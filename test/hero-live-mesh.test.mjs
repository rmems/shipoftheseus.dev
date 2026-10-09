// The homepage hero (GitHub #13 / Linear RM-1649): its static drawing is the
// live network, and its crate trail matches the adapter's pinned crates.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import * as THREE from 'three';

import { loadTsModule, readSource } from './load-ts-module.mjs';

const layout = await loadTsModule('../src/runtime/topology-layout.ts');
const renderer = await loadTsModule('../src/runtime/topology-renderer.ts');
const adapterModule = await loadTsModule('../src/runtime/neuromorphic-adapter.ts');
const stimulus = await loadTsModule('../src/runtime/demo-stimulus.ts');
const wasmSession = await loadTsModule('../src/runtime/wasm-session.ts');
const runtimeData = await loadTsModule('../src/data/live-runtime.ts');

const wasmUrl = new URL('../public/wasm/neuromorphic-adapter/neuromorphic_adapter.js', import.meta.url);
const wasmBytes = readFileSync(new URL('../public/wasm/neuromorphic-adapter/neuromorphic_adapter_bg.wasm', import.meta.url));

async function liveAdapter() {
  // The committed homepage package through the shipped bridge and live options.
  return adapterModule.initNeuromorphicAdapter(
    async () => {
      const generated = await import(wasmUrl.href);
      return {
        default: () => generated.default({ module_or_path: wasmBytes }),
        WasmAdapter: generated.WasmAdapter,
      };
    },
    stimulus.DEMO_SEED,
    wasmSession.LIVE_ADAPTER_OPTIONS,
  );
}

test('the audited topology is exactly what the committed homepage package exports', async () => {
  const audited = adapterModule.auditedBrowserTopology();
  const adapter = await liveAdapter();
  try {
    adapter.input(1n, stimulus.scriptedTelemetry(1n));
    const state = adapter.step();
    assert.equal(state.topologyDigest, audited.digest);
    assert.deepEqual([...state.topologyNodeIds], [...audited.nodeIds]);
    assert.deepEqual([...state.topologyEdgeSources], [...audited.edgeSources]);
    assert.deepEqual([...state.topologyEdgeTargets], [...audited.edgeTargets]);
    assert.deepEqual([...state.topologyEdgeDelays], [...audited.edgeDelays]);
    assert.deepEqual([...state.topologyPolarities], [...audited.polarities]);
    assert.deepEqual([...state.topologyWeightBits], [...audited.weightBits]);
    assert.deepEqual(
      [...new Uint32Array(state.topologyEdgeWeights.slice().buffer)],
      [...audited.weightBits],
      'weights are the exact f32 values, not rounded copies',
    );
  } finally {
    adapter.dispose();
  }
});

test('the audited topology is returned as fresh copies', () => {
  const first = adapterModule.auditedBrowserTopology();
  first.edgeTargets[0] = 99;
  first.weightBits[0] = 0;
  first.edgeWeights[1] = 42;
  const second = adapterModule.auditedBrowserTopology();
  assert.notEqual(second.edgeTargets[0], 99);
  assert.notEqual(second.weightBits[0], 0);
  assert.notEqual(second.edgeWeights[1], 42);
  assert.equal(second.nodeIds.length, 16);
  assert.equal(second.edgeSources.length, 64);
});

test('the static drawing uses the renderer layout and camera framing', () => {
  assert.equal(renderer.layoutTopology, layout.layoutTopology, 'one layout implementation');
  const topology = adapterModule.auditedBrowserTopology();
  const mesh = layout.staticMeshGeometry(topology);
  const positions = layout.layoutTopology(16);

  assert.equal(mesh.viewBox, '-1.35 -1.35 2.7 2.7');
  assert.equal(mesh.nodeSizePx, 16);
  assert.equal(mesh.edgeOpacity, 0.55);
  assert.equal(mesh.nodes.length, 16);
  assert.equal(mesh.edges.length, 64);
  mesh.nodes.forEach((node, index) => {
    assert.equal(node.id, index);
    assert.ok(Math.abs(node.x - positions[index].x) < 1e-4);
    assert.ok(Math.abs(node.y + positions[index].y) < 1e-4, 'SVG y points down, world y points up');
  });
  mesh.edges.forEach((edge, index) => {
    const source = positions[topology.edgeSources[index]];
    const target = positions[topology.edgeTargets[index]];
    assert.ok(Math.abs(edge.x1 - source.x) < 1e-4 && Math.abs(edge.y1 + source.y) < 1e-4);
    assert.ok(Math.abs(edge.x2 - target.x) < 1e-4 && Math.abs(edge.y2 + target.y) < 1e-4);
    // Every node sits inside the frame, so nothing is clipped at any aspect.
    for (const value of [edge.x1, edge.y1, edge.x2, edge.y2]) {
      assert.ok(Math.abs(value) < layout.CAMERA_EXTENT);
    }
  });
});

test('static edge colours match three.js colour mixing in the live renderer', () => {
  const topology = adapterModule.auditedBrowserTopology();
  const mesh = layout.staticMeshGeometry(topology);
  const palette = layout.SITE_TOPOLOGY_PALETTE;
  const signal = new THREE.Color(palette.signal);
  const muted = new THREE.Color(palette.muted);
  const ink = new THREE.Color(palette.ink);
  const inhibitory = muted.clone().lerp(ink, layout.INHIBITORY_INK_MIX);
  const extent = layout.edgeWeightExtent(topology.edgeWeights);

  mesh.edges.forEach((edge, index) => {
    const base = topology.polarities[index] === 0 ? signal : inhibitory;
    const strength = layout.edgeStrength(topology.edgeWeights[index], extent);
    const expected = `#${base.clone().lerp(muted, 1 - strength).getHexString()}`;
    assert.equal(edge.stroke, expected, `edge ${index}`);
  });
  assert.equal(mesh.nodeFill, `#${muted.getHexString()}`);
  assert.ok(mesh.edges.some((edge) => edge.stroke === palette.signal), 'the strongest excitatory edge is full --signal');
});

test('static drawing helpers reject inconsistent topologies and bad colours', () => {
  const topology = adapterModule.auditedBrowserTopology();
  assert.throws(
    () => layout.staticMeshGeometry({ ...topology, edgeTargets: topology.edgeTargets.slice(1) }),
    RangeError,
  );
  assert.throws(
    () => layout.staticMeshGeometry({ ...topology, edgeTargets: topology.edgeTargets.map(() => 99) }),
    /outside the topology/,
  );
  assert.throws(() => layout.staticMeshGeometry(topology, { ...layout.SITE_TOPOLOGY_PALETTE, ink: 'black' }), RangeError);
  assert.equal(layout.edgeWeightExtent([]), 1);
  assert.equal(layout.edgeWeightExtent([0, -0.5, 0.25]), 0.5);
  assert.equal(layout.edgeStrength(0, 1), 0.35);
  assert.equal(layout.edgeStrength(-2, 1), 1);
});

test('the build-time palette matches the stylesheet tokens', () => {
  const styles = readSource('../src/styles/global.css');
  for (const [name, value] of Object.entries(layout.SITE_TOPOLOGY_PALETTE)) {
    assert.match(styles, new RegExp(`--${name}:\\s*${value};`), `--${name}`);
  }
});

test('the crate trail pins every layer exactly as the adapter manifest and lockfile do', () => {
  const manifest = readSource('../crates/neuromorphic-adapter/Cargo.toml');
  const lockfile = readSource('../crates/neuromorphic-adapter/Cargo.lock');
  const names = runtimeData.liveCrateLayers.map((layer) => layer.name);
  assert.deepEqual(names, ['kinetic-signals', 'axon-encoder', 'neuromod', 'synaptic-wiring'], 'pipeline order');

  for (const layer of runtimeData.liveCrateLayers) {
    // `name = { … }`, or the short form `name = "=x.y.z"`.
    const dependency = manifest.match(new RegExp(`^${layer.name} = (\\{[^}]*\\}|"[^"]*")$`, 'm'));
    assert.ok(dependency, `${layer.name} is a direct dependency`);
    const locked = lockfile.match(new RegExp(`\\[\\[package\\]\\]\\r?\\nname = "${layer.name}"\\r?\\nversion = "([^"]+)"\\r?\\nsource = "([^"]+)"`));
    assert.ok(locked, `${layer.name} is in Cargo.lock`);
    assert.equal(layer.version, locked[1], `${layer.name} version`);

    if (layer.source.kind === 'git') {
      assert.match(dependency[1], new RegExp(`git = "${layer.source.repository}\\.git", rev = "${layer.source.revision}"`));
      assert.equal(locked[2], `git+${layer.source.repository}.git?rev=${layer.source.revision}#${layer.source.revision}`);
      assert.equal(runtimeData.crateLayerHref(layer), `${layer.source.repository}/tree/${layer.source.revision}`);
      assert.equal(runtimeData.crateLayerPin(layer), `${layer.version} @ ${layer.source.revision.slice(0, 7)}`);
    } else {
      const exact = `"=${layer.version}"`;
      assert.ok(
        dependency[1] === exact || dependency[1].includes(`version = ${exact}`),
        `${layer.name} is pinned to =${layer.version}`,
      );
      assert.equal(locked[2], 'registry+https://github.com/rust-lang/crates.io-index');
      assert.equal(runtimeData.crateLayerHref(layer), `https://crates.io/crates/${layer.name}/${layer.version}`);
      assert.equal(runtimeData.crateLayerPin(layer), layer.version);
    }
  }
  assert.equal(
    runtimeData.ADAPTER_SOURCE_URL,
    'https://github.com/rmems/shipoftheseus.dev/tree/main/crates/neuromorphic-adapter',
  );
});
