# On-chain proof (Bradbury capture)

Raw JSON-RPC responses for the sample case on GenLayer Testnet Bradbury (chain ID 4221), captured **Sunday, Nov 15, 2026, 10:37:56 PM ET**.

The files are unmodified RPC envelopes (`jsonrpc`, `id`, `result`). They contain only what the public endpoints returned, including ordinary on-chain fields such as sender, recipient, logs, and calldata. The deploy GenLayer receipt is larger because `txCallData` includes the deployed contract source.

These receipts do not replace the explorer; they are a dated snapshot of the same public data.

| Step | EVM transaction (`eth_getTransactionReceipt`) | GenLayer transaction id (`gen_getTransactionReceipt`) | Snapshot |
|---|---|---|---|
| Deploy | `0x5572f1d3140aa180df8dbe5df207ba1f9cbdff26c86651086b3e72b636509d09` | `0xc764f6fc7588424fa36fe93f786c9573e392f0046e5bd8ba427828fa1e494162` | [`eth/deploy.json`](eth/deploy.json), [`gen/deploy.json`](gen/deploy.json) |
| `submit_deliverable` | `0x778a69fe0b8ffb3e7a80879cef6ea25aa65bee4cd9992a7b3cbbfba61350a9e7` | `0xe8df70a207b432c69102d889817fa70a566916dba8aa0630b1935aad2712d3e5` | [`eth/submit_deliverable.json`](eth/submit_deliverable.json), [`gen/submit_deliverable.json`](gen/submit_deliverable.json) |
| `request_verdict` | `0x99f86115017d036dc1d2119ada7c8875cc79c5ef9532d705b9a352d764632e49` | `0xe6b05c9f31f84392c0bac5d94cb8df1f107634f61bd3ba0ce8c056710e1517d8` | [`eth/request_verdict.json`](eth/request_verdict.json), [`gen/request_verdict.json`](gen/request_verdict.json) |

Contract: [`0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B`](https://scan.bradbury.genlayer.com/address/0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B). Explorer: [scan.testnet-chain.genlayer.com](https://scan.testnet-chain.genlayer.com).

The GenLayer transaction id is not the EVM hash. It appears as a repeated 32-byte topic in that transaction's EVM logs. `gen_getTransactionReceipt` on the EVM hash returns an uninitialized receipt; pass the GenLayer id as shown below.

## Reproduce

Chain RPC: `https://rpc.testnet-chain.genlayer.com`  
Node RPC: `https://rpc-bradbury.genlayer.com`

Some endpoints refuse requests without a browser-like `User-Agent`. The captures used a Chrome UA.

EVM receipt (example: deploy):

```bash
curl -sS -X POST https://rpc.testnet-chain.genlayer.com \
  -H 'Content-Type: application/json' \
  -A 'Mozilla/5.0' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0x5572f1d3140aa180df8dbe5df207ba1f9cbdff26c86651086b3e72b636509d09"]}'
```

GenLayer receipt (example: deploy). Repeat with the `txID` values in the table:

```bash
curl -sS -X POST https://rpc-bradbury.genlayer.com \
  -H 'Content-Type: application/json' \
  -A 'Mozilla/5.0' \
  --data '{"jsonrpc":"2.0","id":1,"method":"gen_getTransactionReceipt","params":[{"txID":"0xc764f6fc7588424fa36fe93f786c9573e392f0046e5bd8ba427828fa1e494162","round":0}]}'
```

A later live fetch can differ in formatting or node-side metadata; the files in this folder are the 10:37:56 PM ET snapshot. The EVM `status` (`0x1`) and GenLayer `statusName` / `txExecutionResultName` (`Finalized` / `FinishedWithReturn`) are the fields used in the root README's on-chain proof table.
