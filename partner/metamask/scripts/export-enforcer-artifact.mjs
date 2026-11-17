// Export (or --check) the committed VerdictGateEnforcer artifact from a fresh `forge build`.
//   cd contracts && forge build && cd .. && node scripts/export-enforcer-artifact.mjs [--check]
// --check exits 1 if a fresh pinned build does not reproduce the committed bytecode/ABI/metadata.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const out = JSON.parse(readFileSync(new URL('../contracts/out/VerdictGateEnforcer.sol/VerdictGateEnforcer.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../contracts/src/VerdictGateEnforcer.sol', import.meta.url), 'utf8');
const metadata = typeof out.rawMetadata === 'string' ? out.rawMetadata : JSON.stringify(out.metadata);
const meta = JSON.parse(metadata);
const artifact = {
  contractName: 'VerdictGateEnforcer',
  sourcePath: 'contracts/src/VerdictGateEnforcer.sol',
  sourceSha256: createHash('sha256').update(source).digest('hex'),
  compiler: { solc: meta.compiler.version, evmVersion: meta.settings.evmVersion, optimizer: meta.settings.optimizer },
  abi: out.abi,
  bytecode: out.bytecode.object,
  deployedBytecode: out.deployedBytecode.object,
  rawMetadata: metadata,
};
const path = new URL('../contracts/VerdictGateEnforcer.artifact.json', import.meta.url);
const text = JSON.stringify(artifact, null, 2) + '\n';
if (process.argv.includes('--check')) {
  const committed = readFileSync(path, 'utf8');
  if (committed !== text) { console.error('artifact differs from a fresh pinned build'); process.exit(1); }
  console.log(`artifact matches fresh build (solc ${artifact.compiler.solc}, source sha256 ${artifact.sourceSha256})`);
} else {
  writeFileSync(path, text);
  console.log(`wrote contracts/VerdictGateEnforcer.artifact.json (solc ${artifact.compiler.solc})`);
}
