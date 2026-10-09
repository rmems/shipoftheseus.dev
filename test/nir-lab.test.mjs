import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { loadTsModule } from './load-ts-module.mjs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const ENVELOPE_PATH = 'public/nir/lif-readout-example.v1.json';
const PROJECTION_PATH = 'src/data/nir/lif-readout-example.v1.inspection.json';
const WASM_GLUE = new URL('public/wasm/neuromorphic-adapter/neuromorphic_adapter.js', root);
const WASM_BINARY = new URL('public/wasm/neuromorphic-adapter/neuromorphic_adapter_bg.wasm', root);

const envelope = read(ENVELOPE_PATH);
const projection = read(PROJECTION_PATH);

let wasmModule;
async function committedWasm() {
  if (!wasmModule) {
    wasmModule = await import(WASM_GLUE.href);
    await wasmModule.default({ module_or_path: readFileSync(WASM_BINARY) });
  }
  return wasmModule;
}

const inspection = await loadTsModule('../src/runtime/nir-inspection.ts');

test('the committed WASM package parses the committed envelope into the committed projection', async () => {
  const wasm = await committedWasm();
  const handle = wasm.WasmNirInspection.parse(envelope);
  try {
    assert.equal(handle.inspection_json(), projection);
    assert.equal(handle.nir_rs_version, '0.4.5');
    assert.equal(handle.node_count, 6);
    assert.equal(handle.edge_count, 5);
    const lif = JSON.parse(handle.node_json('lif1'));
    assert.equal(lif.operator, 'LIF');
    assert.deepEqual(lif.parameters.map((field) => field.name), ['tau', 'r', 'v_leak', 'v_threshold', 'v_reset']);
    assert.throws(() => handle.node_json('ghost'), /nir-node-not-found/);
  } finally {
    handle.free();
  }
});

test('the WASM parser fails closed with stable codes', async () => {
  const wasm = await committedWasm();
  const reject = (mutate, code) => {
    const candidate = JSON.parse(envelope);
    mutate(candidate);
    assert.throws(() => wasm.WasmNirInspection.parse(JSON.stringify(candidate)), new RegExp(`^${code}:`));
  };
  reject((value) => { value.nir_rs_version = '0.4.4'; }, 'nir-rs-version-mismatch');
  reject((value) => { value.format_version = 2; }, 'nir-envelope-unsupported-version');
  reject((value) => { value.graph.edges.push(['lif1', 'ghost']); }, 'nir-graph-invalid-structure');
  reject((value) => { value.graph.nodes.lif1.type = 'CurrLIF'; }, 'nir-envelope-invalid');
  assert.throws(() => wasm.WasmNirInspection.parse('not json'), /^nir-envelope-invalid:/);
});

test('the bundled example is versioned, labelled hand-authored, and free of trained-model claims', () => {
  const parsed = JSON.parse(envelope);
  assert.equal(parsed.format, 'shipoftheseus.nir-graph');
  assert.equal(parsed.format_version, 1);
  assert.equal(parsed.asset.revision, 1);
  assert.equal(parsed.asset.origin, 'hand-authored-example');
  assert.match(ENVELOPE_PATH, new RegExp(`${parsed.asset.id}\\.v${parsed.format_version}\\.json$`));
  assert.match(parsed.asset.summary, /nothing is trained or measured/);
  assert.match(parsed.asset.regenerate, /--test nir_example regenerate_nir_example -- --ignored --exact/);
  assert.ok(readFileSync(new URL(parsed.asset.generator, root)));
});

test('openNirInspection enables inspection only when the WASM parse matches the static projection', async () => {
  const wasm = await committedWasm();
  const options = {
    loadModule: async () => wasm,
    initModule: async () => undefined,
    loadEnvelope: async () => envelope,
    staticProjection: projection,
  };

  const session = await inspection.openNirInspection(options);
  assert.equal(session.nirRsVersion, '0.4.5');
  assert.equal(session.node('fc1').operator, 'Affine');
  assert.deepEqual(session.node('fc1').parameters[0].shape, [4, 3]);
  session.dispose();
  session.dispose();
  assert.throws(() => session.node('fc1'), /disposed/);

  await assert.rejects(
    inspection.openNirInspection({ ...options, staticProjection: projection.replace('"LIF"', '"IF"') }),
    { code: 'projection-mismatch' },
  );
  await assert.rejects(
    inspection.openNirInspection({ ...options, loadModule: async () => { throw new Error('404'); } }),
    { code: 'wasm-init-failed' },
  );
  await assert.rejects(
    inspection.openNirInspection({ ...options, loadEnvelope: async () => { throw new Error('offline'); } }),
    { code: 'asset-unavailable' },
  );
  await assert.rejects(
    inspection.openNirInspection({ ...options, loadEnvelope: async () => '{}' }),
    { code: 'nir-parse-failed' },
  );
});

test('the static diagram layout is a pure function of the Rust projection', () => {
  const parsed = JSON.parse(projection);
  const layout = inspection.layoutNirDiagram(parsed);
  assert.deepEqual(layout, inspection.layoutNirDiagram(JSON.parse(projection)));
  assert.equal(layout.nodes.length, 6);
  assert.equal(layout.edges.length, 5);
  assert.equal(layout.width, 260);
  assert.equal(layout.height, 20 * 2 + 5 * 96 + 56);
  assert.deepEqual(layout.nodes.map((node) => node.summary), [
    'Input · shape 3',
    'Affine · weight 4 × 3',
    'LIF · tau 4',
    'Linear · weight 2 × 4',
    'LI · tau 2',
    'Output · shape 2',
  ]);
  for (const edge of layout.edges) {
    assert.match(edge.path, /^M[\d.]+ [\d.]+C/);
  }

  const looped = JSON.parse(projection);
  looped.edges.push({ source: 'lif1', target: 'fc1' });
  const loopedLayout = inspection.layoutNirDiagram(looped);
  assert.equal(loopedLayout.width, layout.width + inspection.NIR_DIAGRAM.loopAllowance);
  assert.equal(loopedLayout.edges.length, 6);
});

test('field formatting shows Rust-formatted values verbatim and marks truncation', () => {
  assert.equal(inspection.formatNirShape([]), 'scalar');
  assert.equal(inspection.formatNirShape([4, 3]), '4 × 3');
  assert.equal(
    inspection.formatNirFieldValues({ kind: 'tensor', values: ['0.5', '-0.25'], value_count: 2 }),
    '0.5, -0.25',
  );
  assert.equal(
    inspection.formatNirFieldValues({ kind: 'tensor', values: ['1', '2'], value_count: 100 }),
    '1, 2, … (first 2 of 100)',
  );
  assert.equal(inspection.formatNirFieldValues({ kind: 'absent', values: [], value_count: 0 }), 'absent');
  assert.equal(inspection.nirNodeAnchorId('lif1'), 'nir-node-lif1');
  assert.equal(inspection.nirNodeAnchorId('a/b c'), 'nir-node-a-2f-b-20-c');
});

test('imported NIR structure has its own execution-origin label', async () => {
  const view = await loadTsModule('../src/native-evidence/view.ts');
  assert.equal(view.executionOriginLabel('imported-nir'), 'IMPORTED · NIR structure');
  assert.equal(view.executionOriginData('imported-nir'), 'imported');
  assert.notEqual(view.executionOriginLabel('imported-nir'), view.executionOriginLabel('live-wasm'));
});
