// Bundles src/app.mjs (+ genlayer-js) into dist/app.js and copies the contract and sample
// case next to it, so the page is fully self-contained (no CDN scripts).
import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const demo = dirname(here);
const dist = join(here, 'dist');
await mkdir(dist, { recursive: true });
await build({ entryPoints: [join(here, 'src/app.mjs')], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: join(dist, 'app.js'), logLevel: 'info' });
await copyFile(join(here, 'index.html'), join(dist, 'index.html'));
await copyFile(join(demo, 'contracts/MandateVerdict.py'), join(dist, 'MandateVerdict.py'));
await copyFile(join(demo, 'examples/sample_mandate.json'), join(dist, 'sample_mandate.json'));
await copyFile(join(demo, 'examples/sample_deliverables.json'), join(dist, 'sample_deliverables.json'));
console.log('Built', dist);
