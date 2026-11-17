// "Try to break it": read-only attack checks against the live MetaMask delegation on Ethereum Sepolia.
//
// Every check is an eth_call (a simulation, never a transaction) or a read-only GenLayer gen_call.
// No wallet and no key: the redemption calldata is the agent's own mined redemption (T5 of the on-chain
// verdict check), fetched from the chain by its hash, so the page never builds or signs anything.
// Some checks pin a past Sepolia block (state just before or after the recorded steps) and some add
// eth_call state overrides (for example "pretend TRUE was posted for another case"). An override changes
// only that one simulated call.
//
// Trust model, stated plainly: VerdictGateEnforcer checks that the carrier named in the signed delegation
// recorded TRUE for exactly this case. No contract on Sepolia checks GenLayer itself; the carrier is a
// trusted off-chain writer. These checks show what the on-chain limits refuse. They do not show that the
// carrier is honest.
//
// Pure module (no DOM, no imports) so every branch is unit-tested without a network.

export const SEPOLIA_RPCS = Object.freeze([
  'https://sepolia.gateway.tenderly.co',
  'https://ethereum-sepolia-rpc.publicnode.com',
]);

export const ADDR = Object.freeze({
  delegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
  enforcer: '0xfEf947Be0F73A95D2A29f156D5cDfC2692Da074a',
  carrier: '0x906b4D9d64a5d4Bb559292A3f24562835a122D10',
  agent: '0x8b5deeE4A52c321C81C33b2bC99834EB05B04929',
  principal: '0x2d006AF0f603CA2C2a6b8f9689A20E1dc65FC976',
  outsider: '0x000000000000000000000000000000000000bEEF',
  otherCarrier: '0x000000000000000000000000000000000000dEaD',
  trueCase: '0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B',
  falseCase: '0x51a2343c90192360199553B92C0D9Fe976D77662',
});

/** The agent's live redemption (T5, success) and its earlier identical attempt (T3, reverted). */
export const TX = Object.freeze({
  T3: '0x4ced2add55d30f2207b0c50e77c75fb2cb55e4245e46be745afe3a616abba90d',
  T5: '0xb5dd287b80fcb96bffefdbcaf1819652d92433ac78ad7032f7e9bf2be488955d',
});

/** Sepolia blocks of the recorded on-chain verdict check. */
export const BLOCK = Object.freeze({ T1: 12150800, T2: 12150801, T4: 12150818, T5: 12150819 });

/** Case keys (= the delegation salt / gate terms): caseKey(4221, case contract) on the enforcer. */
export const CASE_KEY = Object.freeze({
  trueCase: '0x4ecd88166fcf7b929f66342a4ee81440ff553e1f8b76c8bcf763ace4107de8c1',
  falseCase: '0xa5fcdde9e5ad31478f0fc9c5da18a8f2a537f44be751531608ad9ed4f1aa31cc',
});

/** Storage slots of verdictTrue[carrier][caseKey] (mapping at slot 0); verified in test/breakit.test.mjs. */
export const SLOT = Object.freeze({
  trueCase: '0xf68949f00d35c0b0d4fd8fa416f77665e55747db127993f8eb7cf37dabb1650a',
  falseCase: '0x4470167f3b8a7db2772add14ec5b3d5527a532fcb1569bd16909be032abdb244',
  otherCarrier: '0x4f324cadd051cd1d695490e21c357a953e39e58947960ec4a3461a17ffc98902',
});
export const ONE = '0x' + '0'.repeat(63) + '1';
export const FEE_WEI_HEX = '0x38d7ea4c68000'; // 0.001 ETH

export const SEL = Object.freeze({
  errorString: '0x08c379a0',
  InvalidDelegate: '0xb5863604',
  verdictTrue: '0x0eefb7d8',
  caseKey: '0x6ecf8d58',
});

export const GATE_REVERT = 'VerdictGateEnforcer:verdict-not-true';

const gateOn = (slot) => ({ [ADDR.enforcer]: { stateDiff: { [slot]: ONE } } });
const hex = (n) => '0x' + Number(n).toString(16);

/**
 * The checks, in display order. `call` checks eth_call the agent's redemption calldata.
 * expect.revert: accepted decoded reasons. expect.success: the call must not revert (a control).
 */
export const CHECKS = Object.freeze([
  {
    id: 'no-verdict', kind: 'call',
    title: 'The agent redeems before any TRUE is posted',
    how: `Sepolia block ${BLOCK.T2} (fee funded, no verdict posted yet), as is.`,
    from: ADDR.agent, block: BLOCK.T2, overrides: null,
    expect: { revert: [GATE_REVERT] },
    why: 'The verdict gate is a caveat of the signed delegation, so MetaMask\'s DelegationManager calls it on every redemption. Nothing has been posted for this case, so it refuses.',
  },
  {
    id: 'balance-only', kind: 'call',
    title: 'Fund the account, but post no verdict',
    how: `Sepolia block ${BLOCK.T1} (before funding), with only the principal's balance overridden to the 0.001 ETH fee.`,
    from: ADDR.agent, block: BLOCK.T1, overrides: { [ADDR.principal]: { balance: FEE_WEI_HEX } },
    expect: { revert: [GATE_REVERT] },
    why: 'Money in the account is not enough. The gate still refuses, so it is the gate, not a missing balance, that stops the payment.',
  },
  {
    id: 'wrong-case', kind: 'call',
    title: 'Post TRUE for a different case',
    how: `Block ${BLOCK.T2}, pretending the named carrier posted TRUE for the FALSE case (${ADDR.falseCase.slice(0, 6)}…${ADDR.falseCase.slice(-4)}) instead.`,
    from: ADDR.agent, block: BLOCK.T2, overrides: gateOn(SLOT.falseCase),
    expect: { revert: [GATE_REVERT] },
    why: 'The case key is part of the signed caveat terms. A TRUE for any other case does not open this delegation.',
  },
  {
    id: 'wrong-carrier', kind: 'call',
    title: 'Someone other than the named carrier posts TRUE',
    how: `Block ${BLOCK.T2}, pretending address 0x…dEaD posted TRUE for this case.`,
    from: ADDR.agent, block: BLOCK.T2, overrides: gateOn(SLOT.otherCarrier),
    expect: { revert: [GATE_REVERT] },
    why: 'Only the carrier named in the signed delegation counts. A TRUE from anyone else is ignored.',
  },
  {
    id: 'outsider', kind: 'call',
    title: 'A stranger redeems, even with TRUE posted',
    how: `Block ${BLOCK.T2}, sent from 0x…bEEF, with TRUE posted for this case by the named carrier.`,
    from: ADDR.outsider, block: BLOCK.T2, overrides: gateOn(SLOT.trueCase),
    expect: { revert: ['InvalidDelegate'] },
    why: 'MetaMask\'s DelegationManager only lets the delegate (the agent) redeem. A verdict does not change who may be paid.',
  },
  {
    id: 'replay', kind: 'call',
    title: 'The agent redeems a second time after being paid',
    how: 'Latest Sepolia block (after the real payment), with the principal re-funded by an override.',
    from: ADDR.agent, block: 'latest', overrides: { [ADDR.principal]: { balance: FEE_WEI_HEX } },
    expect: { revert: ['NativeTokenTransferAmountEnforcer:allowance-exceeded', 'LimitedCallsEnforcer:limit-exceeded'] },
    why: 'The delegation allows exactly 0.001 ETH, once. MetaMask\'s own caveat enforcers refuse a second payment.',
  },
  {
    id: 'control', kind: 'call',
    title: 'Control: the named carrier posts TRUE for this case',
    how: `Block ${BLOCK.T2}, pretending the named carrier posted TRUE for this case (what really happened at block ${BLOCK.T4}).`,
    from: ADDR.agent, block: BLOCK.T2, overrides: gateOn(SLOT.trueCase),
    expect: { success: true },
    why: 'The same call goes through. So the refusals above come from the gate and the limits, not from a call that can never succeed.',
  },
  {
    id: 'false-case', kind: 'false-case',
    title: 'The live FALSE case on GenLayer',
    how: `Reads get_verdict of ${ADDR.falseCase.slice(0, 6)}…${ADDR.falseCase.slice(-4)} on Bradbury, then verdictTrue(carrier, its case key) on Sepolia (latest block).`,
    expect: { verdict: 'FALSE', verdictTrue: false },
    why: 'For a FALSE verdict the carrier rule posts nothing, so the gate stays closed for that case. This relies on the carrier, a trusted off-chain writer, following its rule.',
  },
]);

/** Decode revert data: Error(string) or a known DelegationManager custom error. Returns null if unknown. */
export function decodeRevert(data) {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(data) || data.length < 10) return null;
  const sel = data.slice(0, 10).toLowerCase();
  if (sel === SEL.InvalidDelegate) return 'InvalidDelegate';
  if (sel !== SEL.errorString) return null;
  try {
    const body = data.slice(10);
    const off = parseInt(body.slice(0, 64), 16) * 2;
    const len = parseInt(body.slice(off, off + 64), 16);
    const strHex = body.slice(off + 64, off + 64 + len * 2);
    if (!Number.isFinite(len) || strHex.length !== len * 2) return null;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) bytes[i] = parseInt(strHex.slice(i * 2, i * 2 + 2), 16);
    return new TextDecoder().decode(bytes);
  } catch { return null; }
}

/** Revert data from a JSON-RPC error, or null when the error is not a revert (transport, archive limit, ...). */
export function revertData(error) {
  if (!error || typeof error !== 'object') return null;
  const d = typeof error.data === 'string' ? error.data : (error.data && typeof error.data.data === 'string' ? error.data.data : null);
  return d && /^0x[0-9a-fA-F]{8,}$/.test(d) ? d : null;
}

/**
 * Classify one eth_call JSON-RPC response for a check. Fail closed:
 *   - 'refused'  : reverted with an expected reason (the attack was stopped);
 *   - 'opened'   : did not revert, and the check expected success (the control);
 *   - 'unexpected': anything else that IS a real answer (wrong reason, or a success where a refusal was expected);
 *   - 'error'    : no usable answer (transport, archive limit, undecodable data). Never shown as a pass.
 */
export function classify(check, response) {
  if (!response || typeof response !== 'object') return { outcome: 'error', detail: 'no JSON-RPC response' };
  if (response.error) {
    const data = revertData(response.error);
    if (!data) return { outcome: 'error', detail: String(response.error.message ?? 'RPC error').slice(0, 160) };
    const reason = decodeRevert(data);
    if (!reason) return { outcome: 'error', detail: `revert data ${data.slice(0, 10)} did not decode` };
    if (check.expect.revert && check.expect.revert.includes(reason)) return { outcome: 'refused', reason };
    return { outcome: 'unexpected', reason, detail: `reverted with ${reason}` };
  }
  if (typeof response.result !== 'string') return { outcome: 'error', detail: 'eth_call returned no result' };
  if (check.expect.success) return { outcome: 'opened', detail: 'the call succeeds' };
  return { outcome: 'unexpected', detail: 'the call did NOT revert' };
}

/** A transport-level failure worth retrying on the next RPC (not a real answer). */
export const isRetryable = (r) => !r || typeof r !== 'object' || (r.error && !revertData(r.error)) || (!r.error && typeof r.result !== 'string');

/** Build the eth_call params for a call check. */
export function callParams(check, tx) {
  const callObj = { from: check.from, to: ADDR.delegationManager, data: tx.input, gas: tx.gas };
  const params = [callObj, check.block === 'latest' ? 'latest' : hex(check.block)];
  if (check.overrides) params.push(check.overrides);
  return params;
}

/** Require that the fetched transaction really is the agent's redemption on the DelegationManager. */
export function checkRedemptionTx(tx3, tx5) {
  const low = (s) => String(s ?? '').toLowerCase();
  if (!tx5 || !tx5.input || !tx5.gas) return 'the agent\'s redemption transaction could not be read';
  if (low(tx5.to) !== low(ADDR.delegationManager)) return 'the redemption is not addressed to MetaMask\'s DelegationManager';
  if (low(tx5.from) !== low(ADDR.agent)) return 'the redemption was not sent by the agent';
  if (!tx3 || low(tx3.input) !== low(tx5.input)) return 'the reverted attempt (T3) and the payment (T5) do not carry the same calldata';
  return null;
}

/** verdictTrue(address carrier, bytes32 caseKey) calldata. */
export function verdictTrueCalldata(carrier, caseKey) {
  return SEL.verdictTrue + carrier.toLowerCase().replace(/^0x/, '').padStart(64, '0') + caseKey.replace(/^0x/, '').toLowerCase();
}

/** caseKey(uint256 genlayerChainId, address caseContract) calldata. */
export function caseKeyCalldata(chainId, contract) {
  return SEL.caseKey + BigInt(chainId).toString(16).padStart(64, '0') + contract.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

/** Classify the FALSE-case check from its three reads. */
export function classifyFalseCase({ verdict, caseKeyResult, verdictTrueResult }) {
  if (!verdict || typeof verdict.verdict !== 'string') return { outcome: 'error', detail: 'GenLayer verdict could not be read' };
  if (typeof caseKeyResult !== 'string' || caseKeyResult.toLowerCase() !== CASE_KEY.falseCase) return { outcome: 'error', detail: 'case key read from the enforcer does not match' };
  if (typeof verdictTrueResult !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(verdictTrueResult)) return { outcome: 'error', detail: 'verdictTrue could not be read' };
  const posted = BigInt(verdictTrueResult) !== 0n;
  if (verdict.status === 'resolved' && verdict.verdict === 'FALSE' && !posted) {
    return { outcome: 'refused', detail: 'GenLayer says FALSE (resolved); nothing is posted for this case on Sepolia (verdictTrue = false)' };
  }
  return { outcome: 'unexpected', detail: `GenLayer verdict ${verdict.status}/${verdict.verdict}, verdictTrue = ${posted}` };
}

/**
 * Run every check. `rpcFor(url)` returns an async (method, params) => raw JSON-RPC body (it may throw).
 * `readFalseVerdict()` returns the parsed get_verdict of the FALSE case (read-only gen_call).
 * `onResult(check, result)` is called as each check finishes. Sends nothing.
 */
export async function runChecks({ rpcFor, readFalseVerdict, onResult = () => {}, rpcs = SEPOLIA_RPCS }) {
  const ask = async (method, params) => {
    let last = null;
    for (const url of rpcs) {
      try {
        const r = await rpcFor(url)(method, params);
        if (!isRetryable(r)) return { response: r, url };
        last = { response: r, url };
      } catch (e) { last = { response: { error: { message: e.message || String(e) } }, url }; }
    }
    return last ?? { response: null, url: null };
  };
  const results = [];
  const [{ response: r3 }, { response: r5 }] = await Promise.all([ask('eth_getTransactionByHash', [TX.T3]), ask('eth_getTransactionByHash', [TX.T5])]);
  const txProblem = checkRedemptionTx(r3?.result, r5?.result);
  for (const check of CHECKS) {
    let result;
    if (check.kind === 'call') {
      if (txProblem) result = { outcome: 'error', detail: txProblem };
      else {
        const { response, url } = await ask('eth_call', callParams(check, r5.result));
        result = { ...classify(check, response), rpc: url };
      }
    } else {
      try {
        const verdict = await readFalseVerdict();
        const { response: ck } = await ask('eth_call', [{ to: ADDR.enforcer, data: caseKeyCalldata(4221, ADDR.falseCase) }, 'latest']);
        const { response: vt, url } = await ask('eth_call', [{ to: ADDR.enforcer, data: verdictTrueCalldata(ADDR.carrier, CASE_KEY.falseCase) }, 'latest']);
        result = { ...classifyFalseCase({ verdict, caseKeyResult: ck?.result, verdictTrueResult: vt?.result }), rpc: url };
      } catch (e) { result = { outcome: 'error', detail: e.message || String(e) }; }
    }
    results.push({ id: check.id, ...result });
    onResult(check, result);
  }
  return results;
}

/** Text for an outcome badge. */
export function outcomeLabel(outcome) {
  return ({ refused: 'Refused ✓', opened: 'Goes through ✓ (control)', unexpected: 'Unexpected ✗', error: 'Could not check' })[outcome] ?? 'Could not check';
}
