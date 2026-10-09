import { spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { WASM_PROFILES, profileFeatureArgs } from './wasm-profiles.mjs';

const repository = resolve(import.meta.dirname, '..');
const manifest = join(repository, 'crates/neuromorphic-adapter/Cargo.toml');

/**
 * Native-only execution paths that never belong in the browser graph:
 * ZeroMQ, the corpus-ipc Axum/Tokio server stack and its networking, CUDA,
 * FPGA acceleration, and HDF5. (`-sys` crates, `links` keys, and C/C++ build
 * tooling are rejected by the generic rules below.)
 */
export const FORBIDDEN_PACKAGES = new Set([
  'axum',
  'axum-core',
  'cuda',
  'cust',
  'hdf5',
  'hyper',
  'mio',
  'myelin-accelerator',
  'socket2',
  'tokio',
  'tokio-macros',
  'tower',
  'zeromq',
  'zmq',
]);
/** The crate whose own features and direct dependencies each profile pins. */
export const ADAPTER_CRATE = 'neuromorphic-adapter';
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
/**
 * The only `plasticity-lab` features a browser graph may enable: the
 * `limbic-critic` bridge and the forwarded `neuromod/wasm-js` entropy backend.
 */
export const PLASTICITY_LAB_BROWSER_FEATURES = new Set(['critic', 'wasm-js']);

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
 * The adapter's own enabled features (without `default`) and its direct
 * normal dependencies, by crate name. Missing for synthetic graphs without an
 * adapter node.
 */
function adapterSurface(metadata, packagesById) {
  const node = metadata.resolve.nodes.find((candidate) => packagesById.get(candidate.id)?.name === ADAPTER_CRATE);
  if (!node) return null;
  const features = (node.features ?? [])
    .filter((feature) => feature !== 'default')
    .sort((left, right) => left.localeCompare(right));
  const directDependencies = (node.deps ?? [])
    .filter((dep) => (dep.dep_kinds ?? [{ kind: null }]).some((kind) => kind.kind === null))
    .map((dep) => packagesById.get(dep.pkg)?.name ?? dep.name);
  return { features, directDependencies };
}

const byName = (left, right) => left.localeCompare(right);

/** Native-library, native-service, and native-tooling packages in the graph. */
function nativeViolations(resolved) {
  return resolved.flatMap((pkg) => {
    const reason = nativeReason(pkg);
    return reason ? [`${pkg.name}: ${reason}`] : [];
  });
}

/** The profile's `requiredCrates` / `excludedCrates`, anywhere in the graph. */
function crateViolations(resolved, requiredCrates, excludedCrates) {
  const has = (name) => resolved.some((pkg) => pkg.name === name);
  return [
    ...requiredCrates
      .filter((name) => !has(name))
      .map((name) => `${name}: required by this profile but missing from its graph`),
    ...excludedCrates.filter(has).map((name) => `${name}: must stay out of this profile's graph`),
  ];
}

/** The adapter's own enabled features and direct dependencies for the profile. */
function adapterViolations(adapter, { features, requiredDirectDependencies, excludedDirectDependencies }) {
  const violations = [];
  if (adapter && features) {
    const expected = [...features].sort(byName);
    if (adapter.features.join(',') !== expected.join(',')) {
      violations.push(`${ADAPTER_CRATE}: enables features [${adapter.features.join(', ')}], profile expects [${expected.join(', ')}]`);
    }
  }
  // Cargo spells dependency names with underscores; compare crate names that way.
  const crateKey = (name) => name.replaceAll('-', '_');
  const direct = new Set((adapter?.directDependencies ?? []).map(crateKey));
  for (const name of requiredDirectDependencies) {
    if (!direct.has(crateKey(name))) violations.push(`${name}: this profile needs it as a direct ${ADAPTER_CRATE} dependency`);
  }
  for (const name of excludedDirectDependencies) {
    if (direct.has(crateKey(name))) violations.push(`${name}: must not be a direct ${ADAPTER_CRATE} dependency in this profile`);
  }
  return violations;
}

/** corpus-ipc's `server` (Axum/Tokio) and `zmq` features never enter the browser. */
function corpusIpcViolations(resolved) {
  const corpusIpc = resolved.find((pkg) => pkg.name === 'corpus-ipc');
  if (!corpusIpc?.features.some((feature) => feature === 'server' || feature === 'zmq')) return [];
  return [`corpus-ipc: browser features must not enable server or zmq: ${corpusIpc.features.join(', ')}`];
}

function plasticityLabViolations(resolved) {
  const plasticityLab = resolved.find((pkg) => pkg.name === 'plasticity-lab');
  const extra = (plasticityLab?.features ?? []).filter((feature) => !PLASTICITY_LAB_BROWSER_FEATURES.has(feature));
  if (extra.length === 0) return [];
  return [`plasticity-lab: browser features must stay within critic and wasm-js: ${extra.join(', ')}`];
}

/**
 * Pure policy over `cargo metadata --format-version 1` output resolved for
 * `wasm32-unknown-unknown`. The native rules apply to every profile;
 * `requiredCrates` / `excludedCrates`, the adapter `features`, and its
 * `requiredDirectDependencies` / `excludedDirectDependencies` come from the
 * profile (see scripts/wasm-profiles.mjs). Returns sorted messages; empty
 * means clean.
 */
export function browserDependencyViolations(
  metadata,
  {
    requiredCrates = [],
    excludedCrates = [],
    features,
    requiredDirectDependencies = [],
    excludedDirectDependencies = [],
  } = {},
) {
  const packagesById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const resolved = metadata.resolve.nodes.map((node) => ({ ...packagesById.get(node.id), features: node.features }));
  const adapter = adapterSurface(metadata, packagesById);
  return [
    ...nativeViolations(resolved),
    ...crateViolations(resolved, requiredCrates, excludedCrates),
    ...adapterViolations(adapter, { features, requiredDirectDependencies, excludedDirectDependencies }),
    ...corpusIpcViolations(resolved),
    ...plasticityLabViolations(resolved),
  ].sort(byName);
}

async function main() {
  const cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo');
  const cargo = join(cargoHome, 'bin', 'cargo');
  const cargoMetadata = await stat(cargo);
  if (!cargoMetadata.isFile() || (cargoMetadata.mode & 0o111) === 0) {
    throw new Error(`expected an executable cargo binary at ${cargo}`);
  }

  const failures = [];
  for (const profile of WASM_PROFILES) {
    const result = spawnSync(cargo, ['+1.98.1', 'metadata', '--manifest-path', manifest, '--locked', '--format-version', '1', '--filter-platform', 'wasm32-unknown-unknown', ...profileFeatureArgs(profile)], {
      cwd: repository,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`cargo metadata failed for the ${profile.name} profile:\n${result.stdout}\n${result.stderr}`);
    }
    for (const violation of browserDependencyViolations(JSON.parse(result.stdout), profile)) {
      failures.push(`[${profile.name}] ${violation}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`browser adapter graph violates the native-dependency policy:\n${failures.join('\n')}`);
  }

  process.stdout.write(`Browser dependency policy passed for profiles: ${WASM_PROFILES.map((profile) => profile.name).join(', ')}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
