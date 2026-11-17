// The committed live FALSE check (live-false-check-result.json): structure and conclusions. Offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { GATE_REVERT } from '../src/verdict-gate.mjs';
import { caseSalt } from '../src/verdict-payment.mjs';

const r = JSON.parse(readFileSync(new URL('../live-false-check-result.json', import.meta.url), 'utf8'));
const LIVE = JSON.parse(readFileSync(new URL('../live-onchain-check-result.json', import.meta.url), 'utf8'));
const CASE = '0x51a2343c90192360199553B92C0D9Fe976D77662';
const REQ = '0x4b2b38cd79433d25fde027dcf6de853f0a6339d3d170b9131abe0a13565e7127';

test('live FALSE record is a live read, not a rehearsal, and sent nothing', () => {
  assert.equal(r.REHEARSAL, undefined);
  assert.equal(r.transactionsSent, 0);
  assert.equal(r.sepolia.delegation.signedOffChainOnly, true);
  assert.equal(r.sepolia.delegation.signature, undefined);
  assert.doesNotMatch(JSON.stringify(r), /OWNER_KEY|"privateKey"|mnemonic/i);
});

test('live FALSE record: the case resolved FALSE and its request_verdict receipt was checked', () => {
  assert.equal(getAddress(r.case.contract), CASE);
  assert.equal(r.case.caseKey, caseSalt(CASE));
  assert.equal(r.case.verdict.status, 'resolved');
  assert.equal(r.case.verdict.verdict, 'FALSE');
  assert.equal(r.case.receiptChecked, true);
  const rc = r.case.requestVerdictReceipt;
  assert.equal(rc.id, REQ);
  assert.equal(getAddress(rc.recipient), CASE);
  assert.equal(rc.statusName, 'Finalized');
  assert.equal(rc.txExecutionResultName, 'FinishedWithReturn');
  assert.equal(rc.lastRound.result, 'MAJORITY_AGREE');
  assert.equal(rc.lastRound.validatorCount, 5);
  assert.equal(rc.lastRound.validators.length, 5);
  assert.deepEqual(rc.lastRound.voteTally, { FINISHED_WITH_RETURN: 4, TIMEOUT: 1 });
  assert.equal(rc.lastRound.validatorsMatchingLeaderResult, 4);
  assert.equal(r.carrierDecision.post, false);
});

test('live FALSE record: the gate refused as is and with only the principal funded; the counterfactual succeeded', () => {
  const s = r.sepolia;
  assert.equal(getAddress(s.enforcer), getAddress(LIVE.enforcer.address));
  assert.equal(getAddress(s.carrier), getAddress(LIVE.accounts.carrier));
  assert.equal(getAddress(s.agent), getAddress(LIVE.accounts.agent));
  assert.equal(s.verdictTrueOnChain, false);
  assert.equal(s.redemptionEthCall.reason, GATE_REVERT);
  assert.equal(s.balanceOnlyEthCall.reason, GATE_REVERT);
  assert.deepEqual(s.balanceOnlyEthCall.overrides, ['principal balance = fee']);
  assert.equal(s.counterfactual.result, 'success');
  assert.equal(s.balanceOnlyEthCall.block, s.pinnedBlock);
  assert.equal(s.counterfactual.block, s.pinnedBlock);
  assert.doesNotMatch(JSON.stringify(r), /trustless|\boracle\b/i);
});
