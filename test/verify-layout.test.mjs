import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  LABS_PACKAGE_PATH,
  LAYOUT_WIDTHS,
  TEXT_SCALES,
  builtPagePaths,
  labsPackageRequests,
  overflowFailures,
} from '../scripts/verify-layout.mjs';

test('the layout check covers 320 to 1024 px at 100% and 200% text', () => {
  assert.deepEqual([...LAYOUT_WIDTHS], [320, 360, 375, 768, 1024]);
  assert.deepEqual([...TEXT_SCALES], ['100%', '200%']);
  assert.ok(Object.isFrozen(LAYOUT_WIDTHS) && Object.isFrozen(TEXT_SCALES));
});

test('every built HTML page is listed by its URL path', async (t) => {
  const dist = await mkdtemp(join(tmpdir(), 'layout-dist-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await mkdir(join(dist, 'labs', 'nir'), { recursive: true });
  await mkdir(join(dist, '_astro'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '');
  await writeFile(join(dist, '404.html'), '');
  await writeFile(join(dist, 'labs', 'index.html'), '');
  await writeFile(join(dist, 'labs', 'nir', 'index.html'), '');
  await writeFile(join(dist, '_astro', 'island.js'), '');

  assert.deepEqual(await builtPagePaths(dist), ['/', '/404.html', '/labs/', '/labs/nir/']);
});

test('only measurements that scroll horizontally fail, with a readable line', () => {
  const failures = overflowFailures([
    { path: '/', width: 320, scale: '100%', overflowPx: 0, widest: null },
    { path: '/work/', width: 375, scale: '200%', overflowPx: 63, widest: 'a' },
    { path: '/labs/', width: 360, scale: '200%', overflowPx: 3, widest: null },
  ]);
  assert.deepEqual(failures, [
    '/work/ at 375px, 200% text: scrolls 63px horizontally (widest: a)',
    '/labs/ at 360px, 200% text: scrolls 3px horizontally',
  ]);
});

test('labs package requests are recognized by path, with or without a query', () => {
  assert.equal(LABS_PACKAGE_PATH, '/wasm/neuromorphic-adapter-labs/');
  assert.deepEqual(
    labsPackageRequests([
      '/',
      '/wasm/neuromorphic-adapter/neuromorphic_adapter.js',
      '/wasm/neuromorphic-adapter-labs/neuromorphic_adapter_bg.wasm',
      '/wasm/neuromorphic-adapter-labs/neuromorphic_adapter.js?v=1',
    ]),
    ['/wasm/neuromorphic-adapter-labs/neuromorphic_adapter_bg.wasm', '/wasm/neuromorphic-adapter-labs/neuromorphic_adapter.js?v=1'],
  );
});

test('the layout check refuses to run without an absolute browser path', () => {
  const environment = { ...process.env };
  delete environment.BROWSER_BIN;
  const missing = spawnSync(process.execPath, ['scripts/verify-layout.mjs'], { encoding: 'utf8', env: environment });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /BROWSER_BIN must be an absolute path/);

  const relative = spawnSync(process.execPath, ['scripts/verify-layout.mjs'], {
    encoding: 'utf8',
    env: { ...environment, BROWSER_BIN: 'chrome' },
  });
  assert.notEqual(relative.status, 0);
  assert.match(relative.stderr, /BROWSER_BIN must be an absolute path/);
});
