# Demo page: live verdict + optional Bradbury deploy

The page in this folder has two parts:

1. **View the live verdict (default, no wallet).** On load it creates a read-only `genlayer-js` client (no account, no provider) for **GenLayer Testnet Bradbury (Phase 2)** and calls the contract's read-only views `get_status`, `get_verdict`, and `get_case` on the deployed sample case, [`0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B`](https://scan.testnet-chain.genlayer.com/address/0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B). It renders the mandate, deliverable, verdict, reasoning, supporting quote, and explorer links. No transaction is sent and MetaMask is not needed.
2. **Try it with MetaMask (optional, collapsed).** Deploys `contracts/MandateVerdict.py` from the visitor's own wallet and runs one verdict. Every transaction is signed in the browser with MetaMask through `window.ethereum`. These are real Bradbury testnet transactions. The page never sees or asks for a seed phrase or private key.

Hosted at **https://pz-human-owner.github.io/internet-court-mandate-demo/**. The workflow [`../.github/workflows/pages.yml`](../.github/workflows/pages.yml) runs `npm ci`, `npm test`, and `npm run build` here on every push to `main` and publishes `dist/`. You can also run it locally (below).

MetaMask's role here is limited: the jury reads MetaMask's official delegation docs as evidence, and MetaMask is the optional signer for the deploy section. The page does not use the MetaMask Smart Accounts Kit or ERC-7710 in code.

### View mode details

- Reads go to the GenLayer node RPC `https://rpc-bradbury.genlayer.com` (it sends `Access-Control-Allow-Origin: *`, so the hosted page can call it directly). Each read times out after 30 seconds.
- `?contract=0x…` in the page URL reads a different MandateVerdict contract instead of the sample case. A malformed value is ignored. In the MetaMask section, after Estimate, that same link resumes at the next unsent step from a read-only `get_status` call: `open` enables only `submit_deliverable`, `submitted` enables only `request_verdict`, and `resolved` enables nothing and shows the verdict. If the read fails, nothing is enabled (fail-closed); retry Estimate, or add `&step=submit` or `&step=verdict` to choose a step yourself.
- If the live read fails, the page says so in a yellow banner and shows the **recorded** result of the sample run (verdict, consensus, reasoning, quote) with explorer links and the dated receipts from [`../proof/`](../proof/), which the build copies into `dist/proof/`. That fallback is labelled as not live.
- **Re-read live** repeats the three reads.

For the full description of the contract, architecture, on-chain proof, and limitations, see the [root README](../README.md).

## Network

| Item | Value |
|---|---|
| Chain ID | 4221 (`0x107d`), currency GEN |
| Chain RPC (wallet, `eth_*`) | `https://rpc.testnet-chain.genlayer.com` |
| Explorer | `https://scan.testnet-chain.genlayer.com` |
| Genesis hash (verify before sending) | `0x17d89764d4f4f963158fc4c5e8f2cb670c2837740b35f37081c12860c3df97e4` |
| AddressManager | `0x3F71AE080BD6270A91dBcc7960d88797828538E0` |
| GenLayer node RPC (`gen_*`) | `https://rpc-bradbury.genlayer.com` (editable in the page) |
| Faucet | [testnet-faucet.genlayer.foundation](https://testnet-faucet.genlayer.foundation/) |

Sources: [GenLayer Networks](https://docs.genlayer.com/developers/networks). The node RPC host is the one genlayer-js ships for Bradbury; the docs do not print it. `rpc.testnet-chain.genlayer.com` does not serve `gen_*`.

This page pins `genlayer-js@2.0.0-rc.3`, which points at ConsensusMain `0x2E2766cbc3E5e61Ce93bBcdCBb3eAcB82082A019` (the Phase 2 contract). The 1.x Bradbury address is not used here.

## Run

```bash
npm ci && npm run build      # bundles genlayer-js into dist/app.js; no CDN
npm test                     # network-free unit tests of the guards and live-view helpers
npm run serve                # http://127.0.0.1:8787/ (loopback only)
```

The live verdict appears without a wallet. For the optional deploy, open the page in the browser that has MetaMask and expand **Optional: try it with MetaMask**. That section sends three transactions, each at most once, in order, each behind a confirm dialog and a MetaMask prompt:

1. **Deploy** `MandateVerdict(agent = your address, mandate, guidelines, evidence_url, allow_subpaths = false)` using the sample case in `../examples`. You become the principal.
2. **`submit_deliverable`** with the sample "pass" deliverable. The contract only accepts this from the appointed agent, so with one wallet the agent is your own address.
3. **`request_verdict`**. Validators fetch the bound MetaMask docs page and judge.

After each step the page waits until the transaction is decided, then logs status, execution result, and costs. "Read verdict" calls `get_verdict` (read-only).

Each transaction sends a fee deposit as `value`; unused budget is refunded at finalization. Immediately before each confirm dialog (deploy, `submit_deliverable`, and `request_verdict`), the page fetches a fresh live deposit estimate, shows that value in the dialog, and uses it for the send. If that estimate fails, the send is aborted and nothing is submitted. The Estimate fee button stays available after a successful estimate so you can refresh the displayed deposit without advancing to the next send step. See [Fees and Transaction Policy](https://docs.genlayer.com/developers/decentralized-applications/fees-and-transaction-kit).
