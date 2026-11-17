// On-chain verdict gate: a MetaMask ERC-7710 delegation that MetaMask's DelegationManager will
// only execute after the named carrier has recorded the GenLayer case's TRUE verdict in
// VerdictGateEnforcer (contracts/src/VerdictGateEnforcer.sol) on the same EVM chain.
//
// What moves on-chain (compared with src/verdict-payment.mjs, where both are clerk code):
//   - the verdict gate: VerdictGateEnforcer.beforeHook reverts "VerdictGateEnforcer:verdict-not-true"
//     unless verdictTrue[carrier][caseKey] is set;
//   - the case binding: caseKey (= the case salt) and the carrier are the caveat's signed terms.
// What does NOT: whether the GenLayer verdict really is TRUE. Ethereum cannot read GenLayer, so the
// carrier named in the signed delegation is trusted to post only a finalized TRUE. It is a trusted
// relayer, not an oracle, and this is not trustless.
// A posted TRUE is never cleared; after it the principal's only remedies are disableDelegation or the
// delegation's expiry. One post opens EVERY delegation whose gate terms name that carrier and caseKey:
// LimitedCalls(1) is per delegation hash, not per case.
//
// In this design the delegate and only redeemer is the AGENT itself: no clerk code sits between the
// recorded verdict and the payment.
import { readFileSync } from 'node:fs';
import { createDelegation, ScopeType, CaveatType } from '@metamask/smart-accounts-kit';
import { encodeAbiParameters, decodeAbiParameters, getAddress, isAddress, keccak256, pad, toHex } from 'viem';
import { caseSalt, parseVerdict, GENLAYER_BRADBURY_CHAIN_ID } from './verdict-payment.mjs';
import { GateError } from './refusal-gate.mjs';

export const ARTIFACT = JSON.parse(readFileSync(new URL('../contracts/VerdictGateEnforcer.artifact.json', import.meta.url), 'utf8'));
export const GATE_ABI = ARTIFACT.abi;
export const GATE_REVERT = 'VerdictGateEnforcer:verdict-not-true';

/** Caveat terms: abi.encode(bytes32 caseKey, address carrier). */
export function gateTerms(caseKey, carrier) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(caseKey)) throw new Error(`caseKey must be bytes32: ${caseKey}`);
  if (!isAddress(carrier)) throw new Error(`carrier is not an address: ${carrier}`);
  return encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }], [caseKey, getAddress(carrier)]);
}

export function decodeGateTerms(terms) {
  const [caseKey, carrier] = decodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }], terms);
  return { caseKey, carrier: getAddress(carrier) };
}

/** Storage slot of verdictTrue[carrier][caseKey] (mapping at slot 0). Used for eth_call state overrides. */
export function verdictSlot(carrier, caseKey) {
  const inner = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [getAddress(carrier), 0n]));
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [caseKey, inner]));
}
export const SLOT_TRUE = pad(toHex(1), { size: 32 });

/**
 * Build (unsigned) the gated payment delegation. Delegate and sole redeemer: the agent.
 * Caveats, in order: VerdictGate (custom), ExactExecution, Redeemer, LimitedCalls(1), Timestamp,
 * plus the NativeTokenTransferAmount scope.
 */
export function buildGatedDelegation({ environment, principal, agent, carrier, gate, amountWei, expiresAt, caseContract, genlayerChainId = GENLAYER_BRADBURY_CHAIN_ID }) {
  if (!environment?.DelegationManager) throw new Error('environment is required');
  if (!isAddress(gate)) throw new Error('gate (VerdictGateEnforcer address) is required');
  if (!(BigInt(amountWei) > 0n)) throw new Error('amountWei must be > 0');
  if (!Number.isInteger(expiresAt) || expiresAt <= 0) throw new Error('expiresAt (unix seconds) is required');
  const amount = BigInt(amountWei);
  const key = caseSalt(caseContract, genlayerChainId);
  return createDelegation({
    environment,
    from: getAddress(principal),
    to: getAddress(agent),
    salt: key,
    scope: { type: ScopeType.NativeTokenTransferAmount, maxAmount: amount },
    caveats: [
      { enforcer: getAddress(gate), terms: gateTerms(key, carrier), args: '0x' },
      { type: CaveatType.ExactExecution, execution: { target: getAddress(agent), value: amount, callData: '0x' } },
      { type: CaveatType.Redeemer, redeemers: [getAddress(agent)] },
      { type: CaveatType.LimitedCalls, limit: 1 },
      { type: CaveatType.Timestamp, afterThreshold: 0, beforeThreshold: expiresAt },
    ],
  });
}

/**
 * Carrier policy: post TRUE only when get_verdict says resolved/TRUE AND the GenLayer
 * request_verdict transaction for this case is Finalized with a normal return.
 * Pure; inputs are the raw get_verdict JSON and the gen_getTransactionReceipt result.
 */
export function carrierDecision({ verdictRaw, genReceipt, caseContract }) {
  let v;
  try { v = parseVerdict(verdictRaw); } catch (e) { return { post: false, why: `verdict unreadable: ${e.message}` }; }
  if (v.status !== 'resolved') return { post: false, why: `case status is "${v.status}"` };
  if (v.verdict !== 'TRUE') return { post: false, why: `verdict is ${v.verdict}; nothing is posted (deny is the default)` };
  if (!genReceipt || typeof genReceipt !== 'object') return { post: false, why: 'no GenLayer receipt for request_verdict' };
  if (!isAddress(genReceipt.recipient ?? '') || getAddress(genReceipt.recipient) !== getAddress(caseContract)) {
    return { post: false, why: 'request_verdict receipt is for a different contract' };
  }
  if (genReceipt.statusName !== 'Finalized') return { post: false, why: `request_verdict is ${genReceipt.statusName}, not Finalized` };
  if (genReceipt.txExecutionResultName !== 'FinishedWithReturn') return { post: false, why: `request_verdict result is ${genReceipt.txExecutionResultName}` };
  return { post: true, why: 'resolved TRUE, request_verdict Finalized (FinishedWithReturn)' };
}

/** Require an eth_call to succeed (no revert, no transport error). Returns the result hex. */
export function checkSuccess(label, response) {
  if (!response || typeof response !== 'object') throw new GateError(`${label}: no JSON-RPC response; refusing to send`);
  if (response.error) throw new GateError(`${label}: eth_call failed (${String(response.error.message ?? '').slice(0, 200)}); refusing to send`);
  if (typeof response.result !== 'string') throw new GateError(`${label}: eth_call returned no result; refusing to send`);
  return response.result;
}

/** Hard cap on live transactions (Mike approved about 4-5 on Sepolia). */
export function txBudget(max = 5) {
  let used = 0;
  return {
    take(label) {
      if (used >= max) throw new GateError(`transaction budget of ${max} used up; refusing to send ${label}`);
      used += 1;
      return used;
    },
    get used() { return used; },
  };
}
