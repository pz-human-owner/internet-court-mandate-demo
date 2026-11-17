// Browser page for MandateVerdict on GenLayer Testnet Bradbury (Phase 2).
// 1) Live view (default, no wallet): reads the deployed sample case with read-only
//    gen_call views and renders the verdict. Falls back to the recorded run if the RPC fails.
// 2) Optional MetaMask flow: deploy your own copy and run one verdict, signing every
//    transaction in the visitor's own MetaMask (window.ethereum). No private key ever
//    reaches this page. Every send needs a click plus a confirm dialog with a fresh fee estimate.
import { createClient, isSuccessful } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import {
  BRADBURY, addChainParams, assertBradburyChain, assertGenesis, constructorArgs,
  createStepGate, formatGen, evmReceiptCost, explorerTx, explorerAddress,
  liveFeesOrAbort, sendConfirmText, shouldUnlockAfterEstimate,
  viewContractAddress, parseVerdict, parseCase, RECORDED_RUN, recordedTxLinks, withTimeout,
  resumeFromStatus, resumeOnReadFailure, normalizeCaseStatus,
} from './plan.mjs';
import { CHECKS, ADDR, runChecks, outcomeLabel, PASS_OUTCOMES } from './breakit.mjs';

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

function applyResume(action) {
  for (const id of action.claim) {
    if (!gate.isDone(id)) gate.claim(id);
  }
  if (action.enable) $(action.enable).disabled = false;
  $('contract').innerHTML = `<a href="${explorerAddress(state.contract)}" target="_blank">${state.contract}</a> · <a href="https://studio.genlayer.com/?import-contract=${state.contract}" target="_blank">Studio import</a> (resume)`;
  log(action.log);
}

async function unlockResume() {
  state.contract = state.resumeContract;
  let raw;
  try {
    raw = await withTimeout(
      state.client.readContract({ address: state.contract, functionName: 'get_status', args: [] }),
      VIEW_TIMEOUT_MS,
      'get_status',
    );
  } catch (e) {
    const why = (e && (e.shortMessage || e.message)) || String(e);
    // Fail-closed: without an explicit &step=, enable nothing (estimated stays false so Estimate can be retried).
    const fb = resumeOnReadFailure(typeof location !== 'undefined' ? location.search : '', why);
    log(fb.log);
    if (!fb.action) return;
    applyResume(fb.action);
    state.estimated = true;
    return;
  }
  const status = normalizeCaseStatus(raw);
  log('Resume: read-only get_status', status);
  let action;
  try {
    action = resumeFromStatus(status);
  } catch (e) {
    log((e && (e.shortMessage || e.message)) || String(e));
    return; // estimated stays false so Estimate can be retried
  }
  applyResume(action);
  state.estimated = true;
  if (action.showVerdict) await readVerdict();
}

async function estimate() {
  // Reads the FeeManager on chain (eth_call only, no transaction).
  const est = await state.client.estimateTransactionFees({});
  applyFees(est);
  log('Fee estimate per transaction (deposit sent as tx value; unused part is refunded at finalization)', { feeValue: formatGen(est.feeValue), policy: est.policy, distribution: est.distribution });
  // Re-clicks only refresh the displayed deposit; they must not open the next send step.
  if (!shouldUnlockAfterEstimate(state.estimated)) return;
  if (state.resumeContract) {
    await unlockResume();
    return;
  }
  state.estimated = true;
  $('deploy').disabled = false;
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

// ---------------------------------------------------------------------------
// Live view: read-only client, no account, no provider. Only gen_call views.
// ---------------------------------------------------------------------------
const VIEW_TIMEOUT_MS = 30000;
const view = { busy: false };

function setText(id, v) { $(id).textContent = v == null || v === '' ? '–' : String(v); }

function link(href, text) {
  const a = document.createElement('a');
  a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = text;
  return a;
}

function renderContract(address) {
  const el = $('v-contract');
  el.replaceChildren(link(explorerAddress(address), address), document.createTextNode(' (explorer)'));
}

function renderSource(url) {
  const el = $('v-source');
  if (url && url.startsWith('https://')) el.replaceChildren(link(url, url)); else setText('v-source', url);
}

function renderTxLinks(container) {
  const ul = document.createElement('ul');
  for (const t of recordedTxLinks()) {
    const li = document.createElement('li');
    li.append(`${t.step}: `, link(t.explorer, t.evmHash.slice(0, 18) + '…'), ' · ', link(`./proof/eth/${t.proof}`, 'EVM receipt'), ' · ', link(`./proof/gen/${t.proof}`, 'GenLayer receipt'));
    ul.append(li);
  }
  container.append(ul);
}

async function viewLive() {
  if (view.busy) return;
  view.busy = true;
  const { address, isDefault } = viewContractAddress(location.search);
  renderContract(address);
  $('v-recorded').replaceChildren();
  $('v-mode').className = 'note';
  $('v-mode').textContent = `Reading ${isDefault ? 'the sample case' : 'contract ' + address} on Bradbury (read-only gen_call: get_status, get_verdict, get_case)…`;
  try {
    const reader = createClient({ chain: testnetBradbury, endpoint: BRADBURY.defaultGenlayerRpcUrl });
    const read = (functionName) => withTimeout(reader.readContract({ address, functionName, args: [] }), VIEW_TIMEOUT_MS, functionName);
    const [status, rawVerdict, rawCase] = await Promise.all([read('get_status'), read('get_verdict'), read('get_case')]);
    const v = parseVerdict(rawVerdict);
    const c = parseCase(rawCase);
    setText('v-status', status);
    setText('v-verdict', v.verdict || (v.last_error ? `no verdict yet (${v.last_error})` : 'no verdict yet'));
    setText('v-reasoning', v.reasoning);
    setText('v-quote', v.quote);
    renderSource(v.source_url || c.source_url);
    setText('v-mandate', c.mandate);
    setText('v-deliverable', c.deliverable);
    setText('v-time', `${new Date().toLocaleString()} (your local time)`);
    $('v-mode').textContent = `Live: read just now from ${address} on GenLayer Testnet Bradbury via ${BRADBURY.defaultGenlayerRpcUrl}. Read-only, no wallet, no transaction.`;
    if (isDefault) {
      const p = document.createElement('p');
      p.textContent = 'The three transactions that produced this verdict (Nov 15, 2026):';
      $('v-recorded').append(p);
      renderTxLinks($('v-recorded'));
    }
    log('Live view: get_verdict (read-only gen_call)', v);
  } catch (e) {
    showRecorded(address, isDefault, e);
  } finally {
    view.busy = false;
  }
}

async function showRecorded(address, isDefault, err) {
  const why = (err && (err.shortMessage || err.message)) || String(err);
  log('Live view: read failed, showing the recorded run', why);
  $('v-mode').className = 'warn';
  if (!isDefault) {
    $('v-mode').textContent = `Live read of ${address} failed (${why}). No recorded snapshot exists for this address; check it on the explorer or press Re-read live.`;
    return;
  }
  $('v-mode').textContent = `Live read failed (${why}). Showing the recorded result of the sample run instead. It is not a live read; press Re-read live to try again, or verify on the explorer.`;
  const r = RECORDED_RUN;
  renderContract(r.contract);
  setText('v-status', `${r.status} (recorded)`);
  setText('v-verdict', `${r.verdict} · ${r.consensus}`);
  setText('v-reasoning', r.reasoning);
  setText('v-quote', r.quote);
  renderSource(r.source_url);
  setText('v-mandate', 'Not in the snapshot; see examples/sample_mandate.json in the repository.');
  setText('v-deliverable', 'Not in the snapshot; see examples/sample_deliverables.json ("pass").');
  setText('v-time', `Receipts captured ${r.capturedEt}`);
  const p = document.createElement('p');
  p.textContent = 'Recorded transactions, with the dated RPC receipts from the repository\'s proof/ folder:';
  $('v-recorded').replaceChildren(p);
  renderTxLinks($('v-recorded'));
  try {
    const g = await (await fetch('./proof/gen/request_verdict.json')).json();
    const s = document.createElement('p');
    s.textContent = `Snapshot of request_verdict: ${g.result.statusName} / ${g.result.txExecutionResultName}.`;
    $('v-recorded').append(s);
  } catch { /* snapshot files are optional in the page */ }
}

$('v-refresh').addEventListener('click', () => { viewLive(); });
viewLive();

// "Try to break it": read-only eth_call / gen_call checks (src/breakit.mjs). No wallet, nothing sent.
const breakState = { busy: false };
function breakRow(check) {
  const tr = document.createElement('tr');
  tr.id = `break-${check.id}`;
  const a = document.createElement('td'); a.textContent = check.title;
  const w = document.createElement('small'); w.textContent = check.why; a.append(w);
  const h = document.createElement('td'); h.textContent = check.how;
  const o = document.createElement('td'); o.className = 'out pending'; o.textContent = 'waiting…';
  tr.append(a, h, o);
  return tr;
}
function showBreakResult(check, r) {
  const td = document.querySelector(`#break-${check.id} td.out`);
  if (!td) return;
  td.className = `out ${r.outcome}`;
  td.textContent = outcomeLabel(r.outcome);
  const d = document.createElement('small');
  d.textContent = r.reason ? `revert: ${r.reason}` : (r.detail || '');
  td.append(d);
}
async function runBreakIt() {
  if (breakState.busy) return;
  breakState.busy = true;
  $('break-run').disabled = true;
  $('break-rows').replaceChildren(...CHECKS.map(breakRow));
  $('break-status').className = 'pending';
  $('break-status').textContent = 'Running read-only checks against public Sepolia and Bradbury RPCs…';
  const rpcFor = (url) => async (method, params) => {
    const r = await withTimeout(fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), 15000, method);
    if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
    return r.json();
  };
  const reader = createClient({ chain: testnetBradbury, endpoint: BRADBURY.defaultGenlayerRpcUrl });
  const readFalseVerdict = async () => parseVerdict(await withTimeout(reader.readContract({ address: ADDR.falseCase, functionName: 'get_verdict', args: [] }), VIEW_TIMEOUT_MS, 'get_verdict'));
  try {
    const results = await runChecks({ rpcFor, readFalseVerdict, onResult: showBreakResult });
    const ok = results.filter((r) => PASS_OUTCOMES.includes(r.outcome)).length;
    const bad = results.filter((r) => r.outcome === 'unexpected').length;
    $('break-status').className = bad ? 'unexpected' : (ok === results.length ? 'refused' : 'error');
    $('break-status').textContent = `${ok} of ${results.length} checks behaved as expected${bad ? `, ${bad} unexpected` : ''}${ok + bad < results.length ? `, ${results.length - ok - bad} could not be checked` : ''} (${new Date().toLocaleTimeString()}, read-only).`;
    log('Try to break it: results (read-only eth_call / gen_call; nothing sent)', results);
  } catch (e) {
    $('break-status').className = 'error';
    $('break-status').textContent = `Checks could not run: ${e.message || e}`;
  } finally {
    breakState.busy = false;
    $('break-run').disabled = false;
  }
}
$('break-run').addEventListener('click', () => { runBreakIt(); });
runBreakIt();
