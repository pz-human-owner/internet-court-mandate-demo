// Static checks of the recorded live on-chain verdict-check run (no network, no keys).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { getSmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
import { caseSalt, hashDelegation, SAMPLE_CASE } from '../src/verdict-payment.mjs';
import { decodeRevertData } from '../src/refusal-gate.mjs';
import { GATE_REVERT, decodeGateTerms, verdictSlot } from '../src/verdict-gate.mjs';

const r = JSON.parse(readFileSync(new URL('../live-onchain-check-result.json', import.meta.url), 'utf8'));
const v = JSON.parse(readFileSync(new URL('../live-onchain-check-verify.json', import.meta.url), 'utf8'));
const live = JSON.parse(readFileSync(new URL('../live-result.json', import.meta.url), 'utf8'));
const refusal = JSON.parse(readFileSync(new URL('../live-refusal-result.json', import.meta.url), 'utf8'));
const env = getSmartAccountsEnvironment(11155111);
const t = r.transactions;
const order = ['T1_deployEnforcer', 'T2_fundPrincipal', 'T3_redeemBeforeVerdict', 'T4_postVerdictTrue', 'T5_redeemAfterVerdict'];

test('record: Sepolia, the same throwaway accounts, no key material, honest note', () => {
  assert.equal(r.chainId, 11155111);
  assert.equal(getAddress(r.delegationManager), getAddress(env.DelegationManager));
  assert.equal(getAddress(r.accounts.owner), getAddress(live.accounts.owner));
  assert.equal(getAddress(r.accounts.carrier), getAddress(live.accounts.clerk));
  assert.equal(getAddress(r.accounts.agent), getAddress(live.accounts.agent));
  assert.equal(getAddress(r.accounts.principalSmartAccount), getAddress(live.accounts.principalSmartAccount));
  assert.doesNotMatch(JSON.stringify(r), /"[a-z_]*(private|_key|mnemonic|seed)[a-z_]*"\s*:/i);
  assert.match(r.note, /NOT trustless/);
  assert.doesNotMatch(JSON.stringify(r).replace(/NOT trustless/g, ''), /trustless|oracle-free/i);
});

test('exactly five transactions, in order, after the earlier live runs', () => {
  assert.deepEqual(Object.keys(t), order);
  assert.equal(r.checks.transactionsUsed, 5);
  let prev = Math.max(...Object.values(refusal.transactions).map((x) => x.block));
  for (const k of order) {
    assert.match(t[k].hash, /^0x[0-9a-f]{64}$/);
    assert.equal(t[k].etherscan, `https://sepolia.etherscan.io/tx/${t[k].hash}`);
    assert.ok(t[k].block > prev, `${k} block order`);
    prev = t[k].block;
  }
  assert.deepEqual(order.map((k) => t[k].status), ['success', 'success', 'reverted', 'success', 'success']);
});

test('the GenLayer read the carrier acted on: resolved TRUE and Finalized', () => {
  const g = r.genlayerRead;
  assert.equal(JSON.parse(g.raw).status, 'resolved');
  assert.equal(JSON.parse(g.raw).verdict, 'TRUE');
  assert.equal(g.receipt.statusName, 'Finalized');
  assert.equal(getAddress(g.receipt.recipient), SAMPLE_CASE);
  assert.equal(g.carrierDecision.post, true);
});

test('the signed delegation: principal -> agent, gate caveat names this case and the carrier', async () => {
  const d = r.delegation.signed;
  assert.equal(hashDelegation(d), r.delegation.hash);
  assert.equal(getAddress(d.delegator), getAddress(r.accounts.principalSmartAccount));
  assert.equal(getAddress(d.delegate), getAddress(r.accounts.agent));
  assert.equal(d.salt, caseSalt(SAMPLE_CASE));
  const g = d.caveats[r.delegation.gateCaveatIndex];
  assert.equal(getAddress(g.enforcer), getAddress(r.enforcer.address));
  assert.deepEqual(decodeGateTerms(g.terms), { caseKey: caseSalt(SAMPLE_CASE), carrier: getAddress(r.accounts.carrier) });
  assert.equal(r.case.caseKey, caseSalt(SAMPLE_CASE));
});

test('T1: the enforcer is the committed pinned build, verified on Sourcify', () => {
  assert.equal(getAddress(t.T1_deployEnforcer.contractAddress), getAddress(r.enforcer.address));
  assert.equal(getAddress(t.T1_deployEnforcer.from), getAddress(r.accounts.carrier));
  assert.equal(r.enforcer.runtimeCodeMatchesArtifact, true);
  assert.equal(v.passed, true);
  assert.equal(v.results.enforcerCodeMatchesArtifact, true);
  assert.equal(v.results.sourcify.match, 'exact_match');
});

test('T3: the agent is blocked by the gate before a verdict is posted, and only by the gate', () => {
  const x = t.T3_redeemBeforeVerdict;
  assert.equal(getAddress(x.from), getAddress(r.accounts.agent));
  assert.equal(x.delegationHash, r.delegation.hash);
  assert.equal(decodeRevertData(x.simulatedRevertData), GATE_REVERT);
  assert.equal(x.replayAtParentBlock.decoded, GATE_REVERT);
  assert.equal(v.results.T3_redeemBeforeVerdict.replayDecoded, GATE_REVERT);
  assert.equal(getAddress(x.blockedByAddress), getAddress(r.enforcer.address));
  // The counterfactual is a pinned simulation at T2's block, not a trace of the mined T3; the claim says so.
  assert.equal(x.counterfactual.block, t.T2_fundPrincipal.block);
  assert.equal(x.counterfactual.minedT3Block, x.block);
  assert.equal(x.counterfactual.withoutOverride, GATE_REVERT);
  assert.equal(x.counterfactual.withOverride, 'success');
  assert.equal(x.counterfactual.override.slot, verdictSlot(r.accounts.carrier, r.case.caseKey));
  assert.match(x.counterfactual.claim, new RegExp(`^In this pinned simulation at block ${t.T2_fundPrincipal.block}, .*in that simulation the gate was the only obstacle`));
  assert.deepEqual(v.results.counterfactualReplay, { block: t.T2_fundPrincipal.block, withoutOverride: GATE_REVERT, withOverride: 'success' });
  assert.ok(x.gasUsed < x.gasLimit, 'reverted with gas left (not out of gas)');
});

test('T4: the carrier named in the caveat recorded TRUE for exactly this case', () => {
  const x = t.T4_postVerdictTrue;
  assert.equal(getAddress(x.from), getAddress(r.accounts.carrier));
  assert.equal(getAddress(x.to), getAddress(r.enforcer.address));
  assert.equal(x.event.caseKey, caseSalt(SAMPLE_CASE));
  assert.equal(getAddress(x.event.caseContract), SAMPLE_CASE);
  assert.equal(x.event.genlayerChainId, 4221);
  assert.equal(v.results.verdictTrue, true);
});

test('T5: the agent redeemed the same delegation itself and got exactly the fee (minus its own gas)', () => {
  const x = t.T5_redeemAfterVerdict;
  assert.equal(getAddress(x.from), getAddress(r.accounts.agent));
  assert.equal(x.delegationHash, r.delegation.hash);
  assert.equal(r.checks.principalPaidWei, r.delegation.feeWei);
  assert.equal(BigInt(r.checks.agentNetFromT5Wei) + BigInt(r.checks.agentGasForT5Wei), BigInt(r.delegation.feeWei));
  assert.equal(r.checks.limitedCallsCountAfter, 1);
  assert.equal(r.balancesAfterEth.principalSmartAccount, '0');
});

test('the abort-and-resume is recorded, not hidden', () => {
  assert.match(r.resumedFrom.explanation, /stale read/);
  assert.match(r.resumedFrom.abortReason, /^T2: principal balance rose by 0/);
  // The field is named for what it holds: the prior run's start time (equal to this record's start).
  assert.ok(!('abortedAtUtc' in r.resumedFrom));
  assert.equal(r.resumedFrom.priorRunStartedAtUtc, r.startedAtUtc);
  assert.ok(r.editedAfterRun.changes.length >= 3);
});

test('nonces: clerk 4 -> 7 and agent 1 -> 3, exactly five transactions; the abort came before any T3', () => {
  const n = r.nonceVerification;
  assert.deepEqual(n.clerk.txNonces, { T1: 4, T2: 5, T4: 6 });
  assert.deepEqual(n.agent.txNonces, { T3: 1, T5: 2 });
  for (const k of order) assert.equal(t[k].nonce ?? null, null, 'transaction fields unchanged after the run');
  const vn = v.results.nonces;
  assert.equal(getAddress(vn.clerk.address), getAddress(r.accounts.carrier));
  assert.equal(getAddress(vn.agent.address), getAddress(r.accounts.agent));
  const b0 = t.T1_deployEnforcer.block - 1, b3 = t.T3_redeemBeforeVerdict.block - 1, b5 = t.T5_redeemAfterVerdict.block;
  assert.deepEqual(vn.clerk.atBlock, { [b0]: 4, [b5]: 7 });
  assert.deepEqual(vn.agent.atBlock, { [b0]: 1, [b3]: 1, [b5]: 3 });
  assert.deepEqual(vn.clerk.txNonces, { T1_deployEnforcer: 4, T2_fundPrincipal: 5, T4_postVerdictTrue: 6 });
  assert.deepEqual(vn.agent.txNonces, { T3_redeemBeforeVerdict: 1, T5_redeemAfterVerdict: 2 });
  assert.equal(n.clerk.nonceAtBlock12150799, vn.clerk.atBlock[b0]);
  assert.equal(n.agent.nonceAtBlock12150816, vn.agent.atBlock[b3]);
});
