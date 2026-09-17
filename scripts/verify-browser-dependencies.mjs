import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const repository = resolve(import.meta.dirname, '..');
const manifest = join(repository, 'crates/neuromorphic-adapter/Cargo.toml');
const result = spawnSync('cargo', ['+1.98.1', 'metadata', '--manifest-path', manifest, '--locked', '--format-version', '1'], {
  cwd: repository,
  encoding: 'utf8',
});

if (result.status !== 0) {
  throw new Error(`cargo metadata failed:\n${result.stdout}\n${result.stderr}`);
}

const metadata = JSON.parse(result.stdout);
const packagesById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
const resolved = metadata.resolve.nodes.map((node) => ({ ...packagesById.get(node.id), features: node.features }));
const forbidden = new Set(['axum', 'cuda', 'hdf5', 'myelin-accelerator', 'tokio', 'zmq']);
const found = resolved.filter((pkg) => forbidden.has(pkg.name)).map((pkg) => pkg.name).sort();
if (found.length > 0) {
  throw new Error(`browser adapter graph contains native-only packages: ${found.join(', ')}`);
}

const corpusIpc = resolved.find((pkg) => pkg.name === 'corpus-ipc');
if (!corpusIpc) throw new Error('browser adapter graph must include the recorded corpus-ipc schema surface.');
if (corpusIpc.features.some((feature) => feature === 'server' || feature === 'zmq')) {
  throw new Error(`corpus-ipc browser features must not enable server or zmq: ${corpusIpc.features.join(', ')}`);
}

process.stdout.write('Browser dependency policy passed.\n');
