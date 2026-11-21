// Network-free unit tests for the direct-mode proof runner helpers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { getAddress, isAddress } from 'viem';
import {
  BRADBURY_CHAIN_ID,
  BRADBURY_GHOST_CODE_HASH,
  FEE,
  buildDirectDelegation,
  caseSalt,
  estimateBudget,
  formatGen,
  frameworkEnvironment,
  gateTerms,
  HISTORICAL_IC_DEPOSIT,
  redeemCalldata,
} from './direct-proof.mjs';

const GATE = getAddress('0x1111111111111111111111111111111111111111');
const PRINCIPAL = getAddress('0x2222222222222222222222222222222222222222');
const AGENT = getAddress('0x3333333333333333333333333333333333333333');
const CASE_T = getAddress('0x4444444444444444444444444444444444444444');
const CASE_F = getAddress('0x5555555555555555555555555555555555555555');

test('official DF addresses are checksummed 0x addresses', () => {
  const env = frameworkEnvironment();
  for (const k of ['DelegationManager', 'EntryPoint', 'SimpleFactory']) {
    assert.ok(isAddress(env[k]), k);
  }
  assert.ok(isAddress(env.implementations.HybridDeleGatorImpl));
  for (const k of ['ExactExecutionEnforcer', 'LimitedCallsEnforcer', 'RedeemerEnforcer', 'TimestampEnforcer']) {
    assert.ok(isAddress(env.caveatEnforcers[k]), k);
  }
});

test('ghost code hash is a 32-byte hex value', () => {
  assert.match(BRADBURY_GHOST_CODE_HASH, /^0x[0-9a-fA-F]{64}$/);
});

test('case salt is deterministic and case-specific', () => {
  const a = caseSalt(CASE_T);
  const b = caseSalt(CASE_T);
  const c = caseSalt(CASE_F);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(caseSalt(CASE_T, 1), a);
});

test('gate terms are abi.encode(address) (32 bytes, no dirty high bits)', () => {
  const terms = gateTerms(CASE_T);
  assert.equal(terms.length, 2 + 64);
  assert.equal(terms.slice(0, 26), '0x000000000000000000000000');
  assert.equal(getAddress('0x' + terms.slice(-40)), CASE_T);
});

test('direct delegation names the gate, the case, and the agent as sole redeemer', () => {
  const env = frameworkEnvironment();
  const expiresAt = 2_000_000_000;
  const d = buildDirectDelegation({
    environment: env,
    gate: GATE,
    principal: PRINCIPAL,
    agent: AGENT,
    amountWei: FEE,
    expiresAt,
    caseContract: CASE_T,
  });
  assert.equal(getAddress(d.delegator), PRINCIPAL);
  assert.equal(getAddress(d.delegate), AGENT);
  assert.equal(d.salt, caseSalt(CASE_T));
  assert.equal(getAddress(d.caveats[0].enforcer), GATE);
  assert.equal(d.caveats[0].terms, gateTerms(CASE_T));
  const redeemers = d.caveats.filter((c) => getAddress(c.enforcer) === getAddress(env.caveatEnforcers.RedeemerEnforcer));
  assert.equal(redeemers.length, 1);
  assert.ok(redeemers[0].terms.toLowerCase().includes(AGENT.slice(2).toLowerCase()));
  const data = redeemCalldata({ ...d, signature: '0x' + '00'.repeat(65) }, { agent: AGENT, amountWei: FEE });
  assert.match(data, /^0x[0-9a-fA-F]+$/);
  assert.ok(data.length > 10);
});

test('two cases get two different unsigned delegations', () => {
  const env = frameworkEnvironment();
  const expiresAt = 2_000_000_000;
  const a = buildDirectDelegation({ environment: env, gate: GATE, principal: PRINCIPAL, agent: AGENT, amountWei: FEE, expiresAt, caseContract: CASE_T });
  const b = buildDirectDelegation({ environment: env, gate: GATE, principal: PRINCIPAL, agent: AGENT, amountWei: FEE, expiresAt, caseContract: CASE_F });
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.caveats[0].terms, b.caveats[0].terms);
});

test('5 GEN covers the peak budget at the 0.1 GEN deposit', () => {
  const b = estimateBudget({ depositPerIc: HISTORICAL_IC_DEPOSIT });
  assert.equal(b.icTxs, 6);
  assert.ok(b.fiveIsEnough);
  assert.ok(b.peak < b.budget);
  assert.ok(b.recommended < b.budget);
  assert.match(formatGen(b.peak), /GEN$/);
  assert.equal(BRADBURY_CHAIN_ID, 4221);
});
