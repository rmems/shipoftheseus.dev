import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';

const smokeDirectoryPrefix = 'neuromorphic-adapter-smoke-';

async function smokeDirectories() {
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(smokeDirectoryPrefix))
    .map((entry) => entry.name)
    .sort();
}

test('the WASM smoke script rejects a relative wasm-bindgen executable path without leaving an output directory', async () => {
  const before = new Set(await smokeDirectories());

  try {
    const result = spawnSync(process.execPath, ['scripts/verify-neuromorphic-wasm.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, WASM_BINDGEN_BIN: 'wasm-bindgen' },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /WASM_BINDGEN_BIN must be an absolute path/);
    assert.deepEqual(await smokeDirectories(), [...before].sort());
  } finally {
    const after = await smokeDirectories();
    await Promise.all(
      after
        .filter((directory) => !before.has(directory))
        .map((directory) => rm(join(tmpdir(), directory), { recursive: true, force: true })),
    );
  }
});
