// Static checks of the recorded live refusal run (no network, no keys).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeErrorResult, getAddress } from 'viem';
import { getSmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
import { DelegationManager as DelegationManagerAbi } from '@metamask/delegation-abis';
import { caseSalt, hashDelegation, SAMPLE_CASE } from '../src/verdict-payment.mjs';

const r = JSON.parse(readFileSync(new URL('../live-refusal-result.json', import.meta.url), 'utf8'));
const live = JSON.parse(readFileSync(new URL('../live-result.json', import.meta.url), 'utf8'));
const env = getSmartAccountsEnvironment(11155111);
const txs = Object.values(r.transactions);
const decode = (data) => { const d = decodeErrorResult({ abi: DelegationManagerAbi, data }); return d.errorName === 'Error' ? d.args[0] : d.errorName; };

test('refusal record: Sepolia, the same throwaway accounts as the live run, no key material', () => {
  assert.equal(r.chainId, 11155111);
  assert.equal(getAddress(r.delegationManager), getAddress(env.DelegationManager));
  assert.deepEqual(r.accounts, live.accounts);
  assert.doesNotMatch(JSON.stringify(r), /"[a-z_]*(private|_key|mnemonic|seed)[a-z_]*"\s*:/i);
});

test('at most three transactions, all mined and all reverted', () => {
  assert.ok(txs.length >= 1 && txs.length <= 3);
  for (const t of txs) {
    assert.match(t.hash, /^0x[0-9a-f]{64}$/);
    assert.equal(t.etherscan, `https://sepolia.etherscan.io/tx/${t.hash}`);
    assert.equal(t.status, 'reverted');
    assert.ok(t.block > live.transactions.C_redeemDelegation.block);
    assert.equal(getAddress(t.to), getAddress(env.DelegationManager));
    assert.ok(t.gasUsed < t.gasLimit, 'reverted with gas left (not out of gas)');
  }
  assert.equal(r.checks.bothReverted, true);
});

test('R1: the agent (an outsider to the delegation) is rejected by the DelegationManager', () => {
  const t = r.transactions.R1_outsiderRedeem;
  assert.equal(getAddress(t.from), getAddress(r.accounts.agent));
  assert.notEqual(getAddress(t.from), getAddress(r.freshDelegation.delegate));
  assert.equal(decode(t.simulatedRevertData), 'InvalidDelegate');
  assert.equal(t.replayAtParentBlock.decoded, 'InvalidDelegate');
  assert.equal(t.delegationHash, r.freshDelegation.hash);
  assert.equal(t.limitedCallsCountAfter, 0);
});

test('R2: the already-paid live-run delegation cannot pay a second time', () => {
  const t = r.transactions.R2_secondRedeem;
  assert.equal(getAddress(t.from), getAddress(r.accounts.clerk));
  assert.equal(t.delegationHash, live.delegation.hash);
  assert.equal(decode(t.simulatedRevertData), 'NativeTokenTransferAmountEnforcer:allowance-exceeded');
  assert.equal(getAddress(t.blockedByAddress), getAddress(env.caveatEnforcers.NativeTokenTransferAmountEnforcer));
  assert.equal(t.limitedCallsCountBefore, 1);
  assert.equal(t.limitedCallsCountAfter, 1);
});

test('fresh delegation is bound to another case, so the clerk refused it with no transaction', () => {
  const f = r.freshDelegation;
  assert.equal(f.salt, caseSalt(f.boundCase));
  assert.notEqual(f.salt, caseSalt(SAMPLE_CASE));
  assert.equal(f.expectedSaltForSampleCase, caseSalt(SAMPLE_CASE));
  assert.equal(hashDelegation(f.signed), f.hash);
  assert.ok(f.expiresAtUnix - Date.parse(r.startedAtUtc) / 1000 <= 3700, 'fresh delegation lives about one hour');
  assert.match(r.sampleCaseVerdict.response, /"verdict": "TRUE"/);
  const [a, b] = r.clerkRefusals;
  assert.equal(a.action, 'REFUSE');
  assert.match(a.why, /salt does not match/);
  assert.equal(a.transactionsSent, 0);
  assert.notEqual(b.action, 'REDEEM');
  assert.equal(b.transactionsSent, 0);
});

test('the record states what it does not show', () => {
  assert.ok(r.whatThisDoesNotShow.some((s) => /FALSE or UNDETERMINED/.test(s)));
  assert.ok(r.whatThisDoesNotShow.some((s) => /clerk/.test(s)));
});

test('gas note claims no cause; principal held 0 ETH during R1', () => {
  assert.match(r.gasNote, /cause not traced/);
  assert.doesNotMatch(r.gasNote, /calldata cost/);
  assert.equal(r.balancesBefore.principalSmartAccountEth, '0');
  assert.equal(r.balancesAfter.principalSmartAccountEth, '0');
  assert.ok(r.whatThisShows.some((s) => /held 0 ETH .*not a funded payment being blocked/.test(s)));
});

test('independent read-only re-verification of R1 and R2 matches the record', () => {
  const v = r.independentReverification;
  assert.equal(v.passed, true);
  for (const [step, key, reason] of [['R1', 'R1_outsiderRedeem', 'InvalidDelegate'], ['R2', 'R2_secondRedeem', 'NativeTokenTransferAmountEnforcer:allowance-exceeded']]) {
    const x = v.transactions[step]; const t = r.transactions[key];
    assert.equal(x.hash, t.hash);
    assert.equal(getAddress(x.from), getAddress(t.from));
    assert.equal(x.receiptStatus, 'reverted');
    assert.equal(x.block, t.block);
    assert.equal(x.replayBlock, t.block - 1);
    assert.equal(x.gasUsed, t.gasUsed);
    assert.equal(x.valueWei, '0');
    assert.equal(decode(x.replayRevertData), reason);
    assert.equal(x.replayDecoded, reason);
    assert.equal(BigInt(x.feePaidWei), BigInt(x.gasUsed) * BigInt(x.effectiveGasPriceWei));
  }
  // R1 fee was paid by the agent; matches the agent's recorded balance change.
  assert.equal(-BigInt(v.transactions.R1.feePaidWei), BigInt(r.checks.agentNetChangeWei));
});
