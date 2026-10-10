import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import test from 'node:test';

import { browserDependencyViolations } from '../scripts/verify-browser-dependencies.mjs';
import { WASM_PROFILES, profileFeatureArgs } from '../scripts/wasm-profiles.mjs';

const profile = (name) => WASM_PROFILES.find((candidate) => candidate.name === name);

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

/**
 * Minimal `cargo metadata` shape: `[name, { features, links, deps, devDeps }]`
 * per resolved package; `deps` / `devDeps` are direct dependency names.
 */
function metadata(packages) {
  const entries = packages.map(([name, { features = [], links = null, deps = [], devDeps = [] } = {}]) => ({
    id: `registry+${name}`,
    name,
    links,
    features,
    deps: [
      ...deps.map((dep) => ({ name: dep.replaceAll('-', '_'), pkg: `registry+${dep}`, dep_kinds: [{ kind: null, target: null }] })),
      ...devDeps.map((dep) => ({ name: dep.replaceAll('-', '_'), pkg: `registry+${dep}`, dep_kinds: [{ kind: 'dev', target: null }] })),
    ],
  }));
  return {
    packages: entries.map(({ id, name, links }) => ({ id, name, links })),
    resolve: { nodes: entries.map(({ id, features, deps }) => ({ id, features, deps })) },
  };
}

/** The adapter node as cargo resolves it for each profile. */
const homepageAdapter = ['neuromorphic-adapter', { features: ['default'], deps: ['corpus-ipc'], devDeps: ['serde_json'] }];
const labsAdapter = [
  'neuromorphic-adapter',
  {
    features: ['default', 'nir', 'plasticity', 'protocol'],
    deps: ['corpus-ipc', 'limbic-critic', 'nir-rs', 'plasticity-lab', 'serde', 'serde_json', 'sha2'],
    devDeps: ['serde_json'],
  },
];

/** Crates only the labs features bring into the graph. */
const LABS_ONLY_CRATES = new Set(['nir-rs', 'indexmap', 'plasticity-lab', 'limbic-critic']);

const browserBaseline = [
  ['neuromorphic-adapter'],
  ['corpus-ipc'],
  ['nir-rs', { features: ['serde'] }],
  ['indexmap', { features: ['default', 'serde', 'std'] }],
  ['plasticity-lab', { features: ['critic', 'wasm-js'] }],
  ['limbic-critic'],
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

test('the corpus-ipc browser surface never enables server or zmq', () => {
  const violations = browserDependencyViolations(metadata([
    ['neuromorphic-adapter'],
    ['corpus-ipc', { features: ['zmq'] }],
    ['zmq'],
  ]), profile('default'));

  assert.deepEqual(violations, [
    'corpus-ipc: browser features must not enable server or zmq: zmq',
    'zmq: native-only package',
  ]);
});

test('build profiles keep nir-rs and plasticity-lab in the labs package and out of the homepage package', () => {
  assert.deepEqual(WASM_PROFILES.map(({ name, features, outputDirectory }) => [name, [...features], outputDirectory]), [
    ['default', [], 'public/wasm/neuromorphic-adapter'],
    ['labs', ['nir', 'protocol', 'plasticity'], 'public/wasm/neuromorphic-adapter-labs'],
  ]);
  assert.notEqual(profile('default').targetDirectory, profile('labs').targetDirectory);
  assert.deepEqual(profileFeatureArgs(profile('default')), []);
  assert.deepEqual(profileFeatureArgs(profile('labs')), ['--features', 'nir,protocol,plasticity']);

  const shared = browserBaseline.filter(([name]) => name !== 'neuromorphic-adapter');
  const homepageGraph = [homepageAdapter, ...shared.filter(([name]) => !LABS_ONLY_CRATES.has(name))];
  const labsGraph = [labsAdapter, ...shared];
  assert.deepEqual(browserDependencyViolations(metadata(homepageGraph), profile('default')), []);
  assert.deepEqual(browserDependencyViolations(metadata(labsGraph), profile('labs')), []);

  assert.deepEqual(browserDependencyViolations(metadata([homepageAdapter, ...shared]), profile('default')), [
    "limbic-critic: must stay out of this profile's graph",
    "nir-rs: must stay out of this profile's graph",
    "plasticity-lab: must stay out of this profile's graph",
  ]);
  const labsMissing = browserDependencyViolations(metadata(homepageGraph), profile('labs'));
  for (const name of ['nir-rs', 'plasticity-lab', 'limbic-critic']) {
    assert.ok(labsMissing.includes(`${name}: required by this profile but missing from its graph`), name);
  }
  assert.deepEqual(browserDependencyViolations(metadata([labsAdapter]), profile('labs')), [
    'corpus-ipc: required by this profile but missing from its graph',
    'limbic-critic: required by this profile but missing from its graph',
    'nir-rs: required by this profile but missing from its graph',
    'plasticity-lab: required by this profile but missing from its graph',
  ]);
});

test('the plasticity lab stays out of the homepage adapter and links only browser features', () => {
  const homepageWithPlasticity = [
    [
      'neuromorphic-adapter',
      { features: ['default', 'plasticity'], deps: ['corpus-ipc', 'limbic-critic', 'plasticity-lab'] },
    ],
    ['corpus-ipc'],
    ['plasticity-lab', { features: ['critic', 'wasm-js'] }],
    ['limbic-critic'],
  ];
  assert.deepEqual(browserDependencyViolations(metadata(homepageWithPlasticity), profile('default')), [
    'limbic-critic: must not be a direct neuromorphic-adapter dependency in this profile',
    "limbic-critic: must stay out of this profile's graph",
    'neuromorphic-adapter: enables features [plasticity], profile expects []',
    'plasticity-lab: must not be a direct neuromorphic-adapter dependency in this profile',
    "plasticity-lab: must stay out of this profile's graph",
  ]);

  const labsWithDefaultPlasticity = browserBaseline.map((entry) => (entry[0] === 'plasticity-lab'
    ? ['plasticity-lab', { features: ['critic', 'default', 'wasm-js'] }]
    : entry));
  assert.deepEqual(browserDependencyViolations(metadata([labsAdapter, ...labsWithDefaultPlasticity.slice(1)]), profile('labs')), [
    'plasticity-lab: browser features must stay within critic and wasm-js: default',
  ]);
});

test('protocol decode dependencies stay out of the homepage adapter', () => {
  // sha2 and serde_json remain in the default graph transitively
  // (synaptic-wiring, corpus-ipc), so the policy pins the adapter itself.
  const homepageWithProtocol = [
    [
      'neuromorphic-adapter',
      { features: ['default', 'protocol'], deps: ['corpus-ipc', 'serde_json', 'sha2'], devDeps: ['serde_json'] },
    ],
    ['corpus-ipc'],
    ['serde_json'],
    ['sha2'],
  ];
  assert.deepEqual(browserDependencyViolations(metadata(homepageWithProtocol), profile('default')), [
    'neuromorphic-adapter: enables features [protocol], profile expects []',
    'serde_json: must not be a direct neuromorphic-adapter dependency in this profile',
    'sha2: must not be a direct neuromorphic-adapter dependency in this profile',
  ]);

  // The test-only serde_json dev-dependency is not a browser dependency.
  assert.deepEqual(
    browserDependencyViolations(metadata([homepageAdapter, ['corpus-ipc'], ['serde_json'], ['sha2']]), profile('default')),
    [],
  );

  const labsWithoutProtocol = [
    [
      'neuromorphic-adapter',
      {
        features: ['default', 'nir', 'plasticity'],
        deps: ['corpus-ipc', 'limbic-critic', 'nir-rs', 'plasticity-lab', 'serde', 'serde_json'],
      },
    ],
    ...browserBaseline.filter(([name]) => name !== 'neuromorphic-adapter'),
  ];
  assert.deepEqual(browserDependencyViolations(metadata(labsWithoutProtocol), profile('labs')), [
    'neuromorphic-adapter: enables features [nir, plasticity], profile expects [nir, plasticity, protocol]',
    'sha2: this profile needs it as a direct neuromorphic-adapter dependency',
  ]);
});

test('ZeroMQ, the Axum/Tokio server stack, and its networking are rejected in every profile', () => {
  const names = ['zmq', 'zeromq', 'axum', 'axum-core', 'tokio', 'tokio-macros', 'hyper', 'tower', 'mio', 'socket2', 'cust'];
  for (const name of names) {
    for (const candidate of WASM_PROFILES) {
      assert.ok(
        browserDependencyViolations(metadata([...browserBaseline, [name]]), candidate).includes(`${name}: native-only package`),
        `${candidate.name} must reject ${name}`,
      );
    }
  }
  assert.ok(
    browserDependencyViolations(metadata([...browserBaseline, ['zmq-sys', { links: 'zmq' }]])).includes(
      'zmq-sys: native -sys binding crate',
    ),
  );
});

test('the native rules apply to every profile', () => {
  const graph = [...browserBaseline, ['hdf5-metno-sys', { links: 'hdf5' }], ['cc']];
  for (const candidate of WASM_PROFILES) {
    const violations = browserDependencyViolations(metadata(graph), candidate);
    assert.ok(violations.includes('cc: native C/C++ build tooling'), candidate.name);
    assert.ok(
      violations.includes('hdf5-metno-sys: HDF5 is native-only (libhdf5) and must stay out of the browser bundle'),
      candidate.name,
    );
  }
});

test('the policy script checks every profile and labels failures by profile', async () => {
  const source = await readFile('scripts/verify-browser-dependencies.mjs', 'utf8');
  const build = await readFile('scripts/build-neuromorphic-web.mjs', 'utf8');

  assert.match(source, /for \(const profile of WASM_PROFILES\)/);
  assert.match(source, /\.\.\.profileFeatureArgs\(profile\)/);
  assert.match(source, /\[\$\{profile\.name\}\]/);
  assert.match(build, /WASM_PROFILES\.map/);
  assert.match(build, /'--target-dir',\s*pkg\.targetDirectory/);
  assert.match(build, /executableFromEnvironment\('WASM_BINDGEN_BIN'\)/);
  assert.match(build, /\(metadata\.mode & 0o022\) !== 0 \|\| \(metadata\.mode & 0o111\) === 0/);
  assert.match(build, /'wasm-bindgen 0\.2\.126'/);
});
