// Read-only proof that a live FALSE GenLayer verdict cannot open the on-chain verdict gate on Sepolia.
// Sends NO transaction on any chain. The only signature is the owner's off-chain ERC-7710 delegation
// signature (throwaway testnet key), which is never broadcast.
//
//   node scripts/false-check.mjs check --case <MandateVerdict address> [--request-txid <GenLayer tx id>] --out <new.json>
//
// For the given Bradbury case it:
//   1. reads get_verdict and (if given) gen_getTransactionReceipt of its request_verdict (read-only GenLayer);
//   2. runs the carrier rule (carrierDecision): it must refuse to post TRUE;
//   3. reads verdictTrue[carrier][caseKey] on the deployed VerdictGateEnforcer: must be false;
//   4. signs (off-chain) a gated delegation for THIS case with the same enforcer, carrier and accounts as the
//      recorded on-chain check, and eth_calls the agent's redemption at a pinned Sepolia block:
//        - as is: must revert VerdictGateEnforcer:verdict-not-true;
//        - with verdictTrue[carrier][caseKey] = TRUE and the principal funded, both as eth_call state overrides:
//          must succeed, so in that pinned simulation the gate is what refuses.
// Writes <out> with flag wx (never overwrites). Inputs: OWNER_KEY (to sign the delegation), SEPOLIA_RPC_URL.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, http, getAddress, toHex, parseEther } from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { Implementation, toMetaMaskSmartAccount, getSmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
import { GateError, rpcCall, simulateExpectedRevert } from '../src/refusal-gate.mjs';
import { redeemCalldata, hashDelegation, caseSalt, parseVerdict, GENLAYER_BRADBURY_CHAIN_ID } from '../src/verdict-payment.mjs';
import { makeVerdictReader, DEFAULT_GENLAYER_RPC } from '../src/genlayer-verdict.mjs';
import { GATE_ABI, GATE_REVERT, SLOT_TRUE, buildGatedDelegation, carrierDecision, checkSuccess, verdictSlot } from '../src/verdict-gate.mjs';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const bigintJson = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
const LIVE = JSON.parse(readFileSync(new URL('../live-onchain-check-result.json', import.meta.url), 'utf8'));
const FEE = parseEther('0.001');
const REVERT_GAS = 700_000n;

/** Pure: the conclusions this check must reach for a FALSE case. Throws GateError otherwise. */
export function assertFalseRefusal({ verdict, decision, verdictTrueOnChain, plainReason, overriddenOk }) {
  if (verdict.status !== 'resolved' || verdict.verdict !== 'FALSE') throw new GateError(`case is ${verdict.status}/${verdict.verdict}, not resolved/FALSE`);
  if (decision.post !== false) throw new GateError('carrier rule would post TRUE for a FALSE case');
  if (verdictTrueOnChain !== false) throw new GateError('verdictTrue is already set for this case');
  if (plainReason !== GATE_REVERT) throw new GateError(`redemption eth_call: ${plainReason ?? 'succeeded'}, expected ${GATE_REVERT}`);
  if (overriddenOk !== true) throw new GateError('the counterfactual (verdictTrue overridden to TRUE) did not succeed');
  return true;
}

export async function genReceipt(txid, endpoint = DEFAULT_GENLAYER_RPC) {
  if (!txid) return null;
  const res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'gen_getTransactionReceipt', params: [{ txID: txid, round: 0 }] }) });
  const r = (await res.json()).result;
  return r ? { id: r.id, recipient: r.recipient, statusName: r.statusName, txExecutionResultName: r.txExecutionResultName } : null;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname) && process.argv[2] === 'check') {
  const outArg = arg('--out') ? resolve(arg('--out')) : null;
  const caseArg = arg('--case');
  if (!outArg || !caseArg) { console.error('usage: check --case <address> [--request-txid <id>] --out <new.json>'); process.exit(2); }
  if (existsSync(outArg)) { console.error(`Refusing: ${outArg} exists`); process.exit(2); }
  if (!process.env.OWNER_KEY) { console.error('OWNER_KEY is not set'); process.exit(2); }
  try {
    const caseContract = getAddress(caseArg);
    const rpcUrl = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
    const environment = getSmartAccountsEnvironment(sepolia.id);
    const pc = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
    if ((await pc.getChainId()) !== sepolia.id) throw new GateError('RPC is not Sepolia');
    // --rehearse-verdict <json>: rehearsal only (before the case exists): use this get_verdict JSON instead of a
    // live read. The output is marked as a rehearsal and must never be committed as the live result.
    const rehearse = arg('--rehearse-verdict');
    const raw = rehearse ?? String(await makeVerdictReader(caseContract)());
    const verdict = parseVerdict(raw);
    const receipt = await genReceipt(arg('--request-txid'));
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
    const override = { [gate]: { stateDiff: { [verdictSlot(carrier, caseKey)]: SLOT_TRUE } }, [principal.address]: { balance: toHex(FEE) } };
    checkSuccess('counterfactual', await rpc('eth_call', [{ from: agent, to: environment.DelegationManager, data, gas: toHex(REVERT_GAS) }, at, override]));
    assertFalseRefusal({ verdict, decision, verdictTrueOnChain, plainReason: plain.reason, overriddenOk: true });
    const out = {
      ...(rehearse ? { REHEARSAL: 'get_verdict was supplied on the command line, not read from GenLayer; not a live result' } : {}),
      note: 'Read-only check: a live FALSE GenLayer verdict cannot open the on-chain verdict gate on Ethereum Sepolia. No transaction was sent on any chain; the delegation below was signed off-chain with the throwaway owner key and never broadcast.',
      atUtc: new Date().toISOString(), sepoliaRpc: rpcUrl, genlayerEndpoint: DEFAULT_GENLAYER_RPC,
      case: { genlayerChainId: GENLAYER_BRADBURY_CHAIN_ID, contract: caseContract, caseKey, getVerdictRaw: raw, verdict, requestVerdictReceipt: receipt },
      carrierDecision: decision,
      sepolia: {
        pinnedBlock: Number(block), enforcer: gate, carrier, agent, principalSmartAccount: principal.address, delegationManager: environment.DelegationManager,
        verdictTrueOnChain,
        delegation: { hash: hashDelegation(signed), signedOffChainOnly: true, gateCaveatIndex: signed.caveats.findIndex((c) => getAddress(c.enforcer) === gate), expiresAtUnix: expiresAt },
        redemptionEthCall: { result: 'reverted', reason: plain.reason, data: plain.data },
        counterfactual: { method: 'eth_call with state overrides (a simulation, not a transaction)', block: Number(block), overrides: ['verdictTrue[carrier][caseKey] = TRUE', 'principal balance = fee'], result: 'success',
          claim: `In this pinned simulation at Sepolia block ${Number(block)}, the redemption for this FALSE case reverted with ${GATE_REVERT}, and succeeded once verdictTrue was overridden to TRUE (and the principal funded), so in that simulation the gate is what refuses it.` },
      },
      transactionsSent: 0,
    };
    console.log(bigintJson(out));
    writeFileSync(outArg, bigintJson(out) + '\n', { flag: 'wx' });
  } catch (e) { console.error(`FAILED: ${e.message}`); process.exit(1); }
}
