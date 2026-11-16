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
  assert.match(panel, /clerk is trusted/i);
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
