import { spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repository = resolve(import.meta.dirname, '..');
const manifest = join(repository, 'crates/neuromorphic-adapter/Cargo.toml');

/** Native-only execution paths that never belong in the browser graph. */
export const FORBIDDEN_PACKAGES = new Set(['axum', 'cuda', 'hdf5', 'myelin-accelerator', 'tokio', 'zmq']);
/** Build tooling that compiles, generates bindings for, or locates native C/C++ libraries. */
export const NATIVE_BUILD_PACKAGES = new Set(['bindgen', 'cc', 'cmake', 'pkg-config', 'vcpkg']);
/** `-sys` crates that bind JavaScript host APIs rather than native libraries. */
export const JS_BINDING_SYS_PACKAGES = new Set(['js-sys', 'web-sys']);
/**
 * `links` keys that do not name a native library. wasm-bindgen declares one
 * only so Cargo rejects two copies of its schema in a single graph.
 */
export const NON_NATIVE_LINKS = new Map([['wasm-bindgen-shared', 'wasm_bindgen']]);
/** Cargo features that link native libraries when enabled on any package. */
export const NATIVE_FEATURES = new Set(['hdf5']);

function nativeReason(pkg) {
  if (FORBIDDEN_PACKAGES.has(pkg.name)) return 'native-only package';
  if (/hdf5/i.test(pkg.name)) return 'HDF5 is native-only (libhdf5) and must stay out of the browser bundle';
  if (NATIVE_BUILD_PACKAGES.has(pkg.name)) return 'native C/C++ build tooling';
  if (pkg.name.endsWith('-sys') && !JS_BINDING_SYS_PACKAGES.has(pkg.name)) return 'native -sys binding crate';
  if (pkg.links && NON_NATIVE_LINKS.get(pkg.name) !== pkg.links) return `links the native library "${pkg.links}"`;
  const feature = pkg.features.find((name) => NATIVE_FEATURES.has(name));
  if (feature) return `enables the native "${feature}" feature`;
  return null;
}

/**
 * Pure policy over `cargo metadata --format-version 1` output resolved for
 * `wasm32-unknown-unknown`. Returns one message per violation; an empty list
 * means the browser adapter graph is policy-clean.
 */
export function browserDependencyViolations(metadata) {
  const packagesById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const resolved = metadata.resolve.nodes.map((node) => ({ ...packagesById.get(node.id), features: node.features }));
  const violations = [];

  for (const pkg of resolved) {
    const reason = nativeReason(pkg);
    if (reason) violations.push(`${pkg.name}: ${reason}`);
  }

  const corpusIpc = resolved.find((pkg) => pkg.name === 'corpus-ipc');
  if (!corpusIpc) {
    violations.push('corpus-ipc: browser adapter graph must include the recorded corpus-ipc schema surface');
  } else if (corpusIpc.features.some((feature) => feature === 'server' || feature === 'zmq')) {
    violations.push(`corpus-ipc: browser features must not enable server or zmq: ${corpusIpc.features.join(', ')}`);
  }

  const nirRs = resolved.find((pkg) => pkg.name === 'nir-rs');
  if (!nirRs) {
    violations.push('nir-rs: browser adapter graph must include the nir-rs graph model');
  }

  return violations.sort();
}

async function main() {
  const cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo');
  const cargo = join(cargoHome, 'bin', 'cargo');
  const cargoMetadata = await stat(cargo);
  if (!cargoMetadata.isFile() || (cargoMetadata.mode & 0o111) === 0) {
    throw new Error(`expected an executable cargo binary at ${cargo}`);
  }
  const result = spawnSync(cargo, ['+1.98.1', 'metadata', '--manifest-path', manifest, '--locked', '--format-version', '1', '--filter-platform', 'wasm32-unknown-unknown'], {
    cwd: repository,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(`cargo metadata failed:\n${result.stdout}\n${result.stderr}`);
  }

  const violations = browserDependencyViolations(JSON.parse(result.stdout));
  if (violations.length > 0) {
    throw new Error(`browser adapter graph violates the native-dependency policy:\n${violations.join('\n')}`);
  }

  process.stdout.write('Browser dependency policy passed.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
