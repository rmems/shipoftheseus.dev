import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import test from 'node:test';

test('the WASM smoke script rejects a relative wasm-bindgen executable path', () => {
  const result = spawnSync(process.execPath, ['scripts/verify-neuromorphic-wasm.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, WASM_BINDGEN_BIN: 'wasm-bindgen' },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WASM_BINDGEN_BIN must be an absolute path/);
});
