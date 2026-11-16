// Verdict-gated MetaMask delegation ("court escrow").
//
// The principal's MetaMask smart account (Hybrid DeleGator) signs one ERC-7710
// delegation to a settlement account (the "clerk"). The delegation's caveats are
// enforced on-chain by MetaMask's Delegation Framework:
//   - nativeTokenTransferAmount scope: at most `amountWei` of native token in total
//   - exactExecution: the only allowed call is "send exactly amountWei to the agent"
//   - redeemer: only the clerk address may redeem
//   - limitedCalls: redeemable once
//   - timestamp: redeemable only before `expiresAt`
// The delegation salt is derived from the GenLayer case (chain id + MandateVerdict
// address), so the signed delegation names the case it settles.
//
// The verdict gate itself is NOT on-chain: GenLayer Bradbury and the EVM testnet are
// different chains and no oracle bridges them. The clerk reads the verdict from the
// GenLayer contract (read-only gen_call) and redeems only on a final TRUE.
import {
  createDelegation,
  createExecution,
  ExecutionMode,
  ScopeType,
  CaveatType,
} from '@metamask/smart-accounts-kit';
import { DelegationManager } from '@metamask/smart-accounts-kit/contracts';
import { hashDelegation } from '@metamask/smart-accounts-kit/utils';
import { encodePacked, getAddress, isAddress, keccak256 } from 'viem';

export const GENLAYER_BRADBURY_CHAIN_ID = 4221;
export const SAMPLE_CASE = getAddress('0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B');

/** Salt that binds a delegation to one GenLayer MandateVerdict case. */
export function caseSalt(contract, genlayerChainId = GENLAYER_BRADBURY_CHAIN_ID) {
  if (!isAddress(contract)) throw new Error(`Not an address: ${contract}`);
  return keccak256(
    encodePacked(['string', 'uint256', 'address'], ['internet-court-mandate-verdict', BigInt(genlayerChainId), getAddress(contract)]),
  );
}

/** Parse the JSON string returned by MandateVerdict.get_verdict(). */
export function parseVerdict(raw) {
  const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!v || typeof v !== 'object') throw new Error('get_verdict returned no object');
  return { status: String(v.status ?? ''), verdict: String(v.verdict ?? ''), reasoning: v.reasoning ?? '' };
}

/**
 * Pure settlement decision.
 *   REDEEM  - case resolved with TRUE and the delegation is still in its window
 *   REFUSE  - case resolved with FALSE or UNDETERMINED: the clerk never redeems
 *   WAIT    - case not resolved yet
 *   EXPIRED - past the delegation's beforeThreshold; nothing can be redeemed
 */
export function decideSettlement({ status, verdict }, { nowSec, expiresAt }) {
  if (expiresAt && nowSec >= expiresAt) return { action: 'EXPIRED', why: 'delegation window has closed' };
  if (status !== 'resolved') return { action: 'WAIT', why: `case status is "${status}"` };
  if (verdict === 'TRUE') return { action: 'REDEEM', why: 'jury verdict TRUE' };
  if (verdict === 'FALSE' || verdict === 'UNDETERMINED') {
    return { action: 'REFUSE', why: `jury verdict ${verdict}: payment withheld; the delegation lapses at expiry` };
  }
  throw new Error(`Unknown verdict "${verdict}"`);
}

/** The single execution the delegation allows: pay the agent exactly amountWei. */
export function paymentExecution({ agent, amountWei }) {
  return createExecution({ target: getAddress(agent), value: BigInt(amountWei), callData: '0x' });
}

/** Build (unsigned) the court-escrow delegation. */
export function buildEscrowDelegation({ environment, principal, clerk, agent, amountWei, expiresAt, caseContract, genlayerChainId }) {
  if (!environment?.DelegationManager) throw new Error('environment is required (getSmartAccountsEnvironment(chainId))');
  if (!(BigInt(amountWei) > 0n)) throw new Error('amountWei must be > 0');
  if (!Number.isInteger(expiresAt) || expiresAt <= 0) throw new Error('expiresAt (unix seconds) is required');
  const amount = BigInt(amountWei);
  return createDelegation({
    environment,
    from: getAddress(principal),
    to: getAddress(clerk),
    salt: caseSalt(caseContract, genlayerChainId),
    scope: { type: ScopeType.NativeTokenTransferAmount, maxAmount: amount },
    caveats: [
      // Library 2.0.0 takes { execution: { target, value, callData } } (the docs page shows a flat form).
      { type: CaveatType.ExactExecution, execution: { target: getAddress(agent), value: amount, callData: '0x' } },
      { type: CaveatType.Redeemer, redeemers: [getAddress(clerk)] },
      { type: CaveatType.LimitedCalls, limit: 1 },
      { type: CaveatType.Timestamp, afterThreshold: 0, beforeThreshold: expiresAt },
    ],
  });
}

/** Calldata for DelegationManager.redeemDelegations (single chain, SingleDefault mode). */
export function redeemCalldata(signedDelegation, { agent, amountWei }) {
  return DelegationManager.encode.redeemDelegations({
    delegations: [[signedDelegation]],
    modes: [ExecutionMode.SingleDefault],
    executions: [[paymentExecution({ agent, amountWei })]],
  });
}

/** Calldata the principal's smart account would send to disable the delegation early. */
export function disableCalldata(delegation) {
  return DelegationManager.encode.disableDelegation({ delegation });
}

export { hashDelegation };

/**
 * Clerk settlement step. All I/O is injected so it can run against mocks, a local
 * fork, or (with Mike's approval) a live testnet.
 *   readVerdict(): Promise<raw get_verdict JSON>
 *   sendTransaction({ to, data }): Promise<txHash>   (only called on REDEEM)
 */
export async function settle({ signedDelegation, environment, agent, amountWei, expiresAt, caseContract, genlayerChainId, readVerdict, sendTransaction, nowSec }) {
  const expectedSalt = caseSalt(caseContract, genlayerChainId);
  if (BigInt(signedDelegation.salt) !== BigInt(expectedSalt)) {
    return { action: 'REFUSE', why: 'delegation salt does not match this GenLayer case' };
  }
  const verdict = parseVerdict(await readVerdict());
  const decision = decideSettlement(verdict, { nowSec: nowSec ?? Math.floor(Date.now() / 1000), expiresAt });
  const result = { ...decision, verdict: verdict.verdict, status: verdict.status, delegationHash: hashDelegation(signedDelegation) };
  if (decision.action !== 'REDEEM') return result;
  const txHash = await sendTransaction({ to: environment.DelegationManager, data: redeemCalldata(signedDelegation, { agent, amountWei }) });
  return { ...result, txHash };
}
