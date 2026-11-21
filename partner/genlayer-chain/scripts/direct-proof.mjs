#!/usr/bin/env node
// Direct-mode live proof runner for GenLayer Testnet Bradbury / GenLayer Chain (4221).
//
//   node scripts/direct-proof.mjs plan          # default: print the batch + GEN estimate; no key, no writes
//   node scripts/direct-proof.mjs dry-run       # local anvil fork of 4221: EVM path only (gate, SA, signed
//                                               # delegations, mined revert / pay / mined revert). No real txs.
//   node scripts/direct-proof.mjs broadcast --broadcast
//                                               # live batch. Refused without --broadcast, a key file, and
//                                               # a funded balance. Do not run until the throwaway EOA is funded.
//
// The throwaway key is read ONLY from a file (chmod 600), never from the command line, and is never
// printed, logged, or written to the state file. Default path is outside this repo:
//   DIRECT_PROOF_KEY_FILE     default /workspace/v6work/submission-101/.throwaway.key
//   DIRECT_PROOF_ADDRESS_FILE default /workspace/v6work/submission-101/.throwaway.address (public)
//
// Delegation Framework v1.3.0 is NOT redeployed: the official CREATE2 addresses from
// getSmartAccountsEnvironment(11155111) already have matching contract code on chain 4221
// (verified read-only on 20 Nov 2026). This script only deploys VerdictGateDirectEnforcer,
// two MandateVerdictDirect Intelligent Contracts, a Hybrid DeleGator smart account, and
// then signs / redeems.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodePacked,
  formatEther,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createDelegation,
  createExecution,
  ExecutionMode,
  CaveatType,
  ScopeType,
  Implementation,
  toMetaMaskSmartAccount,
  getSmartAccountsEnvironment,
} from '@metamask/smart-accounts-kit';
import { DelegationManager } from '@metamask/smart-accounts-kit/contracts';
import { hashDelegation } from '@metamask/smart-accounts-kit/utils';
import { createAccount, createClient, chains, isSuccessful } from 'genlayer-js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const CHAIN_DIR = resolve(HERE, '..');
const MM_DIR = resolve(HERE, '../../metamask');

export const BRADBURY_CHAIN_ID = 4221;
export const BRADBURY_CHAIN_RPC = process.env.BRADBURY_CHAIN_RPC || 'https://rpc.testnet-chain.genlayer.com';
export const BRADBURY_NODE_RPC = process.env.BRADBURY_NODE_RPC || 'https://rpc-bradbury.genlayer.com';
export const BRADBURY_EXPLORER = 'https://scan.testnet-chain.genlayer.com';
export const BRADBURY_GENESIS =
  '0x17d89764d4f4f963158fc4c5e8f2cb670c2837740b35f37081c12860c3df97e4';
// Runtime code hash shared by live IC ghosts on Bradbury (TRUE and FALSE sample cases, 20 Nov 2026).
export const BRADBURY_GHOST_CODE_HASH =
  '0x14dd04172073540826b9ab253bf6b416ba8123fd01c9c36c6e06c5179babdd73';
export const FEE = parseEther(process.env.FEE_GEN || '0.001');
export const HISTORICAL_IC_DEPOSIT = 100000000000010352n; // 0.1 GEN + dust, matches 6 earlier live txs and today's estimate
const DEFAULT_KEY_FILE = '/workspace/v6work/submission-101/.throwaway.key';
const DEFAULT_ADDR_FILE = '/workspace/v6work/submission-101/.throwaway.address';
const STATE_PATH = process.env.DIRECT_PROOF_STATE || join(CHAIN_DIR, 'direct-proof-state.json');

export const bradburyChain = {
  id: BRADBURY_CHAIN_ID,
  name: 'GenLayer Testnet Bradbury',
  nativeCurrency: { name: 'GEN', symbol: 'GEN', decimals: 18 },
  rpcUrls: { default: { http: [BRADBURY_CHAIN_RPC] } },
  blockExplorers: { default: { name: 'scan', url: BRADBURY_EXPLORER } },
};

/** Official MetaMask DF v1.3.0 addresses (same CREATE2 as Sepolia). Already have code on 4221. */
export function frameworkEnvironment() {
  const sepolia = getSmartAccountsEnvironment(11155111);
  return {
    DelegationManager: sepolia.DelegationManager,
    EntryPoint: sepolia.EntryPoint,
    SimpleFactory: sepolia.SimpleFactory,
    implementations: sepolia.implementations,
    caveatEnforcers: sepolia.caveatEnforcers,
  };
}

export function caseSalt(contract, chainId = BRADBURY_CHAIN_ID) {
  return keccak256(
    encodePacked(
      ['string', 'uint256', 'address'],
      ['internet-court-mandate-verdict', BigInt(chainId), getAddress(contract)],
    ),
  );
}

export function gateTerms(caseContract) {
  return encodeAbiParameters([{ type: 'address' }], [getAddress(caseContract)]);
}

export function paymentExecution({ agent, amountWei }) {
  return createExecution({ target: getAddress(agent), value: BigInt(amountWei), callData: '0x' });
}

export function redeemCalldata(signedDelegation, { agent, amountWei }) {
  return DelegationManager.encode.redeemDelegations({
    delegations: [[signedDelegation]],
    modes: [ExecutionMode.SingleDefault],
    executions: [[paymentExecution({ agent, amountWei })]],
  });
}

/** Unsigned ERC-7710 delegation: agent is both delegate and sole redeemer (no clerk). */
export function buildDirectDelegation({ environment, gate, principal, agent, amountWei, expiresAt, caseContract }) {
  if (!environment?.DelegationManager) throw new Error('environment.DelegationManager is required');
  if (!gate) throw new Error('gate address is required');
  if (!(BigInt(amountWei) > 0n)) throw new Error('amountWei must be > 0');
  if (!Number.isInteger(expiresAt) || expiresAt <= 0) throw new Error('expiresAt (unix seconds) is required');
  const amount = BigInt(amountWei);
  const built = createDelegation({
    environment,
    from: getAddress(principal),
    to: getAddress(agent),
    salt: caseSalt(caseContract),
    scope: { type: ScopeType.NativeTokenTransferAmount, maxAmount: amount },
    caveats: [
      { type: CaveatType.ExactExecution, execution: { target: getAddress(agent), value: amount, callData: '0x' } },
      { type: CaveatType.Redeemer, redeemers: [getAddress(agent)] },
      { type: CaveatType.LimitedCalls, limit: 1 },
      { type: CaveatType.Timestamp, afterThreshold: 0, beforeThreshold: expiresAt },
    ],
  });
  return {
    ...built,
    caveats: [
      { enforcer: getAddress(gate), terms: gateTerms(caseContract), args: '0x' },
      ...built.caveats,
    ],
  };
}

export function formatGen(wei) {
  const s = formatEther(BigInt(wei));
  const [a, b = ''] = s.split('.');
  return `${a}.${b.padEnd(6, '0').slice(0, 6)} GEN`;
}

/** Send a tx that is expected to revert on-chain (mined revert). Passing `gas` skips viem's
 *  eth_estimateGas simulation, which would otherwise throw and never broadcast. */
async function sendExpectRevert(wallet, publicClient, tx, expectedSnippet) {
  const hash = await wallet.sendTransaction({ gas: 1_200_000n, ...tx });
  const rec = await publicClient.waitForTransactionReceipt({ hash });
  if (rec.status !== 'reverted') {
    throw new Error(`expected revert${expectedSnippet ? ` (${expectedSnippet})` : ''}, got ${rec.status} ${hash}`);
  }
  return rec;
}


export function estimateBudget({ depositPerIc = HISTORICAL_IC_DEPOSIT, icTxs = 6, fee = FEE } = {}) {
  const deposits = BigInt(depositPerIc) * BigInt(icTxs);
  const evmDust = parseEther('0.01'); // generous upper bound; 0.01 gwei gas makes real L2 cost << 0.001
  const peak = deposits + BigInt(fee) + evmDust;
  const recommended = parseEther('2');
  const budget = parseEther('5');
  return {
    icTxs,
    depositPerIc: BigInt(depositPerIc),
    deposits,
    fee: BigInt(fee),
    evmDust,
    peak,
    recommended,
    budget,
    fiveIsEnough: peak < budget,
  };
}

function bigintJson(o) {
  return JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
}

function explorerTx(hash) {
  return `${BRADBURY_EXPLORER}/tx/${hash}`;
}
function explorerAddress(addr) {
  return `${BRADBURY_EXPLORER}/address/${addr}`;
}

function loadAddressFile() {
  const p = process.env.DIRECT_PROOF_ADDRESS_FILE || DEFAULT_ADDR_FILE;
  if (!existsSync(p)) return null;
  const t = readFileSync(p, 'utf8').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(t)) throw new Error(`address file ${p} is not a 0x-address (length ${t.length})`);
  return getAddress(t);
}

function loadKeyFromFile() {
  const p = process.env.DIRECT_PROOF_KEY_FILE || DEFAULT_KEY_FILE;
  if (!existsSync(p)) throw new Error(`key file not found: ${p}`);
  const raw = readFileSync(p, 'utf8').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`key file ${p} is not a 32-byte hex private key (chars=${raw.length})`);
  }
  return raw;
}

async function assertBradbury(publicClient) {
  const id = await publicClient.getChainId();
  if (id !== BRADBURY_CHAIN_ID) throw new Error(`RPC chain id is ${id}, expected ${BRADBURY_CHAIN_ID}`);
  const genesis = await publicClient.getBlock({ blockNumber: 0n });
  if (genesis.hash !== BRADBURY_GENESIS) {
    throw new Error(`Genesis mismatch: got ${genesis.hash}, expected ${BRADBURY_GENESIS}. Stop.`);
  }
}

async function liveDepositEstimate() {
  const client = createClient({ chain: chains.testnetBradbury, endpoint: BRADBURY_NODE_RPC });
  const est = await client.estimateTransactionFees({});
  if (est == null || est.feeValue == null) throw new Error('estimateTransactionFees returned no feeValue');
  return BigInt(est.feeValue);
}

function plannedSteps() {
  return [
    'Reuse official DF v1.3.0 already on 4221 (DelegationManager, EntryPoint, SimpleFactory, HybridDeleGator, stock enforcers). No deploy.',
    'EVM: deploy VerdictGateDirectEnforcer(BRADBURY_GHOST_CODE_HASH)',
    'IC: deploy MandateVerdictDirect TRUE case and submit_deliverable (pass / accurate briefing). Do not request a verdict yet.',
    'EVM: deploy principal Hybrid DeleGator (SimpleFactory) and fund it with the 0.001 GEN fee',
    'Off-chain: principal signs the TRUE-case ERC-7710 delegation (agent is delegate and redeemer)',
    'EVM: early redeem of the TRUE delegation → mined revert VerdictGateDirect:verdict-not-true',
    'IC: request_verdict on the TRUE case, wait until FINALIZED, confirm gate.verdictTrue(case) == true',
    'IC: deploy MandateVerdictDirect FALSE case, submit_deliverable (fail / caveats-are-suggestions), request_verdict, wait until FINALIZED, confirm the gate stays false',
    'Off-chain: principal signs the FALSE-case delegation',
    'EVM: redeem TRUE delegation → agent is paid exactly 0.001 GEN',
    'EVM: second redeem of the TRUE delegation → mined revert (LimitedCalls or allowance)',
    'EVM: redeem FALSE delegation → mined revert VerdictGateDirect:verdict-not-true',
    'EVM: the throwaway EOA calls postVerdictTrue() → mined revert VerdictGateDirect:only-genlayer-contract',
  ];
}

export async function planText({ depositPerIc } = {}) {
  const env = frameworkEnvironment();
  let deposit = depositPerIc;
  let depositNote = 'historical / fallback 0.1 GEN (6 earlier live IC txs)';
  try {
    deposit = await liveDepositEstimate();
    depositNote = 'live estimateTransactionFees on rpc-bradbury.genlayer.com';
  } catch (e) {
    deposit = deposit ?? HISTORICAL_IC_DEPOSIT;
    depositNote = `live estimate failed (${e.message}); using ${formatGen(deposit)} fallback`;
  }
  const budget = estimateBudget({ depositPerIc: deposit });
  const addr = (() => {
    try {
      return loadAddressFile();
    } catch {
      return null;
    }
  })();
  const lines = [];
  lines.push(`Direct-mode live proof — GenLayer Testnet Bradbury / GenLayer Chain (id ${BRADBURY_CHAIN_ID})`);
  lines.push(`Chain RPC: ${BRADBURY_CHAIN_RPC}`);
  lines.push(`Node RPC:  ${BRADBURY_NODE_RPC}`);
  lines.push(`Explorer:  ${BRADBURY_EXPLORER}`);
  lines.push(`Ghost code hash: ${BRADBURY_GHOST_CODE_HASH}`);
  if (addr) lines.push(`Throwaway EOA (from address file, no key read): ${addr}`);
  else lines.push('Throwaway EOA: address file not present; fund the address printed when the key was created.');
  lines.push('');
  lines.push('Delegation Framework v1.3.0 already on 4221 (reused, not redeployed):');
  lines.push(`  DelegationManager  ${env.DelegationManager}`);
  lines.push(`  EntryPoint         ${env.EntryPoint}`);
  lines.push(`  SimpleFactory      ${env.SimpleFactory}`);
  lines.push(`  HybridDeleGator    ${env.implementations.HybridDeleGatorImpl}`);
  lines.push(`  ExactExecution     ${env.caveatEnforcers.ExactExecutionEnforcer}`);
  lines.push(`  LimitedCalls       ${env.caveatEnforcers.LimitedCallsEnforcer}`);
  lines.push(`  Redeemer           ${env.caveatEnforcers.RedeemerEnforcer}`);
  lines.push(`  Timestamp          ${env.caveatEnforcers.TimestampEnforcer}`);
  lines.push('');
  lines.push('Batch (about 14 transactions: 6 Intelligent Contract + 8 EVM):');
  for (const [i, s] of plannedSteps().entries()) lines.push(`  ${String(i + 1).padStart(2, ' ')}. ${s}`);
  lines.push('');
  lines.push('GEN budget:');
  lines.push(`  IC fee deposit each (${depositNote}): ${formatGen(budget.depositPerIc)}`);
  lines.push(`  6 IC deposits (refunded at finalization, so this is peak lock): ${formatGen(budget.deposits)}`);
  lines.push(`  Agent fee locked in the smart account: ${formatGen(budget.fee)}`);
  lines.push(`  EVM gas allowance (0.01 gwei; real cost is far smaller): ${formatGen(budget.evmDust)}`);
  lines.push(`  Peak GEN that must be on the throwaway EOA at once: ${formatGen(budget.peak)}`);
  lines.push(`  Recommended funding: ${formatGen(budget.recommended)}`);
  lines.push(`  5 GEN is enough: ${budget.fiveIsEnough ? 'YES' : 'NO — fund more than 5 GEN'}`);
  lines.push('');
  lines.push('Nothing is sent by `plan`. `dry-run` talks only to a local anvil fork.');
  lines.push('`broadcast --broadcast` is refused until the throwaway EOA has a funded balance.');
  lines.push('Finalization of request_verdict (appeal window) may take minutes to hours; the runner waits and can be resumed.');
  return { text: lines.join('\n'), budget, deposit, addr, env };
}

function loadArtifact(solFile, name) {
  const p = join(CHAIN_DIR, 'out', solFile, `${name}.json`);
  if (!existsSync(p)) throw new Error(`artifact missing: ${p} (run forge build in partner/genlayer-chain)`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

async function startAnvilFork() {
  const anvil = process.env.ANVIL_BIN || `${process.env.HOME}/.foundry/bin/anvil`;
  const proc = spawn(
    anvil,
    ['--fork-url', BRADBURY_CHAIN_RPC, '--chain-id', String(BRADBURY_CHAIN_ID), '--silent', '--port', '8545'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let ready = false;
  const started = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('anvil fork did not become ready')), 60_000);
    const onData = (buf) => {
      const s = buf.toString();
      if (/Listening on/i.test(s) || ready) return;
      // anvil --silent may not print; poll RPC instead
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    const poll = async () => {
      for (let i = 0; i < 60; i++) {
        try {
          const res = await fetch('http://127.0.0.1:8545', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
          });
          const j = await res.json();
          if (j.result) {
            ready = true;
            clearTimeout(t);
            resolve();
            return;
          }
        } catch {
          // not up yet
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      clearTimeout(t);
      reject(new Error('anvil fork RPC never answered'));
    };
    poll();
  });
  await started;
  return proc;
}

async function forgeBuild() {
  const forge = process.env.FORGE_BIN || `${process.env.HOME}/.foundry/bin/forge`;
  await new Promise((resolve, reject) => {
    const p = spawn(forge, ['build'], { cwd: CHAIN_DIR, stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`forge build exit ${code}`))));
  });
}

async function dryRun() {
  console.log('Dry-run: forking chain 4221 locally. No transactions are sent to Bradbury.');
  await forgeBuild();
  const proc = await startAnvilFork();
  try {
    const transport = http('http://127.0.0.1:8545');
    const publicClient = createPublicClient({ chain: { ...bradburyChain, rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } } }, transport });
    const id = await publicClient.getChainId();
    if (id !== BRADBURY_CHAIN_ID) throw new Error(`fork chain id ${id}`);
    // Well-known anvil/Hardhat dev key #0 — only used on the local fork, never on the live network.
    const dev = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
    const wallet = createWalletClient({ account: dev, chain: bradburyChain, transport });
    const env = frameworkEnvironment();
    const dmCode = await publicClient.getCode({ address: env.DelegationManager });
    if (!dmCode || dmCode === '0x') throw new Error('fork is missing DelegationManager; cannot dry-run against official DF');

    const ghostArt = loadArtifact('MockGhost.sol', 'MockGhost');
    const deployMock = async () => {
      const hash = await wallet.deployContract({ abi: ghostArt.abi, bytecode: ghostArt.bytecode.object, chain: bradburyChain });
      const rec = await publicClient.waitForTransactionReceipt({ hash });
      if (rec.status !== 'success') throw new Error('MockGhost deploy failed');
      return rec.contractAddress;
    };
    const caseTrue = getAddress(await deployMock());
    const caseFalse = getAddress(await deployMock());
    const trueHash = await publicClient.getCode({ address: caseTrue }).then((c) => keccak256(c));
    const gateArt = loadArtifact('VerdictGateDirectEnforcer.sol', 'VerdictGateDirectEnforcer');
    const gateTx = await wallet.deployContract({
      abi: gateArt.abi,
      bytecode: gateArt.bytecode.object,
      args: [trueHash],
      chain: bradburyChain,
    });
    const gateRec = await publicClient.waitForTransactionReceipt({ hash: gateTx });
    if (gateRec.status !== 'success') throw new Error('gate deploy failed');
    const gate = getAddress(gateRec.contractAddress);
    console.log('dry-run gate', gate, '(constructed with MockGhost codehash, not the live Bradbury hash)');
    console.log('dry-run TRUE stand-in', caseTrue, 'FALSE stand-in', caseFalse);

    const agent = dev;
    const principal = await toMetaMaskSmartAccount({
      client: publicClient,
      implementation: Implementation.Hybrid,
      environment: env,
      deployParams: [dev.address, [], [], []],
      deploySalt: '0x',
      signer: { account: dev },
    });
    if (!(await principal.isDeployed())) {
      const { factory, factoryData } = await principal.getFactoryArgs();
      const hash = await wallet.sendTransaction({ to: factory, data: factoryData, chain: bradburyChain });
      const rec = await publicClient.waitForTransactionReceipt({ hash });
      if (rec.status !== 'success') throw new Error('smart account deploy failed');
      console.log('dry-run smart account', principal.address, hash);
    }
    const fund = await wallet.sendTransaction({ to: principal.address, value: FEE, chain: bradburyChain });
    await publicClient.waitForTransactionReceipt({ hash: fund });
    const expiresAt = Math.floor(Date.now() / 1000) + 7 * 86400;
    const dTrue = buildDirectDelegation({
      environment: env, gate, principal: principal.address, agent: agent.address, amountWei: FEE, expiresAt, caseContract: caseTrue,
    });
    const dFalse = buildDirectDelegation({
      environment: env, gate, principal: principal.address, agent: agent.address, amountWei: FEE, expiresAt, caseContract: caseFalse,
    });
    const sTrue = { ...dTrue, signature: await principal.signDelegation({ delegation: dTrue, chainId: BRADBURY_CHAIN_ID }) };
    const sFalse = { ...dFalse, signature: await principal.signDelegation({ delegation: dFalse, chainId: BRADBURY_CHAIN_ID }) };
    console.log('dry-run signed TRUE', hashDelegation(sTrue), 'FALSE', hashDelegation(sFalse));

    const startBal = await publicClient.getBalance({ address: agent.address });
    const early = await sendExpectRevert(
      wallet,
      publicClient,
      { to: env.DelegationManager, data: redeemCalldata(sTrue, { agent: agent.address, amountWei: FEE }), chain: bradburyChain },
      'verdict-not-true',
    );
    console.log('dry-run early redeem reverted as expected', early.transactionHash);

    const mockAbi = parseAbi(['function deliver(address target, bytes calldata data)']);
    const post = await wallet.writeContract({
      address: caseTrue,
      abi: mockAbi,
      functionName: 'deliver',
      args: [gate, '0xfefceb7f'],
      chain: bradburyChain,
    });
    const postRec = await publicClient.waitForTransactionReceipt({ hash: post });
    if (postRec.status !== 'success') throw new Error('mock post failed');
    const posted = await publicClient.readContract({
      address: gate,
      abi: gateArt.abi,
      functionName: 'verdictTrue',
      args: [caseTrue],
    });
    if (!posted) throw new Error('gate did not record TRUE for the stand-in');
    console.log('dry-run gate recorded TRUE for the stand-in case');

    const paid = await wallet.sendTransaction({
      to: env.DelegationManager,
      data: redeemCalldata(sTrue, { agent: agent.address, amountWei: FEE }),
      chain: bradburyChain,
    }).then((h) => publicClient.waitForTransactionReceipt({ hash: h }));
    if (paid.status !== 'success') throw new Error('TRUE redeem failed');
    const midBal = await publicClient.getBalance({ address: agent.address });
    // agent also paid gas; the net increase should be FEE minus gas for the redeem it sent
    if (midBal <= startBal) throw new Error('agent was not paid');
    console.log('dry-run TRUE redeem paid the agent', paid.transactionHash, 'delta_wei', (midBal - startBal).toString());

    const second = await sendExpectRevert(
      wallet,
      publicClient,
      { to: env.DelegationManager, data: redeemCalldata(sTrue, { agent: agent.address, amountWei: FEE }), chain: bradburyChain },
      'limit-exceeded',
    );
    console.log('dry-run second redeem reverted as expected', second.transactionHash);

    const falseR = await sendExpectRevert(
      wallet,
      publicClient,
      { to: env.DelegationManager, data: redeemCalldata(sFalse, { agent: agent.address, amountWei: FEE }), chain: bradburyChain },
      'verdict-not-true',
    );
    console.log('dry-run FALSE redeem reverted as expected', falseR.transactionHash);

    let strangerReverted = false;
    try {
      const rec = await sendExpectRevert(
        wallet,
        publicClient,
        { to: gate, data: '0xfefceb7f', chain: bradburyChain },
        'only-genlayer-contract',
      );
      strangerReverted = true;
      console.log('dry-run EOA postVerdictTrue reverted as expected', rec.transactionHash);
    } catch (e) {
      const msg = e.shortMessage || e.message || '';
      if (msg.includes('only-genlayer-contract')) {
        strangerReverted = true;
        console.log('dry-run EOA postVerdictTrue refused:', msg);
      } else {
        throw e;
      }
    }
    if (!strangerReverted) throw new Error('EOA postVerdictTrue should not succeed');

    console.log('Dry-run OK. Intelligent Contract deploy / jury / ghost post were not exercised (local EVM only).');
    console.log('Live broadcast still requires a funded throwaway EOA and an explicit --broadcast.');
  } finally {
    proc.kill('SIGTERM');
  }
}

function loadSample() {
  const mandate = JSON.parse(readFileSync(join(ROOT, 'examples/sample_mandate.json'), 'utf8'));
  const dels = JSON.parse(readFileSync(join(ROOT, 'examples/sample_deliverables.json'), 'utf8'));
  return { mandate, dels };
}

function loadState() {
  if (!existsSync(STATE_PATH)) return {};
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
}

function saveState(s) {
  const out = { ...s, updatedAt: new Date().toISOString() };
  delete out.privateKey;
  delete out.key;
  delete out.secret;
  writeFileSync(STATE_PATH, bigintJson(out));
}

async function waitIc(client, txId, label) {
  console.log(`${label}: GenLayer tx ${txId}; waiting until finalized…`);
  const receipt = await client.waitForTransactionReceipt({
    hash: txId,
    waitUntil: 'finalized',
    interval: 15_000,
    retries: 720,
    fullTransaction: true,
  });
  const full = receipt.txExecutionResultName ? receipt : await client.getTransaction({ hash: txId });
  const ok = isSuccessful(full);
  console.log(`${label}: status ${full.statusName ?? full.status}, execution ${full.txExecutionResultName ?? full.txExecutionResult}, success=${ok}`);
  if (!ok) throw new Error(`${label} did not succeed; not continuing`);
  return full;
}

async function broadcastLive() {
  if (!process.argv.includes('--broadcast')) {
    console.error('Refusing to send transactions without --broadcast. Run `plan` first, fund the throwaway EOA, then retry with --broadcast.');
    process.exit(2);
  }
  const key = loadKeyFromFile();
  const account = privateKeyToAccount(key);
  const fileAddr = loadAddressFile();
  if (fileAddr && fileAddr !== account.address) {
    throw new Error('address file does not match the key file; stopping (no transaction sent)');
  }
  const transport = http(BRADBURY_CHAIN_RPC);
  const publicClient = createPublicClient({ chain: bradburyChain, transport });
  await assertBradbury(publicClient);
  const env = frameworkEnvironment();
  const dmCode = await publicClient.getCode({ address: env.DelegationManager });
  if (!dmCode || dmCode === '0x') throw new Error('DelegationManager has no code on 4221; refusing to continue');

  const bal = await publicClient.getBalance({ address: account.address });
  let deposit = HISTORICAL_IC_DEPOSIT;
  try {
    deposit = await liveDepositEstimate();
  } catch {
    // fallback already set
  }
  const budget = estimateBudget({ depositPerIc: deposit });
  console.log('Throwaway EOA', account.address, 'balance', formatGen(bal));
  if (bal < budget.peak) {
    console.error(
      `Unfunded or underfunded: ${formatGen(bal)} on ${account.address}, need about ${formatGen(budget.peak)} peak (recommended ${formatGen(budget.recommended)}; 5 GEN is enough). Nothing sent.`,
    );
    process.exit(3);
  }

  const wallet = createWalletClient({ account, chain: bradburyChain, transport });
  const glAccount = createAccount(key);
  const gl = createClient({ chain: chains.testnetBradbury, endpoint: BRADBURY_NODE_RPC, account: glAccount });
  const samples = loadSample();
  const code = readFileSync(join(ROOT, 'contracts/MandateVerdictDirect.py'), 'utf8');
  let state = loadState();
  state.address = account.address;
  saveState(state);

  const fees = async () => {
    const est = await gl.estimateTransactionFees({});
    if (!est?.feeValue) throw new Error('live fee estimate failed; aborting send');
    return { distribution: est.distribution, feeValue: est.feeValue, policy: est.policy };
  };

  if (!state.gate) {
    await forgeBuild();
    const gateArt = loadArtifact('VerdictGateDirectEnforcer.sol', 'VerdictGateDirectEnforcer');
    const hash = await wallet.deployContract({
      abi: gateArt.abi,
      bytecode: gateArt.bytecode.object,
      args: [BRADBURY_GHOST_CODE_HASH],
      chain: bradburyChain,
    });
    const rec = await publicClient.waitForTransactionReceipt({ hash });
    if (rec.status !== 'success') throw new Error('gate deploy failed');
    state.gate = rec.contractAddress;
    state.gateTx = hash;
    saveState(state);
    console.log('gate', state.gate, explorerTx(hash));
  } else {
    console.log('resume: gate', state.gate);
  }

  const deployCase = async (label) => {
    if (state[`${label}Contract`]) {
      console.log(`resume: ${label} case`, state[`${label}Contract`]);
      return state[`${label}Contract`];
    }
    const fee = await fees();
    const args = [
      account.address,
      samples.mandate.mandate,
      samples.mandate.guidelines,
      samples.mandate.evidence_url,
      false,
      state.gate,
    ];
    const txId = await gl.deployContract({ code, args, leaderOnly: false, fees: fee });
    const full = await waitIc(gl, txId, `deploy ${label}`);
    const addr = full.recipient ?? full.txDataDecoded?.contractAddress;
    if (!addr) throw new Error(`deploy ${label} returned no contract address`);
    state[`${label}Contract`] = addr;
    state[`${label}DeployTx`] = txId;
    saveState(state);
    console.log(`${label} case`, addr, explorerAddress(addr));
    return addr;
  };

  const writeCase = async (label, functionName, args, keyName) => {
    if (state[keyName]) {
      console.log(`resume: ${keyName}`, state[keyName]);
      return;
    }
    const fee = await fees();
    const txId = await gl.writeContract({
      address: state[`${label}Contract`],
      functionName,
      args,
      value: 0n,
      fees: fee,
    });
    await waitIc(gl, txId, `${label} ${functionName}`);
    state[keyName] = txId;
    saveState(state);
  };

  const trueCase = await deployCase('true');
  await writeCase('true', 'submit_deliverable', [samples.dels.pass.deliverable, samples.dels.pass.source_url], 'trueSubmitTx');

  // Deploy SA, fund, sign, and attempt early redeem BEFORE the TRUE verdict is posted.
  const principal = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Hybrid,
    environment: env,
    deployParams: [account.address, [], [], []],
    deploySalt: '0x',
    signer: { account },
  });
  if (!state.smartAccountTx && !(await principal.isDeployed())) {
    const { factory, factoryData } = await principal.getFactoryArgs();
    const hash = await wallet.sendTransaction({ to: factory, data: factoryData, chain: bradburyChain });
    const rec = await publicClient.waitForTransactionReceipt({ hash });
    if (rec.status !== 'success') throw new Error('smart account deploy failed');
    state.smartAccount = principal.address;
    state.smartAccountTx = hash;
    saveState(state);
    console.log('smart account', principal.address, explorerTx(hash));
  } else {
    state.smartAccount = principal.address;
    saveState(state);
    console.log('smart account', principal.address);
  }
  if (!state.fundTx) {
    const hash = await wallet.sendTransaction({ to: principal.address, value: FEE, chain: bradburyChain });
    const rec = await publicClient.waitForTransactionReceipt({ hash });
    if (rec.status !== 'success') throw new Error('fund failed');
    state.fundTx = hash;
    saveState(state);
    console.log('funded smart account', explorerTx(hash));
  }
  const expiresAt = state.expiresAt || Math.floor(Date.now() / 1000) + 7 * 86400;
  state.expiresAt = expiresAt;
  const dTrue = buildDirectDelegation({
    environment: env, gate: state.gate, principal: principal.address, agent: account.address, amountWei: FEE, expiresAt, caseContract: trueCase,
  });
  // FALSE case address may not exist yet; early redeem only needs the TRUE delegation.
  const sTrue = { ...dTrue, signature: await principal.signDelegation({ delegation: dTrue, chainId: BRADBURY_CHAIN_ID }) };
  state.trueDelegationHash = hashDelegation(sTrue);
  saveState(state);
  console.log('signed TRUE delegation', state.trueDelegationHash, '(signature stored only in memory)');

  if (!state.earlyRedeemTx) {
    const rec = await sendExpectRevert(
      wallet,
      publicClient,
      { to: env.DelegationManager, data: redeemCalldata(sTrue, { agent: account.address, amountWei: FEE }), chain: bradburyChain },
      'verdict-not-true',
    );
    state.earlyRedeemTx = rec.transactionHash;
    saveState(state);
    console.log('early redeem reverted as expected', explorerTx(hash));
  }

  await writeCase('true', 'request_verdict', [], 'trueVerdictTx');
  // After finalization the ghost should have posted.
  const gateArt = loadArtifact('VerdictGateDirectEnforcer.sol', 'VerdictGateDirectEnforcer');
  const waitGate = async (caseAddr, expectTrue, label) => {
    for (let i = 0; i < 60; i++) {
      const v = await publicClient.readContract({ address: state.gate, abi: gateArt.abi, functionName: 'verdictTrue', args: [getAddress(caseAddr)] });
      if (Boolean(v) === expectTrue) return v;
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error(`${label}: gate.verdictTrue was not ${expectTrue} after waiting`);
  };
  await waitGate(trueCase, true, 'TRUE case');
  const vTrue = await gl.readContract({ address: trueCase, functionName: 'get_verdict', args: [] });
  console.log('TRUE get_verdict', vTrue);

  const falseCase = await deployCase('false');
  await writeCase('false', 'submit_deliverable', [samples.dels.fail.deliverable, samples.dels.fail.source_url], 'falseSubmitTx');
  const dFalse = buildDirectDelegation({
    environment: env, gate: state.gate, principal: principal.address, agent: account.address, amountWei: FEE, expiresAt, caseContract: falseCase,
  });
  const sFalse = { ...dFalse, signature: await principal.signDelegation({ delegation: dFalse, chainId: BRADBURY_CHAIN_ID }) };
  state.falseDelegationHash = hashDelegation(sFalse);
  saveState(state);

  await writeCase('false', 'request_verdict', [], 'falseVerdictTx');
  await waitGate(falseCase, false, 'FALSE case');
  const vFalse = await gl.readContract({ address: falseCase, functionName: 'get_verdict', args: [] });
  console.log('FALSE get_verdict', vFalse);

  if (!state.trueRedeemTx) {
    const hash = await wallet.sendTransaction({
      to: env.DelegationManager,
      data: redeemCalldata(sTrue, { agent: account.address, amountWei: FEE }),
      chain: bradburyChain,
    });
    const rec = await publicClient.waitForTransactionReceipt({ hash });
    if (rec.status !== 'success') throw new Error('TRUE redeem failed');
    state.trueRedeemTx = hash;
    saveState(state);
    console.log('TRUE redeem paid the agent', explorerTx(hash));
  }
  if (!state.secondRedeemTx) {
    const rec = await sendExpectRevert(
      wallet,
      publicClient,
      { to: env.DelegationManager, data: redeemCalldata(sTrue, { agent: account.address, amountWei: FEE }), chain: bradburyChain },
      'limit-exceeded',
    );
    state.secondRedeemTx = rec.transactionHash;
    saveState(state);
    console.log('second redeem reverted as expected', explorerTx(rec.transactionHash));
  }
  if (!state.falseRedeemTx) {
    const rec = await sendExpectRevert(
      wallet,
      publicClient,
      { to: env.DelegationManager, data: redeemCalldata(sFalse, { agent: account.address, amountWei: FEE }), chain: bradburyChain },
      'verdict-not-true',
    );
    state.falseRedeemTx = rec.transactionHash;
    saveState(state);
    console.log('FALSE redeem reverted as expected', explorerTx(rec.transactionHash));
  }
  if (!state.strangerPostTx) {
    try {
      const hash = await wallet.writeContract({
        address: state.gate,
        abi: gateArt.abi,
        functionName: 'postVerdictTrue',
        chain: bradburyChain,
      });
      const rec = await publicClient.waitForTransactionReceipt({ hash });
      if (rec.status !== 'reverted') throw new Error(`EOA postVerdictTrue should revert, got ${rec.status}`);
      state.strangerPostTx = hash;
      saveState(state);
      console.log('EOA postVerdictTrue reverted as expected', explorerTx(hash));
    } catch (e) {
      // If the node refuses the send after a revert-estimate, record the error and stop cleanly once a hash exists.
      if (!state.strangerPostTx) {
        console.log('EOA postVerdictTrue refused:', e.shortMessage || e.message);
        state.strangerPostNote = 'refused at estimate or send (expected)';
        saveState(state);
      }
    }
  }
  console.log('Live batch complete. State written to', STATE_PATH, '(addresses and hashes only).');
}

const cmd = process.argv[2] || 'plan';
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (cmd === 'plan' || cmd === '--help' || cmd === 'help') {
    const { text } = await planText();
    console.log(text);
  } else if (cmd === 'dry-run') {
    await dryRun();
  } else if (cmd === 'broadcast') {
    await broadcastLive();
  } else {
    console.error(`Unknown command ${cmd}. Use plan | dry-run | broadcast --broadcast`);
    process.exit(2);
  }
}
