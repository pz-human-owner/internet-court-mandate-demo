// Send journal and resume reconciliation (src/send-journal.mjs). Offline: the chain is a plain object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync, mkdirSync, existsSync, copyFileSync, renameSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createJournal, readJournal, journalSends, reconcileResume, describeResume, journalPathFor, journaledSend, hashFromError, consumeRecord, consumedPathFor, consumedReason, resumeIdentity } from '../src/send-journal.mjs';

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

test('runner source: every send goes through journaledSend with the pinned nonce; one sendTransaction call site', () => {
  const src = readFileSync(new URL('../scripts/onchain-check.mjs', import.meta.url), 'utf8');
  assert.equal((src.match(/\.sendTransaction\(/g) ?? []).length, 1, 'all sends go through one helper');
  assert.match(src, /budget\.take\(stepName\);\s*sendCount\[who\] \+= 1;\s*const h = await journaledSend\(\{ journal, step: stepName, from: accts\[who\], nonce, doSend: \(\) => wallet\.sendTransaction\(\{ \.\.\.tx, nonce \}\) \}\);/);
  for (const st of ['T1', 'T2', 'T3', 'T4', 'T5']) assert.match(src, new RegExp(`await send\\('${st}'`));
  // The record is consumed (content + run ledger) right after reconciliation, before `send` exists.
  assert.ok(src.includes('consumeRecord(resume.priorPath, { by: outPath, id: resume.id })'));
  assert.ok(src.indexOf('consumeRecord(resume.priorPath') > 0 && src.indexOf('consumeRecord(resume.priorPath') < src.indexOf('const send = async'));
});

const openJournal = () => { const p = join(dir(), 'r.json.journal.jsonl'); return { p, j: createJournal(p, { accounts: { clerk, agent }, startNonces }) }; };

test('journaledSend: intent, send, hash, in that order', async () => {
  const { p, j } = openJournal();
  const order = [];
  const h = await journaledSend({ journal: j, step: 'T1', from: clerk, nonce: 4, doSend: async () => { order.push(readJournal(p).at(-1).event); return H(1); } });
  assert.equal(h, H(1));
  assert.deepEqual(order, ['intent'], 'the intent is on disk before the send runs');
  assert.deepEqual(readJournal(p).map((e) => e.event), ['start', 'intent', 'sent']);
});

test('journal write fails before the send: nothing is sent', async () => {
  const { p, j } = openJournal();
  rmSync(p); mkdirSync(p); // the journal path is now a directory: every append fails (EISDIR), even as root
  let sends = 0;
  await assert.rejects(journaledSend({ journal: j, step: 'T1', from: clerk, nonce: 4, doSend: async () => { sends += 1; return H(1); } }), /EISDIR/);
  assert.equal(sends, 0);
});

test('journal write fails after the send: the intent stays open and a resume refuses it as ambiguous', async () => {
  const s = scenario([['T1', H(1)], ['T2', H(2)]]);
  const real = createJournal(join(dir(), 'x.journal.jsonl'), { accounts: { clerk, agent }, startNonces });
  const failing = { ...real, sent() { throw new Error('ENOSPC: no space left on device'); } };
  let sends = 0;
  await assert.rejects(journaledSend({ journal: failing, step: 'T3', from: agent, nonce: 1, doSend: async () => { sends += 1; return H(3); } }), /ENOSPC/);
  assert.equal(sends, 1, 'sent exactly once, never retried');
  const entries = [...s.entries, ...real.entries.slice(1)];
  assert.deepEqual(journalSends(entries).at(-1), { step: 'T3', from: agent, nonce: 1, hash: null });
  assert.throws(() => reconcileResume({ ...s, entries, chain: { ...s.chain, nonces: { ...s.chain.nonces, agent: { latest: 2, pending: 2 } } } }), /ambiguous send: T3 \(nonce 1\)/);
});

test('a send error that carries a hash is journaled before rethrowing; message text is never parsed', async () => {
  const err = Object.assign(new Error('TransactionReceiptNotFound'), { cause: Object.assign(new Error('inner'), { transactionHash: H(7) }) });
  assert.equal(hashFromError(err), H(7));
  assert.equal(hashFromError({ hash: H(8) }), H(8));
  assert.equal(hashFromError({ data: { hash: H(9) } }), H(9));
  assert.equal(hashFromError(new Error(`execution reverted ${H(5)}`)), null);
  assert.equal(hashFromError({ hash: '0x1234' }), null);
  assert.equal(hashFromError(null), null);
  const { p, j } = openJournal();
  await assert.rejects(journaledSend({ journal: j, step: 'T3', from: agent, nonce: 1, doSend: async () => { throw err; } }), /TransactionReceiptNotFound/);
  const last = readJournal(p).at(-1);
  assert.equal(last.event, 'sent'); assert.equal(last.hash, H(7)); assert.match(last.fromError, /TransactionReceiptNotFound/);
  // An error with no hash leaves the intent open (ambiguous).
  const o = openJournal();
  await assert.rejects(journaledSend({ journal: o.j, step: 'T3', from: agent, nonce: 1, doSend: async () => { throw new Error('socket hang up'); } }));
  assert.equal(journalSends(readJournal(o.p)).at(-1).hash, null);
});

/** An aborted run on disk: incomplete record + its journal, in a fresh dir. */
function abortedRun(d = dir()) {
  const journal = createJournal(join(d, 'run.json.journal.jsonl'), { accounts: { clerk, agent }, startNonces });
  journal.intent('T1', clerk, 4); journal.sent('T1', H(1)); journal.intent('T2', clerk, 5); journal.sent('T2', H(2));
  const rec = join(d, 'run.json.incomplete.json');
  writeFileSync(rec, JSON.stringify({ aborted: 'x', abortedAtStep: 'T2', journal: 'run.json.journal.jsonl', startNonces, startedAtUtc: '2026-11-17T00:00:00.000Z', transactions: {} }, null, 2) + '\n');
  return { d, rec, jpath: journal.path, id: resumeIdentity(readFileSync(rec), readJournal(journal.path)) };
}

test('single-use: the second consume of the same record is refused', () => {
  const ledger = dir();
  const { rec, id } = abortedRun();
  assert.equal(consumedReason(rec, id, ledger), null);
  consumeRecord(rec, { by: '/tmp/resume-1.json', id, ledgerDir: ledger });
  assert.deepEqual(readdirSync(ledger).sort(), [`content-${id.contentSha256}.json`, `run-${id.runId}.json`]);
  assert.equal(JSON.parse(readFileSync(join(ledger, `run-${id.runId}.json`), 'utf8')).by, '/tmp/resume-1.json');
  assert.ok(existsSync(consumedPathFor(rec)));
  assert.throws(() => consumeRecord(rec, { by: '/tmp/resume-2.json', id, ledgerDir: ledger }), /cannot be resumed: its run .* was already resumed once.*single-use/);
});

test('single-use survives a copy, a rename, a deleted marker and an edited copy (ledger keyed by content and run)', () => {
  const ledger = dir();
  const a = abortedRun();
  consumeRecord(a.rec, { by: 'first', id: a.id, ledgerDir: ledger });
  // Copy record + journal to another directory: same content, same run.
  const d2 = dir();
  copyFileSync(a.rec, join(d2, 'run.json.incomplete.json')); copyFileSync(a.jpath, join(d2, 'run.json.journal.jsonl'));
  const idCopy = resumeIdentity(readFileSync(join(d2, 'run.json.incomplete.json')), readJournal(join(d2, 'run.json.journal.jsonl')));
  assert.deepEqual(idCopy, a.id);
  assert.match(consumedReason(join(d2, 'run.json.incomplete.json'), idCopy, ledger), /already resumed once/);
  assert.throws(() => consumeRecord(join(d2, 'run.json.incomplete.json'), { by: 'copy', id: idCopy, ledgerDir: ledger }), /single-use/);
  // Rename in place.
  const renamed = join(a.d, 'renamed.incomplete.json');
  renameSync(a.rec, renamed);
  assert.match(consumedReason(renamed, resumeIdentity(readFileSync(renamed), readJournal(a.jpath)), ledger), /already resumed once/);
  // Delete the path-local marker: the ledger still refuses.
  rmSync(consumedPathFor(a.rec));
  assert.match(consumedReason(renamed, a.id, ledger), /already resumed once/);
  // Edit the record (new content hash): the run id is unchanged, still refused.
  const edited = join(a.d, 'edited.incomplete.json');
  writeFileSync(edited, readFileSync(renamed, 'utf8').replace('"aborted": "x"', '"aborted": "y"'));
  const idEdited = resumeIdentity(readFileSync(edited), readJournal(a.jpath));
  assert.notEqual(idEdited.contentSha256, a.id.contentSha256);
  assert.equal(idEdited.runId, a.id.runId);
  assert.throws(() => consumeRecord(edited, { by: 'edited', id: idEdited, ledgerDir: ledger }), /already resumed once/);
  // A different run is unaffected.
  const b = abortedRun();
  const other = createJournal(join(dir(), 'j.jsonl'), { accounts: { clerk, agent }, startNonces: { ...startNonces, clerk: { address: clerk, nonce: 10 } } });
  assert.notEqual(resumeIdentity(readFileSync(b.rec), other.entries).runId, a.id.runId);
});

test('runner: resuming a consumed record, a copy of it, or after deleting its marker is refused before any network use', () => {
  const script = new URL('../scripts/onchain-check.mjs', import.meta.url).pathname;
  const ledger = dir();
  const a = abortedRun();
  consumeRecord(a.rec, { by: 'first', id: a.id, ledgerDir: ledger });
  const run = (rec) => spawnSync(process.execPath, [script, 'run', '--broadcast', '--resume', rec, '--out', join(dir(), 'o.json')], { encoding: 'utf8', env: { SEPOLIA_RPC_URL: 'http://127.0.0.1:9', ONCHAIN_CHECK_LEDGER_DIR: ledger } });
  let r = run(a.rec);
  assert.equal(r.status, 2); assert.match(r.stderr, /cannot be resumed: its run .* already resumed once.*single-use/);
  const d2 = dir();
  copyFileSync(a.rec, join(d2, 'copy.incomplete.json')); copyFileSync(a.jpath, join(d2, 'run.json.journal.jsonl'));
  r = run(join(d2, 'copy.incomplete.json'));
  assert.equal(r.status, 2); assert.match(r.stderr, /already resumed once/);
  rmSync(consumedPathFor(a.rec));
  r = run(a.rec);
  assert.equal(r.status, 2); assert.match(r.stderr, /already resumed once/);
});
