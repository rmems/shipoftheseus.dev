import assert from 'node:assert/strict';
import test from 'node:test';

import { loadTsModule, readSource } from './load-ts-module.mjs';

const quality = await loadTsModule('../src/runtime/adaptive-quality.ts');
const probes = await loadTsModule('../src/runtime/perf-probe.ts');
const stimulus = await loadTsModule('../src/runtime/demo-stimulus.ts');

// Synthetic frame timings for the pure controller. These are inputs to the
// state machine under test, not measurements.
const SMOOTH = 1000 / 60;
const JANKY = 40;

/**
 * Feed identical frames until the controller has judged `windows` more
 * windows (a level change also closes the open window); return level changes.
 */
function feed(controller, windows, intervalMs, workMs = 1) {
  const changes = [];
  for (let window = 0; window < windows; window += 1) {
    const judged = controller.stats().windows;
    for (let frame = 0; frame < 10_000 && controller.stats().windows === judged; frame += 1) {
      if (controller.recordFrame(intervalMs, workMs)) {
        changes.push(controller.current().level);
      }
    }
  }
  return changes;
}

test('the quality ladder only sheds presentation work, monotonically', () => {
  const ladder = quality.QUALITY_LADDER;
  assert.deepEqual(ladder.map((settings) => settings.name), ['full', 'balanced', 'reduced', 'minimal']);
  assert.deepEqual(ladder.map((settings) => settings.level), [0, 1, 2, 3]);
  for (let index = 1; index < ladder.length; index += 1) {
    assert.ok(ladder[index].maxPixelRatio <= ladder[index - 1].maxPixelRatio);
    assert.ok(ladder[index].maxPulses <= ladder[index - 1].maxPulses);
    assert.ok(ladder[index].minFrameIntervalMs >= ladder[index - 1].minFrameIntervalMs);
    assert.ok(ladder[index].telemetryCadenceSteps >= ladder[index - 1].telemetryCadenceSteps);
  }
  // Full quality keeps the renderer's previous behaviour: DPR capped at 2,
  // every buffered pulse drawn, every animation frame drawn.
  assert.equal(ladder[0].maxPixelRatio, 2);
  assert.equal(ladder[0].maxPulses, Number.POSITIVE_INFINITY);
  assert.equal(ladder[0].minFrameIntervalMs, 0);
  assert.equal(ladder[0].telemetryCadenceSteps, 1);
  assert.equal(ladder.at(-1).maxPulses, 0, 'the lowest level turns pulses off');
  assert.ok(Object.isFrozen(ladder) && ladder.every(Object.isFrozen));
  // No setting is a simulation parameter.
  for (const settings of ladder) {
    assert.deepEqual(Object.keys(settings).sort(), [
      'level', 'maxPixelRatio', 'maxPulses', 'minFrameIntervalMs', 'name', 'telemetryCadenceSteps',
    ]);
  }
});

test('sustained frame-time pressure steps down one level per two pressured windows', () => {
  const controller = quality.createAdaptiveQuality();
  assert.equal(controller.current().name, 'full');
  assert.deepEqual(feed(controller, 1, JANKY), [], 'one pressured window is not sustained');
  assert.deepEqual(feed(controller, 1, JANKY), [1]);
  assert.deepEqual(feed(controller, 4, JANKY), [2, 3]);
  assert.deepEqual(feed(controller, 6, JANKY), [], 'never below the lowest level');
  assert.equal(controller.current().name, 'minimal');
  assert.equal(controller.stats().downshifts, 3);
});

test('isolated slow windows between smooth ones never change quality', () => {
  const controller = quality.createAdaptiveQuality();
  for (let round = 0; round < 10; round += 1) {
    assert.deepEqual(feed(controller, 1, JANKY), []);
    assert.deepEqual(feed(controller, 1, SMOOTH), []);
  }
  assert.equal(controller.current().level, 0);
});

test('recovery needs a longer relieved streak than degradation (hysteresis)', () => {
  const controller = quality.createAdaptiveQuality();
  feed(controller, 2, JANKY);
  assert.equal(controller.current().level, 1);
  assert.deepEqual(feed(controller, 4, SMOOTH), [], 'four relieved windows are not enough');
  assert.deepEqual(feed(controller, 1, SMOOTH), [0], 'the fifth steps back up');

  // Between the thresholds (≈50 fps) is steady: no change either way.
  const steady = quality.createAdaptiveQuality({ initialLevel: 2 });
  assert.deepEqual(feed(steady, 20, 20), []);
  assert.equal(steady.current().level, 2);
  assert.equal(steady.stats().lastWindow.verdict, 'steady');
});

test('falling back soon after recovering doubles the next recovery wait', () => {
  const controller = quality.createAdaptiveQuality();
  feed(controller, 2, JANKY);
  feed(controller, 5, SMOOTH);
  assert.equal(controller.current().level, 0);
  assert.equal(controller.stats().upshiftWindowsRequired, 5);
  feed(controller, 2, JANKY);
  assert.equal(controller.current().level, 1);
  assert.equal(controller.stats().upshiftWindowsRequired, 10, 'flapping backs off');
  assert.deepEqual(feed(controller, 9, SMOOTH), []);
  assert.deepEqual(feed(controller, 1, SMOOTH), [0]);

  for (let round = 0; round < 10; round += 1) {
    feed(controller, 2, JANKY);
    feed(controller, controller.stats().upshiftWindowsRequired, SMOOTH);
  }
  assert.equal(controller.stats().upshiftWindowsRequired, quality.MAX_UPSHIFT_WINDOWS);
});

test('main-thread draw time over budget is pressure even at a smooth frame rate', () => {
  const controller = quality.createAdaptiveQuality();
  assert.deepEqual(feed(controller, 2, SMOOTH, quality.DEFAULT_FRAME_WORK_BUDGET_MS + 1), [1]);
  // Skipped frames (work 0) do not dilute the per-drawn-frame mean.
  const capped = quality.createAdaptiveQuality();
  const changes = [];
  for (let frame = 0; frame < 240; frame += 1) {
    if (capped.recordFrame(SMOOTH, frame % 4 === 0 ? 10 : 0)) changes.push(capped.current().level);
  }
  assert.deepEqual(changes, [1]);
  assert.equal(capped.stats().lastWindow.drawnFrames > 0, true);
});

test('draws the clock times at 0 ms still count toward the mean draw time', () => {
  // With a 0.1 ms clock, cheap frames often read as 0. Counting only the
  // non-zero ones would inflate the mean and could block recovery.
  const explicit = quality.createAdaptiveQuality({ initialLevel: 1 });
  const inferred = quality.createAdaptiveQuality({ initialLevel: 1 });
  for (let frame = 0; frame < 120; frame += 1) {
    const work = frame % 2 === 0 ? 0 : 5;
    explicit.recordFrame(12.5, work, true);
    inferred.recordFrame(12.5, work);
  }
  assert.equal(explicit.stats().lastWindow.drawnFrames, explicit.stats().lastWindow.frames, 'every drawn frame counts');
  assert.equal(explicit.stats().lastWindow.meanWorkMs, 2.5);
  assert.equal(explicit.stats().lastWindow.verdict, 'relief', 'a true 2.5 ms mean is under half the budget');
  assert.equal(inferred.stats().lastWindow.meanWorkMs, 5, 'without the flag zero-time draws drop out');
  assert.equal(inferred.stats().lastWindow.verdict, 'steady');

  const skipped = quality.createAdaptiveQuality();
  for (let frame = 0; frame < 120; frame += 1) skipped.recordFrame(12.5, 0, frame % 3 === 0);
  assert.equal(skipped.stats().lastWindow.frames, 80);
  assert.equal(skipped.stats().lastWindow.drawnFrames, 27, 'frames skipped by the frame cap are not draws');
});

test('stalls, resumes, and non-frames reset the window instead of counting', () => {
  const controller = quality.createAdaptiveQuality();
  for (let index = 0; index < 50; index += 1) {
    assert.equal(controller.recordFrame(JANKY, 1), false);
    // A background-tab gap or a resume after pause is not a slow frame.
    controller.recordFrame(5_000, 0);
    controller.recordFrame(0, 0);
    controller.recordFrame(Number.NaN, 0);
  }
  assert.equal(controller.stats().windows, 0);
  assert.equal(controller.current().level, 0);

  feed(controller, 1, JANKY);
  controller.resetWindow();
  feed(controller, 1, JANKY);
  assert.equal(controller.current().level, 1, 'resetWindow drops only the open window');
});

test('levels stay within the configured range and options are validated', () => {
  const capped = quality.createAdaptiveQuality({ maxLevel: 1 });
  feed(capped, 10, JANKY);
  assert.equal(capped.current().level, 1);
  assert.throws(() => quality.createAdaptiveQuality({ maxLevel: 4 }), RangeError);
  assert.throws(() => quality.createAdaptiveQuality({ initialLevel: 2, maxLevel: 1 }), RangeError);
  assert.throws(() => quality.createAdaptiveQuality({ reliefIntervalMs: 30, pressureIntervalMs: 20 }), RangeError);
  assert.throws(() => quality.createAdaptiveQuality({ downshiftWindows: 0 }), RangeError);
  assert.throws(() => quality.createAdaptiveQuality({ windowMs: -1 }), RangeError);
});

test('force pins a level for measurement and resumes adapting on null', () => {
  const controller = quality.createAdaptiveQuality();
  const seen = [];
  const unsubscribe = controller.subscribe((settings) => seen.push(settings.name));
  controller.force(3);
  assert.equal(controller.current().name, 'minimal');
  feed(controller, 10, SMOOTH);
  assert.equal(controller.current().name, 'minimal', 'a pinned level ignores relief');
  assert.equal(controller.stats().pinned, 3);
  controller.force(null);
  assert.equal(controller.current().name, 'full');
  assert.throws(() => controller.force(7), RangeError);
  unsubscribe();
  controller.force(2);
  assert.deepEqual(seen, ['minimal', 'full']);
});

test('telemetry cadence is keyed to simulation steps, never to frames', () => {
  const cadence = quality.QUALITY_LADDER.map((settings) => quality.telemetryCadenceMs(settings));
  assert.deepEqual(cadence, [50, 100, 500, 1000]);
  assert.equal(quality.telemetryCadenceMs({ telemetryCadenceSteps: 1 }), stimulus.DEMO_TICK_MS);
  const sampled = [];
  for (let step = 1n; step <= 20n; step += 1n) {
    if (quality.shouldSampleTelemetry(step, 4)) sampled.push(step);
  }
  assert.deepEqual(sampled, [4n, 8n, 12n, 16n, 20n]);
  assert.equal(quality.shouldSampleTelemetry(7n, 1), true);
  assert.throws(() => quality.shouldSampleTelemetry(1n, 0), RangeError);
  assert.throws(() => quality.shouldSampleTelemetry(1n, 1.5), RangeError);
});

test('the pixel-ratio cap applies the level and tolerates bad device values', () => {
  const [full, balanced, reduced] = quality.QUALITY_LADDER;
  assert.equal(quality.cappedPixelRatio(3, full), 2);
  assert.equal(quality.cappedPixelRatio(1.25, full), 1.25);
  assert.equal(quality.cappedPixelRatio(3, balanced), 1.5);
  assert.equal(quality.cappedPixelRatio(2, reduced), 1);
  assert.equal(quality.cappedPixelRatio(Number.NaN, full), 1);
  assert.equal(quality.cappedPixelRatio(0, full), 1);
});

test('device-pixel-ratio watching keeps exactly one media-query listener', () => {
  const live = new Set();
  const queries = [];
  const host = {
    devicePixelRatio: 1,
    matchMedia(query) {
      const entry = {
        query,
        listeners: new Set(),
        addEventListener(type, listener) {
          entry.listeners.add(listener);
          live.add(entry);
        },
        removeEventListener(type, listener) {
          entry.listeners.delete(listener);
          if (entry.listeners.size === 0) live.delete(entry);
        },
      };
      queries.push(entry);
      return entry;
    },
  };
  let changes = 0;
  const stop = quality.watchDevicePixelRatio(host, () => {
    changes += 1;
  });
  assert.equal(live.size, 1);
  for (const ratio of [2, 1.5, 1, 2, 3]) {
    host.devicePixelRatio = ratio;
    const [current] = [...live];
    for (const listener of [...current.listeners]) listener();
    assert.equal(live.size, 1, 'the previous query listener is removed before the next is added');
  }
  assert.equal(changes, 5);
  assert.equal(queries.at(-1).query, '(resolution: 3dppx)');
  stop();
  assert.equal(live.size, 0, 'stopping removes the last listener');
  assert.doesNotThrow(() => quality.watchDevicePixelRatio({}, () => {})());
});

test('the perf probe keeps a bounded window per stage and reports percentiles', () => {
  let clock = 0;
  const probe = probes.createPerfProbe({ windowSize: 4, now: () => (clock += 0.5) });
  for (const ms of [1, 2, 3, 4, 100]) probe.record('tick', ms);
  probe.record('tick', -1);
  probe.record('tick', Number.NaN);
  probe.increment('ticks');
  probe.increment('ticks', 2);
  probe.mark('first-frame');
  probe.mark('first-frame');
  const summary = probe.summary();
  assert.equal(summary.stages.tick.count, 5, 'invalid samples are ignored');
  assert.equal(summary.stages.tick.windowCount, 4, 'the window never grows past its size');
  assert.equal(summary.stages.tick.maxMs, 100);
  assert.equal(summary.stages.tick.meanMs, 22);
  assert.equal(summary.stages.tick.p50Ms, 3);
  assert.equal(summary.stages.tick.p99Ms, 100);
  assert.equal(summary.counters.ticks, 3);
  assert.equal(Object.keys(summary.marks).length, 1);
  assert.ok(summary.timerResolutionMs > 0);
  probe.reset();
  assert.deepEqual(probe.summary().stages, {});
  assert.equal(Object.keys(probe.summary().marks).length, 1, 'marks survive reset');
  assert.throws(() => probes.createPerfProbe({ windowSize: 0 }), RangeError);

  assert.equal(probes.timed(null, 'tick', () => 7), 7);
  assert.equal(probes.timed(probe, 'publish', () => 8), 8);
  assert.equal(probe.summary().stages.publish.count, 1);
});

test('the probe is opt-in: only ?neuromorphic-perf or astro dev installs it', () => {
  assert.equal(probes.perfProbeRequested({ location: { search: '?neuromorphic-perf' } }), true);
  assert.equal(probes.perfProbeRequested({ location: { search: '?a=1&neuromorphic-perf=1' } }), true);
  assert.equal(probes.perfProbeRequested({ location: { search: '?other' } }), false);
  assert.equal(probes.perfProbeRequested({ location: { search: '' } }), false);
  assert.equal(probes.perfProbeRequested({}), false);

  const seams = readSource('../src/runtime/live-seams.ts');
  assert.match(seams, /import\.meta\.env\?\.DEV \|\| perfProbeRequested\(\)/);
  // Without a probe every instrumented site is a null check.
  for (const file of ['../src/runtime/wasm-session.ts', '../src/runtime/topology-renderer.ts']) {
    const source = readSource(file);
    assert.doesNotMatch(source, /createPerfProbe/, `${file} never creates a probe itself`);
  }
});
