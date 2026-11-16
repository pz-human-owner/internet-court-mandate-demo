// Browser page: deploy MandateVerdict to GenLayer Testnet Bradbury (Phase 2) and run one
// verdict, signing every transaction in the user's own MetaMask (window.ethereum).
// No private key ever reaches this page. Every send needs a click plus a confirm dialog.
import { createClient, isSuccessful } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import {
  BRADBURY, addChainParams, assertBradburyChain, assertGenesis, constructorArgs,
  createStepGate, formatGen, evmReceiptCost, explorerTx, explorerAddress,
  liveFeesOrAbort, sendConfirmText, shouldUnlockAfterEstimate,
} from './plan.mjs';

const $ = (id) => document.getElementById(id);
const gate = createStepGate();
const state = { address: null, client: null, contract: null, evmHashes: [], sample: null, code: null, fees: null, estimated: false };

const json = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
function log(msg, obj) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}${obj === undefined ? '' : '\n' + (typeof obj === 'string' ? obj : json(obj))}`;
  $('log').textContent += line + '\n\n';
  $('log').scrollTop = $('log').scrollHeight;
}

async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const d = await r.json();
  if (d.error) throw new Error(`${method}: ${d.error.message}`);
  return d.result;
}

// Wrap MetaMask so we can record the EVM hash of each eth_sendTransaction (to read gas later).
const recordingProvider = {
  async request(args) {
    const out = await window.ethereum.request(args);
    if (args.method === 'eth_sendTransaction') state.evmHashes.push(out);
    return out;
  },
};

function genlayerRpc() { return $('glrpc').value.trim(); }

async function connect() {
  if (!window.ethereum) throw new Error('No window.ethereum. Open this page in the browser that has MetaMask.');
  const [addr] = await window.ethereum.request({ method: 'eth_requestAccounts' });
  state.address = addr;
  $('addr').textContent = addr;
  log('Connected account', addr);
  await checkNetwork();
}

async function addOrSwitch() {
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BRADBURY.chainIdHex }] });
  } catch (e) {
    if (e.code !== 4902) throw e;
    await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [addChainParams()] });
  }
  await checkNetwork();
}

async function checkNetwork() {
  const walletChain = await window.ethereum.request({ method: 'eth_chainId' });
  $('walletchain').textContent = `${Number.parseInt(walletChain, 16)}`;
  assertBradburyChain(walletChain);
  // Verify genesis on BOTH endpoints: the docs warn an old RPC can return chain id 4221
  // but point to another deployment.
  for (const url of [BRADBURY.chainRpcUrl, genlayerRpc()]) {
    const b0 = await rpc(url, 'eth_getBlockByNumber', ['0x0', false]);
    assertGenesis(b0.hash);
  }
  const walletB0 = await window.ethereum.request({ method: 'eth_getBlockByNumber', params: ['0x0', false] });
  assertGenesis(walletB0.hash);
  const bal = BigInt(await rpc(BRADBURY.chainRpcUrl, 'eth_getBalance', [state.address, 'latest']));
  $('balance').textContent = formatGen(bal);
  state.client = createClient({ chain: testnetBradbury, endpoint: genlayerRpc(), account: state.address, provider: recordingProvider });
  log('Network OK: chain 4221, genesis matches on chain RPC, GenLayer RPC and the wallet RPC', { balance: formatGen(bal) });
  $('estimate').disabled = false;
}

async function loadInputs() {
  state.code = await (await fetch('./MandateVerdict.py')).text();
  const mandate = await (await fetch('./sample_mandate.json')).json();
  const deliverables = await (await fetch('./sample_deliverables.json')).json();
  state.sample = { mandate, deliverable: deliverables.pass };
  $('mandate').value = mandate.mandate;
  $('guidelines').value = mandate.guidelines;
  $('evidence').value = mandate.evidence_url;
  $('deliverable').value = deliverables.pass.deliverable;
  $('source').value = deliverables.pass.source_url;
}

function fees() {
  if (!state.fees) throw new Error('Estimate fees first');
  return state.fees;
}

function applyFees(est) {
  state.fees = { distribution: est.distribution, feeValue: est.feeValue };
  $('feeeach').textContent = formatGen(est.feeValue);
  return state.fees;
}

async function estimate() {
  // Reads the FeeManager on chain (eth_call only, no transaction).
  const est = await state.client.estimateTransactionFees({});
  applyFees(est);
  log('Fee estimate per transaction (deposit sent as tx value; unused part is refunded at finalization)', { feeValue: formatGen(est.feeValue), policy: est.policy, distribution: est.distribution });
  // Re-clicks only refresh the displayed deposit; they must not open the next send step.
  if (!shouldUnlockAfterEstimate(state.estimated)) return;
  state.estimated = true;
  if (state.resumeContract) { gate.claim('deploy'); gate.claim('submit'); state.contract = state.resumeContract; $('verdict').disabled = false; log(`Resume mode: contract ${state.contract} already deployed and deliverable submitted; only request_verdict is enabled`); }
  else $('deploy').disabled = false;
}

async function afterSend(step, txId) {
  const evmHash = state.evmHashes.at(-1);
  log(`${step}: GenLayer tx id ${txId}`, { evmHash, explorer: evmHash ? explorerTx(evmHash) : null });
  const receipt = await state.client.waitForTransactionReceipt({ hash: txId, waitUntil: 'decided', interval: 5000, retries: 240 });
  const full = await state.client.getTransaction({ hash: txId });
  const ok = isSuccessful(full);
  log(`${step}: status ${full.statusName ?? full.status}, execution ${full.txExecutionResultName ?? full.txExecutionResult}, success=${ok}`, receipt);
  if (evmHash) {
    const r = await rpc(BRADBURY.chainRpcUrl, 'eth_getTransactionReceipt', [evmHash]);
    const t = await rpc(BRADBURY.chainRpcUrl, 'eth_getTransactionByHash', [evmHash]);
    log(`${step}: EVM cost`, { gasUsed: BigInt(r.gasUsed), effectiveGasPrice: BigInt(r.effectiveGasPrice), l2Gas: formatGen(evmReceiptCost(r)), feeDepositSentAsValue: formatGen(BigInt(t.value)) });
  }
  if (!ok) throw new Error(`${step} did not succeed; stop and read the log before doing anything else`);
  return full;
}

async function confirmSend(what) {
  // Fresh live estimate immediately before the dialog; abort the send if it fails.
  const live = await liveFeesOrAbort(() => state.client.estimateTransactionFees({}));
  applyFees(live);
  log('Live fee deposit re-estimated before send', { feeValue: formatGen(live.feeValue), policy: live.policy, distribution: live.distribution });
  return window.confirm(sendConfirmText(what, state.address, live.feeValue));
}

async function deploy() {
  const args = constructorArgs({
    agent: state.address, // one wallet: principal (deployer) and agent are the same address
    mandate: $('mandate').value, guidelines: $('guidelines').value,
    evidence_url: $('evidence').value, allow_subpaths: false,
  });
  if (!await confirmSend('Step 1 of 3: deploy MandateVerdict')) return 'cancelled';
  gate.claim('deploy');
  try {
    const txId = await state.client.deployContract({ code: state.code, args, leaderOnly: false, fees: fees() });
    const tx = await afterSend('deploy', txId);
    state.contract = tx.recipient ?? tx.txDataDecoded?.contractAddress;
    $('contract').innerHTML = `<a href="${explorerAddress(state.contract)}" target="_blank">${state.contract}</a> · <a href="https://studio.genlayer.com/?import-contract=${state.contract}" target="_blank">Studio import</a>`;
    $('submit').disabled = false;
  } catch (e) { if (!state.evmHashes.length) gate.release('deploy'); throw e; }
}

async function submit() {
  if (!await confirmSend('Step 2 of 3: submit_deliverable (you act as the appointed agent)')) return 'cancelled';
  gate.claim('submit');
  const n = state.evmHashes.length;
  try {
    const txId = await state.client.writeContract({ address: state.contract, functionName: 'submit_deliverable', args: [$('deliverable').value, $('source').value], value: 0n, fees: fees() });
    await afterSend('submit_deliverable', txId);
    $('verdict').disabled = false;
  } catch (e) { if (state.evmHashes.length === n) gate.release('submit'); throw e; }
}

async function verdict() {
  if (!await confirmSend('Step 3 of 3: request_verdict (validators fetch the bound page and judge)')) return 'cancelled';
  gate.claim('verdict');
  const n = state.evmHashes.length;
  try {
    const txId = await state.client.writeContract({ address: state.contract, functionName: 'request_verdict', args: [], value: 0n, fees: fees() });
    await afterSend('request_verdict', txId);
    await readVerdict();
  } catch (e) { if (state.evmHashes.length === n) gate.release('verdict'); throw e; }
}

async function readVerdict() {
  const v = await state.client.readContract({ address: state.contract, functionName: 'get_verdict', args: [] });
  $('result').textContent = v;
  log('get_verdict (read-only gen_call)', v);
}

function wire(id, fn) {
  $(id).addEventListener('click', async () => {
    $(id).disabled = true;
    try { if ((await fn()) === 'cancelled') { $(id).disabled = false; log(`${id}: cancelled at the confirm dialog, nothing sent`); } } catch (e) {
      log(`ERROR in ${id}: ${e.shortMessage || e.message}`);
      // Failed live estimate: nothing was sent, so allow the same send button to be retried.
      if (e.code === 'FEE_ESTIMATE_ABORTED') $(id).disabled = false;
    } finally {
      if (['connect', 'switch', 'read', 'estimate'].includes(id)) $(id).disabled = false;
    }
  });
}

$('glrpc').value = BRADBURY.defaultGenlayerRpcUrl;
$('chainrpc').textContent = BRADBURY.chainRpcUrl;
wire('connect', connect);
wire('switch', addOrSwitch);
wire('estimate', estimate);
wire('deploy', deploy);
wire('submit', submit);
wire('verdict', verdict);
wire('read', readVerdict);
{ const rc = new URLSearchParams(location.search).get('contract'); if (rc && /^0x[0-9a-fA-F]{40}$/.test(rc)) { state.resumeContract = rc; $('contract').textContent = rc + ' (resume)'; } }
loadInputs().catch((e) => log('Could not load contract/sample files: ' + e.message));
