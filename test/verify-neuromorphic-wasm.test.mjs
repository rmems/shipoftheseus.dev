import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';

test('the WASM smoke script rejects a relative wasm-bindgen executable path without leaving an output directory', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'neuromorphic-adapter-test-'));

  try {
    const result = spawnSync(process.execPath, ['scripts/verify-neuromorphic-wasm.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: temporaryRoot, WASM_BINDGEN_BIN: 'wasm-bindgen' },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /WASM_BINDGEN_BIN must be an absolute path/);
    assert.deepEqual(await readdir(temporaryRoot), []);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
