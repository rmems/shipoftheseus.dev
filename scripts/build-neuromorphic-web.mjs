// Builds the browser-facing wasm-bindgen packages of the neuromorphic adapter.
//
//   node scripts/build-neuromorphic-web.mjs          emit every profile's package under public/wasm/
//   node scripts/build-neuromorphic-web.mjs --check  regenerate each in a temp dir and fail on drift
//
// One crate and one adapter boundary, built once per profile in
// scripts/wasm-profiles.mjs (name -> cargo features -> output directory):
// `default` is the homepage package, `labs` serves off-homepage interactive
// surfaces. Each profile has its own cargo target directory so the .wasm
// outputs never overwrite each other.
//
// --check compares the deterministic wasm-bindgen outputs (.js, .d.ts, .ts)
// byte-for-byte. The .wasm binary itself is not byte-stable across build
// hosts, so it is only required to regenerate successfully and be non-empty;
// functional correctness is enforced by scripts/verify-neuromorphic-wasm.mjs,
// scripts/verify-neuromorphic-browser.mjs, and test/nir-lab.test.mjs.
import { mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { WASM_PROFILES, profileFeatureArgs } from './wasm-profiles.mjs';

const repository = resolve(import.meta.dirname, '..');
const crate = join(repository, 'crates/neuromorphic-adapter');
const manifest = join(crate, 'Cargo.toml');
const checkOnly = process.argv.includes('--check');

const packages = WASM_PROFILES.map((profile) => ({
  name: profile.name,
  featureArgs: profileFeatureArgs(profile),
  targetDirectory: join(crate, profile.targetDirectory),
  destination: join(repository, profile.outputDirectory),
}));

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

async function buildWasm(pkg) {
  run(cargo, [
    '+1.98.1',
    'build',
    '--manifest-path',
    manifest,
    '--target',
    'wasm32-unknown-unknown',
    '--release',
    '--locked',
    '--target-dir',
    pkg.targetDirectory,
    ...pkg.featureArgs,
  ]);
  const wasm = join(pkg.targetDirectory, 'wasm32-unknown-unknown/release/neuromorphic_adapter.wasm');
  await stat(wasm);
  return wasm;
}

async function checkPackage(pkg, wasm, output) {
  run(wasmBindgen, ['--target', 'web', '--out-dir', output, wasm]);

  const expected = await generatedFiles(pkg.destination);
  const actual = await generatedFiles(output);
  if (expected.join('\n') !== actual.join('\n')) {
    throw new Error(
      `committed ${pkg.name} browser package file set is stale; regenerate with npm run build:wasm-web`,
    );
  }
  const comparisons = await Promise.all(
    expected.map(async (file) => {
      const committed = join(pkg.destination, file);
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
      `committed ${pkg.name} browser package drifted at ${drifted[0]}; regenerate with npm run build:wasm-web`,
    );
  }
}

let output = null;
try {
  if (checkOnly) {
    output = await mkdtemp(join(tmpdir(), 'neuromorphic-web-check-'));
  }
  for (const pkg of packages) {
    const wasm = await buildWasm(pkg);
    if (checkOnly) {
      await checkPackage(pkg, wasm, join(output, pkg.name));
    } else {
      await rm(pkg.destination, { recursive: true, force: true });
      run(wasmBindgen, ['--target', 'web', '--out-dir', pkg.destination, wasm]);
      process.stdout.write(`Wrote ${pkg.name} browser WASM package to ${pkg.destination}\n`);
    }
  }
  if (checkOnly) {
    process.stdout.write('Committed browser WASM packages match the locked toolchain output.\n');
  }
} finally {
  if (output) {
    await rm(output, { recursive: true, force: true });
  }
}
