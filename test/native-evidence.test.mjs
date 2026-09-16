import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTsModule, readSource } from './load-ts-module.mjs';

const evidence = await loadTsModule('../src/native-evidence/parse.ts');
const load = await loadTsModule('../src/native-evidence/load.ts');
const catalog = await loadTsModule('../src/native-evidence/catalog.ts');
const view = await loadTsModule('../src/native-evidence/view.ts');
const types = await loadTsModule('../src/native-evidence/types.ts');

const fixtures = new URL('./fixtures/native-evidence/', import.meta.url);

function readFixture(name) {
  return readFileSync(new URL(name, fixtures), 'utf8');
}

function withTempCatalog(files, fn) {
  const directory = mkdtempSync(join(tmpdir(), 'native-evidence-'));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const path = join(directory, relativePath);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, contents);
    }
    return fn(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('valid CUDA and FPGA fixtures parse with hardware, workload, units, and source revision', () => {
  const cuda = evidence.parseNativeEvidenceJson(readFixture('valid-cuda-synthetic.json'), {
    path: 'valid-cuda-synthetic.json',
    requireIdMatchesFilename: true,
  });
  const fpga = evidence.parseNativeEvidenceJson(readFixture('valid-fpga-synthetic.json'), {
    path: 'valid-fpga-synthetic.json',
    requireIdMatchesFilename: true,
  });

  assert.equal(cuda.ok, true);
  assert.equal(cuda.artifact.kind, 'cuda-benchmark');
  assert.equal(cuda.artifact.recordStatus, 'synthetic');
  assert.equal(cuda.artifact.hardware.class, 'cuda');
  assert.equal(cuda.artifact.hardware.deviceName, 'Synthetic CUDA device');
  assert.equal(cuda.artifact.workload.name, 'poisson_encode_4096');
  assert.equal(cuda.artifact.results[0].unit, 'µs');
  assert.equal(cuda.artifact.provenance.sourceRevision, '26651ca0edf96b080cd5ef89045543c453bd786c');
  assert.equal(cuda.artifact.provenance.crateName, 'myelin-accelerator');

  assert.equal(fpga.ok, true);
  assert.equal(fpga.artifact.kind, 'fpga-snn-trace');
  assert.equal(fpga.artifact.hardware.class, 'fpga');
  assert.equal(fpga.artifact.traces.length, 3);
  assert.equal(fpga.artifact.traces[1].event, 'spike');
});

test('missing provenance, raw myelin reports, and unknown fields fail closed', () => {
  const missing = evidence.parseNativeEvidenceJson(readFixture('invalid-missing-provenance.json'));
  const raw = evidence.parseNativeEvidenceJson(readFixture('raw-myelin-benchmark.json'));
  const unknown = evidence.parseNativeEvidenceValue({
    schema: types.NATIVE_EVIDENCE_SCHEMA_ID,
    schemaVersion: 1,
    id: 'unknown-field',
    kind: 'cuda-benchmark',
    title: 'Unknown field',
    capturedAt: '2026-09-16T12:00:00Z',
    recordStatus: 'synthetic',
    cudaKernel: 'poisson_encode',
  });

  assert.equal(missing.ok, false);
  assert.equal(missing.issue.code, 'invalid-artifact');
  assert.match(missing.issue.message, /provenance/);

  assert.equal(raw.ok, false);
  assert.equal(raw.issue.code, 'invalid-artifact');

  assert.equal(unknown.ok, false);
  assert.equal(unknown.issue.code, 'invalid-artifact');
  assert.match(unknown.issue.message, /cudaKernel/);
});

test('unsupported schema versions fail closed without ingesting results', () => {
  const unsupported = evidence.parseNativeEvidenceJson(readFixture('unsupported-version.json'));
  const numeric = evidence.parseNativeEvidenceValue({ schemaVersion: 99, results: [{ value: 12.3, unit: 'µs' }] });

  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.issue.code, 'unsupported-version');
  assert.equal(numeric.ok, false);
  assert.equal(numeric.issue.code, 'unsupported-version');
});

test('a missing or empty catalog is a graceful empty state', () => {
  const missing = load.loadNativeEvidenceDirectory(join(tmpdir(), `native-evidence-missing-${Date.now()}`));
  const empty = withTempCatalog({}, (directory) => load.loadNativeEvidenceDirectory(directory));

  assert.equal(missing.status, 'missing');
  assert.deepEqual(missing.artifacts, []);
  assert.deepEqual(missing.issues, []);
  assert.equal(empty.status, 'empty');
  assert.deepEqual(empty.artifacts, []);
  assert.deepEqual(empty.issues, []);
});

test('published ingest rejects synthetic fixtures and does not return partial catalogs', () => {
  const loaded = withTempCatalog(
    {
      'valid-cuda-synthetic.json': readFixture('valid-cuda-synthetic.json'),
      'broken.json': '{',
    },
    (directory) => load.loadNativeEvidenceDirectory(directory, { allowSynthetic: false }),
  );

  assert.equal(loaded.status, 'invalid');
  assert.deepEqual(loaded.artifacts, []);
  assert.equal(loaded.issues.some((issue) => issue.code === 'synthetic-not-publishable'), true);
  assert.equal(loaded.issues.some((issue) => issue.code === 'invalid-json'), true);
});

test('synthetic catalogs can load when explicitly allowed and measured catalogs fail closed on duplicates', () => {
  const allowed = withTempCatalog(
    { 'valid-cuda-synthetic.json': readFixture('valid-cuda-synthetic.json') },
    (directory) => load.loadNativeEvidenceDirectory(directory, { allowSynthetic: true }),
  );
  assert.equal(allowed.status, 'ok');
  assert.equal(allowed.artifacts.length, 1);

  const duplicate = withTempCatalog(
    {
      'valid-cuda-synthetic.json': readFixture('valid-cuda-synthetic.json'),
      'nested/valid-cuda-synthetic.json': readFixture('valid-cuda-synthetic.json'),
    },
    (directory) => load.loadNativeEvidenceDirectory(directory, { allowSynthetic: true }),
  );
  assert.equal(duplicate.status, 'invalid');
  assert.deepEqual(duplicate.artifacts, []);
  assert.equal(duplicate.issues[0].code, 'duplicate-id');
});

test('measured artifacts load from a catalog and synthetic files stay unpublished', () => {
  const measured = JSON.parse(readFixture('valid-cuda-synthetic.json'));
  measured.recordStatus = 'measured';
  measured.id = 'valid-cuda-measured';

  const published = withTempCatalog(
    { 'valid-cuda-measured.json': JSON.stringify(measured) },
    (directory) => load.loadNativeEvidenceDirectory(directory, { allowSynthetic: false }),
  );
  assert.equal(published.status, 'ok');
  assert.equal(published.artifacts[0].id, 'valid-cuda-measured');
  assert.equal(published.artifacts[0].recordStatus, 'measured');

  const mismatch = evidence.parseNativeEvidenceJson(readFixture('valid-cuda-synthetic.json'), {
    path: 'other-name.json',
    requireIdMatchesFilename: true,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.issue.code, 'id-filename-mismatch');
});

test('published loader fails closed when the catalog contains invalid JSON', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'native-evidence-project-'));
  try {
    mkdirSync(join(cwd, 'src/content/native-evidence'), { recursive: true });
    writeFileSync(join(cwd, 'src/content/native-evidence/broken.json'), '{');
    assert.throws(() => catalog.loadPublishedNativeEvidence(cwd), /failed closed/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('the published site catalog is empty until a measured artifact exists', () => {
  const published = catalog.loadPublishedNativeEvidence();

  assert.ok(published.status === 'empty' || published.status === 'missing');
  assert.deepEqual(published.artifacts, []);
  assert.deepEqual(published.issues, []);
});

test('execution origin labels distinguish live WASM from recorded CUDA/FPGA', () => {
  assert.equal(view.executionOriginLabel('live-wasm'), 'LIVE · Rust/WASM');
  assert.equal(view.executionOriginLabel('recorded-cuda-fpga'), 'RECORDED · CUDA/FPGA');
  assert.equal(view.nativeEvidenceKindLabel('cuda-benchmark'), 'CUDA benchmark');
  assert.equal(view.nativeEvidenceKindLabel('fpga-snn-trace'), 'FPGA/SNN trace');
});

test('the live demo and recorded evidence surfaces keep distinct labels and remain static', () => {
  const demo = readSource('../src/components/NeuromorphicDemo.astro');
  const evidenceUi = readSource('../src/components/NativeEvidence.astro');
  const evidencePage = readSource('../src/pages/evidence.astro');
  const home = readSource('../src/pages/index.astro');

  assert.match(demo, /origin="live-wasm"/);
  assert.match(demo, /href="\/evidence\/"/);
  assert.doesNotMatch(demo, /client:only/);
  assert.match(evidenceUi, /origin="recorded-cuda-fpga"/);
  assert.match(evidenceUi, /data-evidence-empty/);
  assert.match(evidenceUi, /EMPTY_NATIVE_EVIDENCE_COPY/);
  assert.match(evidencePage, /loadPublishedNativeEvidence/);
  assert.match(home, /NativeEvidence/);
  assert.match(home, /loadPublishedNativeEvidence/);
});

test('the browser package graph does not include native CUDA, FPGA, or IPC dependencies', () => {
  const packageJson = readSource('../package.json');
  const lockfile = readSource('../package-lock.json');
  const sources = [
    readSource('../package.json'),
    readSource('../src/pages/index.astro'),
    readSource('../src/pages/evidence.astro'),
    readSource('../src/components/NativeEvidence.astro'),
    readSource('../src/components/NeuromorphicDemo.astro'),
    readSource('../src/runtime/enhance-demo.ts'),
    readSource('../src/runtime/demo-runtime.ts'),
    readSource('../src/native-evidence/catalog.ts'),
    readSource('../src/native-evidence/load.ts'),
    readSource('../src/native-evidence/parse.ts'),
  ].join('\n');

  for (const name of types.FORBIDDEN_BROWSER_DEPENDENCY_NAMES) {
    assert.doesNotMatch(packageJson, new RegExp(`"${name}"`));
    assert.doesNotMatch(lockfile, new RegExp(`"node_modules/${name}"`));
  }

  assert.doesNotMatch(sources, /from\s+['"](?:myelin-accelerator|cust|zeromq|hdf5)/);
  assert.doesNotMatch(sources, /features:\s*['"]cuda['"]/);
});
