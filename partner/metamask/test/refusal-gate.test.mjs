// Offline tests for the refusal runner's evidence gate (src/refusal-gate.mjs) and the
// script's no-overwrite / fail-closed behaviour. No network, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { encodeErrorResult, encodeAbiParameters } from 'viem';
import { DelegationManager as DelegationManagerAbi } from '@metamask/delegation-abis';
import { EXPECTED, GateError, decodeRevertData, blockedByFromReason, checkSimulation, rpcCall, simulateExpectedRevert, verifyMinedRevert } from '../src/refusal-gate.mjs';

const INVALID_DELEGATE = encodeErrorResult({ abi: DelegationManagerAbi, errorName: 'InvalidDelegate' });
const errorString = (msg) => '0x08c379a0' + encodeAbiParameters([{ type: 'string' }], [msg]).slice(2);
const ALLOWANCE = errorString('NativeTokenTransferAmountEnforcer:allowance-exceeded');
const LIMIT = errorString('LimitedCallsEnforcer:limit-exceeded');
const revertResp = (data) => ({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data } });
const TX = { from: '0x8b5deeE4A52c321C81C33b2bC99834EB05B04929', to: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3', input: '0xcafe0001', gas: 400000n };

test('decodes the recorded revert data of R1 and R2', () => {
  assert.equal(decodeRevertData('0xb5863604'), 'InvalidDelegate');
  assert.equal(decodeRevertData(ALLOWANCE), 'NativeTokenTransferAmountEnforcer:allowance-exceeded');
  assert.equal(decodeRevertData(LIMIT), 'LimitedCallsEnforcer:limit-exceeded');
  assert.equal(decodeRevertData('0x'), null);
  assert.equal(decodeRevertData('0xdeadbeef'), null);
  assert.equal(decodeRevertData(undefined), null);
});

test('expected reasons: R1 InvalidDelegate only; R2 allowance-exceeded or limit-exceeded', () => {
  assert.deepEqual([...EXPECTED.R1], ['InvalidDelegate']);
  assert.ok(EXPECTED.R2.includes('NativeTokenTransferAmountEnforcer:allowance-exceeded'));
  assert.ok(EXPECTED.R2.includes('LimitedCallsEnforcer:limit-exceeded'));
  assert.ok(!EXPECTED.R2.includes('InvalidDelegate'));
});

test('blockedBy is derived from the decoded reason, not hard-coded', () => {
  const env = {
    DelegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
    caveatEnforcers: {
      NativeTokenTransferAmountEnforcer: '0xF71af580b9c3078fbc2BBF16FbB8EEd82b330320',
      LimitedCallsEnforcer: '0x04658B29F6b82ed55274221a06Fc97D318E25416',
    },
  };
  assert.deepEqual(blockedByFromReason('InvalidDelegate', env), {
    by: 'DelegationManager (InvalidDelegate: caller is not the delegate)',
    address: env.DelegationManager,
  });
  assert.deepEqual(blockedByFromReason('NativeTokenTransferAmountEnforcer:allowance-exceeded', env), {
    by: 'NativeTokenTransferAmountEnforcer (allowance-exceeded)',
    address: env.caveatEnforcers.NativeTokenTransferAmountEnforcer,
  });
  assert.deepEqual(blockedByFromReason('LimitedCallsEnforcer:limit-exceeded', env), {
    by: 'LimitedCallsEnforcer (limit-exceeded)',
    address: env.caveatEnforcers.LimitedCallsEnforcer,
  });
  assert.throws(() => blockedByFromReason('TimestampEnforcer:expired-delegation', env), (e) => e instanceof GateError && /no blockedBy mapping/.test(e.message));
  // The recorded R2 used allowance-exceeded, so its label must still map to the amount enforcer.
  const rec = JSON.parse(readFileSync(new URL('../live-refusal-result.json', import.meta.url), 'utf8'));
  const r2 = rec.transactions.R2_secondRedeem;
  const derived = blockedByFromReason(r2.simulatedRevertReason, env);
  assert.equal(r2.simulatedRevertReason, 'NativeTokenTransferAmountEnforcer:allowance-exceeded');
  assert.equal(r2.blockedBy, derived.by);
  assert.equal(r2.blockedByAddress.toLowerCase(), derived.address.toLowerCase());
});

test('pre-broadcast gate passes only the expected decoded revert', () => {
  assert.deepEqual(checkSimulation('R1', revertResp(INVALID_DELEGATE), EXPECTED.R1), { reason: 'InvalidDelegate', data: INVALID_DELEGATE });
  assert.equal(checkSimulation('R2', revertResp(ALLOWANCE), EXPECTED.R2).reason, 'NativeTokenTransferAmountEnforcer:allowance-exceeded');
  assert.equal(checkSimulation('R2', revertResp(LIMIT), EXPECTED.R2).reason, 'LimitedCallsEnforcer:limit-exceeded');
  // nested data shape some providers use
  assert.equal(checkSimulation('R1', { error: { code: -32000, message: 'reverted', data: { data: INVALID_DELEGATE } } }, EXPECTED.R1).reason, 'InvalidDelegate');
});

test('pre-broadcast gate aborts when the call would succeed', () => {
  assert.throws(() => checkSimulation('R1', { jsonrpc: '2.0', id: 1, result: '0x' }, EXPECTED.R1), (e) => e instanceof GateError && /did not revert/.test(e.message));
});

test('pre-broadcast gate aborts on RPC / transport errors with no revert data', () => {
  for (const error of [
    { code: -32005, message: 'rate limit exceeded' },
    { code: -32602, message: 'Archive requests require a personal token.' },
    { code: -32000, message: 'header not found' },
    { code: 3, message: 'execution reverted', data: '0x' },
  ]) assert.throws(() => checkSimulation('R1', { error }, EXPECTED.R1), (e) => e instanceof GateError && /without revert data/.test(e.message), JSON.stringify(error));
  assert.throws(() => checkSimulation('R1', null, EXPECTED.R1), GateError);
});

test('pre-broadcast gate aborts on undecodable or unexpected revert reasons', () => {
  assert.throws(() => checkSimulation('R1', revertResp('0xdeadbeef'), EXPECTED.R1), /did not decode/);
  assert.throws(() => checkSimulation('R1', revertResp(ALLOWANCE), EXPECTED.R1), /unexpected revert "NativeTokenTransferAmountEnforcer:allowance-exceeded"/);
  assert.throws(() => checkSimulation('R2', revertResp(INVALID_DELEGATE), EXPECTED.R2), /unexpected revert "InvalidDelegate"/);
  assert.throws(() => checkSimulation('R2', revertResp(errorString('TimestampEnforcer:expired-delegation')), EXPECTED.R2), /unexpected revert/);
});

test('rpcCall treats non-200 HTTP and non-JSON bodies as transport errors', async () => {
  const f403 = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(rpcCall('http://x', 'eth_call', [], f403), /HTTP 403/);
  const fBad = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } });
  await assert.rejects(rpcCall('http://x', 'eth_call', [], fBad), /non-JSON/);
  let sent;
  const fOk = async (url, init) => { sent = JSON.parse(init.body); return { ok: true, status: 200, json: async () => revertResp(INVALID_DELEGATE) }; };
  assert.deepEqual(await rpcCall('http://x', 'eth_call', [{ to: '0x1' }, 'latest'], fOk), revertResp(INVALID_DELEGATE));
  assert.equal(sent.method, 'eth_call');
});

test('simulateExpectedRevert passes from/to/data/gas and the block to eth_call', async () => {
  const calls = [];
  const rpc = async (m, p) => { calls.push([m, p]); return revertResp(INVALID_DELEGATE); };
  const r = await simulateExpectedRevert({ label: 'R1', rpc, from: TX.from, to: TX.to, data: TX.input, gas: 400000n, block: '0x10', expected: EXPECTED.R1 });
  assert.equal(r.reason, 'InvalidDelegate');
  assert.deepEqual(calls, [['eth_call', [{ from: TX.from, to: TX.to, data: TX.input, gas: '0x61a80' }, '0x10']]]);
  await assert.rejects(simulateExpectedRevert({ label: 'R1', rpc: async () => { throw new Error('ECONNRESET'); }, from: TX.from, to: TX.to, data: '0x', expected: EXPECTED.R1 }), /ECONNRESET/);
});

test('post-mining check: a successful receipt fails the run', async () => {
  const rpc = async () => revertResp(INVALID_DELEGATE);
  await assert.rejects(verifyMinedRevert({ label: 'R1', rpc, receipt: { status: 'success', blockNumber: 100n }, tx: TX, expected: EXPECTED.R1 }), /status is success, not reverted/);
  await assert.rejects(verifyMinedRevert({ label: 'R1', rpc, receipt: { status: '0x1', blockNumber: 100n }, tx: TX, expected: EXPECTED.R1 }), /not reverted/);
  await assert.rejects(verifyMinedRevert({ label: 'R1', rpc, receipt: null, tx: TX, expected: EXPECTED.R1 }), /no receipt/);
});

test('post-mining check: reverted receipt but a replay with another reason (or an RPC error) fails', async () => {
  const receipt = { status: 'reverted', blockNumber: 100n };
  await assert.rejects(verifyMinedRevert({ label: 'R1', rpc: async () => revertResp(ALLOWANCE), receipt, tx: TX, expected: EXPECTED.R1 }), /unexpected revert/);
  await assert.rejects(verifyMinedRevert({ label: 'R1', rpc: async () => ({ error: { code: -32602, message: 'Archive requests require a personal token.' } }), receipt, tx: TX, expected: EXPECTED.R1 }), /without revert data/);
  await assert.rejects(verifyMinedRevert({ label: 'R1', rpc: async () => ({ result: '0x' }), receipt, tx: TX, expected: EXPECTED.R1 }), /did not revert/);
});

test('post-mining check: reverted receipt + matching parent-block replay passes', async () => {
  const calls = [];
  const rpc = async (m, p) => { calls.push(p[1]); return revertResp(INVALID_DELEGATE); };
  const r = await verifyMinedRevert({ label: 'R1', rpc, receipt: { status: 'reverted', blockNumber: 12150397n }, tx: TX, expected: EXPECTED.R1 });
  assert.deepEqual(r, { status: 'reverted', block: 12150397, replayBlock: 12150396, replayRevertData: INVALID_DELEGATE, replayDecoded: 'InvalidDelegate' });
  assert.deepEqual(calls, ['0x' + (12150396).toString(16)]);
});

const SCRIPT = fileURLToPath(new URL('../scripts/refusal.mjs', import.meta.url));
const RECORD = fileURLToPath(new URL('../live-refusal-result.json', import.meta.url));
const sha = () => createHash('sha256').update(readFileSync(RECORD)).digest('hex');
const run = (args, extraEnv = {}) => {
  const env = { ...process.env, ...extraEnv };
  for (const k of ['OWNER_KEY', 'CLERK_KEY', 'AGENT_KEY']) delete env[k];
  return spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8', timeout: 30000 });
};

test('script: run without --broadcast refuses (exit 2)', () => {
  const r = run(['run']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Refusing to send/);
});

test('script: run --broadcast never overwrites the recorded evidence (exit 2, file unchanged)', () => {
  const before = sha();
  const r = run(['run', '--broadcast'], { SEPOLIA_RPC_URL: 'http://127.0.0.1:9' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /already exists/);
  const r2 = run(['run', '--broadcast', '--out', RECORD], { SEPOLIA_RPC_URL: 'http://127.0.0.1:9' });
  assert.equal(r2.status, 2);
  assert.equal(sha(), before);
});

test('script: verify fails closed on an unreachable RPC and leaves the record unchanged', () => {
  const before = sha();
  const r = run(['verify', '--write'], { SEPOLIA_RPC_URL: 'http://127.0.0.1:9' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FAILED \(nothing written\)/);
  assert.equal(sha(), before);
});
