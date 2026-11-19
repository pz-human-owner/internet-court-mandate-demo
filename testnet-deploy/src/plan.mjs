// Pure, network-free helpers for the demo page (read-only live view + optional MetaMask deploy).
// Everything that decides WHAT gets sent lives here so it can be unit tested
// without a wallet or an RPC. Sources for every constant are listed in README.md.

/** Bradbury Phase 2 facts from https://docs.genlayer.com/developers/networks (read Nov 15, 2026). */
export const BRADBURY = Object.freeze({
  chainId: 4221,
  chainIdHex: '0x107d',
  chainName: 'GenLayer Testnet Bradbury',
  nativeCurrency: { name: 'GEN', symbol: 'GEN', decimals: 18 },
  // EVM chain RPC (docs). MetaMask uses this one for eth_* and signing.
  chainRpcUrl: 'https://rpc.testnet-chain.genlayer.com',
  explorerUrl: 'https://scan.testnet-chain.genlayer.com',
  // GenLayer Explorer contract pages (the portal's named "GenLayer Explorer Contract" evidence type).
  contractExplorerUrl: 'https://scan.bradbury.genlayer.com',
  // Block-zero hash and AddressManager the docs say to verify before sending.
  genesisHash: '0x17d89764d4f4f963158fc4c5e8f2cb670c2837740b35f37081c12860c3df97e4',
  addressManager: '0x3F71AE080BD6270A91dBcc7960d88797828538E0',
  // GenLayer node RPC for gen_* methods. The docs do not print one; this host is the
  // one genlayer-js 1.1.8 ships for Bradbury and, probed read-only on Nov 15, 2026,
  // it answers gen_call and is at the same block height as the chain RPC.
  // Keep it editable in the page; replace it if GenLayer publishes another.
  defaultGenlayerRpcUrl: 'https://rpc-bradbury.genlayer.com',
  faucetUrl: 'https://testnet-faucet.genlayer.foundation/',
});

/** Params for wallet_addEthereumChain (EIP-3085). */
export function addChainParams(net = BRADBURY) {
  return {
    chainId: net.chainIdHex,
    chainName: net.chainName,
    nativeCurrency: net.nativeCurrency,
    rpcUrls: [net.chainRpcUrl],
    blockExplorerUrls: [net.explorerUrl],
  };
}

export function sameHex(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/** Throws unless the wallet chain id (hex or number) is Bradbury. */
export function assertBradburyChain(walletChainId, net = BRADBURY) {
  const n = typeof walletChainId === 'string' ? Number.parseInt(walletChainId, 16) : Number(walletChainId);
  if (n !== net.chainId) {
    throw new Error(`Wallet is on chain ${n}, expected ${net.chainId} (${net.chainName}). Switch networks first.`);
  }
}

/** Throws unless block zero matches the documented Phase 2 genesis. */
export function assertGenesis(blockZeroHash, net = BRADBURY) {
  if (!sameHex(blockZeroHash, net.genesisHash)) {
    throw new Error(`Genesis mismatch: got ${blockZeroHash}, expected ${net.genesisHash}. Stop: this RPC points at another deployment.`);
  }
}

/**
 * Constructor args for MandateVerdict, in contract order:
 * (agent: Address, mandate: str, guidelines: str, evidence_url: str, allow_subpaths: bool).
 * The deployer becomes the principal. With one wallet, agent === principal.
 */
export function constructorArgs({ agent, mandate, guidelines, evidence_url, allow_subpaths }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(agent || '')) throw new Error('agent must be a 0x address');
  for (const [k, v] of Object.entries({ mandate, guidelines, evidence_url })) {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`${k} is required`);
  }
  if (!evidence_url.startsWith('https://')) throw new Error('evidence_url must be https');
  if (typeof allow_subpaths !== 'boolean') throw new Error('allow_subpaths must be a boolean');
  return [agent, mandate, guidelines, evidence_url, allow_subpaths];
}

/** The planned transactions, in order. The page refuses to send anything not listed here. */
export const PLANNED_STEPS = Object.freeze([
  Object.freeze({ id: 'deploy', kind: 'deploy', label: 'Deploy MandateVerdict' }),
  Object.freeze({ id: 'submit', kind: 'write', functionName: 'submit_deliverable', label: 'Agent submits deliverable' }),
  Object.freeze({ id: 'verdict', kind: 'write', functionName: 'request_verdict', label: 'Request the verdict' }),
]);

/** Guard: each step at most once per page load, strictly in order. */
export function createStepGate(steps = PLANNED_STEPS) {
  const done = new Set();
  return {
    claim(id) {
      const i = steps.findIndex((s) => s.id === id);
      if (i < 0) throw new Error(`Unknown step ${id}`);
      if (done.has(id)) throw new Error(`Step ${id} already sent; reload only if you mean to send it again`);
      for (const prev of steps.slice(0, i)) {
        if (!done.has(prev.id)) throw new Error(`Step ${prev.id} must finish before ${id}`);
      }
      done.add(id);
    },
    release(id) { done.delete(id); },
    isDone(id) { return done.has(id); },
  };
}

/** Format wei (bigint) as GEN with 18 decimals, trimmed. */
export function formatGen(wei) {
  const v = BigInt(wei);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 10n ** 18n;
  const frac = (a % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''} GEN`;
}

/** L2 gas cost of an EVM receipt in wei: gasUsed * effectiveGasPrice. */
export function evmReceiptCost(receipt) {
  return BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
}

/**
 * Fetch a fresh fee/deposit estimate. On any failure, throw with
 * code FEE_ESTIMATE_ABORTED so the caller can abort the send, skip
 * the confirm dialog, and show a clear message.
 */
export async function liveFeesOrAbort(estimateFees) {
  let est;
  try {
    est = await estimateFees();
  } catch (e) {
    const detail = (e && (e.shortMessage || e.message)) || String(e);
    const err = new Error(`Could not re-estimate the live deposit; send aborted. ${detail}`);
    err.code = 'FEE_ESTIMATE_ABORTED';
    throw err;
  }
  if (est == null || est.feeValue == null) {
    const err = new Error('Could not re-estimate the live deposit; send aborted. estimate returned no feeValue');
    err.code = 'FEE_ESTIMATE_ABORTED';
    throw err;
  }
  return { distribution: est.distribution, feeValue: est.feeValue, policy: est.policy };
}

/** Confirm-dialog text that shows the live deposit just estimated. */
export function sendConfirmText(what, address, feeValue) {
  return `${what}\n\nThis sends a real Bradbury testnet transaction from ${address} with a fee deposit of up to ${formatGen(feeValue)} plus L2 gas. Continue?`;
}

/**
 * After a successful Estimate click, unlock the first send only once.
 * A later re-estimate must not advance or open the next send step.
 */
export function shouldUnlockAfterEstimate(alreadyEstimated) {
  return !alreadyEstimated;
}

export function explorerTx(hash, net = BRADBURY) { return `${net.explorerUrl}/tx/${hash}`; }
export function explorerAddress(addr, net = BRADBURY) { return `${net.contractExplorerUrl || net.explorerUrl}/address/${addr}`; }

// ---------------------------------------------------------------------------
// Read-only live view (no wallet). The page reads the already-deployed sample
// case with gen_call views only: get_status, get_verdict, get_case.
// ---------------------------------------------------------------------------

/** The sample case deployed on Bradbury (chain 4221) on Nov 15, 2026. See ../proof/. */
export const DEFAULT_CONTRACT = '0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B';

/** The read-only views the live view calls. None of them sends a transaction. */
export const VIEW_FUNCTIONS = Object.freeze(['get_status', 'get_verdict', 'get_case']);

export function isAddress(v) {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
}

/**
 * Which contract the live view reads: a valid ?contract=0x... in the page URL,
 * otherwise DEFAULT_CONTRACT. Anything malformed falls back to the default.
 */
export function viewContractAddress(search = '', fallback = DEFAULT_CONTRACT) {
  let q = null;
  try { q = new URLSearchParams(search).get('contract'); } catch { q = null; }
  if (isAddress(q)) return { address: q, isDefault: sameHex(q, fallback) };
  return { address: fallback, isDefault: true };
}

/** Case statuses returned by get_status and get_verdict.status. */
export const CASE_STATUS_OPEN = 'open';
export const CASE_STATUS_SUBMITTED = 'submitted';
export const CASE_STATUS_RESOLVED = 'resolved';

/**
 * Normalize a get_status result or a get_verdict / get_case object (or JSON
 * string) to the bare status string: open, submitted, or resolved.
 */
export function normalizeCaseStatus(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.status != null) {
    return String(raw.status).trim();
  }
  if (typeof raw !== 'string') return raw == null || raw === '' ? '' : String(raw).trim();
  const t = raw.trim();
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object' && !Array.isArray(o) && o.status != null) return String(o.status).trim();
    } catch { /* not a JSON object */ }
  }
  if (t.startsWith('"') && t.endsWith('"')) {
    try { return String(JSON.parse(t)).trim(); } catch { /* keep the trimmed string */ }
  }
  return t;
}

/**
 * Optional ?step= hint used only when on-chain status cannot be read.
 * Fail-closed (#124 round 6936737208): only an explicit `step=submit` or
 * `step=verdict` selects a step. Absent, empty or malformed values return
 * null, and the page then enables nothing.
 */
export function resumeStepParam(search = '') {
  let q = null;
  try { q = new URLSearchParams(search).get('step'); } catch { q = null; }
  return q === 'submit' || q === 'verdict' ? q : null;
}

/**
 * Which MetaMask send step to unlock when resuming an already-deployed
 * contract after Estimate. `status` is get_status (or get_verdict.status).
 * Previous steps are marked done on the one-shot gate so they cannot be
 * sent again; only the next unsent write is enabled.
 *
 * - open: no deliverable yet → claim deploy, enable submit
 * - submitted: deliverable in, no final verdict → claim deploy+submit, enable verdict
 * - resolved: verdict final → claim all three, enable nothing, show the verdict
 */
export function resumeFromStatus(status) {
  const s = normalizeCaseStatus(status);
  if (s === CASE_STATUS_OPEN) {
    return Object.freeze({
      status: s,
      claim: Object.freeze(['deploy']),
      enable: 'submit',
      showVerdict: false,
      log: 'Resume mode: contract already deployed, no deliverable submitted; only submit_deliverable is enabled',
    });
  }
  if (s === CASE_STATUS_SUBMITTED) {
    return Object.freeze({
      status: s,
      claim: Object.freeze(['deploy', 'submit']),
      enable: 'verdict',
      showVerdict: false,
      log: 'Resume mode: contract already deployed and deliverable submitted; only request_verdict is enabled',
    });
  }
  if (s === CASE_STATUS_RESOLVED) {
    return Object.freeze({
      status: s,
      claim: Object.freeze(['deploy', 'submit', 'verdict']),
      enable: null,
      showVerdict: true,
      log: 'Resume mode: contract already has a final verdict; no further send is enabled',
    });
  }
  throw new Error(`Resume: unknown case status ${JSON.stringify(status)}; not enabling any send step`);
}

/**
 * Map an explicit ?step= fallback (when get_status cannot be read) onto resumeFromStatus.
 * Throws for anything that is not an explicit `submit` or `verdict`, so no step is enabled.
 */
export function resumeFromStepParam(step) {
  if (step === 'submit') return resumeFromStatus(CASE_STATUS_OPEN);
  if (step === 'verdict') return resumeFromStatus(CASE_STATUS_SUBMITTED);
  throw new Error(`Resume: no explicit step ${JSON.stringify(step)}; not enabling any send step`);
}

/**
 * What to do when the read-only get_status call fails. Fail-closed: without an explicit
 * `&step=submit` or `&step=verdict` in the URL, nothing is enabled and nothing is claimed
 * (`action: null`), so Estimate can be retried. With an explicit step, only that step is enabled.
 */
export function resumeOnReadFailure(search = '', why = 'unknown error') {
  const step = resumeStepParam(search);
  if (!step) {
    return Object.freeze({
      action: null,
      log: `Resume: could not read get_status (${why}). No send step is enabled. Retry Estimate, or add &step=submit or &step=verdict to the URL to choose a step yourself (this is not on-chain state).`,
    });
  }
  return Object.freeze({
    action: resumeFromStepParam(step),
    log: `Resume: could not read get_status (${why}). Using the explicit URL step=${step}; this is not on-chain state.`,
  });
}

function parseJsonObject(raw, what) {
  let o = raw;
  if (typeof raw === 'string') {
    try { o = JSON.parse(raw); } catch { throw new Error(`${what} did not return JSON`); }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`${what} did not return an object`);
  return o;
}

const str = (v) => (v == null ? '' : String(v));

/** Normalize the JSON string returned by get_verdict. */
export function parseVerdict(raw) {
  const o = parseJsonObject(raw, 'get_verdict');
  return {
    status: str(o.status), verdict: str(o.verdict), reasoning: str(o.reasoning), quote: str(o.quote),
    source_url: str(o.source_url), last_error: str(o.last_error), attempts: Number(o.attempts ?? 0),
  };
}

/** Normalize the JSON string returned by get_case. */
export function parseCase(raw) {
  const o = parseJsonObject(raw, 'get_case');
  return {
    principal: str(o.principal), agent: str(o.agent), mandate: str(o.mandate), guidelines: str(o.guidelines),
    evidence_url: str(o.evidence_url), allow_subpaths: o.allow_subpaths === true, status: str(o.status),
    deliverable: str(o.deliverable), source_url: str(o.source_url), verdict: str(o.verdict),
    reasoning: str(o.reasoning), quote: str(o.quote), last_error: str(o.last_error), attempts: Number(o.attempts ?? 0),
  };
}

/**
 * Recorded result of the sample Bradbury run, shown only when the live read fails.
 * Transaction hashes and capture time: ../proof/README.md. Verdict and consensus:
 * root README. Reasoning and quote: get_verdict as read from DEFAULT_CONTRACT on
 * Nov 16, 2026 (the case is resolved, so these no longer change).
 */
export const RECORDED_RUN = Object.freeze({
  contract: DEFAULT_CONTRACT,
  capturedEt: 'Sunday, Nov 15, 2026, 10:37:56 PM ET',
  status: 'resolved',
  verdict: 'TRUE',
  consensus: 'MAJORITY_AGREE 4/5 (5 validators; 4 Agree, 1 Timeout)',
  reasoning: 'The deliverable accurately reflects the page: it mentions ERC-7710, states that the delegator configures a scope and optional caveats, and does not claim the delegate receives the private key. All mandate clauses are satisfied.',
  quote: 'The delegator creates a delegation, configuring a scope and optional caveats that define the conditions under which the delegation can be redeemed.',
  source_url: 'https://docs.metamask.io/smart-accounts-kit/concepts/delegation/overview/',
  txs: Object.freeze([
    Object.freeze({ step: 'deploy', evmHash: '0x5572f1d3140aa180df8dbe5df207ba1f9cbdff26c86651086b3e72b636509d09', proof: 'deploy.json' }),
    Object.freeze({ step: 'submit_deliverable', evmHash: '0x778a69fe0b8ffb3e7a80879cef6ea25aa65bee4cd9992a7b3cbbfba61350a9e7', proof: 'submit_deliverable.json' }),
    Object.freeze({ step: 'request_verdict', evmHash: '0x99f86115017d036dc1d2119ada7c8875cc79c5ef9532d705b9a352d764632e49', proof: 'request_verdict.json' }),
  ]),
});

/** Explorer links for the recorded run (used by the fallback view). */
export function recordedTxLinks(run = RECORDED_RUN, net = BRADBURY) {
  return run.txs.map((t) => ({ step: t.step, evmHash: t.evmHash, explorer: explorerTx(t.evmHash, net), proof: t.proof }));
}

/** Reject after ms, so a hung RPC drops the page into the fallback view. */
export function withTimeout(promise, ms, what = 'request') {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}
