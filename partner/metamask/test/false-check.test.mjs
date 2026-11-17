// The FALSE-verdict refusal check (scripts/false-check.mjs): pure conclusions only. Offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFalseRefusal } from '../scripts/false-check.mjs';
import { carrierDecision, GATE_REVERT } from '../src/verdict-gate.mjs';
import { SAMPLE_CASE } from '../src/verdict-payment.mjs';

const FALSE_RAW = JSON.stringify({ status: 'resolved', verdict: 'FALSE', reasoning: 'contradicts the page' });
const FINAL = { recipient: SAMPLE_CASE.toLowerCase(), statusName: 'Finalized', txExecutionResultName: 'FinishedWithReturn' };
const ok = { verdict: { status: 'resolved', verdict: 'FALSE' }, decision: { post: false }, verdictTrueOnChain: false, plainReason: GATE_REVERT, overriddenOk: true };

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
