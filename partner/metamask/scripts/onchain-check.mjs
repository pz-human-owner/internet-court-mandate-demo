// On-chain verdict check on Ethereum Sepolia (option B: VerdictGateEnforcer + a carrier named in the
// signed delegation). CI never runs it. Live transactions only with `run --broadcast --out <new-file>`.
//
//   node scripts/onchain-check.mjs plan                       # prints the steps; no keys, no network writes
//   node scripts/onchain-check.mjs rehearse --out <new.json>  # the full flow on a local anvil fork of Sepolia
//   node scripts/onchain-check.mjs run --broadcast --out <new.json>
//   node scripts/onchain-check.mjs verify [--out <new.json>]  # read-only re-check of live-onchain-check-result.json
//
// Steps (5 transactions; a hard budget of 5 is enforced in code):
//   pre  read GenLayer Bradbury (read-only): get_verdict must be resolved/TRUE and the request_verdict
//        transaction Finalized. Otherwise the carrier posts nothing and the run stops.
//   T1   CLERK deploys VerdictGateEnforcer (committed pinned artifact). eth_call of the creation code
//        must return exactly the artifact's runtime code; after mining, eth_getCode must match too.
//   -    OWNER signs an ERC-7710 delegation from the existing principal smart account to the AGENT,
//        with the VerdictGate caveat first (terms: caseKey, carrier = CLERK). Off-chain, no tx.
//   T2   CLERK funds the principal smart account with the fee.
//   T3   AGENT redeems BEFORE any verdict is posted. Sent only if eth_call reverts with
//        VerdictGateEnforcer:verdict-not-true AND the same call with verdictTrue overridden to TRUE
//        (eth_call state override) succeeds, i.e. the gate is the only thing in the way. Mined with a
//        fixed gas limit; receipt must be reverted and a parent-block replay must decode the same reason.
//   T4   CLERK (the carrier) calls postVerdictTrue(4221, case). eth_call must return the caseKey;
//        after mining the VerdictTrue event and verdictTrue[CLERK][caseKey] must be readable.
//   T5   AGENT redeems the same delegation. Sent only if eth_call succeeds. After mining: success,
//        principal balance down by exactly the fee, agent up by fee minus its own gas, call count 1.
// `run` and `rehearse` never overwrite: --out must name a file that does not exist.
// Send journal (src/send-journal.mjs): before each send the runner checks that the sender's latest and pending
// nonces equal start + sends so far, pins that nonce, and fsyncs an `intent` line to <out>.journal.jsonl; the
// hash is fsync'd as a `sent` line as soon as the send returns, before any post-send check. If anything fails
// after a send, <out>.incomplete.json records the sends, the start nonces and the abort, and the run exits 1.
// `run --broadcast --resume <incomplete.json> --out <new.json>` continues only from one point: the journal and
// the chain (nonces, receipts) agree that exactly T1 and T2 were sent and mined and nothing is pending. Any
// other state (a send with no hash, T3 already broadcast, a nonce the journal does not explain) is refused.
// T2 is taken from the journal, not from the command line.
//
// Inputs (partner/metamask/.env, gitignored; `set -a; . ./.env; set +a`): OWNER_KEY, CLERK_KEY,
// AGENT_KEY (throwaway testnet keys only, never printed), SEPOLIA_RPC_URL (default publicnode).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { createPublicClient, createWalletClient, http, formatEther, parseEther, getAddress, getContractAddress, encodeFunctionData, decodeEventLog, toHex } from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { Implementation, toMetaMaskSmartAccount, getSmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
import { LimitedCallsEnforcer } from '@metamask/delegation-abis';
import { GateError, rpcCall, simulateExpectedRevert, verifyMinedRevert, decodeRevertData } from '../src/refusal-gate.mjs';
import { redeemCalldata, hashDelegation, caseSalt, SAMPLE_CASE, GENLAYER_BRADBURY_CHAIN_ID } from '../src/verdict-payment.mjs';
import { makeVerdictReader, DEFAULT_GENLAYER_RPC } from '../src/genlayer-verdict.mjs';
import { ARTIFACT, GATE_ABI, GATE_REVERT, SLOT_TRUE, buildGatedDelegation, carrierDecision, checkSuccess, gateTerms, txBudget, verdictSlot } from '../src/verdict-gate.mjs';
import { createJournal, readJournal, journalSends, reconcileResume, describeResume, journalPathFor, SENDER } from '../src/send-journal.mjs';

// The GenLayer transaction id of the sample case's request_verdict (see proof/README.md).
export const REQUEST_VERDICT_TXID = '0xe6b05c9f31f84392c0bac5d94cb8df1f107634f61bd3ba0ce8c056710e1517d8';
const FEE = parseEther('0.001');
const REVERT_GAS = 700_000n;
const cmd = process.argv[2];
const env = process.env;
const environment = getSmartAccountsEnvironment(sepolia.id);
const ex = (h) => `https://sepolia.etherscan.io/tx/${h}`;
const bigintJson = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
const LIVE_RECORD = new URL('../live-onchain-check-result.json', import.meta.url).pathname;
const defaultRpc = env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const caseKey = caseSalt(SAMPLE_CASE);

if (cmd === 'plan' || !cmd) {
  console.log(`On-chain verdict check on Ethereum Sepolia (chain ${sepolia.id}), DelegationManager ${environment.DelegationManager}
Case: GenLayer Bradbury (chain ${GENLAYER_BRADBURY_CHAIN_ID}) MandateVerdict ${SAMPLE_CASE}, caseKey ${caseKey}
  pre  read get_verdict + gen_getTransactionReceipt(${REQUEST_VERDICT_TXID}); stop unless resolved TRUE and Finalized
  T1   CLERK deploys VerdictGateEnforcer (solc ${ARTIFACT.compiler.solc}, source sha256 ${ARTIFACT.sourceSha256})
  -    OWNER signs delegation principal -> AGENT: VerdictGate(caseKey, carrier=CLERK), ExactExecution, Redeemer(AGENT), LimitedCalls(1), Timestamp
  T2   CLERK -> principal smart account: ${formatEther(FEE)} ETH
  T3   AGENT redeems before the verdict is posted -> must revert ${GATE_REVERT}   (fixed gas ${REVERT_GAS})
  T4   CLERK postVerdictTrue(${GENLAYER_BRADBURY_CHAIN_ID}, ${SAMPLE_CASE})
  T5   AGENT redeems the same delegation -> pays AGENT ${formatEther(FEE)} ETH
Budget: 5 transactions, enforced in code.`);
  process.exit(0);
}

/** Read-only GenLayer reads the carrier bases its decision on. */
async function readGenLayer() {
  const raw = await makeVerdictReader(SAMPLE_CASE)();
  const res = await fetch(DEFAULT_GENLAYER_RPC, {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'gen_getTransactionReceipt', params: [{ txID: REQUEST_VERDICT_TXID, round: 0 }] }),
  });
  if (!res.ok) throw new GateError(`gen_getTransactionReceipt: HTTP ${res.status}`);
  const r = (await res.json()).result;
  const receipt = r ? { id: r.id, recipient: r.recipient, statusName: r.statusName, txExecutionResultName: r.txExecutionResultName } : null;
  return { raw: String(raw), receipt, readAtUtc: new Date().toISOString() };
}

async function flow({ rpcUrl, outPath, label, resume, rehearsal = false }) {
  for (const k of ['OWNER_KEY', 'CLERK_KEY', 'AGENT_KEY']) if (!env[k]) throw new GateError(`${k} is not set`);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: sepolia, transport });
  if ((await publicClient.getChainId()) !== sepolia.id) throw new GateError('RPC is not Sepolia (chain 11155111)');
  // Public RPCs are load-balanced; a node a block behind returns stale state. Every post-receipt read
  // and simulation below is pinned to an explicit block number and retried only while the node does
  // not have that block yet (never on a revert).
  const lagging = (m) => /header not found|unknown block|block not found|missing trie node|not available|cannot query unfinalized/i.test(String(m ?? ''));
  const rpc = async (method, params) => {
    for (let i = 0; ; i++) {
      const r = await rpcCall(rpcUrl, method, params);
      if (!(r?.error && !r.error.data && lagging(r.error.message)) || i >= 20) return r;
      await new Promise((res) => setTimeout(res, 1500));
    }
  };
  const retry = async (fn) => {
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (e) { if (i >= 20) throw e; await new Promise((res) => setTimeout(res, 1500)); }
    }
  };
  const hexBlock = (n) => toHex(BigInt(n));
  const owner = privateKeyToAccount(env.OWNER_KEY);
  const clerk = privateKeyToAccount(env.CLERK_KEY);
  const agentAcct = privateKeyToAccount(env.AGENT_KEY);
  const agent = agentAcct.address;
  const clerkWallet = createWalletClient({ account: clerk, chain: sepolia, transport });
  const agentWallet = createWalletClient({ account: agentAcct, chain: sepolia, transport });
  const principal = await toMetaMaskSmartAccount({
    client: publicClient, implementation: Implementation.Hybrid, deployParams: [owner.address, [], [], []], deploySalt: '0x', signer: { account: owner },
  });
  if (!(await principal.isDeployed())) throw new GateError('principal smart account is not deployed (expected the PR #4 account)');
  const budget = txBudget(5);
  const accts = { clerk: clerk.address, agent };
  const nonceNow = async (who) => ({
    latest: await retry(() => publicClient.getTransactionCount({ address: accts[who], blockTag: 'latest' })),
    pending: await retry(() => publicClient.getTransactionCount({ address: accts[who], blockTag: 'pending' })),
  });
  // Resume: reconcile the prior run's journal against the chain BEFORE anything else.
  let reconciled = null;
  if (resume) {
    const entries = readJournal(resume.journalPath);
    const chain = { nonces: { clerk: await nonceNow('clerk'), agent: await nonceNow('agent') }, txs: {} };
    for (const sd of journalSends(entries)) {
      if (!sd.hash) continue;
      const tx = await publicClient.getTransaction({ hash: sd.hash }).catch(() => null);
      if (!tx) continue;
      const rc = await publicClient.getTransactionReceipt({ hash: sd.hash }).catch(() => null);
      chain.txs[sd.hash] = { from: tx.from, nonce: tx.nonce, status: rc ? rc.status : null, blockNumber: rc ? Number(rc.blockNumber) : null };
    }
    reconciled = reconcileResume({ prior: resume.prior, entries, chain });
    console.log('resume reconciled: T1', reconciled.t1.hash, 'T2', reconciled.t2.hash, `clerk nonce ${reconciled.nonces.clerk}, agent nonce ${reconciled.nonces.agent}`);
  }
  let startNonces;
  if (resume) startNonces = resume.prior.startNonces;
  else {
    startNonces = {};
    for (const who of ['clerk', 'agent']) {
      const n = await nonceNow(who);
      if (n.latest !== n.pending) throw new GateError(`${who} has a pending transaction (latest ${n.latest}, pending ${n.pending}); refusing to start`);
      startNonces[who] = { address: accts[who], nonce: n.latest };
    }
  }
  const sendCount = resume ? { ...reconciled.sentBefore } : { clerk: 0, agent: 0 };
  const journalPath = journalPathFor(outPath);
  const journal = createJournal(journalPath, { accounts: accts, startNonces,
    prior: resume ? [reconciled.t1, reconciled.t2].map((x) => ({ step: x.step, from: x.from, nonce: x.nonce, hash: x.hash, fromJournal: basename(resume.journalPath) })) : [] });
  let step = 'pre';
  const bal = (a, blockNumber) => retry(() => publicClient.getBalance({ address: a, ...(blockNumber !== undefined ? { blockNumber: BigInt(blockNumber) } : {}) }));
  const out = {
    note: `${label}. VerdictGateEnforcer on Ethereum Sepolia: MetaMask's DelegationManager runs the gate caveat on redemption. Throwaway testnet keys; no private keys in this file. NOT trustless: the carrier (CLERK) is trusted to post only a finalized TRUE.`,
    chainId: sepolia.id, rpc: rpcUrl, delegationManager: environment.DelegationManager,
    accounts: { owner: owner.address, carrier: clerk.address, principalSmartAccount: principal.address, agent },
    case: { genlayerChainId: GENLAYER_BRADBURY_CHAIN_ID, contract: SAMPLE_CASE, caseKey, requestVerdictTxId: REQUEST_VERDICT_TXID },
    enforcerBuild: { solc: ARTIFACT.compiler.solc, evmVersion: ARTIFACT.compiler.evmVersion, optimizer: ARTIFACT.compiler.optimizer, sourcePath: ARTIFACT.sourcePath, sourceSha256: ARTIFACT.sourceSha256 },
    startedAtUtc: new Date().toISOString(),
    startNonces, journal: basename(journalPath),
    balancesBeforeWei: { carrier: await bal(clerk.address), agent: await bal(agent), principalSmartAccount: await bal(principal.address) },
    transactions: {},
  };
  const incomplete = (e) => {
    if (budget.used > 0) {
      out.aborted = e.message;
      out.abortedAtUtc = new Date().toISOString();
      out.abortedAtStep = step;
      out.sends = journalSends(journal.entries);
      writeFileSync(outPath + '.incomplete.json', bigintJson(out) + '\n', { flag: 'wx' });
      console.error(`wrote ${outPath}.incomplete.json (${budget.used} tx sent)`);
    }
    throw e;
  };
  const mined = async (hash) => {
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    const block = await retry(() => publicClient.getBlock({ blockNumber: rc.blockNumber }));
    const fee = rc.gasUsed * rc.effectiveGasPrice;
    return { rc, rec: { hash, etherscan: ex(hash), status: rc.status, block: Number(rc.blockNumber), timestampUtc: new Date(Number(block.timestamp) * 1000).toISOString(), gasUsed: Number(rc.gasUsed), feePaidWei: fee.toString() } };
  };

  // Every send goes through here: nonce check, budget, durable intent, send with the pinned nonce, durable hash.
  const send = async (stepName, wallet, tx) => {
    const who = SENDER[stepName];
    const nonce = startNonces[who].nonce + sendCount[who];
    for (let i = 0; ; i++) {
      const n = await nonceNow(who);
      if (n.latest === nonce && n.pending === nonce) break;
      if (n.latest > nonce || n.pending > nonce || i >= 20) throw new GateError(`${stepName}: ${who} nonce is latest ${n.latest} / pending ${n.pending}, expected ${nonce}; refusing to send`);
      await new Promise((res) => setTimeout(res, 1500)); // a lagging node; never send on a mismatch
    }
    budget.take(stepName);
    journal.intent(stepName, accts[who], nonce);
    sendCount[who] += 1;
    const h = await wallet.sendTransaction({ ...tx, nonce });
    journal.sent(stepName, h);
    console.log(`${stepName} sent`, h, `(nonce ${nonce})`);
    if (rehearsal && env.ONCHAIN_CHECK_FAULT_AFTER_SEND === stepName) throw new GateError(`injected fault right after ${stepName} was sent (rehearsal only)`);
    return { h, nonce };
  };

  try {
    // pre: what the carrier reads before it may post (read-only GenLayer).
    const gen = await readGenLayer();
    const decision = carrierDecision({ verdictRaw: gen.raw, genReceipt: gen.receipt, caseContract: SAMPLE_CASE });
    out.genlayerRead = { network: 'GenLayer Testnet Bradbury', endpoint: DEFAULT_GENLAYER_RPC, ...gen, carrierDecision: decision };
    if (!decision.post) throw new GateError(`carrier must not post: ${decision.why}`);
    console.log('pre  carrier may post:', decision.why);

    let gate, t1, t2;
    if (resume) {
      // Resume after an abort that happened AFTER T1 and T2 were mined. The journal and the chain were
      // reconciled above; T1 and T2 come from the journal (not the command line) and count against the budget.
      const prior = resume.prior;
      gate = getAddress(prior.enforcer.address);
      step = 'resume';
      const r1 = await retry(() => publicClient.getTransactionReceipt({ hash: reconciled.t1.hash }));
      if (r1.status !== 'success' || getAddress(r1.contractAddress) !== gate) throw new GateError('resume: T1 did not deploy the recorded enforcer');
      const r2 = await retry(() => publicClient.getTransactionReceipt({ hash: reconciled.t2.hash }));
      const x2 = await retry(() => publicClient.getTransaction({ hash: reconciled.t2.hash }));
      if (getAddress(x2.to) !== principal.address || x2.value !== FEE) throw new GateError('resume: T2 is not the fee transfer to the principal');
      budget.take('T1 (sent in the aborted run)');
      budget.take('T2 (sent in the aborted run)');
      const fromRc = async (hash, rc) => {
        const b = await retry(() => publicClient.getBlock({ blockNumber: rc.blockNumber }));
        return { hash, etherscan: ex(hash), status: rc.status, block: Number(rc.blockNumber), timestampUtc: new Date(Number(b.timestamp) * 1000).toISOString(), gasUsed: Number(rc.gasUsed), feePaidWei: (rc.gasUsed * rc.effectiveGasPrice).toString() };
      };
      t1 = { rc: r1, rec: { ...(await fromRc(reconciled.t1.hash, r1)), nonce: reconciled.t1.nonce } };
      t2 = { rc: r2, rec: { ...(await fromRc(reconciled.t2.hash, r2)), nonce: reconciled.t2.nonce } };
      out.balancesBeforeWei = prior.balancesBeforeWei;
      out.startedAtUtc = prior.startedAtUtc;
      out.resumedFrom = describeResume({ prior, reconciled });
    }
    if (!resume) {
    // T1 deploy the enforcer.
    step = 'T1';
    gate = getContractAddress({ from: clerk.address, nonce: BigInt(startNonces.clerk.nonce) });
    if (((await publicClient.getCode({ address: gate })) ?? '0x') !== '0x') throw new GateError(`predicted address ${gate} already has code`);
    const simCode = checkSuccess('T1 simulate deploy', await rpc('eth_call', [{ from: clerk.address, data: ARTIFACT.bytecode }, 'latest']));
    if (simCode.toLowerCase() !== ARTIFACT.deployedBytecode.toLowerCase()) throw new GateError('T1: simulated runtime code != artifact deployedBytecode');
    const s1 = await send('T1', clerkWallet, { data: ARTIFACT.bytecode });
    t1 = await mined(s1.h);
    t1.rec.nonce = s1.nonce;
    if (t1.rc.status !== 'success') throw new GateError(`T1 status ${t1.rc.status}`);
    if (getAddress(t1.rc.contractAddress) !== gate) throw new GateError(`T1 deployed at ${t1.rc.contractAddress}, predicted ${gate}`);
    }
    {
    const code = await retry(() => publicClient.getCode({ address: gate, blockNumber: t1.rc.blockNumber }));
    if (code.toLowerCase() !== ARTIFACT.deployedBytecode.toLowerCase()) throw new GateError('T1: on-chain code != artifact deployedBytecode');
    }
    out.enforcer = { address: gate, etherscan: `https://sepolia.etherscan.io/address/${gate}#code`, runtimeCodeMatchesArtifact: true };
    out.transactions.T1_deployEnforcer = { ...t1.rec, from: clerk.address, contractAddress: gate, what: 'CLERK deploys VerdictGateEnforcer; on-chain runtime code equals the committed pinned artifact' };

    let signed;
    if (resume) {
      signed = resume.prior.delegation.signed;
      out.delegation = resume.prior.delegation;
      if (hashDelegation(signed) !== out.delegation.hash || getAddress(signed.delegate) !== agent || getAddress(signed.delegator) !== principal.address) throw new GateError('resume: delegation mismatch');
    } else {

    // Sign the gated delegation (off-chain).
    const head = await publicClient.getBlock();
    const expiresAt = Number(head.timestamp) + 86400;
    const d = buildGatedDelegation({ environment, principal: principal.address, agent, carrier: clerk.address, gate, amountWei: FEE, expiresAt, caseContract: SAMPLE_CASE });
    signed = { ...d, signature: await principal.signDelegation({ delegation: d }) };
    out.delegation = { hash: hashDelegation(signed), delegator: signed.delegator, delegate: signed.delegate, salt: signed.salt, feeWei: FEE.toString(),
      expiresAtUnix: expiresAt, expiresAtUtc: new Date(expiresAt * 1000).toISOString(),
      gateCaveatIndex: signed.caveats.findIndex((c) => getAddress(c.enforcer) === gate), caveatCount: signed.caveats.length, signed };
    }
    {
      const gc = signed.caveats.filter((c) => getAddress(c.enforcer) === gate);
      if (gc.length !== 1 || gc[0].terms.toLowerCase() !== gateTerms(caseKey, clerk.address).toLowerCase()) throw new GateError('delegation gate caveat mismatch');
    }
    const dHash = hashDelegation(signed);
    const data = redeemCalldata(signed, { agent, amountWei: FEE });
    const callCount = (blockNumber) => retry(() => publicClient.readContract({ address: environment.caveatEnforcers.LimitedCallsEnforcer, abi: LimitedCallsEnforcer, functionName: 'callCounts', args: [environment.DelegationManager, dHash], blockNumber: BigInt(blockNumber) }));

    // T2 fund the principal smart account.
    if (!resume) {
    step = 'T2';
    checkSuccess('T2 simulate fund', await rpc('eth_call', [{ from: clerk.address, to: principal.address, value: toHex(FEE) }, 'latest']));
    const s2 = await send('T2', clerkWallet, { to: principal.address, value: FEE });
    t2 = await mined(s2.h);
    t2.rec.nonce = s2.nonce;
    if (t2.rc.status !== 'success') throw new GateError(`T2 status ${t2.rc.status}`);
    }
    const pBefore = await bal(principal.address, t2.rc.blockNumber - 1n);
    const pFunded = await bal(principal.address, t2.rc.blockNumber);
    if (pFunded - pBefore !== FEE) throw new GateError(`T2: principal balance rose by ${pFunded - pBefore}, not ${FEE}`);
    out.transactions.T2_fundPrincipal = { ...t2.rec, from: clerk.address, to: principal.address, valueWei: FEE.toString(), what: 'CLERK funds the principal smart account with the fee' };

    // T3 blocked redeem: in the pinned simulation, the gate must be the only obstacle.
    step = 'T3';
    let pin2 = t2.rc.blockNumber;
    if (resume && rehearsal) {
      // anvil cannot apply eth_call state overrides at blocks before its fork point; mine one empty
      // local block and pin there instead (same state as after T2).
      await rpc('evm_mine', []);
      pin2 = await publicClient.getBlockNumber();
    }
    const at2 = hexBlock(pin2);
    const sim3 = await simulateExpectedRevert({ label: 'T3', rpc, from: agent, to: environment.DelegationManager, data, gas: REVERT_GAS, block: at2, expected: [GATE_REVERT] });
    const override = { [gate]: { stateDiff: { [verdictSlot(clerk.address, caseKey)]: SLOT_TRUE } } };
    checkSuccess('T3 counterfactual (verdictTrue overridden)', await rpc('eth_call', [{ from: agent, to: environment.DelegationManager, data, gas: toHex(REVERT_GAS) }, at2, override]));
    const s3 = await send('T3', agentWallet, { to: environment.DelegationManager, data, gas: REVERT_GAS });
    const h3 = s3.h;
    const t3 = await mined(h3);
    t3.rec.nonce = s3.nonce;
    const tx3 = await retry(() => publicClient.getTransaction({ hash: h3 }));
    const v3 = await verifyMinedRevert({ label: 'T3', rpc, receipt: t3.rc, tx: tx3, expected: [GATE_REVERT] });
    if (Number(await callCount(t3.rc.blockNumber)) !== 0) throw new GateError('T3: call count changed');
    out.transactions.T3_redeemBeforeVerdict = { ...t3.rec, from: agent, to: environment.DelegationManager, gasLimit: Number(REVERT_GAS), delegationHash: dHash,
      blockedBy: 'VerdictGateEnforcer (verdict-not-true)', blockedByAddress: gate, simulatedRevertReason: sim3.reason, simulatedRevertData: sim3.data,
      counterfactual: {
        method: 'eth_call with a state override (a simulation, not a trace of the mined T3)',
        block: Number(pin2), blockIs: resume && rehearsal ? 'an empty local anvil block mined after T2 (same state as after T2)' : 'the block of T2 (state after T2)',
        minedT3Block: Number(t3.rc.blockNumber),
        override: { contract: gate, slot: verdictSlot(clerk.address, caseKey), value: SLOT_TRUE, meaning: 'verdictTrue[carrier][caseKey] = TRUE' },
        withoutOverride: GATE_REVERT, withOverride: 'success',
        claim: `In this pinned simulation at block ${Number(pin2)}, the same call reverted with ${GATE_REVERT} and succeeded once verdictTrue[carrier][caseKey] was overridden to TRUE, so in that simulation the gate was the only obstacle. It says nothing about other blocks or state.`,
      },
      replayAtParentBlock: { block: v3.replayBlock, revertData: v3.replayRevertData, decoded: v3.replayDecoded },
      what: 'AGENT tries to redeem before any verdict is posted on Sepolia; MetaMask runs the gate caveat and it reverts' };

    // T4 carrier posts TRUE.
    step = 'T4';
    const postData = encodeFunctionData({ abi: GATE_ABI, functionName: 'postVerdictTrue', args: [BigInt(GENLAYER_BRADBURY_CHAIN_ID), SAMPLE_CASE] });
    const ret = checkSuccess('T4 simulate post', await rpc('eth_call', [{ from: clerk.address, to: gate, data: postData }, hexBlock(t3.rc.blockNumber)]));
    if (ret.toLowerCase() !== caseKey.toLowerCase()) throw new GateError(`T4: postVerdictTrue would return ${ret}, not caseKey`);
    const s4 = await send('T4', clerkWallet, { to: gate, data: postData });
    const t4 = await mined(s4.h);
    t4.rec.nonce = s4.nonce;
    if (t4.rc.status !== 'success') throw new GateError(`T4 status ${t4.rc.status}`);
    const ev = t4.rc.logs.filter((l) => getAddress(l.address) === gate).map((l) => decodeEventLog({ abi: GATE_ABI, data: l.data, topics: l.topics }));
    if (ev.length !== 1 || ev[0].eventName !== 'VerdictTrue' || getAddress(ev[0].args.carrier) !== clerk.address || ev[0].args.caseKey !== caseKey
      || ev[0].args.genlayerChainId !== BigInt(GENLAYER_BRADBURY_CHAIN_ID) || getAddress(ev[0].args.caseContract) !== SAMPLE_CASE) throw new GateError('T4: VerdictTrue event mismatch');
    if (!(await retry(() => publicClient.readContract({ address: gate, abi: GATE_ABI, functionName: 'verdictTrue', args: [clerk.address, caseKey], blockNumber: t4.rc.blockNumber })))) throw new GateError('T4: verdictTrue not set');
    out.transactions.T4_postVerdictTrue = { ...t4.rec, from: clerk.address, to: gate, event: { name: 'VerdictTrue', carrier: clerk.address, caseKey, genlayerChainId: GENLAYER_BRADBURY_CHAIN_ID, caseContract: SAMPLE_CASE },
      what: 'CLERK, the carrier named in the signed caveat, records the finalized TRUE verdict for this case on Sepolia' };

    // T5 agent redeems.
    step = 'T5';
    checkSuccess('T5 simulate redeem', await rpc('eth_call', [{ from: agent, to: environment.DelegationManager, data }, hexBlock(t4.rc.blockNumber)]));
    const s5 = await send('T5', agentWallet, { to: environment.DelegationManager, data });
    const t5 = await mined(s5.h);
    t5.rec.nonce = s5.nonce;
    if (t5.rc.status !== 'success') throw new GateError(`T5 status ${t5.rc.status}`);
    const aBefore = await bal(agent, t5.rc.blockNumber - 1n);
    const pBefore5 = await bal(principal.address, t5.rc.blockNumber - 1n);
    const aAfter = await bal(agent, t5.rc.blockNumber);
    const pAfter = await bal(principal.address, t5.rc.blockNumber);
    const gas5 = t5.rc.gasUsed * t5.rc.effectiveGasPrice;
    if (pBefore5 - pAfter !== FEE) throw new GateError(`T5: principal paid ${pBefore5 - pAfter}, not ${FEE}`);
    if (aAfter - aBefore !== FEE - gas5) throw new GateError(`T5: agent net ${aAfter - aBefore}, expected fee - gas ${FEE - gas5}`);
    const count = Number(await callCount(t5.rc.blockNumber));
    if (count !== 1) throw new GateError(`T5: call count ${count}`);
    out.transactions.T5_redeemAfterVerdict = { ...t5.rec, from: agent, to: environment.DelegationManager, delegationHash: dHash,
      what: 'AGENT redeems the same delegation after the carrier posted TRUE; MetaMask pays the agent the fee from the principal smart account' };
    out.checks = {
      transactionsUsed: budget.used,
      enforcerCodeMatchesArtifact: true,
      blockedBeforeVerdict: t3.rc.status === 'reverted',
      paidAfterVerdict: t5.rc.status === 'success',
      principalPaidWei: (pBefore5 - pAfter).toString(),
      agentNetFromT5Wei: (aAfter - aBefore).toString(),
      agentGasForT5Wei: gas5.toString(),
      limitedCallsCountAfter: count,
      verdictTrueRecorded: true,
    };
    {
      const end = { clerk: await nonceNow('clerk'), agent: await nonceNow('agent') };
      for (const who of ['clerk', 'agent']) {
        const want = startNonces[who].nonce + sendCount[who];
        if (end[who].latest !== want || end[who].pending !== want) throw new GateError(`end: ${who} nonce ${end[who].latest}/${end[who].pending}, expected ${want}`);
      }
      out.checks.nonces = { clerk: `${startNonces.clerk.nonce} -> ${startNonces.clerk.nonce + sendCount.clerk}`, agent: `${startNonces.agent.nonce} -> ${startNonces.agent.nonce + sendCount.agent}`, sends: sendCount };
      if (sendCount.clerk + sendCount.agent !== 5) throw new GateError(`end: ${sendCount.clerk + sendCount.agent} sends, expected 5`);
    }
    out.balancesAfterWei = { carrier: await bal(clerk.address, t5.rc.blockNumber), agent: aAfter, principalSmartAccount: pAfter, atBlock: Number(t5.rc.blockNumber) };
    out.balancesAfterEth = { carrier: formatEther(out.balancesAfterWei.carrier), agent: formatEther(aAfter), principalSmartAccount: formatEther(pAfter) };
    out.finishedAtUtc = new Date().toISOString();
  } catch (e) { incomplete(e); }
  writeFileSync(outPath, bigintJson(out) + '\n', { flag: 'wx' }); // never overwrite
  console.log(`wrote ${outPath}`, bigintJson(out.checks));
  return out;
}

const outIdx = process.argv.indexOf('--out');
const outArg = outIdx > 0 && process.argv[outIdx + 1] ? resolve(process.argv[outIdx + 1]) : null;
const fail = (e) => { console.error(`FAILED: ${e.message}`); process.exit(1); };
function parseResume() {
  let resume;
  const ri = process.argv.indexOf('--resume');
  if (process.argv.includes('--t2-hash')) { console.error('--t2-hash is no longer accepted: T2 is taken from the send journal of the incomplete record'); process.exit(2); }
  if (ri > 0) {
    if (!process.argv[ri + 1]) { console.error('--resume needs <incomplete.json>'); process.exit(2); }
    const priorPath = resolve(process.argv[ri + 1]);
    const prior = JSON.parse(readFileSync(priorPath, 'utf8'));
    if (!prior.aborted || !prior.journal || !prior.startNonces) { console.error('resume file is not an aborted run with a send journal'); process.exit(2); }
    resume = { prior, priorPath, journalPath: resolve(dirname(priorPath), prior.journal) };
  }
  return resume;
}

if (cmd === 'rehearse') {
  if (!outArg) { console.error('rehearse needs --out <new-file.json>'); process.exit(2); }
  if (existsSync(outArg)) { console.error(`Refusing: ${outArg} exists`); process.exit(2); }
  // REHEARSE_RPC_URL: reuse an already-running local anvil fork (loopback only; must answer anvil_nodeInfo),
  // so a crash-then-resume can be rehearsed against the same fork state. Otherwise spawn a fresh fork.
  const reuse = env.REHEARSE_RPC_URL;
  if (reuse && !/^http:\/\/127\.0\.0\.1:\d+$/.test(reuse)) { console.error('REHEARSE_RPC_URL must be http://127.0.0.1:<port>'); process.exit(2); }
  const port = 18545 + Math.floor(Math.random() * 1000);
  const anvil = reuse ? { kill() {} } : spawn('anvil', ['--fork-url', defaultRpc, '--port', String(port), '--silent'], { stdio: 'ignore' });
  const rpcUrl = reuse ?? `http://127.0.0.1:${port}`;
  try {
    if (reuse && !(await rpcCall(rpcUrl, 'anvil_nodeInfo', [])).result) throw new Error('REHEARSE_RPC_URL is not an anvil node');
    for (let i = 0; ; i++) {
      try { if ((await rpcCall(rpcUrl, 'eth_chainId', [])).result) break; } catch {}
      if (i > 60) throw new Error('anvil did not start');
      await new Promise((r) => setTimeout(r, 500));
    }
    const resume = parseResume();
    await flow({ resume, rehearsal: true, rpcUrl, outPath: outArg, label: `Rehearsal on a local anvil fork of Sepolia (anvil 1.9.0 default hardfork, whose gas schedule matched live Sepolia for T1/T2; forked from ${defaultRpc}); nothing here was broadcast to Sepolia` });
  } catch (e) { anvil.kill(); fail(e); }
  anvil.kill();
  process.exit(0);
}

if (cmd === 'run') {
  const resume = parseResume();
  if (!process.argv.includes('--broadcast') || !outArg) { console.error('Refusing: need `run --broadcast --out <new-file.json>`'); process.exit(2); }
  if (existsSync(outArg)) { console.error(`Refusing: ${outArg} exists. The recorded run is the evidence.`); process.exit(2); }
  try { await flow({ rpcUrl: defaultRpc, outPath: outArg, label: resume ? 'Live run on Ethereum Sepolia (resumed after T2 from a reconciled send journal; see resumedFrom)' : 'Live run on Ethereum Sepolia', resume }); } catch (e) { fail(e); }
  process.exit(0);
}

if (cmd === 'verify') {
  // Read-only: re-check the recorded live run on Sepolia. Needs no keys; sends nothing.
  try {
    const rec = JSON.parse(readFileSync(LIVE_RECORD, 'utf8'));
    const rpc = (method, params) => rpcCall(defaultRpc, method, params);
    const pc = createPublicClient({ chain: sepolia, transport: http(defaultRpc) });
    if ((await pc.getChainId()) !== sepolia.id) throw new GateError('RPC is not Sepolia');
    const gate = getAddress(rec.enforcer.address);
    const code = await pc.getCode({ address: gate });
    if (code.toLowerCase() !== ARTIFACT.deployedBytecode.toLowerCase()) throw new GateError('enforcer code != artifact');
    const t = rec.transactions;
    const results = { enforcerCodeMatchesArtifact: true };
    for (const [k, want] of [['T1_deployEnforcer', 'success'], ['T2_fundPrincipal', 'success'], ['T3_redeemBeforeVerdict', 'reverted'], ['T4_postVerdictTrue', 'success'], ['T5_redeemAfterVerdict', 'success']]) {
      const rc = await pc.getTransactionReceipt({ hash: t[k].hash });
      if (rc.status !== want) throw new GateError(`${k}: status ${rc.status}, want ${want}`);
      if (Number(rc.gasUsed) !== t[k].gasUsed) throw new GateError(`${k}: gasUsed differs from record`);
      results[k] = { hash: t[k].hash, status: rc.status, block: Number(rc.blockNumber) };
    }
    const tx3 = await pc.getTransaction({ hash: t.T3_redeemBeforeVerdict.hash });
    const rc3 = await pc.getTransactionReceipt({ hash: t.T3_redeemBeforeVerdict.hash });
    const v3 = await verifyMinedRevert({ label: 'T3', rpc, receipt: rc3, tx: tx3, expected: [GATE_REVERT] });
    results.T3_redeemBeforeVerdict.replayDecoded = v3.replayDecoded;
    // Nonces: exactly these five transactions came from the two accounts between the start and T5, and the
    // agent sent nothing between the start and T3 (so the abort after T2 came before any T3 broadcast).
    const nonceAt = async (address, block) => Number(await pc.getTransactionCount({ address, blockNumber: BigInt(block) }));
    const txs = {};
    for (const k of Object.keys(t)) txs[k] = await pc.getTransaction({ hash: t[k].hash });
    const clerkKs = ['T1_deployEnforcer', 'T2_fundPrincipal', 'T4_postVerdictTrue'], agentKs = ['T3_redeemBeforeVerdict', 'T5_redeemAfterVerdict'];
    const seq = (ks, who) => { const n = ks.map((k) => { if (getAddress(txs[k].from) !== getAddress(who)) throw new GateError(`${k}: from ${txs[k].from}`); return txs[k].nonce; });
      n.forEach((x, i) => { if (x !== n[0] + i) throw new GateError(`nonces not consecutive: ${n}`); }); return n; };
    const cn = seq(clerkKs, rec.accounts.carrier), an = seq(agentKs, rec.accounts.agent);
    const b0 = t.T1_deployEnforcer.block - 1, b5 = t.T5_redeemAfterVerdict.block, b3 = t.T3_redeemBeforeVerdict.block - 1;
    const n = { clerkBefore: await nonceAt(rec.accounts.carrier, b0), clerkAfter: await nonceAt(rec.accounts.carrier, b5),
      agentBefore: await nonceAt(rec.accounts.agent, b0), agentBeforeT3: await nonceAt(rec.accounts.agent, b3), agentAfter: await nonceAt(rec.accounts.agent, b5) };
    if (n.clerkBefore !== cn[0] || n.clerkAfter !== cn[0] + 3) throw new GateError(`clerk nonce ${n.clerkBefore} -> ${n.clerkAfter}, expected ${cn[0]} -> ${cn[0] + 3}`);
    if (n.agentBefore !== an[0] || n.agentBeforeT3 !== an[0] || n.agentAfter !== an[0] + 2) throw new GateError(`agent nonce ${n.agentBefore} -> ${n.agentBeforeT3} -> ${n.agentAfter}, expected ${an[0]} -> ${an[0]} -> ${an[0] + 2}`);
    results.nonces = { clerk: { address: rec.accounts.carrier, atBlock: { [b0]: n.clerkBefore, [b5]: n.clerkAfter }, txNonces: Object.fromEntries(clerkKs.map((k, i) => [k, cn[i]])) },
      agent: { address: rec.accounts.agent, atBlock: { [b0]: n.agentBefore, [b3]: n.agentBeforeT3, [b5]: n.agentAfter }, txNonces: Object.fromEntries(agentKs.map((k, i) => [k, an[i]])) },
      conclusion: `clerk ${n.clerkBefore} -> ${n.clerkAfter} and agent ${n.agentBefore} -> ${n.agentAfter} between blocks ${b0} and ${b5}: exactly 5 transactions from these accounts; the agent's nonce was still ${n.agentBeforeT3} at block ${b3}, so no T3 was broadcast before the recorded one` };
    // Re-run the T3 counterfactual at its recorded block (read-only; needs an RPC with state at that block).
    const cf = t.T3_redeemBeforeVerdict.counterfactual;
    if (cf && typeof cf === 'object') {
      const data3 = txs.T3_redeemBeforeVerdict.input;
      const at = toHex(BigInt(cf.block));
      // Public RPCs load-balance across archive and non-archive nodes: retry a refused historical read a few times.
      const hist = async (params) => { for (let i = 0; ; i++) { try { return await rpc('eth_call', params); } catch (e) { if (i >= 8 || !/HTTP 403/.test(e.message)) throw e; await new Promise((res) => setTimeout(res, 1500)); } } };
      const plain = await hist([{ from: rec.accounts.agent, to: rec.delegationManager, data: data3, gas: toHex(REVERT_GAS) }, at]);
      const over = await hist([{ from: rec.accounts.agent, to: rec.delegationManager, data: data3, gas: toHex(REVERT_GAS) }, at, { [gate]: { stateDiff: { [cf.override.slot]: cf.override.value } } }]);
      const archive = (r) => /archive|missing trie|header not found|not available/i.test(String(r?.error?.message ?? ''));
      if (archive(plain) || archive(over)) results.counterfactualReplay = { block: cf.block, skipped: 'the RPC has no state at that block' };
      else {
        const why = plain.error ? decodeRevertData(plain.error.data) : null;
        if (why !== GATE_REVERT || over.error) throw new GateError(`counterfactual replay at ${cf.block}: plain ${why ?? 'succeeded'}, overridden ${over.error ? 'reverted' : 'succeeded'}`);
        results.counterfactualReplay = { block: cf.block, withoutOverride: why, withOverride: 'success' };
      }
    }
    results.verdictTrue = await pc.readContract({ address: gate, abi: GATE_ABI, functionName: 'verdictTrue', args: [getAddress(rec.accounts.carrier), rec.case.caseKey] });
    if (!results.verdictTrue) throw new GateError('verdictTrue not set on-chain');
    // Source verification on Sourcify (public, no account): require an exact (metadata-hash) match.
    const sf = await (await fetch(`https://sourcify.dev/server/v2/contract/${sepolia.id}/${gate}`)).json();
    if (sf.match !== 'exact_match' || sf.creationMatch !== 'exact_match' || sf.runtimeMatch !== 'exact_match') throw new GateError(`Sourcify match is ${sf.match}`);
    results.sourcify = { match: sf.match, creationMatch: sf.creationMatch, runtimeMatch: sf.runtimeMatch, verifiedAt: sf.verifiedAt, repo: `https://repo.sourcify.dev/${sepolia.id}/${gate}` };
    const out = { method: 'read-only: eth_getCode, eth_getTransactionReceipt, eth_getTransactionByHash, eth_getTransactionCount at fixed blocks, eth_call replay at the parent block, the T3 counterfactual eth_call at its recorded block, verdictTrue(), Sourcify lookup; no transactions', rpc: defaultRpc, atUtc: new Date().toISOString(), passed: true, results };
    console.log(bigintJson(out));
    if (outArg) writeFileSync(outArg, bigintJson(out) + '\n', { flag: 'wx' });
    process.exit(0);
  } catch (e) { fail(e); }
}
console.error('unknown command; see the header of scripts/onchain-check.mjs');
process.exit(2);
