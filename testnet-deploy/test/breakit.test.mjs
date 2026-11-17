// Unit tests for the "Try to break it" checks (src/breakit.mjs). No network: the RPCs are mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak256, encodeAbiParameters, getAddress, toFunctionSelector, encodeErrorResult, encodeFunctionData } from 'viem';
import {
  ADDR, CASE_KEY, SLOT, SEL, CHECKS, TX, BLOCK, GATE_REVERT, SEPOLIA_RPCS,
  decodeRevert, classify, classifyFalseCase, callParams, checkRedemptionTx, runChecks,
  verdictTrueCalldata, caseKeyCalldata, outcomeLabel, isRetryable, stateProbes, judgeProbe, balanceProbeCode, PASS_OUTCOMES, FEE_WEI_HEX,
} from '../src/breakit.mjs';

const slot = (carrier, key) => {
  const inner = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [getAddress(carrier), 0n]));
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [key, inner]));
};
const errString = (s) => encodeErrorResult({ abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string', name: 'm' }] }], errorName: 'Error', args: [s] });
const revert = (data) => ({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data } });
const ok = (result = '0x') => ({ jsonrpc: '2.0', id: 1, result });

test('storage slots and selectors match a fresh computation', () => {
  assert.equal(SLOT.trueCase, slot(ADDR.carrier, CASE_KEY.trueCase));
  assert.equal(SLOT.falseCase, slot(ADDR.carrier, CASE_KEY.falseCase));
  assert.equal(SLOT.otherCarrier, slot(ADDR.otherCarrier, CASE_KEY.trueCase));
  assert.equal(SEL.InvalidDelegate, toFunctionSelector('InvalidDelegate()'));
  assert.equal(SEL.verdictTrue, toFunctionSelector('verdictTrue(address,bytes32)'));
  assert.equal(SEL.caseKey, toFunctionSelector('caseKey(uint256,address)'));
  assert.equal(SEL.errorString, toFunctionSelector('Error(string)'));
});

test('constants match the committed live records', () => {
  const rec = JSON.parse(readFileSync(new URL('../../partner/metamask/live-onchain-check-result.json', import.meta.url), 'utf8'));
  const fal = JSON.parse(readFileSync(new URL('../../partner/metamask/live-false-check-result.json', import.meta.url), 'utf8'));
  assert.equal(rec.accounts.carrier, ADDR.carrier);
  assert.equal(rec.accounts.agent, ADDR.agent);
  assert.equal(rec.accounts.principalSmartAccount, ADDR.principal);
  assert.equal(rec.enforcer.address, ADDR.enforcer);
  assert.equal(rec.delegationManager, ADDR.delegationManager);
  assert.equal(rec.case.caseKey, CASE_KEY.trueCase);
  assert.equal(fal.case.caseKey, CASE_KEY.falseCase);
  assert.equal(fal.case.contract, ADDR.falseCase);
  const hashes = JSON.stringify(rec.transactions);
  assert.ok(hashes.includes(TX.T3) && hashes.includes(TX.T5));
  assert.equal(rec.transactions.T2_fundPrincipal.block, BLOCK.T2);
  assert.equal(rec.transactions.T1_deployEnforcer.block, BLOCK.T1);
});

test('decodeRevert: Error(string), InvalidDelegate, junk', () => {
  assert.equal(decodeRevert(errString(GATE_REVERT)), GATE_REVERT);
  assert.equal(decodeRevert(SEL.InvalidDelegate), 'InvalidDelegate');
  assert.equal(decodeRevert('0xdeadbeef'), null);
  assert.equal(decodeRevert('0x'), null);
  assert.equal(decodeRevert(undefined), null);
  assert.equal(decodeRevert(SEL.errorString + 'zz'), null);
});

test('classify fails closed', () => {
  const gate = CHECKS.find((c) => c.id === 'no-verdict');
  const control = CHECKS.find((c) => c.id === 'control');
  assert.equal(classify(gate, revert(errString(GATE_REVERT))).outcome, 'refused');
  assert.equal(classify(gate, revert(SEL.InvalidDelegate)).outcome, 'unexpected');
  assert.equal(classify(gate, ok()).outcome, 'unexpected');
  assert.equal(classify(gate, { error: { message: 'Archive requests require a personal token' } }).outcome, 'error');
  assert.equal(classify(gate, revert('0x12345678')).outcome, 'unexpected');
  assert.equal(classify(gate, null).outcome, 'error');
  assert.equal(classify(gate, {}).outcome, 'error');
  assert.equal(classify(control, ok()).outcome, 'opened');
  assert.equal(classify(control, revert(errString(GATE_REVERT))).outcome, 'unexpected');
  assert.equal(outcomeLabel('error'), 'Could not check');
  assert.equal(outcomeLabel('bogus'), 'Could not check');
});

test('every call check targets the DelegationManager with the fetched calldata; only the control expects success', () => {
  const tx = { input: '0xabcdef', gas: '0x7312c' };
  for (const c of CHECKS.filter((x) => x.kind === 'call')) {
    const [obj, block, ov] = callParams(c, tx);
    assert.equal(obj.to, ADDR.delegationManager);
    assert.equal(obj.data, '0xabcdef');
    assert.match(block, /^0x[0-9a-f]+$/); // every call check pins a block (replay at T5, before the expiry)
    if (c.overrides) assert.deepEqual(ov, c.overrides); else assert.equal(ov, undefined);
    assert.equal(Boolean(c.expect.success), c.id === 'control');
  }
  const outsider = CHECKS.find((c) => c.id === 'outsider');
  assert.equal(outsider.from, ADDR.outsider);
  assert.deepEqual(Object.keys(CHECKS.find((c) => c.id === 'wrong-case').overrides[ADDR.enforcer].stateDiff), [SLOT.falseCase]);
  assert.equal(CHECKS.find((c) => c.id === 'replay').block, BLOCK.T5);
});

test('every call check declares the simulated state it depends on, probed at its own block with its own overrides', () => {
  const want = {
    'no-verdict': [['carrier', 'trueCase', 0]], 'balance-only': [['carrier', 'trueCase', 0]],
    'wrong-case': [['carrier', 'falseCase', 1], ['carrier', 'trueCase', 0]],
    'wrong-carrier': [['otherCarrier', 'trueCase', 1], ['carrier', 'trueCase', 0]],
    outsider: [['carrier', 'trueCase', 1]], replay: [['carrier', 'trueCase', 1]], control: [['carrier', 'trueCase', 1]],
  };
  for (const c of CHECKS.filter((x) => x.kind === 'call')) {
    const vts = c.state.filter((s) => s.kind === 'verdictTrue').map((s) => [Object.keys(ADDR).find((k) => ADDR[k] === s.carrier), s.caseName, s.want]);
    assert.deepEqual(vts, want[c.id], c.id);
    assert.ok(c.state.some((s) => s.kind === 'balance' && s.who === ADDR.principal), `${c.id} probes the fee balance`);
    for (const { params } of stateProbes(c)) {
      assert.equal(params[1], callParams(c, { input: '0x', gas: '0x1' })[1]);
      assert.deepEqual(params[2], c.overrides ?? undefined);
    }
  }
  assert.equal(balanceProbeCode(ADDR.principal), '0x73' + ADDR.principal.slice(2).toLowerCase() + '3160005260206000f3');
  const vt1 = { kind: 'verdictTrue', carrier: ADDR.carrier, caseName: 'trueCase', want: 1 };
  assert.equal(judgeProbe(vt1, ok('0x' + '0'.repeat(63) + '1')), 'ok');
  assert.match(judgeProbe(vt1, ok('0x' + '0'.repeat(64))), /read 0 instead of 1/);
  assert.equal(judgeProbe(vt1, { error: { message: 'down' } }), 'retry');
  assert.equal(judgeProbe(vt1, ok('0x')), 'retry');
});

test('checkRedemptionTx refuses anything but the agent\'s DelegationManager redemption', () => {
  const t5 = { hash: TX.T5, to: ADDR.delegationManager.toLowerCase(), from: ADDR.agent.toLowerCase(), input: '0xaa', gas: '0x1' };
  const rc = { transactionHash: TX.T5, status: '0x1' };
  assert.equal(checkRedemptionTx({ hash: TX.T3, input: '0xaa' }, t5, rc), null);
  assert.match(checkRedemptionTx({ hash: TX.T3, input: '0xaa' }, t5, { ...rc, status: '0x0' }), /does not show success/);
  assert.match(checkRedemptionTx({ hash: TX.T3, input: '0xaa' }, t5, null), /receipt/);
  assert.match(checkRedemptionTx({ hash: TX.T3, input: '0xaa' }, { ...t5, hash: TX.T3 }, rc), /different transaction/);
  assert.match(checkRedemptionTx({ hash: TX.T3, input: '0xbb' }, t5), /same calldata/);
  assert.match(checkRedemptionTx({ hash: TX.T3, input: '0xaa' }, { ...t5, to: ADDR.enforcer }), /DelegationManager/);
  assert.match(checkRedemptionTx({ hash: TX.T3, input: '0xaa' }, { ...t5, from: ADDR.outsider }), /agent/);
  assert.match(checkRedemptionTx(null, null), /could not be read/);
});

test('calldata helpers match viem encoding', () => {
  const abi = [
    { type: 'function', name: 'verdictTrue', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'bytes32' }], outputs: [{ type: 'bool' }] },
    { type: 'function', name: 'caseKey', stateMutability: 'pure', inputs: [{ type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'bytes32' }] },
  ];
  assert.equal(verdictTrueCalldata(ADDR.carrier, CASE_KEY.falseCase), encodeFunctionData({ abi, functionName: 'verdictTrue', args: [ADDR.carrier, CASE_KEY.falseCase] }));
  assert.equal(caseKeyCalldata(4221, ADDR.falseCase), encodeFunctionData({ abi, functionName: 'caseKey', args: [4221n, ADDR.falseCase] }));
});

test('classifyFalseCase', () => {
  const zero = '0x' + '0'.repeat(64), one = '0x' + '0'.repeat(63) + '1';
  const v = { status: 'resolved', verdict: 'FALSE' };
  assert.equal(classifyFalseCase({ verdict: v, caseKeyResult: CASE_KEY.falseCase, verdictTrueResult: zero }).outcome, 'closed');
  assert.equal(classifyFalseCase({ verdict: v, caseKeyResult: CASE_KEY.falseCase, verdictTrueResult: one }).outcome, 'unexpected');
  assert.equal(classifyFalseCase({ verdict: { status: 'resolved', verdict: 'TRUE' }, caseKeyResult: CASE_KEY.falseCase, verdictTrueResult: zero }).outcome, 'unexpected');
  assert.equal(classifyFalseCase({ verdict: v, caseKeyResult: CASE_KEY.trueCase, verdictTrueResult: zero }).outcome, 'error');
  assert.equal(classifyFalseCase({ verdict: null, caseKeyResult: CASE_KEY.falseCase, verdictTrueResult: zero }).outcome, 'error');
  assert.equal(classifyFalseCase({ verdict: v, caseKeyResult: CASE_KEY.falseCase, verdictTrueResult: undefined }).outcome, 'error');
});

// A fake Sepolia that mimics the live answers (as observed 16-17 Nov 2026), plus failure modes.
// It honours eth_call state overrides (verdictTrue slots and balances) unless told to ignore them.
const FEE = BigInt(FEE_WEI_HEX);
const word = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
function fakeChain({ archiveFailsOn = new Set(), broken = new Set(), lie = null, ignoreOverrides = new Set(), txDownOn = new Set() } = {}) {
  const calls = [];
  const tx = (hash) => ({ hash, to: ADDR.delegationManager.toLowerCase(), from: ADDR.agent.toLowerCase(), input: '0xfeed', gas: '0x7312c' });
  const rpcFor = (url) => async (method, params) => {
    calls.push({ url, method, params });
    if (broken.has(url)) throw new Error('network down');
    if (method === 'eth_getTransactionByHash') return txDownOn.has(url) ? ok(null) : ok(tx(params[0]));
    if (method === 'eth_getTransactionReceipt') return txDownOn.has(url) ? ok(null) : ok({ transactionHash: params[0], status: '0x1' });
    const [obj, block, rawOv] = params;
    const ov = ignoreOverrides.has(url) ? undefined : rawOv;
    const n = block === 'latest' ? Infinity : parseInt(block, 16);
    if (n !== Infinity && archiveFailsOn.has(url)) return { error: { code: -32000, message: 'Archive requests require a personal token' } };
    const sd = ov?.[ADDR.enforcer]?.stateDiff ?? {};
    const posted = (s) => Boolean(sd[s]) || (s === SLOT.trueCase && n >= BLOCK.T4);
    const bal = ov?.[ADDR.principal]?.balance ? BigInt(ov[ADDR.principal].balance) : (n >= BLOCK.T2 && n < BLOCK.T5 ? FEE : 0n);
    if (obj.to === ADDR.enforcer) {
      if (obj.data.startsWith(SEL.caseKey)) return ok(CASE_KEY.falseCase);
      const key = '0x' + obj.data.slice(-64), carrier = '0x' + obj.data.slice(10 + 24, 10 + 64);
      const c = carrier.toLowerCase(), k = key.toLowerCase();
      const which = c === ADDR.carrier.toLowerCase() && k === CASE_KEY.trueCase ? SLOT.trueCase
        : c === ADDR.carrier.toLowerCase() && k === CASE_KEY.falseCase ? SLOT.falseCase
        : c === ADDR.otherCarrier.toLowerCase() && k === CASE_KEY.trueCase ? SLOT.otherCarrier : null;
      return ok(word(which && posted(which) ? 1 : 0));
    }
    if (!obj.to && obj.data.startsWith('0x73')) return ok(word(bal));
    if (lie) return lie;
    if (obj.from === ADDR.outsider) return revert(SEL.InvalidDelegate);
    if (!posted(SLOT.trueCase)) return revert(errString(GATE_REVERT));
    if (n >= BLOCK.T5) return revert(errString('NativeTokenTransferAmountEnforcer:allowance-exceeded'));
    if (bal < FEE) return revert('0x');
    return ok('0x');
  };
  return { rpcFor, calls };
}
const readFalseVerdict = async () => ({ status: 'resolved', verdict: 'FALSE' });

test('runChecks: all refusals and the control behave as on the live chain; only eth_call and reads are used', async () => {
  const { rpcFor, calls } = fakeChain();
  const seen = [];
  const out = await runChecks({ retryDelayMs: 0, rpcFor, readFalseVerdict, onResult: (c, r) => seen.push([c.id, r.outcome]) });
  assert.equal(out.length, CHECKS.length);
  for (const r of out) assert.equal(r.outcome, r.id === 'control' ? 'opened' : r.id === 'false-case' ? 'closed' : 'refused', r.id);
  for (const r of out.filter((x) => x.id !== 'false-case')) assert.equal(r.stateConfirmed, true, r.id);
  assert.equal(seen.length, CHECKS.length);
  for (const c of calls) assert.ok(['eth_call', 'eth_getTransactionByHash', 'eth_getTransactionReceipt'].includes(c.method), c.method);
});

test('runChecks falls back to the next RPC on an archive/transport error, never on a real revert', async () => {
  const [first, second] = SEPOLIA_RPCS;
  const { rpcFor, calls } = fakeChain({ archiveFailsOn: new Set([first]) });
  const out = await runChecks({ retryDelayMs: 0, rpcFor, readFalseVerdict });
  assert.ok(out.every((r) => PASS_OUTCOMES.includes(r.outcome)));
  for (const r of out.filter((x) => x.id !== 'false-case')) assert.equal(r.rpc, second, r.id);
  assert.ok(calls.some((c) => c.url === second));
  assert.equal(isRetryable(revert(errString(GATE_REVERT))), false);
});

test('an RPC that silently ignores state overrides never yields a pass for an override row', async () => {
  const { rpcFor } = fakeChain({ ignoreOverrides: new Set(SEPOLIA_RPCS) });
  const out = await runChecks({ retryDelayMs: 0, rpcFor, readFalseVerdict });
  const by = Object.fromEntries(out.map((r) => [r.id, r]));
  for (const id of ['balance-only', 'wrong-case', 'wrong-carrier', 'outsider', 'replay', 'control']) {
    assert.ok(!PASS_OUTCOMES.includes(by[id].outcome), id);
    assert.equal(by[id].outcome, 'error', id);
  }
  // no-verdict has no override, but it still needs the control on the same RPC, which cannot pass here
  assert.equal(by['no-verdict'].outcome, 'error');
  assert.match(by['wrong-case'].detail, /control did not go through/);
});

test('split endpoints: a row passes only on an RPC where its state probes and the control also passed', async () => {
  const [first, second] = SEPOLIA_RPCS;
  const { rpcFor } = fakeChain({ ignoreOverrides: new Set([first]) });
  const out = await runChecks({ retryDelayMs: 0, rpcFor, readFalseVerdict });
  for (const r of out.filter((x) => x.id !== 'false-case')) {
    assert.ok(PASS_OUTCOMES.includes(r.outcome), r.id);
    assert.equal(r.rpc, second, r.id);
  }
});

test('a valid transaction read from the first RPC is kept when the second RPC is down', async () => {
  const [first, second] = SEPOLIA_RPCS;
  const base = fakeChain();
  const rpcFor = (url) => async (method, params) => {
    if (url === second) throw new Error('down');
    return base.rpcFor(url)(method, params);
  };
  const out = await runChecks({ retryDelayMs: 0, rpcFor, readFalseVerdict });
  assert.ok(out.every((r) => PASS_OUTCOMES.includes(r.outcome)), JSON.stringify(out.map((r) => [r.id, r.outcome, r.detail])));
  assert.equal(isRetryable(ok({ hash: TX.T5, input: '0x1' }), 'eth_getTransactionByHash'), false);
  assert.equal(isRetryable(ok(null), 'eth_getTransactionByHash'), true);
  assert.equal(isRetryable(ok({ status: '0x1' }), 'eth_getTransactionReceipt'), false);
});

test('a transaction read that only the second RPC can serve is still used', async () => {
  const [first] = SEPOLIA_RPCS;
  const { rpcFor } = fakeChain({ txDownOn: new Set([first]) });
  const out = await runChecks({ retryDelayMs: 0, rpcFor, readFalseVerdict });
  assert.ok(out.every((r) => PASS_OUTCOMES.includes(r.outcome)));
});

test('a one-off non-answer (e.g. HTTP 429) is retried once on the same RPC; a revert is never re-asked', async () => {
  const [first] = SEPOLIA_RPCS;
  const base = fakeChain();
  const seen = new Map();
  const rpcFor = (url) => async (method, params) => {
    const k = url + JSON.stringify(params);
    seen.set(k, (seen.get(k) ?? 0) + 1);
    if (seen.get(k) === 1 && method === 'eth_call' && params[0].to === ADDR.delegationManager) throw new Error('eth_call: HTTP 429');
    return base.rpcFor(url)(method, params);
  };
  const out = await runChecks({ retryDelayMs: 0, rpcFor, readFalseVerdict, rpcs: [first] });
  assert.ok(out.every((r) => PASS_OUTCOMES.includes(r.outcome)));
  for (const [k, n] of seen) if (k.includes(ADDR.delegationManager.toLowerCase()) || k.includes(ADDR.delegationManager)) assert.ok(n <= 2);
});

test('runChecks shows "error" (never a pass) when every RPC is down', async () => {
  const { rpcFor } = fakeChain({ broken: new Set(SEPOLIA_RPCS) });
  const out = await runChecks({ retryDelayMs: 0, rpcFor, readFalseVerdict });
  for (const r of out) assert.equal(r.outcome, 'error', r.id);
});

test('runChecks reports "unexpected" if the chain ever lets a refused attempt through', async () => {
  const { rpcFor } = fakeChain({ lie: ok('0x') });
  const out = await runChecks({ retryDelayMs: 0, rpcFor, readFalseVerdict });
  for (const r of out.filter((x) => x.id !== 'control' && x.id !== 'false-case')) assert.equal(r.outcome, 'unexpected', r.id);
  assert.equal(out.find((r) => r.id === 'control').outcome, 'opened');
});

test('a failed GenLayer read makes the FALSE-case row "error"', async () => {
  const { rpcFor } = fakeChain();
  const out = await runChecks({ retryDelayMs: 0, rpcFor, readFalseVerdict: async () => { throw new Error('gen_call timed out'); } });
  assert.equal(out.find((r) => r.id === 'false-case').outcome, 'error');
});

test('page section: present, read-only wording, trusted-carrier note, no overclaims', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('<section class="settle break" id="break-it"');
  assert.ok(start > html.indexOf('id="mm-settle"'));
  assert.ok(start < html.indexOf('<details id="mm">'));
  const sec = html.slice(start, html.indexOf('</section>', start));
  assert.match(sec, /this panel uses no wallet, no signature and no transaction/);
  assert.match(sec, /optional MetaMask section further down is separate/);
  assert.match(sec, /same RPC, block and overrides confirm the simulated state/);
  assert.match(sec, /trusted off-chain writer/);
  assert.match(sec, /never counted as a pass/);
  assert.doesNotMatch(sec, /<(input|form|script)\b/i);
  assert.doesNotMatch(sec.toLowerCase(), /trustless|oracle|lens/);
  const src = readFileSync(new URL('../src/breakit.mjs', import.meta.url), 'utf8').toLowerCase();
  assert.doesNotMatch(src, /trustless|oracle|eth_sendtransaction|eth_sendrawtransaction|privatekey/);
});
