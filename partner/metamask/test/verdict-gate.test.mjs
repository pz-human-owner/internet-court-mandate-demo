// Unit tests for the on-chain verdict gate (src/verdict-gate.mjs). Offline. The last group starts a
// plain local `anvil` (no fork, no network) if it is on PATH and skips otherwise; CI installs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseEther, getAddress, encodeFunctionData, decodeFunctionResult } from 'viem';
import { foundry } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { getSmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
import { caseSalt, SAMPLE_CASE } from '../src/verdict-payment.mjs';
import { decodeRevertData, rpcCall } from '../src/refusal-gate.mjs';
import { ARTIFACT, GATE_ABI, GATE_REVERT, SLOT_TRUE, buildGatedDelegation, carrierDecision, checkSuccess, decodeGateTerms, gateTerms, txBudget, verdictSlot } from '../src/verdict-gate.mjs';

const env = getSmartAccountsEnvironment(11155111);
const principal = getAddress('0x1111111111111111111111111111111111111111');
const carrier = getAddress('0x2222222222222222222222222222222222222222');
const agent = getAddress('0x3333333333333333333333333333333333333333');
const gate = getAddress('0x4444444444444444444444444444444444444444');
const amountWei = parseEther('0.001');
const base = { environment: env, principal, agent, carrier, gate, amountWei, expiresAt: 2_000_000_000, caseContract: SAMPLE_CASE };
const TRUE_JSON = JSON.stringify({ status: 'resolved', verdict: 'TRUE', reasoning: 'ok' });
const FINAL = { recipient: SAMPLE_CASE.toLowerCase(), statusName: 'Finalized', txExecutionResultName: 'FinishedWithReturn' };

test('artifact is the committed pinned build of the committed source', () => {
  const src = readFileSync(new URL('../contracts/src/VerdictGateEnforcer.sol', import.meta.url));
  assert.equal(createHash('sha256').update(src).digest('hex'), ARTIFACT.sourceSha256);
  assert.match(ARTIFACT.compiler.solc, /^0\.8\.23\+commit\.f704f362$/);
  assert.deepEqual(ARTIFACT.compiler.optimizer, { enabled: true, runs: 200 });
  const names = GATE_ABI.filter((x) => x.type === 'function').map((x) => x.name).sort();
  assert.deepEqual(names, ['CASE_LABEL', 'afterAllHook', 'afterHook', 'beforeAllHook', 'beforeHook', 'caseKey', 'getTermsInfo', 'postVerdictTrue', 'verdictTrue']);
  // No owner, admin, upgrade, pause or selfdestruct surface.
  assert.ok(!/selfdestruct|delegatecall|onlyOwner|owner\(/i.test(src.toString()));
});

test('gate terms are abi.encode(caseKey, carrier) and round-trip', () => {
  const k = caseSalt(SAMPLE_CASE);
  const t = gateTerms(k, carrier);
  assert.equal(t.length, 2 + 128);
  assert.deepEqual(decodeGateTerms(t), { caseKey: k, carrier });
  assert.throws(() => gateTerms('0x1234', carrier));
  assert.throws(() => gateTerms(k, 'nope'));
});

test('buildGatedDelegation: delegate and sole redeemer is the agent; gate caveat carries the case and carrier', () => {
  const d = buildGatedDelegation(base);
  assert.equal(getAddress(d.delegate), agent);
  assert.equal(d.salt, caseSalt(SAMPLE_CASE));
  const g = d.caveats.filter((c) => getAddress(c.enforcer) === gate);
  assert.equal(g.length, 1);
  assert.deepEqual(decodeGateTerms(g[0].terms), { caseKey: caseSalt(SAMPLE_CASE), carrier });
  const red = d.caveats.find((c) => c.enforcer.toLowerCase() === env.caveatEnforcers.RedeemerEnforcer.toLowerCase());
  assert.equal(getAddress(red.terms), agent);
  for (const name of ['NativeTokenTransferAmountEnforcer', 'ExactExecutionEnforcer', 'LimitedCallsEnforcer', 'TimestampEnforcer']) {
    assert.ok(d.caveats.some((c) => c.enforcer.toLowerCase() === env.caveatEnforcers[name].toLowerCase()), name);
  }
  // A different case gives different gate terms.
  const other = buildGatedDelegation({ ...base, caseContract: '0x0000000000000000000000000000000000000001' });
  assert.notEqual(other.caveats.find((c) => getAddress(c.enforcer) === gate).terms, g[0].terms);
  assert.throws(() => buildGatedDelegation({ ...base, gate: 'x' }));
  assert.throws(() => buildGatedDelegation({ ...base, amountWei: 0n }));
});

test('carrierDecision posts only a resolved TRUE whose request_verdict is Finalized', () => {
  assert.equal(carrierDecision({ verdictRaw: TRUE_JSON, genReceipt: FINAL, caseContract: SAMPLE_CASE }).post, true);
  for (const v of ['FALSE', 'UNDETERMINED']) {
    assert.equal(carrierDecision({ verdictRaw: JSON.stringify({ status: 'resolved', verdict: v }), genReceipt: FINAL, caseContract: SAMPLE_CASE }).post, false);
  }
  assert.equal(carrierDecision({ verdictRaw: JSON.stringify({ status: 'submitted', verdict: '' }), genReceipt: FINAL, caseContract: SAMPLE_CASE }).post, false);
  assert.equal(carrierDecision({ verdictRaw: TRUE_JSON, genReceipt: { ...FINAL, statusName: 'Accepted' }, caseContract: SAMPLE_CASE }).post, false);
  assert.equal(carrierDecision({ verdictRaw: TRUE_JSON, genReceipt: { ...FINAL, txExecutionResultName: 'FinishedWithError' }, caseContract: SAMPLE_CASE }).post, false);
  assert.equal(carrierDecision({ verdictRaw: TRUE_JSON, genReceipt: { ...FINAL, recipient: '0x0000000000000000000000000000000000000001' }, caseContract: SAMPLE_CASE }).post, false);
  assert.equal(carrierDecision({ verdictRaw: TRUE_JSON, genReceipt: null, caseContract: SAMPLE_CASE }).post, false);
  assert.equal(carrierDecision({ verdictRaw: 'not json', genReceipt: FINAL, caseContract: SAMPLE_CASE }).post, false);
});

test('checkSuccess and txBudget refuse anything unexpected', () => {
  assert.equal(checkSuccess('x', { result: '0x' }), '0x');
  assert.throws(() => checkSuccess('x', { error: { message: 'execution reverted' } }));
  assert.throws(() => checkSuccess('x', null));
  assert.throws(() => checkSuccess('x', { result: 5 }));
  const b = txBudget(5);
  for (let i = 0; i < 5; i++) b.take(`T${i + 1}`);
  assert.equal(b.used, 5);
  assert.throws(() => b.take('T6'), /budget of 5/);
});

test('gate revert reason decodes with the refusal-gate decoder', () => {
  // Error(string) "VerdictGateEnforcer:verdict-not-true"
  const data = encodeFunctionData({ abi: [{ type: 'function', name: 'Error', inputs: [{ type: 'string' }] }], args: [GATE_REVERT] });
  assert.equal(decodeRevertData(data), GATE_REVERT);
});

const hasAnvil = spawnSync('anvil', ['--version']).status === 0;
test('on a local anvil: caseKey matches caseSalt, gate blocks then opens, state-override slot is right', { skip: !hasAnvil && 'anvil not on PATH' }, async () => {
  const port = 19545 + Math.floor(Math.random() * 400);
  const proc = spawn('anvil', ['--port', String(port), '--hardfork', 'osaka', '--silent'], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; ; i++) {
      try { if ((await rpcCall(url, 'eth_chainId', [])).result) break; } catch {}
      if (i > 60) throw new Error('anvil did not start');
      await new Promise((r) => setTimeout(r, 250));
    }
    // anvil's well-known dev account 0 (public test key, not a secret).
    const dev = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
    const pc = createPublicClient({ chain: foundry, transport: http(url) });
    const wc = createWalletClient({ account: dev, chain: foundry, transport: http(url) });
    const rc = await pc.waitForTransactionReceipt({ hash: await wc.deployContract({ abi: GATE_ABI, bytecode: ARTIFACT.bytecode }) });
    const g = rc.contractAddress;
    assert.equal((await pc.getCode({ address: g })).toLowerCase(), ARTIFACT.deployedBytecode.toLowerCase());
    const k = caseSalt(SAMPLE_CASE);
    assert.equal(await pc.readContract({ address: g, abi: GATE_ABI, functionName: 'caseKey', args: [4221n, SAMPLE_CASE] }), k);
    const hook = encodeFunctionData({ abi: GATE_ABI, functionName: 'beforeHook', args: [gateTerms(k, dev.address), '0x', '0x' + '00'.repeat(32), '0x', '0x' + '00'.repeat(32), agent, agent] });
    const blocked = await rpcCall(url, 'eth_call', [{ to: g, data: hook }, 'latest']);
    assert.equal(decodeRevertData(blocked.error?.data), GATE_REVERT);
    // The JS slot computation opens exactly this gate in an eth_call override.
    const overridden = await rpcCall(url, 'eth_call', [{ to: g, data: hook }, 'latest', { [g]: { stateDiff: { [verdictSlot(dev.address, k)]: SLOT_TRUE } } }]);
    assert.equal(overridden.error, undefined);
    // Wrong carrier in the override does not open it.
    const wrong = await rpcCall(url, 'eth_call', [{ to: g, data: hook }, 'latest', { [g]: { stateDiff: { [verdictSlot(carrier, k)]: SLOT_TRUE } } }]);
    assert.equal(decodeRevertData(wrong.error?.data), GATE_REVERT);
    // Real post by the carrier opens it; a second post is refused.
    await pc.waitForTransactionReceipt({ hash: await wc.writeContract({ address: g, abi: GATE_ABI, functionName: 'postVerdictTrue', args: [4221n, SAMPLE_CASE] }) });
    assert.equal(await pc.readContract({ address: g, abi: GATE_ABI, functionName: 'verdictTrue', args: [dev.address, k] }), true);
    assert.equal((await rpcCall(url, 'eth_call', [{ to: g, data: hook }, 'latest'])).error, undefined);
    const again = await rpcCall(url, 'eth_call', [{ from: dev.address, to: g, data: encodeFunctionData({ abi: GATE_ABI, functionName: 'postVerdictTrue', args: [4221n, SAMPLE_CASE] }) }, 'latest']);
    assert.equal(decodeRevertData(again.error?.data), 'VerdictGateEnforcer:already-posted');
    const ti = await rpcCall(url, 'eth_call', [{ to: g, data: encodeFunctionData({ abi: GATE_ABI, functionName: 'getTermsInfo', args: [gateTerms(k, carrier)] }) }, 'latest']);
    assert.deepEqual(decodeFunctionResult({ abi: GATE_ABI, functionName: 'getTermsInfo', data: ti.result }), [k, carrier]);
  } finally {
    proc.kill();
  }
});
