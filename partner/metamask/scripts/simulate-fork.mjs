// Local dry run on an anvil fork of Ethereum Sepolia. Nothing is broadcast to any
// public network: every transaction below is mined only by the local anvil process.
// Keys are generated fresh in memory for this run and never written anywhere.
// The GenLayer verdict is read live (read-only gen_call) from Bradbury unless
// --verdict-json is passed.
//
//   node scripts/simulate-fork.mjs [--fork-url URL] [--out sim-result.json]
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createPublicClient, createTestClient, createWalletClient, http, parseEther, formatEther } from 'viem';
import { sepolia } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Implementation, toMetaMaskSmartAccount, getSmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
import { buildPaymentDelegation, settle, redeemCalldata, hashDelegation, SAMPLE_CASE } from '../src/verdict-payment.mjs';
import { makeVerdictReader } from '../src/genlayer-verdict.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const FORK_URL = arg('--fork-url', 'https://ethereum-sepolia-rpc.publicnode.com');
const OUT = arg('--out');
const PORT = 8546;
const RPC = `http://127.0.0.1:${PORT}`;
const AMOUNT = parseEther('0.001');

const anvil = spawn(process.env.ANVIL ?? 'anvil', ['--fork-url', FORK_URL, '--port', String(PORT), '--chain-id', String(sepolia.id), '--silent'], { stdio: 'inherit' });
const stop = () => anvil.kill('SIGTERM');
process.on('exit', stop);

const chain = { ...sepolia, rpcUrls: { default: { http: [RPC] } } };
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const testClient = createTestClient({ chain, mode: 'anvil', transport: http(RPC) });
for (let i = 0; ; i++) {
  try { await publicClient.getChainId(); break; } catch { if (i > 60) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 500)); }
}

const log = [];
const step = (name, data = {}) => { log.push({ step: name, ...data }); console.log(`- ${name}`, JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v))); };

const environment = getSmartAccountsEnvironment(sepolia.id);
const forkBlock = await publicClient.getBlockNumber();
step('fork', { chainId: sepolia.id, forkBlock, delegationManager: environment.DelegationManager, dmHasCode: (await publicClient.getCode({ address: environment.DelegationManager }))?.length > 2 });

// Throwaway in-memory keys (local fork only).
const owner = privateKeyToAccount(generatePrivateKey());
const clerk = privateKeyToAccount(generatePrivateKey());
const agent = privateKeyToAccount(generatePrivateKey()).address;
const outsider = privateKeyToAccount(generatePrivateKey());
for (const a of [clerk.address, outsider.address]) await testClient.setBalance({ address: a, value: parseEther('1') });

const principal = await toMetaMaskSmartAccount({
  client: publicClient,
  implementation: Implementation.Hybrid,
  deployParams: [owner.address, [], [], []],
  deploySalt: '0x',
  signer: { account: owner },
});
const clerkWallet = createWalletClient({ account: clerk, chain, transport: http(RPC) });
const outsiderWallet = createWalletClient({ account: outsider, chain, transport: http(RPC) });

// Tx A: deploy the principal smart account via SimpleFactory (relay pattern from the docs).
const { factory, factoryData } = await principal.getFactoryArgs();
let h = await clerkWallet.sendTransaction({ to: factory, data: factoryData });
let rc = await publicClient.waitForTransactionReceipt({ hash: h });
step('A deploy principal smart account (fork)', { smartAccount: principal.address, status: rc.status, gasUsed: rc.gasUsed });

// Tx B: fund the principal smart account with the agent's fee (not locked; the owner could move it).
h = await clerkWallet.sendTransaction({ to: principal.address, value: AMOUNT });
rc = await publicClient.waitForTransactionReceipt({ hash: h });
step('B fund principal smart account (fork)', { value: formatEther(AMOUNT), status: rc.status });

// Off-chain: principal signs the payment delegation (EIP-712 signature, no tx).
const latest = await publicClient.getBlock();
const expiresAt = Number(latest.timestamp) + 7 * 86400;
const delegation = buildPaymentDelegation({ environment, principal: principal.address, clerk: clerk.address, agent, amountWei: AMOUNT, expiresAt, caseContract: SAMPLE_CASE });
const signed = { ...delegation, signature: await principal.signDelegation({ delegation }) };
step('sign delegation (off-chain)', { delegationHash: hashDelegation(signed), caveats: signed.caveats.length, salt: signed.salt });

// Negative 1: an outsider cannot redeem (redeemer caveat).
try {
  await outsiderWallet.sendTransaction({ to: environment.DelegationManager, data: redeemCalldata(signed, { agent, amountWei: AMOUNT }), gas: 1_000_000n })
    .then((hash) => publicClient.waitForTransactionReceipt({ hash }))
    .then((r) => { if (r.status === 'success') throw new Error('outsider redemption unexpectedly succeeded'); step('outsider redemption reverted', { status: r.status }); });
} catch (e) { if (/unexpectedly/.test(e.message)) throw e; step('outsider redemption rejected', { reason: e.shortMessage ?? e.message.split('\n')[0] }); }

// FALSE path: same delegation, mocked FALSE verdict -> clerk refuses, nothing sent.
const refused = await settle({ signedDelegation: signed, environment, agent, amountWei: AMOUNT, caseContract: SAMPLE_CASE,
  readVerdict: async () => JSON.stringify({ status: 'resolved', verdict: 'FALSE' }), sendTransaction: async () => { throw new Error('must not send on FALSE'); }, nowSec: Number(latest.timestamp) });
step('settle with mocked FALSE verdict', { action: refused.action, why: refused.why });

// TRUE path: live verdict from GenLayer Bradbury, clerk redeems on the fork.
const verdictJson = arg('--verdict-json');
const readVerdict = verdictJson ? async () => verdictJson : makeVerdictReader(SAMPLE_CASE);
const before = await publicClient.getBalance({ address: agent });
const res = await settle({ signedDelegation: signed, environment, agent, amountWei: AMOUNT, caseContract: SAMPLE_CASE, readVerdict, nowSec: Number(latest.timestamp),
  sendTransaction: ({ to, data }) => clerkWallet.sendTransaction({ to, data }) });
let redeemReceipt;
if (res.txHash) redeemReceipt = await publicClient.waitForTransactionReceipt({ hash: res.txHash });
const after = await publicClient.getBalance({ address: agent });
step('settle with GenLayer verdict', { verdictSource: verdictJson ? 'arg' : `Bradbury gen_call get_verdict on ${SAMPLE_CASE}`, status: res.status, verdict: res.verdict, action: res.action, redeemStatus: redeemReceipt?.status, gasUsed: redeemReceipt?.gasUsed, agentReceived: formatEther(after - before) });

// Negative 2: second redemption fails (limitedCalls = 1).
try {
  const hash = await clerkWallet.sendTransaction({ to: environment.DelegationManager, data: redeemCalldata(signed, { agent, amountWei: AMOUNT }), gas: 1_000_000n });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status === 'success') throw new Error('second redemption unexpectedly succeeded');
  step('second redemption reverted', { status: r.status });
} catch (e) { if (/unexpectedly/.test(e.message)) throw e; step('second redemption rejected', { reason: e.shortMessage ?? e.message.split('\n')[0] }); }

// Negative 3: a fresh delegation stops working after its timestamp window (fork time warp).
const d2 = buildPaymentDelegation({ environment, principal: principal.address, clerk: clerk.address, agent, amountWei: AMOUNT, expiresAt: Number(latest.timestamp) + 3600, caseContract: SAMPLE_CASE });
const s2 = { ...d2, signature: await principal.signDelegation({ delegation: d2 }) };
await clerkWallet.sendTransaction({ to: principal.address, value: AMOUNT }).then((hash) => publicClient.waitForTransactionReceipt({ hash }));
await testClient.increaseTime({ seconds: 7200 });
await testClient.mine({ blocks: 1 });
try {
  const hash = await clerkWallet.sendTransaction({ to: environment.DelegationManager, data: redeemCalldata(s2, { agent, amountWei: AMOUNT }), gas: 1_000_000n });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status === 'success') throw new Error('expired redemption unexpectedly succeeded');
  step('redemption after expiry reverted', { status: r.status });
} catch (e) { if (/unexpectedly/.test(e.message)) throw e; step('redemption after expiry rejected', { reason: e.shortMessage ?? e.message.split('\n')[0] }); }

const enforcerNames = Object.fromEntries(Object.entries(environment.caveatEnforcers).map(([k, v]) => [v.toLowerCase(), k]));
step('caveat enforcers in the signed delegation', { enforcers: signed.caveats.map((c) => enforcerNames[c.enforcer.toLowerCase()] ?? c.enforcer) });

const ok = res.action === 'REDEEM' && redeemReceipt?.status === 'success' && after - before === AMOUNT && refused.action === 'REFUSE';
step(ok ? 'PASS' : 'FAIL');
if (OUT) writeFileSync(OUT, JSON.stringify({ note: 'Local anvil fork of Sepolia. Nothing broadcast. Throwaway in-memory keys.', forkUrl: FORK_URL, log }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
stop();
process.exit(ok ? 0 : 1);
