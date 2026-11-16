import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRADBURY, addChainParams, assertBradburyChain, assertGenesis, constructorArgs,
  createStepGate, formatGen, evmReceiptCost, PLANNED_STEPS,
  liveFeesOrAbort, sendConfirmText, shouldUnlockAfterEstimate,
  DEFAULT_CONTRACT, VIEW_FUNCTIONS, isAddress, viewContractAddress, parseVerdict, parseCase,
  RECORDED_RUN, recordedTxLinks, withTimeout, explorerAddress,
} from '../src/plan.mjs';

const ME = '0x1111111111111111111111111111111111111111';
const base = { agent: ME, mandate: 'm', guidelines: 'g', evidence_url: 'https://docs.metamask.io/x/', allow_subpaths: false };

test('chain params match documented Bradbury values', () => {
  assert.equal(Number.parseInt(BRADBURY.chainIdHex, 16), 4221);
  const p = addChainParams();
  assert.equal(p.chainId, '0x107d');
  assert.deepEqual(p.rpcUrls, ['https://rpc.testnet-chain.genlayer.com']);
  assert.equal(p.nativeCurrency.symbol, 'GEN');
});

test('chain and genesis guards', () => {
  assert.doesNotThrow(() => assertBradburyChain('0x107d'));
  assert.doesNotThrow(() => assertBradburyChain(4221));
  assert.throws(() => assertBradburyChain('0xaa36a7'), /expected 4221/);
  assert.doesNotThrow(() => assertGenesis(BRADBURY.genesisHash.toUpperCase().replace('0X', '0x')));
  assert.throws(() => assertGenesis('0x' + '00'.repeat(32)), /Genesis mismatch/);
});

test('constructor args keep contract order and validate', () => {
  assert.deepEqual(constructorArgs(base), [ME, 'm', 'g', 'https://docs.metamask.io/x/', false]);
  assert.throws(() => constructorArgs({ ...base, agent: 'bob' }), /agent/);
  assert.throws(() => constructorArgs({ ...base, evidence_url: 'http://x' }), /https/);
  assert.throws(() => constructorArgs({ ...base, allow_subpaths: 'no' }), /boolean/);
  assert.throws(() => constructorArgs({ ...base, mandate: ' ' }), /mandate/);
});

test('step gate: in order, once each', () => {
  assert.deepEqual(PLANNED_STEPS.map((s) => s.id), ['deploy', 'submit', 'verdict']);
  const g = createStepGate();
  assert.throws(() => g.claim('verdict'), /deploy must finish/);
  g.claim('deploy');
  assert.throws(() => g.claim('deploy'), /already sent/);
  g.claim('submit');
  g.claim('verdict');
  assert.throws(() => g.claim('verdict'), /already sent/);
  assert.throws(() => g.claim('appeal'), /Unknown step/);
});

test('formatting and receipt cost', () => {
  assert.equal(formatGen(100000000000010352n), '0.100000000000010352 GEN');
  assert.equal(formatGen(0n), '0 GEN');
  assert.equal(evmReceiptCost({ gasUsed: '0x5208', effectiveGasPrice: 250000000n }), 21000n * 250000000n);
});

test('liveFeesOrAbort returns a fresh estimate and aborts clearly on failure', async () => {
  const live = await liveFeesOrAbort(async () => ({ feeValue: 100000000000010352n, distribution: { ops: 1n }, policy: 'p' }));
  assert.equal(live.feeValue, 100000000000010352n);
  assert.deepEqual(live.distribution, { ops: 1n });
  assert.equal(live.policy, 'p');

  await assert.rejects(
    () => liveFeesOrAbort(async () => { throw new Error('rpc down'); }),
    (err) => err.code === 'FEE_ESTIMATE_ABORTED' && /send aborted/.test(err.message) && /rpc down/.test(err.message),
  );
  await assert.rejects(
    () => liveFeesOrAbort(async () => ({ policy: 'p' })),
    (err) => err.code === 'FEE_ESTIMATE_ABORTED' && /no feeValue/.test(err.message),
  );
});

test('send confirm text shows the live deposit; re-estimate does not unlock again', () => {
  const text = sendConfirmText('Step 1 of 3: deploy MandateVerdict', ME, 100000000000010352n);
  assert.match(text, /Step 1 of 3: deploy MandateVerdict/);
  assert.match(text, /0\.100000000000010352 GEN/);
  assert.match(text, new RegExp(ME));
  assert.equal(shouldUnlockAfterEstimate(false), true);
  assert.equal(shouldUnlockAfterEstimate(true), false);
});

test('default contract is the deployed Bradbury sample case', () => {
  assert.equal(DEFAULT_CONTRACT, '0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B');
  assert.ok(isAddress(DEFAULT_CONTRACT));
  assert.equal(explorerAddress(DEFAULT_CONTRACT), 'https://scan.testnet-chain.genlayer.com/address/0x07E2A9e0341266E87e539E8a18B9Ed2611612F8B');
  assert.deepEqual([...VIEW_FUNCTIONS], ['get_status', 'get_verdict', 'get_case']);
  assert.equal(RECORDED_RUN.contract, DEFAULT_CONTRACT);
});

test('viewContractAddress: ?contract= override, otherwise the default', () => {
  assert.deepEqual(viewContractAddress(''), { address: DEFAULT_CONTRACT, isDefault: true });
  assert.deepEqual(viewContractAddress('?contract=' + ME), { address: ME, isDefault: false });
  assert.deepEqual(viewContractAddress('?contract=' + DEFAULT_CONTRACT.toLowerCase()), { address: DEFAULT_CONTRACT.toLowerCase(), isDefault: true });
  for (const bad of ['?contract=0x123', '?contract=<script>', '?contract=', '?other=1', '?contract=' + ME + 'ff']) {
    assert.deepEqual(viewContractAddress(bad), { address: DEFAULT_CONTRACT, isDefault: true }, bad);
  }
  assert.equal(isAddress(undefined), false);
  assert.equal(isAddress('0x' + 'g'.repeat(40)), false);
});

test('parseVerdict / parseCase normalize the contract JSON views', () => {
  const v = parseVerdict('{"status": "resolved", "verdict": "TRUE", "reasoning": "r", "quote": "q", "source_url": "https://x.io/", "last_error": "", "attempts": 1}');
  assert.deepEqual(v, { status: 'resolved', verdict: 'TRUE', reasoning: 'r', quote: 'q', source_url: 'https://x.io/', last_error: '', attempts: 1 });
  assert.equal(parseVerdict({ status: 'submitted' }).verdict, '');
  assert.throws(() => parseVerdict('not json'), /did not return JSON/);
  assert.throws(() => parseVerdict('[1]'), /did not return an object/);
  const c = parseCase(JSON.stringify({ principal: ME, agent: ME, mandate: 'm', allow_subpaths: false, attempts: 2 }));
  assert.equal(c.mandate, 'm');
  assert.equal(c.allow_subpaths, false);
  assert.equal(c.attempts, 2);
  assert.equal(c.deliverable, '');
});

test('recorded run fallback matches the proof/ table', () => {
  assert.equal(RECORDED_RUN.verdict, 'TRUE');
  const links = recordedTxLinks();
  assert.deepEqual(links.map((l) => l.step), ['deploy', 'submit_deliverable', 'request_verdict']);
  for (const l of links) {
    assert.match(l.evmHash, /^0x[0-9a-f]{64}$/);
    assert.equal(l.explorer, `https://scan.testnet-chain.genlayer.com/tx/${l.evmHash}`);
  }
  assert.equal(links[0].evmHash, '0x5572f1d3140aa180df8dbe5df207ba1f9cbdff26c86651086b3e72b636509d09');
});

test('withTimeout rejects a hung read and passes a fast one through', async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 50), 7);
  await assert.rejects(() => withTimeout(new Promise(() => {}), 20, 'get_verdict'), /get_verdict timed out after 20 ms/);
});
