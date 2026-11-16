# Bradbury deploy page

A local page that deploys `contracts/MandateVerdict.py` to **GenLayer Testnet Bradbury (Phase 2)** and runs one verdict. Every transaction is signed in the browser with MetaMask through `window.ethereum`. The page never sees or asks for a seed phrase or private key.

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
npm test                     # network-free unit tests of the guards
npm run serve                # http://127.0.0.1:8787/ (loopback only)
```

Open the page in the browser that has MetaMask. The page sends three transactions, each at most once, in order, each behind a confirm dialog and a MetaMask prompt:

1. **Deploy** `MandateVerdict(agent = your address, mandate, guidelines, evidence_url, allow_subpaths = false)` using the sample case in `../examples`. You become the principal.
2. **`submit_deliverable`** with the sample "pass" deliverable. The contract only accepts this from the appointed agent, so with one wallet the agent is your own address.
3. **`request_verdict`**. Validators fetch the bound MetaMask docs page and judge.

After each step the page waits until the transaction is decided, then logs status, execution result, and costs. "Read verdict" calls `get_verdict` (read-only).

Each transaction sends a fee deposit as `value`; unused budget is refunded at finalization. Immediately before each confirm dialog (deploy, `submit_deliverable`, and `request_verdict`), the page fetches a fresh live deposit estimate, shows that value in the dialog, and uses it for the send. If that estimate fails, the send is aborted and nothing is submitted. The Estimate fee button stays available after a successful estimate so you can refresh the displayed deposit without advancing to the next send step. See [Fees and Transaction Policy](https://docs.genlayer.com/developers/decentralized-applications/fees-and-transaction-kit).
