/* global ReadableStream, Response, TextDecoder, TextEncoder -- Node 20+ web globals */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadTsModule, readSource } from './load-ts-module.mjs';

// Every case here crosses the real JS boundary: the committed
// `public/wasm/neuromorphic-adapter` package, loaded in Node, behind the
// TypeScript bridge the `/protocol/` page uses.
const repository = fileURLToPath(new URL('..', import.meta.url));
const packageDir = join(repository, 'public/wasm/neuromorphic-adapter');
const fixtureDir = join(repository, 'public/protocol/fixtures/v1');
const manifest = JSON.parse(readFileSync(join(fixtureDir, 'manifest.json'), 'utf8'));

const bridge = await loadTsModule('../src/protocol/inspector.ts');
const provenance = await loadTsModule('../src/protocol/provenance.ts');
const enhance = await loadTsModule('../src/protocol/enhance-protocol.ts');
const catalogModule = await loadTsModule('../src/protocol/catalog.ts');

const wasm = await import(pathToFileURL(join(packageDir, 'neuromorphic_adapter.js')).href);
const wasmBytes = readFileSync(join(packageDir, 'neuromorphic_adapter_bg.wasm'));
const loadWasmModule = async () => ({
  ...wasm,
  default: () => wasm.default({ module_or_path: wasmBytes }),
});
const inspector = await bridge.createProtocolInspector(loadWasmModule);

const encode = (text) => new TextEncoder().encode(text);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixtureBytes = (entry) => new Uint8Array(readFileSync(join(fixtureDir, entry.file)));

const STIMULI = '{"wire_version":1,"payload":{"Stimuli":{"session_id":"s","batch_id":9007199254740993,"timestamp":18446744073709551615,"values":[0.5,1.0],"valid_mask":[true,false],"metadata":null}}}';
const SPIKES = '{"wire_version":1,"payload":{"Spikes":{"session_id":"s","batch_id":1,"timestamp":2,"spikes":[{"channel":3,"time":4,"strength":1.0}],"metadata":null}}}';
const TRACES = '{"wire_version":1,"payload":{"EligibilityTraces":{"session_id":"s","batch_id":18446744073709551615,"traces":[{"channel_id":0,"trace_value":0.25,"last_spike_time":7}]}}}';
const SPIKES_PAYLOAD = '{"Spikes":{"session_id":"s","batch_id":1,"timestamp":2,"spikes":[],"metadata":null}}';

function signedInspect(text, variant) {
  const bytes = typeof text === 'string' ? encode(text) : text;
  return inspector.inspect(bytes, sha256(bytes), variant);
}

function assertRejects(run, code) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof bridge.ProtocolFixtureError, `expected ProtocolFixtureError, got ${error}`);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

test('the committed recorded fixtures decode through the real adapter with exact bigints', () => {
  assert.deepEqual(
    manifest.fixtures.map((entry) => entry.variant),
    ['Stimuli', 'Spikes', 'EligibilityTraces'],
  );
  for (const entry of manifest.fixtures) {
    const bytes = fixtureBytes(entry);
    assert.equal(bytes.length, entry.bytes);
    assert.equal(sha256(bytes), entry.sha256);
    const inspection = inspector.inspect(bytes, entry.sha256, entry.variant);
    assert.equal(inspection.variant, entry.variant);
    assert.equal(inspection.wireVersion, 1);
    assert.deepEqual(inspection.wireWindow, { minSupported: 1, current: 1 });
    assert.equal(typeof inspection.batchId, 'bigint');
    assert.equal(inspection.batchId, 9007199254740993n);
    assert.equal(inspection.sessionId, 'kinetic-seed9-golden');
    assert.equal(inspection.canonicalMatchesInput, true);
    assert.equal(inspection.canonicalJson, new TextDecoder().decode(bytes));
  }

  const [stimuli, spikes, traces] = manifest.fixtures.map((entry) =>
    inspector.inspect(fixtureBytes(entry), entry.sha256, entry.variant),
  );
  assert.equal(stimuli.stimuli.values.length, 16);
  assert.ok(stimuli.stimuli.values.every((value) => value >= 0 && value <= 1));
  assert.equal(stimuli.stimuli.validMask, null);
  assert.equal(stimuli.timestamp, 0n);
  assert.deepEqual(stimuli.metadata.custom, [['completed_step', String(manifest.source_step)]]);
  assert.equal(stimuli.metadata.processingLatencyNs, null);
  assert.equal(spikes.spikes.channels.length, spikes.spikes.times.length);
  assert.ok(spikes.spikes.channels.length > 0);
  assert.ok(spikes.spikes.times.every((time) => time === manifest.source_step));
  assert.equal(traces.timestamp, null);
  assert.equal(traces.traces.channelIds.length, 16);
  assert.equal(traces.metadata, null);
});

test('u64 values above Number.MAX_SAFE_INTEGER round-trip losslessly as bigint', () => {
  // The lossy path the bridge avoids: JavaScript JSON parsing rounds 2^53 + 1.
  assert.equal(JSON.parse('9007199254740993'), 9007199254740992);

  const stimuli = signedInspect(STIMULI, 'Stimuli');
  assert.equal(stimuli.batchId, 9007199254740993n);
  assert.equal(stimuli.timestamp, 18446744073709551615n);
  assert.deepEqual([...stimuli.stimuli.validMask], [1, 0]);
  const traces = signedInspect(TRACES, 'EligibilityTraces');
  assert.equal(traces.batchId, (1n << 64n) - 1n);
  const spikes = signedInspect(
    '{"wire_version":1,"payload":{"Spikes":{"session_id":null,"batch_id":1,"timestamp":2,"spikes":[],"metadata":{"processing_latency_ns":18446744073709551615,"source":null,"custom":{"b":"2","a":"1"}}}}}',
    'Spikes',
  );
  assert.equal(spikes.metadata.processingLatencyNs, 18446744073709551615n);
  assert.deepEqual(spikes.metadata.custom, [['a', '1'], ['b', '2']]);
  assert.equal(spikes.sessionId, null);
});

test('oversize and digest failures are rejected before parsing', () => {
  const oversize = new Uint8Array(inspector.byteLimit + 1).fill(0x20);
  oversize.set(encode(STIMULI));
  assertRejects(() => inspector.inspect(oversize, sha256(oversize), 'Stimuli'), 'oversize');
  assertRejects(() => inspector.inspect(oversize, '0'.repeat(64), 'Stimuli'), 'oversize');

  const entry = manifest.fixtures[0];
  const tampered = fixtureBytes(entry);
  tampered[tampered.length - 2] ^= 1;
  assertRejects(() => inspector.inspect(tampered, entry.sha256, entry.variant), 'digest-mismatch');
  assertRejects(() => inspector.inspect(encode('{not json'), entry.sha256, entry.variant), 'digest-mismatch');

  const bytes = encode(STIMULI);
  for (const digest of ['', sha256(bytes).toUpperCase(), sha256(bytes).slice(1)]) {
    assertRejects(() => inspector.inspect(bytes, digest, 'Stimuli'), 'expected-digest-invalid');
  }
  assertRejects(() => inspector.inspect(bytes, sha256(bytes), 'Ping'), 'expected-variant-unsupported');
});

test('malformed JSON and non-object envelopes fail closed', () => {
  for (const text of ['', '{"wire_version":1,"payload":', `${STIMULI} trailing`, `${STIMULI}${STIMULI}`]) {
    assertRejects(() => signedInspect(text, 'Stimuli'), 'malformed-json');
  }
  assertRejects(() => signedInspect(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]), 'Stimuli'), 'malformed-json');
  for (const text of ['"Ping"', '[1]', 'null']) {
    assertRejects(() => signedInspect(text, 'Stimuli'), 'envelope-not-object');
  }
});

test('missing, null, duplicate, old, future, and invalid wire versions fail closed', () => {
  const cases = [
    [`{"payload":${SPIKES_PAYLOAD}}`, 'wire-version-missing'],
    [SPIKES_PAYLOAD, 'wire-version-missing'],
    [`{"wire_version":null,"payload":${SPIKES_PAYLOAD}}`, 'wire-version-null'],
    [`{"wire_version":1,"wire_version":1,"payload":${SPIKES_PAYLOAD}}`, 'wire-version-duplicate'],
    [`{"wire_version":0,"payload":${SPIKES_PAYLOAD}}`, 'wire-version-too-old'],
    [`{"wire_version":2,"payload":${SPIKES_PAYLOAD}}`, 'wire-version-too-new'],
    [`{"wire_version":"1","payload":${SPIKES_PAYLOAD}}`, 'wire-version-invalid'],
    [`{"wire_version":-1,"payload":${SPIKES_PAYLOAD}}`, 'wire-version-invalid'],
    [`{"wire_version":4294967296,"payload":${SPIKES_PAYLOAD}}`, 'wire-version-invalid'],
  ];
  for (const [text, code] of cases) {
    assertRejects(() => signedInspect(text, 'Spikes'), code);
  }
});

test('missing, null, and duplicate payloads fail closed', () => {
  assertRejects(() => signedInspect('{"wire_version":1}', 'Spikes'), 'payload-missing');
  assertRejects(() => signedInspect('{"wire_version":1,"payload":null}', 'Spikes'), 'payload-null');
  assertRejects(
    () => signedInspect(`{"wire_version":1,"payload":"Ping","payload":${SPIKES_PAYLOAD}}`, 'Spikes'),
    'payload-duplicate',
  );
});

test('unknown variants, invalid typed data, validation failures, and kind mismatches fail closed', () => {
  assertRejects(
    () => signedInspect('{"wire_version":1,"payload":{"Telemetry":{"batch_id":1}}}', 'Stimuli'),
    'unknown-variant',
  );
  for (const text of [
    STIMULI.replace('9007199254740993', '"9007199254740993"'),
    STIMULI.replace('9007199254740993', '-1'),
    STIMULI.replace('9007199254740993', '18446744073709551616'),
    SPIKES.replace('"channel":3', '"channel":70000'),
    '{"wire_version":1,"payload":7}',
  ]) {
    const variant = text.includes('Spikes') ? 'Spikes' : 'Stimuli';
    assertRejects(() => signedInspect(text, variant), 'invalid-typed-data');
  }
  for (const [text, variant] of [
    [STIMULI.replace('[true,false]', '[true]'), 'Stimuli'],
    [STIMULI.replace('[0.5,1.0]', '[0.5,1e39]'), 'Stimuli'],
    [
      TRACES.replace(
        '[{"channel_id":0,"trace_value":0.25,"last_spike_time":7}]',
        '[{"channel_id":0,"trace_value":0.25,"last_spike_time":7},{"channel_id":0,"trace_value":0.5,"last_spike_time":8}]',
      ),
      'EligibilityTraces',
    ],
  ]) {
    assertRejects(() => signedInspect(text, variant), 'validation-failed');
  }
  assertRejects(() => signedInspect(SPIKES, 'Stimuli'), 'kind-mismatch');
  assertRejects(() => signedInspect('{"wire_version":1,"payload":"Ping"}', 'Spikes'), 'kind-mismatch');
});

test('additive unknown fields keep corpus-ipc forward compatibility', () => {
  const additive = '{"wire_version":1,"producer":"future","payload":{"Stimuli":{"session_id":"s","batch_id":9007199254740993,"timestamp":0,"values":[0.5],"valid_mask":null,"metadata":null,"added_later":{"nested":[1,2]}}}}';
  const inspection = signedInspect(additive, 'Stimuli');
  assert.equal(inspection.batchId, 9007199254740993n);
  assert.equal(inspection.canonicalMatchesInput, false);
  assert.doesNotMatch(inspection.canonicalJson, /added_later|producer/);
});

test('the page check mutations fail closed through the adapter', async () => {
  const entry = manifest.fixtures.find((fixture) => fixture.variant === 'Stimuli');
  const original = fixtureBytes(entry);

  const flipped = enhance.mutateForCheck('flip-byte', original);
  assert.equal(flipped.length, original.length);
  assert.equal(flipped.filter((byte, index) => byte !== original[index]).length, 1);
  assertRejects(() => inspector.inspect(flipped, entry.sha256, entry.variant), 'digest-mismatch');

  const future = enhance.mutateForCheck('future-version', original);
  assert.match(new TextDecoder().decode(future), /^\{"wire_version":2,/);
  assertRejects(() => inspector.inspect(future, sha256(future), entry.variant), 'wire-version-too-new');
});

test('the bridge fails closed on adapter load failures and contract violations', async () => {
  await assert.rejects(
    bridge.createProtocolInspector(async () => {
      throw new Error('network down');
    }),
    (error) => error.code === 'wasm-unavailable',
  );
  await assert.rejects(
    bridge.createProtocolInspector(async () => ({ default: async () => {} })),
    (error) => error.code === 'wasm-unavailable',
  );

  const bytes = encode(STIMULI);
  const lossy = await bridge.createProtocolInspector(async () => ({
    default: async () => {},
    protocolFixtureByteLimit: () => 65536,
    inspectProtocolFixture: (input, digest, variant) => {
      const raw = wasm.inspectProtocolFixture(input, digest, variant);
      return new Proxy(raw, { get: (target, key) => (key === 'batch_id' ? Number(target.batch_id) : Reflect.get(target, key)) });
    },
  }));
  assertRejects(() => lossy.inspect(bytes, sha256(bytes), 'Stimuli'), 'adapter-contract');

  const opaque = await bridge.createProtocolInspector(async () => ({
    default: async () => {},
    protocolFixtureByteLimit: () => 65536,
    inspectProtocolFixture: () => {
      throw new Error('trap');
    },
  }));
  assertRejects(() => opaque.inspect(bytes, sha256(bytes), 'Stimuli'), 'adapter-error');
});

test('bounded reads never buffer more than the limit plus one byte', async () => {
  const chunks = [new Uint8Array(40).fill(1), new Uint8Array(40).fill(2), new Uint8Array(40).fill(3)];
  let pulled = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (pulled === chunks.length) controller.close();
      else controller.enqueue(chunks[pulled++]);
    },
  });
  const capped = await bridge.readBoundedBytes(new Response(stream), 50);
  assert.equal(capped.length, 51);
  assert.ok(pulled < chunks.length, 'the reader stops once the cap is reached');

  const small = await bridge.readBoundedBytes(new Response(encode(STIMULI)), 65536);
  assert.equal(new TextDecoder().decode(small), STIMULI);
  await assert.rejects(bridge.readBoundedBytes(new Response('missing', { status: 404 }), 10), (error) => error.code === 'fetch-failed');
});

test('display formatting keeps the shortest f32 decimal', () => {
  assert.equal(bridge.formatF32(Math.fround(0.22)), '0.22');
  assert.equal(bridge.formatF32(Math.fround(0.80000013)), '0.80000013');
  assert.equal(bridge.formatF32(1), '1');
  assert.equal(bridge.formatF32(0), '0');
});

test('TypeScript constants mirror the Rust adapter rather than redefine it', () => {
  assert.equal(wasm.protocolFixtureByteLimit(), provenance.PROTOCOL_FIXTURE_BYTE_LIMIT);
  assert.equal(inspector.byteLimit, provenance.PROTOCOL_FIXTURE_BYTE_LIMIT);

  const rust = readSource('../crates/neuromorphic-adapter/src/protocol.rs');
  const asStr = rust.slice(rust.indexOf('pub fn as_str(self)'), rust.indexOf('/// A fail-closed rejection'));
  const rustCodes = [...asStr.matchAll(/=> "([a-z-]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(Object.keys(provenance.PROTOCOL_ERROR_CODES).sort(), rustCodes);
  assert.match(rust, /pub const MAX_PROTOCOL_FIXTURE_BYTES: usize = 64 \* 1024;/);
  assert.match(rust, /WireEnvelope::<IpcMessage>::decode_json\(bytes\)/);
  assert.match(rust, /message\.validate\(\)/);
  assert.doesNotMatch(rust, /decode_ipc_message_json\(/, 'legacy-tolerant ingress is not used');

  assert.match(
    readSource('../src/runtime/wasm-session.ts'),
    new RegExp(`WASM_MODULE_URL = '${provenance.PROTOCOL_WASM_MODULE_URL.replaceAll('/', '\\/')}'`),
  );
});

test('recorded provenance matches the locked crate pin and lockfile', () => {
  const cargoToml = readSource('../crates/neuromorphic-adapter/Cargo.toml');
  const cargoLock = readSource('../crates/neuromorphic-adapter/Cargo.lock');
  assert.match(cargoToml, /^corpus-ipc = \{ version = "=0\.1\.0", default-features = false \}$/m);
  const lockEntry = cargoLock.match(/name = "corpus-ipc"\r?\nversion = "([^"]+)"\r?\nsource = "[^"]+"\r?\nchecksum = "([0-9a-f]{64})"/);
  assert.ok(lockEntry, 'corpus-ipc is locked from crates.io with a checksum');
  assert.equal(lockEntry[1], provenance.CORPUS_IPC_VERSION);
  assert.equal(lockEntry[2], provenance.CORPUS_IPC_ARCHIVE_SHA256);
  assert.equal(provenance.CORPUS_IPC_SOURCE_SHA, 'd99e6544d7925dc0ccfe69fdff372352b0a9d041');

  const doc = readSource('../docs/architecture/browser-runtime.md');
  for (const value of [provenance.CORPUS_IPC_SOURCE_SHA, provenance.CORPUS_IPC_ARCHIVE_SHA256]) {
    assert.ok(doc.includes(value), `browser-runtime.md records ${value}`);
  }

  for (const file of ['neuromorphic_adapter.js', 'neuromorphic_adapter.d.ts']) {
    assert.doesNotMatch(readFileSync(join(packageDir, file), 'utf8'), /zmq|zeromq|axum|tokio/i);
  }
});

test('the build-time catalog verifies exact bytes and fails closed on tampering', () => {
  const catalog = catalogModule.loadProtocolFixtureCatalog(fixtureDir);
  assert.equal(catalog.fixtures.length, 3);
  for (const fixture of catalog.fixtures) {
    assert.equal(fixture.url, `/protocol/fixtures/v1/${fixture.file}`);
    assert.equal(fixture.text, readFileSync(join(fixtureDir, fixture.file), 'utf8'));
    assert.match(fixture.derivation, /not captured from hardware or a live service/);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'protocol-catalog-'));
  try {
    cpSync(fixtureDir, scratch, { recursive: true });
    const victim = join(scratch, manifest.fixtures[1].file);
    writeFileSync(victim, readFileSync(victim, 'utf8').replace('"time":', '"time" :'));
    assert.throws(() => catalogModule.loadProtocolFixtureCatalog(scratch), /failed closed/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
