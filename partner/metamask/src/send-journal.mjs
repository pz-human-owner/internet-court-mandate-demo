// Durable send journal and resume reconciliation for scripts/onchain-check.mjs.
//
// Why: the runner's 5-transaction budget must hold across a crash and a resume. A process-local counter
// cannot see a transaction that was broadcast by an earlier process but never written to its record.
// So every send is journaled to disk, fsync'd, in two lines:
//   {"event":"intent","step":"T3","from":"0x…","nonce":1}   before the send (the nonce is pinned)
//   {"event":"sent","step":"T3","hash":"0x…"}                 as soon as the send returns, before any check
// A resume is allowed only after reconciling that journal against the chain (sender nonces and receipts),
// and only from the one supported point: exactly T1 and T2 sent and mined. Anything else is refused.
import { openSync, writeSync, fsyncSync, closeSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAddress } from 'viem';
import { GateError } from './refusal-gate.mjs';

export const STEPS = ['T1', 'T2', 'T3', 'T4', 'T5'];
/** Which account sends each step. */
export const SENDER = { T1: 'clerk', T2: 'clerk', T3: 'agent', T4: 'clerk', T5: 'agent' };
export const RECORD_KEY = { T1: 'T1_deployEnforcer', T2: 'T2_fundPrincipal', T3: 'T3_redeemBeforeVerdict', T4: 'T4_postVerdictTrue', T5: 'T5_redeemAfterVerdict' };
export const journalPathFor = (outPath) => `${outPath}.journal.jsonl`;

/** Append one JSON line and fsync before returning. */
function appendDurable(path, obj, flag = 'a') {
  const fd = openSync(path, flag);
  try { writeSync(fd, JSON.stringify(obj) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * Create a new journal (never overwrites). `start` records the accounts and their nonces before any send.
 * `prior` (optional) lists steps a resumed run inherits, already reconciled against the chain.
 */
export function createJournal(path, { accounts, startNonces, prior = [] }) {
  const entries = [];
  const put = (e, flag) => { appendDurable(path, e, flag); entries.push(e); };
  put({ event: 'start', accounts: { clerk: getAddress(accounts.clerk), agent: getAddress(accounts.agent) }, startNonces, atUtc: new Date().toISOString() }, 'wx');
  for (const p of prior) put({ event: 'inherited', ...p });
  return {
    path,
    entries,
    intent(step, from, nonce) { put({ event: 'intent', step, from: getAddress(from), nonce: Number(nonce), atUtc: new Date().toISOString() }); },
    sent(step, hash, extra = {}) { put({ event: 'sent', step, hash, ...extra, atUtc: new Date().toISOString() }); },
  };
}

/**
 * A transaction hash carried by a send error (viem and JSON-RPC errors may carry one when the node accepted
 * the transaction but something after that failed). Only fields named `hash` / `transactionHash` along the
 * `cause` chain count; message text is never parsed, so an unrelated 32-byte value cannot be mistaken for one.
 */
export function hashFromError(e) {
  const isHash = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
  for (let x = e, i = 0; x && typeof x === 'object' && i < 10; x = x.cause, i++) {
    for (const k of ['hash', 'transactionHash']) if (isHash(x[k])) return x[k];
    if (isHash(x.data?.hash)) return x.data.hash;
  }
  return null;
}

/**
 * The one send path: durable intent, then the send, then the durable hash. If the intent cannot be written,
 * nothing is sent. If the send throws with a hash, that hash is journaled before the error is rethrown. If the
 * hash cannot be written after a send, the intent stays open and any resume refuses it as an ambiguous send.
 */
export async function journaledSend({ journal, step, from, nonce, doSend }) {
  journal.intent(step, from, nonce);
  let h;
  try { h = await doSend(); } catch (e) {
    const eh = hashFromError(e);
    if (eh) journal.sent(step, eh, { fromError: String(e?.shortMessage ?? e?.message ?? e).slice(0, 200) });
    throw e;
  }
  journal.sent(step, h);
  return h;
}

/**
 * An incomplete record is single-use, by content and by run, not by path.
 * Identity: `contentSha256` = sha256 of the record's bytes; `runId` = sha256 of the journal's start entry
 * (accounts, start nonces, start time), which a copy, rename or edit of the record cannot change.
 * Consumption is recorded in a fixed per-machine ledger directory (default ~/.onchain-check/consumed-resumes,
 * override ONCHAIN_CHECK_LEDGER_DIR) as `run-<runId>.json` and `content-<sha>.json`, each created with O_EXCL,
 * before a resumed run can send. The path-local `<record>.consumed` marker is kept as a second, local check.
 * Boundary: the ledger is per machine; the pinned-nonce guard (resume refuses unless the chain's nonces match the
 * journal) still applies everywhere.
 */
export const consumedPathFor = (recordPath) => `${recordPath}.consumed`;
export const defaultLedgerDir = () => process.env.ONCHAIN_CHECK_LEDGER_DIR || join(homedir(), '.onchain-check', 'consumed-resumes');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
export function resumeIdentity(recordBytes, journalEntries) {
  const start = journalEntries?.[0];
  if (start?.event !== 'start') throw new GateError('resume: journal has no start entry');
  const runId = sha256(JSON.stringify({ accounts: start.accounts, startNonces: start.startNonces, atUtc: start.atUtc }));
  return { contentSha256: sha256(recordBytes), runId };
}
const ledgerFiles = (dir, id) => [join(dir, `run-${id.runId}.json`), join(dir, `content-${id.contentSha256}.json`)];
/** Why this record may not be resumed, or null. Read-only. */
export function consumedReason(recordPath, id, ledgerDir = defaultLedgerDir()) {
  const [runF, contentF] = ledgerFiles(ledgerDir, id);
  if (existsSync(runF)) return `its run (runId ${id.runId.slice(0, 16)}…) was already resumed once (ledger ${runF})`;
  if (existsSync(contentF)) return `a record with the same content (sha256 ${id.contentSha256.slice(0, 16)}…) was already used (ledger ${contentF})`;
  if (existsSync(consumedPathFor(recordPath))) return `${consumedPathFor(recordPath)} exists`;
  return null;
}
export const isConsumed = (recordPath, id, ledgerDir) => consumedReason(recordPath, id, ledgerDir) !== null;
export function consumeRecord(recordPath, { by, id, ledgerDir = defaultLedgerDir() }) {
  if (!id?.runId || !id?.contentSha256) throw new GateError('resume: consumeRecord needs the record identity');
  mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
  const entry = { event: 'consumed', record: recordPath, by, runId: id.runId, contentSha256: id.contentSha256, atUtc: new Date().toISOString() };
  const refuse = (why) => new GateError(`resume: ${recordPath} cannot be resumed: ${why}; an incomplete record is single-use. Refusing.`);
  // The run marker is the atomic claim: O_EXCL, so two concurrent resumes of the same run cannot both pass.
  for (const f of [...ledgerFiles(ledgerDir, id), consumedPathFor(recordPath)]) {
    try { appendDurable(f, entry, 'wx'); }
    catch (e) { if (e.code === 'EEXIST') throw refuse(consumedReason(recordPath, id, ledgerDir) ?? `${f} exists`); throw e; }
  }
}

export function readJournal(path) {
  const text = readFileSync(path, 'utf8');
  if (!text.endsWith('\n')) throw new GateError(`journal ${path}: last line is incomplete`);
  return text.trimEnd().split('\n').map((l, i) => { try { return JSON.parse(l); } catch { throw new GateError(`journal ${path}: line ${i + 1} is not JSON`); } });
}

/**
 * Fold journal entries into one row per step: { step, from, nonce, hash | null }.
 * An intent without a hash is a send whose outcome is unknown (the call threw or the process died).
 */
export function journalSends(entries) {
  if (entries[0]?.event !== 'start') throw new GateError('journal does not begin with a start entry');
  const rows = new Map();
  for (const e of entries.slice(1)) {
    if (!STEPS.includes(e.step)) throw new GateError(`journal: unknown step ${e.step}`);
    if (e.event === 'inherited') { rows.set(e.step, { step: e.step, from: getAddress(e.from), nonce: e.nonce, hash: e.hash }); continue; }
    if (e.event === 'intent') {
      if (rows.has(e.step)) throw new GateError(`journal: second intent for ${e.step}`);
      rows.set(e.step, { step: e.step, from: getAddress(e.from), nonce: e.nonce, hash: null });
    } else if (e.event === 'sent') {
      const r = rows.get(e.step);
      if (!r || r.hash) throw new GateError(`journal: sent ${e.step} without a single open intent`);
      r.hash = e.hash;
    } else throw new GateError(`journal: unknown event ${e.event}`);
  }
  return [...rows.values()];
}

/**
 * Decide whether an aborted run may be resumed, from the incomplete record, its journal, and what the
 * chain says now. Pure: `chain` is gathered by the caller:
 *   chain.nonces  = { clerk: { latest, pending }, agent: { latest, pending } }
 *   chain.txs     = { [hash]: { from, nonce, status, blockNumber } }   (status from the receipt; null if no receipt)
 * Returns { t1, t2, nonces } on success; throws GateError (refusal) on anything ambiguous.
 */
export function reconcileResume({ prior, entries, chain }) {
  if (!prior?.aborted) throw new GateError('resume: the record is not an aborted run');
  if (!prior.startNonces || !prior.journal) throw new GateError('resume: the record has no send journal (written by an older runner); reconcile by hand, do not resume');
  const start = entries[0];
  if (start?.event !== 'start') throw new GateError('resume: journal has no start entry');
  for (const who of ['clerk', 'agent']) {
    if (getAddress(start.accounts[who]) !== getAddress(prior.startNonces[who].address)) throw new GateError(`resume: journal ${who} differs from the record`);
    if (start.startNonces[who].nonce !== prior.startNonces[who].nonce) throw new GateError(`resume: journal ${who} start nonce differs from the record`);
  }
  const sends = journalSends(entries);
  const open = sends.filter((s) => !s.hash);
  if (open.length) throw new GateError(`resume: ambiguous send: ${open.map((s) => `${s.step} (nonce ${s.nonce})`).join(', ')} has an intent but no hash; it may have been broadcast. Refusing.`);
  // Every transaction in the record must be in the journal with the same hash.
  for (const [step, key] of Object.entries(RECORD_KEY)) {
    const recd = prior.transactions?.[key];
    if (recd && sends.find((s) => s.step === step)?.hash !== recd.hash) throw new GateError(`resume: record ${key} is not in the journal with the same hash`);
  }
  // Each journaled send must be on-chain from the right account at the expected nonce.
  const counts = { clerk: 0, agent: 0 };
  for (const s of sends) {
    const who = SENDER[s.step];
    const want = start.startNonces[who].nonce + counts[who];
    counts[who] += 1;
    if (getAddress(s.from) !== getAddress(start.accounts[who])) throw new GateError(`resume: ${s.step} journaled from ${s.from}, expected the ${who}`);
    if (s.nonce !== want) throw new GateError(`resume: ${s.step} journaled at nonce ${s.nonce}, expected ${want}`);
    const tx = chain.txs[s.hash];
    if (!tx) throw new GateError(`resume: ${s.step} ${s.hash} is not on-chain (dropped or pending); refusing`);
    if (getAddress(tx.from) !== getAddress(start.accounts[who]) || Number(tx.nonce) !== want) throw new GateError(`resume: ${s.step} on-chain from/nonce differs from the journal`);
    if (tx.status == null) throw new GateError(`resume: ${s.step} has no receipt yet; refusing`);
  }
  // Nonce reconciliation: the chain must show exactly the journaled sends, and nothing pending.
  for (const who of ['clerk', 'agent']) {
    const want = start.startNonces[who].nonce + counts[who];
    const n = chain.nonces[who];
    if (Number(n.latest) !== want || Number(n.pending) !== want) {
      throw new GateError(`resume: nonce mismatch for the ${who}: chain latest ${n.latest}, pending ${n.pending}; the journal accounts for ${start.startNonces[who].nonce}+${counts[who]} = ${want}. Something was sent that the journal does not explain; refusing.`);
    }
  }
  const steps = sends.map((s) => s.step);
  if (steps.join(',') !== 'T1,T2') {
    const after = steps.filter((s) => s !== 'T1' && s !== 'T2');
    throw new GateError(after.length
      ? `resume: ${after.join(', ')} already broadcast (${after.map((s) => sends.find((x) => x.step === s).hash).join(', ')}); resuming would resend. Refusing.`
      : `resume: supported only after T1 and T2 are both sent and mined; journal shows ${steps.join(', ') || 'nothing'}`);
  }
  for (const s of sends) if (chain.txs[s.hash].status !== 'success') throw new GateError(`resume: ${s.step} did not succeed on-chain`);
  if (chain.txs[sends[1].hash].blockNumber <= chain.txs[sends[0].hash].blockNumber) throw new GateError('resume: T2 is not after T1');
  return {
    t1: sends[0], t2: sends[1],
    nonces: { clerk: start.startNonces.clerk.nonce + counts.clerk, agent: start.startNonces.agent.nonce + counts.agent },
    sentBefore: { clerk: counts.clerk, agent: counts.agent },
  };
}

/** The resumedFrom block of a resumed record, derived from the prior run's own abort data (no fixed story). */
export function describeResume({ prior, reconciled }) {
  const sc = prior.startNonces.clerk.nonce, sa = prior.startNonces.agent.nonce;
  const steps = ['T1', 'T2'];
  return {
    priorRunStartedAtUtc: prior.startedAtUtc,
    priorRunAbortedAtUtc: prior.abortedAtUtc ?? null,
    priorRunAbortedAtStep: prior.abortedAtStep ?? null,
    abortReason: prior.aborted,
    reconciledBeforeResume: {
      sent: steps.map((s) => ({ step: s, hash: reconciled[s.toLowerCase()].hash, nonce: reconciled[s.toLowerCase()].nonce })),
      clerkNonce: `${sc} -> ${reconciled.nonces.clerk}`, agentNonce: `${sa} -> ${reconciled.nonces.agent}`, nothingPending: true,
    },
    explanation: `The prior run (started ${prior.startedAtUtc}) aborted${prior.abortedAtStep ? ` at ${prior.abortedAtStep}` : ''} with: "${prior.aborted}". `
      + `Its send journal and the chain agree that it had sent ${steps.join(' and ')} and nothing else (clerk nonce ${sc} -> ${reconciled.nonces.clerk}, agent nonce ${sa} -> ${reconciled.nonces.agent}, nothing pending). `
      + 'This run re-verified those transactions on-chain, counted them against the same 5-transaction budget, and reused the delegation signed in the prior run.',
  };
}
