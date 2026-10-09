import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { loadTsModule, readSource } from './load-ts-module.mjs';

const spikes = await loadTsModule('../src/runtime/spike-events.ts');
const adapterModule = await loadTsModule('../src/runtime/neuromorphic-adapter.ts');
const channelModule = await loadTsModule('../src/runtime/simulation-channel.ts');
const stimulus = await loadTsModule('../src/runtime/demo-stimulus.ts');
const wasmSession = await loadTsModule('../src/runtime/wasm-session.ts');
const liveSeams = await loadTsModule('../src/runtime/live-seams.ts');
const rendererModule = await loadTsModule('../src/runtime/topology-renderer.ts');

// ---------------------------------------------------------------------------
// Explicit test fixtures. These are hand-built topologies and spike lists for
// isolated buffer/mapping tests only, always tagged `fixture`. The live path
// is exercised separately below against the committed Rust/WASM package.
// ---------------------------------------------------------------------------

/**
 * Four neurons, CSR-ordered like the adapter's canonical projection:
 *   0 → 1 (delay 2, excitatory), 0 → 2 (delay 0, excitatory)
 *   1 → (none)
 *   2 → 3 (delay 1, inhibitory) twice: parallel synapses with distinct weights
 *   3 → 0 (delay 3, excitatory)
 */
function fixtureTopology(overrides = {}) {
  return {
    completedStep: 10n,
    spikeNeurons: new Uint32Array(0),
    topologyDigest: 'fixture-topology-a',
    topologyNodeIds: new Uint32Array([0, 1, 2, 3]),
    topologyEdgeSources: new Uint32Array([0, 0, 2, 2, 3]),
    topologyEdgeTargets: new Uint32Array([1, 2, 3, 3, 0]),
    topologyEdgeWeights: new Float32Array([0.5, 0.25, -0.75, -0.125, 0.375]),
    topologyEdgeDelays: new Uint16Array([2, 0, 1, 1, 3]),
    topologyPolarities: new Uint8Array([0, 0, 1, 1, 0]),
    topologyOutgoingEdgeOffsets: new Uint32Array([0, 2, 2, 4, 5]),
    ...overrides,
  };
}

/** A dense fixture: `nodes` neurons, each with `fanOut` edges and delays 1..maxDelay. */
function denseFixture(nodes, fanOut, maxDelay, digest = 'fixture-dense') {
  const sources = [];
  const targets = [];
  const delays = [];
  const offsets = [0];
  for (let source = 0; source < nodes; source += 1) {
    for (let k = 0; k < fanOut; k += 1) {
      sources.push(source);
      targets.push((source + k + 1) % nodes);
      delays.push(1 + ((source + k) % maxDelay));
    }
    offsets.push(sources.length);
  }
  return {
    topologyDigest: digest,
    topologyNodeIds: new Uint32Array([...Array(nodes).keys()]),
    topologyEdgeSources: new Uint32Array(sources),
    topologyEdgeTargets: new Uint32Array(targets),
    topologyEdgeWeights: new Float32Array(sources.length).fill(0.5),
    topologyEdgeDelays: new Uint16Array(delays),
    topologyPolarities: new Uint8Array(sources.length),
    topologyOutgoingEdgeOffsets: new Uint32Array(offsets),
  };
}

function fixtureStep(topology, step, neurons) {
  return { ...topology, completedStep: BigInt(step), spikeNeurons: new Uint32Array(neurons) };
}

function fixtureBuffer(options = {}) {
  return spikes.createSpikeEventBuffer({ provenance: 'fixture', ...options });
}

const eventKey = (event) => `${event.emittedStep}:${event.edgeIndex}`;

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

test('a spike maps onto exactly its outgoing synaptic-wiring edges with delay timing', () => {
  const events = spikes.mapSpikesThroughTopology(
    fixtureTopology({ spikeNeurons: new Uint32Array([2, 0, 1]) }),
    'fixture',
  );

  assert.deepEqual(
    events.map((event) => ({ ...event })),
    [
      // Spike order is preserved; each neuron's edges follow canonical order.
      { provenance: 'fixture', topologyDigest: 'fixture-topology-a', emittedStep: 10n, arrivalStep: 11n, sourceNeuron: 2, targetNeuron: 3, edgeIndex: 2, delaySteps: 1, polarity: 1, weight: -0.75 },
      { provenance: 'fixture', topologyDigest: 'fixture-topology-a', emittedStep: 10n, arrivalStep: 11n, sourceNeuron: 2, targetNeuron: 3, edgeIndex: 3, delaySteps: 1, polarity: 1, weight: -0.125 },
      { provenance: 'fixture', topologyDigest: 'fixture-topology-a', emittedStep: 10n, arrivalStep: 12n, sourceNeuron: 0, targetNeuron: 1, edgeIndex: 0, delaySteps: 2, polarity: 0, weight: 0.5 },
      { provenance: 'fixture', topologyDigest: 'fixture-topology-a', emittedStep: 10n, arrivalStep: 10n, sourceNeuron: 0, targetNeuron: 2, edgeIndex: 1, delaySteps: 0, polarity: 0, weight: 0.25 },
    ],
    'neuron 1 has no outgoing synapses and so emits no propagation event',
  );
  assert.ok(events.every(Object.isFrozen), 'events are immutable once mapped');
});

test('mapping fails closed on projections it cannot trust', () => {
  const map = (overrides) => () => spikes.mapSpikesThroughTopology(fixtureTopology(overrides), 'fixture');
  assert.throws(map({ spikeNeurons: new Uint32Array([4]) }), RangeError, 'spike outside the node domain');
  assert.throws(map({ spikeNeurons: new Uint32Array([2, 2]) }), RangeError, 'duplicate spike in one step');
  assert.throws(map({ topologyOutgoingEdgeOffsets: new Uint32Array([0, 2, 2, 5]) }), RangeError, 'offsets length');
  assert.throws(map({ topologyOutgoingEdgeOffsets: new Uint32Array([0, 2, 2, 4, 4]) }), RangeError, 'offsets end');
  assert.throws(
    map({ spikeNeurons: new Uint32Array([0]), topologyEdgeSources: new Uint32Array([0, 1, 2, 2, 3]) }),
    RangeError,
    'an edge in the range must leave the spiking neuron',
  );
  assert.throws(
    map({ spikeNeurons: new Uint32Array([3]), topologyEdgeTargets: new Uint32Array([1, 2, 3, 3, 9]) }),
    RangeError,
    'targets must stay inside the topology',
  );
  assert.throws(map({ topologyEdgeDelays: new Uint16Array(4) }), RangeError, 'edge arrays must agree');
  assert.throws(map({ completedStep: 3 }), RangeError, 'steps are u64 bigints');
});

// ---------------------------------------------------------------------------
// The live path: real neuromod spikes through the real synaptic-wiring topology
// ---------------------------------------------------------------------------

const wasmUrl = new URL('../public/wasm/neuromorphic-adapter/neuromorphic_adapter.js', import.meta.url);
const wasmBytes = readFileSync(new URL('../public/wasm/neuromorphic-adapter/neuromorphic_adapter_bg.wasm', import.meta.url));

async function liveAdapter() {
  // The committed `web` package, initialized from bytes because Node cannot
  // fetch file URLs. Everything else is the shipped bridge and live options.
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

// Audited canonical projection of the browser topology (see
// `src/runtime/neuromorphic-adapter.ts`): four outgoing edges per neuron.
const AUDITED_TARGETS = [
  1, 2, 12, 14, 3, 8, 12, 15, 0, 1, 3, 4, 2, 4, 5, 8,
  2, 3, 7, 14, 3, 4, 6, 7, 0, 5, 7, 8, 5, 6, 11, 15,
  6, 7, 9, 10, 8, 10, 11, 14, 4, 8, 9, 13, 9, 12, 13, 15,
  10, 11, 13, 14, 11, 12, 14, 15, 0, 9, 12, 15, 0, 5, 13, 14,
];
const AUDITED_DELAYS = [
  3, 1, 1, 4, 1, 4, 1, 1, 1, 2, 1, 2, 3, 1, 3, 3,
  2, 4, 1, 2, 3, 1, 3, 1, 3, 1, 4, 1, 1, 2, 1, 2,
  2, 3, 2, 3, 4, 2, 4, 4, 2, 3, 1, 2, 1, 1, 1, 4,
  1, 2, 1, 2, 2, 3, 2, 3, 3, 3, 3, 2, 2, 1, 3, 1,
];

test('live neuromod spikes become live-wasm propagation events on the real topology', async () => {
  const adapter = await liveAdapter();
  const channel = channelModule.createSimulationChannel();
  const buffer = spikes.createSpikeEventBuffer({ provenance: spikes.LIVE_SPIKE_EVENT_PROVENANCE });
  const errors = [];
  const feed = spikes.feedSpikeEvents(channel, buffer, (error) => errors.push(error));
  feed.setActive(true);
  const batches = [];
  buffer.subscribe((batch) => batches.push(batch));

  let spikeTotal = 0;
  try {
    // The live session's own input path: one scripted packet per tick.
    for (let sequence = 1n; sequence <= 160n; sequence += 1n) {
      adapter.input(sequence, stimulus.scriptedTelemetry(sequence));
      const state = adapter.step();
      spikeTotal += state.spikeNeurons.length;
      channel.publish(state);

      const batch = batches.at(-1);
      assert.equal(batch.step, state.completedStep);
      assert.deepEqual(batch.spikeNeurons, Array.from(state.spikeNeurons));
      const expected = [];
      for (const neuron of state.spikeNeurons) {
        const start = state.topologyOutgoingEdgeOffsets[neuron];
        const end = state.topologyOutgoingEdgeOffsets[neuron + 1];
        for (let edge = start; edge < end; edge += 1) {
          expected.push({
            edgeIndex: edge,
            sourceNeuron: neuron,
            targetNeuron: AUDITED_TARGETS[edge],
            delaySteps: AUDITED_DELAYS[edge],
            arrivalStep: state.completedStep + BigInt(AUDITED_DELAYS[edge]),
          });
        }
      }
      assert.deepEqual(
        batch.events.map(({ edgeIndex, sourceNeuron, targetNeuron, delaySteps, arrivalStep }) => ({
          edgeIndex, sourceNeuron, targetNeuron, delaySteps, arrivalStep,
        })),
        expected,
        `step ${state.completedStep} maps every spike through its synaptic-wiring edges`,
      );
      assert.ok(batch.events.every((event) => event.provenance === 'live-wasm'));
      assert.ok(batch.events.every((event) => event.topologyDigest === state.topologyDigest));
      assert.ok(buffer.size() <= buffer.capacity);
    }
  } finally {
    feed.detach();
    adapter.dispose();
  }

  assert.deepEqual(errors, []);
  assert.ok(spikeTotal > 0, 'the scripted path drives real neuromod spikes within 160 ticks');
  const stats = buffer.stats();
  assert.equal(stats.emitted, spikeTotal * 4, 'every live spike leaves along its four synapses');
  assert.equal(stats.evicted, 0, 'the default capacity holds the live topology without eviction');
  assert.equal(buffer.size(), 0, 'detaching the feed clears the buffer');
});

// ---------------------------------------------------------------------------
// Buffer bounds, retirement, concurrency
// ---------------------------------------------------------------------------

test('the buffer is fixed-capacity and evicts the oldest events first', () => {
  const topology = denseFixture(4, 2, 4);
  const buffer = fixtureBuffer({ capacity: 5 });
  assert.equal(buffer.capacity, 5);

  buffer.ingest(fixtureStep(topology, 1, [0, 1]));
  assert.equal(buffer.size(), 4);
  buffer.ingest(fixtureStep(topology, 2, [2]));
  assert.equal(buffer.size(), 5);
  buffer.ingest(fixtureStep(topology, 3, [3]));
  assert.equal(buffer.size(), 5);
  assert.deepEqual(
    buffer.events().map(eventKey),
    ['1:3', '2:4', '2:5', '3:6', '3:7'],
    'the oldest events are evicted, order stays oldest → newest',
  );

  // A single step larger than the ring keeps only its newest events.
  const batch = buffer.ingest(fixtureStep(topology, 4, [0, 1, 2, 3]));
  assert.equal(batch.events.length, 8, 'the batch still reports every event of the step');
  assert.deepEqual(buffer.events().map(eventKey), ['4:3', '4:4', '4:5', '4:6', '4:7']);
  const stats = buffer.stats();
  assert.equal(stats.emitted, 16);
  assert.equal(stats.evicted, 11);
  assert.equal(stats.evicted + stats.retired + buffer.size(), stats.emitted, 'every event is accounted for');
});

test('events retire one step after they arrive, by simulation step rather than frames', () => {
  const buffer = fixtureBuffer();
  const topology = fixtureTopology();
  buffer.ingest({ ...topology, completedStep: 10n, spikeNeurons: new Uint32Array([0, 2]) });
  // Edges: 0→1 arrives 12, 0→2 arrives 10, 2→3 (×2) arrive 11.
  buffer.ingest({ ...topology, completedStep: 11n });
  assert.deepEqual(buffer.events().map((event) => event.edgeIndex), [0, 2, 3], 'delay-0 edge retired at 11');
  buffer.ingest({ ...topology, completedStep: 12n });
  assert.deepEqual(buffer.events().map((event) => event.edgeIndex), [0]);
  buffer.ingest({ ...topology, completedStep: 13n });
  assert.equal(buffer.size(), 0);
  assert.equal(buffer.stats().retired, 4);

  // A gap in steps retires everything that has landed in between.
  buffer.ingest({ ...topology, completedStep: 20n, spikeNeurons: new Uint32Array([3]) });
  buffer.ingest({ ...topology, completedStep: 40n });
  assert.equal(buffer.size(), 0);
});

test('many concurrent spikes keep every in-flight event intact across ring wraparound', () => {
  const topology = denseFixture(32, 6, 9);
  const capacity = 700;
  const buffer = fixtureBuffer({ capacity });
  const everyNeuron = [...Array(32).keys()];
  const seen = new Set();

  for (let step = 1; step <= 60; step += 1) {
    // Every neuron fires every step: 192 new events per step, and long edges
    // carry several spikes at once at different positions.
    const batch = buffer.ingest(fixtureStep(topology, step, everyNeuron));
    assert.equal(batch.events.length, 192);
    for (const event of batch.events) {
      const key = eventKey(event);
      assert.ok(!seen.has(key), `event ${key} is emitted once`);
      seen.add(key);
    }

    const buffered = buffer.events();
    assert.ok(buffered.length <= capacity);
    let previous = -1n;
    for (const event of buffered) {
      // Each buffered event still matches the topology it was mapped from.
      assert.equal(event.sourceNeuron, topology.topologyEdgeSources[event.edgeIndex]);
      assert.equal(event.targetNeuron, topology.topologyEdgeTargets[event.edgeIndex]);
      assert.equal(event.delaySteps, topology.topologyEdgeDelays[event.edgeIndex]);
      assert.equal(event.arrivalStep, event.emittedStep + BigInt(event.delaySteps));
      assert.ok(event.arrivalStep + 1n > BigInt(step), 'nothing past its retention lingers');
      assert.ok(event.emittedStep >= previous, 'emission order is preserved');
      previous = event.emittedStep;
    }
  }

  const perEdge = new Map();
  for (const event of buffer.events()) {
    perEdge.set(event.edgeIndex, (perEdge.get(event.edgeIndex) ?? 0) + 1);
  }
  assert.ok(Math.max(...perEdge.values()) > 1, 'one edge carries several spikes concurrently');
  const stats = buffer.stats();
  assert.equal(stats.emitted, 60 * 192);
  assert.ok(stats.evicted > 0, 'capacity bounds the ring under sustained load');
  assert.equal(stats.evicted + stats.retired + buffer.size(), stats.emitted);
});

test('reading or changing the buffer from a listener cannot corrupt iteration', () => {
  const topology = denseFixture(4, 2, 3);
  const buffer = fixtureBuffer({ capacity: 6 });
  buffer.ingest(fixtureStep(topology, 1, [0, 1, 2]));

  const visited = [];
  buffer.forEach((event) => {
    visited.push(eventKey(event));
    if (visited.length === 2) {
      buffer.ingest(fixtureStep(topology, 2, [3]));
    }
  });
  assert.equal(visited.length, 2, 'iteration stops once the ring changes underneath it');
  assert.equal(buffer.size(), 6);

  // Reentrant ingest from a subscriber sees a fully updated buffer.
  const reentrant = [];
  const unsubscribe = buffer.subscribe((batch) => {
    reentrant.push([batch.step, buffer.latestStep()]);
    if (batch.step === 3n) buffer.ingest(fixtureStep(topology, 4, [0]));
  });
  buffer.ingest(fixtureStep(topology, 3, [1]));
  unsubscribe();
  assert.deepEqual(reentrant, [[3n, 3n], [4n, 4n]]);
  assert.equal(buffer.latestStep(), 4n);
});

test('every subscriber receives steps in order when one of them ingests re-entrantly', () => {
  const topology = denseFixture(4, 2, 3);
  const buffer = fixtureBuffer();
  const first = [];
  const second = [];
  const third = [];
  buffer.subscribe((batch) => {
    first.push(batch.step);
    // Re-enter twice from inside delivery: steps 4 and then 5 (from 4's delivery).
    if (batch.step === 3n || batch.step === 4n) {
      const nested = buffer.ingest(fixtureStep(topology, Number(batch.step) + 1, [0]));
      assert.equal(nested.step, batch.step + 1n, 'the nested ingest still returns its own batch');
    }
  });
  buffer.subscribe((batch) => second.push([batch.step, batch.events.length]));
  buffer.subscribe((batch) => third.push(batch.step));

  buffer.ingest(fixtureStep(topology, 3, [1, 2]));

  assert.deepEqual(first, [3n, 4n, 5n]);
  assert.deepEqual(second, [[3n, 4], [4n, 2], [5n, 2]], 'the second subscriber never sees a later step first');
  assert.deepEqual(third, [3n, 4n, 5n]);
  assert.equal(buffer.latestStep(), 5n);

  // Delivery resumes normally once the queue has drained.
  buffer.ingest(fixtureStep(topology, 6, []));
  assert.deepEqual(third, [3n, 4n, 5n, 6n]);

  // Disposing from inside delivery drops the queued batches and the rest of the listeners.
  const late = fixtureBuffer();
  const seenAfterDispose = [];
  late.subscribe((batch) => {
    if (batch.step === 1n) {
      late.ingest(fixtureStep(topology, 2, [0]));
      late.dispose();
    }
  });
  late.subscribe((batch) => seenAfterDispose.push(batch.step));
  late.ingest(fixtureStep(topology, 1, [0]));
  assert.deepEqual(seenAfterDispose, [], 'no batch reaches listeners after dispose');
});

test('repeated steps are ignored; a restarted session or new topology resets the buffer', () => {
  const buffer = fixtureBuffer();
  const topology = fixtureTopology();
  assert.ok(buffer.ingest({ ...topology, completedStep: 5n, spikeNeurons: new Uint32Array([0]) }));
  assert.equal(buffer.ingest({ ...topology, completedStep: 5n, spikeNeurons: new Uint32Array([0]) }), null);
  assert.equal(buffer.size(), 2, 'a repeated snapshot does not duplicate events');

  // A fresh adapter (for example the main-thread retry) restarts at step 1.
  buffer.ingest({ ...topology, completedStep: 1n, spikeNeurons: new Uint32Array([3]) });
  assert.deepEqual(buffer.events().map(eventKey), ['1:4']);
  assert.equal(buffer.stats().resets, 1);

  buffer.ingest({ ...topology, completedStep: 2n, topologyDigest: 'fixture-topology-b', spikeNeurons: new Uint32Array([2]) });
  assert.deepEqual(buffer.events().map((event) => event.topologyDigest), ['fixture-topology-b', 'fixture-topology-b']);
  assert.equal(buffer.stats().resets, 2);
});

test('a snapshot that cannot be mapped leaves the buffer untouched', () => {
  const buffer = fixtureBuffer();
  const topology = fixtureTopology();
  buffer.ingest({ ...topology, completedStep: 5n, spikeNeurons: new Uint32Array([0]) });
  const before = buffer.events();
  assert.throws(() => buffer.ingest({ ...topology, completedStep: 6n, spikeNeurons: new Uint32Array([7]) }), RangeError);
  assert.throws(() => buffer.ingest({ ...topology, completedStep: 1n, spikeNeurons: new Uint32Array([7]) }), RangeError);
  assert.deepEqual(buffer.events(), before);
  assert.equal(buffer.latestStep(), 5n);
  assert.equal(buffer.stats().resets, 0);
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

test('every event and batch carries the provenance its buffer was created with', () => {
  assert.throws(() => spikes.createSpikeEventBuffer({ provenance: 'synthetic' }), RangeError);
  assert.throws(() => spikes.createSpikeEventBuffer({}), RangeError);
  assert.throws(() => fixtureBuffer({ capacity: 0 }), RangeError);
  assert.throws(() => fixtureBuffer({ retainSteps: -1 }), RangeError);

  const topology = fixtureTopology({ spikeNeurons: new Uint32Array([0]) });
  const live = spikes.createSpikeEventBuffer({ provenance: 'live-wasm' });
  const fixture = fixtureBuffer();
  const liveBatch = live.ingest(topology);
  const fixtureBatch = fixture.ingest(topology);
  assert.equal(liveBatch.provenance, 'live-wasm');
  assert.equal(fixtureBatch.provenance, 'fixture');
  assert.deepEqual(live.events().map((event) => event.provenance), ['live-wasm', 'live-wasm']);
  assert.deepEqual(fixture.events().map((event) => event.provenance), ['fixture', 'fixture']);
  assert.equal(live.stats().provenance, 'live-wasm');
  assert.equal(spikes.LIVE_SPIKE_EVENT_PROVENANCE, 'live-wasm');
});

test('fixture events stay out of the shipped live path', () => {
  const live = [
    '../src/runtime/live-seams.ts',
    '../src/runtime/topology-renderer.ts',
    '../src/runtime/wasm-session.ts',
    '../src/runtime/enhance-demo.ts',
    '../src/runtime/demo-runtime.ts',
    '../src/components/NeuromorphicDemo.astro',
  ].map(readSource).join('\n');
  assert.doesNotMatch(live, /'fixture'|"fixture"/, 'no live module can create a fixture buffer');
  assert.match(readSource('../src/runtime/live-seams.ts'), /provenance: LIVE_SPIKE_EVENT_PROVENANCE/);
  assert.match(readSource('../src/runtime/topology-renderer.ts'), /provenance: LIVE_SPIKE_EVENT_PROVENANCE/);

  // The event path maps spikes; it never generates them.
  const eventPath = [readSource('../src/runtime/spike-events.ts'), readSource('../src/runtime/topology-renderer.ts')].join('\n');
  assert.doesNotMatch(eventPath, /Math\.random|getRandomValues|spikeTrain|fakeNeuron|toySnn|simulateNetwork/);
});

// ---------------------------------------------------------------------------
// Cleanup: pause, dispose, detach
// ---------------------------------------------------------------------------

test('clear and dispose release every event; disposed buffers ignore later input', () => {
  const buffer = fixtureBuffer();
  const topology = fixtureTopology({ spikeNeurons: new Uint32Array([0, 2]) });
  const batches = [];
  buffer.subscribe((batch) => batches.push(batch.step));
  buffer.ingest(topology);
  assert.equal(buffer.size(), 4);

  buffer.clear();
  assert.equal(buffer.size(), 0);
  assert.equal(buffer.latestStep(), null);
  assert.equal(buffer.stats().clears, 1);
  // After a clear (pause), the same step is accepted again as a fresh start.
  assert.ok(buffer.ingest(topology));

  buffer.dispose();
  assert.equal(buffer.size(), 0);
  assert.equal(buffer.ingest({ ...topology, completedStep: 11n }), null);
  assert.equal(buffer.size(), 0);
  assert.deepEqual(batches, [10n, 10n], 'listeners are dropped on dispose');
  const late = [];
  buffer.subscribe(() => late.push(true))();
  assert.deepEqual(late, []);
  buffer.dispose();
});

test('the channel feed ingests only while active, clears on pause, and detaches cleanly', () => {
  const channel = channelModule.createSimulationChannel();
  const buffer = fixtureBuffer();
  const errors = [];
  const feed = spikes.feedSpikeEvents(channel, buffer, (error) => errors.push(error));
  const topology = fixtureTopology({ spikeNeurons: new Uint32Array([0]) });

  channel.publish({ ...topology, completedStep: 1n });
  assert.equal(buffer.size(), 0, 'inactive feeds ignore snapshots');
  feed.setActive(true);
  channel.publish({ ...topology, completedStep: 2n });
  assert.equal(buffer.size(), 2);

  feed.setActive(false);
  assert.equal(buffer.size(), 0, 'pausing clears the buffer');
  channel.publish({ ...topology, completedStep: 3n });
  assert.equal(buffer.size(), 0, 'a straggling tick after pause is not ingested');

  feed.setActive(true);
  channel.publish({ ...topology, completedStep: 4n, spikeNeurons: new Uint32Array([9]) });
  assert.equal(errors.length, 1, 'an unmappable snapshot is reported, not swallowed');
  assert.ok(errors[0] instanceof RangeError);
  channel.publish({ ...topology, completedStep: 5n });
  assert.equal(buffer.size(), 2);

  feed.detach();
  assert.equal(buffer.size(), 0, 'detaching clears the buffer');
  channel.publish({ ...topology, completedStep: 6n });
  assert.equal(buffer.size(), 0, 'detached feeds no longer subscribe');
  feed.setActive(true);
  channel.publish({ ...topology, completedStep: 7n });
  assert.equal(buffer.size(), 0);
  feed.detach();
});

test('a throwing subscriber is reported without interrupting ingestion', () => {
  const buffer = fixtureBuffer();
  const reported = [];
  const host = globalThis;
  const original = host.reportError;
  host.reportError = (error) => reported.push(error);
  try {
    const after = [];
    buffer.subscribe(() => {
      throw new Error('telemetry consumer failed');
    });
    buffer.subscribe((batch) => after.push(batch.step));
    const batch = buffer.ingest(fixtureTopology({ spikeNeurons: new Uint32Array([3]) }));
    assert.ok(batch);
    assert.deepEqual(after, [10n]);
    assert.equal(reported.length, 1);
    assert.equal(buffer.size(), 1);
  } finally {
    host.reportError = original;
  }
});

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

test('propagation timing follows synaptic-wiring delays at the 50 ms demo step', () => {
  assert.equal(spikes.SPIKE_EVENT_STEP_MS, stimulus.DEMO_TICK_MS);
  assert.equal(spikes.SPIKE_EVENT_STEP_MS, 50);
  assert.equal(spikes.delayStepsToMs(3), 150);
  assert.equal(spikes.delayStepsToMs(2, 20), 40);

  const tail = spikes.PULSE_TAIL_STEPS;
  assert.equal(spikes.propagationSpan(2, -0.01), null, 'nothing before emission');
  assert.deepEqual(spikes.propagationSpan(2, 0), { head: 0, tail: 0 });
  assert.deepEqual(spikes.propagationSpan(2, 1), { head: 0.5, tail: (1 - tail) / 2 });
  assert.deepEqual(spikes.propagationSpan(2, 2), { head: 1, tail: (2 - tail) / 2 }, 'head reaches the target on the arrival step');
  assert.equal(spikes.propagationSpan(2, 2 + tail), null, 'gone once the tail lands');
  assert.ok(spikes.propagationSpan(4, 2).head < spikes.propagationSpan(1, 0.6).head, 'longer delays travel slower');

  assert.deepEqual(spikes.propagationSpan(0, 0), { head: 1, tail: 0 }, 'zero delay spans the whole edge at once');
  assert.equal(spikes.propagationSpan(0, tail), null);
  assert.equal(spikes.propagationSpan(1, Number.NaN), null);

  // Retention always outlives the drawn pulse, so frames never lose a pulse
  // the buffer has already retired.
  assert.ok(spikes.DEFAULT_SPIKE_EVENT_RETAIN_STEPS >= tail);
});

test('the per-frame span helper writes into one caller-owned object and matches propagationSpan', () => {
  const out = { head: -1, tail: -1 };
  for (const delay of [0, 1, 2, 4, 9]) {
    for (let elapsed = -0.5; elapsed <= delay + 1.5; elapsed += 0.05) {
      const expected = spikes.propagationSpan(delay, elapsed);
      const before = { ...out };
      const visible = spikes.propagationSpanInto(out, delay, elapsed);
      assert.equal(visible, expected !== null, `delay ${delay}, elapsed ${elapsed}`);
      // Hidden pulses leave the reused object untouched; visible ones overwrite it.
      assert.deepEqual({ ...out }, expected ?? before);
    }
  }
  assert.equal(spikes.propagationSpanInto(out, 2, Number.NaN), false);
});

test('the renderer frame path reuses its span and visitor instead of allocating per event', () => {
  const source = readSource('../src/runtime/topology-renderer.ts');
  const start = source.indexOf('const writeVertex = ');
  const end = source.indexOf('const loop = ');
  assert.ok(start > 0 && end > start, 'frame-path functions are where this guard expects them');
  const framePath = source.slice(start, end);
  assert.match(framePath, /propagationSpanInto\(pulseSpan,/);
  assert.match(framePath, /spikeEvents\.forEach\(visitPulse\)/);
  assert.doesNotMatch(framePath, /propagationSpan\(/, 'the allocating span helper stays out of frames');
  assert.doesNotMatch(framePath, /new [A-Z]|\.clone\(|forEach\(\(|\[\.\.\.|\.map\(/, 'no per-frame allocation');
});

test('subscribing or unsubscribing during delivery only affects later batches', () => {
  const topology = denseFixture(4, 2, 3);
  const buffer = fixtureBuffer();
  const seen = { a: [], b: [], c: [] };
  const c = (batch) => seen.c.push(batch.step);
  let unsubscribeB = () => {};
  buffer.subscribe((batch) => {
    seen.a.push(batch.step);
    if (batch.step === 1n) {
      unsubscribeB();
      buffer.subscribe(c);
      buffer.subscribe(c);
    }
  });
  unsubscribeB = buffer.subscribe((batch) => seen.b.push(batch.step));

  buffer.ingest(fixtureStep(topology, 1, [0]));
  buffer.ingest(fixtureStep(topology, 2, [0]));

  assert.deepEqual(seen.a, [1n, 2n]);
  assert.deepEqual(seen.b, [1n], 'an unsubscribed listener still finishes the batch in flight');
  assert.deepEqual(seen.c, [2n], 'a new listener starts with the next batch, registered once');
});

test('the dev inspector clamps recent(limit) to the buffered events', () => {
  const buffer = fixtureBuffer();
  const topology = fixtureTopology({ spikeNeurons: new Uint32Array([0, 2]) });
  buffer.ingest(topology);
  const inspector = liveSeams.createSpikeEventInspector(buffer, { inspect: () => null });

  assert.equal(inspector.recent().length, 4, 'the default 16 covers all four events');
  assert.deepEqual(inspector.recent(0), [], 'zero returns none');
  assert.deepEqual(inspector.recent(-3), []);
  assert.deepEqual(inspector.recent(Number.NaN), []);
  assert.deepEqual(inspector.recent(2).map((event) => event.edgeIndex), [2, 3], 'the newest events, oldest first');
  assert.deepEqual(inspector.recent(2.9).map((event) => event.edgeIndex), [2, 3]);
  assert.equal(inspector.recent(99).length, 4);
  assert.equal(inspector.recent(Number.POSITIVE_INFINITY).length, 4);
  assert.deepEqual(inspector.recent(1)[0], {
    provenance: 'fixture',
    emittedStep: '10',
    arrivalStep: '11',
    sourceNeuron: 2,
    targetNeuron: 3,
    edgeIndex: 3,
    delaySteps: 1,
    polarity: 1,
  });
  assert.equal(inspector.stats().latestStep, '10');
  assert.equal(inspector.renderer(), null);
});

test('pulses are layered between the edges and the neuron markers', () => {
  const renderer = rendererModule;
  assert.ok(renderer.EDGE_RENDER_ORDER < renderer.PULSE_RENDER_ORDER);
  assert.ok(renderer.PULSE_RENDER_ORDER < renderer.NODE_RENDER_ORDER);
  const source = readSource('../src/runtime/topology-renderer.ts');
  assert.match(source, /pulseMesh\.renderOrder = PULSE_RENDER_ORDER/);
  assert.match(source, /pointsObject\.renderOrder = NODE_RENDER_ORDER/);
  assert.match(source, /edgeObject\.renderOrder = EDGE_RENDER_ORDER/);
});

test('live seams share one live-wasm buffer with an inspectable renderer seam', () => {
  const seams = liveSeams.createLiveDemoSeams();
  assert.equal(typeof seams.renderer.inspect, 'function');
  assert.equal(seams.renderer.inspect(), null, 'no frame is reported before a session exists');
});
