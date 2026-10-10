/* global ReadableStream, Response, TextDecoder -- Node 20+ web globals */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createFakeDocument, h } from './fake-dom.mjs';
import { loadTsModule, readSource } from './load-ts-module.mjs';

// Behavior tests for the /protocol/ enhancement (`enhanceProtocolViewer` and
// `renderInspection`) on a small fake DOM, driving the real labs WASM package.
// The skeleton below mirrors the data hooks of src/pages/protocol.astro and
// src/components/ProtocolFixtureCard.astro; the last test pins that contract.
const repository = fileURLToPath(new URL('..', import.meta.url));
const packageDir = join(repository, 'public/wasm/neuromorphic-adapter-labs');
const manifest = JSON.parse(readFileSync(join(repository, 'public/protocol/fixtures/v1/manifest.json'), 'utf8'));

globalThis.document = createFakeDocument();
const enhance = await loadTsModule('../src/protocol/enhance-protocol.ts');
const wasm = await import(pathToFileURL(join(packageDir, 'neuromorphic_adapter.js')).href);
const wasmBytes = readFileSync(join(packageDir, 'neuromorphic_adapter_bg.wasm'));
const loadWasmModule = async () => ({ ...wasm, default: () => wasm.default({ module_or_path: wasmBytes }) });

const STATIC_STATUS = 'Not decoded yet. The bytes above are the reference.';

function fixtureBytes(entry) {
  return new Uint8Array(readFileSync(join(repository, 'public/protocol/fixtures/v1', entry.file)));
}

/** The static markup the Astro page renders, reduced to the enhancement hooks. */
function staticPage() {
  const cards = manifest.fixtures.map((entry) =>
    h(
      'article',
      {
        'data-protocol-fixture': '',
        'data-protocol-status': 'static',
        'data-fixture-id': entry.id,
        'data-fixture-url': `/protocol/fixtures/v1/${entry.file}`,
        'data-fixture-sha256': entry.sha256,
        'data-fixture-variant': entry.variant,
      },
      h('pre', {}, h('code', { 'data-static-bytes': '' }, new TextDecoder().decode(fixtureBytes(entry)))),
      h('p', { 'data-protocol-fixture-status': '' }, STATIC_STATUS),
      h('div', { 'data-protocol-decoded': '' }),
    ),
  );
  return h(
    'div',
    { 'data-protocol-viewer': '', 'data-protocol-state': 'static' },
    h('p', { 'data-protocol-page-status': '' }, 'Static view.'),
    ...cards,
    h(
      'div',
      { 'data-protocol-checks': '', hidden: '' },
      h('button', { 'data-protocol-check': 'flip-byte' }, 'Change one byte'),
      h('button', { 'data-protocol-check': 'future-version' }, 'Set wire_version 2'),
      h('p', { 'data-protocol-check-result': '' }),
    ),
  );
}

function servedFixtures(transform = (_url, bytes) => bytes) {
  const requested = [];
  const fetchFixture = async (url) => {
    requested.push(url);
    const entry = manifest.fixtures.find((fixture) => url.endsWith(fixture.file));
    return new Response(transform(url, fixtureBytes(entry)));
  };
  return { fetchFixture, requested };
}

function card(root, variant) {
  return root.querySelector(`[data-fixture-variant="${variant}"]`);
}

test('a successful enhancement renders every fixture through the adapter', async () => {
  const root = staticPage();
  const { fetchFixture, requested } = servedFixtures();
  await enhance.enhanceProtocolViewer(root, { loadWasmModule, fetchFixture });

  assert.equal(root.dataset.protocolState, 'verified');
  assert.equal(root.querySelector('[data-protocol-page-status]').textContent, '3 of 3 recorded envelopes verified and decoded in this browser.');
  assert.equal(requested.length, 3);
  for (const entry of manifest.fixtures) {
    const fixture = card(root, entry.variant);
    assert.equal(fixture.dataset.protocolStatus, 'verified', entry.id);
    assert.match(fixture.querySelector('[data-protocol-fixture-status]').textContent, /^Verified, decoded, and validated/);
    const decoded = fixture.querySelector('[data-protocol-decoded]');
    assert.equal(decoded.querySelector('[data-protocol-batch-id]').querySelector('[data-protocol-bigint]').textContent, '9007199254740993');
    assert.match(decoded.querySelector('[data-protocol-batch-id]').textContent, /A JavaScript Number would read 9007199254740992\./);
    assert.match(decoded.querySelector('[data-protocol-wire-version]').textContent, /^1 accepted \(corpus-ipc window 1–1\)$/);
    assert.equal(decoded.querySelector('[data-protocol-canonical]').textContent, 'corpus-ipc re-encodes it byte-for-byte (lossless)');
    assert.equal(fixture.querySelector('[data-static-bytes]').textContent, new TextDecoder().decode(fixtureBytes(entry)));
  }

  const stimuli = card(root, 'Stimuli').querySelector('[data-protocol-decoded]');
  const rows = stimuli.children.find((child) => child.className === 'protocol-table-wrap').children[0].children[2].children;
  assert.equal(rows.length, 16);
  assert.deepEqual(rows[1].children.map((cell) => cell.textContent), ['1', '0.22', 'yes']);
  assert.equal(root.querySelector('[data-protocol-checks]').hidden, false);

  // Enhancement is one-shot: a second call leaves the verified view alone.
  await enhance.enhanceProtocolViewer(root, { loadWasmModule, fetchFixture });
  assert.equal(requested.length, 3);
});

test('one rejected fixture fails closed while the others still verify', async () => {
  const root = staticPage();
  const { fetchFixture } = servedFixtures((url, bytes) => {
    if (!url.includes('spikes')) return bytes;
    const tampered = new Uint8Array(bytes);
    tampered[tampered.length - 3] ^= 1;
    return tampered;
  });
  await enhance.enhanceProtocolViewer(root, { loadWasmModule, fetchFixture });

  assert.equal(root.dataset.protocolState, 'partial');
  assert.equal(root.querySelector('[data-protocol-page-status]').textContent, '2 of 3 recorded envelopes verified and decoded in this browser.');
  const spikes = card(root, 'Spikes');
  assert.equal(spikes.dataset.protocolStatus, 'rejected');
  assert.equal(spikes.dataset.protocolCode, 'digest-mismatch');
  assert.match(spikes.querySelector('[data-protocol-fixture-status]').textContent, /^Rejected · digest-mismatch\. fixture SHA-256 is [0-9a-f]{64}, expected /);
  assert.equal(spikes.querySelector('[data-protocol-decoded]').childNodes.length, 0, 'no decoded view for rejected bytes');
  assert.equal(card(root, 'Stimuli').dataset.protocolStatus, 'verified');
  assert.equal(card(root, 'EligibilityTraces').dataset.protocolStatus, 'verified');
});

test('a WASM load failure keeps the static content and touches nothing else', async () => {
  const root = staticPage();
  const { fetchFixture, requested } = servedFixtures();
  await enhance.enhanceProtocolViewer(root, {
    loadWasmModule: async () => {
      throw new Error('fetch for neuromorphic_adapter_bg.wasm failed');
    },
    fetchFixture,
  });

  assert.equal(root.dataset.protocolState, 'unavailable');
  assert.equal(
    root.querySelector('[data-protocol-page-status]').textContent,
    'Rust/WASM unavailable (wasm-unavailable). The recorded bytes and digests above remain the reference.',
  );
  assert.equal(requested.length, 0, 'no fixture is fetched without the adapter');
  for (const entry of manifest.fixtures) {
    const fixture = card(root, entry.variant);
    assert.equal(fixture.dataset.protocolStatus, 'static');
    assert.equal(fixture.querySelector('[data-protocol-fixture-status]').textContent, STATIC_STATUS);
    assert.equal(fixture.querySelector('[data-protocol-decoded]').childNodes.length, 0);
    assert.equal(fixture.querySelector('[data-static-bytes]').textContent, new TextDecoder().decode(fixtureBytes(entry)));
  }
  assert.equal(root.querySelector('[data-protocol-checks]').hidden, true);
});

test('both tamper buttons replay a modified copy through the adapter and fail closed', async () => {
  const root = staticPage();
  await enhance.enhanceProtocolViewer(root, { loadWasmModule, fetchFixture: servedFixtures().fetchFixture });
  const output = root.querySelector('[data-protocol-check-result]');

  await root.querySelector('[data-protocol-check="flip-byte"]').dispatch('click');
  assert.equal(output.dataset.protocolCheckCode, 'digest-mismatch');
  assert.match(output.textContent, /^kinetic-seed9-step7-stimuli: rejected · digest-mismatch\./);

  await root.querySelector('[data-protocol-check="future-version"]').dispatch('click');
  assert.equal(output.dataset.protocolCheckCode, 'wire-version-too-new');
  assert.match(output.textContent, /wire version 2 is too new \(current is 1\)/);

  // The published fixtures are untouched by the demonstrations.
  assert.equal(card(root, 'Stimuli').dataset.protocolStatus, 'verified');
});

test('transport failures are fetch-failed, never adapter-error', async () => {
  const root = staticPage();
  const served = servedFixtures();
  const fetchFixture = async (url) => {
    if (url.includes('stimuli')) throw new TypeError('Failed to fetch');
    if (url.includes('spikes')) {
      // The body stream errors partway through the read.
      let sent = false;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (sent) {
              controller.error(new TypeError('network error'));
              return;
            }
            sent = true;
            controller.enqueue(new Uint8Array([0x7b]));
          },
        }),
      );
    }
    if (url.includes('eligibility')) return new Response('missing', { status: 404 });
    return served.fetchFixture(url);
  };
  await enhance.enhanceProtocolViewer(root, { loadWasmModule, fetchFixture });

  assert.equal(root.dataset.protocolState, 'partial');
  assert.equal(root.querySelector('[data-protocol-page-status]').textContent, '0 of 3 recorded envelopes verified and decoded in this browser.');
  const expectations = [
    ['Stimuli', 'Rejected · fetch-failed. Fixture request failed: Failed to fetch'],
    ['Spikes', 'Rejected · fetch-failed. Fixture request failed: network error'],
    ['EligibilityTraces', 'Rejected · fetch-failed. Fixture request failed with HTTP 404.'],
  ];
  for (const [variant, status] of expectations) {
    const fixture = card(root, variant);
    assert.equal(fixture.dataset.protocolStatus, 'rejected', variant);
    assert.equal(fixture.dataset.protocolCode, 'fetch-failed', variant);
    assert.equal(fixture.querySelector('[data-protocol-fixture-status]').textContent, status);
    assert.equal(fixture.querySelector('[data-protocol-decoded]').childNodes.length, 0);
  }
});

test('adapter-side failures stay adapter-error', async () => {
  const root = staticPage();
  const trapping = async () => ({
    ...(await loadWasmModule()),
    inspectProtocolFixture: () => {
      throw new Error('RuntimeError: unreachable');
    },
  });
  await enhance.enhanceProtocolViewer(root, { loadWasmModule: trapping, fetchFixture: servedFixtures().fetchFixture });

  for (const entry of manifest.fixtures) {
    const fixture = card(root, entry.variant);
    assert.equal(fixture.dataset.protocolCode, 'adapter-error', entry.variant);
    assert.equal(fixture.querySelector('[data-protocol-fixture-status]').textContent, 'Rejected · adapter-error. RuntimeError: unreachable');
  }
});

test('renderInspection reports dropped fields only when the adapter found them', async () => {
  const container = h('div', { 'data-protocol-decoded': '' });
  enhance.renderInspection(container, {
    variant: 'EligibilityTraces',
    wireVersion: 1,
    wireWindow: { minSupported: 1, current: 1 },
    sha256: '0'.repeat(64),
    byteLength: 10,
    sessionId: 's',
    batchId: 18446744073709551615n,
    timestamp: null,
    stimuli: null,
    spikes: null,
    traces: { channelIds: new Uint16Array([0]), values: new Float32Array([-0]), lastSpikeTimes: new Uint32Array([7]) },
    metadata: null,
    canonicalJson: '{}',
    canonicalMatchesInput: false,
    canonicalDifference: 'dropped-fields',
    droppedFields: ['producer'],
  });
  assert.equal(container.querySelector('[data-protocol-bigint]').textContent, '18446744073709551615');
  assert.equal(container.querySelector('[data-protocol-canonical]').textContent, 'accepted; corpus-ipc’s re-encoding omits fields it does not define: producer');
  const row = container.children.find((child) => child.className === 'protocol-table-wrap').children[0].children[2].children[0];
  assert.deepEqual(row.children.map((cell) => cell.textContent), ['0', '-0', '7']);
});

test('the fake page uses the same data hooks as the Astro markup', () => {
  const page = readSource('../src/pages/protocol.astro');
  const fixtureCard = readSource('../src/components/ProtocolFixtureCard.astro');
  for (const hook of ['data-protocol-viewer', 'data-protocol-state="static"', 'data-protocol-page-status', 'data-protocol-checks hidden', 'data-protocol-check="flip-byte"', 'data-protocol-check="future-version"', 'data-protocol-check-result']) {
    assert.ok(page.includes(hook), `protocol.astro renders ${hook}`);
  }
  for (const hook of ['data-protocol-fixture', 'data-protocol-status="static"', 'data-fixture-id=', 'data-fixture-url=', 'data-fixture-sha256=', 'data-fixture-variant=', 'data-protocol-fixture-status', 'data-protocol-decoded']) {
    assert.ok(fixtureCard.includes(hook), `ProtocolFixtureCard.astro renders ${hook}`);
  }
});
