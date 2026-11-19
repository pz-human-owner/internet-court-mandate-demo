---
name: internet-court-verdict-gated-payment
description: Pay an AI agent through a MetaMask ERC-7710 delegation only after a GenLayer Internet Court jury rules its deliverable TRUE. Use when you want to read a MandateVerdict case on GenLayer Testnet Bradbury, deploy your own case, or build, sign and redeem a verdict-gated MetaMask Smart Accounts Kit delegation on Ethereum Sepolia, including the refusal paths and an on-chain verdict gate (a custom caveat enforcer whose verdict is posted by a named, trusted carrier).
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
step 6: carrier ──reads finalized TRUE──▶ postVerdictTrue ──▶ VerdictGateEnforcer (Sepolia)
        agent ──redeemDelegations──▶ DelegationManager runs the gate caveat ──▶ paid only after the named carrier posted
```

Everything below uses code that is in this repository. Live page:
https://pz-human-owner.github.io/internet-court-mandate-demo/

## Deployed and recorded

| What | Where | Value |
|---|---|---|
| MandateVerdict sample case (verdict `TRUE`) | GenLayer Testnet Bradbury, chain 4221 | [`0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B`](https://scan.bradbury.genlayer.com/address/0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B) |
| GenLayer node RPC (`gen_call`, receipts) | Bradbury | `https://rpc-bradbury.genlayer.com` |
| GenLayer chain RPC (wallet, `eth_*`) | Bradbury | `https://rpc.testnet-chain.genlayer.com` |
| DelegationManager (MetaMask's own deployment) | Ethereum Sepolia, chain 11155111 | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` |
| Principal's Hybrid smart account (throwaway) | Sepolia | `0x2d006AF0f603CA2C2a6b8f9689A20E1dc65FC976` |
| Payment run: deploy, fund, redeem | Sepolia | [`partner/metamask/live-result.json`](partner/metamask/live-result.json) |
| Refusal run: an outsider's and a repeat redemption, both reverted | Sepolia | [`partner/metamask/live-refusal-result.json`](partner/metamask/live-refusal-result.json) |
| `VerdictGateEnforcer` (on-chain verdict gate caveat; source verified on [Sourcify](https://repo.sourcify.dev/11155111/0xfEf947Be0F73A95D2A29f156D5cDfC2692Da074a)) | Sepolia | [`0xfEf947Be0F73A95D2A29f156D5cDfC2692Da074a`](https://sepolia.etherscan.io/address/0xfEf947Be0F73A95D2A29f156D5cDfC2692Da074a) |
| On-chain check run: blocked before the verdict was posted, paid after | Sepolia | [`partner/metamask/live-onchain-check-result.json`](partner/metamask/live-onchain-check-result.json) |
| Raw Bradbury receipts for the case | Bradbury | [`proof/`](proof/) |
| Live FALSE case (`request_verdict` [`0x4b2b38cd…`](https://explorer-bradbury.genlayer.com/tx/0x4b2b38cd79433d25fde027dcf6de853f0a6339d3d170b9131abe0a13565e7127)) and its read-only Sepolia refusal check | Bradbury + Sepolia | [`0x51a2343c90192360199553B92C0D9Fe976D77662`](https://scan.bradbury.genlayer.com/address/0x51a2343c90192360199553B92C0D9Fe976D77662), [`partner/metamask/live-false-check-result.json`](partner/metamask/live-false-check-result.json) |

## Connector summary (Internet Court `genlayer-erc7710-connector` shape)

This section answers the eight items of the [GenLayer ERC-7710 Connector](https://github.com/internet-court/internet-court-skill/tree/main/integrations/genlayer-erc7710-connector) skill's output checklist, so the design can be compared with other Internet Court connectors line by line. It describes what is deployed and recorded now; nothing here is a new claim.

**Design rule.** GenLayer produces a decision; an EVM-side caveat enforcer consumes it. The effect path is spelled out below. GenLayer does not itself move or block the Sepolia payment.

1. **Connector mode and trust assumptions.** Two modes are shown:
   - *Manual demo relay* (steps 1-5): the clerk reads `get_verdict()` and redeems only on a resolved `TRUE`. The clerk is trusted to relay correctly.
   - *Trusted relayer* (step 6): a carrier named in the signed delegation reads the finalized `TRUE` and calls `postVerdictTrue` on `VerdictGateEnforcer`. The carrier is a trusted off-chain writer: on-chain rules limit *which* delegation it can unlock (this case, this carrier, once), not whether it is honest. No contract on Sepolia checks GenLayer itself.
   - Not used: Studio bridge, optimistic relay, verified bridge, direct EVM call.
2. **GenLayer decision source.** `MandateVerdict` (`contracts/MandateVerdict.py`) on GenLayer Testnet Bradbury (chain 4221). Methods: `request_verdict()` writes; `get_verdict()` / `get_status()` read. The decision enum is `TRUE` / `FALSE` / `UNDETERMINED` with `status` `open` / `submitted` / `resolved`. The decision is checked on the `request_verdict` receipt: `Finalized`, `FinishedWithReturn`, and the round result.
3. **Decision payload.** This demo does not use the full `GenLayerDelegationDecision` struct. The EVM side receives only a case key: `caseKey = keccak256(abi.encodePacked("internet-court-mandate-verdict", genlayerChainId, caseContract))`. That key is also the delegation salt. The carrier posts it with `postVerdictTrue(genlayerChainId, caseContract)`. Score, violations hash, evidence hash, `issuedAt` and `expiresAt` are not carried. Expiry is enforced by the delegation's own timestamp caveat.
4. **Relay, proof and finality path.** The carrier waits for `request_verdict` to be `Finalized` with `get_verdict().verdict == "TRUE"`, then sends one Sepolia transaction. There is no proof: Sepolia trusts the carrier's address, which the principal named in the signed terms.
5. **EVM controller interface.** `VerdictGateEnforcer` (`partner/metamask/contracts/src/VerdictGateEnforcer.sol`, [Sepolia `0xfEf9…074a`](https://sepolia.etherscan.io/address/0xfEf947Be0F73A95D2A29f156D5cDfC2692Da074a), Sourcify-verified):
   - `postVerdictTrue(genlayerChainId, caseContract)` records `verdictTrue[msg.sender][caseKey]`;
   - `caseKey(...)` is a pure view;
   - `beforeHook` requires `verdictTrue[carrier][key]`.
   There is no revoke or constrain method: the only effect is "unlock payment on TRUE".
6. **Where ERC-7710 redemption checks the controller.** As a caveat enforcer. MetaMask's `DelegationManager.redeemDelegations` calls `beforeHook` with the caveat terms `abi.encode(caseKey, carrier)`. Alongside it are MetaMask's stock caveats: exact payment, redeemer, one call, and a timestamp expiry.
7. **Decision-to-effect mapping.**
   - `TRUE` (finalized): the carrier posts; the agent can redeem once.
   - `FALSE` or `UNDETERMINED`: nothing is posted; every redemption reverts `verdict-not-true`; the delegation lapses at expiry.
   - Not resolved: same as `FALSE`.
   - The principal can always disable the delegation with MetaMask's own `disableDelegation`.
8. **Failure cases and tests.**

   | Failure case | Result | Evidence |
   |---|---|---|
   | Redeem before a verdict | Reverts | Live Sepolia T3 |
   | A different case's TRUE | Refused | Salt binding: unit test, and a break-it row |
   | A different carrier's TRUE | Refused | Unit test, and a break-it row |
   | Outsider redeem | Reverted | Live |
   | Second redemption | Reverted | Live |
   | FALSE case | Refused | Live Bradbury verdict; Sepolia refusal by `eth_call` simulation |
   | Duplicate post | Reverts `already-posted` | Foundry test |
   | Stale or expired delegation | Refused | Timestamp caveat: unit test |
   | Carrier outage | Fails closed: no payment | — |
   | Dishonest carrier | **Not mitigated** | — |

   The dishonest carrier is the main open item. A direct-call mode, where the Intelligent Contract posts to an enforcer on GenLayer Chain itself on finalization, would remove it and is being prototyped separately.

## Setup

Node 20+. Python 3.11+ only for the optional contract tests.

**Every command block in this file starts at the repository root** (the `internet-court-mandate-demo` folder the
clone creates). Blocks that need a subfolder `cd` into it in a subshell `( … )` or `cd` back with `cd ../..`, so you
can run them one after another.

```bash
git clone https://github.com/pz-human-owner/internet-court-mandate-demo && cd internet-court-mandate-demo
(cd partner/metamask && npm ci && npm test)   # offline: delegation shape, caveats, salt, settle() decisions, refusal gate, recorded runs
(cd testnet-deploy && npm ci && npm test)     # offline: deploy-page guards, live-view helpers, panel content
(cd partner/metamask && npm run test:contracts)   # needs Foundry: VerdictGateEnforcer unit tests + artifact reproducibility
```

## Workflow

### 1. Read a verdict (no wallet, nothing signed)

```bash
(cd partner/metamask && node -e "import('./src/genlayer-verdict.mjs').then(async (m) => console.log(await m.makeVerdictReader('0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B')()))")
```

`get_verdict` returns JSON: `status` (`open`, `submitted` or `resolved`), `verdict` (`TRUE`, `FALSE`, `UNDETERMINED`
or empty), `reasoning`, `quote` (must appear in the fetched page), `source_url`, `last_error`, `attempts`. The contract
also has `get_case` and `get_status`. The live page reads any case with `?contract=0x…`. After Estimate, that link also resumes the MetaMask send at the next unsent step from `get_status`.

### 2. Open your own case (real Bradbury transactions, your wallet)

The contract is [`contracts/MandateVerdict.py`](contracts/MandateVerdict.py). Its constructor takes
`(agent, mandate, guidelines, evidence_url, allow_subpaths)`; the sample inputs are in
[`examples/sample_mandate.json`](examples/sample_mandate.json).

```bash
(cd testnet-deploy && npm ci && npm run build && npm run serve)   # http://127.0.0.1:8787/ ; Ctrl-C stops it
```

Open the page with MetaMask, expand **Optional: try it with MetaMask**, switch to Bradbury, then send deploy,
`submit_deliverable` and `request_verdict`. Each needs testnet GEN from the
[faucet](https://testnet-faucet.genlayer.foundation/) and shows a freshly estimated fee deposit before you confirm.
The page never asks for a seed phrase or a private key.

### 3. Build the verdict-gated delegation

```js
// save as partner/metamask/my-delegation.mjs and run (from the repo root): node partner/metamask/my-delegation.mjs
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

What the delegation carries, all checked on-chain by MetaMask's Delegation Framework at redemption. The signed
delegation has six caveats, in this order (Sepolia enforcer addresses from `getSmartAccountsEnvironment(11155111)`;
the same six are in the payment and refusal runs; the on-chain check in step 6 adds a seventh):

| # | Caveat (enforcer) | Terms | Effect |
|---|---|---|---|
| 1 | `exactCalldata` ([`0x99F2…BdED`](https://sepolia.etherscan.io/address/0x99F2e9bF15ce5eC84685604836F71aB835DBBdED), ExactCalldataEnforcer) | `0x` | added by the `nativeTokenTransferAmount` scope: requires empty calldata; no function calldata (a plain ETH transfer) |
| 2 | `nativeTokenTransferAmount` ([`0xF71a…0320`](https://sepolia.etherscan.io/address/0xF71af580b9c3078fbc2BBF16FbB8EEd82b330320)) | `amountWei` | at most `amountWei` in total |
| 3 | `exactExecution` ([`0x1467…bfbb`](https://sepolia.etherscan.io/address/0x146713078D39eCC1F5338309c28405ccf85Abfbb)) | agent, `amountWei`, `0x` | the only call allowed is "send exactly `amountWei` to `agent`" |
| 4 | `redeemer` ([`0xE144…65c5`](https://sepolia.etherscan.io/address/0xE144b0b2618071B4E56f746313528a669c7E65c5)); the delegate is also the clerk | clerk | nobody but the clerk can redeem |
| 5 | `limitedCalls` ([`0x0465…5416`](https://sepolia.etherscan.io/address/0x04658B29F6b82ed55274221a06Fc97D318E25416)) | `1` | once |
| 6 | `timestamp` ([`0x1046…c069`](https://sepolia.etherscan.io/address/0x1046bb45C8d673d4ea75321280DB34899413c069)) | `0`, `expiresAt` | only before `expiresAt` |

Caveats 1 and 2 are what `scope: { type: NativeTokenTransferAmount }` expands to in Smart Accounts Kit 2.0.0
(`createNativeTokenTransferCaveatBuilder` adds `exactCalldata: 0x` when no calldata rule is given).

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
(cd partner/metamask && npm run simulate)   # deploy, fund, sign, live Bradbury verdict, redeem; plus FALSE, outsider, second-redeem and expiry checks
```

Live on Sepolia, with fresh throwaway keys in `partner/metamask/.env` (gitignored; never commit it):

```bash
(
  set -e
  cd partner/metamask
  set -a; . ./.env; set +a     # OWNER_KEY, CLERK_KEY, AGENT_ADDRESS (+ AGENT_KEY for the refusal run)
  node scripts/live.mjs plan                # prints the transactions; sends nothing
  node scripts/live.mjs grant --broadcast   # deploy the smart account, fund the fee, sign the delegation (writes signed-delegation.json)
  node scripts/live.mjs settle --broadcast  # read the verdict; redeem only on TRUE
  node scripts/refusal.mjs plan             # prints the refusal steps; sends nothing
  node scripts/refusal.mjs run --broadcast --out my-refusal-result.json   # clerk refusals (no tx) + two deliberately reverting redemptions
)
```

Without `--broadcast` both scripts refuse to send. **Who pays the gas:** in the payment run the clerk pays for all
three transactions (about 0.02 Sepolia ETH covers it). In the refusal run, R1 is sent and paid for by the agent's
throwaway key (`AGENT_KEY`), so the agent address needs a little Sepolia ETH (R1 cost 2,532,840 wei); the clerk pays
for R2. R2 re-uses the `signed-delegation.json` that `grant` wrote.

The refusal runner broadcasts R1 or R2 only after an `eth_call` simulation reverts with the expected decoded reason
(R1 `InvalidDelegate`; R2 `NativeTokenTransferAmountEnforcer:allowance-exceeded`, or
`LimitedCallsEnforcer:limit-exceeded`). Any other result, including an RPC error or rate limit, aborts before
sending. After mining it requires a `reverted` receipt and a parent-block replay with the same reason; otherwise it
exits non-zero and writes nothing. It never overwrites an existing result file.

### 6. Optional: put the verdict gate on-chain (trusted carrier)

[`VerdictGateEnforcer`](partner/metamask/contracts/src/VerdictGateEnforcer.sol) is a 71-line caveat enforcer for
MetaMask's Delegation Framework. A delegation that carries it can be redeemed only after the **carrier named in its
signed terms** has called `postVerdictTrue(4221, caseContract)` on the enforcer. Its terms are
`abi.encode(caseKey, carrier)`, and `caseKey` is the same value as the salt. The verdict gate and the case match
become chain rules, so the agent can be the delegate and redeem for itself. **The carrier is still trusted:** it is a
trusted off-chain writer (no contract on Sepolia checks GenLayer itself), trusted to post only a finalized `TRUE`. It
cannot post FALSE, change the amount, the recipient or any other limit, or post for another carrier.
A posted TRUE cannot be undone: after it, the principal's only remedies are `disableDelegation` or letting the
delegation expire. One post opens every delegation that names that carrier and that case; the once-only limit
(`limitedCalls`) is per delegation, not per case.

```js
// save as partner/metamask/my-gated.mjs and run (from the repo root): node partner/metamask/my-gated.mjs
import { getSmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
import { buildGatedDelegation, carrierDecision } from './src/verdict-gate.mjs';
import { SAMPLE_CASE } from './src/verdict-payment.mjs';

const delegation = buildGatedDelegation({
  environment: getSmartAccountsEnvironment(11155111),
  principal: '0x2d006AF0f603CA2C2a6b8f9689A20E1dc65FC976', // the principal's MetaMask Hybrid smart account
  agent: '0x8b5deeE4A52c321C81C33b2bC99834EB05B04929',     // delegate, only redeemer, and payee
  carrier: '0x906b4D9d64a5d4Bb559292A3f24562835a122D10',   // the only account whose verdict post counts
  gate: '0xfEf947Be0F73A95D2A29f156D5cDfC2692Da074a',      // VerdictGateEnforcer on Sepolia
  amountWei: 10n ** 15n,
  expiresAt: Math.floor(Date.now() / 1000) + 86400,
  caseContract: SAMPLE_CASE,
});
console.log(delegation.caveats.length, 'caveats; gate terms', delegation.caveats[2].terms);
// The carrier's rule before it calls postVerdictTrue: resolved TRUE and request_verdict Finalized.
console.log(carrierDecision({ verdictRaw: '{"status":"resolved","verdict":"TRUE"}', caseContract: SAMPLE_CASE,
  genReceipt: { recipient: SAMPLE_CASE, statusName: 'Finalized', txExecutionResultName: 'FinishedWithReturn' } }));
```

Run the whole flow on a local anvil fork first, then live. The runner sends five transactions (deploy, fund, a
blocked redemption, the carrier's post, the paid redemption) and refuses to send a sixth:

```bash
(
  set -e
  cd partner/metamask
  set -a; . ./.env; set +a     # OWNER_KEY, CLERK_KEY (also the carrier), AGENT_KEY
  node scripts/onchain-check.mjs plan
  node scripts/onchain-check.mjs rehearse --out my-onchain-rehearsal.json      # local anvil fork; nothing broadcast
  node scripts/onchain-check.mjs run --broadcast --out my-onchain-result.json  # five Sepolia transactions
)
```

Each step is sent only if its `eth_call` simulation shows the expected outcome. The blocked redemption must revert
with `VerdictGateEnforcer:verdict-not-true` and must succeed with `verdictTrue` overridden to TRUE (an `eth_call`
state override) in a simulation pinned at T2's block, so in that simulation the gate is the only obstacle (the record
names the block). Reads after each receipt are pinned to explicit blocks. Each send is journaled to
`<out>.journal.jsonl`: the sender's nonce before the send and the hash as soon as it returns, before any check. If a
check fails after a broadcast, the runner writes `<out>.incomplete.json` and exits. `run --broadcast --resume
<incomplete.json> --out <new.json>` continues only when the journal and the chain's nonces and receipts agree that
exactly T1 and T2 were sent and nothing is pending; T2 comes from the journal. Anything else is refused. An
incomplete record is single-use by content and run (a ledger in `~/.onchain-check/consumed-resumes`), so a second
resume, from a copy, a renamed file or after deleting a marker, is refused. Do not copy, rename or edit an incomplete
record, or delete its markers, to resume it again. This is local-scope protection only: the ledger is per machine, and
another machine or `ONCHAIN_CHECK_LEDGER_DIR` pointed at an empty directory bypasses it; the pinned-nonce check still
applies everywhere.
The agent pays the gas for its two redemptions, so the agent address needs a little Sepolia ETH.

## Verify

- Payment: the redeem tx [`0x64a3f537…`](https://sepolia.etherscan.io/tx/0x64a3f537451b275f12421f52fea886eb89dd666fbf9f9ee697a64d1f423b2e1f) moved 0.001 ETH from the smart account to the agent.
- Outsider: [`0x323887a0…`](https://sepolia.etherscan.io/tx/0x323887a077ab6f8be8226ab47f259f7a1b6562df2627db31f8ee5e592c33528b), the agent redeeming by itself, reverted with `InvalidDelegate`. The principal's smart account held 0 ETH during R1, so R1 shows the delegate (caller) check, not a funded payment being blocked.
- Second redemption: [`0x28c9837c…`](https://sepolia.etherscan.io/tx/0x28c9837c4137efd47ef85cac8940499cb792dfbc53b8860d9a41b3f92755d640), the clerk re-using the paid delegation, reverted with `NativeTokenTransferAmountEnforcer:allowance-exceeded`.
- On-chain gate, blocked: [`0x4ced2add…`](https://sepolia.etherscan.io/tx/0x4ced2add55d30f2207b0c50e77c75fb2cb55e4245e46be745afe3a616abba90d), the agent redeeming a funded gated delegation before any verdict was posted, reverted with `VerdictGateEnforcer:verdict-not-true`.
- On-chain gate, carrier post: [`0xfb9090a0…`](https://sepolia.etherscan.io/tx/0xfb9090a04b906512faf466c52a33c4c7ad4257429a1abf777723c6f3deac2423) emitted `VerdictTrue(carrier, caseKey, 4221, 0x07E2…2F8B)`.
- On-chain gate, paid: [`0xb5dd287b…`](https://sepolia.etherscan.io/tx/0xb5dd287b80fcb96bffefdbcaf1819652d92433ac78ad7032f7e9bf2be488955d), the same delegation redeemed by the agent, paid 0.001 ETH. `verdictTrue(carrier, caseKey)` on the enforcer reads `true`.
- `(cd partner/metamask && node scripts/onchain-check.mjs verify)` re-checks the on-chain run read-only: code equals the
  committed artifact, all five receipts, a parent-block replay of the blocked redemption, `verdictTrue`, and the
  Sourcify exact match. Like `refusal.mjs verify`, the replay needs an archive-capable `SEPOLIA_RPC_URL` once the
  blocks age out of the public RPC's recent-state window. Its 17 November 2026 (UTC) result is in `live-onchain-check-verify.json`.
- FALSE case: `(cd partner/metamask && OWNER_KEY=<throwaway owner key> node scripts/false-check.mjs check --case
  0x51a2343c90192360199553B92C0D9Fe976D77662 --request-txid
  0x4b2b38cd79433d25fde027dcf6de853f0a6339d3d170b9131abe0a13565e7127 --out <new.json>)` sends nothing. It records the
  `request_verdict` receipt (Finalized, MAJORITY_AGREE, each validator's vote), requires the carrier rule to refuse and
  `verdictTrue` to be false, and requires the agent's redemption `eth_call` to revert `verdict-not-true` as is and with
  only the principal funded, and to succeed only with `verdictTrue` also overridden. `--request-txid` is required unless
  you pass `--no-receipt`, which marks the output "receipt not checked". Recorded output:
  `partner/metamask/live-false-check-result.json`.
- `LimitedCallsEnforcer.callCounts(DelegationManager, delegationHash)` reads how often a delegation was redeemed.
- `npm test` in `partner/metamask` re-checks both recorded runs against the code (hashes, salts, decoded revert data).
- `(cd partner/metamask && SEPOLIA_RPC_URL=<an archive-capable Sepolia RPC> node scripts/refusal.mjs verify)` re-reads
  both refusal receipts and replays each at its parent block (read-only; no keys, sends nothing). The result of one such
  check is stored under `independentReverification` in the refusal record. The default public RPC refuses
  parent-block (archive) calls, and the script then fails instead of passing.

## Trust model and limits

- **The clerk is trusted for the verdict (steps 3–5).** Nothing on Sepolia checks GenLayer. The verdict check and the
  case match run in the clerk's code; a dishonest clerk could redeem on `FALSE`. It still could not pay anyone else, pay
  more, pay twice, or pay after expiry.
- **The carrier is trusted for the verdict (step 6).** With `VerdictGateEnforcer` the gate and the case match are checked
  on-chain, but whether the GenLayer verdict really is `TRUE` rests on the carrier named in the signed delegation. It is a
  trusted off-chain writer. A posted TRUE cannot be undone (the principal can only
  `disableDelegation` or let it expire), and one post opens every delegation naming that carrier and case. In the
  recorded run the carrier was the clerk's throwaway key, and one operator held every key.
- **Not an escrow.** The fee stays in the principal's smart account until redemption; the owner can move it out first.
- **Live coverage.** On Sepolia: one paid redemption, plus an outsider's redemption and a repeat redemption that both reverted, plus a gated redemption that was blocked before the verdict was posted and paid after. A live `FALSE` or `UNDETERMINED` verdict
  and an expired redemption are covered by the unit tests and the local fork, not on a public chain.
- **Testnets only.** Use throwaway keys. Never paste a seed phrase or private key into a page, a chat or a commit.
