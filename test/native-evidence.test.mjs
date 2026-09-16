import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

function cloneFixture(name) {
  return JSON.parse(readFixture(name));
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

test('measured artifacts fail closed without a capture method', () => {
  const missing = evidence.parseNativeEvidenceJson(readFixture('invalid-measured-missing-capture.json'));
  assert.equal(missing.ok, false);
  assert.equal(missing.issue.code, 'invalid-artifact');
  assert.match(missing.issue.message, /captureCommand/);

  const emptyCommand = JSON.parse(readFixture('valid-cuda-synthetic.json'));
  emptyCommand.recordStatus = 'measured';
  emptyCommand.id = 'valid-cuda-measured';
  emptyCommand.provenance.captureCommand = '';
  const empty = evidence.parseNativeEvidenceValue(emptyCommand);
  assert.equal(empty.ok, false);
  assert.equal(empty.issue.code, 'invalid-artifact');
  assert.match(empty.issue.message, /captureCommand/);

  const published = withTempCatalog(
    { 'invalid-measured-missing-capture.json': readFixture('invalid-measured-missing-capture.json') },
    (directory) => load.loadNativeEvidenceDirectory(directory, { allowSynthetic: false }),
  );
  assert.equal(published.status, 'invalid');
  assert.deepEqual(published.artifacts, []);
  assert.equal(
    published.issues.some((issue) => issue.code === 'invalid-artifact' && /captureCommand/.test(issue.message)),
    true,
  );

  const cwd = mkdtempSync(join(tmpdir(), 'native-evidence-missing-capture-'));
  try {
    mkdirSync(join(cwd, 'src/content/native-evidence'), { recursive: true });
    writeFileSync(
      join(cwd, 'src/content/native-evidence/invalid-measured-missing-capture.json'),
      readFixture('invalid-measured-missing-capture.json'),
    );
    assert.throws(() => catalog.loadPublishedNativeEvidence(cwd), /captureCommand/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
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
  assert.equal(
    published.artifacts[0].provenance.captureCommand,
    'cargo run --example benchmark --features bench,cuda',
  );

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

test('published ingest accepts zero or more measured-only artifacts', () => {
  const published = catalog.loadPublishedNativeEvidence();

  assert.notEqual(published.status, 'invalid');
  assert.deepEqual(published.issues, []);
  assert.equal(
    published.artifacts.every((artifact) => artifact.recordStatus === 'measured'),
    true,
  );
  if (published.artifacts.length > 0) {
    assert.equal(published.status, 'ok');
  } else {
    assert.ok(published.status === 'empty' || published.status === 'missing');
  }

  const measured = cloneFixture('valid-cuda-synthetic.json');
  measured.recordStatus = 'measured';
  measured.id = 'valid-cuda-measured';
  const cwd = mkdtempSync(join(tmpdir(), 'native-evidence-future-measured-'));
  try {
    mkdirSync(join(cwd, 'src/content/native-evidence'), { recursive: true });
    writeFileSync(
      join(cwd, 'src/content/native-evidence/valid-cuda-measured.json'),
      JSON.stringify(measured),
    );
    const future = catalog.loadPublishedNativeEvidence(cwd);
    assert.equal(future.status, 'ok');
    assert.deepEqual(future.issues, []);
    assert.equal(future.artifacts.length, 1);
    assert.equal(future.artifacts[0].recordStatus, 'measured');
    assert.equal(future.artifacts[0].id, 'valid-cuda-measured');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('catalog discovery fails closed when depth, file count, or aggregate bytes exceed small limits', () => {
  const measured = cloneFixture('valid-cuda-synthetic.json');
  measured.recordStatus = 'measured';
  measured.id = 'too-deep';
  const deepPath = ['n1', 'n2', 'n3', 'n4', 'n5', 'too-deep.json'].join('/');
  const deep = withTempCatalog(
    { [deepPath]: JSON.stringify(measured) },
    (directory) => load.loadNativeEvidenceDirectory(directory),
  );
  assert.equal(deep.status, 'invalid');
  assert.deepEqual(deep.artifacts, []);
  assert.equal(deep.issues.length, 1);
  assert.equal(deep.issues[0].code, 'catalog-limit-exceeded');
  assert.match(deep.issues[0].message, /depth/);

  measured.id = 'depth-ok';
  const boundedPath = ['n1', 'n2', 'n3', 'n4', 'depth-ok.json'].join('/');
  const bounded = withTempCatalog(
    { [boundedPath]: JSON.stringify(measured) },
    (directory) => load.loadNativeEvidenceDirectory(directory),
  );
  assert.equal(bounded.status, 'ok');
  assert.equal(bounded.artifacts.length, 1);

  const many = {};
  for (let index = 0; index < load.MAX_CATALOG_JSON_FILES + 1; index += 1) {
    many[`overflow-${index}.json`] = '{}';
  }
  const tooMany = withTempCatalog(many, (directory) => load.loadNativeEvidenceDirectory(directory));
  assert.equal(tooMany.status, 'invalid');
  assert.deepEqual(tooMany.artifacts, []);
  assert.equal(tooMany.issues[0].code, 'catalog-limit-exceeded');
  assert.match(tooMany.issues[0].message, /JSON artifacts/);

  const padding = `{${'x'.repeat(220 * 1024)}`;
  const oversized = withTempCatalog(
    {
      'a.json': padding,
      'b.json': padding,
      'c.json': padding,
      'd.json': padding,
      'e.json': padding,
    },
    (directory) => load.loadNativeEvidenceDirectory(directory),
  );
  assert.equal(oversized.status, 'invalid');
  assert.deepEqual(oversized.artifacts, []);
  assert.equal(oversized.issues[0].code, 'catalog-limit-exceeded');
  assert.match(oversized.issues[0].message, /byte ingest limit/);
});

test('filesystem listing, stat, and read failures become fail-closed catalog issues', () => {
  const dangling = withTempCatalog({}, (directory) => {
    symlinkSync(join(directory, 'missing-target.json'), join(directory, 'broken.json'));
    return load.loadNativeEvidenceDirectory(directory);
  });
  assert.equal(dangling.status, 'invalid');
  assert.deepEqual(dangling.artifacts, []);
  assert.equal(dangling.issues.length, 1);
  assert.equal(dangling.issues[0].code, 'catalog-io-error');
  assert.match(dangling.issues[0].message, /regular files/);

  const sibling = cloneFixture('valid-cuda-synthetic.json');
  sibling.recordStatus = 'measured';
  sibling.id = 'visible-measured';
  const listing = withTempCatalog({ 'visible-measured.json': JSON.stringify(sibling) }, (directory) => {
    const nested = join(directory, 'nested');
    mkdirSync(nested);
    chmodSync(nested, 0);
    try {
      return load.loadNativeEvidenceDirectory(directory);
    } finally {
      chmodSync(nested, 0o755);
    }
  });
  assert.equal(listing.status, 'invalid');
  assert.deepEqual(listing.artifacts, []);
  assert.equal(listing.issues.length, 1);
  assert.equal(listing.issues[0].code, 'catalog-io-error');
  assert.match(listing.issues[0].message, /list/);

  const statDenied = withTempCatalog({ 'nested/secret.json': '{"schema":1}' }, (directory) => {
    const nested = join(directory, 'nested');
    chmodSync(nested, 0o400);
    try {
      return load.loadNativeEvidenceDirectory(directory);
    } finally {
      chmodSync(nested, 0o755);
    }
  });
  assert.equal(statDenied.status, 'invalid');
  assert.deepEqual(statDenied.artifacts, []);
  assert.equal(statDenied.issues[0].code, 'catalog-io-error');
  assert.match(statDenied.issues[0].message, /stat/);

  const unread = withTempCatalog({ 'secret.json': '{"schema":1}' }, (directory) => {
    chmodSync(join(directory, 'secret.json'), 0);
    try {
      return load.loadNativeEvidenceDirectory(directory);
    } finally {
      chmodSync(join(directory, 'secret.json'), 0o644);
    }
  });
  assert.equal(unread.status, 'invalid');
  assert.deepEqual(unread.artifacts, []);
  assert.equal(unread.issues[0].code, 'catalog-io-error');
  assert.match(unread.issues[0].message, /read/);
});

test('catalog discovery rejects symlinks and does not follow them outside the catalog', () => {
  const measured = cloneFixture('valid-cuda-synthetic.json');
  measured.recordStatus = 'measured';
  measured.id = 'valid-cuda-measured';
  const payload = JSON.stringify(measured);

  const outside = mkdtempSync(join(tmpdir(), 'native-evidence-outside-'));
  const realCatalog = mkdtempSync(join(tmpdir(), 'native-evidence-real-catalog-'));
  const parent = mkdtempSync(join(tmpdir(), 'native-evidence-root-parent-'));
  try {
    const outsideFile = join(outside, 'valid-cuda-measured.json');
    writeFileSync(outsideFile, payload);
    const escaped = withTempCatalog({}, (directory) => {
      symlinkSync(outsideFile, join(directory, 'valid-cuda-measured.json'));
      return load.loadNativeEvidenceDirectory(directory);
    });
    assert.equal(escaped.status, 'invalid');
    assert.deepEqual(escaped.artifacts, []);
    assert.equal(escaped.issues[0].code, 'catalog-io-error');
    assert.match(escaped.issues[0].message, /regular files/);

    writeFileSync(join(realCatalog, 'valid-cuda-measured.json'), payload);
    const linkedRoot = join(parent, 'catalog');
    symlinkSync(realCatalog, linkedRoot);
    const followed = load.loadNativeEvidenceDirectory(linkedRoot);
    assert.equal(followed.status, 'invalid');
    assert.deepEqual(followed.artifacts, []);
    assert.equal(followed.issues[0].code, 'catalog-io-error');
    assert.match(followed.issues[0].message, /real directory/);

    const danglingRoot = join(parent, 'dangling-catalog');
    symlinkSync(join(parent, 'missing-catalog'), danglingRoot);
    const missingLink = load.loadNativeEvidenceDirectory(danglingRoot);
    assert.equal(missingLink.status, 'invalid');
    assert.notEqual(missingLink.status, 'missing');
    assert.deepEqual(missingLink.artifacts, []);
    assert.equal(missingLink.issues[0].code, 'catalog-io-error');
    assert.match(missingLink.issues[0].message, /real directory/);

    const cwd = mkdtempSync(join(tmpdir(), 'native-evidence-published-link-'));
    try {
      mkdirSync(join(cwd, 'src/content'), { recursive: true });
      symlinkSync(realCatalog, join(cwd, 'src/content/native-evidence'));
      assert.throws(
        () => catalog.loadPublishedNativeEvidence(cwd),
        /failed closed[\s\S]*catalog-io-error/,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(realCatalog, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test('execution origin labels distinguish live WASM from recorded CUDA/FPGA', () => {
  assert.equal(view.executionOriginLabel('live-wasm'), 'LIVE · Rust/WASM');
  assert.equal(view.executionOriginLabel('static-diagram'), 'STATIC · diagram');
  assert.equal(view.executionOriginLabel('unavailable-wasm'), 'UNAVAILABLE · Rust/WASM');
  assert.equal(view.executionOriginLabel('recorded-cuda-fpga'), 'RECORDED · CUDA/FPGA');
  assert.equal(view.executionOriginData('live-wasm'), 'live');
  assert.equal(view.executionOriginData('static-diagram'), 'static');
  assert.equal(view.executionOriginData('unavailable-wasm'), 'unavailable');
  assert.equal(view.nativeEvidenceKindLabel('cuda-benchmark'), 'CUDA benchmark');
  assert.equal(view.nativeEvidenceKindLabel('fpga-snn-trace'), 'FPGA/SNN trace');
});

test('the live demo and recorded evidence surfaces keep distinct labels and remain static', () => {
  const demo = readSource('../src/components/NeuromorphicDemo.astro');
  const evidenceUi = readSource('../src/components/NativeEvidence.astro');
  const evidencePage = readSource('../src/pages/evidence.astro');
  const home = readSource('../src/pages/index.astro');
  const enhance = readSource('../src/runtime/enhance-demo.ts');

  assert.match(demo, /origin="static-diagram"/);
  assert.match(demo, /runtimeBound/);
  assert.doesNotMatch(demo, /origin="live-wasm"/);
  assert.doesNotMatch(demo, /LIVE · Rust\/WASM/);
  assert.match(demo, /href="\/evidence\/"/);
  assert.doesNotMatch(demo, /client:only/);
  assert.doesNotMatch(enhance, /provideDemoSeams/);
  assert.match(evidenceUi, /origin="recorded-cuda-fpga"/);
  assert.match(evidenceUi, /data-evidence-empty/);
  assert.match(evidenceUi, /EMPTY_NATIVE_EVIDENCE_COPY/);
  assert.match(evidenceUi, /data-evidence-capture/);
  assert.match(evidenceUi, /displayCaptureMethod/);
  assert.match(evidenceUi, /data-evidence-workload-description/);
  assert.match(evidenceUi, /data-evidence-workload-parameters/);
  assert.match(evidenceUi, /tracePreviewCaption/);
  assert.match(evidenceUi, /Full versioned capture/);
  assert.doesNotMatch(evidenceUi, /\{artifact\.provenance\.captureCommand\}/);
  assert.match(evidencePage, /loadPublishedNativeEvidence/);
  assert.doesNotMatch(home, /NativeEvidence/);
  assert.doesNotMatch(home, /loadPublishedNativeEvidence/);
  assert.match(readSource('../src/data/site.ts'), /href: '\/evidence\/'/);
});

test('impossible calendar dates fail closed and fractional instants sort newest first', () => {
  const impossibleDay = cloneFixture('valid-cuda-synthetic.json');
  impossibleDay.capturedAt = '2026-02-31T12:00:00Z';
  const february31 = evidence.parseNativeEvidenceValue(impossibleDay);
  assert.equal(Number.isNaN(Date.parse('2026-02-31T12:00:00Z')), false);
  assert.equal(february31.ok, false);
  assert.equal(february31.issue.code, 'invalid-artifact');
  assert.match(february31.issue.message, /capturedAt/);

  const nonLeap = cloneFixture('valid-cuda-synthetic.json');
  nonLeap.capturedAt = '2025-02-29T00:00:00Z';
  assert.equal(evidence.parseNativeEvidenceValue(nonLeap).ok, false);

  const validLeap = cloneFixture('valid-cuda-synthetic.json');
  validLeap.capturedAt = '2024-02-29T00:00:00Z';
  assert.equal(evidence.parseNativeEvidenceValue(validLeap).ok, true);

  const april31 = cloneFixture('valid-cuda-synthetic.json');
  april31.capturedAt = '2026-04-31T12:00:00Z';
  assert.equal(evidence.parseNativeEvidenceValue(april31).ok, false);

  const early = cloneFixture('valid-cuda-synthetic.json');
  early.id = 'early';
  early.capturedAt = '2026-09-16T12:00:00Z';
  const mid = cloneFixture('valid-cuda-synthetic.json');
  mid.id = 'mid';
  mid.capturedAt = '2026-09-16T12:00:00.1Z';
  const late = cloneFixture('valid-cuda-synthetic.json');
  late.id = 'late';
  late.capturedAt = '2026-09-16T12:00:00.100000001Z';
  const sameA = cloneFixture('valid-cuda-synthetic.json');
  sameA.id = 'same-a';
  sameA.capturedAt = '2026-09-16T12:00:00.1Z';
  const sameB = cloneFixture('valid-cuda-synthetic.json');
  sameB.id = 'same-b';
  sameB.capturedAt = '2026-09-16T12:00:00.100Z';

  assert.equal(evidence.compareCapturedAt(early.capturedAt, mid.capturedAt), -1);
  assert.equal(evidence.compareCapturedAt(mid.capturedAt, late.capturedAt), -1);
  assert.equal(evidence.compareCapturedAt(sameA.capturedAt, sameB.capturedAt), 0);

  const ordered = withTempCatalog(
    {
      'early.json': JSON.stringify(early),
      'mid.json': JSON.stringify(mid),
      'late.json': JSON.stringify(late),
      'same-a.json': JSON.stringify(sameA),
      'same-b.json': JSON.stringify(sameB),
    },
    (directory) => load.loadNativeEvidenceDirectory(directory, { allowSynthetic: true }),
  );
  assert.equal(ordered.status, 'ok');
  assert.deepEqual(
    ordered.artifacts.map((artifact) => artifact.id),
    ['late', 'mid', 'same-a', 'same-b', 'early'],
  );
});

test('credentialed and ported GitHub provenance URLs fail closed', () => {
  const artifact = cloneFixture('valid-cuda-synthetic.json');
  const invalid = [
    'https://user@github.com/Limen-Neural/myelin-accelerator',
    'https://user:token@github.com/Limen-Neural/myelin-accelerator',
    'https://github.com:443/Limen-Neural/myelin-accelerator',
    'https://github.com:8080/Limen-Neural/myelin-accelerator',
  ];

  for (const sourceRepository of invalid) {
    artifact.provenance.sourceRepository = sourceRepository;
    const parsed = evidence.parseNativeEvidenceValue(artifact);
    assert.equal(evidence.isGitHubRepositoryUrl(sourceRepository), false, sourceRepository);
    assert.equal(parsed.ok, false, sourceRepository);
    assert.match(parsed.issue.message, /sourceRepository/);
  }

  assert.equal(
    evidence.isGitHubRepositoryUrl('https://github.com/Limen-Neural/myelin-accelerator'),
    true,
  );
});

test('trace timestamps and neuron ids reject integers above MAX_SAFE_INTEGER', () => {
  const accepted = cloneFixture('valid-fpga-synthetic.json');
  accepted.traces[0].timeNs = Number.MAX_SAFE_INTEGER;
  accepted.traces[0].neuronId = 0;
  const ok = evidence.parseNativeEvidenceValue(accepted);
  assert.equal(ok.ok, true);
  assert.equal(ok.artifact.traces[0].timeNs, Number.MAX_SAFE_INTEGER);
  assert.equal(ok.artifact.traces[0].neuronId, 0);

  const overflowTime = cloneFixture('valid-fpga-synthetic.json');
  overflowTime.traces[0].timeNs = Number.MAX_SAFE_INTEGER + 1;
  const time = evidence.parseNativeEvidenceValue(overflowTime);
  assert.equal(time.ok, false);
  assert.equal(time.issue.code, 'invalid-artifact');
  assert.match(time.issue.message, /timeNs/);

  const overflowNeuron = cloneFixture('valid-fpga-synthetic.json');
  overflowNeuron.traces[1].neuronId = Number.MAX_SAFE_INTEGER + 1;
  const neuron = evidence.parseNativeEvidenceValue(overflowNeuron);
  assert.equal(neuron.ok, false);
  assert.match(neuron.issue.message, /neuronId/);

  const fractional = cloneFixture('valid-fpga-synthetic.json');
  fractional.traces[0].timeNs = 1.5;
  const fraction = evidence.parseNativeEvidenceValue(fractional);
  assert.equal(fraction.ok, false);
  assert.match(fraction.issue.message, /timeNs/);

  const jsonOverflow = readFixture('valid-fpga-synthetic.json').replace(
    '"timeNs": 12',
    '"timeNs": 9007199254740993',
  );
  const parsedJson = evidence.parseNativeEvidenceJson(jsonOverflow);
  assert.equal(parsedJson.ok, false);
  assert.match(parsedJson.issue.message, /timeNs/);
});

test('recorded metric formatting never renders a finite nonzero value as zero', () => {
  assert.equal(view.formatResultValue(1), '1');
  assert.equal(view.formatResultValue(1.25), '1.25');
  assert.equal(view.formatResultValue(0), '0');
  assert.notEqual(view.formatResultValue(0.00001), '0');
  assert.notEqual(view.formatResultValue(-0.00001), '0');
  assert.notEqual(Number(view.formatResultValue(0.00001)), 0);
  assert.equal(view.formatResultValue(0.00014), '0.00014');
  assert.equal(view.formatResultValue(1.00001), '1.00001');

  const roundTrips = [1, 1.25, 0, 0.00001, -0.00001, 0.00014, 1.00001, -12.5, 1e-7, 1e21, Number.MAX_SAFE_INTEGER];
  for (const value of roundTrips) {
    assert.equal(Number(view.formatResultValue(value).replaceAll(',', '')), value);
  }
});

test('crate versions accept SemVer build metadata', () => {
  const accepted = ['0.2.0', '1.2.3-alpha.1', '1.2.3+cuda.12', '1.2.3-alpha.1+build.7'];
  for (const crateVersion of accepted) {
    const artifact = cloneFixture('valid-cuda-synthetic.json');
    artifact.provenance.crateVersion = crateVersion;
    const parsed = evidence.parseNativeEvidenceValue(artifact);
    assert.equal(parsed.ok, true, crateVersion);
    assert.equal(parsed.artifact.provenance.crateVersion, crateVersion);
  }

  const rejected = ['1.2', '1.2.3+', '1.2.3-', '1.2.3+_build'];
  for (const crateVersion of rejected) {
    const artifact = cloneFixture('valid-cuda-synthetic.json');
    artifact.provenance.crateVersion = crateVersion;
    const parsed = evidence.parseNativeEvidenceValue(artifact);
    assert.equal(parsed.ok, false, crateVersion);
    assert.match(parsed.issue.message, /crateVersion/);
  }
});

test('public capture labels stay display-safe and omit secrets or local paths', () => {
  assert.equal(
    view.displayCaptureMethod('cargo run --example benchmark --features bench,cuda'),
    'cargo · example benchmark · features bench,cuda',
  );

  const secret = 'TOKEN=ghp_secret cargo run --example benchmark --features bench,cuda -- /home/ubuntu/.ssh/id_rsa';
  const displayed = view.displayCaptureMethod(secret);
  assert.equal(displayed, 'Recorded native capture');
  assert.doesNotMatch(displayed, /ghp_secret/);
  assert.doesNotMatch(displayed, /TOKEN=/);
  assert.doesNotMatch(displayed, /\/home\//);
  assert.doesNotMatch(displayed, /id_rsa/);

  const evidenceUi = readSource('../src/components/NativeEvidence.astro');
  assert.match(evidenceUi, /displayCaptureMethod\(artifact\.provenance\.captureCommand\)/);
  assert.doesNotMatch(evidenceUi, /<code data-evidence-capture>\{artifact\.provenance\.captureCommand\}<\/code>/);
});

test('trace captions disclose preview truncation and preserve a path to the full capture', () => {
  assert.equal(view.TRACE_PREVIEW_LIMIT, 12);
  assert.equal(view.tracePreviewCaption(3), 'Recorded hardware trace (3 events)');
  assert.equal(
    view.tracePreviewCaption(13),
    'Recorded hardware trace preview (showing first 12 of 13 events)',
  );

  const css = readSource('../src/styles/global.css');
  assert.match(css, /\.native-evidence-table-wrap/);
  assert.match(css, /\.native-evidence-results th,[\s\S]*overflow-wrap: anywhere/);
});

test('workload parameter formatting is deterministic and exhaustive', () => {
  assert.deepEqual(
    view.sortedWorkloadParameterEntries({ iterations: 100, neurons: 4096, fused: true }),
    [
      ['fused', true],
      ['iterations', 100],
      ['neurons', 4096],
    ],
  );
  assert.equal(view.formatWorkloadParameterValue('sm_120'), 'sm_120');
  assert.equal(view.formatWorkloadParameterValue(4096), '4096');
  assert.equal(view.formatWorkloadParameterValue(true), 'true');
  assert.equal(view.formatWorkloadParameterValue(false), 'false');
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
