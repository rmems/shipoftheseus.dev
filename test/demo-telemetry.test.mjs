import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { loadTsModule, readSource } from './load-ts-module.mjs';

const telemetry = await loadTsModule('../src/runtime/demo-telemetry.ts');
const spikes = await loadTsModule('../src/runtime/spike-events.ts');
const adapterModule = await loadTsModule('../src/runtime/neuromorphic-adapter.ts');
const channelModule = await loadTsModule('../src/runtime/simulation-channel.ts');
const stimulus = await loadTsModule('../src/runtime/demo-stimulus.ts');
const wasmSession = await loadTsModule('../src/runtime/wasm-session.ts');
const view = await loadTsModule('../src/runtime/telemetry-view.ts');
const entry = await loadTsModule('../src/runtime/telemetry-entry.ts');

// ---------------------------------------------------------------------------
// Helpers. Hand-built batches are tagged `fixture` and used only for the ring
// and scheduler mechanics; the live path below runs the committed WASM package.
// ---------------------------------------------------------------------------

const NODE_IDS = new Uint32Array([0, 1, 2, 3]);

function fixtureBatch(step, neurons, digest = 'fixture-digest') {
  return { provenance: 'fixture', step: BigInt(step), topologyDigest: digest, spikeNeurons: neurons };
}

function fixtureSnapshot(step, encodedSpikeCount = 0, digest = 'fixture-digest', nodeIds = NODE_IDS) {
  return { completedStep: BigInt(step), topologyDigest: digest, topologyNodeIds: nodeIds, encodedSpikeCount };
}

function record(raster, step, neurons, encoded = 0, digest) {
  raster.record(fixtureBatch(step, neurons, digest), fixtureSnapshot(step, encoded, digest));
}

/** A deterministic clock: timers fire only when the test advances time. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, ms) {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, ms), callback });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.at <= end && (due === null || timer.at < due[1].at)) due = [id, timer];
        }
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = end;
    },
  };
}

function fakePanel({ open = false, mode = 'live', reducedMotion = false } = {}) {
  const toggles = new Set();
  const modeListeners = new Set();
  const panel = {
    open,
    mode,
    reducedMotion,
    toggleListeners: () => toggles.size,
    modeListeners: () => modeListeners.size,
    port: {
      isOpen: () => panel.open,
      onToggle(listener) {
        toggles.add(listener);
        return () => toggles.delete(listener);
      },
      demoMode: () => panel.mode,
      onDemoModeChange(listener) {
        modeListeners.add(listener);
        return () => modeListeners.delete(listener);
      },
      prefersReducedMotion: () => panel.reducedMotion,
    },
    setOpen(value) {
      panel.open = value;
      for (const listener of [...toggles]) listener();
    },
    setMode(value) {
      panel.mode = value;
      for (const listener of [...modeListeners]) listener();
    },
  };
  return panel;
}

/** Wrap a spike-event buffer so the test can count live subscriptions. */
function countingSource(buffer) {
  let subscriptions = 0;
  return {
    subscriptions: () => subscriptions,
    spikeEvents: {
      provenance: buffer.provenance,
      stats: () => buffer.stats(),
      subscribe(listener) {
        subscriptions += 1;
        const off = buffer.subscribe(listener);
        return () => {
          subscriptions -= 1;
          off();
        };
      },
    },
  };
}

const wasmUrl = new URL('../public/wasm/neuromorphic-adapter/neuromorphic_adapter.js', import.meta.url);
const wasmBytes = readFileSync(new URL('../public/wasm/neuromorphic-adapter/neuromorphic_adapter_bg.wasm', import.meta.url));

async function liveAdapter() {
  // The committed `web` package through the shipped bridge and live options.
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

/**
 * The live island's wiring without the DOM: one channel, the single
 * `live-wasm` buffer fed from it, and the scripted input path.
 */
async function liveRig() {
  const adapter = await liveAdapter();
  const channel = channelModule.createSimulationChannel();
  const buffer = spikes.createSpikeEventBuffer({ provenance: spikes.LIVE_SPIKE_EVENT_PROVENANCE });
  const errors = [];
  const feed = spikes.feedSpikeEvents(channel, buffer, (error) => errors.push(error));
  feed.setActive(true);
  let sequence = 0n;
  return {
    adapter,
    channel,
    buffer,
    errors,
    step() {
      sequence += 1n;
      adapter.input(sequence, stimulus.scriptedTelemetry(sequence));
      const state = adapter.step();
      channel.publish(state);
      return state;
    },
    dispose() {
      feed.detach();
      adapter.dispose();
    },
  };
}

function potentialBits(state) {
  return Array.from(new Uint32Array(state.membranePotentials.buffer.slice(0)));
}

// ---------------------------------------------------------------------------
// Raster ring
// ---------------------------------------------------------------------------

test('the raster ring is bounded and evicts the oldest steps first', () => {
  const raster = telemetry.createSpikeRaster({ provenance: 'fixture', steps: 4 });
  assert.equal(raster.capacity, 4);
  assert.equal(raster.size(), 0);
  assert.equal(raster.latestStep(), null);

  record(raster, 1, [0], 3);
  record(raster, 2, [1, 3], 1);
  record(raster, 3, [], 0);
  record(raster, 4, [0, 2], 5);
  assert.equal(raster.size(), 4);
  record(raster, 5, [3], 2);
  record(raster, 6, [0], 0);

  assert.equal(raster.size(), 4, 'the ring never grows past its capacity');
  assert.equal(raster.oldestStep(), 3n);
  assert.equal(raster.latestStep(), 6n);
  assert.equal(raster.stats().evictedRows, 2);
  assert.equal(raster.spiked(1n, 0), null, 'evicted steps are no longer known');
  assert.equal(raster.spiked(4n, 2), true);
  assert.equal(raster.spiked(4n, 1), false);
  assert.equal(raster.spiked(7n, 0), null, 'future steps are unknown, not false');
  assert.deepEqual(raster.recentSpikeSteps(0), [6n, 4n], 'newest first, inside the window only');
  assert.deepEqual(raster.recentSpikeSteps(0, 1), [6n]);

  const rows = [];
  raster.forEachRow((column, step, sampled, encoded) => rows.push([column, step, sampled, encoded]));
  assert.deepEqual(rows, [[0, 3n, true, 0], [1, 4n, true, 5], [2, 5n, true, 2], [3, 6n, true, 0]]);
  const marks = [];
  raster.forEachSpike((column, neuron) => marks.push([column, neuron]));
  assert.deepEqual(marks, [[1, 0], [1, 2], [2, 3], [3, 0]]);
  assert.deepEqual(raster.totals(), { spikes: 4, activeNeurons: 3, encodedSpikes: 7, sampledRows: 4 });
});

test('skipped steps become unsampled gap rows; restarts and new topologies reset the ring', () => {
  const raster = telemetry.createSpikeRaster({ provenance: 'fixture', steps: 5 });
  record(raster, 10, [1]);
  record(raster, 13, [2]);
  assert.equal(raster.size(), 4, 'steps 11 and 12 are kept as gaps so columns stay consecutive');
  assert.equal(raster.spiked(11n, 2), null);
  assert.equal(raster.stats().gapRows, 2);

  record(raster, 40, [0]);
  assert.equal(raster.oldestStep(), 36n, 'a gap wider than the ring keeps only the newest window');
  assert.equal(raster.size(), 5);

  record(raster, 2, [3]);
  assert.equal(raster.oldestStep(), 2n, 'a lower step is a fresh adapter counting again');
  assert.equal(raster.size(), 1);
  assert.equal(raster.stats().resets, 1);

  record(raster, 3, [1], 0, 'other-digest');
  assert.equal(raster.size(), 1, 'a new topology starts a new raster');
  assert.equal(raster.topologyDigest(), 'other-digest');
  assert.equal(raster.stats().resets, 2);

  raster.reset();
  assert.equal(raster.size(), 0);
  assert.equal(raster.topologyDigest(), null);
});

test('raster recording is atomic and refuses mismatched or foreign input', () => {
  const raster = telemetry.createSpikeRaster({ provenance: 'fixture', steps: 3 });
  record(raster, 1, [1]);
  const before = raster.stats();

  assert.throws(() => record(raster, 2, [4]), RangeError, 'a neuron outside the topology');
  assert.throws(
    () => raster.record(fixtureBatch(2, [0]), fixtureSnapshot(3)),
    RangeError,
    'the batch and snapshot must be the same step',
  );
  assert.throws(
    () => raster.record({ ...fixtureBatch(2, [0]), provenance: 'live-wasm' }, fixtureSnapshot(2)),
    RangeError,
    'a fixture raster never records live events (and vice versa)',
  );
  assert.throws(() => raster.record(fixtureBatch(2, [0]), fixtureSnapshot(2, -1)), RangeError);
  assert.deepEqual(raster.stats(), before, 'a rejected record changes nothing');

  assert.throws(() => telemetry.createSpikeRaster({ provenance: 'synthetic' }), RangeError);
  assert.throws(() => telemetry.createSpikeRaster({ provenance: 'fixture', steps: 0 }), RangeError);
});

// ---------------------------------------------------------------------------
// Throttled flushes
// ---------------------------------------------------------------------------

test('flushes coalesce to the configured cadence, independent of the step rate', () => {
  const clock = fakeClock();
  const flushedAt = [];
  const scheduler = telemetry.createFlushScheduler(() => flushedAt.push(clock.now()), { clock });
  assert.equal(scheduler.cadenceHz(), telemetry.DEFAULT_TELEMETRY_HZ);
  assert.equal(telemetry.DEFAULT_TELEMETRY_HZ, 4);

  // Twenty simulation steps per second for two seconds, each requesting a flush.
  for (let tick = 0; tick < 40; tick += 1) {
    scheduler.request();
    clock.advance(50);
  }
  assert.deepEqual(flushedAt, [0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000], '4 Hz, not 20 Hz');

  scheduler.setCadenceHz(1);
  flushedAt.length = 0;
  for (let tick = 0; tick < 40; tick += 1) {
    scheduler.request();
    clock.advance(50);
  }
  assert.deepEqual(flushedAt, [3000, 4000], 'a performance budget can lower the cadence at any time');

  assert.equal(clock.pending(), 0);
  clock.advance(5000);
  assert.equal(flushedAt.length, 2, 'without requests there are no timers and no flushes');

  scheduler.setCadenceHz(1000);
  assert.equal(scheduler.cadenceHz(), telemetry.MAX_TELEMETRY_HZ, 'capped at one flush per simulation step');
  assert.equal(telemetry.MAX_TELEMETRY_HZ, 1000 / stimulus.DEMO_TICK_MS);
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '4']) {
    assert.throws(() => scheduler.setCadenceHz(invalid), RangeError);
  }

  scheduler.request();
  assert.equal(scheduler.pending(), true);
  scheduler.cancel();
  assert.equal(clock.pending(), 0, 'cancel releases the timer');
});

test('the controller samples per step but renders only at its cadence', async () => {
  const rig = await liveRig();
  const clock = fakeClock();
  const panel = fakePanel({ open: true });
  const renders = [];
  const controller = telemetry.createTelemetryController({
    sources: { spikeEvents: rig.buffer, channel: rig.channel, inputSource: () => 'scripted' },
    panel: panel.port,
    render: (model) => renders.push(model),
    clock,
  });
  try {
    assert.equal(renders.length, 1, 'opening renders immediately');
    for (let tick = 0; tick < 40; tick += 1) {
      rig.step();
      clock.advance(50);
    }
    const inspection = controller.inspect();
    assert.equal(inspection.samples, 40, 'every step is sampled into the ring');
    assert.equal(inspection.rasterRows, 40);
    assert.equal(renders.length, 1 + 8, 'two seconds at 4 Hz');

    controller.setCadenceHz(2);
    renders.length = 0;
    for (let tick = 0; tick < 40; tick += 1) {
      rig.step();
      clock.advance(50);
    }
    assert.equal(renders.length, 4, 'two seconds at 2 Hz');
  } finally {
    controller.dispose();
    rig.dispose();
  }
});

test('reduced motion caps the telemetry refresh rate', () => {
  const clock = fakeClock();
  const buffer = spikes.createSpikeEventBuffer({ provenance: 'live-wasm' });
  const channel = channelModule.createSimulationChannel();
  const panel = fakePanel({ open: false, reducedMotion: true });
  const controller = telemetry.createTelemetryController({
    sources: { spikeEvents: buffer, channel, inputSource: () => null },
    panel: panel.port,
    render() {},
    clock,
  });
  panel.setOpen(true);
  assert.equal(controller.cadenceHz(), 4);
  assert.equal(controller.effectiveCadenceHz(), telemetry.REDUCED_MOTION_TELEMETRY_HZ);
  controller.setCadenceHz(0.5);
  assert.equal(controller.effectiveCadenceHz(), 0.5, 'a lower budget still wins');
  controller.dispose();
});

// ---------------------------------------------------------------------------
// Disabled telemetry leaves the simulation untouched
// ---------------------------------------------------------------------------

test('a closed or disabled panel holds no subscription, timer, or observer', () => {
  const clock = fakeClock();
  const buffer = spikes.createSpikeEventBuffer({ provenance: 'live-wasm' });
  const source = countingSource(buffer);
  const channel = channelModule.createSimulationChannel();
  const panel = fakePanel({ open: false });
  const renders = [];
  const controller = telemetry.createTelemetryController({
    sources: { spikeEvents: source.spikeEvents, channel, inputSource: () => null },
    panel: panel.port,
    render: (model) => renders.push(model.state),
    clock,
  });

  assert.equal(source.subscriptions(), 0, 'closed by default: nothing subscribes');
  assert.equal(panel.modeListeners(), 0);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(renders, [], 'and nothing renders');

  panel.setOpen(true);
  assert.equal(source.subscriptions(), 1);
  assert.equal(panel.modeListeners(), 1);
  assert.equal(controller.inspect().sampling, true);
  assert.deepEqual(renders, ['waiting']);

  panel.setOpen(false);
  assert.equal(source.subscriptions(), 0, 'closing unsubscribes');
  assert.equal(panel.modeListeners(), 0);
  assert.equal(clock.pending(), 0);
  assert.equal(controller.inspect().sampling, false);

  panel.setOpen(true);
  controller.setEnabled(false);
  assert.equal(source.subscriptions(), 0, 'a performance budget can turn telemetry off while open');
  assert.equal(renders.at(-1), 'disabled');
  controller.setEnabled(true);
  assert.equal(source.subscriptions(), 1);

  controller.dispose();
  assert.equal(source.subscriptions(), 0);
  assert.equal(panel.toggleListeners(), 0, 'dispose releases the toggle listener');
  panel.setOpen(true);
  assert.equal(source.subscriptions(), 0, 'a disposed controller never resubscribes');
});

test('the simulation produces identical state with telemetry open, closed, or failing', async () => {
  const runs = [];
  for (const variant of ['none', 'open', 'closed', 'throwing']) {
    const rig = await liveRig();
    const clock = fakeClock();
    const panel = fakePanel({ open: variant === 'open' || variant === 'throwing' });
    const reported = [];
    const originalReport = globalThis.reportError;
    globalThis.reportError = (error) => reported.push(error);
    const controller =
      variant === 'none'
        ? null
        : telemetry.createTelemetryController({
            sources: { spikeEvents: rig.buffer, channel: rig.channel, inputSource: () => 'scripted' },
            panel: panel.port,
            render() {
              if (variant === 'throwing') throw new Error('telemetry view failed');
            },
            clock,
          });
    const trace = [];
    try {
      for (let tick = 0; tick < 120; tick += 1) {
        const state = rig.step();
        clock.advance(50);
        trace.push({
          step: state.completedStep,
          spikes: Array.from(state.spikeNeurons),
          potentials: potentialBits(state),
          features: Array.from(state.encoderFeatures),
          encoded: state.encodedSpikeCount,
        });
      }
      runs.push({ variant, trace, events: rig.buffer.stats().emitted, errors: rig.errors.length, reported: reported.length });
    } finally {
      globalThis.reportError = originalReport;
      controller?.dispose();
      rig.dispose();
    }
  }

  const [baseline, ...others] = runs;
  assert.ok(baseline.trace.some((entry) => entry.spikes.length > 0), 'the run includes real neuromod spikes');
  for (const run of others) {
    assert.deepEqual(run.trace, baseline.trace, `telemetry ${run.variant} does not change simulation state`);
    assert.equal(run.events, baseline.events, `telemetry ${run.variant} does not change the spike-event stream`);
    assert.equal(run.errors, 0);
  }
  assert.ok(runs.find((run) => run.variant === 'throwing').reported > 0, 'view failures are reported, not thrown');
});

test('telemetry reads the live seams but has no handle to drive them', () => {
  const source = readSource('../src/runtime/demo-telemetry.ts');
  const viewSource = readSource('../src/runtime/telemetry-view.ts');
  const entrySource = readSource('../src/runtime/telemetry-entry.ts');
  const both = `${source}\n${viewSource}\n${entrySource}`;
  assert.doesNotMatch(both, /\.publish\(|\.ingest\(|\.input\(|\.step\(\)|spikeEvents\.clear|feedSpikeEvents|createSpikeEventBuffer|setActive\(/);
  assert.doesNotMatch(both, /Math\.random|getRandomValues|spikeTrain|fakeNeuron|toySnn|simulateNetwork/);
  assert.match(entrySource, /channel: Pick<SimulationChannel, 'latest'>/, 'the channel is read-only to telemetry');
  assert.match(readSource('../src/runtime/live-seams.ts'), /registerLiveTelemetrySources\(island, \{\s*spikeEvents,/);
  assert.doesNotMatch(viewSource, /'fixture'|"fixture"/);
});

// ---------------------------------------------------------------------------
// Inspector: only runtime-provided fields, associated with the rendered topology
// ---------------------------------------------------------------------------

test('a selected neuron exposes only runtime-provided fields from the live WASM snapshot', async () => {
  const rig = await liveRig();
  const raster = telemetry.createSpikeRaster({ provenance: 'live-wasm' });
  rig.buffer.subscribe((batch) => raster.record(batch, rig.channel.latest()));
  try {
    let state;
    for (let tick = 0; tick < 160; tick += 1) {
      state = rig.step();
    }
    const spiking = [...Array(16).keys()].find((neuron) => raster.recentSpikeSteps(neuron).length > 0);
    assert.notEqual(spiking, undefined, 'the scripted path drives real spikes');

    for (let neuron = 0; neuron < state.topologyNodeIds.length; neuron += 1) {
      const inspection = telemetry.inspectNeuron(state, raster, neuron);
      assert.deepEqual(
        Object.keys(inspection).sort(),
        ['incoming', 'membranePotential', 'neuron', 'outgoing', 'recentSpikeSteps', 'spikedAtStep', 'step', 'topologyDigest'],
        'no threshold, resting potential, refractory state, or model tag is invented',
      );
      for (const absent of ['threshold', 'thresholdPotential', 'restingPotential', 'refractory', 'model', 'neuronModel']) {
        assert.equal(absent in inspection, false, `${absent} stays absent`);
      }
      assert.equal(Object.isFrozen(inspection), true);
      assert.equal(inspection.neuron, state.topologyNodeIds[neuron]);
      assert.equal(inspection.step, state.completedStep);
      assert.ok(Object.is(inspection.membranePotential, state.membranePotentials[neuron]), 'the exact f32 neuromod potential');
      assert.equal(inspection.spikedAtStep, state.spikeNeurons.includes(neuron));

      // Outgoing synapses are exactly the edges the spike-event seam maps a
      // spike at this neuron onto, which are the edges the renderer pulses.
      const mapped = spikes.mapSpikesThroughTopology({ ...state, spikeNeurons: new Uint32Array([neuron]) }, 'live-wasm');
      assert.deepEqual(
        inspection.outgoing.map(({ edgeIndex, peer, weight, delaySteps, polarity }) => ({ edgeIndex, peer, weight, delaySteps, polarity })),
        mapped.map((event) => ({
          edgeIndex: event.edgeIndex,
          peer: event.targetNeuron,
          weight: event.weight,
          delaySteps: event.delaySteps,
          polarity: event.polarity === 0 ? 'excitatory' : 'inhibitory',
        })),
      );
      const incoming = [];
      for (let edge = 0; edge < state.topologyEdgeTargets.length; edge += 1) {
        if (state.topologyEdgeTargets[edge] === neuron) incoming.push(edge);
      }
      assert.deepEqual(inspection.incoming.map((synapse) => synapse.edgeIndex), incoming);
      for (const synapse of [...inspection.outgoing, ...inspection.incoming]) {
        assert.deepEqual(Object.keys(synapse).sort(), ['delayMs', 'delaySteps', 'edgeIndex', 'peer', 'polarity', 'weight']);
        assert.ok(Object.is(synapse.weight, state.topologyEdgeWeights[synapse.edgeIndex]));
        assert.equal(synapse.delaySteps, state.topologyEdgeDelays[synapse.edgeIndex]);
        assert.equal(synapse.delayMs, synapse.delaySteps * spikes.SPIKE_EVENT_STEP_MS);
      }
    }

    const recent = telemetry.inspectNeuron(state, raster, spiking).recentSpikeSteps;
    assert.ok(recent.length > 0 && recent.length <= telemetry.RECENT_SPIKE_LIMIT);
    for (let index = 1; index < recent.length; index += 1) {
      assert.ok(recent[index] < recent[index - 1], 'recent spike steps are newest first');
    }

    assert.equal(telemetry.inspectNeuron(state, raster, 16), null, 'outside the topology there is nothing to show');
    assert.equal(telemetry.inspectNeuron(state, raster, -1), null);
    const unsampled = telemetry.inspectNeuron(state, null, spiking);
    assert.equal(unsampled.spikedAtStep, null, 'without a raster, spike state is unknown rather than false');
    assert.deepEqual(unsampled.recentSpikeSteps, []);
  } finally {
    rig.dispose();
  }
});

test('encoder inspection shows the active axon-encoder mode and the exported kinetic-signals features', async () => {
  assert.equal(telemetry.KINETIC_FEATURE_LABELS.length, adapterModule.ENCODER_FEATURE_COUNT);
  const rig = await liveRig();
  try {
    let state;
    for (let tick = 0; tick < 30; tick += 1) {
      state = rig.step();
    }
    const encoder = telemetry.inspectEncoder(state, 'scripted');
    assert.deepEqual(
      Object.keys(encoder).sort(),
      ['contractVersion', 'encodedSpikeChannels', 'encodedSpikeCount', 'encodedSpikeTotal', 'features', 'inputSource', 'mode', 'name', 'step'],
    );
    assert.equal(encoder.contractVersion, 5);
    assert.equal(encoder.name, 'temporal');
    assert.equal(encoder.mode, adapterModule.ENCODER_MODES.temporal);
    assert.equal(encoder.encodedSpikeCount, state.encodedSpikeCount);
    assert.equal(encoder.encodedSpikeTotal, state.encodedSpikeTotal);
    assert.equal(encoder.inputSource, 'scripted');
    assert.deepEqual(encoder.features.map((feature) => feature.value), Array.from(state.encoderFeatures));
    assert.deepEqual(encoder.features.map((feature) => feature.label), telemetry.KINETIC_FEATURE_LABELS);
  } finally {
    rig.dispose();
  }

  const contract4 = telemetry.inspectEncoder(
    {
      contractVersion: 4,
      completedStep: 1n,
      encoderMode: 2,
      encoderName: 'rate',
      encodedSpikeCount: 1,
      encodedSpikeChannels: 1,
      encodedSpikeTotal: 1n,
      encoderFeatures: new Float32Array(0),
    },
    null,
  );
  assert.equal(contract4.features, null, 'contract 4 does not export features, so none are shown');
  assert.equal(
    telemetry.inspectEncoder({ contractVersion: 3, encoderFeatures: new Float32Array(0) }, null),
    null,
    'contract 3 carries bridge defaults, not runtime diagnostics',
  );
});

// ---------------------------------------------------------------------------
// Provenance labels
// ---------------------------------------------------------------------------

test('only live-wasm data is labeled as the live Rust/WASM runtime', async () => {
  assert.equal(telemetry.telemetryOrigin('live-wasm'), 'live-wasm');
  assert.equal(telemetry.telemetryOrigin('fixture'), 'unavailable-wasm');
  assert.equal(telemetry.telemetryOrigin(null), 'unavailable-wasm');

  const fixtureBuffer = spikes.createSpikeEventBuffer({ provenance: 'fixture' });
  assert.throws(
    () => entry.registerLiveTelemetrySources({}, { spikeEvents: fixtureBuffer, channel: { latest: () => null }, inputSource: () => null }),
    RangeError,
    'the panel can only be registered against the live-wasm buffer',
  );
  const island = {};
  const liveBuffer = spikes.createSpikeEventBuffer({ provenance: 'live-wasm' });
  const sources = { spikeEvents: liveBuffer, channel: { latest: () => null }, inputSource: () => null };
  assert.equal(entry.liveTelemetrySources(island), null);
  entry.registerLiveTelemetrySources(island, sources);
  assert.equal(entry.liveTelemetrySources(island), sources);

  // A fixture-fed controller (tests only) never renders the live label.
  const fixtureState = { ...(await firstLiveState()) };
  const fixtureChannel = { latest: () => fixtureState };
  const renders = [];
  const panel = fakePanel({ open: true });
  const fixtureController = telemetry.createTelemetryController({
    sources: { spikeEvents: fixtureBuffer, channel: fixtureChannel, inputSource: () => 'scripted' },
    panel: panel.port,
    render: (model) => renders.push(model),
    clock: fakeClock(),
  });
  assert.equal(renders.at(-1).provenance, 'fixture');
  assert.equal(renders.at(-1).origin, 'unavailable-wasm');
  fixtureController.dispose();

  // The live rig is labeled live once it has data, and names its crate layers.
  const rig = await liveRig();
  const liveRenders = [];
  const livePanel = fakePanel({ open: true });
  const clock = fakeClock();
  const liveController = telemetry.createTelemetryController({
    sources: { spikeEvents: rig.buffer, channel: rig.channel, inputSource: () => 'pointer' },
    panel: livePanel.port,
    render: (model) => liveRenders.push(model),
    clock,
  });
  try {
    assert.equal(liveRenders.at(-1).state, 'waiting');
    assert.equal(liveRenders.at(-1).origin, 'unavailable-wasm', 'no data yet, so nothing is labeled live');
    rig.step();
    clock.advance(250);
    const live = liveRenders.at(-1);
    assert.equal(live.state, 'streaming');
    assert.equal(live.origin, 'live-wasm');
    assert.equal(live.provenance, 'live-wasm');
    assert.match(live.status, /live Rust\/WASM runtime/);
    assert.match(live.rasterSummary, /neuromod/);
    assert.match(live.rasterSummary, /axon-encoder/);
    assert.equal(live.snapshot.contractVersion, 5);
    assert.equal(live.encoder.inputSource, 'pointer');

    livePanel.setMode('awaiting-play');
    clock.advance(250);
    assert.equal(liveRenders.at(-1).state, 'paused', 'telemetry follows the demo when it pauses');
    assert.match(liveRenders.at(-1).status, /Paused with the demo/);
    livePanel.setMode('fallback');
    clock.advance(250);
    assert.equal(liveRenders.at(-1).state, 'unavailable');
    assert.equal(liveRenders.at(-1).neuron, null, 'nothing is shown once the runtime is gone');
    assert.equal(liveRenders.at(-1).encoder, null);
  } finally {
    liveController.dispose();
    rig.dispose();
  }

  // Without live seams (no JS runtime connected) the panel keeps its static explanation.
  const staticRenders = [];
  telemetry.createTelemetryController({
    sources: null,
    panel: fakePanel({ open: true }).port,
    render: (model) => staticRenders.push(model),
    clock: fakeClock(),
  });
  assert.equal(staticRenders.at(-1).state, 'unavailable');
  assert.equal(staticRenders.at(-1).status, telemetry.TELEMETRY_STATIC_STATUS);
});

async function firstLiveState() {
  const rig = await liveRig();
  try {
    return rig.step();
  } finally {
    rig.dispose();
  }
}

// ---------------------------------------------------------------------------
// The real bridge end to end
// ---------------------------------------------------------------------------

test('the committed WASM package drives the raster and inspector through the real bridge', async () => {
  const rig = await liveRig();
  const clock = fakeClock();
  const panel = fakePanel({ open: false });
  const renders = [];
  const controller = telemetry.createTelemetryController({
    sources: { spikeEvents: rig.buffer, channel: rig.channel, inputSource: () => 'scripted' },
    panel: panel.port,
    render: (model) => renders.push(model),
    clock,
  });
  const window = [];
  try {
    for (let tick = 0; tick < 20; tick += 1) {
      rig.step();
      clock.advance(50);
    }
    assert.equal(renders.length, 0, 'steps while closed are neither sampled nor rendered');

    panel.setOpen(true);
    let state;
    for (let tick = 0; tick < 160; tick += 1) {
      state = rig.step();
      window.push(state);
      clock.advance(50);
    }
    clock.advance(250);
    const model = renders.at(-1);
    assert.equal(model.raster.size(), telemetry.DEFAULT_RASTER_STEPS, 'the ring holds the last 120 steps');
    assert.equal(model.raster.latestStep(), state.completedStep);
    assert.equal(model.raster.oldestStep(), state.completedStep - BigInt(telemetry.DEFAULT_RASTER_STEPS - 1));
    const kept = window.slice(-telemetry.DEFAULT_RASTER_STEPS);
    assert.equal(
      model.raster.totals().spikes,
      kept.reduce((sum, entry) => sum + entry.spikeNeurons.length, 0),
      'every neuromod spike in the window is on the raster',
    );
    assert.equal(
      model.raster.totals().encodedSpikes,
      kept.reduce((sum, entry) => sum + entry.encodedSpikeCount, 0),
      'the encoder lane is the runtime count per step',
    );
    for (const entry of kept) {
      for (let neuron = 0; neuron < 16; neuron += 1) {
        assert.equal(model.raster.spiked(entry.completedStep, neuron), entry.spikeNeurons.includes(neuron));
      }
    }
    assert.deepEqual(model.nodeIds, Array.from(state.topologyNodeIds), 'the inspector lists the stable upstream NeuronIds');
    assert.equal(model.selectedNeuron, 0);
    assert.ok(Object.is(model.neuron.membranePotential, state.membranePotentials[0]));

    controller.select(5);
    assert.equal(renders.at(-1).neuron.neuron, 5, 'a selection renders immediately');
    assert.ok(Object.is(renders.at(-1).neuron.membranePotential, state.membranePotentials[5]));
    const before = renders.at(-1).neuron.membranePotential;
    let changed = false;
    for (let tick = 0; tick < 40 && !changed; tick += 1) {
      rig.step();
      clock.advance(250);
      changed = !Object.is(renders.at(-1).neuron.membranePotential, before);
    }
    assert.ok(changed, 'the inspected potential follows the simulation');
    assert.equal(rig.errors.length, 0);

    panel.setOpen(false);
    const flushes = controller.inspect().flushes;
    const rendered = renders.length;
    for (let tick = 0; tick < 40; tick += 1) {
      rig.step();
      clock.advance(50);
    }
    assert.equal(renders.length, rendered, 'closing stops rendering');
    assert.equal(controller.inspect().flushes, flushes);
    assert.equal(controller.inspect().samples > 0, true);
    assert.equal(controller.inspect().rasterRows, 0, 'closing drops the sampled window');
  } finally {
    controller.dispose();
    rig.dispose();
  }
});

// ---------------------------------------------------------------------------
// Static contract of the panel
// ---------------------------------------------------------------------------

test('the telemetry panel is collapsible, closed by default, and static-first', () => {
  const component = readSource('../src/components/DemoTelemetry.astro');
  const island = readSource('../src/components/NeuromorphicDemo.astro');
  const enhance = readSource('../src/runtime/enhance-demo.ts');
  const styles = readSource('../src/styles/telemetry.css');

  assert.match(island, /<DemoTelemetry \/>/);
  assert.match(component, /<details class="demo-telemetry" data-demo-telemetry/);
  assert.doesNotMatch(component, /<details[^>]*\bopen\b/, 'closed by default');
  assert.match(component, /TELEMETRY_STATIC_STATUS/);
  assert.match(telemetry.TELEMETRY_STATIC_STATUS, /live Rust\/WASM runtime/);
  assert.match(component, /const origin = 'unavailable-wasm'/, 'nothing is labeled live before live data exists');
  assert.doesNotMatch(component, /LIVE · Rust\/WASM|origin="live-wasm"/);
  assert.match(component, /data-telemetry-live hidden/);
  for (const layer of ['kinetic-signals', 'axon-encoder', 'neuromod', 'synaptic-wiring']) {
    assert.match(component, new RegExp(`demo-telemetry-layer">${layer}<`), `${layer} is named`);
  }
  assert.match(component, /does not export a firing threshold/);
  assert.match(component, /role="img"/);
  assert.match(component, /<legend>/);
  assert.match(component, /import '\.\.\/styles\/telemetry\.css'/);
  assert.match(enhance, /const telemetry = bindDemoTelemetryPanel\(root\)/);
  assert.match(enhance, /telemetry\?\.dispose\(\)/);
  assert.match(styles, /\.demo-telemetry-table-scroll \{[^}]*overflow-x: auto/);
  assert.match(styles, /\.demo-telemetry-chip input:focus-visible \+ span/);
  assert.doesNotMatch(styles, /min-width:\s*\d{3,}px/);
  assert.doesNotMatch(styles, /transition|animation/, 'no decorative motion in the panel');

  assert.equal(typeof view.bindDemoTelemetry, 'function');
  assert.equal(view.bindDemoTelemetry({ querySelector: () => null }), null, 'islands without the panel are left alone');
  assert.equal(entry.bindDemoTelemetryPanel({ querySelector: () => null }), null);
  assert.equal(entry.getDemoTelemetry({}), null);
});

test('the panel code loads only when a reader opens the panel', async () => {
  // The always-loaded island script reaches telemetry only through the small
  // entry module; the raster, inspector, and view are a lazy chunk.
  const enhance = readSource('../src/runtime/enhance-demo.ts');
  const liveSeams = readSource('../src/runtime/live-seams.ts');
  const entrySource = readSource('../src/runtime/telemetry-entry.ts');
  assert.doesNotMatch(`${enhance}\n${liveSeams}`, /from '\.\/(demo-telemetry|telemetry-view)'/);
  assert.match(enhance, /from '\.\/telemetry-entry'/);
  assert.match(liveSeams, /from '\.\/telemetry-entry'/);
  assert.doesNotMatch(entrySource, /^import \{[^}]*\} from '\.\/(demo-telemetry|telemetry-view)'/m, 'only type imports from the lazy modules');
  assert.match(entrySource, /import\('\.\/telemetry-view'\)/);

  const listeners = new Set();
  const panel = {
    open: false,
    addEventListener(type, listener) {
      if (type === 'toggle') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'toggle') listeners.delete(listener);
    },
  };
  const binding = entry.bindDemoTelemetryPanel({
    querySelector: (selector) => (selector === 'details[data-demo-telemetry]' ? panel : null),
  });
  assert.ok(binding);
  assert.equal(listeners.size, 1, 'a closed panel costs one toggle listener');
  // Opening starts the lazy load. In Node the chunk cannot resolve from a
  // data: URL module; the failure is contained and the panel stays static.
  panel.open = true;
  for (const listener of [...listeners]) listener();
  await new Promise((resolve) => setTimeout(resolve, 10));
  binding.dispose();
  assert.equal(listeners.size, 0, 'dispose removes the listener');
  binding.dispose();
});
