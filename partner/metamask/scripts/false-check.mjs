// Read-only proof that a live FALSE GenLayer verdict cannot open the on-chain verdict gate on Sepolia.
// Sends NO transaction on any chain. The only signature is the owner's off-chain ERC-7710 delegation
// signature (throwaway testnet key), which is never broadcast.
//
//   node scripts/false-check.mjs check --case <MandateVerdict address> --request-txid <GenLayer tx id> --out <new.json>
//   node scripts/false-check.mjs check --case <address> --no-receipt --out <new.json>   (output marked "receipt not checked")
//
// For the given Bradbury case it:
//   1. reads get_verdict and gen_getTransactionReceipt of its request_verdict (read-only GenLayer), and records the
//      receipt: status/finality, execution result, round-0 result, validators and each validator's vote. Before any
//      Sepolia work, the receipt must be for this case, Finalized, FinishedWithReturn and MAJORITY_AGREE.
//      --request-txid is required unless --no-receipt is given; then the output says the receipt was not checked;
//   2. runs the carrier rule (carrierDecision): it must refuse to post TRUE;
//   3. reads verdictTrue[carrier][caseKey] on the deployed VerdictGateEnforcer: must be false;
//   4. signs (off-chain) a gated delegation for THIS case with the same enforcer, carrier and accounts as the
//      recorded on-chain check, and eth_calls the agent's redemption at a pinned Sepolia block:
//        - as is: must revert VerdictGateEnforcer:verdict-not-true;
//        - with only the principal's balance overridden (gate untouched): must still revert verdict-not-true;
//        - with verdictTrue[carrier][caseKey] = TRUE and the principal funded, both as eth_call state overrides:
//          must succeed. Together with the balance-only run, in that pinned simulation the gate is what refuses.
// Writes <out> with flag wx (never overwrites). Inputs: OWNER_KEY (to sign the delegation), SEPOLIA_RPC_URL.
// Trust model: no contract on Sepolia checks GenLayer. A trusted off-chain carrier key writes verdictTrue; this check shows
// the carrier rule refuses a FALSE case and the gate refuses without that write. It does not prove the carrier is honest.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import { createPublicClient, http, getAddress, toHex, parseEther } from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { Implementation, toMetaMaskSmartAccount, getSmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
import { GateError, rpcCall, simulateExpectedRevert, checkSimulation } from '../src/refusal-gate.mjs';
import { redeemCalldata, hashDelegation, caseSalt, parseVerdict, GENLAYER_BRADBURY_CHAIN_ID } from '../src/verdict-payment.mjs';
import { makeVerdictReader, DEFAULT_GENLAYER_RPC } from '../src/genlayer-verdict.mjs';
import { GATE_ABI, GATE_REVERT, SLOT_TRUE, buildGatedDelegation, carrierDecision, checkSuccess, verdictSlot } from '../src/verdict-gate.mjs';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const bigintJson = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
const LIVE = JSON.parse(readFileSync(new URL('../live-onchain-check-result.json', import.meta.url), 'utf8'));
const FEE = parseEther('0.001');
const REVERT_GAS = 700_000n;

/** Pure: the conclusions this check must reach for a FALSE case. Throws GateError otherwise. */
export function assertFalseRefusal({ verdict, decision, verdictTrueOnChain, plainReason, balanceOnlyReason, overriddenOk }) {
  if (verdict.status !== 'resolved' || verdict.verdict !== 'FALSE') throw new GateError(`case is ${verdict.status}/${verdict.verdict}, not resolved/FALSE`);
  if (decision.post !== false) throw new GateError('carrier rule would post TRUE for a FALSE case');
  if (verdictTrueOnChain !== false) throw new GateError('verdictTrue is already set for this case');
  if (plainReason !== GATE_REVERT) throw new GateError(`redemption eth_call: ${plainReason ?? 'succeeded'}, expected ${GATE_REVERT}`);
  if (balanceOnlyReason !== GATE_REVERT) throw new GateError(`balance-only eth_call: ${balanceOnlyReason ?? 'succeeded'}, expected ${GATE_REVERT}`);
  if (overriddenOk !== true) throw new GateError('the counterfactual (verdictTrue overridden to TRUE) did not succeed');
  return true;
}

// GenLayer enum names (genlayer-js 2.0.0-rc.3: voteTypeNumberToName, transactionResultNumberToName).
export const VOTE_NAMES = { 0: 'NOT_VOTED', 1: 'FINISHED_WITH_RETURN', 2: 'FINISHED_WITH_ERROR', 3: 'TIMEOUT', 4: 'NONDET_DISAGREE', 5: 'DETERMINISTIC_VIOLATION' };
export const ROUND_RESULT_NAMES = { 0: 'IDLE', 1: 'MAJORITY_AGREE', 2: 'MAJORITY_DISAGREE', 3: 'MAJORITY_TIMEOUT', 4: 'DETERMINISTIC_VIOLATION', 5: 'NO_MAJORITY' };

/** Decode validatorVotes (base64 bytes, hex string or number array) into numbers. Pure. */
export function decodeVotes(v) {
  if (Array.isArray(v)) return v.map(Number);
  if (typeof v !== 'string' || v === '') return [];
  if (/^0x[0-9a-fA-F]*$/.test(v)) return [...Buffer.from(v.slice(2), 'hex')];
  return [...Buffer.from(v, 'base64')];
}

/** Pure: summarize a raw gen_getTransactionReceipt result (the fields this check records). */
export function summarizeReceipt(r) {
  if (!r || typeof r !== 'object') return null;
  const rounds = (Array.isArray(r.roundData) ? r.roundData : []).map((rd) => {
    const votes = decodeVotes(rd.validatorVotes);
    const validators = Array.isArray(rd.roundValidators) ? rd.roundValidators : [];
    const resultHashes = Array.isArray(rd.validatorResultHash) ? rd.validatorResultHash : [];
    const byValidator = validators.map((addr, i) => ({
      validator: addr,
      vote: VOTE_NAMES[votes[i]] ?? `UNKNOWN(${votes[i]})`,
      matchesLeaderResult: typeof r.resultHash === 'string' && typeof resultHashes[i] === 'string'
        ? r.resultHash.toLowerCase().replace(/^0x/, '') === resultHashes[i].toLowerCase().replace(/^0x/, '') : null,
    }));
    const tally = {};
    for (const x of byValidator) tally[x.vote] = (tally[x.vote] ?? 0) + 1;
    return {
      round: Number(rd.round), result: ROUND_RESULT_NAMES[Number(rd.result)] ?? `UNKNOWN(${rd.result})`,
      leaderIndex: Number(rd.leaderIndex), votesCommitted: Number(rd.votesCommitted), votesRevealed: Number(rd.votesRevealed),
      validatorCount: validators.length, voteTally: tally,
      validatorsMatchingLeaderResult: byValidator.filter((x) => x.matchesLeaderResult === true).length,
      validators: byValidator,
    };
  });
  return {
    id: r.id, sender: r.sender, recipient: r.recipient, statusName: r.statusName, txExecutionResultName: r.txExecutionResultName,
    numOfInitialValidators: r.numOfInitialValidators != null ? Number(r.numOfInitialValidators) : null,
    resultHash: r.resultHash ?? null,
    timestampsUnix: r.timestamps ? { created: Number(r.timestamps.Created), committed: Number(r.timestamps.Committed), lastVote: Number(r.timestamps.LastVote) } : null,
    rounds, lastRound: rounds.length ? rounds[rounds.length - 1] : null,
  };
}

/**
 * Pure: the request_verdict receipt must belong to this case and be final with a majority-agree round.
 * Checked BEFORE any Sepolia work. Throws GateError otherwise.
 */
export function assertReceipt(receipt, caseContract, txid) {
  if (!receipt) throw new GateError('no GenLayer receipt for request_verdict');
  if (txid && String(receipt.id ?? '').toLowerCase() !== String(txid).toLowerCase()) throw new GateError('receipt id differs from --request-txid');
  if (String(receipt.recipient ?? '').toLowerCase() !== String(caseContract).toLowerCase()) throw new GateError('request_verdict receipt is for a different contract');
  if (receipt.statusName !== 'Finalized') throw new GateError(`request_verdict is ${receipt.statusName}, not Finalized`);
  if (receipt.txExecutionResultName !== 'FinishedWithReturn') throw new GateError(`request_verdict result is ${receipt.txExecutionResultName}`);
  if (!receipt.lastRound || receipt.lastRound.result !== 'MAJORITY_AGREE') throw new GateError(`request_verdict round result is ${receipt.lastRound?.result ?? 'missing'}, not MAJORITY_AGREE`);
  return true;
}

export async function genReceipt(txid, endpoint = DEFAULT_GENLAYER_RPC) {
  if (!txid) return null;
  const res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'gen_getTransactionReceipt', params: [{ txID: txid, round: 0 }] }) });
  return summarizeReceipt((await res.json()).result);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname) && process.argv[2] === 'check') {
  const outArg = arg('--out') ? resolve(arg('--out')) : null;
  const caseArg = arg('--case');
  const txidArg = arg('--request-txid');
  const noReceipt = process.argv.includes('--no-receipt');
  if (!outArg || !caseArg || (!txidArg && !noReceipt) || (txidArg && noReceipt)) {
    console.error('usage: check --case <address> (--request-txid <id> | --no-receipt) --out <new.json>'); process.exit(2);
  }
  if (existsSync(outArg)) { console.error(`Refusing: ${outArg} exists`); process.exit(2); }
  if (!process.env.OWNER_KEY) { console.error('OWNER_KEY is not set'); process.exit(2); }
  try {
    const caseContract = getAddress(caseArg);
    // --rehearse-verdict <json>: rehearsal only (before the case exists): use this get_verdict JSON instead of a
    // live read. The output is marked as a rehearsal and must never be committed as the live result.
    const rehearse = arg('--rehearse-verdict');
    const raw = rehearse ?? String(await makeVerdictReader(caseContract)());
    const verdict = parseVerdict(raw);
    const receipt = noReceipt ? null : await genReceipt(txidArg);
    if (!noReceipt) assertReceipt(receipt, caseContract, txidArg); // before any Sepolia work
    const rpcUrl = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
    const environment = getSmartAccountsEnvironment(sepolia.id);
    const pc = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
    if ((await pc.getChainId()) !== sepolia.id) throw new GateError('RPC is not Sepolia');
    const decision = carrierDecision({ verdictRaw: raw, genReceipt: receipt, caseContract });
    const gate = getAddress(LIVE.enforcer.address), carrier = getAddress(LIVE.accounts.carrier), agent = getAddress(LIVE.accounts.agent);
    const caseKey = caseSalt(caseContract);
    const block = await pc.getBlockNumber();
    const verdictTrueOnChain = await pc.readContract({ address: gate, abi: GATE_ABI, functionName: 'verdictTrue', args: [carrier, caseKey], blockNumber: block });
    const owner = privateKeyToAccount(process.env.OWNER_KEY);
    const principal = await toMetaMaskSmartAccount({ client: pc, implementation: Implementation.Hybrid, deployParams: [owner.address, [], [], []], deploySalt: '0x', signer: { account: owner } });
    if (getAddress(principal.address) !== getAddress(LIVE.accounts.principalSmartAccount)) throw new GateError('principal differs from the recorded run');
    const expiresAt = Number((await pc.getBlock({ blockNumber: block })).timestamp) + 86400;
    const d = buildGatedDelegation({ environment, principal: principal.address, agent, carrier, gate, amountWei: FEE, expiresAt, caseContract });
    const signed = { ...d, signature: await principal.signDelegation({ delegation: d }) };
    const data = redeemCalldata(signed, { agent, amountWei: FEE });
    const at = toHex(block);
    const rpc = (m, p) => rpcCall(rpcUrl, m, p);
    const plain = await simulateExpectedRevert({ label: 'FALSE-case redemption', rpc, from: agent, to: environment.DelegationManager, data, gas: REVERT_GAS, block: at, expected: [GATE_REVERT] });
    const balanceOnly = checkSimulation('balance-only redemption', await rpc('eth_call', [{ from: agent, to: environment.DelegationManager, data, gas: toHex(REVERT_GAS) }, at,
      { [principal.address]: { balance: toHex(FEE) } }]), [GATE_REVERT]);
    const override = { [gate]: { stateDiff: { [verdictSlot(carrier, caseKey)]: SLOT_TRUE } }, [principal.address]: { balance: toHex(FEE) } };
    checkSuccess('counterfactual', await rpc('eth_call', [{ from: agent, to: environment.DelegationManager, data, gas: toHex(REVERT_GAS) }, at, override]));
    assertFalseRefusal({ verdict, decision, verdictTrueOnChain, plainReason: plain.reason, balanceOnlyReason: balanceOnly.reason, overriddenOk: true });
    const out = {
      ...(rehearse ? { REHEARSAL: 'get_verdict was supplied on the command line, not read from GenLayer; not a live result' } : {}),
      note: 'Read-only check at a pinned Ethereum Sepolia block: for a live FALSE GenLayer verdict, the trusted off-chain carrier refuses to post TRUE, and the on-chain verdict gate refuses the payment without that post. No transaction was sent on any chain; the delegation below was signed off-chain with the throwaway owner key and never broadcast.',
      atUtc: new Date().toISOString(), sepoliaRpc: rpcUrl, genlayerEndpoint: DEFAULT_GENLAYER_RPC,
      case: { genlayerChainId: GENLAYER_BRADBURY_CHAIN_ID, contract: caseContract, caseKey, getVerdictRaw: raw, verdict,
        receiptChecked: !noReceipt, ...(noReceipt ? { receiptNote: 'receipt not checked (--no-receipt): finality, round result and validator votes are NOT shown by this file' } : {}),
        requestVerdictReceipt: receipt },
      carrierDecision: decision,
      sepolia: {
        pinnedBlock: Number(block), enforcer: gate, carrier, agent, principalSmartAccount: principal.address, delegationManager: environment.DelegationManager,
        verdictTrueOnChain,
        delegation: { hash: hashDelegation(signed), signedOffChainOnly: true, gateCaveatIndex: signed.caveats.findIndex((c) => getAddress(c.enforcer) === gate), expiresAtUnix: expiresAt },
        redemptionEthCall: { result: 'reverted', reason: plain.reason, data: plain.data },
        balanceOnlyEthCall: { method: 'eth_call with one state override (a simulation, not a transaction)', block: Number(block), overrides: ['principal balance = fee'], result: 'reverted', reason: balanceOnly.reason, data: balanceOnly.data },
        counterfactual: { method: 'eth_call with state overrides (a simulation, not a transaction)', block: Number(block), overrides: ['verdictTrue[carrier][caseKey] = TRUE', 'principal balance = fee'], result: 'success',
          claim: `In these pinned simulations at Sepolia block ${Number(block)}, the redemption for this FALSE case reverted with ${GATE_REVERT} as is and with only the principal funded, and succeeded once verdictTrue was also overridden to TRUE, so in those simulations the gate is what refuses it. The carrier is a trusted off-chain writer.` },
      },
      transactionsSent: 0,
    };
    console.log(bigintJson(out));
    writeFileSync(outArg, bigintJson(out) + '\n', { flag: 'wx' });
  } catch (e) { console.error(`FAILED: ${e.message}`); process.exit(1); }
}
