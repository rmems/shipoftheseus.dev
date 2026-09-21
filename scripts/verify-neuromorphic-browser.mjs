import { mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const repository = resolve(import.meta.dirname, '..');
const manifest = join(repository, 'crates/neuromorphic-adapter/Cargo.toml');
const wasm = join(repository, 'crates/neuromorphic-adapter/target/wasm32-unknown-unknown/release/neuromorphic_adapter.wasm');
const topologyContractSource = String.raw`
const EXPECTED_TOPOLOGY_DIGEST = 'synaptic-wiring.topology.digest.v1:sha256:26875faf05121b9afda27a533760369da67ba9110599fb61533f08961ff6e971';
const EXPECTED_TOPOLOGY_EDGE_TARGETS = new Uint32Array([
  1, 2, 12, 14, 3, 8, 12, 15, 0, 1, 3, 4, 2, 4, 5, 8,
  2, 3, 7, 14, 3, 4, 6, 7, 0, 5, 7, 8, 5, 6, 11, 15,
  6, 7, 9, 10, 8, 10, 11, 14, 4, 8, 9, 13, 9, 12, 13, 15,
  10, 11, 13, 14, 11, 12, 14, 15, 0, 9, 12, 15, 0, 5, 13, 14,
]);
const EXPECTED_TOPOLOGY_EDGE_DELAYS = new Uint16Array([
  3, 1, 1, 4, 1, 4, 1, 1, 1, 2, 1, 2, 3, 1, 3, 3,
  2, 4, 1, 2, 3, 1, 3, 1, 3, 1, 4, 1, 1, 2, 1, 2,
  2, 3, 2, 3, 4, 2, 4, 4, 2, 3, 1, 2, 1, 1, 1, 4,
  1, 2, 1, 2, 2, 3, 2, 3, 3, 3, 3, 2, 2, 1, 3, 1,
]);
const EXPECTED_TOPOLOGY_WEIGHT_BITS = new Uint32Array([
  3210213374, 3209821784, 3205905881, 3205122701, 3209004865, 3207046914, 3205480553, 3204163308,
  3209754308, 3209362717, 3208579536, 3208187946, 3208545798, 3207762618, 3207371028, 3206196257,
  1060636822, 1060245232, 1058678871, 1054910871, 1059819904, 1059428314, 1058645133, 1058253543,
  1060569346, 1058611395, 1057828214, 1057436624, 1058186066, 1057794476, 1054708442, 1062658772,
  1057369148, 1056977558, 1055424146, 1054640966, 1055356670, 1053790309, 1063374476, 1062199706,
  1057301672, 1054506013, 1053722833, 1062165968, 1063307000, 1062132230, 1061740639, 1060957458,
  1062490082, 1062098491, 1061315310, 1060923720, 1061673163, 1061281572, 1060498392, 1060106802,
  1057166719, 1062031015, 1060856244, 1059681474, 1056518174, 1063172048, 1060039326, 1059647736,
]);

function assertTopologyContract(state) {
  if (!(state.membrane_potentials instanceof Float32Array) ||
      !(state.topology_rows instanceof Uint32Array) ||
      !(state.topology_targets instanceof Uint32Array) ||
      !(state.topology_weights instanceof Float32Array) ||
      !(state.topology_delays instanceof Uint16Array) ||
      !(state.topology_node_ids instanceof Uint32Array) ||
      !(state.topology_edge_sources instanceof Uint32Array) ||
      !(state.topology_edge_targets instanceof Uint32Array) ||
      !(state.topology_edge_weights instanceof Float32Array) ||
      !(state.topology_edge_delays instanceof Uint16Array) ||
      !(state.topology_polarities instanceof Uint8Array) ||
      !(state.topology_weight_bits instanceof Uint32Array) ||
      !(state.topology_outgoing_edge_offsets instanceof Uint32Array)) {
    throw new Error('topology contract returned an unexpected typed array');
  }

  const nodeCount = state.topology_node_ids.length;
  const edgeCount = state.topology_edge_sources.length;
  const canonicalArrays = [
    state.topology_edge_targets,
    state.topology_edge_weights,
    state.topology_edge_delays,
    state.topology_polarities,
    state.topology_weight_bits,
  ];
  if (nodeCount !== state.membrane_potentials.length ||
      state.topology_rows.length !== nodeCount + 1 ||
      state.topology_outgoing_edge_offsets.length !== nodeCount + 1 ||
      canonicalArrays.some((values) => values.length !== edgeCount) ||
      state.topology_targets.length !== edgeCount ||
      state.topology_weights.length !== edgeCount ||
      state.topology_delays.length !== edgeCount ||
      state.topology_rows[0] !== 0 ||
      state.topology_rows.at(-1) !== edgeCount ||
      state.topology_outgoing_edge_offsets[0] !== 0 ||
      state.topology_outgoing_edge_offsets.at(-1) !== edgeCount) {
    throw new Error('topology contract has inconsistent cardinality');
  }

  const canonicalWeightBits = new Uint32Array(
    state.topology_edge_weights.buffer,
    state.topology_edge_weights.byteOffset,
    edgeCount,
  );
  if (state.topology_digest !== EXPECTED_TOPOLOGY_DIGEST || nodeCount !== 16 || edgeCount !== 64) {
    throw new Error('topology contract does not match the fixed topology identity');
  }
  for (let node = 0; node < nodeCount; node += 1) {
    if (state.topology_node_ids[node] !== node || state.topology_edge_sources[node * 4] !== node ||
        state.topology_outgoing_edge_offsets[node] !== node * 4 ||
        state.topology_rows[node] > state.topology_rows[node + 1] ||
        state.topology_outgoing_edge_offsets[node] > state.topology_outgoing_edge_offsets[node + 1]) {
      throw new Error('topology contract has invalid node offsets');
    }
    for (let edge = state.topology_outgoing_edge_offsets[node]; edge < state.topology_outgoing_edge_offsets[node + 1]; edge += 1) {
      if (state.topology_edge_sources[edge] !== node) throw new Error('topology contract has inconsistent canonical sources');
    }
    for (let edge = state.topology_rows[node]; edge < state.topology_rows[node + 1]; edge += 1) {
      if (state.topology_targets[edge] >= nodeCount) throw new Error('topology contract has an out-of-range routed target');
    }
  }

  for (let edge = 0; edge < edgeCount; edge += 1) {
    if (state.topology_edge_sources[edge] >= nodeCount ||
        state.topology_edge_targets[edge] >= nodeCount ||
        state.topology_polarities[edge] > 1 ||
        canonicalWeightBits[edge] !== state.topology_weight_bits[edge] ||
        state.topology_edge_sources[edge] !== Math.floor(edge / 4) ||
        state.topology_edge_targets[edge] !== EXPECTED_TOPOLOGY_EDGE_TARGETS[edge] ||
        state.topology_edge_delays[edge] !== EXPECTED_TOPOLOGY_EDGE_DELAYS[edge] ||
        state.topology_polarities[edge] !== (edge < 16 ? 1 : 0) ||
        state.topology_weight_bits[edge] !== EXPECTED_TOPOLOGY_WEIGHT_BITS[edge]) {
      throw new Error('topology contract has invalid canonical edge data');
    }
    if (edge > 0) {
      const previous = edge - 1;
      const before = [state.topology_edge_sources[previous], state.topology_edge_targets[previous], state.topology_edge_delays[previous], state.topology_polarities[previous], state.topology_weight_bits[previous]];
      const current = [state.topology_edge_sources[edge], state.topology_edge_targets[edge], state.topology_edge_delays[edge], state.topology_polarities[edge], state.topology_weight_bits[edge]];
      if (before.some((value, index) => value > current[index] && before.slice(0, index).every((prior, priorIndex) => prior === current[priorIndex]))) {
        throw new Error('topology contract is not canonically ordered');
      }
    }
  }

  const canonicalTuples = new Map();
  for (let edge = 0; edge < edgeCount; edge += 1) {
    const key = [state.topology_edge_sources[edge], state.topology_edge_targets[edge], state.topology_edge_delays[edge], canonicalWeightBits[edge]].join(':');
    canonicalTuples.set(key, (canonicalTuples.get(key) || 0) + 1);
  }
  const routedWeightBits = new Uint32Array(state.topology_weights.buffer, state.topology_weights.byteOffset, edgeCount);
  for (let source = 0; source < nodeCount; source += 1) {
    for (let edge = state.topology_rows[source]; edge < state.topology_rows[source + 1]; edge += 1) {
      const key = [source, state.topology_targets[edge], state.topology_delays[edge], routedWeightBits[edge]].join(':');
      const remaining = canonicalTuples.get(key);
      if (!remaining) throw new Error('routed topology does not match the fixed projection');
      if (remaining === 1) canonicalTuples.delete(key);
      else canonicalTuples.set(key, remaining - 1);
    }
  }
  if (canonicalTuples.size !== 0) throw new Error('routed topology does not match the fixed projection');
}
`;

async function executableFromEnvironment(name) {
  const requested = process.env[name];
  if (!requested || !isAbsolute(requested)) {
    throw new Error(`${name} must be an absolute path to a non-group-writable executable file.`);
  }
  const executable = await realpath(requested);
  const metadata = await stat(executable);
  if (!metadata.isFile() || (metadata.mode & 0o022) !== 0 || (metadata.mode & 0o111) === 0) {
    throw new Error(`${name} must be an absolute path to a non-group-writable executable file.`);
  }
  return executable;
}

function run(command, arguments_, environment = {}) {
  const result = spawnSync(command, arguments_, { cwd: repository, encoding: 'utf8', env: { ...process.env, ...environment } });
  if (result.status !== 0) {
    throw new Error(`${command} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

async function generatedFiles(directory, relative = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await generatedFiles(join(directory, entry.name), child));
    else if (entry.isFile()) files.push(child);
  }
  return files.sort((left, right) => {
    if (left === right) return 0;
    return left < right ? -1 : 1;
  });
}

async function assertReproducible(first, second) {
  const firstFiles = await generatedFiles(first);
  const secondFiles = await generatedFiles(second);
  if (firstFiles.join('\n') !== secondFiles.join('\n')) throw new Error('wasm-bindgen generated different file sets.');
  for (const file of firstFiles) {
    if (!(await readFile(join(first, file))).equals(await readFile(join(second, file)))) {
      throw new Error(`wasm-bindgen generated different contents for ${file}.`);
    }
  }
}

const browser = await executableFromEnvironment('BROWSER_BIN');
const wasmBindgen = await executableFromEnvironment('WASM_BINDGEN_BIN');
const cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo');
if (!isAbsolute(cargoHome)) {
  throw new Error('CARGO_HOME must be an absolute path when set.');
}
const cargo = join(cargoHome, 'bin', 'cargo');
const cargoMetadata = await stat(cargo);
if (!cargoMetadata.isFile() || (cargoMetadata.mode & 0o111) === 0) {
  throw new Error(`expected an executable cargo binary at ${cargo}`);
}
if (run(wasmBindgen, ['--version']).trim() !== 'wasm-bindgen 0.2.126') {
  throw new Error('wasm-bindgen-cli 0.2.126 is required for browser smoke coverage.');
}

let output;
try {
  output = await mkdtemp(join(tmpdir(), 'neuromorphic-browser-smoke-'));
  const generated = join(output, 'generated');
  const repeated = join(output, 'repeated');
  const firstTarget = join(output, 'target-first');
  const secondTarget = join(output, 'target-second');
  const deterministicBuild = { CARGO_INCREMENTAL: '0', SOURCE_DATE_EPOCH: '0' };
  run(cargo, ['+1.98.1', 'build', '--manifest-path', manifest, '--target', 'wasm32-unknown-unknown', '--release', '--locked'], { ...deterministicBuild, CARGO_TARGET_DIR: firstTarget });
  run(cargo, ['+1.98.1', 'build', '--manifest-path', manifest, '--target', 'wasm32-unknown-unknown', '--release', '--locked'], { ...deterministicBuild, CARGO_TARGET_DIR: secondTarget });
  run(wasmBindgen, ['--target', 'web', '--out-dir', generated, join(firstTarget, 'wasm32-unknown-unknown/release/neuromorphic_adapter.wasm')]);
  run(wasmBindgen, ['--target', 'web', '--out-dir', repeated, join(secondTarget, 'wasm32-unknown-unknown/release/neuromorphic_adapter.wasm')]);
  await assertReproducible(generated, repeated);
  await rename(join(generated, 'neuromorphic_adapter.js'), join(generated, 'neuromorphic_adapter.mjs'));
  const page = join(generated, 'index.html');
  await writeFile(page, `<!doctype html><body><script type="module">\nimport init, { WasmAdapter } from './neuromorphic_adapter.mjs';\n${topologyContractSource}\ntry {\n  await init('./neuromorphic_adapter_bg.wasm');\n  const adapter = WasmAdapter.init(9n, new Uint8Array([2]));\n  adapter.input(1n, new Float32Array([1, 0.5]));\n  const state = adapter.step();\n  if (state.completed_step !== 1n) throw new Error('unexpected step');\n  assertTopologyContract(state);\n  adapter.dispose();\n  document.body.textContent = ['BROWSER', 'SMOKE', 'PASS'].join('_');\n} catch (error) { document.body.textContent = 'BROWSER_SMOKE_FAIL:' + error.message; }\n</script>`);
  const dom = run(browser, ['--headless=new', '--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--virtual-time-budget=3000', '--dump-dom', page]);
  if (!dom.includes('BROWSER_SMOKE_PASS')) {
    throw new Error(`browser Rust/WASM smoke failed:\n${dom}`);
  }
  process.stdout.write('Browser Rust/WASM adapter smoke test passed.\n');
} finally {
  if (output) await rm(output, { recursive: true, force: true });
}
