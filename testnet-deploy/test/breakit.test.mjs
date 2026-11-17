// Unit tests for the "Try to break it" checks (src/breakit.mjs). No network: the RPCs are mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak256, encodeAbiParameters, getAddress, toFunctionSelector, encodeErrorResult, encodeFunctionData } from 'viem';
import {
  ADDR, CASE_KEY, SLOT, SEL, CHECKS, TX, BLOCK, GATE_REVERT, SEPOLIA_RPCS,
  decodeRevert, classify, classifyFalseCase, callParams, checkRedemptionTx, runChecks,
  verdictTrueCalldata, caseKeyCalldata, outcomeLabel, isRetryable,
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
  assert.equal(classify(gate, revert('0x12345678')).outcome, 'error');
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
    assert.ok(block === 'latest' || /^0x[0-9a-f]+$/.test(block));
    if (c.overrides) assert.deepEqual(ov, c.overrides); else assert.equal(ov, undefined);
    assert.equal(Boolean(c.expect.success), c.id === 'control');
  }
  const outsider = CHECKS.find((c) => c.id === 'outsider');
  assert.equal(outsider.from, ADDR.outsider);
  assert.deepEqual(Object.keys(CHECKS.find((c) => c.id === 'wrong-case').overrides[ADDR.enforcer].stateDiff), [SLOT.falseCase]);
});

test('checkRedemptionTx refuses anything but the agent\'s DelegationManager redemption', () => {
  const t5 = { to: ADDR.delegationManager.toLowerCase(), from: ADDR.agent.toLowerCase(), input: '0xaa', gas: '0x1' };
  assert.equal(checkRedemptionTx({ input: '0xaa' }, t5), null);
  assert.match(checkRedemptionTx({ input: '0xbb' }, t5), /same calldata/);
  assert.match(checkRedemptionTx({ input: '0xaa' }, { ...t5, to: ADDR.enforcer }), /DelegationManager/);
  assert.match(checkRedemptionTx({ input: '0xaa' }, { ...t5, from: ADDR.outsider }), /agent/);
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
  assert.equal(classifyFalseCase({ verdict: v, caseKeyResult: CASE_KEY.falseCase, verdictTrueResult: zero }).outcome, 'refused');
  assert.equal(classifyFalseCase({ verdict: v, caseKeyResult: CASE_KEY.falseCase, verdictTrueResult: one }).outcome, 'unexpected');
  assert.equal(classifyFalseCase({ verdict: { status: 'resolved', verdict: 'TRUE' }, caseKeyResult: CASE_KEY.falseCase, verdictTrueResult: zero }).outcome, 'unexpected');
  assert.equal(classifyFalseCase({ verdict: v, caseKeyResult: CASE_KEY.trueCase, verdictTrueResult: zero }).outcome, 'error');
  assert.equal(classifyFalseCase({ verdict: null, caseKeyResult: CASE_KEY.falseCase, verdictTrueResult: zero }).outcome, 'error');
  assert.equal(classifyFalseCase({ verdict: v, caseKeyResult: CASE_KEY.falseCase, verdictTrueResult: undefined }).outcome, 'error');
});

// A fake Sepolia that mimics the live answers (as observed 16 Nov 2026), plus failure modes.
function fakeChain({ archiveFailsOn = new Set(), broken = new Set(), lie = null } = {}) {
  const calls = [];
  const tx = { to: ADDR.delegationManager.toLowerCase(), from: ADDR.agent.toLowerCase(), input: '0xfeed', gas: '0x7312c' };
  const rpcFor = (url) => async (method, params) => {
    calls.push({ url, method, params });
    if (broken.has(url)) throw new Error('network down');
    if (method === 'eth_getTransactionByHash') return ok(tx);
    const [obj, block, ov] = params;
    if (obj.to === ADDR.enforcer) {
      if (obj.data.startsWith(SEL.caseKey)) return ok(CASE_KEY.falseCase);
      return ok('0x' + '0'.repeat(64));
    }
    if (block !== 'latest' && archiveFailsOn.has(url)) return { error: { code: -32000, message: 'Archive requests require a personal token' } };
    if (lie) return lie;
    const sd = ov?.[ADDR.enforcer]?.stateDiff ?? {};
    if (block === 'latest') return revert(errString('NativeTokenTransferAmountEnforcer:allowance-exceeded'));
    if (obj.from === ADDR.outsider) return revert(SEL.InvalidDelegate);
    if (sd[SLOT.trueCase]) return ok('0x');
    return revert(errString(GATE_REVERT));
  };
  return { rpcFor, calls };
}
const readFalseVerdict = async () => ({ status: 'resolved', verdict: 'FALSE' });

test('runChecks: all refusals and the control behave as on the live chain; only eth_call and reads are used', async () => {
  const { rpcFor, calls } = fakeChain();
  const seen = [];
  const out = await runChecks({ rpcFor, readFalseVerdict, onResult: (c, r) => seen.push([c.id, r.outcome]) });
  assert.equal(out.length, CHECKS.length);
  for (const r of out) assert.equal(r.outcome, r.id === 'control' ? 'opened' : 'refused', r.id);
  assert.equal(seen.length, CHECKS.length);
  for (const c of calls) assert.ok(['eth_call', 'eth_getTransactionByHash'].includes(c.method), c.method);
});

test('runChecks falls back to the next RPC on an archive/transport error, never on a real revert', async () => {
  const [first, second] = SEPOLIA_RPCS;
  const { rpcFor, calls } = fakeChain({ archiveFailsOn: new Set([first]) });
  const out = await runChecks({ rpcFor, readFalseVerdict });
  assert.ok(out.every((r) => r.outcome === 'refused' || r.outcome === 'opened'));
  assert.equal(out.find((r) => r.id === 'no-verdict').rpc, second);
  assert.equal(out.find((r) => r.id === 'replay').rpc, first);
  assert.ok(calls.some((c) => c.url === second));
  assert.equal(isRetryable(revert(errString(GATE_REVERT))), false);
});

test('runChecks shows "error" (never a pass) when every RPC is down', async () => {
  const { rpcFor } = fakeChain({ broken: new Set(SEPOLIA_RPCS) });
  const out = await runChecks({ rpcFor, readFalseVerdict });
  for (const r of out) assert.equal(r.outcome, 'error', r.id);
});

test('runChecks reports "unexpected" if the chain ever lets a refused attempt through', async () => {
  const { rpcFor } = fakeChain({ lie: ok('0x') });
  const out = await runChecks({ rpcFor, readFalseVerdict });
  for (const r of out.filter((x) => x.id !== 'control' && x.id !== 'false-case')) assert.equal(r.outcome, 'unexpected', r.id);
});

test('a failed GenLayer read makes the FALSE-case row "error"', async () => {
  const { rpcFor } = fakeChain();
  const out = await runChecks({ rpcFor, readFalseVerdict: async () => { throw new Error('gen_call timed out'); } });
  assert.equal(out.find((r) => r.id === 'false-case').outcome, 'error');
});

test('page section: present, read-only wording, trusted-carrier note, no overclaims', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('<section class="settle break" id="break-it"');
  assert.ok(start > html.indexOf('id="mm-settle"'));
  assert.ok(start < html.indexOf('<details id="mm">'));
  const sec = html.slice(start, html.indexOf('</section>', start));
  assert.match(sec, /no wallet, no signature, no transaction/);
  assert.match(sec, /trusted off-chain writer/);
  assert.match(sec, /never counted as a pass/);
  assert.doesNotMatch(sec, /<(input|form|script)\b/i);
  assert.doesNotMatch(sec.toLowerCase(), /trustless|oracle|lens/);
  const src = readFileSync(new URL('../src/breakit.mjs', import.meta.url), 'utf8').toLowerCase();
  assert.doesNotMatch(src, /trustless|oracle|eth_sendtransaction|eth_sendrawtransaction|privatekey/);
});
