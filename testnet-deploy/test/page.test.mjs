// Static checks of the MetaMask settlement panel in index.html (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('<section class="settle" id="mm-settle"');
const panel = html.slice(start, html.indexOf('</section>', start));

test('settlement panel exists, after the live verdict and before the optional MetaMask deploy section', () => {
  assert.ok(start > 0);
  assert.ok(start > html.indexOf('id="v-recorded"'));
  assert.ok(start < html.indexOf('<details id="mm">'));
  assert.match(panel, /aria-labelledby="mm-settle-h"/);
});

test('panel is read-only: no buttons, inputs or scripts', () => {
  assert.doesNotMatch(panel, /<(button|input|form|script)\b/i);
});

test('panel links the three live Sepolia transactions and live-result.json', () => {
  for (const h of [
    '0x0897bcffcc2afd00de69936ab89de6613c4fc1bccb8b2b4130c4092ea79ca51a',
    '0xef5104a490e68ae7078b396beaab9080922301fdf2caad69da0aed27218881c3',
    '0x64a3f537451b275f12421f52fea886eb89dd666fbf9f9ee697a64d1f423b2e1f',
  ]) assert.ok(panel.includes(`https://sepolia.etherscan.io/tx/${h}`), h);
  assert.match(panel, /partner\/metamask\/live-result\.json/);
});

test('panel carries the honesty notes from the README', () => {
  assert.match(panel, /clerk is trusted in A–C/i);
  assert.match(panel, /isn't an escrow/i);
  assert.match(panel, /same operator held/i);
  assert.match(panel, /FALSE or UNDETERMINED verdict/);
  assert.match(panel, /simulated only/i);
  assert.doesNotMatch(panel.replace(/isn't an escrow/gi, ''), /escrow/i);
});

test('panel has Refusal on Sepolia rows with the two reverted transactions and the refusal record', () => {
  const start = panel.indexOf('id="refusal-rows"');
  assert.ok(start > 0);
  const rows = panel.slice(start, panel.indexOf('</tbody>', start));
  assert.match(rows, /Refusal on Sepolia/);
  for (const h of [
    '0x323887a077ab6f8be8226ab47f259f7a1b6562df2627db31f8ee5e592c33528b',
    '0x28c9837c4137efd47ef85cac8940499cb792dfbc53b8860d9a41b3f92755d640',
  ]) assert.ok(rows.includes(`https://sepolia.etherscan.io/tx/${h}`), h);
  assert.equal((rows.match(/Reverted on-chain/g) ?? []).length, 2);
  assert.match(rows, /InvalidDelegate/);
  assert.match(rows, /allowance-exceeded/);
  assert.match(rows, /no transaction/);
  assert.match(panel, /partner\/metamask\/live-refusal-result\.json/);
});

test('honesty notes match the refusal run: live now vs still simulated', () => {
  assert.match(panel, /Now live on Sepolia, not just simulated/);
  assert.match(panel, /Still simulated only:<\/b> a live FALSE or UNDETERMINED verdict/);
  assert.match(panel, /redemption after expiry/);
  assert.doesNotMatch(panel, /Simulated only:<\/b> the FALSE path and the on-chain rejections/);
});

test('SKILL.md is linked from the hero and the footer', () => {
  const skill = 'https://github.com/pz-human-owner/internet-court-mandate-demo/blob/main/SKILL.md';
  const hero = html.slice(html.indexOf('<h1>'), html.indexOf('<h2>'));
  assert.ok(hero.includes(skill));
  const footer = html.slice(html.indexOf('<pre id="log">'));
  assert.ok(footer.includes(skill));
  assert.ok(footer.includes('#refusal-rows'));
});

test('page is not tied to unrelated products', () => {
  assert.doesNotMatch(html, /lens ?closer|lens labs/i);
});

test('refusal badge and notes do not call the clerk\'s repeat redemption unauthorized', () => {
  assert.doesNotMatch(html, /unauthori[sz]ed/i);
  assert.match(panel, /an outsider's redemption and a repeat redemption both reverted/);
  assert.match(panel, /held 0 ETH at the time, so R1 shows that caller check, not a funded payment being blocked/);
  assert.match(panel, /<code>exactCalldata<\/code>/);
  assert.match(panel, /requires empty calldata; no function call/);
  assert.doesNotMatch(panel, /cannot call a contract/);
});

test('panel has On-chain verdict check rows: five Sepolia transactions, the enforcer and its records', () => {
  const s = panel.indexOf('id="onchain-rows"');
  assert.ok(s > panel.indexOf('id="refusal-rows"'));
  const rows = panel.slice(s, panel.indexOf('</tbody>', s));
  assert.match(rows, /On-chain verdict check on Sepolia/);
  for (const h of [
    '0x159d965f9ec998527090f4db4be6b52cba3c30914a0770eb7d09f9ec2ceae181',
    '0x15aaf077f0459bee10c4e3665e2bbe31cfc594c348eb629a6c677359a3439f3f',
    '0x4ced2add55d30f2207b0c50e77c75fb2cb55e4245e46be745afe3a616abba90d',
    '0xfb9090a04b906512faf466c52a33c4c7ad4257429a1abf777723c6f3deac2423',
    '0xb5dd287b80fcb96bffefdbcaf1819652d92433ac78ad7032f7e9bf2be488955d',
  ]) assert.ok(rows.includes(`https://sepolia.etherscan.io/tx/${h}`), h);
  assert.equal((rows.match(/Reverted on-chain/g) ?? []).length, 1);
  assert.match(rows, /VerdictGateEnforcer:verdict-not-true/);
  assert.ok(rows.includes('https://sepolia.etherscan.io/address/0xfEf947Be0F73A95D2A29f156D5cDfC2692Da074a'));
  assert.ok(rows.includes('https://repo.sourcify.dev/11155111/0xfEf947Be0F73A95D2A29f156D5cDfC2692Da074a'));
  assert.match(panel, /partner\/metamask\/live-onchain-check-result\.json/);
  assert.match(panel, /contracts\/src\/VerdictGateEnforcer\.sol/);
  const footer = html.slice(html.indexOf('<pre id="log">'));
  assert.ok(footer.includes('#onchain-rows'));
});

test('on-chain check wording names who is still trusted and avoids trustless/oracle wording', () => {
  assert.match(panel, /<b>The carrier is a trusted off-chain writer\.<\/b>/);
  // A post is final, the principal's remedies are named, and one post opens every matching delegation.
  assert.match(panel, /A posted TRUE cannot be undone/);
  assert.match(panel, /<code>disableDelegation<\/code>\) or let it expire/);
  assert.match(panel, /One post opens every delegation that names that carrier and that case; the once-only limit is per delegation, not per case\./);
  assert.match(panel, /carrier is trusted in T1–T5/);
  assert.match(panel, /No contract on Ethereum Sepolia checks GenLayer itself/);
  assert.doesNotMatch(panel, /trustless|trust-minimi[sz]ed|\boracle\b|reads? GenLayer/i);
});

test('panel has the live FALSE verdict rows: three GenLayer transactions, read-only refusal, committed record', () => {
  const s = panel.indexOf('id="false-rows"');
  assert.ok(s > panel.indexOf('id="onchain-rows"'));
  const rows = panel.slice(s, panel.indexOf('</tbody>', s));
  for (const id of [
    '0x6829b7152b048029102448a6efec269738650e6991ede3b8697396dac2579260',
    '0x1bff12f7ef76bf094dc533ed0f4570fff6b6eab52c3e523d32f42a670b6931d7',
    '0x4b2b38cd79433d25fde027dcf6de853f0a6339d3d170b9131abe0a13565e7127',
  ]) assert.ok(rows.includes(`https://explorer-bradbury.genlayer.com/tx/${id}`), id);
  for (const h of [
    '0x5ad88e8af64f0b2316c69e58cdf599f75429b72f65e1120528384a17154285f2',
    '0x1deacb11dcae3909a958a20da950618c132d637693381e88bd41306e39b9237f',
    '0x02dc4fb3898e1db9eb2a3636fb1051a95216e86e25a39674e1e9821c3a5d1900',
  ]) assert.ok(rows.includes(`https://scan.testnet-chain.genlayer.com/tx/${h}`), h);
  assert.match(rows, /Verdict FALSE/);
  assert.match(rows, /4 of 5 validators matched the leader's result, 1 timed out/);
  assert.match(rows, /VerdictGateEnforcer:verdict-not-true/);
  assert.doesNotMatch(rows, /sepolia\.etherscan\.io\/tx/); // no Sepolia transaction for the FALSE case
  assert.match(panel, /partner\/metamask\/live-false-check-result\.json/);
  const footer = html.slice(html.indexOf('<pre id="log">'));
  assert.ok(footer.includes('#false-rows'));
});
