// Live refusal run on Ethereum Sepolia. CI never runs it. It sends real transactions
// only with --broadcast. Run once on 2026-11-16; see live-refusal-result.json.
//
//   node scripts/refusal.mjs plan                 # prints the steps; no keys, no network writes
//   node scripts/refusal.mjs verify [--write]     # read-only: re-check the recorded R1/R2 on Sepolia
//   node scripts/refusal.mjs run --broadcast --out <new-file.json>
//                                                 # off-chain clerk refusals + 2 deliberately reverting txs
//
// Evidence gate (src/refusal-gate.mjs): R1/R2 are broadcast only if eth_call reverts with the
// EXPECTED decoded reason (R1 InvalidDelegate; R2 NativeTokenTransferAmountEnforcer:allowance-exceeded
// or LimitedCallsEnforcer:limit-exceeded). Any other outcome (no revert, RPC/transport error, rate
// limit, undecodable data, a different reason) aborts before sending. After mining, the receipt must
// be `reverted` and a replay at the parent block must decode to the expected reason. If any check
// fails the script exits non-zero and writes nothing. `run` never overwrites an existing file: the
// recorded live-refusal-result.json is the evidence, so a new run must name a new --out file.
//
// What it shows:
//   1. Clerk code refuses (no transaction) a freshly signed delegation that is bound to a
//      different GenLayer case, even though the sample case's live verdict is TRUE.
//   2. The clerk code sends nothing for a case with no readable verdict.
//   3. On-chain: the AGENT tries to redeem that fresh delegation itself, skipping the clerk.
//      MetaMask's DelegationManager reverts it with InvalidDelegate (only the named delegate,
//      the clerk, may redeem; the RedeemerEnforcer caveat is a second, unreached layer).
//   4. On-chain: the CLERK tries to redeem the already-paid delegation from the live run a
//      second time. The NativeTokenTransferAmountEnforcer reverts it (the 0.001 ETH cap is
//      used up; the LimitedCallsEnforcer count is already 1 and would also block it).
// The fresh delegation expires one hour after signing, and the principal smart account holds
// 0 ETH, so nothing can be paid under it.
// Steps 3 and 4 are sent with a fixed gas limit (estimateGas would refuse a reverting call)
// so the failed transactions are mined and visible on Etherscan.
//
// Inputs from the environment (partner/metamask/.env, gitignored; `set -a; . ./.env; set +a`):
//   OWNER_KEY, CLERK_KEY, AGENT_KEY   throwaway testnet keys only (never printed). R1 is sent and
//                                      paid for by the AGENT key, so the agent address needs a little
//                                      Sepolia ETH (R1 cost about 2.5 million wei); R2 is paid by the clerk.
//   SEPOLIA_RPC_URL                    default https://ethereum-sepolia-rpc.publicnode.com
// Reads signed-delegation.json (the spent delegation from `live.mjs grant`).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, http, parseEther, formatEther, getAddress, keccak256, toHex } from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { Implementation, toMetaMaskSmartAccount, getSmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
import { LimitedCallsEnforcer } from '@metamask/delegation-abis';
import { EXPECTED, GateError, blockedByFromReason, rpcCall, simulateExpectedRevert, verifyMinedRevert } from '../src/refusal-gate.mjs';
import { buildPaymentDelegation, settle, redeemCalldata, hashDelegation, caseSalt, SAMPLE_CASE } from '../src/verdict-payment.mjs';
import { makeVerdictReader, DEFAULT_GENLAYER_RPC } from '../src/genlayer-verdict.mjs';

// A Bradbury address with no MandateVerdict deployed (derived from a fixed label).
export const NO_SUCH_CASE = getAddress('0x' + keccak256(toHex('internet-court-refusal-demo:no-such-case')).slice(26));
const GAS_LIMIT = 400_000n;
const cmd = process.argv[2];
const env = process.env;
const environment = getSmartAccountsEnvironment(sepolia.id);
const ex = (h) => `https://sepolia.etherscan.io/tx/${h}`;
const bigintJson = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);

if (cmd === 'plan' || !cmd) {
  console.log(`Refusal run on Ethereum Sepolia (chain ${sepolia.id}), DelegationManager ${environment.DelegationManager}
  -  OWNER signs a fresh delegation bound to case ${NO_SUCH_CASE} (off-chain, no tx)
  -  CLERK settle() for case ${SAMPLE_CASE} (verdict TRUE) with that delegation -> REFUSE, no tx
  -  CLERK settle() for case ${NO_SUCH_CASE} -> no readable verdict, no tx
  R1 AGENT -> DelegationManager.redeemDelegations(fresh delegation)   sent only if eth_call reverts with ${EXPECTED.R1.join(' / ')}; agent pays the gas; gas limit ${GAS_LIMIT}
  R2 CLERK -> DelegationManager.redeemDelegations(spent delegation)   sent only if eth_call reverts with ${EXPECTED.R2.join(' / ')}; clerk pays the gas; gas limit ${GAS_LIMIT}
  After mining: receipt must be reverted and a parent-block replay must give the same reason, else exit 1 and write nothing`);
  process.exit(0);
}

const rpcUrl = env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const RECORD = new URL('../live-refusal-result.json', import.meta.url);
const rpc = (method, params) => rpcCall(rpcUrl, method, params);
const fail = (e) => { console.error(`FAILED (nothing written): ${e.message}`); process.exit(1); };

if (cmd === 'verify') {
  // Read-only re-verification of the recorded R1/R2. Sends nothing and needs no keys.
  try {
    const rec = JSON.parse(readFileSync(RECORD, 'utf8'));
    const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
    if ((await publicClient.getChainId()) !== sepolia.id) throw new GateError('RPC is not Sepolia');
    const results = {};
    for (const [key, step] of [['R1_outsiderRedeem', 'R1'], ['R2_secondRedeem', 'R2']]) {
      const t = rec.transactions[key];
      const receipt = await publicClient.getTransactionReceipt({ hash: t.hash });
      const tx = await publicClient.getTransaction({ hash: t.hash });
      if (getAddress(tx.from) !== getAddress(t.from)) throw new GateError(`${step}: on-chain sender ${tx.from} != recorded ${t.from}`);
      if (getAddress(tx.to) !== getAddress(environment.DelegationManager)) throw new GateError(`${step}: tx is not to the DelegationManager`);
      if (tx.value !== 0n) throw new GateError(`${step}: on-chain value ${tx.value} is not 0`);
      const v = await verifyMinedRevert({ label: step, rpc, receipt, tx, expected: EXPECTED[step] });
      if (Number(receipt.gasUsed) !== t.gasUsed) throw new GateError(`${step}: gasUsed ${receipt.gasUsed} != recorded ${t.gasUsed}`);
      results[step] = { hash: t.hash, from: tx.from, receiptStatus: receipt.status, block: v.block, gasUsed: Number(receipt.gasUsed),
        effectiveGasPriceWei: receipt.effectiveGasPrice.toString(), feePaidWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
        valueWei: tx.value.toString(), replayBlock: v.replayBlock, replayRevertData: v.replayRevertData, replayDecoded: v.replayDecoded, expected: EXPECTED[step] };
    }
    const out = { method: 'node scripts/refusal.mjs verify (read-only: eth_getTransactionReceipt, eth_getTransactionByHash, eth_call replay at the parent block; no transactions)',
      rpc: rpcUrl, atUtc: new Date().toISOString(), passed: true, transactions: results };
    console.log(bigintJson(out));
    if (process.argv.includes('--write')) {
      rec.independentReverification = out;
      writeFileSync(RECORD, bigintJson(rec) + '\n');
      console.log('updated independentReverification in live-refusal-result.json');
    }
    process.exit(0);
  } catch (e) { fail(e); }
}

if (cmd !== 'run' || !process.argv.includes('--broadcast')) {
  console.error('Refusing to send transactions without `run --broadcast --out <new-file.json>`. Run `plan` first and get approval.');
  process.exit(2);
}
const outIdx = process.argv.indexOf('--out');
const outPath = outIdx > 0 && process.argv[outIdx + 1] ? resolve(process.argv[outIdx + 1]) : RECORD.pathname;
if (existsSync(outPath)) {
  console.error(`Refusing: ${outPath} already exists. The recorded run is the evidence; pass --out <new-file.json>.`);
  process.exit(2);
}
for (const k of ['OWNER_KEY', 'CLERK_KEY', 'AGENT_KEY']) if (!env[k]) { console.error(`${k} is not set`); process.exit(2); }
process.on('unhandledRejection', fail);
process.on('uncaughtException', fail);

const transport = http(rpcUrl);
const publicClient = createPublicClient({ chain: sepolia, transport });
if ((await publicClient.getChainId()) !== sepolia.id) fail(new Error('RPC is not Sepolia'));
const owner = privateKeyToAccount(env.OWNER_KEY);
const clerk = privateKeyToAccount(env.CLERK_KEY);
const agentAcct = privateKeyToAccount(env.AGENT_KEY);
const agent = agentAcct.address;
const clerkWallet = createWalletClient({ account: clerk, chain: sepolia, transport });
const agentWallet = createWalletClient({ account: agentAcct, chain: sepolia, transport });
const principal = await toMetaMaskSmartAccount({
  client: publicClient, implementation: Implementation.Hybrid, deployParams: [owner.address, [], [], []], deploySalt: '0x', signer: { account: owner },
});
const spent = JSON.parse(readFileSync(new URL('../signed-delegation.json', import.meta.url), 'utf8'));
const fee = BigInt(spent.fee);
const bal = async (a) => formatEther(await publicClient.getBalance({ address: a }));
const callCount = (hash) => publicClient.readContract({ address: environment.caveatEnforcers.LimitedCallsEnforcer, abi: LimitedCallsEnforcer, functionName: 'callCounts', args: [environment.DelegationManager, hash] });
const neverSend = async () => { throw new Error('clerk must not send a transaction here'); };

const out = {
  note: 'Live refusal run on Ethereum Sepolia (chain 11155111). Throwaway testnet keys; no private keys in this file. R1 and R2 are deliberately reverting transactions sent with a fixed gas limit so they are mined.',
  chainId: sepolia.id,
  delegationManager: environment.DelegationManager,
  accounts: { owner: owner.address, clerk: clerk.address, principalSmartAccount: principal.address, agent },
  startedAtUtc: new Date().toISOString(),
  balancesBefore: { clerkEth: await bal(clerk.address), agentEth: await bal(agent), principalSmartAccountEth: await bal(principal.address) },
};

// Live GenLayer verdict for the sample case (read-only gen_call).
const rawTrue = await makeVerdictReader(SAMPLE_CASE)();
out.sampleCaseVerdict = { network: 'GenLayer Testnet Bradbury', chainId: 4221, endpoint: DEFAULT_GENLAYER_RPC, contract: SAMPLE_CASE, readAtUtc: new Date().toISOString(), response: String(rawTrue) };

// Fresh delegation bound to a different case (off-chain signature, no tx).
const nowSec = Math.floor(Date.now() / 1000);
const expiresAt = nowSec + 3600; // one hour
const d = buildPaymentDelegation({ environment, principal: principal.address, clerk: clerk.address, agent, amountWei: fee, expiresAt, caseContract: NO_SUCH_CASE });
const fresh = { ...d, signature: await principal.signDelegation({ delegation: d }) };
const freshHash = hashDelegation(fresh);
out.freshDelegation = {
  hash: freshHash, boundCase: NO_SUCH_CASE, salt: fresh.salt, expectedSaltForSampleCase: caseSalt(SAMPLE_CASE),
  delegator: fresh.delegator, delegate: fresh.delegate, feeWei: fee.toString(), expiresAtUnix: expiresAt, expiresAtUtc: new Date(expiresAt * 1000).toISOString(),
  signed: fresh,
};

// Clerk refusal 1: TRUE verdict for the sample case cannot release a delegation bound to another case.
const r1 = await settle({ signedDelegation: fresh, environment, agent, amountWei: fee, caseContract: SAMPLE_CASE, readVerdict: makeVerdictReader(SAMPLE_CASE), sendTransaction: neverSend });
// Clerk refusal 2: the delegation's own case has no readable verdict on Bradbury.
let r2;
try {
  r2 = await settle({ signedDelegation: fresh, environment, agent, amountWei: fee, caseContract: NO_SUCH_CASE, readVerdict: makeVerdictReader(NO_SUCH_CASE), sendTransaction: neverSend });
} catch (e) {
  r2 = { action: 'NO_TX', why: `get_verdict failed: ${(e.shortMessage ?? e.message).split('\n')[0]}` };
}
out.clerkRefusals = [
  { step: 'settle(fresh delegation, case = sample case with verdict TRUE)', transactionsSent: 0, ...r1 },
  { step: 'settle(fresh delegation, case = its own case, no MandateVerdict deployed)', transactionsSent: 0, ...r2 },
];
console.log('clerk refusals', bigintJson(out.clerkRefusals));

async function revertingTx(label, step, wallet, signed) {
  const data = redeemCalldata(signed, { agent, amountWei: fee });
  // Gate 1: simulate (eth_call) and require the EXPECTED decoded revert; anything else aborts before sending.
  const sim = await simulateExpectedRevert({ label, rpc, from: wallet.account.address, to: environment.DelegationManager, data, gas: GAS_LIMIT, expected: EXPECTED[step] });
  const enforcer = blockedByFromReason(sim.reason, environment);
  const countBefore = await callCount(hashDelegation(signed));
  const hash = await wallet.sendTransaction({ to: environment.DelegationManager, data, gas: GAS_LIMIT });
  console.log(label, 'sent', hash);
  const rc = await publicClient.waitForTransactionReceipt({ hash });
  // Gate 2: the mined tx must have reverted, and a parent-block replay must give the expected reason.
  const tx = await publicClient.getTransaction({ hash });
  const mined = await verifyMinedRevert({ label, rpc, receipt: rc, tx, expected: EXPECTED[step] });
  const block = await publicClient.getBlock({ blockNumber: rc.blockNumber });
  const countAfter = await callCount(hashDelegation(signed));
  const r = {
    label, hash, etherscan: ex(hash), status: rc.status, block: Number(rc.blockNumber), timestampUtc: new Date(Number(block.timestamp) * 1000).toISOString(),
    from: wallet.account.address, to: environment.DelegationManager, gasLimit: Number(GAS_LIMIT), gasUsed: Number(rc.gasUsed),
    delegationHash: hashDelegation(signed), blockedBy: enforcer.by, blockedByAddress: enforcer.address,
    simulatedRevertReason: sim.reason, simulatedRevertData: sim.data, limitedCallsCountBefore: Number(countBefore), limitedCallsCountAfter: Number(countAfter),
    replayAtParentBlock: { block: mined.replayBlock, method: 'eth_call with the mined tx from/to/input/gas', revertData: mined.replayRevertData, decoded: mined.replayDecoded },
  };
  console.log(label, hash, rc.status, sim.reason);
  return r;
}

const agentBefore = await publicClient.getBalance({ address: agent });
const R1 = await revertingTx('R1 agent redeems the fresh delegation itself (skips the clerk)', 'R1', agentWallet, fresh);
const R2 = await revertingTx('R2 clerk redeems the already-paid live-run delegation a second time', 'R2', clerkWallet, spent.signed);
const agentAfter = await publicClient.getBalance({ address: agent });
out.transactions = { R1_outsiderRedeem: R1, R2_secondRedeem: R2 };
out.balancesAfter = { clerkEth: await bal(clerk.address), agentEth: formatEther(agentAfter), principalSmartAccountEth: await bal(principal.address) };
out.checks = {
  bothReverted: R1.status === 'reverted' && R2.status === 'reverted',
  agentNetChangeWei: (agentAfter - agentBefore).toString(),
  agentPaidOnlyGasForR1: agentBefore - agentAfter > 0n && agentBefore - agentAfter < parseEther('0.0001'),
  spentDelegationCallCount: R2.limitedCallsCountAfter,
  freshDelegationCallCount: R1.limitedCallsCountAfter,
};
if (!out.checks.bothReverted) fail(new GateError('not every transaction reverted'));
out.finishedAtUtc = new Date().toISOString();
writeFileSync(outPath, bigintJson(out) + '\n', { flag: 'wx' }); // 'wx': never overwrite
console.log(`wrote ${outPath}`, bigintJson(out.checks));
