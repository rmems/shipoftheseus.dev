import { mkdtemp, realpath, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repository = resolve(import.meta.dirname, '..');
const manifest = join(repository, 'crates/neuromorphic-adapter/Cargo.toml');
const wasm = join(
  repository,
  'crates/neuromorphic-adapter/target/wasm32-unknown-unknown/release/neuromorphic_adapter.wasm',
);
const requestedWasmBindgen = process.env.WASM_BINDGEN_BIN;

if (!requestedWasmBindgen || !isAbsolute(requestedWasmBindgen)) {
  throw new Error('WASM_BINDGEN_BIN must be an absolute path to wasm-bindgen-cli 0.2.126.');
}

const wasmBindgen = await realpath(requestedWasmBindgen);
const wasmBindgenMetadata = await stat(wasmBindgen);
if (
  !wasmBindgenMetadata.isFile() ||
  (wasmBindgenMetadata.mode & 0o022) !== 0 ||
  (wasmBindgenMetadata.mode & 0o111) === 0
) {
  throw new Error('WASM_BINDGEN_BIN must identify a non-group-writable executable file.');
}

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, { cwd: repository, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} failed:\n${result.stdout}\n${result.stderr}`);
  }
}

function requireWasmBindgenVersion() {
  const result = spawnSync(wasmBindgen, ['--version'], { cwd: repository, encoding: 'utf8' });
  if (result.status !== 0 || result.stdout.trim() !== 'wasm-bindgen 0.2.126') {
    throw new Error(`wasm-bindgen-cli 0.2.126 is required; found: ${result.stdout?.trim() || result.stderr?.trim() || result.error?.message || 'no executable output'}`);
  }
}

let output;

try {
  requireWasmBindgenVersion();
  output = await mkdtemp(join(tmpdir(), 'neuromorphic-adapter-smoke-'));
  const webOutput = join(output, 'web');
  run('cargo', ['+1.98.1', 'build', '--manifest-path', manifest, '--target', 'wasm32-unknown-unknown', '--release', '--locked']);
  run(wasmBindgen, ['--target', 'nodejs', '--out-dir', output, wasm]);
  run('node', ['--input-type=commonjs', '--eval', [
    "const wasm = require(process.argv[1]);",
    "const adapter = wasm.WasmAdapter.init(9n, new Uint8Array([1]));",
    "adapter.input(1n, new Float32Array([1, 0.5]));",
    "const state = adapter.step();",
    "if (typeof state.seed !== 'bigint' || state.completed_step !== 1n) process.exit(1);",
    "if (!(state.membrane_potentials instanceof Float32Array)) process.exit(1);",
    "if (!(state.topology_node_ids instanceof Uint32Array) || !(state.topology_edge_sources instanceof Uint32Array)) process.exit(1);",
    "if (!(state.topology_edge_targets instanceof Uint32Array) || !(state.topology_edge_weights instanceof Float32Array) || !(state.topology_edge_delays instanceof Uint16Array)) process.exit(1);",
    "if (!(state.topology_polarities instanceof Uint8Array) || !(state.topology_weight_bits instanceof Uint32Array)) process.exit(1);",
    "if (!(state.topology_outgoing_edge_offsets instanceof Uint32Array)) process.exit(1);",
    "adapter.dispose();",
  ].join(' '), join(output, 'neuromorphic_adapter.js')]);
  run(wasmBindgen, ['--target', 'web', '--out-dir', webOutput, wasm]);
  const webModule = join(webOutput, 'neuromorphic_adapter.mjs');
  await rename(join(webOutput, 'neuromorphic_adapter.js'), webModule);
  run('node', ['--input-type=module', '--eval', [
    "import { readFile } from 'node:fs/promises';",
    "import { pathToFileURL } from 'node:url';",
    "const wasm = await import(pathToFileURL(process.argv[1]).href);",
    "await wasm.default(await readFile(process.argv[2]));",
    "const adapter = wasm.WasmAdapter.init(9n, new Uint8Array([1]));",
    "adapter.input(1n, new Float32Array([1, 0.5]));",
    "const state = adapter.step();",
    "if (typeof state.seed !== 'bigint' || state.completed_step !== 1n) process.exit(1);",
    "if (!(state.membrane_potentials instanceof Float32Array)) process.exit(1);",
    "if (!(state.topology_node_ids instanceof Uint32Array) || !(state.topology_edge_sources instanceof Uint32Array)) process.exit(1);",
    "if (!(state.topology_edge_targets instanceof Uint32Array) || !(state.topology_edge_weights instanceof Float32Array) || !(state.topology_edge_delays instanceof Uint16Array)) process.exit(1);",
    "if (!(state.topology_polarities instanceof Uint8Array) || !(state.topology_weight_bits instanceof Uint32Array)) process.exit(1);",
    "if (!(state.topology_outgoing_edge_offsets instanceof Uint32Array)) process.exit(1);",
    "adapter.dispose();",
  ].join(' '), webModule, join(webOutput, 'neuromorphic_adapter_bg.wasm')]);
  process.stdout.write('Generated Rust/WASM adapter smoke test passed.\n');
} finally {
  if (output) {
    await rm(output, { recursive: true, force: true });
  }
}
