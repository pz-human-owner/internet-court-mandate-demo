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
| `scripts/refusal.mjs` | `plan` prints the refusal steps. `run --broadcast` makes the clerk refuse a delegation bound to another case (no tx), then sends two deliberately reverting redemptions: the agent redeeming by itself, and a second redemption of the paid delegation. |
| `live-refusal-result.json` | Record of the live refusal run: the fresh delegation, the clerk's refusals, both reverted transactions with decoded revert reasons and replays. No keys. |

## Live run on Sepolia

On 16 November 2026 (20:38–20:39 UTC) the flow ran on public Ethereum Sepolia with throwaway testnet keys. The clerk read the real Bradbury verdict for [`0x07E2…2F8B`](https://scan.testnet-chain.genlayer.com/address/0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B), got `resolved` / **TRUE**, and redeemed the delegation. All keys were throwaway testnet keys, and the same operator held both the OWNER and CLERK keys (in this run the agent was only a receiving address; the refusal run below also used its throwaway key). To keep the demo to one funded account, the clerk paid the gas for all three transactions and also sent the 0.001 ETH fee into the principal's smart account (step B). In real use the principal would fund their own account. The full record, with hashes, blocks, addresses, the delegation hash, caveat enforcers and a raw `get_verdict` response (from a read-only call made after the run), is in [`partner/metamask/live-result.json`](live-result.json).

| Step | Transaction | Block | Result |
|---|---|---|---|
| A. Deploy the principal's MetaMask Hybrid smart account [`0x2d00…C976`](https://sepolia.etherscan.io/address/0x2d006AF0f603CA2C2a6b8f9689A20E1dc65FC976) via SimpleFactory | [`0x0897bcff…`](https://sepolia.etherscan.io/tx/0x0897bcffcc2afd00de69936ab89de6613c4fc1bccb8b2b4130c4092ea79ca51a) | 12149738 | success |
| B. Fund the smart account with the 0.001 ETH fee | [`0xef5104a4…`](https://sepolia.etherscan.io/tx/0xef5104a490e68ae7078b396beaab9080922301fdf2caad69da0aed27218881c3) | 12149739 | success |
| – Owner signs the ERC-7710 delegation off-chain (hash `0xd76ec7fb…8187`) | no transaction | – | – |
| C. The clerk [`0x906b…2D10`](https://sepolia.etherscan.io/address/0x906b4D9d64a5d4Bb559292A3f24562835a122D10) reads verdict TRUE and calls `DelegationManager.redeemDelegations` | [`0x64a3f537…`](https://sepolia.etherscan.io/tx/0x64a3f537451b275f12421f52fea886eb89dd666fbf9f9ee697a64d1f423b2e1f) | 12149741 | success; agent [`0x8b5d…4929`](https://sepolia.etherscan.io/address/0x8b5deeE4A52c321C81C33b2bC99834EB05B04929) went from 0 to 0.001 ETH |

### Refusal on Sepolia

On 16 November 2026 (22:52–22:53 UTC) `node scripts/refusal.mjs run --broadcast` ran on public Sepolia with the same throwaway accounts. The clerk's `settle()` refused, with no transaction, a fresh delegation bound to another case, even though the sample case's live verdict was TRUE. Then two redemptions were sent with a fixed gas limit so they would be mined, and both reverted:

| Step | Transaction | Block | Result |
|---|---|---|---|
| R1. The agent redeems the fresh delegation itself | [`0x323887a0…`](https://sepolia.etherscan.io/tx/0x323887a077ab6f8be8226ab47f259f7a1b6562df2627db31f8ee5e592c33528b) | 12150397 | reverted: DelegationManager `InvalidDelegate` |
| R2. The clerk redeems the delegation paid in step C again | [`0x28c9837c…`](https://sepolia.etherscan.io/tx/0x28c9837c4137efd47ef85cac8940499cb792dfbc53b8860d9a41b3f92755d640) | 12150399 | reverted: `NativeTokenTransferAmountEnforcer:allowance-exceeded` |

The agent's throwaway key sent and paid for R1 (2,532,840 wei of gas), so a rerun needs a little Sepolia ETH on the agent address; the clerk paid for R2. The principal's smart account held 0 ETH during R1, so R1 shows the delegate (caller) check, not a funded payment being blocked.

The runner now sends R1 or R2 only if an `eth_call` simulation reverts with the expected decoded reason (any RPC error, rate limit or other reason aborts before sending), requires a `reverted` receipt and a matching parent-block replay after mining, exits non-zero and writes nothing otherwise, and never overwrites an existing record (`run --broadcast --out <new-file>`). `node scripts/refusal.mjs verify` re-checks the recorded R1 and R2 read-only (it needs an archive-capable Sepolia RPC in `SEPOLIA_RPC_URL`); its 16 November 2026 result is under `independentReverification`. The gate is unit-tested in [`test/refusal-gate.test.mjs`](test/refusal-gate.test.mjs).

Record: [`live-refusal-result.json`](live-refusal-result.json). Still not run on a public chain: a live FALSE or UNDETERMINED verdict (the only deployed case resolved TRUE, and no new GenLayer transactions were made) and a redemption after expiry. Those are covered by the unit tests and the local fork simulation.

