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
  assert.match(panel, /FALSE path[^<]*<\/b>|FALSE path/);
  assert.match(panel, /Simulated only/i);
  assert.doesNotMatch(panel.replace(/isn't an escrow/gi, ''), /escrow/i);
});
