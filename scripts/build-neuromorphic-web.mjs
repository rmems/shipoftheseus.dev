// Builds the browser-facing wasm-bindgen package for the neuromorphic demo.
//
//   node scripts/build-neuromorphic-web.mjs          emit into public/wasm/neuromorphic-adapter/
//   node scripts/build-neuromorphic-web.mjs --check  regenerate in a temp dir and fail on drift
//
// The committed output is deterministic: same crate lockfile, Rust toolchain,
// and wasm-bindgen 0.2.126 produce byte-identical files (asserted by
// scripts/verify-neuromorphic-browser.mjs as well).
import { mkdtemp, cp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const repository = resolve(import.meta.dirname, '..');
const manifest = join(repository, 'crates/neuromorphic-adapter/Cargo.toml');
const wasm = join(
  repository,
  'crates/neuromorphic-adapter/target/wasm32-unknown-unknown/release/neuromorphic_adapter.wasm',
);
const destination = join(repository, 'public/wasm/neuromorphic-adapter');
const checkOnly = process.argv.includes('--check');

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

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repository, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

async function generatedFiles(directory, relative = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await generatedFiles(join(directory, entry.name), child)));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files.sort();
}

const wasmBindgen = await executableFromEnvironment('WASM_BINDGEN_BIN');
const cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo');
const cargo = join(cargoHome, 'bin', 'cargo');
await stat(cargo);

if (run(wasmBindgen, ['--version']).trim() !== 'wasm-bindgen 0.2.126') {
  throw new Error('wasm-bindgen-cli 0.2.126 is required to build the browser package.');
}

run(cargo, [
  '+1.98.1',
  'build',
  '--manifest-path',
  manifest,
  '--target',
  'wasm32-unknown-unknown',
  '--release',
  '--locked',
]);
await stat(wasm);

let output = null;
try {
  if (checkOnly) {
    output = await mkdtemp(join(tmpdir(), 'neuromorphic-web-check-'));
    run(wasmBindgen, ['--target', 'web', '--out-dir', output, wasm]);

    const expected = await generatedFiles(destination);
    const actual = await generatedFiles(output);
    if (expected.join('\n') !== actual.join('\n')) {
      throw new Error(
        'committed browser package file set is stale; regenerate with npm run build:wasm-web',
      );
    }
    for (const file of expected) {
      const committed = await readFile(join(destination, file));
      const fresh = await readFile(join(output, file));
      if (!committed.equals(fresh)) {
        throw new Error(
          `committed browser package drifted at ${file}; regenerate with npm run build:wasm-web`,
        );
      }
    }
    process.stdout.write('Committed browser WASM package matches the locked toolchain output.\n');
  } else {
    await rm(destination, { recursive: true, force: true });
    run(wasmBindgen, ['--target', 'web', '--out-dir', destination, wasm]);
    process.stdout.write(`Wrote browser WASM package to ${destination}\n`);
  }
} finally {
  if (output) {
    await rm(output, { recursive: true, force: true });
  }
}
