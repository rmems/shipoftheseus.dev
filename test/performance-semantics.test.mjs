import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { setImmediate } from 'node:timers';
import { readFileSync } from 'node:fs';
import test, { mock } from 'node:test';

import { loadTsModule, readSource } from './load-ts-module.mjs';

const adapterModule = await loadTsModule('../src/runtime/neuromorphic-adapter.ts');
const channelModule = await loadTsModule('../src/runtime/simulation-channel.ts');
const quality = await loadTsModule('../src/runtime/adaptive-quality.ts');
const probes = await loadTsModule('../src/runtime/perf-probe.ts');
const spikes = await loadTsModule('../src/runtime/spike-events.ts');
const stimulus = await loadTsModule('../src/runtime/demo-stimulus.ts');
const telemetry = await loadTsModule('../src/runtime/kinetic-telemetry.ts');
const wasmSession = await loadTsModule('../src/runtime/wasm-session.ts');
const { replayTraceFixture } = await import('../scripts/replay-trace-fixture.mjs');

// The committed `web` package, initialized from bytes because Node cannot
// fetch file URLs (as in test/spike-events.test.mjs).
const wasmUrl = new URL('../public/wasm/neuromorphic-adapter/neuromorphic_adapter.js', import.meta.url);
const wasmBytes = readFileSync(new URL('../public/wasm/neuromorphic-adapter/neuromorphic_adapter_bg.wasm', import.meta.url));

function liveAdapter(encoderMode) {
  return adapterModule.initNeuromorphicAdapter(
    async () => {
      const generated = await import(wasmUrl.href);
      return {
        default: () => generated.default({ module_or_path: wasmBytes }),
        WasmAdapter: generated.WasmAdapter,
      };
    },
    stimulus.DEMO_SEED,
    { ...wasmSession.LIVE_ADAPTER_OPTIONS, encoderMode },
  );
}

/** Byte-exact serialization of every snapshot field. */
function serialize(state) {
  return Object.keys(state)
    .sort()
    .map((key) => {
      const value = state[key];
      return ArrayBuffer.isView(value)
        ? `${key}=${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex')}`
        : `${key}=${String(value)}`;
    })
    .join('|');
}

function serializeBatch(batch) {
  return `${batch.step}:${batch.spikeNeurons.join(',')}:${batch.events
    .map((event) => `${event.edgeIndex}@${event.arrivalStep}`)
    .join(',')}`;
}

function fakePointerTarget() {
  const listeners = new Map();
  return {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    emit(type, event = {}) {
      listeners.get(type)?.(event);
    },
  };
}

/** A deterministic drag: pressed sweeps between ticks 20 and 140, then leaves. */
function pointerScript(tick, target) {
  if (tick < 20 || tick > 140) {
    if (tick === 141) target.emit('pointerleave');
    return;
  }
  const phase = (tick % 25) / 25;
  const x = 400 * (phase < 0.5 ? phase * 2 : 2 - phase * 2);
  const y = 300 * (0.2 + 0.6 * ((tick % 17) / 17));
  target.emit(tick % 9 === 0 ? 'pointerdown' : 'pointermove', { clientX: x, clientY: y, pressure: tick % 40 < 30 ? 0.5 : 0 });
}

const TICKS = 200;

/**
 * Drive the shipped WASM seam (main-thread path) one fixed tick at a time with
 * mocked timers. `presentation`, when given, attaches everything adaptive
 * quality touches: a controller under synthetic frame pressure and forced
 * level changes, a renderer-style pulse reader honouring the pulse cap, a
 * telemetry consumer honouring the cadence, and an opt-in perf probe.
 */
async function runSession({ encoderMode, pointer, presentation }) {
  const channel = channelModule.createSimulationChannel();
  const snapshots = [];
  channel.subscribe((state) => snapshots.push(serialize(state)));
  const buffer = spikes.createSpikeEventBuffer({ provenance: spikes.LIVE_SPIKE_EVENT_PROVENANCE });
  const feed = spikes.feedSpikeEvents(channel, buffer, (error) => {
    throw error;
  });
  feed.setActive(true);
  const batches = [];
  buffer.subscribe((batch) => batches.push(serializeBatch(batch)));

  const target = fakePointerTarget();
  const stats = { levels: new Set(), sampledSteps: 0, drawnPulses: 0, bufferedPulses: 0 };
  const controller = presentation ? quality.createAdaptiveQuality() : null;
  if (controller) {
    stats.levels.add(controller.current().level);
    controller.subscribe((settings) => stats.levels.add(settings.level));
    buffer.subscribe(() => {
      let drawn = 0;
      buffer.forEach(() => {
        if (drawn < controller.current().maxPulses) drawn += 1;
      });
      stats.drawnPulses += drawn;
      stats.bufferedPulses += buffer.size();
    });
  }
  let lastFrame = null;
  const seam = wasmSession.createWasmSeam({
    channel,
    mainThreadAdapter: () => liveAdapter(encoderMode),
    telemetry: () => (pointer ? telemetry.createPointerTelemetry(target) : telemetry.createScriptedTelemetry()),
    probe: presentation ? probes.createPerfProbe() : null,
    onFrame(frame) {
      lastFrame = frame;
      if (controller && quality.shouldSampleTelemetry(frame.state.completedStep, controller.current().telemetryCadenceSteps)) {
        stats.sampledSteps += 1;
      }
    },
  });
  const session = await seam.init({
    useWorker: false,
    signal: new AbortController().signal,
    onWorkerFailure: () => assert.fail('no worker failure expected'),
  });
  session.resume();
  for (let tick = 1; tick <= TICKS; tick += 1) {
    if (pointer) pointerScript(tick, target);
    if (controller) {
      // Synthetic frame timings (inputs, not measurements): pressure then
      // relief, plus pinned levels, so quality moves through the ladder.
      if (tick % 50 === 25) controller.force((tick / 25) % 4);
      if (tick % 50 === 0) controller.force(null);
      for (let frame = 0; frame < 30; frame += 1) controller.recordFrame(tick % 80 < 40 ? 45 : 1000 / 60, 1);
    }
    mock.timers.tick(stimulus.DEMO_TICK_MS);
    await new Promise((resolve) => setImmediate(resolve));
  }
  session.dispose();
  feed.detach();
  return { snapshots, batches, stats, trace: lastFrame.trace() };
}

test('adaptive quality and the perf probe never change simulation output (same seed + inputs ⇒ same snapshots)', async (t) => {
  mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => mock.timers.reset());

  for (const encoderMode of ['delta', 'temporal', 'rate']) {
    for (const pointer of [false, true]) {
      const label = `${encoderMode}/${pointer ? 'pointer' : 'scripted'}`;
      const baseline = await runSession({ encoderMode, pointer, presentation: false });
      const adapted = await runSession({ encoderMode, pointer, presentation: true });

      assert.equal(baseline.snapshots.length, TICKS, `${label}: one snapshot per fixed tick`);
      assert.deepEqual(adapted.snapshots, baseline.snapshots, `${label}: snapshots are byte-identical`);
      assert.deepEqual(adapted.batches, baseline.batches, `${label}: spike propagation events are identical`);
      assert.deepEqual(adapted.trace, baseline.trace, `${label}: the recorded input trace is identical`);

      // The adapted run really did move through the ladder and shed work.
      assert.ok(adapted.stats.levels.size >= 3, `${label}: visited levels ${[...adapted.stats.levels]}`);
      assert.ok(adapted.stats.sampledSteps < TICKS, `${label}: telemetry cadence thinned sampling`);
      assert.ok(adapted.stats.sampledSteps > 0);
      if (adapted.stats.bufferedPulses > 0) {
        assert.ok(adapted.stats.drawnPulses < adapted.stats.bufferedPulses, `${label}: the pulse cap drew fewer pulses`);
      }
      if (pointer) {
        assert.ok(
          baseline.trace.operations.some((operation) => operation.op === 'input' && operation.samples[2] === 0.5),
          `${label}: pointer packets reached the adapter`,
        );
      }

      // And the recording replays from init to the same snapshots.
      if (encoderMode === 'temporal') {
        const replayed = [];
        await replayTraceFixture(adapted.trace, async () => {
          const adapter = await liveAdapter(encoderMode);
          return {
            input: (sequence, samples) => adapter.input(sequence, samples),
            step: () => {
              const state = adapter.step();
              replayed.push(serialize(state));
              return { error_status: state.errorStatus };
            },
          };
        });
        assert.deepEqual(replayed, baseline.snapshots, `${label}: replay reproduces the session`);
      }
    }
  }
});

test('quality is wired only into presentation, never into the simulation path', () => {
  for (const file of [
    'wasm-session.ts',
    'neuromorphic-worker.ts',
    'neuromorphic-adapter.ts',
    'kinetic-telemetry.ts',
    'demo-stimulus.ts',
    'spike-events.ts',
    'simulation-channel.ts',
  ]) {
    assert.doesNotMatch(readSource(`../src/runtime/${file}`), /adaptive-quality/, `${file} must not read quality`);
  }
  const seams = readSource('../src/runtime/live-seams.ts');
  const wasmSeamCall = seams.slice(seams.indexOf('wasm: createWasmSeam('));
  assert.doesNotMatch(wasmSeamCall.slice(0, wasmSeamCall.indexOf('}),')), /quality/);
  assert.match(seams, /createTopologyRendererSeam\(\{[\s\S]*quality,[\s\S]*\}\)/);
  // The simulation cadence stays fixed.
  assert.match(readSource('../src/runtime/wasm-session.ts'), /setInterval\(\(\) => \{\s*void tick\(\);\s*\}, DEMO_TICK_MS\)/);
});

test('live seams mirror the quality level and telemetry cadence onto the island', () => {
  const liveSeams = loadTsModule('../src/runtime/live-seams.ts');
  return liveSeams.then((module) => {
    const surface = {};
    const island = {
      dataset: {},
      querySelector: (selector) => (selector === '[data-demo-surface]' ? surface : null),
    };
    const controller = quality.createAdaptiveQuality();
    const seams = module.createLiveDemoSeams(island, { quality: controller, probe: null });
    assert.equal(island.dataset.demoQuality, 'full');
    assert.equal(island.dataset.demoTelemetryCadenceMs, '50');
    assert.equal(seams.renderer.quality.current().name, 'full');
    controller.force(2);
    assert.equal(island.dataset.demoQuality, 'reduced');
    assert.equal(island.dataset.demoTelemetryCadenceMs, '200');
    assert.equal(seams.renderer.quality.current().telemetryCadenceSteps, 4);
    assert.equal(typeof seams.renderer.quality.subscribe, 'function');
    assert.equal('recordFrame' in seams.renderer.quality, true, 'the renderer seam owns the controller');
  });
});

// ---------------------------------------------------------------------------
// The bridge transfer path (WASM → JS) stays bounded and fail-closed.
// ---------------------------------------------------------------------------

test('the bridge releases every WASM state handle and keeps WASM memory flat', async () => {
  const generated = await import(wasmUrl.href);
  const exports = await generated.default({ module_or_path: wasmBytes });
  let freed = 0;
  let created = 0;
  const adapter = await adapterModule.initNeuromorphicAdapter(
    async () => ({
      default: async () => {},
      WasmAdapter: {
        init(seed, config) {
          const raw = generated.WasmAdapter.init(seed, config);
          const track = (state) => {
            created += 1;
            const free = state.free.bind(state);
            state.free = () => {
              freed += 1;
              free();
            };
            return state;
          };
          return {
            input: (sequence, samples) => raw.input(sequence, samples),
            step: () => track(raw.step()),
            state: () => track(raw.state()),
            dispose: () => raw.dispose(),
          };
        },
      },
    }),
    stimulus.DEMO_SEED,
    wasmSession.LIVE_ADAPTER_OPTIONS,
  );
  // Warm up, then record linear memory: a leaked handle per step would grow it.
  for (let sequence = 1n; sequence <= 200n; sequence += 1n) {
    adapter.input(sequence, stimulus.scriptedTelemetry(sequence));
    adapter.step();
  }
  const before = exports.memory.buffer.byteLength;
  for (let sequence = 201n; sequence <= 5200n; sequence += 1n) {
    adapter.input(sequence, stimulus.scriptedTelemetry(sequence));
    adapter.step();
  }
  adapter.state();
  adapter.dispose();
  assert.equal(freed, created, 'every handle is freed exactly once');
  assert.equal(created, 5201);
  assert.equal(exports.memory.buffer.byteLength, before, 'WASM linear memory does not grow with steps');
});

test('the routed-topology check is cached by value and still rejects any change', async () => {
  let current = null;
  const adapter = await adapterModule.initNeuromorphicAdapter(
    async () => {
      const generated = await import(wasmUrl.href);
      return {
        default: () => generated.default({ module_or_path: wasmBytes }),
        WasmAdapter: {
          init(seed, config) {
            const raw = generated.WasmAdapter.init(seed, config);
            return {
              input: (sequence, samples) => raw.input(sequence, samples),
              step: () => current(raw.step()),
              state: () => current(raw.state()),
              dispose: () => raw.dispose(),
            };
          },
        },
      };
    },
    stimulus.DEMO_SEED,
    wasmSession.LIVE_ADAPTER_OPTIONS,
  );
  const fields = (handle) => {
    const copy = {};
    for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(handle))) {
      if (key !== 'constructor' && key !== 'free' && !key.startsWith('__')) copy[key] = handle[key];
    }
    handle.free();
    return copy;
  };

  current = (handle) => fields(handle);
  adapter.input(1n, stimulus.scriptedTelemetry(1n));
  const valid = adapter.step();
  assert.equal(valid.completedStep, 1n, 'a genuine snapshot passes (and primes the cache)');

  // Reordering targets inside one source row keeps the routed multiset: valid.
  current = (handle) => {
    const state = fields(handle);
    const targets = new Uint32Array(state.topology_targets);
    const weights = new Float32Array(state.topology_weights);
    const delays = new Uint16Array(state.topology_delays);
    for (const array of [targets, weights, delays]) {
      [array[0], array[1]] = [array[1], array[0]];
    }
    return { ...state, topology_targets: targets, topology_weights: weights, topology_delays: delays };
  };
  assert.equal(adapter.state().completedStep, 1n);

  // Retargeting one routed edge changes the multiset: rejected despite the cache.
  current = (handle) => {
    const state = fields(handle);
    const targets = new Uint32Array(state.topology_targets);
    targets[0] = (targets[0] + 1) % 16;
    return { ...state, topology_targets: targets };
  };
  assert.throws(() => adapter.state(), adapterModule.AdapterUnavailableError);

  current = (handle) => fields(handle);
  assert.equal(adapter.state().completedStep, 1n, 'the genuine topology still passes afterwards');
  adapter.dispose();
});
