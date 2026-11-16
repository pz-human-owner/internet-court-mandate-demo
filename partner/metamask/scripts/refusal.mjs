// Live refusal run on Ethereum Sepolia. CI never runs it. It sends real transactions
// only with --broadcast. Run once on 2026-11-16; see live-refusal-result.json.
//
//   node scripts/refusal.mjs plan                 # prints the steps; no keys, no network writes
//   node scripts/refusal.mjs run --broadcast      # off-chain clerk refusals + 2 deliberately reverting txs
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
//   OWNER_KEY, CLERK_KEY, AGENT_KEY   throwaway testnet keys only (never printed)
//   SEPOLIA_RPC_URL                    default https://ethereum-sepolia-rpc.publicnode.com
// Reads signed-delegation.json (the spent delegation from `live.mjs grant`).
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseEther, formatEther, getAddress, keccak256, toHex, decodeErrorResult } from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { Implementation, toMetaMaskSmartAccount, getSmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
import { LimitedCallsEnforcer, DelegationManager as DelegationManagerAbi } from '@metamask/delegation-abis';
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
  R1 AGENT -> DelegationManager.redeemDelegations(fresh delegation)   expected revert (DelegationManager InvalidDelegate), gas limit ${GAS_LIMIT}
  R2 CLERK -> DelegationManager.redeemDelegations(spent delegation)   expected revert (NativeTokenTransferAmountEnforcer allowance-exceeded), gas limit ${GAS_LIMIT}`);
  process.exit(0);
}
if (cmd !== 'run' || !process.argv.includes('--broadcast')) {
  console.error('Refusing to send transactions without `run --broadcast`. Run `plan` first and get approval.');
  process.exit(2);
}
for (const k of ['OWNER_KEY', 'CLERK_KEY', 'AGENT_KEY']) if (!env[k]) throw new Error(`${k} is not set`);

const rpcUrl = env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const transport = http(rpcUrl);
const publicClient = createPublicClient({ chain: sepolia, transport });
if ((await publicClient.getChainId()) !== sepolia.id) throw new Error('RPC is not Sepolia');
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

async function revertingTx(label, wallet, signed, enforcer) {
  const data = redeemCalldata(signed, { agent, amountWei: fee });
  // Simulate first (eth_call) and keep the raw revert data; refuse to send if it would succeed.
  const sim = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from: wallet.account.address, to: environment.DelegationManager, data }, 'latest'] }) }).then((r) => r.json());
  if (!sim.error) throw new Error(`${label}: eth_call did not revert; refusing to send`);
  const simulatedRevertData = sim.error.data ?? '0x';
  let simulatedRevert = sim.error.message;
  try {
    const dec = decodeErrorResult({ abi: DelegationManagerAbi, data: simulatedRevertData });
    simulatedRevert = dec.errorName === 'Error' ? dec.args[0] : dec.errorName;
  } catch { /* keep the RPC message */ }
  const countBefore = await callCount(hashDelegation(signed));
  const hash = await wallet.sendTransaction({ to: environment.DelegationManager, data, gas: GAS_LIMIT });
  const rc = await publicClient.waitForTransactionReceipt({ hash });
  const block = await publicClient.getBlock({ blockNumber: rc.blockNumber });
  const countAfter = await callCount(hashDelegation(signed));
  const r = {
    label, hash, etherscan: ex(hash), status: rc.status, block: Number(rc.blockNumber), timestampUtc: new Date(Number(block.timestamp) * 1000).toISOString(),
    from: wallet.account.address, to: environment.DelegationManager, gasLimit: Number(GAS_LIMIT), gasUsed: Number(rc.gasUsed),
    delegationHash: hashDelegation(signed), blockedBy: enforcer.by, blockedByAddress: enforcer.address,
    simulatedRevertReason: simulatedRevert, simulatedRevertData, limitedCallsCountBefore: Number(countBefore), limitedCallsCountAfter: Number(countAfter),
  };
  console.log(label, hash, rc.status, simulatedRevert);
  return r;
}

const agentBefore = await publicClient.getBalance({ address: agent });
const R1 = await revertingTx('R1 agent redeems the fresh delegation itself (skips the clerk)', agentWallet, fresh, { by: 'DelegationManager (InvalidDelegate: caller is not the delegate)', address: environment.DelegationManager });
const R2 = await revertingTx('R2 clerk redeems the already-paid live-run delegation a second time', clerkWallet, spent.signed, { by: 'NativeTokenTransferAmountEnforcer (allowance-exceeded)', address: environment.caveatEnforcers.NativeTokenTransferAmountEnforcer });
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
out.finishedAtUtc = new Date().toISOString();
writeFileSync(new URL('../live-refusal-result.json', import.meta.url), bigintJson(out) + '\n');
console.log('wrote live-refusal-result.json', bigintJson(out.checks));
