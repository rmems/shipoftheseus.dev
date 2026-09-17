import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import test from 'node:test';

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
