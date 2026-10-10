import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { loadTsModule, readSource } from './load-ts-module.mjs';

// Adaptive quality (GitHub #10) may only LOWER the live telemetry panel's
// (GitHub #9) refresh rate: never above the panel's own cadence (4 Hz by
// default, 1 Hz under reduced motion). The panel picks up the cap when it is
// first opened and follows every quality change.
const quality = await loadTsModule('../src/runtime/adaptive-quality.ts');
const telemetry = await loadTsModule('../src/runtime/demo-telemetry.ts');
const entry = await loadTsModule('../src/runtime/telemetry-entry.ts');
const liveSeams = await loadTsModule('../src/runtime/live-seams.ts');
const renderer = await loadTsModule('../src/runtime/topology-renderer.ts');
const adapterModule = await loadTsModule('../src/runtime/neuromorphic-adapter.ts');
const channelModule = await loadTsModule('../src/runtime/simulation-channel.ts');
const spikes = await loadTsModule('../src/runtime/spike-events.ts');
const stimulus = await loadTsModule('../src/runtime/demo-stimulus.ts');
const wasmSession = await loadTsModule('../src/runtime/wasm-session.ts');

const wasmUrl = new URL('../public/wasm/neuromorphic-adapter/neuromorphic_adapter.js', import.meta.url);
const wasmBytes = readFileSync(new URL('../public/wasm/neuromorphic-adapter/neuromorphic_adapter_bg.wasm', import.meta.url));

/** The committed `web` package through the shipped bridge, stepped by hand. */
async function liveRig() {
  const adapter = await adapterModule.initNeuromorphicAdapter(
    async () => {
      const generated = await import(wasmUrl.href);
      return { default: () => generated.default({ module_or_path: wasmBytes }), WasmAdapter: generated.WasmAdapter };
    },
    stimulus.DEMO_SEED,
    wasmSession.LIVE_ADAPTER_OPTIONS,
  );
  const channel = channelModule.createSimulationChannel();
  const buffer = spikes.createSpikeEventBuffer({ provenance: spikes.LIVE_SPIKE_EVENT_PROVENANCE });
  const feed = spikes.feedSpikeEvents(channel, buffer, (error) => {
    throw error;
  });
  feed.setActive(true);
  let sequence = 0n;
  return {
    channel,
    buffer,
    step() {
      sequence += 1n;
      adapter.input(sequence, stimulus.scriptedTelemetry(sequence));
      channel.publish(adapter.step());
    },
    dispose() {
      feed.detach();
      adapter.dispose();
    },
  };
}

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

function fakePanel({ open = true, reducedMotion = false } = {}) {
  const toggles = new Set();
  const motion = new Set();
  const panel = {
    open,
    reducedMotion,
    port: {
      isOpen: () => panel.open,
      onToggle(listener) {
        toggles.add(listener);
        return () => toggles.delete(listener);
      },
      demoMode: () => 'live',
      onDemoModeChange: () => () => {},
      prefersReducedMotion: () => panel.reducedMotion,
      onReducedMotionChange(listener) {
        motion.add(listener);
        return () => motion.delete(listener);
      },
    },
    setReducedMotion(value) {
      panel.reducedMotion = value;
      for (const listener of [...motion]) listener();
    },
  };
  return panel;
}

/** A live-wasm-shaped source with no data; cadence is all that is under test. */
function emptySources() {
  return {
    spikeEvents: { provenance: 'live-wasm', subscribe: () => () => {}, stats: () => ({ size: 0, emitted: 0, evicted: 0 }) },
    channel: { latest: () => null },
    inputSource: () => null,
  };
}

function panelController(options = {}) {
  const panel = fakePanel(options);
  const controller = telemetry.createTelemetryController({
    sources: emptySources(),
    panel: panel.port,
    render() {},
    clock: fakeClock(),
  });
  return { panel, controller };
}

function fakeIsland() {
  return { dataset: {}, querySelector: () => null };
}

test('a capped pulse budget draws the most recently emitted pulses', () => {
  // Buffers iterate oldest first; skipping the oldest keeps recent spikes.
  assert.equal(renderer.oldestPulsesToSkip(300, 96), 204);
  assert.equal(renderer.oldestPulsesToSkip(50, 96), 0, 'under the cap nothing is skipped');
  assert.equal(renderer.oldestPulsesToSkip(40, 0), 40, 'pulses off skips every pulse');
  const source = readSource('../src/runtime/topology-renderer.ts');
  assert.match(source, /skipOldest = oldestPulsesToSkip\(spikeEvents\.size\(\), pulseLimit\)/);
});

test('the quality ladder maps to telemetry ceilings of 20, 10, 2, and 1 Hz', () => {
  assert.deepEqual(quality.QUALITY_LADDER.map((settings) => quality.telemetryCadenceHz(settings)), [20, 10, 2, 1]);
  assert.equal(telemetry.MAX_TELEMETRY_HZ, 20, 'the panel never refreshes faster than one simulation step');
});

test('a cadence cap only lowers the panel rate, alongside its own cadence and reduced motion', () => {
  const { panel, controller } = panelController();
  assert.equal(controller.effectiveCadenceHz(), telemetry.DEFAULT_TELEMETRY_HZ);
  controller.setCadenceCapHz(20);
  assert.equal(controller.effectiveCadenceHz(), 4, 'a higher ceiling never raises the panel above 4 Hz');
  controller.setCadenceCapHz(2);
  assert.equal(controller.effectiveCadenceHz(), 2);
  assert.equal(controller.cadenceHz(), 4, 'the panel keeps its own requested cadence');
  assert.equal(controller.inspect().cadenceCapHz, 2);
  panel.setReducedMotion(true);
  assert.equal(controller.effectiveCadenceHz(), 1, 'reduced motion still wins below the cap');
  panel.setReducedMotion(false);
  controller.setCadenceCapHz(null);
  assert.equal(controller.effectiveCadenceHz(), 4, 'removing the cap restores the panel cadence');
  assert.throws(() => controller.setCadenceCapHz(0), RangeError);
  controller.dispose();
});

test('the capped cadence governs real flushes of live WASM steps', async () => {
  const rig = await liveRig();
  const clock = fakeClock();
  const panel = fakePanel();
  const renders = [];
  const controller = telemetry.createTelemetryController({
    sources: {
      spikeEvents: rig.buffer,
      channel: rig.channel,
      inputSource: () => null,
    },
    panel: panel.port,
    render: (model) => renders.push(model),
    clock,
  });
  try {
    renders.length = 0;
    for (let tick = 0; tick < 40; tick += 1) {
      rig.step();
      clock.advance(50);
    }
    assert.equal(renders.length, 8, 'two seconds at the panel cadence of 4 Hz');
    controller.setCadenceCapHz(quality.telemetryCadenceHz(quality.QUALITY_LADDER[3]));
    renders.length = 0;
    for (let tick = 0; tick < 40; tick += 1) {
      rig.step();
      clock.advance(50);
    }
    assert.equal(renders.length, 2, 'two seconds at the minimal level ceiling of 1 Hz');
    assert.equal(controller.inspect().samples, 80, 'every step is still sampled; only redraws slow down');
  } finally {
    controller.dispose();
    rig.dispose();
  }
});

test('the panel picks up the quality cap when first opened and follows every level change', () => {
  const island = fakeIsland();
  const adaptive = quality.createAdaptiveQuality();
  liveSeams.createLiveDemoSeams(island, { quality: adaptive, probe: null });
  assert.equal(entry.getDemoTelemetry(island), null, 'no controller (and no cost) before the panel opens');

  // Quality drops before the reader ever opens the panel.
  adaptive.force(2);
  const { panel, controller } = panelController();
  const unregister = entry.registerDemoTelemetry(island, controller);
  assert.equal(controller.effectiveCadenceHz(), 2, 'first open applies the current cap (reduced: 2 Hz)');

  adaptive.force(3);
  assert.equal(controller.effectiveCadenceHz(), 1, 'minimal: 1 Hz');
  adaptive.force(1);
  assert.equal(controller.effectiveCadenceHz(), 4, 'balanced (10 Hz ceiling) leaves the panel at its own 4 Hz');
  adaptive.force(0);
  assert.equal(controller.effectiveCadenceHz(), 4, 'full (20 Hz ceiling) never raises it');
  assert.equal(controller.cadenceHz(), 4);

  panel.setReducedMotion(true);
  for (const level of [0, 1, 2, 3]) {
    adaptive.force(level);
    assert.equal(controller.effectiveCadenceHz(), 1, `reduced motion keeps 1 Hz at level ${level}`);
  }
  panel.setReducedMotion(false);

  // Closing for good (dispose) stops following quality.
  unregister();
  adaptive.force(3);
  assert.equal(controller.cadenceCapHz(), 1, 'the last applied cap stays');
  adaptive.force(0);
  assert.equal(controller.cadenceCapHz(), 1, 'an unregistered controller no longer follows quality');
  controller.dispose();
});

test('registration order does not matter, and the panel stays a read-only consumer', () => {
  const island = fakeIsland();
  const { controller } = panelController();
  const unregister = entry.registerDemoTelemetry(island, controller);
  assert.equal(controller.cadenceCapHz(), null, 'no cap until the live seams register one');
  const adaptive = quality.createAdaptiveQuality({ initialLevel: 3 });
  liveSeams.createLiveDemoSeams(island, { quality: adaptive, probe: null });
  assert.equal(controller.effectiveCadenceHz(), 1, 'a cap registered after the panel applies at once');
  unregister();
  controller.dispose();

  // Quality reaches telemetry only through the entry registry; the lazy panel
  // modules never import the quality controller, and the simulation path
  // never imports either.
  const seams = readSource('../src/runtime/live-seams.ts');
  assert.match(seams, /registerTelemetryCadenceCap\(island, \{/);
  assert.doesNotMatch(seams, /from '\.\/(demo-telemetry|telemetry-view)'/);
  for (const file of ['demo-telemetry.ts', 'telemetry-view.ts', 'telemetry-entry.ts']) {
    assert.doesNotMatch(readSource(`../src/runtime/${file}`), /adaptive-quality/);
  }
});
