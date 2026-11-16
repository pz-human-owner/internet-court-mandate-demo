// Offline unit tests: no network, no keys from anywhere but generatePrivateKey().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, parseAbi, parseEther, getAddress, recoverTypedDataAddress, toFunctionSelector } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getSmartAccountsEnvironment, signDelegation } from '@metamask/smart-accounts-kit';
import { SIGNABLE_DELEGATION_TYPED_DATA, decodeDelegations } from '@metamask/smart-accounts-kit/utils';
import {
  buildEscrowDelegation, caseSalt, decideSettlement, parseVerdict, redeemCalldata, disableCalldata, settle, SAMPLE_CASE,
} from '../src/court-escrow.mjs';

const env = getSmartAccountsEnvironment(11155111);
const principal = getAddress('0x1111111111111111111111111111111111111111');
const clerk = getAddress('0x2222222222222222222222222222222222222222');
const agent = getAddress('0x3333333333333333333333333333333333333333');
const amountWei = parseEther('0.001');
const expiresAt = 2_000_000_000;
const base = { environment: env, principal, clerk, agent, amountWei, expiresAt, caseContract: SAMPLE_CASE };
const fakeSigned = (d) => ({ ...d, signature: '0x' + '11'.repeat(65) });
const enforcer = (name) => env.caveatEnforcers[name].toLowerCase();

test('caseSalt is deterministic and case-specific', () => {
  assert.equal(caseSalt(SAMPLE_CASE), caseSalt(SAMPLE_CASE.toLowerCase()));
  assert.notEqual(caseSalt(SAMPLE_CASE), caseSalt('0x0000000000000000000000000000000000000001'));
  assert.notEqual(caseSalt(SAMPLE_CASE, 4221), caseSalt(SAMPLE_CASE, 61999));
  assert.throws(() => caseSalt('nope'));
});

test('parseVerdict reads the get_verdict JSON shape', () => {
  const v = parseVerdict(JSON.stringify({ status: 'resolved', verdict: 'TRUE', reasoning: 'ok', quote: 'q' }));
  assert.deepEqual(v, { status: 'resolved', verdict: 'TRUE', reasoning: 'ok' });
  assert.throws(() => parseVerdict('null'));
});

test('decideSettlement: only a resolved TRUE inside the window redeems', () => {
  const w = { nowSec: 100, expiresAt: 200 };
  assert.equal(decideSettlement({ status: 'resolved', verdict: 'TRUE' }, w).action, 'REDEEM');
  assert.equal(decideSettlement({ status: 'resolved', verdict: 'FALSE' }, w).action, 'REFUSE');
  assert.equal(decideSettlement({ status: 'resolved', verdict: 'UNDETERMINED' }, w).action, 'REFUSE');
  assert.equal(decideSettlement({ status: 'submitted', verdict: '' }, w).action, 'WAIT');
  assert.equal(decideSettlement({ status: 'open', verdict: '' }, w).action, 'WAIT');
  assert.equal(decideSettlement({ status: 'resolved', verdict: 'TRUE' }, { nowSec: 200, expiresAt: 200 }).action, 'EXPIRED');
  assert.throws(() => decideSettlement({ status: 'resolved', verdict: 'MAYBE' }, w));
});

test('escrow delegation: delegator, delegate, salt and on-chain caveats', () => {
  const d = buildEscrowDelegation(base);
  assert.equal(d.delegator, principal);
  assert.equal(d.delegate, clerk);
  assert.equal(BigInt(d.salt), BigInt(caseSalt(SAMPLE_CASE)));
  const used = d.caveats.map((c) => c.enforcer.toLowerCase());
  for (const name of ['NativeTokenTransferAmountEnforcer', 'ExactExecutionEnforcer', 'RedeemerEnforcer', 'LimitedCallsEnforcer', 'TimestampEnforcer']) {
    assert.ok(used.includes(enforcer(name)), `missing ${name}`);
  }
  // Redeemer terms carry the clerk address; timestamp terms end with expiresAt.
  const red = d.caveats.find((c) => c.enforcer.toLowerCase() === enforcer('RedeemerEnforcer'));
  assert.ok(red.terms.toLowerCase().includes(clerk.slice(2).toLowerCase()));
  const ts = d.caveats.find((c) => c.enforcer.toLowerCase() === enforcer('TimestampEnforcer'));
  assert.equal(BigInt('0x' + ts.terms.slice(-32)), BigInt(expiresAt));
  // Exact execution terms pin the agent as target.
  const ex = d.caveats.find((c) => c.enforcer.toLowerCase() === enforcer('ExactExecutionEnforcer'));
  assert.ok(ex.terms.toLowerCase().includes(agent.slice(2).toLowerCase()));
});

test('escrow delegation rejects bad input', () => {
  assert.throws(() => buildEscrowDelegation({ ...base, amountWei: 0n }));
  assert.throws(() => buildEscrowDelegation({ ...base, expiresAt: 0 }));
  assert.throws(() => buildEscrowDelegation({ ...base, environment: undefined }));
});

test('EIP-712 delegation signature recovers to the signer (offline)', async () => {
  const key = generatePrivateKey();
  const owner = privateKeyToAccount(key);
  const d = buildEscrowDelegation({ ...base, principal: owner.address });
  const signature = await signDelegation({ privateKey: key, delegation: d, delegationManager: env.DelegationManager, chainId: 11155111 });
  const recovered = await recoverTypedDataAddress({
    domain: { name: 'DelegationManager', version: '1', chainId: 11155111, verifyingContract: env.DelegationManager },
    types: SIGNABLE_DELEGATION_TYPED_DATA, primaryType: 'Delegation',
    message: { ...d, salt: BigInt(d.salt) }, signature,
  });
  assert.equal(recovered, owner.address);
});

test('redeem calldata targets redeemDelegations with the signed delegation', () => {
  const signed = fakeSigned(buildEscrowDelegation(base));
  const data = redeemCalldata(signed, { agent, amountWei });
  const abi = parseAbi(['function redeemDelegations(bytes[] permissionContexts, bytes32[] modes, bytes[] executionCallDatas)']);
  const { functionName, args } = decodeFunctionData({ abi, data });
  assert.equal(functionName, 'redeemDelegations');
  assert.equal(args[0].length, 1);
  const chain = decodeDelegations(args[0][0]);
  assert.equal(chain.length, 1);
  assert.equal(getAddress(chain[0].delegate), clerk);
  assert.equal(getAddress(chain[0].delegator), principal);
  // Execution calldata = agent (20 bytes) ++ value (32 bytes) ++ empty calldata.
  assert.equal(args[2][0].toLowerCase(), (agent + amountWei.toString(16).padStart(64, '0')).toLowerCase());
  const disableSel = toFunctionSelector('disableDelegation((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))');
  assert.equal(disableCalldata(signed).slice(0, 10), disableSel);
});

test('settle: TRUE sends one redeem tx to the DelegationManager', async () => {
  const signed = fakeSigned(buildEscrowDelegation(base));
  const sent = [];
  const r = await settle({ ...base, signedDelegation: signed, nowSec: 100,
    readVerdict: async () => JSON.stringify({ status: 'resolved', verdict: 'TRUE' }),
    sendTransaction: async (tx) => { sent.push(tx); return '0xabc'; } });
  assert.equal(r.action, 'REDEEM');
  assert.equal(r.txHash, '0xabc');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, env.DelegationManager);
});

for (const [status, verdict, action] of [['resolved', 'FALSE', 'REFUSE'], ['resolved', 'UNDETERMINED', 'REFUSE'], ['submitted', '', 'WAIT']]) {
  test(`settle: ${status}/${verdict || '-'} never sends`, async () => {
    const r = await settle({ ...base, signedDelegation: fakeSigned(buildEscrowDelegation(base)), nowSec: 100,
      readVerdict: async () => JSON.stringify({ status, verdict }),
      sendTransaction: async () => { throw new Error('must not send'); } });
    assert.equal(r.action, action);
  });
}

test('settle: refuses a delegation made for a different case', async () => {
  const other = fakeSigned(buildEscrowDelegation({ ...base, caseContract: '0x0000000000000000000000000000000000000001' }));
  const r = await settle({ ...base, signedDelegation: other, nowSec: 100,
    readVerdict: async () => { throw new Error('should not even read'); },
    sendTransaction: async () => { throw new Error('must not send'); } });
  assert.equal(r.action, 'REFUSE');
});

test('settle: expired window never sends', async () => {
  const r = await settle({ ...base, signedDelegation: fakeSigned(buildEscrowDelegation(base)), nowSec: expiresAt + 1,
    readVerdict: async () => JSON.stringify({ status: 'resolved', verdict: 'TRUE' }),
    sendTransaction: async () => { throw new Error('must not send'); } });
  assert.equal(r.action, 'EXPIRED');
});
