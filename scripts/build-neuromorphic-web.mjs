// Builds the browser-facing wasm-bindgen package for the neuromorphic demo.
//
//   node scripts/build-neuromorphic-web.mjs          emit into public/wasm/neuromorphic-adapter/
//   node scripts/build-neuromorphic-web.mjs --check  regenerate in a temp dir and fail on drift
//
// --check compares the deterministic wasm-bindgen outputs (.js, .d.ts, .ts)
// byte-for-byte. The .wasm binary itself is not byte-stable across build
// hosts, so it is only required to regenerate successfully and be non-empty;
// functional correctness is enforced by scripts/verify-neuromorphic-wasm.mjs
// and scripts/verify-neuromorphic-browser.mjs.
import { mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
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
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const child = join(relative, entry.name);
      if (entry.isDirectory()) {
        return generatedFiles(join(directory, entry.name), child);
      }
      return Promise.resolve(entry.isFile() ? [child] : []);
    }),
  );
  return nested.flat().sort((left, right) => left.localeCompare(right));
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
    const comparisons = await Promise.all(
      expected.map(async (file) => {
        const committed = join(destination, file);
        const fresh = join(output, file);
        if (file.endsWith('.wasm')) {
          return (await stat(fresh)).size === 0 ? file : null;
        }
        const [committedBytes, freshBytes] = await Promise.all([
          readFile(committed),
          readFile(fresh),
        ]);
        return committedBytes.equals(freshBytes) ? null : file;
      }),
    );
    const drifted = comparisons.filter(Boolean);
    if (drifted.length > 0) {
      throw new Error(
        `committed browser package drifted at ${drifted[0]}; regenerate with npm run build:wasm-web`,
      );
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
