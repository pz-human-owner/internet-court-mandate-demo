// The FALSE-verdict refusal check (scripts/false-check.mjs): pure conclusions only. Offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFalseRefusal } from '../scripts/false-check.mjs';
import { carrierDecision, GATE_REVERT } from '../src/verdict-gate.mjs';
import { SAMPLE_CASE } from '../src/verdict-payment.mjs';

const FALSE_RAW = JSON.stringify({ status: 'resolved', verdict: 'FALSE', reasoning: 'contradicts the page' });
const FINAL = { recipient: SAMPLE_CASE.toLowerCase(), statusName: 'Finalized', txExecutionResultName: 'FinishedWithReturn' };
const ok = { verdict: { status: 'resolved', verdict: 'FALSE' }, decision: { post: false }, verdictTrueOnChain: false, plainReason: GATE_REVERT, balanceOnlyReason: GATE_REVERT, overriddenOk: true };

test('carrier rule: a finalized FALSE verdict is never posted', () => {
  const d = carrierDecision({ verdictRaw: FALSE_RAW, genReceipt: FINAL, caseContract: SAMPLE_CASE });
  assert.equal(d.post, false);
  assert.match(d.why, /verdict is FALSE/);
});

test('assertFalseRefusal passes only for FALSE + no post + gate revert + working counterfactual', () => {
  assert.equal(assertFalseRefusal(ok), true);
  assert.throws(() => assertFalseRefusal({ ...ok, verdict: { status: 'resolved', verdict: 'TRUE' } }), /not resolved\/FALSE/);
  assert.throws(() => assertFalseRefusal({ ...ok, verdict: { status: 'resolved', verdict: 'UNDETERMINED' } }), /not resolved\/FALSE/);
  assert.throws(() => assertFalseRefusal({ ...ok, decision: { post: true } }), /would post TRUE/);
  assert.throws(() => assertFalseRefusal({ ...ok, verdictTrueOnChain: true }), /already set/);
  assert.throws(() => assertFalseRefusal({ ...ok, plainReason: null }), /succeeded, expected/);
  assert.throws(() => assertFalseRefusal({ ...ok, plainReason: 'InvalidDelegate' }), /InvalidDelegate/);
  assert.throws(() => assertFalseRefusal({ ...ok, overriddenOk: false }), /counterfactual/);
});

test('false-check.mjs sends nothing: no sendTransaction / writeContract / sendRawTransaction, output written wx', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../scripts/false-check.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /sendTransaction|writeContract|sendRawTransaction|eth_sendRawTransaction|createWalletClient/);
  assert.match(src, /writeFileSync\(outArg, .*\{ flag: 'wx' \}\)/);
});

// #124 round 6936737208: receipt evidence, balance-only simulation, required --request-txid.
import { summarizeReceipt, assertReceipt, decodeVotes } from '../scripts/false-check.mjs';
import { spawnSync } from 'node:child_process';

const RAW_RECEIPT = {
  id: '0xabc', sender: '0x0f21', recipient: SAMPLE_CASE.toLowerCase(), statusName: 'Finalized', txExecutionResultName: 'FinishedWithReturn',
  numOfInitialValidators: 5, resultHash: '0xaa', timestamps: { Created: 1, Committed: 2, LastVote: 3 },
  roundData: [{ round: 0, leaderIndex: 0, votesCommitted: 5, votesRevealed: 5, result: 1,
    roundValidators: ['0x1', '0x2', '0x3', '0x4', '0x5'], validatorVotes: 'AQEBAwE=', validatorResultHash: ['aa', 'aa', 'aa', 'bb', 'aa'] }],
};

test('decodeVotes reads base64, hex and arrays', () => {
  assert.deepEqual(decodeVotes('AQEBAwE='), [1, 1, 1, 3, 1]);
  assert.deepEqual(decodeVotes('0x0101'), [1, 1]);
  assert.deepEqual(decodeVotes([1, 3]), [1, 3]);
  assert.deepEqual(decodeVotes(undefined), []);
});

test('summarizeReceipt records finality, round result, validator count and each vote', () => {
  const r = summarizeReceipt(RAW_RECEIPT);
  assert.equal(r.statusName, 'Finalized');
  assert.equal(r.numOfInitialValidators, 5);
  assert.equal(r.lastRound.result, 'MAJORITY_AGREE');
  assert.equal(r.lastRound.validatorCount, 5);
  assert.deepEqual(r.lastRound.voteTally, { FINISHED_WITH_RETURN: 4, TIMEOUT: 1 });
  assert.equal(r.lastRound.validatorsMatchingLeaderResult, 4);
  assert.equal(r.lastRound.validators[3].vote, 'TIMEOUT');
  assert.equal(r.lastRound.validators[3].matchesLeaderResult, false);
  assert.equal(summarizeReceipt(null), null);
});

test('assertReceipt requires this case, Finalized, FinishedWithReturn and MAJORITY_AGREE', () => {
  const r = summarizeReceipt(RAW_RECEIPT);
  assert.equal(assertReceipt(r, SAMPLE_CASE, '0xABC'), true);
  assert.throws(() => assertReceipt(null, SAMPLE_CASE), /no GenLayer receipt/);
  assert.throws(() => assertReceipt(r, SAMPLE_CASE, '0xdef'), /differs from --request-txid/);
  assert.throws(() => assertReceipt(r, '0x0000000000000000000000000000000000000001'), /different contract/);
  assert.throws(() => assertReceipt({ ...r, statusName: 'Accepted' }, SAMPLE_CASE), /not Finalized/);
  assert.throws(() => assertReceipt({ ...r, txExecutionResultName: 'FinishedWithError' }, SAMPLE_CASE), /FinishedWithError/);
  assert.throws(() => assertReceipt(summarizeReceipt({ ...RAW_RECEIPT, roundData: [{ ...RAW_RECEIPT.roundData[0], result: 5 }] }), SAMPLE_CASE), /NO_MAJORITY/);
  assert.throws(() => assertReceipt(summarizeReceipt({ ...RAW_RECEIPT, roundData: [] }), SAMPLE_CASE), /missing/);
});

test('assertFalseRefusal requires the balance-only simulation to still hit the gate', () => {
  assert.throws(() => assertFalseRefusal({ ...ok, balanceOnlyReason: null }), /balance-only eth_call: succeeded/);
  assert.throws(() => assertFalseRefusal({ ...ok, balanceOnlyReason: 'InsufficientBalance' }), /balance-only/);
});

test('check refuses without --request-txid unless --no-receipt is explicit (before any network use)', () => {
  const script = new URL('../scripts/false-check.mjs', import.meta.url).pathname;
  const run = (extra) => spawnSync(process.execPath, [script, 'check', '--case', SAMPLE_CASE, '--out', '/nonexistent-dir/x.json', ...extra], { env: { ...process.env, OWNER_KEY: '' }, encoding: 'utf8' });
  const a = run([]);
  assert.equal(a.status, 2); assert.match(a.stderr, /--request-txid <id> \| --no-receipt/);
  const b = run(['--request-txid', '0xabc', '--no-receipt']);
  assert.equal(b.status, 2); assert.match(b.stderr, /usage/);
});

test('false-check.mjs records the receipt and the balance-only run in its output', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../scripts/false-check.mjs', import.meta.url), 'utf8');
  assert.match(src, /receiptChecked: !noReceipt/);
  assert.match(src, /receipt not checked/);
  assert.match(src, /balanceOnlyEthCall/);
  assert.ok(src.indexOf('assertReceipt(receipt, caseContract') < src.indexOf('createPublicClient({ chain: sepolia'), 'receipt is checked before any Sepolia call');
});
