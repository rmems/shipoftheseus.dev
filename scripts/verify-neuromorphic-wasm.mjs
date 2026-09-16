import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repository = resolve(import.meta.dirname, '..');
const manifest = join(repository, 'crates/neuromorphic-adapter/Cargo.toml');
const wasm = join(
  repository,
  'crates/neuromorphic-adapter/target/wasm32-unknown-unknown/release/neuromorphic_adapter.wasm',
);
const output = await mkdtemp(join(tmpdir(), 'neuromorphic-adapter-smoke-'));
const webOutput = join(output, 'web');

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, { cwd: repository, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} failed:\n${result.stdout}\n${result.stderr}`);
  }
}

try {
  run('cargo', ['+1.98.1', 'build', '--manifest-path', manifest, '--target', 'wasm32-unknown-unknown', '--release', '--locked']);
  run('wasm-bindgen', ['--target', 'nodejs', '--out-dir', output, wasm]);
  run('node', ['--input-type=commonjs', '--eval', [
    "const wasm = require(process.argv[1]);",
    "const adapter = wasm.WasmAdapter.init(9n, new Uint8Array([1]));",
    "adapter.input(1n, new Float32Array([1, 0.5]));",
    "const state = adapter.step();",
    "if (typeof state.seed !== 'bigint' || state.completed_step !== 1n) process.exit(1);",
    "if (!(state.membrane_potentials instanceof Float32Array)) process.exit(1);",
    "adapter.dispose();",
  ].join(' '), join(output, 'neuromorphic_adapter.js')]);
  run('wasm-bindgen', ['--target', 'web', '--out-dir', webOutput, wasm]);
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
    "adapter.dispose();",
  ].join(' '), webModule, join(webOutput, 'neuromorphic_adapter_bg.wasm')]);
  process.stdout.write('Generated Rust/WASM adapter smoke test passed.\n');
} finally {
  await rm(output, { recursive: true, force: true });
}
