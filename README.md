# Internet Court Mandate Demo

**Live demo (no wallet needed):** https://pz-human-owner.github.io/internet-court-mandate-demo/  
**Demo video (44 s):** [mission101_demo_v4s.mp4](https://github.com/pz-human-owner/internet-court-mandate-demo/releases/download/v1.2-demo/mission101_demo_v4s.mp4) on the [v1.2-demo release](https://github.com/pz-human-owner/internet-court-mandate-demo/releases/tag/v1.2-demo)  
**Reuse it:** [`SKILL.md`](SKILL.md), an agent skill that walks through reading a verdict, opening a case, and building, settling and refusing the MetaMask delegation

A principal writes a mandate, binds the evidence a jury may read, and appoints an agent. The agent submits a deliverable. A [GenLayer](https://docs.genlayer.com/) Intelligent Contract then acts as an [Internet Court](https://internetcourt.org/)-style jury: validators fetch a page at the submitted source URL and record whether the deliverable met the mandate.

The sample case binds official [MetaMask Smart Accounts Kit: Delegation](https://docs.metamask.io/smart-accounts-kit/concepts/delegation/overview/) documentation (HTTP 200, no redirect, checked 15 November 2026). The mandate asks for a short briefing that mentions ERC-7710, explains that the delegator configures a scope and optional caveats, and never claims that the delegate holds the delegator's private key.

**How MetaMask fits in, plainly:** two ways. (1) The jury reads MetaMask's official delegation documentation as its evidence, and MetaMask is the optional browser signer if you deploy your own copy of the contract. (2) [`partner/metamask/`](partner/metamask/) settles the case with the [MetaMask Smart Accounts Kit](https://docs.metamask.io/smart-accounts-kit/): the principal's MetaMask smart account signs an ERC-7710 delegation that can pay the agent a fixed fee once, and a settlement script redeems it only after the GenLayer contract returns TRUE. The delegation's limits are enforced on-chain by MetaMask's Delegation Framework. In the first two runs, the verdict check and the case match are done by that script, not by a contract, and in every run the fee is not locked in escrow (see [MetaMask delegation settlement](#metamask-delegation-settlement)). That flow has run live on Ethereum Sepolia against the real Bradbury verdict: the [redeem transaction](https://sepolia.etherscan.io/tx/0x64a3f537451b275f12421f52fea886eb89dd666fbf9f9ee697a64d1f423b2e1f) paid the agent 0.001 ETH. A second live run showed the refusals: an outsider's redemption and a second redemption both [reverted on Sepolia](#refusal-on-sepolia). A third run moved the verdict gate itself on-chain: a caveat enforcer on Sepolia [blocked the agent's redemption until the verdict was posted, then paid it](#on-chain-verdict-check-on-sepolia). The account that posts the verdict is named in the signed delegation and is still trusted: a trusted off-chain writer. MetaMask is listed in the Founding Partners section of [internetcourt.org](https://internetcourt.org/). This project is not endorsed by MetaMask.

## Live demo

Hosted page: **https://pz-human-owner.github.io/internet-court-mandate-demo/** (served by GitHub Pages from `testnet-deploy/` via [`.github/workflows/pages.yml`](.github/workflows/pages.yml) on every push to `main`).

- **View the live verdict (default, no wallet).** On load the page reads the deployed sample case, contract [`0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B`](https://scan.testnet-chain.genlayer.com/address/0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B) on Bradbury, with read-only `gen_call` views (`get_status`, `get_verdict`, `get_case`) and shows the mandate, deliverable, verdict, reasoning, supporting quote, and explorer links. Nothing is signed or sent. If the RPC cannot be reached, the page says so and shows the recorded result of the Nov 15 run with links to the [`proof/`](proof/) receipts and the explorer. Add `?contract=0x…` to read a different MandateVerdict contract. The MetaMask section uses that link to resume at the next unsent step, chosen from a read-only `get_status` call.
- **Try it with MetaMask (optional).** A collapsed section deploys your own copy from your own MetaMask wallet. It sends real Bradbury testnet transactions and needs testnet GEN; see [Deploy on Bradbury](#deploy-on-bradbury).

To run the same page locally: `cd testnet-deploy && npm ci && npm run build && npm run serve`, then open http://127.0.0.1:8787/.

## What it does

1. A **principal** creates the case: a written **mandate**, **guidelines**, and the **evidence URL** the jury may read. The binding is either an exact URL or, with `allow_subpaths=True`, an origin plus a path prefix.
2. An appointed **agent** submits a **deliverable** and a source URL. The contract rejects any submitted URL outside that binding. That is not a guarantee the jury will read only a page the principal intended: see [Evidence-URL policy](#evidence-url-policy) and [Limitations](#limitations).
3. Either party requests a verdict. The contract fetches the submitted source URL and records **TRUE**, **FALSE**, or **UNDETERMINED**, with short reasoning and a supporting quote that must match the fetched page after case-folding and whitespace normalization.

### How GenLayer is used

`request_verdict` runs a leader and validators through `gl.vm.run_nondet`:

- **Leader:** fetches the page (`gl.nondet.web.render`), asks the model for strict JSON `{verdict, reasoning, quote}`, validates the schema, and checks that its own quote matches the page it fetched under the rule in [Quote matching](#quote-matching-and-page-window).
- **Validator:** rejects a malformed leader result, fetches the page itself, checks the leader's quote against *its own* fetch (TRUE/FALSE only, same matching rule), re-runs the judgement, and agrees only when the outcome and the verdict match. Reasoning text and quote wording may differ. That is the [Equivalence Principle](https://docs.genlayer.com/developers/intelligent-contracts/equivalence-principle) applied to a qualitative decision, plus a deterministic grounding check.

Verdict vocabulary follows [genlayer-foundation/internetcourt](https://github.com/genlayer-foundation/internetcourt) and the [Internet Court skill](https://internetcourt.org/skill.md).

### Outcomes

| Outcome | Case status | Meaning |
|---|---|---|
| `TRUE` / `FALSE` | `resolved` | Evidential verdict, with a quote that matches the fetched page after case-folding and whitespace normalization. |
| `UNDETERMINED` | `resolved` | Evidential verdict: the page was read but is insufficient or conflicting. |
| `FETCH_ERROR` | stays `submitted` | Page could not be retrieved, or had no text. `last_error` and `attempts` are recorded; `request_verdict` can be called again. |
| `MODEL_ERROR` | stays `submitted` | Model output failed schema validation, or its quote did not match the page under the rule above. Retryable. |

Operational failures are never stored as a verdict.

### Evidence-URL policy

- URLs are parsed by a strict parser (not substring bans): `https` only; no userinfo; port 443 only; host must be a domain name (IP literals and single-label hosts like `localhost` are rejected); no fragments; no `.`/`..` segments; no encoded separators (`%2e`, `%2f`, `%5c`, `%00`); printable ASCII only. Host case and an explicit `:443` are normalized.
- **Exact binding:** the normalized submitted URL must equal the bound URL.
- **Prefix binding** (`allow_subpaths=True`): same host; path equals the prefix or continues it on a `/` boundary (`/kit` does not match `/kit-evil`); no query strings. The agent may therefore submit any same-host path under that prefix, including a page it controls there.
- **Redirects are followed outside the contract.** The check above applies only to the URL the agent submits. `gl.nondet.web.render` follows HTTP redirects itself (it re-checks TLD/port on each hop and refuses HTTPS→HTTP downgrades, per the [GenVM web module spec](https://sdk.genlayer.com/main/impl-spec/01-core-architecture/03-modules/01-web.html)) and does not return the final URL. A submitted URL that passes the binding can still resolve to a different page, including one the agent controls, if that page is the redirect target. The contract cannot detect this.

The sample case uses exact binding (`allow_subpaths=False`) and a URL that returned HTTP 200 with no redirect when checked on 15 November 2026. That is procedural mitigation, not a contract-level guarantee.

### Quote matching and page window

These rules are in `contracts/MandateVerdict.py` (`_normalize_ws`, `_quote_in_page`, `_build_prompt`, `MAX_PAGE_CHARS = 12000`):

- A quote is **not** checked as verbatim, case-sensitive text. The contract collapses any whitespace to single spaces and compares with Unicode case folding (`casefold()`). For TRUE/FALSE, the normalized quote must be at least 12 characters and a substring of the normalized fetched page. The model is prompted to copy verbatim text; the enforcement is this normalized match.
- Only the first 12,000 characters of the page, after fence-marker stripping, are placed in the model prompt. The quote-grounding check itself runs against the full fetched page text, not only that window.

## MetaMask delegation settlement

[`partner/metamask/`](partner/metamask/) turns the verdict into a payment decision with the [MetaMask Smart Accounts Kit](https://docs.metamask.io/smart-accounts-kit/) (`@metamask/smart-accounts-kit` 2.0.0, [delegation guide](https://docs.metamask.io/smart-accounts-kit/guides/delegation/execute-on-smart-accounts-behalf/)).

1. **Fund.** The principal has a MetaMask Hybrid smart account on Ethereum Sepolia holding the agent's fee (0.001 ETH in the demo). This is not an escrow: the fee stays in the principal's own account, and the owner could move it out before redemption, in which case the redemption reverts and the agent is not paid.
2. **Grant.** The principal signs one ERC-7710 delegation (EIP-712, off-chain) to a settlement account, the *clerk*. These caveats are checked on-chain by MetaMask's Delegation Framework at redemption:
   - [`nativeTokenTransferAmount`](https://docs.metamask.io/smart-accounts-kit/guides/delegation/use-delegation-scopes/spending-limit/) scope: at most the fee, in total
   - [`exactExecution`](https://docs.metamask.io/smart-accounts-kit/reference/delegation/caveats/): the only allowed call is "send exactly the fee to the agent"
   - `redeemer`: only the clerk may redeem
   - `limitedCalls`: once
   - `timestamp`: only before the expiry. The live runner sets 7 days by default (`EXPIRY_DAYS`); the delegation builder accepts any expiry and doesn't enforce a length.

   **Case label, checked off-chain only:** the delegation's salt is derived from the GenLayer case (chain 4221 + the MandateVerdict address). It changes the delegation hash, so the signed delegation names its case, but no caveat checks it. Only the clerk's `settle()` code refuses a delegation whose salt doesn't match the case it's settling.
3. **Settle.** The clerk reads `get_verdict` from the Bradbury contract (read-only `gen_call`). Resolved **TRUE**: it calls `DelegationManager.redeemDelegations` and the agent is paid. **FALSE** or **UNDETERMINED**: it refuses, and the delegation lapses at expiry. The principal can also revoke it early with [`disableDelegation`](https://docs.metamask.io/smart-accounts-kit/guides/delegation/disable-delegation/); the calldata is built in the code, but sending it needs a bundler and is not wired up. Not resolved yet: it waits.

**What is enforced where.** GenLayer and Sepolia are separate chains, and nothing on Sepolia checks GenLayer. Two things are left to the clerk's code, so the clerk is a trusted party:
- reading and honoring the verdict
- matching the delegation to its case (the salt check)

MetaMask's caveat enforcers check these on-chain:
- only the clerk can redeem
- it can redeem only once, and only before the expiry
- the only possible payment is the exact fee to the named agent

The chain doesn't guarantee that the fee is still there; see step 1. A dishonest clerk could pay the agent on a FALSE verdict, or for the wrong case. It could not pay anyone else, pay more, or pay twice.

The [on-chain verdict check](#on-chain-verdict-check-on-sepolia) below moves both clerk checks into a Sepolia caveat for a new delegation. Whether the GenLayer verdict really is TRUE still rests on a named carrier.

**What has been run.** `npm run simulate` starts a local [anvil](https://book.getfoundry.sh/anvil/) fork of Ethereum Sepolia, which includes MetaMask's deployed DelegationManager and enforcers. It uses throwaway keys that live only in memory and broadcasts nothing to any public network. Then it:
- deploys the principal's smart account through `SimpleFactory`
- funds it
- signs the delegation
- reads the **real** verdict from Bradbury (TRUE) and redeems, so the agent receives exactly 0.001 ETH
- checks that a mocked FALSE verdict is refused without sending anything
- checks that an outsider's redemption, a second redemption, and a redemption after expiry all revert on-chain (the first two have since also reverted on public Sepolia; see [Refusal on Sepolia](#refusal-on-sepolia))

The recorded output is in [`partner/metamask/sim-result.json`](partner/metamask/sim-result.json).

### Live run on Sepolia

On 16 November 2026 (20:38–20:39 UTC) the flow ran on public Ethereum Sepolia with throwaway testnet keys. The clerk read the real Bradbury verdict for [`0x07E2…2F8B`](https://scan.testnet-chain.genlayer.com/address/0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B), got `resolved` / **TRUE**, and redeemed the delegation. All keys were throwaway testnet keys, and the same operator held both the OWNER and CLERK keys (in this run the agent was only a receiving address; the refusal run below also used its throwaway key). To keep the demo to one funded account, the clerk paid the gas for all three transactions and also sent the 0.001 ETH fee into the principal's smart account (step B). In real use the principal would fund their own account. The full record, with hashes, blocks, addresses, the delegation hash, caveat enforcers and a raw `get_verdict` response (from a read-only call made after the run), is in [`partner/metamask/live-result.json`](partner/metamask/live-result.json).

| Step | Transaction | Block | Result |
|---|---|---|---|
| A. Deploy the principal's MetaMask Hybrid smart account [`0x2d00…C976`](https://sepolia.etherscan.io/address/0x2d006AF0f603CA2C2a6b8f9689A20E1dc65FC976) via SimpleFactory | [`0x0897bcff…`](https://sepolia.etherscan.io/tx/0x0897bcffcc2afd00de69936ab89de6613c4fc1bccb8b2b4130c4092ea79ca51a) | 12149738 | success |
| B. Fund the smart account with the 0.001 ETH fee | [`0xef5104a4…`](https://sepolia.etherscan.io/tx/0xef5104a490e68ae7078b396beaab9080922301fdf2caad69da0aed27218881c3) | 12149739 | success |
| – Owner signs the ERC-7710 delegation off-chain (hash `0xd76ec7fb…8187`) | no transaction | – | – |
| C. The clerk [`0x906b…2D10`](https://sepolia.etherscan.io/address/0x906b4D9d64a5d4Bb559292A3f24562835a122D10) reads verdict TRUE and calls `DelegationManager.redeemDelegations` | [`0x64a3f537…`](https://sepolia.etherscan.io/tx/0x64a3f537451b275f12421f52fea886eb89dd666fbf9f9ee697a64d1f423b2e1f) | 12149741 | success; agent [`0x8b5d…4929`](https://sepolia.etherscan.io/address/0x8b5deeE4A52c321C81C33b2bC99834EB05B04929) went from 0 to 0.001 ETH |

### Refusal on Sepolia

Later the same day (22:52–22:53 UTC, 5:52–5:53 PM ET) a second run on public Sepolia, [`scripts/refusal.mjs`](partner/metamask/scripts/refusal.mjs), checked that payment is refused when it should be. Same throwaway accounts; two transactions, both deliberately reverting, sent with a fixed 400,000 gas limit so they would be mined (a gas estimate refuses a call that reverts). Before each send that run simulated the call with `eth_call` and refused to send if it would succeed; both simulations decoded to the expected reasons, and replaying each mined transaction at its parent block gives the same revert. The script's gate has since been tightened: it now sends only if the simulation reverts with the *expected* decoded reason (any RPC error or other reason aborts), and after mining it requires a `reverted` receipt and a matching parent-block replay, or it exits non-zero and writes nothing. A read-only `node scripts/refusal.mjs verify` re-checked both mined transactions with that code on 16 November 2026 (`independentReverification` in the record). The full record is in [`partner/metamask/live-refusal-result.json`](partner/metamask/live-refusal-result.json).

| Step | Transaction | Block | Result |
|---|---|---|---|
| – The owner signs a fresh delegation (hash `0xa27cd9c3…340f`, one-hour expiry) whose salt binds it to a different case, `0xb773…c635`, where no MandateVerdict is deployed. The clerk's `settle()` checks it against the sample case, whose live verdict is TRUE | no transaction | – | refused by the clerk's code: `delegation salt does not match this GenLayer case`. Settling it against its own case sent nothing either (no readable verdict) |
| R1. The agent [`0x8b5d…4929`](https://sepolia.etherscan.io/address/0x8b5deeE4A52c321C81C33b2bC99834EB05B04929) tries to redeem that fresh delegation itself, skipping the clerk | [`0x323887a0…`](https://sepolia.etherscan.io/tx/0x323887a077ab6f8be8226ab47f259f7a1b6562df2627db31f8ee5e592c33528b) | 12150397 | reverted: DelegationManager `InvalidDelegate` (only the delegation's delegate, the clerk, may redeem; this check runs before the `redeemer` caveat) |
| R2. The clerk tries to redeem the delegation already paid in step C a second time | [`0x28c9837c…`](https://sepolia.etherscan.io/tx/0x28c9837c4137efd47ef85cac8940499cb792dfbc53b8860d9a41b3f92755d640) | 12150399 | reverted: `NativeTokenTransferAmountEnforcer:allowance-exceeded` (the 0.001 ETH cap is used; the `limitedCalls` count was already 1 and stayed 1) |

The agent paid R1's gas (about 2.5 million wei) from the fee it had received; the clerk paid R2's. No ETH moved in either transaction, and the principal's smart account held 0 ETH throughout, so nothing could have been paid under the fresh delegation: R1 shows the delegate (caller) check, not a funded payment being blocked.

**What is now live and what is still not.** An outsider redemption and a second redemption have reverted on public Sepolia. A live FALSE or UNDETERMINED verdict has not: the only deployed case resolved TRUE, and no new GenLayer transactions were made, so those paths, and a redemption after expiry, are still covered only by the unit tests and the local fork. The clerk refusal in this run is a case-label mismatch decided by the clerk's code, not by a contract.

### On-chain verdict check on Sepolia

The two runs above leave the verdict gate and the case label to the clerk's code. A third run on 16 November 2026 (7:14–7:18 PM ET; 00:14–00:18 UTC on 17 November) moved both into a caveat that MetaMask's DelegationManager runs on-chain at redemption. The caveat is [`VerdictGateEnforcer`](partner/metamask/contracts/src/VerdictGateEnforcer.sol), 71 lines of Solidity with no owner, admin, upgrade or pause function. It was compiled with pinned solc 0.8.23 (optimizer, 200 runs) and deployed at [`0xfEf9…074a`](https://sepolia.etherscan.io/address/0xfEf947Be0F73A95D2A29f156D5cDfC2692Da074a). Its source is verified on [Sourcify](https://repo.sourcify.dev/11155111/0xfEf947Be0F73A95D2A29f156D5cDfC2692Da074a) (exact match, creation and runtime).

How it works:
- **Terms.** The caveat's terms are `abi.encode(caseKey, carrier)`, signed by the principal as part of the delegation. `caseKey` is the same case label as the salt: `keccak256(abi.encodePacked("internet-court-mandate-verdict", 4221, MandateVerdict address))`. `carrier` is the one account whose verdict post counts for this delegation.
- **The gate.** `beforeHook` reverts with `VerdictGateEnforcer:verdict-not-true` unless `verdictTrue[carrier][caseKey]` is set.
- **Posting.** `postVerdictTrue(genlayerChainId, caseContract)` records TRUE for `msg.sender` only. It computes the case key on-chain from the GenLayer chain id and contract address, emits `VerdictTrue`, and cannot be repeated or undone. There is no way to post FALSE, so deny is the default: on Sepolia, a FALSE case looks the same as one that was never posted.
- **Who redeems.** The delegation goes straight to the agent, which is its delegate and only `redeemer`. The other caveats are unchanged: amount cap, exact payment to the agent, once, expiry (one day).

**Who is still trusted.** The carrier is a trusted off-chain writer. No contract on Ethereum Sepolia checks GenLayer itself: it is trusted to post TRUE only after reading a finalized TRUE verdict, and no contract on Sepolia checks that it did. The runner posts only when `get_verdict` returns `resolved` / `TRUE` and the case's `request_verdict` transaction is `Finalized` with `FinishedWithReturn` (both read-only GenLayer calls).

What the chain now guarantees is narrower trust:
- the carrier is named in the signed delegation;
- it can open only this case, and only for delegations that name it;
- it cannot change the amount, the recipient or any other limit, and cannot undo a post;
- anyone can compare its post with the public `get_verdict`.

A posted TRUE cannot be undone. After it, the principal's only remedies are to disable the delegation (`disableDelegation`) or let it expire. One post opens every delegation that names that carrier and that case: the once-only limit (`limitedCalls`) is per delegation, not per case.

In this demo the carrier is the clerk's throwaway key, and the same operator held every key.

| Step | Transaction | Block | Result |
|---|---|---|---|
| T1. The clerk deploys `VerdictGateEnforcer` | [`0x159d965f…`](https://sepolia.etherscan.io/tx/0x159d965f9ec998527090f4db4be6b52cba3c30914a0770eb7d09f9ec2ceae181) | 12150800 | success; on-chain runtime code equals the committed pinned artifact |
| – The owner signs a delegation (hash `0xd4e773de…36e6`) from the principal's smart account [`0x2d00…C976`](https://sepolia.etherscan.io/address/0x2d006AF0f603CA2C2a6b8f9689A20E1dc65FC976) straight to the agent, with the verdict gate as caveat 3 of 7: this case, and carrier = the clerk [`0x906b…2D10`](https://sepolia.etherscan.io/address/0x906b4D9d64a5d4Bb559292A3f24562835a122D10) | no transaction | – | – |
| T2. The clerk funds the smart account with the 0.001 ETH fee | [`0x15aaf077…`](https://sepolia.etherscan.io/tx/0x15aaf077f0459bee10c4e3665e2bbe31cfc594c348eb629a6c677359a3439f3f) | 12150801 | success |
| T3. The agent [`0x8b5d…4929`](https://sepolia.etherscan.io/address/0x8b5deeE4A52c321C81C33b2bC99834EB05B04929) redeems before any verdict is posted on Sepolia | [`0x4ced2add…`](https://sepolia.etherscan.io/tx/0x4ced2add55d30f2207b0c50e77c75fb2cb55e4245e46be745afe3a616abba90d) | 12150817 | reverted: `VerdictGateEnforcer:verdict-not-true`; the funded fee stayed put |
| T4. The clerk, as carrier, reads the finalized TRUE verdict and calls `postVerdictTrue(4221, 0x07E2…2F8B)` | [`0xfb9090a0…`](https://sepolia.etherscan.io/tx/0xfb9090a04b906512faf466c52a33c4c7ad4257429a1abf777723c6f3deac2423) | 12150818 | success; `VerdictTrue` event for this case |
| T5. The agent redeems the same delegation itself | [`0xb5dd287b…`](https://sepolia.etherscan.io/tx/0xb5dd287b80fcb96bffefdbcaf1819652d92433ac78ad7032f7e9bf2be488955d) | 12150819 | success; the smart account paid exactly 0.001 ETH to the agent; `limitedCalls` count 1 |

**How each step was checked.** Before anything was broadcast, the full flow was rehearsed on a local anvil fork of Sepolia; the fork's gas figures matched the live run to within 0.01%. Each live step was sent only if an `eth_call` simulation showed the expected outcome:
- **T1:** the creation code returned exactly the committed runtime bytecode.
- **T3:** the call reverted with `verdict-not-true`, *and* the same call with `verdictTrue` overridden to TRUE (an `eth_call` state override) succeeded. That was a simulation pinned at block 12150801 (T2's block, the state after T2), not a trace of the mined T3 at 12150817: in that pinned simulation, the gate was the only obstacle. `verify` re-ran both calls at 12150801, read-only, with the same result.
- **T4:** the call returned the expected case key.
- **T5:** the call succeeded.

After mining, the runner checked:
- the on-chain code equals the artifact;
- T3's receipt is `reverted`, and a replay at its parent block gives the same reason;
- the `VerdictTrue` event and the storage slot are set;
- the smart account paid exactly the fee, and the agent received the fee minus its own gas.

The runner caps itself at five transactions and never overwrites a record. The clerk paid T1, T2 and T4; the agent paid T3 and T5. Sepolia gas cost about 16 wei per unit at the time, so all five fees together came to 58,960,511 wei (about 0.00000006 ETH).

**One abort, recorded.** The first attempt stopped after T2. A load-balanced public RPC node had returned the smart account's balance from a block before T2, which had in fact succeeded. The runner wrote what it had sent to an incomplete record and exited. A resume mode was then rehearsed on a fork and run live. It re-verified T1 and T2 on-chain, counted them against the same five-transaction budget, reused the delegation signed in the first attempt, and pinned every later read and simulation to an explicit block. Details are under `resumedFrom` in the record. Nonces (read-only, re-checked by `verify`): between the block before T1 and T5's block the clerk's nonce went 4 → 7 and the agent's 1 → 3, so exactly five transactions from these accounts were mined in that interval, the five in the record. The agent's nonce was still 1 at block 12150816, after T2, so no agent transaction was mined before the recorded T3. Nonces show only what was mined, not what was broadcast. That no T3 was broadcast before the abort rests on the run log and the code order: the first run threw at the T2 balance check, which comes before the T3 simulation and send, and its console log ([`live-onchain-check-run1.console.log`](partner/metamask/live-onchain-check-run1.console.log), committed verbatim) shows T1 and T2 sent and no T3. 

Since then, review on #124 found that the older resume path could not tell "T3 never sent" from "T3 sent but not yet recorded" (not what happened here; see the run log and nonces above). The runner now journals each transaction's nonce before it is sent and its hash as soon as the send returns, before any check. A resume is allowed only when that journal and the chain's nonces and receipts agree that exactly T1 and T2 were sent and nothing is pending. It takes T2 from the journal, not the command line, and refuses anything else. Rehearsed on anvil forks: a crash after sending T3, and an unexplained clerk or agent nonce, are each refused.

Records:
- [`partner/metamask/live-onchain-check-result.json`](partner/metamask/live-onchain-check-result.json);
- a read-only re-check, including the Sourcify lookup: [`live-onchain-check-verify.json`](partner/metamask/live-onchain-check-verify.json) (`node scripts/onchain-check.mjs verify`).

Still not shown:
- a carrier and an agent run by different people;
- verification on Etherscan's own verifier, which needs an account (Sourcify only).

### Live FALSE verdict on Bradbury
On 16 November 2026, about 9:56 PM ET (02:56 UTC on 17 November), a second case ran on GenLayer Testnet Bradbury and resolved **FALSE**. The case contract is [`0x51a2343c90192360199553B92C0D9Fe976D77662`](https://scan.testnet-chain.genlayer.com/address/0x51a2343c90192360199553B92C0D9Fe976D77662). Its deliverable said the delegate holds the delegator's private key and that scope and caveats are only suggestions. The jury quoted [MetaMask's delegation overview](https://docs.metamask.io/smart-accounts-kit/concepts/delegation/overview/): "The delegator creates a delegation, configuring a scope and optional caveats that define the conditions under which the delegation can be redeemed."

| Step | GenLayer transaction | EVM hash | Result |
|---|---|---|---|
| Deploy the case | [`0x6829b715…9260`](https://explorer-bradbury.genlayer.com/tx/0x6829b7152b048029102448a6efec269738650e6991ede3b8697396dac2579260) | [`0x5ad88e8a…85f2`](https://scan.testnet-chain.genlayer.com/tx/0x5ad88e8af64f0b2316c69e58cdf599f75429b72f65e1120528384a17154285f2) | Finalized |
| `submit_deliverable` | [`0x1bff12f7…31d7`](https://explorer-bradbury.genlayer.com/tx/0x1bff12f7ef76bf094dc533ed0f4570fff6b6eab52c3e523d32f42a670b6931d7) | [`0x1deacb11…237f`](https://scan.testnet-chain.genlayer.com/tx/0x1deacb11dcae3909a958a20da950618c132d637693381e88bd41306e39b9237f) | Finalized, MAJORITY_AGREE |
| `request_verdict` | [`0x4b2b38cd…7e127`](https://explorer-bradbury.genlayer.com/tx/0x4b2b38cd79433d25fde027dcf6de853f0a6339d3d170b9131abe0a13565e7127) | [`0x02dc4fb3…1900`](https://scan.testnet-chain.genlayer.com/tx/0x02dc4fb3898e1db9eb2a3636fb1051a95216e86e25a39674e1e9821c3a5d1900) | Finalized, `FinishedWithReturn`; round 0 MAJORITY_AGREE (5 validators: 4 matched the leader's result, 1 timed out); `get_verdict`: resolved, FALSE, attempts 1 |

The three transactions were sent from one wallet, `0x0F21F8a024Dd2448A53e4763b23cc64Ee939dFC4`, through the MetaMask page above. Nothing was sent on Sepolia for this case.

[`partner/metamask/scripts/false-check.mjs`](partner/metamask/scripts/false-check.mjs) then checked it read-only (no transaction on any chain), and its output is committed as [`partner/metamask/live-false-check-result.json`](partner/metamask/live-false-check-result.json) (run at 03:48 UTC on 17 November 2026):
- the `request_verdict` receipt is for this case, Finalized, `FinishedWithReturn`, MAJORITY_AGREE; each validator's vote is recorded. This is checked before any Sepolia call;
- the carrier rule refuses to post (verdict FALSE);
- `verdictTrue[carrier][caseKey]` on `VerdictGateEnforcer` is false;
- at Sepolia block 12151838, the agent's redemption of a gated delegation for this case (signed off-chain, never broadcast) reverts with `VerdictGateEnforcer:verdict-not-true`, as is and with only the principal's balance overridden; it succeeds only when `verdictTrue` is also overridden to TRUE. These are `eth_call` simulations, not transactions.

What this shows: for a FALSE case, the carrier rule refuses, and without a carrier post the gate refuses the payment. It does not show that the carrier is honest; the carrier is a trusted off-chain writer.

## Architecture

| Path | Role |
|---|---|
| `contracts/MandateVerdict.py` | The Intelligent Contract. Pinned to the Bradbury runner `py-genlayer:babwp9t37jw9g4j2bccgn14g6x7x9s1f7dsmh7emvz735pz4zxa0` and written against the current GenLayer Python API (`import genlayer as gl`, `gl.contract.Contract`, `gl.vm.run_nondet`). |
| `examples/` | Sample mandate (with the bound evidence URL) and pass / fail / undetermined deliverables. |
| `testnet-deploy/` | The demo page. By default it reads the live verdict of the deployed sample case without a wallet; an optional section deploys to Bradbury and runs one case, with every transaction signed in the browser with MetaMask. |
| `partner/metamask/` | Verdict-gated MetaMask Smart Accounts Kit (ERC-7710) delegation: the code that builds the delegation and settles it, offline unit tests, a local Sepolia-fork simulation, and live payment and refusal runners that only send with `--broadcast`. |
| `SKILL.md` | Reusable agent skill: the whole flow with the repository's own commands, addresses, decision table and trust model. |
| `tests/direct/` | Optional in-memory tests of the contract file via `genlayer-test`. |
| `proof/` | Dated raw JSON-RPC receipts for the sample Bradbury run, with commands to reproduce. Also copied into the page build for its fallback view. |
| `.github/workflows/pages.yml` | On push to `main`: `npm ci`, `npm test`, `npm run build` in `testnet-deploy/`, then publishes `testnet-deploy/dist` to GitHub Pages. Uses only the built-in `GITHUB_TOKEN`. |

The contract holds one case. The deployer is the principal. `submit_deliverable` is restricted to the appointed agent. `request_verdict` may be called by either party once a deliverable is on file. `get_verdict` is a read-only view.

The contract file in this repository is byte-identical to the source that was deployed (sha256 `bc3efe4794463b3fe7db2e2e7c5647108d7cc90cd962a6418da0e8c8dd370117`). Its header docstring still says the contract had not been deployed; that wording predates the Bradbury run and was left unchanged so the file would stay identical to what is on chain.

## On-chain proof

The sample case was run on **GenLayer Testnet Bradbury** (chain ID 4221) on 15 November 2026. A dated snapshot of the public RPC receipts (captured 15 November 2026, 10:37:56 PM ET) is in [`proof/`](proof/), with commands to reproduce the calls.

Independent verification:

- EVM receipts via `eth_getTransactionReceipt` on `https://rpc.testnet-chain.genlayer.com` (all `status` `0x1`). Snapshots: [`proof/eth/`](proof/eth/).
- GenLayer receipts via `gen_getTransactionReceipt` on `https://rpc-bradbury.genlayer.com` (all `Finalized` / `FinishedWithReturn`). Snapshots: [`proof/gen/`](proof/gen/).
- Explorer: [scan.testnet-chain.genlayer.com](https://scan.testnet-chain.genlayer.com).

| Step | Value |
|---|---|
| Contract | [`0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B`](https://scan.testnet-chain.genlayer.com/address/0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B) |
| Deploy (EVM transaction) | [`0x5572f1d3140aa180df8dbe5df207ba1f9cbdff26c86651086b3e72b636509d09`](https://scan.testnet-chain.genlayer.com/tx/0x5572f1d3140aa180df8dbe5df207ba1f9cbdff26c86651086b3e72b636509d09) |
| `submit_deliverable` (EVM transaction) | [`0x778a69fe0b8ffb3e7a80879cef6ea25aa65bee4cd9992a7b3cbbfba61350a9e7`](https://scan.testnet-chain.genlayer.com/tx/0x778a69fe0b8ffb3e7a80879cef6ea25aa65bee4cd9992a7b3cbbfba61350a9e7) |
| `request_verdict` (EVM transaction) | [`0x99f86115017d036dc1d2119ada7c8875cc79c5ef9532d705b9a352d764632e49`](https://scan.testnet-chain.genlayer.com/tx/0x99f86115017d036dc1d2119ada7c8875cc79c5ef9532d705b9a352d764632e49) |
| Verdict | **TRUE** (outcome `VERDICT`) |
| Consensus | **MAJORITY_AGREE** 4/5 (5 validators; 4 Agree, 1 Timeout; all five votes revealed) |

The first-line runner pin is `py-genlayer:babwp9t37jw9g4j2bccgn14g6x7x9s1f7dsmh7emvz735pz4zxa0`.

## Tests and build

Node 20+ for the deploy-page tests and bundle:

```bash
cd testnet-deploy
npm ci
npm test          # network-free unit tests of chain, genesis, send guards, and live-view helpers
npm run build     # writes dist/ (bundled app, contract, sample case, proof/ receipts)
```

MetaMask delegation (Node 20+). The unit tests are network-free. The simulation needs [Foundry](https://book.getfoundry.sh/)'s `anvil` and reads a public Sepolia RPC and the Bradbury RPC; it broadcasts nothing:

```bash
cd partner/metamask
npm ci
npm test          # delegation shape, caveats, salt label, expiry, signature recovery, settle() decisions, both recorded live runs
npm run simulate  # local anvil fork of Sepolia: deploy, fund, sign, read the live verdict, redeem
npm run plan      # prints the three public-testnet transactions a live run would send
node scripts/refusal.mjs plan   # prints the refusal run's steps (two deliberately reverting redemptions)
npm run test:contracts          # Foundry: VerdictGateEnforcer unit tests + the committed artifact matches a fresh pinned build
node scripts/onchain-check.mjs plan     # prints the on-chain verdict check's five transactions
node scripts/onchain-check.mjs verify   # read-only re-check of the recorded on-chain check (and its Sourcify match)
```

`npm test` includes a test that starts a plain local `anvil` (no fork) if it is on `PATH`, and skips it otherwise. CI installs Foundry v1.9.0.

Optional contract tests (Python 3.11+). These use a local GenVM stand-in, not the live network:

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python -m pytest tests/direct -q
genvm-lint check contracts/MandateVerdict.py
```

Without `genlayer-test` installed, `tests/direct` is skipped.

## Deploy on Bradbury

Network facts from [GenLayer Networks](https://docs.genlayer.com/developers/networks):

| Item | Value |
|---|---|
| Network | GenLayer Testnet Bradbury (Phase 2) |
| Chain ID | 4221 (`0x107d`), currency GEN |
| Chain RPC (wallet, `eth_*`) | `https://rpc.testnet-chain.genlayer.com` |
| GenLayer node RPC (`gen_*`) | `https://rpc-bradbury.genlayer.com` |
| Explorer | `https://scan.testnet-chain.genlayer.com` |
| Faucet | [testnet-faucet.genlayer.foundation](https://testnet-faucet.genlayer.foundation/) |

```bash
cd testnet-deploy
npm ci && npm run build
npm run serve                 # http://127.0.0.1:8787/ (loopback only)
```

Open the page in a browser with MetaMask and expand **Optional: try it with MetaMask**. Add or switch to Bradbury, connect, run the read-only fee estimate, then confirm each of the three transactions (deploy, `submit_deliverable`, `request_verdict`). Each send is gated by an in-page confirm dialog and a MetaMask prompt. The page never asks for a seed phrase or private key.

You need testnet GEN from the faucet. With one connected account, the principal and the agent are the same address. That is enough to show the mechanics; it is not a two-party run.

Each transaction sends a fee deposit as `value`; unused budget is refunded at finalization. Immediately before each confirm dialog (deploy, `submit_deliverable`, and `request_verdict`), the page fetches a fresh live deposit estimate, shows that value in the dialog, and uses it for the send. If that estimate fails, the send is aborted and nothing is submitted. The Estimate fee button stays available after a successful estimate so you can refresh the displayed deposit without advancing to the next send step. See [Fees and Transaction Policy](https://docs.genlayer.com/developers/decentralized-applications/fees-and-transaction-kit). More deploy-page detail is in [`testnet-deploy/README.md`](testnet-deploy/README.md).

## Limitations

- **One case per contract.** A registry of many mandates would be a later revision.
- **Live refusals are on-chain limits, not the verdict.** The outsider's and the repeat redemption that reverted on Sepolia show MetaMask's limits holding (only the clerk, only once). They do not involve a verdict. The [live FALSE verdict](#live-false-verdict-on-bradbury) is a separate case, checked read-only on Sepolia (no Sepolia transaction).
- **The settlement clerk is trusted in the payment run; the verdict carrier is trusted in the on-chain check.** In the payment run, `partner/metamask/` gates the MetaMask delegation on the verdict in off-chain code. MetaMask's caveat enforcers limit what the clerk can do (exact fee, to the named agent, once, before expiry), but no contract checks the GenLayer verdict or the case label (salt) on Sepolia. In the [on-chain verdict check](#on-chain-verdict-check-on-sepolia), `VerdictGateEnforcer` checks on Sepolia that the carrier named in the signed delegation posted TRUE for exactly this case. No contract on Sepolia checks GenLayer itself, so the carrier, a trusted off-chain writer, is trusted to post only a finalized TRUE. In both, the fee is not locked: it stays in the principal's own account until redemption. Removing that trust would need the verdict to reach the EVM side without a trusted party, for example GenLayer delivering it to the enforcer itself.
- **Local tests use a v0.3-dev stand-in.** `tests/direct` runs the contract in genlayer-test's in-memory VM with mocked web and model responses. That environment is a v0.3-dev stand-in, not the exact Bradbury runner pinned in the contract header, and it is not a network consensus run. The on-chain proof above is the authoritative result.
- **Submitted-URL binding is not the fetched page.** GenVM follows redirects and does not expose the final URL, so a bound URL can still lead the jury to a page the agent controls if that page is the redirect target. With prefix binding, the agent can also submit any path under the allowed prefix, including a page it controls there. See [Evidence-URL policy](#evidence-url-policy).
- **Quote matching is normalized, and the model sees a truncated page.** See [Quote matching and page window](#quote-matching-and-page-window).
- **One-wallet demos** make the principal and the agent the same address.
- **Prompt-injection fencing** (untrusted text between fixed markers, normalized quote grounding, independent re-judgement) is a mitigation, not a proof that a real model resists every injection.

## License

[MIT](LICENSE)
