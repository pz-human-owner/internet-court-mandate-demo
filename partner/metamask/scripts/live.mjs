// Live testnet runner. CI never runs it. It sends real transactions only with --broadcast, after the
// owner approves the list printed by `plan`. It was run once on 2026-11-16; see live-result.json.
//
//   node scripts/live.mjs plan                      # prints the tx list; no keys, no network writes
//   node scripts/live.mjs grant  --broadcast        # tx A (deploy smart account) + tx B (fund it) + signs the delegation
//   node scripts/live.mjs settle --broadcast        # reads the GenLayer verdict; tx C (redeem) only on TRUE
//
// Inputs come from the environment (put them in partner/metamask/.env, which is gitignored,
// and `set -a; . ./.env; set +a`). Use fresh throwaway testnet keys only.
//   SEPOLIA_RPC_URL     default https://ethereum-sepolia-rpc.publicnode.com
//   OWNER_KEY           signs for the principal's MetaMask smart account (needs no ETH)
//   CLERK_KEY           settlement EOA; pays gas for A, B and C (needs Sepolia ETH)
//   AGENT_ADDRESS       receives the fee when the verdict is TRUE
//   CASE_CONTRACT       default 0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B (Bradbury)
//   FEE_ETH             default 0.001
//   EXPIRY_DAYS         default 7
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseEther, formatEther, getAddress } from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { Implementation, toMetaMaskSmartAccount, getSmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
import { buildPaymentDelegation, settle, hashDelegation, SAMPLE_CASE } from '../src/verdict-payment.mjs';
import { makeVerdictReader } from '../src/genlayer-verdict.mjs';

const cmd = process.argv[2];
const broadcast = process.argv.includes('--broadcast');
const STATE = new URL('../signed-delegation.json', import.meta.url);
const env = process.env;
const caseContract = getAddress(env.CASE_CONTRACT ?? SAMPLE_CASE);
const fee = parseEther(env.FEE_ETH ?? '0.001');
const environment = getSmartAccountsEnvironment(sepolia.id);
const bigintJson = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);

if (cmd === 'plan' || !cmd) {
  console.log(`Live run on Ethereum Sepolia (chain ${sepolia.id}), DelegationManager ${environment.DelegationManager}
Verdict source: GenLayer Bradbury (chain 4221) MandateVerdict ${caseContract}, read-only gen_call get_verdict
Accounts: OWNER (signs only, 0 ETH), CLERK (pays all gas), AGENT (receive-only address)
  A  CLERK -> SimpleFactory ${environment.SimpleFactory}: deploy principal Hybrid smart account   ~826k gas
  B  CLERK -> principal smart account: send ${formatEther(fee)} ETH (the agent's fee; stays in the principal's account until redeemed)          ~22-30k gas
  -  OWNER signs the ERC-7710 delegation off-chain (EIP-712, no tx)
  C  CLERK -> DelegationManager.redeemDelegations: pays AGENT ${formatEther(fee)} ETH, only if verdict TRUE   ~630k gas
Funding: CLERK needs about 0.02 Sepolia ETH (1.5M gas at <=10 gwei, plus the ${formatEther(fee)} fee).`);
  process.exit(0);
}

if (!broadcast) {
  console.error('Refusing to send transactions without --broadcast. Run `plan` first and get approval.');
  process.exit(2);
}
for (const k of ['OWNER_KEY', 'CLERK_KEY', 'AGENT_ADDRESS']) if (!env[k]) throw new Error(`${k} is not set`);

const transport = http(env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com');
const publicClient = createPublicClient({ chain: sepolia, transport });
if ((await publicClient.getChainId()) !== sepolia.id) throw new Error('RPC is not Sepolia');
const owner = privateKeyToAccount(env.OWNER_KEY);
const clerk = privateKeyToAccount(env.CLERK_KEY);
const agent = getAddress(env.AGENT_ADDRESS);
const clerkWallet = createWalletClient({ account: clerk, chain: sepolia, transport });
const principal = await toMetaMaskSmartAccount({
  client: publicClient, implementation: Implementation.Hybrid, deployParams: [owner.address, [], [], []], deploySalt: '0x', signer: { account: owner },
});

if (cmd === 'grant') {
  if (!(await principal.isDeployed())) {
    const { factory, factoryData } = await principal.getFactoryArgs();
    const hash = await clerkWallet.sendTransaction({ to: factory, data: factoryData });
    console.log('A deploy smart account', hash, (await publicClient.waitForTransactionReceipt({ hash })).status);
  }
  const hashB = await clerkWallet.sendTransaction({ to: principal.address, value: fee });
  console.log('B fund smart account', hashB, (await publicClient.waitForTransactionReceipt({ hash: hashB })).status);
  const expiresAt = Math.floor(Date.now() / 1000) + Number(env.EXPIRY_DAYS ?? 7) * 86400;
  const delegation = buildPaymentDelegation({ environment, principal: principal.address, clerk: clerk.address, agent, amountWei: fee, expiresAt, caseContract });
  const signed = { ...delegation, signature: await principal.signDelegation({ delegation }) };
  writeFileSync(STATE, bigintJson({ chainId: sepolia.id, caseContract, agent, fee, expiresAt, delegationHash: hashDelegation(signed), signed }));
  console.log('Signed delegation', hashDelegation(signed), '-> signed-delegation.json (public data, no keys)');
} else if (cmd === 'settle') {
  const s = JSON.parse(readFileSync(STATE, 'utf8'));
  const r = await settle({
    signedDelegation: s.signed, environment, agent: s.agent, amountWei: BigInt(s.fee), caseContract: s.caseContract,
    readVerdict: makeVerdictReader(s.caseContract),
    sendTransaction: ({ to, data }) => clerkWallet.sendTransaction({ to, data }),
  });
  if (r.txHash) r.receipt = (await publicClient.waitForTransactionReceipt({ hash: r.txHash })).status;
  console.log(bigintJson(r));
} else {
  throw new Error(`Unknown command ${cmd}`);
}
