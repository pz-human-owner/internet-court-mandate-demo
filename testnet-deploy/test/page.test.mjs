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

test('on-chain check wording names who is still trusted and never claims trustless', () => {
  assert.match(panel, /<b>Not trustless\.<\/b>/);
  assert.match(panel, /trusted relayer, not an oracle/);
  assert.match(panel, /carrier is trusted in T1–T5/);
  assert.match(panel, /cannot read GenLayer/);
  assert.doesNotMatch(panel.replace(/Not trustless/g, ''), /trustless|trust-minimi[sz]ed|oracle-free|decentrali[sz]ed oracle/i);
  assert.doesNotMatch(panel.replace(/not an oracle|no oracle between them/g, ''), /\boracle\b/i);
});
