// Evidence gate for the live refusal run (scripts/refusal.mjs). Pure functions plus an
// injected JSON-RPC caller, so every branch can be unit-tested without a network.
//
// Rule: a deliberately reverting transaction may be broadcast only if a simulation
// (eth_call) reverted with the EXPECTED decoded reason. Anything else (no revert, an
// RPC/transport error, a rate limit, revert data that will not decode, or a different
// revert reason) aborts before broadcast. After mining, the receipt must say `reverted`
// and a replay of the mined transaction (eth_call with its from/to/input/gas at the
// parent block) must decode to the same expected reason. Otherwise the run fails and
// no result file is written.
import { decodeErrorResult } from 'viem';
import { DelegationManager as DelegationManagerAbi } from '@metamask/delegation-abis';

/** Expected revert reasons per step. R2 is normally stopped by the amount cap (caveat 2 of 6);
 *  LimitedCalls (caveat 5) would also stop it, so either reason is accepted for R2. */
export const EXPECTED = Object.freeze({
  R1: Object.freeze(['InvalidDelegate']),
  R2: Object.freeze(['NativeTokenTransferAmountEnforcer:allowance-exceeded', 'LimitedCallsEnforcer:limit-exceeded']),
});

export class GateError extends Error {
  constructor(message) { super(message); this.name = 'GateError'; }
}

/** Map a decoded revert reason to the blockedBy label and contract address recorded in a result.
 *  Labels must be derived from the observed reason: a hard-coded amount-enforcer label would
 *  mis-attribute a future R2 that reverts with limit-exceeded. */
export function blockedByFromReason(reason, environment) {
  if (reason === 'InvalidDelegate') {
    return { by: 'DelegationManager (InvalidDelegate: caller is not the delegate)', address: environment.DelegationManager };
  }
  if (reason === 'NativeTokenTransferAmountEnforcer:allowance-exceeded') {
    return { by: 'NativeTokenTransferAmountEnforcer (allowance-exceeded)', address: environment.caveatEnforcers.NativeTokenTransferAmountEnforcer };
  }
  if (reason === 'LimitedCallsEnforcer:limit-exceeded') {
    return { by: 'LimitedCallsEnforcer (limit-exceeded)', address: environment.caveatEnforcers.LimitedCallsEnforcer };
  }
  throw new GateError(`no blockedBy mapping for "${reason}"`);
}

/** Decode revert data from the DelegationManager (custom errors) or an enforcer (Error(string)).
 *  Returns the reason string, or null if the data is missing or does not decode. */
export function decodeRevertData(data) {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]{8,}$/.test(data)) return null;
  try {
    const d = decodeErrorResult({ abi: DelegationManagerAbi, data });
    return d.errorName === 'Error' ? String(d.args[0]) : d.errorName;
  } catch {
    return null;
  }
}

/** Revert data from a JSON-RPC error object, or null if it is not a revert (transport, rate limit, ...). */
export function revertDataFromRpcError(error) {
  if (!error || typeof error !== 'object') return null;
  const d = typeof error.data === 'string' ? error.data : (error.data && typeof error.data.data === 'string' ? error.data.data : null);
  return d && /^0x[0-9a-fA-F]{8,}$/.test(d) ? d : null;
}

/**
 * Check a raw JSON-RPC response to eth_call against the expected reasons.
 * Returns { reason, data } only for an expected revert; throws GateError otherwise.
 */
export function checkSimulation(label, response, expected) {
  if (!response || typeof response !== 'object') throw new GateError(`${label}: no JSON-RPC response; refusing to send`);
  if (!response.error) throw new GateError(`${label}: eth_call did not revert; refusing to send`);
  const data = revertDataFromRpcError(response.error);
  if (!data) throw new GateError(`${label}: eth_call failed without revert data (RPC/transport error?): ${String(response.error.message ?? '').slice(0, 200)}; refusing to send`);
  const reason = decodeRevertData(data);
  if (!reason) throw new GateError(`${label}: revert data ${data.slice(0, 10)} did not decode; refusing to send`);
  if (!expected.includes(reason)) throw new GateError(`${label}: unexpected revert "${reason}" (expected ${expected.join(' or ')}); refusing to send`);
  return { reason, data };
}

/** Post one JSON-RPC request. Non-200 HTTP or a non-JSON body throws (that is a transport error, not a revert). */
export async function rpcCall(rpcUrl, method, params, fetchImpl = fetch) {
  const res = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!res.ok) throw new GateError(`${method}: HTTP ${res.status} from RPC`);
  let body;
  try { body = await res.json(); } catch { throw new GateError(`${method}: RPC returned a non-JSON body`); }
  return body;
}

/** Simulate a call and require the expected revert. */
export async function simulateExpectedRevert({ label, rpc, from, to, data, gas, block = 'latest', expected }) {
  const callObj = { from, to, data, ...(gas ? { gas: typeof gas === 'string' ? gas : '0x' + BigInt(gas).toString(16) } : {}) };
  const response = await rpc('eth_call', [callObj, block]);
  return checkSimulation(label, response, expected);
}

/**
 * After mining: require receipt.status reverted and a replay of the mined tx at its parent block
 * that decodes to an expected reason. `tx` is the mined transaction (from, to, input, gas).
 */
export async function verifyMinedRevert({ label, rpc, receipt, tx, expected }) {
  if (!receipt) throw new GateError(`${label}: no receipt`);
  const status = receipt.status;
  if (!(status === 'reverted' || status === '0x0' || status === 0 || status === 0n)) throw new GateError(`${label}: receipt status is ${status}, not reverted`);
  if (!tx || !tx.input) throw new GateError(`${label}: mined transaction not readable`);
  const blockNumber = BigInt(receipt.blockNumber);
  const parent = '0x' + (blockNumber - 1n).toString(16);
  const replay = await simulateExpectedRevert({ label: `${label} replay`, rpc, from: tx.from, to: tx.to, data: tx.input, gas: tx.gas, block: parent, expected });
  return { status: 'reverted', block: Number(blockNumber), replayBlock: Number(blockNumber - 1n), replayRevertData: replay.data, replayDecoded: replay.reason };
}
