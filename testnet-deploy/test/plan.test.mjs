import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRADBURY, addChainParams, assertBradburyChain, assertGenesis, constructorArgs,
  createStepGate, formatGen, evmReceiptCost, PLANNED_STEPS,
  liveFeesOrAbort, sendConfirmText, shouldUnlockAfterEstimate,
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

