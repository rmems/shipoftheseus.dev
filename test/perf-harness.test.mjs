import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { loadTsModule, readSource } from './load-ts-module.mjs';

// Smoke coverage for the committed measurement harness (scripts/perf/). The
// harness itself is machine-dependent and never runs in `npm test`; this only
// keeps its pure parts and its wiring to the shipped runtime from rotting.
// Timing values are not asserted.
const { pointerActivePacket, runBoundaryBench } = await import('../scripts/perf/boundary-bench.mjs');
const adapterModule = await loadTsModule('../src/runtime/neuromorphic-adapter.ts');
const spikes = await loadTsModule('../src/runtime/spike-events.ts');
const stimulus = await loadTsModule('../src/runtime/demo-stimulus.ts');

test('the synthetic active-pointer workload is deterministic and stays on the island', () => {
  const pressures = new Set();
  let previous = null;
  let moving = 0;
  for (let sequence = 1n; sequence <= 400n; sequence += 1n) {
    const packet = pointerActivePacket(sequence);
    assert.deepEqual(packet, pointerActivePacket(sequence));
    assert.equal(packet.length, 3);
    const [x, y, pressure] = packet;
    assert.ok(x > -0.05 && x < 1.05 && y > -0.05 && y < 1.05, `packet ${sequence} leaves the island`);
    pressures.add(pressure > 0);
    if (previous && Math.hypot(x - previous[0], y - previous[1]) > 0.05) moving += 1;
    previous = packet;
  }
  assert.deepEqual([...pressures].sort(), [false, true], 'the drag presses and releases');
  assert.ok(moving > 300, 'the workload is a fast drag, not a held pointer');
});

test('the boundary benchmark runs against the committed WASM package and shipped bridge', async () => {
  const generated = await import(new URL('../public/wasm/neuromorphic-adapter/neuromorphic_adapter.js', import.meta.url).href);
  const exports = await generated.default({
    module_or_path: readFileSync(new URL('../public/wasm/neuromorphic-adapter/neuromorphic_adapter_bg.wasm', import.meta.url)),
  });
  const report = await runBoundaryBench(
    {
      WasmAdapter: generated.WasmAdapter,
      wasmMemory: exports.memory,
      initBridge: (options) =>
        adapterModule.initNeuromorphicAdapter(
          async () => ({ default: async () => {}, WasmAdapter: generated.WasmAdapter }),
          stimulus.DEMO_SEED,
          options,
        ),
      createSpikeEventBuffer: spikes.createSpikeEventBuffer,
      scriptedTelemetry: stimulus.scriptedTelemetry,
      DEMO_SEED: stimulus.DEMO_SEED,
    },
    { ticks: 20, repeats: 1, modes: ['temporal'] },
  );
  assert.deepEqual(report.results.map((row) => `${row.source}/${row.mode}`), ['scripted/temporal', 'pointer-active/temporal']);
  for (const row of report.results) {
    for (const key of ['rawInput', 'rawTick', 'rawState', 'getters', 'bridgeState', 'bridgeTick', 'spikeIngest']) {
      assert.ok(Number.isFinite(row[key].medianUs), `${key} is reported`);
    }
    assert.ok(row.snapshotBytes > 2000, 'the contract-5 snapshot carries the full topology projection');
  }
  assert.equal(
    report.memory.withFree.linearMemoryAfterBytes,
    report.memory.withFree.linearMemoryBeforeBytes,
    'freeing each state keeps WASM linear memory flat',
  );
});

test('the browser harness only runs fixture topologies through the renderer, never the live path', () => {
  const tasks = readSource('../scripts/perf/page-tasks.mjs');
  assert.match(tasks, /createSpikeEventBuffer\(\{ provenance: 'fixture'/);
  assert.doesNotMatch(tasks, /provenance: 'live-wasm'/);
  const harness = readSource('../scripts/perf/measure-browser.mjs');
  assert.match(harness, /neuromorphic-perf/);
  assert.match(readSource('../src/runtime/perf-probe.ts'), /PERF_PROBE_QUERY = 'neuromorphic-perf'/);
});
