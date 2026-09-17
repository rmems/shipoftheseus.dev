import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import test from 'node:test';

test('the browser smoke script rejects a relative browser executable path before building artifacts', () => {
  const result = spawnSync(process.execPath, ['scripts/verify-neuromorphic-browser.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, BROWSER_BIN: 'google-chrome', WASM_BINDGEN_BIN: '/bin/true' },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BROWSER_BIN must be an absolute path/);
});

test('the browser smoke script launches Rust from its fixed Cargo launcher', async () => {
  const source = await readFile('scripts/verify-neuromorphic-browser.mjs', 'utf8');

  assert.match(source, /const cargo = join\(cargoHome, 'bin', 'cargo'\);/);
  assert.doesNotMatch(source, /run\('cargo',/);
});
