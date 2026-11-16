---
name: internet-court-verdict-gated-payment
description: Pay an AI agent through a MetaMask ERC-7710 delegation only after a GenLayer Internet Court jury rules its deliverable TRUE. Use when you want to read a MandateVerdict case on GenLayer Testnet Bradbury, deploy your own case, or build, sign and redeem a verdict-gated MetaMask Smart Accounts Kit delegation on Ethereum Sepolia, including the refusal paths.
---

# Internet Court verdict → MetaMask payment

A principal writes a mandate and binds the one evidence page a jury may read. An agent submits a deliverable. The
`MandateVerdict` Intelligent Contract on GenLayer has validators fetch that page and agree on `TRUE`, `FALSE` or
`UNDETERMINED`. A MetaMask smart account on Sepolia has signed one ERC-7710 delegation that can pay the agent a fixed
fee once, and a settlement account (the *clerk*) redeems it only when the verdict is a resolved `TRUE`.

```text
principal ──deploy(agent, mandate, guidelines, evidence_url)──▶ MandateVerdict (GenLayer Bradbury, 4221)
agent ──submit_deliverable(text, source_url)──▶ MandateVerdict
anyone ──request_verdict()──▶ validators fetch the bound page, agree on TRUE / FALSE / UNDETERMINED
principal's MetaMask smart account ──signs (off-chain)──▶ Delegation(clerk; cap, exact payment, clerk-only, once, expiry)
clerk ──get_verdict() (read-only)──▶ TRUE? ──redeemDelegations──▶ MetaMask DelegationManager (Sepolia) ──▶ agent paid
                                    else ──▶ no transaction; the delegation lapses at expiry
```

Everything below uses code that is in this repository. Live page:
https://pz-human-owner.github.io/internet-court-mandate-demo/

## Deployed and recorded

| What | Where | Value |
|---|---|---|
| MandateVerdict sample case (verdict `TRUE`) | GenLayer Testnet Bradbury, chain 4221 | [`0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B`](https://scan.testnet-chain.genlayer.com/address/0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B) |
| GenLayer node RPC (`gen_call`, receipts) | Bradbury | `https://rpc-bradbury.genlayer.com` |
| GenLayer chain RPC (wallet, `eth_*`) | Bradbury | `https://rpc.testnet-chain.genlayer.com` |
| DelegationManager (MetaMask's own deployment) | Ethereum Sepolia, chain 11155111 | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` |
| Principal's Hybrid smart account (throwaway) | Sepolia | `0x2d006AF0f603CA2C2a6b8f9689A20E1dc65FC976` |
| Payment run: deploy, fund, redeem | Sepolia | [`partner/metamask/live-result.json`](partner/metamask/live-result.json) |
| Refusal run: two reverted redemptions | Sepolia | [`partner/metamask/live-refusal-result.json`](partner/metamask/live-refusal-result.json) |
| Raw Bradbury receipts for the case | Bradbury | [`proof/`](proof/) |

## Setup

Node 20+. Python 3.11+ only for the optional contract tests.

```bash
git clone https://github.com/pz-human-owner/internet-court-mandate-demo && cd internet-court-mandate-demo
cd partner/metamask && npm ci && npm test        # offline: delegation shape, caveats, salt, settle() decisions, recorded runs
cd ../../testnet-deploy && npm ci && npm test    # offline: deploy-page guards, live-view helpers, panel content
```

## Workflow

### 1. Read a verdict (no wallet, nothing signed)

```bash
cd partner/metamask
node -e "import('./src/genlayer-verdict.mjs').then(async (m) => console.log(await m.makeVerdictReader('0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B')()))"
```

`get_verdict` returns JSON: `status` (`open`, `submitted` or `resolved`), `verdict` (`TRUE`, `FALSE`, `UNDETERMINED`
or empty), `reasoning`, `quote` (must appear in the fetched page), `source_url`, `last_error`, `attempts`. The contract
also has `get_case` and `get_status`. The live page reads any case with `?contract=0x…`.

### 2. Open your own case (real Bradbury transactions, your wallet)

The contract is [`contracts/MandateVerdict.py`](contracts/MandateVerdict.py). Its constructor takes
`(agent, mandate, guidelines, evidence_url, allow_subpaths)`; the sample inputs are in
[`examples/sample_mandate.json`](examples/sample_mandate.json).

```bash
cd testnet-deploy && npm ci && npm run build && npm run serve   # http://127.0.0.1:8787/
```

Open the page with MetaMask, expand **Optional: try it with MetaMask**, switch to Bradbury, then send deploy,
`submit_deliverable` and `request_verdict`. Each needs testnet GEN from the
[faucet](https://testnet-faucet.genlayer.foundation/) and shows a freshly estimated fee deposit before you confirm.
The page never asks for a seed phrase or a private key.

### 3. Build the verdict-gated delegation

```js
// run from partner/metamask
import { getSmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
import { buildPaymentDelegation, hashDelegation, SAMPLE_CASE } from './src/verdict-payment.mjs';

const environment = getSmartAccountsEnvironment(11155111);  // Sepolia DelegationManager + enforcers
const delegation = buildPaymentDelegation({
  environment,
  principal: '0x…',       // the principal's MetaMask Hybrid smart account
  clerk: '0x…',           // the only account allowed to redeem
  agent: '0x…',           // receives the fee on TRUE
  amountWei: 10n ** 15n,  // 0.001 ETH
  expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400,
  caseContract: SAMPLE_CASE, // the MandateVerdict address; becomes the salt (case label)
});
// sign with the principal's smart account: { ...delegation, signature: await principal.signDelegation({ delegation }) }
```

What the delegation carries, all checked on-chain by MetaMask's Delegation Framework at redemption:

| Caveat | Effect |
|---|---|
| `nativeTokenTransferAmount` scope | at most `amountWei` in total |
| `exactExecution` | the only call allowed is "send exactly `amountWei` to `agent`" |
| delegate = clerk, plus `redeemer` | nobody but the clerk can redeem |
| `limitedCalls: 1` | once |
| `timestamp` | only before `expiresAt` |

The salt is `keccak256("internet-court-mandate-verdict", 4221, caseContract)`. It names the case inside the signed
delegation, but no caveat checks it: the clerk's `settle()` does.

### 4. Settle

`settle()` in [`src/verdict-payment.mjs`](partner/metamask/src/verdict-payment.mjs) reads the expiry from the signed
Timestamp caveat, refuses a salt that does not match the case, reads `get_verdict`, and calls `sendTransaction` only on
`REDEEM`:

| Case state | Decision | Transaction |
|---|---|---|
| `resolved` + `TRUE`, before expiry | `REDEEM` | `DelegationManager.redeemDelegations` |
| `resolved` + `FALSE` or `UNDETERMINED` | `REFUSE` | none |
| not resolved | `WAIT` | none |
| past expiry | `EXPIRED` | none |
| salt bound to another case | `REFUSE` | none |

### 5. Run it

Rehearse on a local fork first (needs Foundry's `anvil`; broadcasts nothing; keys live in memory only):

```bash
cd partner/metamask
npm run simulate          # deploy, fund, sign, live Bradbury verdict, redeem; plus FALSE, outsider, second-redeem and expiry checks
```

Live on Sepolia, with fresh throwaway keys in `partner/metamask/.env` (gitignored; never commit it):

```bash
cd partner/metamask && set -a; . ./.env; set +a     # OWNER_KEY, CLERK_KEY, AGENT_ADDRESS (+ AGENT_KEY for the refusal run)
node scripts/live.mjs plan                # prints the transactions; sends nothing
node scripts/live.mjs grant --broadcast   # deploy the smart account, fund the fee, sign the delegation
node scripts/live.mjs settle --broadcast  # read the verdict; redeem only on TRUE
node scripts/refusal.mjs plan             # prints the refusal steps; sends nothing
node scripts/refusal.mjs run --broadcast  # clerk refusals (no tx) + two deliberately reverting redemptions
```

Without `--broadcast` both scripts refuse to send. The clerk pays the gas (about 0.02 Sepolia ETH covers a payment run).

## Verify

- Payment: the redeem tx [`0x64a3f537…`](https://sepolia.etherscan.io/tx/0x64a3f537451b275f12421f52fea886eb89dd666fbf9f9ee697a64d1f423b2e1f) moved 0.001 ETH from the smart account to the agent.
- Outsider: [`0x323887a0…`](https://sepolia.etherscan.io/tx/0x323887a077ab6f8be8226ab47f259f7a1b6562df2627db31f8ee5e592c33528b), the agent redeeming by itself, reverted with `InvalidDelegate`.
- Second redemption: [`0x28c9837c…`](https://sepolia.etherscan.io/tx/0x28c9837c4137efd47ef85cac8940499cb792dfbc53b8860d9a41b3f92755d640), the clerk re-using the paid delegation, reverted with `NativeTokenTransferAmountEnforcer:allowance-exceeded`.
- `LimitedCallsEnforcer.callCounts(DelegationManager, delegationHash)` reads how often a delegation was redeemed.
- `npm test` in `partner/metamask` re-checks both recorded runs against the code (hashes, salts, decoded revert data).

## Trust model and limits

- **The clerk is trusted for the verdict.** GenLayer and Sepolia have no oracle between them. The verdict check and the
  case match run in the clerk's code; a dishonest clerk could redeem on `FALSE`. It still could not pay anyone else, pay
  more, pay twice, or pay after expiry.
- **Not an escrow.** The fee stays in the principal's smart account until redemption; the owner can move it out first.
- **Live coverage.** On Sepolia: one paid redemption and two reverted ones. A live `FALSE` or `UNDETERMINED` verdict
  and an expired redemption are covered by the unit tests and the local fork, not on a public chain.
- **Testnets only.** Use throwaway keys. Never paste a seed phrase or private key into a page, a chat or a commit.
