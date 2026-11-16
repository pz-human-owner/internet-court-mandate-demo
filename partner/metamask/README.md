# MetaMask delegation settlement

A verdict-gated ERC-7710 delegation built with the MetaMask Smart Accounts Kit. The principal's MetaMask smart account delegates "pay the agent exactly the fee, once, before expiry" to a settlement account (the clerk). The clerk redeems only after the GenLayer MandateVerdict contract returns TRUE. See [MetaMask delegation settlement](../../README.md#metamask-delegation-settlement) in the main README for the design and its trust model.

| File | Role |
|---|---|
| `src/court-escrow.mjs` | Builds the delegation (scope, caveats, case salt), the redeem and disable calldata, and makes the `settle()` decision. All I/O is injected. |
| `src/genlayer-verdict.mjs` | Read-only `get_verdict` reader for Bradbury (genlayer-js `readContract`). |
| `test/` | Offline unit tests. |
| `scripts/simulate-fork.mjs` | Full run on a local anvil fork of Sepolia. Broadcasts nothing; keys are throwaway and in memory only. |
| `sim-result.json` | Output of the last simulation. |
| `scripts/live.mjs` | `plan` prints the public-testnet transactions. `grant` and `settle` send them, and only with `--broadcast` and keys set in the environment. |
