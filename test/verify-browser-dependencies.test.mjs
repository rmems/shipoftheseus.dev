import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
