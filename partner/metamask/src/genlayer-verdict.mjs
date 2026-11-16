// Read-only verdict reader for the GenLayer MandateVerdict contract (gen_call; nothing is signed).
import { createClient } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';

export const DEFAULT_GENLAYER_RPC = 'https://rpc-bradbury.genlayer.com';

export function makeVerdictReader(contract, { endpoint = DEFAULT_GENLAYER_RPC, timeoutMs = 20000 } = {}) {
  const client = createClient({ chain: testnetBradbury, endpoint });
  return async () => {
    let timer;
    try {
      return await Promise.race([
        client.readContract({ address: contract, functionName: 'get_verdict', args: [] }),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error(`get_verdict timed out after ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}
