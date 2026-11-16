# Internet Court Mandate Demo

A principal writes a mandate, binds the evidence a jury may read, and appoints an agent. The agent submits a deliverable. A [GenLayer](https://docs.genlayer.com/) Intelligent Contract then acts as an [Internet Court](https://internetcourt.org/)-style jury: validators fetch a page at the submitted source URL and record whether the deliverable met the mandate.

The sample case binds official [MetaMask Smart Accounts Kit: Delegation](https://docs.metamask.io/smart-accounts-kit/concepts/delegation/overview/) documentation (HTTP 200, no redirect, checked 15 November 2026). The mandate asks for a short briefing that mentions ERC-7710, explains that the delegator configures a scope and optional caveats, and never claims that the delegate holds the delegator's private key.

MetaMask is listed in the Founding Partners section of [internetcourt.org](https://internetcourt.org/). This project uses MetaMask's public documentation as evidence and MetaMask in the browser to sign testnet transactions. It is not endorsed by MetaMask.

## Live demo

Hosted page: **https://pz-human-owner.github.io/internet-court-mandate-demo/** (served by GitHub Pages from `testnet-deploy/` via [`.github/workflows/pages.yml`](.github/workflows/pages.yml); the link works only once GitHub Pages is enabled for this repository with Source: GitHub Actions).

- **View the live verdict (default, no wallet).** On load the page reads the deployed sample case, contract [`0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B`](https://scan.testnet-chain.genlayer.com/address/0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B) on Bradbury, with read-only `gen_call` views (`get_status`, `get_verdict`, `get_case`) and shows the mandate, deliverable, verdict, reasoning, supporting quote, and explorer links. Nothing is signed or sent. If the RPC cannot be reached, the page says so and shows the recorded result of the Nov 15 run with links to the [`proof/`](proof/) receipts and the explorer. Add `?contract=0x…` to read a different MandateVerdict contract.
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

## Architecture

| Path | Role |
|---|---|
| `contracts/MandateVerdict.py` | The Intelligent Contract. Pinned to the Bradbury runner `py-genlayer:babwp9t37jw9g4j2bccgn14g6x7x9s1f7dsmh7emvz735pz4zxa0` and written against the current GenLayer Python API (`import genlayer as gl`, `gl.contract.Contract`, `gl.vm.run_nondet`). |
| `examples/` | Sample mandate (with the bound evidence URL) and pass / fail / undetermined deliverables. |
| `testnet-deploy/` | The demo page. By default it reads the live verdict of the deployed sample case without a wallet; an optional section deploys to Bradbury and runs one case, with every transaction signed in the browser with MetaMask. |
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
- **Trusted attester for any EVM settlement.** This repository does not include a settlement contract. Bridging a GenLayer verdict into an EVM payment — for example, unlocking a MetaMask Smart Accounts Kit (ERC-7710) delegation only when `get_verdict` is TRUE — would require a trusted attester to copy the verdict into an oracle or caveat enforcer. That attester is a trust assumption, not a trustless bridge.
- **Local tests use a v0.3-dev stand-in.** `tests/direct` runs the contract in genlayer-test's in-memory VM with mocked web and model responses. That environment is a v0.3-dev stand-in, not the exact Bradbury runner pinned in the contract header, and it is not a network consensus run. The on-chain proof above is the authoritative result.
- **Submitted-URL binding is not the fetched page.** GenVM follows redirects and does not expose the final URL, so a bound URL can still lead the jury to a page the agent controls if that page is the redirect target. With prefix binding, the agent can also submit any path under the allowed prefix, including a page it controls there. See [Evidence-URL policy](#evidence-url-policy).
- **Quote matching is normalized, and the model sees a truncated page.** See [Quote matching and page window](#quote-matching-and-page-window).
- **One-wallet demos** make the principal and the agent the same address.
- **Prompt-injection fencing** (untrusted text between fixed markers, normalized quote grounding, independent re-judgement) is a mitigation, not a proof that a real model resists every injection.

## License

[MIT](LICENSE)
