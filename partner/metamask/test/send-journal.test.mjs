// Send journal and resume reconciliation (src/send-journal.mjs). Offline: the chain is a plain object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createJournal, readJournal, journalSends, reconcileResume, describeResume, journalPathFor } from '../src/send-journal.mjs';

const clerk = '0x906b4D9d64a5d4Bb559292A3f24562835a122D10';
const agent = '0x8b5deeE4A52c321C81C33b2bC99834EB05B04929';
const H = (n) => `0x${String(n).repeat(64).slice(0, 64)}`;
const startNonces = { clerk: { address: clerk, nonce: 4 }, agent: { address: agent, nonce: 1 } };
const dir = () => mkdtempSync(join(tmpdir(), 'journal-'));

/** A journal + incomplete record + chain view; `sends` is [[step, hash|null], ...]. */
function scenario(sends, { chainNonces, recordT = {}, txOverride = {} } = {}) {
  const path = join(dir(), 'run.json.journal.jsonl');
  const j = createJournal(path, { accounts: { clerk, agent }, startNonces });
  const n = { clerk: 4, agent: 1 };
  const txs = {};
  let block = 100;
  for (const [step, hash] of sends) {
    const who = step === 'T3' || step === 'T5' ? 'agent' : 'clerk';
    j.intent(step, who === 'clerk' ? clerk : agent, n[who]);
    if (hash) { j.sent(step, hash); txs[hash] = { from: who === 'clerk' ? clerk : agent, nonce: n[who], status: step === 'T3' ? 'reverted' : 'success', blockNumber: block++ }; }
    n[who] += 1;
  }
  Object.assign(txs, txOverride);
  const nonces = chainNonces ?? { clerk: { latest: n.clerk, pending: n.clerk }, agent: { latest: n.agent, pending: n.agent } };
  const prior = { aborted: 'T2: principal balance rose by 0, not 1000000000000000', abortedAtUtc: '2026-11-17T00:14:50.000Z', abortedAtStep: 'T2',
    startedAtUtc: '2026-11-17T00:14:17.647Z', startNonces, journal: 'run.json.journal.jsonl', transactions: recordT };
  return { prior, entries: readJournal(path), chain: { nonces, txs }, path };
}

test('journal: intent then hash, fsync\'d lines; never overwrites; incomplete last line is refused', () => {
  const p = join(dir(), 'x.journal.jsonl');
  const j = createJournal(p, { accounts: { clerk, agent }, startNonces });
  j.intent('T1', clerk, 4);
  j.sent('T1', H(1));
  const lines = readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.event), ['start', 'intent', 'sent']);
  assert.deepEqual(journalSends(readJournal(p)), [{ step: 'T1', from: clerk, nonce: 4, hash: H(1) }]);
  assert.throws(() => createJournal(p, { accounts: { clerk, agent }, startNonces }), /EEXIST/);
  appendFileSync(p, '{"event":"intent"');
  assert.throws(() => readJournal(p), /incomplete/);
  assert.equal(journalPathFor('/a/b.json'), '/a/b.json.journal.jsonl');
});

test('resume: T1 and T2 sent and mined, nonces agree -> allowed; T2 is bound to the journal', () => {
  const s = scenario([['T1', H(1)], ['T2', H(2)]], { recordT: { T1_deployEnforcer: { hash: H(1) } } });
  const r = reconcileResume(s);
  assert.equal(r.t2.hash, H(2));
  assert.deepEqual(r.nonces, { clerk: 6, agent: 1 });
  assert.deepEqual(r.sentBefore, { clerk: 2, agent: 0 });
});

test('crash after send: T3 broadcast but missing from the record -> refused (would resend)', () => {
  const s = scenario([['T1', H(1)], ['T2', H(2)], ['T3', H(3)]], { recordT: { T1_deployEnforcer: { hash: H(1) }, T2_fundPrincipal: { hash: H(2) } } });
  assert.throws(() => reconcileResume(s), /T3 already broadcast .*resuming would resend/);
});

test('crash during send: an intent with no hash is ambiguous -> refused', () => {
  const s = scenario([['T1', H(1)], ['T2', H(2)], ['T3', null]]);
  assert.throws(() => reconcileResume(s), /ambiguous send: T3 \(nonce 1\)/);
});

test('nonce mismatch: the agent nonce advanced but the journal has no T3 -> refused', () => {
  const s = scenario([['T1', H(1)], ['T2', H(2)]], { chainNonces: { clerk: { latest: 6, pending: 6 }, agent: { latest: 2, pending: 2 } } });
  assert.throws(() => reconcileResume(s), /nonce mismatch for the agent: chain latest 2.*1\+0 = 1/);
});

test('nonce mismatch: an extra clerk transaction, or anything pending -> refused', () => {
  assert.throws(() => reconcileResume(scenario([['T1', H(1)], ['T2', H(2)]], { chainNonces: { clerk: { latest: 7, pending: 7 }, agent: { latest: 1, pending: 1 } } })), /nonce mismatch for the clerk/);
  assert.throws(() => reconcileResume(scenario([['T1', H(1)], ['T2', H(2)]], { chainNonces: { clerk: { latest: 6, pending: 7 }, agent: { latest: 1, pending: 1 } } })), /nonce mismatch for the clerk: chain latest 6, pending 7/);
});

test('a journaled send that is not on-chain, has no receipt, failed, or has the wrong nonce -> refused', () => {
  assert.throws(() => reconcileResume(scenario([['T1', H(1)], ['T2', H(2)]], { txOverride: { [H(2)]: undefined } })), /T2 .* is not on-chain/);
  assert.throws(() => reconcileResume(scenario([['T1', H(1)], ['T2', H(2)]], { txOverride: { [H(2)]: { from: clerk, nonce: 5, status: null, blockNumber: null } } })), /T2 has no receipt/);
  assert.throws(() => reconcileResume(scenario([['T1', H(1)], ['T2', H(2)]], { txOverride: { [H(2)]: { from: clerk, nonce: 5, status: 'reverted', blockNumber: 200 } } })), /T2 did not succeed/);
  assert.throws(() => reconcileResume(scenario([['T1', H(1)], ['T2', H(2)]], { txOverride: { [H(2)]: { from: clerk, nonce: 9, status: 'success', blockNumber: 200 } } })), /on-chain from\/nonce differs/);
});

test('record and journal must agree; older records without a journal cannot be resumed; only T1 is not a resume point', () => {
  assert.throws(() => reconcileResume(scenario([['T1', H(1)], ['T2', H(2)]], { recordT: { T2_fundPrincipal: { hash: H(9) } } })), /T2_fundPrincipal is not in the journal/);
  const s = scenario([['T1', H(1)], ['T2', H(2)]]);
  assert.throws(() => reconcileResume({ ...s, prior: { ...s.prior, journal: undefined } }), /no send journal/);
  assert.throws(() => reconcileResume({ ...s, prior: { ...s.prior, aborted: undefined } }), /not an aborted run/);
  assert.throws(() => reconcileResume({ ...s, prior: { ...s.prior, startNonces: { ...startNonces, clerk: { address: clerk, nonce: 3 } } } }), /start nonce differs/);
  assert.throws(() => reconcileResume(scenario([['T1', H(1)]])), /only after T1 and T2/);
});

test('describeResume derives its text from the abort data, not a fixed story', () => {
  const s = scenario([['T1', H(1)], ['T2', H(2)]]);
  const d = describeResume({ prior: s.prior, reconciled: reconcileResume(s) });
  assert.equal(d.priorRunStartedAtUtc, '2026-11-17T00:14:17.647Z');
  assert.equal(d.priorRunAbortedAtUtc, '2026-11-17T00:14:50.000Z');
  assert.equal(d.priorRunAbortedAtStep, 'T2');
  assert.ok(!('abortedAtUtc' in d));
  assert.match(d.explanation, /aborted at T2 with: "T2: principal balance rose by 0/);
  assert.match(d.explanation, /clerk nonce 4 -> 6, agent nonce 1 -> 1, nothing pending/);
  assert.doesNotMatch(d.explanation, /stale|load-balanced/);
  const other = describeResume({ prior: { ...s.prior, aborted: 'T2: RPC timeout', abortedAtStep: 'T2' }, reconciled: reconcileResume(s) });
  assert.match(other.explanation, /"T2: RPC timeout"/);
});

test('runner: --t2-hash is refused, and a resume file without a journal is refused (no keys, no network)', () => {
  const script = new URL('../scripts/onchain-check.mjs', import.meta.url).pathname;
  const a = spawnSync(process.execPath, [script, 'run', '--broadcast', '--resume', 'x.json', '--t2-hash', H(2), '--out', join(dir(), 'o.json')], { encoding: 'utf8', env: {} });
  assert.equal(a.status, 2);
  assert.match(a.stderr, /--t2-hash is no longer accepted/);
  const legacy = join(dir(), 'legacy.incomplete.json');
  writeFileSync(legacy, JSON.stringify({ aborted: 'x', transactions: { T1_deployEnforcer: { hash: H(1) } } }));
  const b = spawnSync(process.execPath, [script, 'run', '--broadcast', '--resume', legacy, '--out', join(dir(), 'o.json')], { encoding: 'utf8', env: {} });
  assert.equal(b.status, 2);
  assert.match(b.stderr, /not an aborted run with a send journal/);
});

test('runner source: each send journals its intent before and its hash right after sendTransaction, before any check', () => {
  const src = readFileSync(new URL('../scripts/onchain-check.mjs', import.meta.url), 'utf8');
  assert.equal((src.match(/\.sendTransaction\(/g) ?? []).length, 1, 'all sends go through one helper');
  const m = src.match(/budget\.take\(stepName\);\s*journal\.intent\(stepName, accts\[who\], nonce\);\s*sendCount\[who\] \+= 1;\s*const h = await wallet\.sendTransaction\(\{ \.\.\.tx, nonce \}\);\s*journal\.sent\(stepName, h\);/);
  assert.ok(m, 'intent -> send with pinned nonce -> sent, with nothing in between');
  for (const st of ['T1', 'T2', 'T3', 'T4', 'T5']) assert.match(src, new RegExp(`await send\\('${st}'`));
});
