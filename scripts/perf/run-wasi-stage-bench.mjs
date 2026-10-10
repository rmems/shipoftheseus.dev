// Runs the stage-timing harness (`crates/neuromorphic-adapter/examples/stage_bench.rs`)
// compiled to `wasm32-wasip1`, so the same per-stage timings come from WebAssembly
// executed by V8. This is Node's V8 (see `process.versions.v8`), not Chrome's:
// use it for per-stage costs under WASM, and the browser harness for Chrome.
//
//   rustup target add wasm32-wasip1 --toolchain 1.98.1
//   cargo +1.98.1 build --release --locked --target wasm32-wasip1 \
//     --manifest-path crates/neuromorphic-adapter/Cargo.toml --example stage_bench
//   node scripts/perf/run-wasi-stage-bench.mjs <path to stage_bench.wasm> [--json] [--quick]
//
// Machine-dependent and slow; never part of `npm test`.
import { readFile } from 'node:fs/promises';
import { argv, stdout, versions } from 'node:process';
import { WASI } from 'node:wasi';

const [wasmPath, ...rest] = argv.slice(2);
if (!wasmPath) {
  throw new Error('usage: node scripts/perf/run-wasi-stage-bench.mjs <stage_bench.wasm> [--json] [--quick]');
}

const wasi = new WASI({ version: 'preview1', args: ['stage_bench', ...rest], env: {}, returnOnExit: true });
const module = await WebAssembly.compile(await readFile(wasmPath));
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
if (!rest.includes('--json')) {
  stdout.write(`<!-- WASI run: Node ${versions.node}, V8 ${versions.v8} -->\n`);
}
const code = wasi.start(instance);
if (code !== 0) {
  throw new Error(`stage_bench exited with ${code}`);
}
