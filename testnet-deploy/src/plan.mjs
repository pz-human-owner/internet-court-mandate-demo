// Pure, network-free helpers for the testnet deploy page.
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
export function explorerAddress(addr, net = BRADBURY) { return `${net.explorerUrl}/address/${addr}`; }
