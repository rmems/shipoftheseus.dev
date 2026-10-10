import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  FONT_VARIANTS,
  LABS_PACKAGE_PATH,
  LAYOUT_WIDTHS,
  TEXT_SCALES,
  builtPagePaths,
  labsPackageRequests,
  overflowFailures,
} from '../scripts/verify-layout.mjs';

test('the layout check covers 320 to 1024 px at 100% and 200% text, in site and wide fonts', () => {
  assert.deepEqual([...LAYOUT_WIDTHS], [320, 360, 375, 768, 1024]);
  assert.deepEqual([...TEXT_SCALES], ['100%', '200%']);
  assert.ok(Object.isFrozen(LAYOUT_WIDTHS) && Object.isFrozen(TEXT_SCALES) && Object.isFrozen(FONT_VARIANTS));
  assert.deepEqual(Object.keys(FONT_VARIANTS), ['site', 'wide']);
  assert.equal(FONT_VARIANTS.site, null, "the site's own stacks, as the machine resolves them");
  // Every font token is replaced by a ~0.6 em monospace face that exists on
  // Linux (DejaVu Sans Mono) and elsewhere (Courier New).
  for (const token of ['--serif', '--sans', '--mono']) {
    assert.match(FONT_VARIANTS.wide, new RegExp(`${token}: 'DejaVu Sans Mono', 'Courier New', monospace;`));
  }
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

test('only measurements that scroll horizontally fail, naming the element and the fonts', () => {
  const failures = overflowFailures([
    { path: '/', width: 320, scale: '100%', fonts: 'site', overflowPx: 0, culprit: null, widest: null },
    {
      path: '/projects/',
      width: 1024,
      scale: '200%',
      fonts: 'wide',
      overflowPx: 22,
      culprit: 'span in a.project-detail-link "→"',
      widest: 'span in a.project-detail-link "→"',
    },
    {
      path: '/work/',
      width: 375,
      scale: '200%',
      fonts: 'site',
      overflowPx: 63,
      culprit: 'span.status in header.case-study-header "Active research"',
      widest: 'i in span.status',
    },
    { path: '/labs/', width: 360, scale: '200%', fonts: 'site', overflowPx: 3, culprit: null, widest: null },
  ]);
  assert.deepEqual(failures, [
    '/projects/ at 1024px, 200% text, wide fonts: scrolls 22px horizontally; first to overflow: span in a.project-detail-link "→"',
    '/work/ at 375px, 200% text: scrolls 63px horizontally; first to overflow: span.status in header.case-study-header "Active research"; reaches furthest: i in span.status',
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
