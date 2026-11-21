# Direct mode on GenLayer Chain

`VerdictGateDirectEnforcer` and the Foundry tests in this folder are the EVM side of direct mode: a GenLayer Intelligent Contract posts `postVerdictTrue()` itself after a finalized TRUE, and a MetaMask ERC-7710 delegation can be redeemed only then. There is no carrier key. See the [root README](../../README.md).

## Live proof runner

[`scripts/direct-proof.mjs`](scripts/direct-proof.mjs) is the batch runner for a live proof on **GenLayer Testnet Bradbury / GenLayer Chain (chain id 4221)**. It does not submit anything to the GenLayer portal.

```bash
cd partner/genlayer-chain
npm ci
npm run plan          # print the batch and GEN estimate; no key, no writes
npm test              # network-free unit tests of salts, caveats, and the GEN budget
npm run dry-run       # local anvil fork of 4221; EVM path only; no real txs
# Only after the throwaway EOA is funded, and only with an explicit yes:
node scripts/direct-proof.mjs broadcast --broadcast
```

`plan` and `dry-run` do not read the throwaway private key. `broadcast` reads it only from a chmod 600 file (`DIRECT_PROOF_KEY_FILE`, default `/workspace/v6work/submission-101/.throwaway.key`, outside this repo) and refuses to send if the account is unfunded. The key is never logged or written to `direct-proof-state.json`.

The runner **reuses** MetaMask Delegation Framework v1.3.0 already deployed on 4221 at the official CREATE2 addresses (`getSmartAccountsEnvironment(11155111)`), which were confirmed to have contract code on this chain. It deploys `VerdictGateDirectEnforcer`, two `MandateVerdictDirect` cases (TRUE and FALSE sample briefings), a Hybrid DeleGator smart account, then signs two delegations and records the early redeem revert, the TRUE payment, the repeat redeem revert, the FALSE mined revert, and an EOA `postVerdictTrue` refusal.

A live `request_verdict` is waited out until **finalized** (after the appeal window), because the ghost posts `postVerdictTrue` only then.

## Optional Foundry helper

`forge script script/DeployGate.s.sol` deploys only the enforcer. The node runner is the supported path for the full batch.
