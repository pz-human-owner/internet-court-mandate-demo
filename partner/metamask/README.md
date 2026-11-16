# MetaMask delegation settlement

A verdict-gated ERC-7710 delegation built with the MetaMask Smart Accounts Kit. The principal's MetaMask smart account delegates "pay the agent exactly the fee, once, before expiry" to a settlement account (the clerk). The clerk redeems only after the GenLayer MandateVerdict contract returns TRUE. See [MetaMask delegation settlement](../../README.md#metamask-delegation-settlement) in the main README for the design.

**Trust model, briefly:**
- **The clerk is trusted.** The verdict gate and the case label (the salt) are checked only by the clerk's code in `settle()`, not on-chain; no oracle connects GenLayer Bradbury and Sepolia. A dishonest clerk could pay the agent on a FALSE verdict or for the wrong case. MetaMask's caveat enforcers still stop it from paying anyone else, paying more, paying twice, or paying after expiry.
- **It isn't an escrow.** The fee stays in the principal's own smart account, and the owner could move it out before redemption.
- **The expiry is up to the caller.** The live runner defaults to 7 days (`EXPIRY_DAYS`); `buildPaymentDelegation` accepts any expiry. `settle()` reads the expiry from the signed delegation's Timestamp caveat.

| File | Role |
|---|---|
| `src/verdict-payment.mjs` | Builds the delegation (scope, caveats, case-label salt), the redeem and disable calldata, and makes the `settle()` decision. All I/O is injected. |
| `src/genlayer-verdict.mjs` | Read-only `get_verdict` reader for Bradbury (genlayer-js `readContract`). |
| `test/` | Offline unit tests. |
| `scripts/simulate-fork.mjs` | Full run on a local anvil fork of Sepolia. Broadcasts nothing; keys are throwaway and in memory only. |
| `sim-result.json` | Output of the last simulation. |
| `live-result.json` | Record of the live Sepolia run: transaction hashes, blocks, addresses, verdict. No keys. |
| `scripts/live.mjs` | `plan` prints the public-testnet transactions. `grant` and `settle` send them, and only with `--broadcast` and keys set in the environment. |

## Live run on Sepolia

On 16 November 2026 (20:38–20:39 UTC) the flow ran on public Ethereum Sepolia with throwaway testnet keys. The clerk read the real Bradbury verdict for [`0x07E2…2F8B`](https://scan.testnet-chain.genlayer.com/address/0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B), got `resolved` / **TRUE**, and redeemed the delegation. All keys were throwaway testnet keys, and the same operator held both the OWNER and CLERK keys (the agent is only a receiving address). To keep the demo to one funded account, the clerk paid the gas for all three transactions and also sent the 0.001 ETH fee into the principal's smart account (step B). In real use the principal would fund their own account. The full record, with hashes, blocks, addresses, the delegation hash, caveat enforcers and a raw `get_verdict` response (from a read-only call made after the run), is in [`partner/metamask/live-result.json`](live-result.json).

| Step | Transaction | Block | Result |
|---|---|---|---|
| A. Deploy the principal's MetaMask Hybrid smart account [`0x2d00…C976`](https://sepolia.etherscan.io/address/0x2d006AF0f603CA2C2a6b8f9689A20E1dc65FC976) via SimpleFactory | [`0x0897bcff…`](https://sepolia.etherscan.io/tx/0x0897bcffcc2afd00de69936ab89de6613c4fc1bccb8b2b4130c4092ea79ca51a) | 12149738 | success |
| B. Fund the smart account with the 0.001 ETH fee | [`0xef5104a4…`](https://sepolia.etherscan.io/tx/0xef5104a490e68ae7078b396beaab9080922301fdf2caad69da0aed27218881c3) | 12149739 | success |
| – Owner signs the ERC-7710 delegation off-chain (hash `0xd76ec7fb…8187`) | no transaction | – | – |
| C. The clerk [`0x906b…2D10`](https://sepolia.etherscan.io/address/0x906b4D9d64a5d4Bb559292A3f24562835a122D10) reads verdict TRUE and calls `DelegationManager.redeemDelegations` | [`0x64a3f537…`](https://sepolia.etherscan.io/tx/0x64a3f537451b275f12421f52fea886eb89dd666fbf9f9ee697a64d1f423b2e1f) | 12149741 | success; agent [`0x8b5d…4929`](https://sepolia.etherscan.io/address/0x8b5deeE4A52c321C81C33b2bC99834EB05B04929) went from 0 to 0.001 ETH |

The FALSE path and the on-chain rejections (an outsider, a second redemption, a redemption after expiry) were exercised only in the local fork simulation, not on public Sepolia.

