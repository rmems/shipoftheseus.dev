import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import test from 'node:test';

import { browserDependencyViolations } from '../scripts/verify-browser-dependencies.mjs';

test('the resolved browser adapter graph excludes native-only execution paths', () => {
  const result = spawnSync(process.execPath, ['scripts/verify-browser-dependencies.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Browser dependency policy passed/);
});

test('the browser policy resolves dependencies only for the WASM target', async () => {
  const source = await readFile('scripts/verify-browser-dependencies.mjs', 'utf8');

  assert.match(source, /'--filter-platform', 'wasm32-unknown-unknown'/);
});

/** Minimal `cargo metadata` shape: `[name, { features, links }]` per resolved package. */
function metadata(packages) {
  const entries = packages.map(([name, { features = [], links = null } = {}]) => ({
    id: `registry+${name}`,
    name,
    links,
    features,
  }));
  return {
    packages: entries.map(({ id, name, links }) => ({ id, name, links })),
    resolve: { nodes: entries.map(({ id, features }) => ({ id, features })) },
  };
}

const browserBaseline = [
  ['neuromorphic-adapter'],
  ['corpus-ipc'],
  ['nir-rs', { features: ['serde'] }],
  ['indexmap', { features: ['default', 'serde', 'std'] }],
  ['js-sys', { features: ['default', 'std'] }],
  ['wasm-bindgen-shared', { links: 'wasm_bindgen' }],
];

test('the policy accepts the audited browser graph shape', () => {
  assert.deepEqual(browserDependencyViolations(metadata(browserBaseline)), []);
});

test('the policy rejects nir-rs with its native HDF5 feature enabled', () => {
  const graph = browserBaseline.map((entry) => (entry[0] === 'nir-rs'
    ? ['nir-rs', { features: ['hdf5', 'serde'] }]
    : entry));

  assert.deepEqual(browserDependencyViolations(metadata(graph)), [
    'nir-rs: enables the native "hdf5" feature',
  ]);
});

test('the policy rejects every HDF5 crate, not only one named exactly hdf5', () => {
  const violations = browserDependencyViolations(metadata([
    ...browserBaseline,
    ['hdf5-metno'],
    ['hdf5-metno-sys', { links: 'hdf5' }],
    ['hdf5-metno-src'],
  ]));

  assert.deepEqual(violations, [
    'hdf5-metno-src: HDF5 is native-only (libhdf5) and must stay out of the browser bundle',
    'hdf5-metno-sys: HDF5 is native-only (libhdf5) and must stay out of the browser bundle',
    'hdf5-metno: HDF5 is native-only (libhdf5) and must stay out of the browser bundle',
  ]);
});

test('the policy rejects native C linking, bindings, and build tooling', () => {
  const violations = browserDependencyViolations(metadata([
    ...browserBaseline,
    ['cc'],
    ['pkg-config'],
    ['openssl-sys'],
    ['libz-native', { links: 'z' }],
    ['web-sys'],
  ]));

  assert.deepEqual(violations, [
    'cc: native C/C++ build tooling',
    'libz-native: links the native library "z"',
    'openssl-sys: native -sys binding crate',
    'pkg-config: native C/C++ build tooling',
  ]);
});

test('the wasm-bindgen links exemption is bound to its exact package and key', () => {
  const violations = browserDependencyViolations(metadata([
    ...browserBaseline.filter(([name]) => name !== 'wasm-bindgen-shared'),
    ['wasm-bindgen-shared', { links: 'something_else' }],
  ]));

  assert.deepEqual(violations, ['wasm-bindgen-shared: links the native library "something_else"']);
});

test('the policy still requires the corpus-ipc schema surface and the nir-rs graph model', () => {
  const violations = browserDependencyViolations(metadata([
    ['neuromorphic-adapter'],
    ['corpus-ipc', { features: ['zmq'] }],
    ['zmq'],
  ]));

  assert.deepEqual(violations, [
    'corpus-ipc: browser features must not enable server or zmq: zmq',
    'nir-rs: browser adapter graph must include the nir-rs graph model',
    'zmq: native-only package',
  ]);
});
