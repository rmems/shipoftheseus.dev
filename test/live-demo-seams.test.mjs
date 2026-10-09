import assert from 'node:assert/strict';
import test from 'node:test';

import { loadTsModule } from './load-ts-module.mjs';

const stimulus = await loadTsModule('../src/runtime/demo-stimulus.ts');
const telemetry = await loadTsModule('../src/runtime/kinetic-telemetry.ts');
const { replayTraceFixture } = await import('../scripts/replay-trace-fixture.mjs');
const channelModule = await loadTsModule('../src/runtime/simulation-channel.ts');
const rendererModule = await loadTsModule('../src/runtime/topology-renderer.ts');
const wasmModule = await loadTsModule('../src/runtime/wasm-session.ts');
const liveSeams = await loadTsModule('../src/runtime/live-seams.ts');
const demoRuntime = await loadTsModule('../src/runtime/demo-runtime.ts');

function fakeState(overrides = {}) {
  return {
    contractVersion: 2,
    seed: 9n,
    completedStep: 1n,
    lastSequence: 1n,
    membranePotentials: new Float32Array(16),
    spikeNeurons: new Uint32Array(0),
    topologyRows: new Uint32Array(17),
    topologyTargets: new Uint32Array(64),
    topologyWeights: new Float32Array(64),
    topologyDelays: new Uint16Array(64),
    topologyNodeIds: new Uint32Array([...Array(16).keys()]),
    topologyEdgeSources: new Uint32Array(64),
    topologyEdgeTargets: new Uint32Array(64),
    topologyEdgeWeights: new Float32Array(64),
    topologyEdgeDelays: new Uint16Array(64),
    topologyPolarities: new Uint8Array(64),
    topologyWeightBits: new Uint32Array(64),
    topologyOutgoingEdgeOffsets: new Uint32Array(17),
    topologyDigest: 'digest',
    protocolWireVersion: 1,
    errorStatus: 'ok',
    ...overrides,
  };
}

function fakeAdapter(state = fakeState()) {
  const calls = { input: 0, step: 0, dispose: 0 };
  return {
    calls,
    input(sequence, samples) {
      calls.input += 1;
      assert.equal(typeof sequence, 'bigint');
      assert.ok(samples instanceof Float32Array);
    },
    step() {
      calls.step += 1;
      return { ...state, completedStep: BigInt(calls.step), lastSequence: BigInt(calls.step) };
    },
    dispose() {
      calls.dispose += 1;
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('scripted telemetry is a deterministic [x, y, pressure] path inside the island', () => {
  assert.deepEqual(stimulus.scriptedTelemetry(7n), stimulus.scriptedTelemetry(7n));
  assert.notDeepEqual(stimulus.scriptedTelemetry(7n), stimulus.scriptedTelemetry(8n));
  const pressures = new Set();
  for (let sequence = 1n; sequence <= 240n; sequence += 1n) {
    const [x, y, pressure] = stimulus.scriptedTelemetry(sequence);
    assert.equal(stimulus.scriptedTelemetry(sequence).length, 3);
    assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1, `packet ${sequence} leaves the island`);
    pressures.add(pressure);
  }
  assert.deepEqual([...pressures].sort(), [0, 0.5], 'the script presses and releases');
});

function fakePointerTarget() {
  const listeners = new Map();
  return {
    listeners,
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 400, height: 200 }),
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    emit(type, event = {}) {
      listeners.get(type)?.(event);
    },
  };
}

test('pointer telemetry normalizes island-relative packets and falls back to the script when idle', () => {
  const target = fakePointerTarget();
  const source = telemetry.createPointerTelemetry(target);

  assert.deepEqual(source.sample(1n), stimulus.scriptedTelemetry(1n), 'no pointer yet');
  assert.equal(source.kind(), 'scripted');

  // Raw coordinates outside the island pass through; Rust owns clamping.
  target.emit('pointermove', { clientX: 300, clientY: 100, pressure: 0 });
  assert.deepEqual([...source.sample(2n)], [0.5, 0.25, 0]);
  target.emit('pointerdown', { clientX: 700, clientY: 0, pressure: 0.5 });
  assert.deepEqual([...source.sample(3n)], [1.5, -0.25, 0.5]);
  assert.equal(source.kind(), 'pointer');

  // A held, motionless pointer keeps its last packet until the idle window ends.
  const idle = telemetry.POINTER_IDLE_TICKS;
  assert.deepEqual([...source.sample(3n + idle - 1n)], [1.5, -0.25, 0.5]);
  assert.deepEqual(source.sample(3n + idle), stimulus.scriptedTelemetry(3n + idle));
  assert.equal(source.kind(), 'scripted');

  target.emit('pointermove', { clientX: 200, clientY: 150, pressure: 0 });
  assert.equal(source.sample(100n)[0], 0.25);
  target.emit('pointerleave');
  assert.deepEqual(source.sample(101n), stimulus.scriptedTelemetry(101n), 'leaving resumes the script');

  source.dispose();
  assert.equal(target.listeners.size, 0, 'dispose removes every pointer listener');
});

test('a tap that leaves between ticks still reaches exactly one tick', () => {
  const target = fakePointerTarget();
  const source = telemetry.createPointerTelemetry(target);
  target.emit('pointerdown', { clientX: 200, clientY: 100, pressure: 0.5 });
  target.emit('pointerup', { clientX: 200, clientY: 100, pressure: 0 });
  target.emit('pointerleave');
  assert.deepEqual([...source.sample(1n)], [0.25, 0.25, 0]);
  assert.equal(source.kind(), 'pointer');
  assert.deepEqual(source.sample(2n), stimulus.scriptedTelemetry(2n));
  source.dispose();
});

test('a canceled gesture drops its pending packet instead of reporting pointer input', () => {
  const target = fakePointerTarget();
  const source = telemetry.createPointerTelemetry(target);
  target.emit('pointerdown', { clientX: 200, clientY: 100, pressure: 0.5 });
  target.emit('pointermove', { clientX: 220, clientY: 110, pressure: 0.5 });
  // The browser takes over for scrolling before the next tick samples.
  target.emit('pointercancel');
  assert.deepEqual(source.sample(1n), stimulus.scriptedTelemetry(1n));
  assert.equal(source.kind(), 'scripted');
  // A cancel arriving after the packet was sampled also ends pointer input.
  target.emit('pointermove', { clientX: 300, clientY: 100, pressure: 0.5 });
  assert.deepEqual([...source.sample(2n)], [0.5, 0.25, 0.5]);
  target.emit('pointercancel');
  assert.deepEqual(source.sample(3n), stimulus.scriptedTelemetry(3n));
  assert.equal(source.kind(), 'scripted');
  source.dispose();
  assert.equal(target.listeners.size, 0);
});

test('the session feeds telemetry packets to the adapter and records a replayable trace', async () => {
  const channel = channelModule.createSimulationChannel();
  const received = [];
  const adapter = fakeAdapter();
  const input = adapter.input;
  adapter.input = (sequence, samples) => {
    input(sequence, samples);
    received.push([sequence, [...samples]]);
  };
  const frames = [];
  const seam = wasmModule.createWasmSeam({
    channel,
    mainThreadAdapter: () => Promise.resolve(adapter),
    telemetry: () => telemetry.createScriptedTelemetry(),
    onFrame: (frame) => frames.push(frame),
  });
  const session = await seam.init({
    useWorker: false,
    signal: new AbortController().signal,
    onWorkerFailure: () => assert.fail('no worker failure expected'),
  });
  session.resume();
  await sleep(180);
  session.dispose();

  assert.ok(received.length >= 2);
  received.forEach(([sequence, samples], index) => {
    assert.equal(sequence, BigInt(index + 1));
    assert.deepEqual(samples, [...stimulus.scriptedTelemetry(sequence)]);
  });
  const last = frames.at(-1);
  assert.equal(last.source, 'scripted');
  const trace = last.trace();
  assert.equal(trace.seed, stimulus.DEMO_SEED.toString());
  assert.deepEqual(trace.config, [5, 1], 'live sessions use contract 5 with the temporal encoder');
  assert.deepEqual(
    trace.operations,
    received.flatMap(([sequence, samples]) => [
      { op: 'input', sequence: sequence.toString(), samples },
      { op: 'step' },
    ]),
  );
});

test('failed ticks are not recorded, and exported recordings replay without expected values', async () => {
  const channel = channelModule.createSimulationChannel();
  const adapter = fakeAdapter();
  const step = adapter.step;
  adapter.step = () => {
    if (adapter.calls.step >= 2) {
      adapter.calls.step += 1;
      throw new Error('step failed');
    }
    return step();
  };
  const frames = [];
  const failures = [];
  const seam = wasmModule.createWasmSeam({
    channel,
    mainThreadAdapter: () => Promise.resolve(adapter),
    onFrame: (frame) => frames.push(frame),
  });
  const session = await seam.init({
    useWorker: false,
    signal: new AbortController().signal,
    onWorkerFailure: (phase) => failures.push(phase),
  });
  session.resume();
  await sleep(220);
  session.dispose();

  assert.ok(failures.length > 0, 'the third tick fails');
  const trace = frames.at(-1).trace();
  assert.deepEqual(
    trace.operations.filter((operation) => operation.op === 'input').map((operation) => operation.sequence),
    ['1', '2'],
    'only the two completed ticks are recorded',
  );

  trace.operations[0].samples[0] = 99;
  assert.notEqual(frames.at(-1).trace().operations[0].samples[0], 99, 'exports are copies');

  const replayed = [];
  let seenConfig;
  await replayTraceFixture(frames.at(-1).trace(), (seed, config) => {
    seenConfig = config;
    return {
      input: (sequence, samples) => replayed.push([sequence, Array.from(samples)]),
      step: () => ({ error_status: 'ok' }),
    };
  });
  assert.deepEqual(seenConfig, [5, 1]);
  assert.deepEqual(replayed, [
    [1n, Array.from(stimulus.scriptedTelemetry(1n))],
    [2n, Array.from(stimulus.scriptedTelemetry(2n))],
  ]);
});

test('the telemetry recorder stops at capacity instead of dropping replay history', () => {
  const recorder = telemetry.createTelemetryRecorder(9n, [5, 1], 2);
  recorder.record(1n, new Float32Array([0.1, 0.2, 0]));
  recorder.record(2n, new Float32Array([0.2, 0.2, 0]));
  assert.equal(recorder.trace().operations.length, 4);
  recorder.record(3n, new Float32Array([0.3, 0.2, 0]));
  assert.equal(recorder.trace(), null);
  assert.throws(() => recorder.record(4n, new Float32Array(16)), RangeError);
});

test('simulation channel delivers the latest snapshot to subscribers', () => {
  const channel = channelModule.createSimulationChannel();
  assert.equal(channel.latest(), null);
  const seen = [];
  const unsubscribe = channel.subscribe((state) => seen.push(state.completedStep));
  channel.publish(fakeState({ completedStep: 1n }));
  channel.publish(fakeState({ completedStep: 2n }));
  unsubscribe();
  channel.publish(fakeState({ completedStep: 3n }));
  assert.deepEqual(seen, [1n, 2n]);
  assert.equal(channel.latest().completedStep, 3n);
});

test('topology layout is deterministic and bounded to the stage', () => {
  const positions = rendererModule.layoutTopology(16);
  assert.equal(positions.length, 16);
  assert.deepEqual(positions, rendererModule.layoutTopology(16));
  for (const { x, y } of positions) {
    const radius = Math.hypot(x, y);
    assert.ok(radius > 0.5 && radius < 1.5, `radius ${radius} out of range`);
  }
});

test('live seams expose renderer and wasm seams backed by one channel', () => {
  const seams = liveSeams.createLiveDemoSeams();
  assert.equal(typeof seams.renderer?.create, 'function');
  assert.equal(typeof seams.wasm?.init, 'function');
});

test('wasm seam main-thread session steps at a fixed cadence and publishes snapshots', async () => {
  const channel = channelModule.createSimulationChannel();
  const adapter = fakeAdapter();
  const seam = wasmModule.createWasmSeam({
    channel,
    mainThreadAdapter: () => Promise.resolve(adapter),
  });
  const published = [];
  channel.subscribe((state) => published.push(state.completedStep));

  const session = await seam.init({
    useWorker: false,
    signal: new AbortController().signal,
    onWorkerFailure: () => assert.fail('no worker failure expected'),
  });
  session.resume();
  await sleep(180);
  session.pause();
  const pausedSteps = adapter.calls.step;
  await sleep(120);
  assert.equal(adapter.calls.step, pausedSteps, 'paused session must not step');
  session.dispose();

  assert.ok(published.length >= 2, `expected repeated steps, saw ${published.length}`);
  assert.deepEqual(
    published,
    published.map((_, index) => BigInt(index + 1)),
    'steps advance exactly one logical tick at a time',
  );
  assert.equal(adapter.calls.dispose, 1);
});

test('wasm seam main-thread failure reports a structured reason code', async () => {
  const channel = channelModule.createSimulationChannel();
  const seam = wasmModule.createWasmSeam({
    channel,
    mainThreadAdapter: () => Promise.reject(new Error('no adapter')),
  });
  await assert.rejects(
    seam.init({
      useWorker: false,
      signal: new AbortController().signal,
      onWorkerFailure: () => {},
    }),
    (error) => error.code === 'wasm-init-failed',
  );
});

test('wasm seam worker failure after init notifies the runtime callback', async () => {
  const channel = channelModule.createSimulationChannel();
  const listeners = {};
  const worker = {
    postMessage(message) {
      if (message.type === 'init') {
        queueMicrotask(() => listeners.message?.({ data: { id: message.id, type: 'ready' } }));
      }
    },
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    removeEventListener() {},
    terminate() {},
    onerror: null,
    onmessageerror: null,
    onmessage: null,
  };
  const failures = [];
  const seam = wasmModule.createWasmSeam({ channel, workerFactory: () => worker });
  const session = await seam.init({
    useWorker: true,
    signal: new AbortController().signal,
    onWorkerFailure: (phase) => failures.push(phase),
  });
  worker.onerror?.({ message: 'boom', preventDefault() {} });
  assert.deepEqual(failures, ['after-init']);
  session.dispose();
});

test('wasm seam aborts worker init cleanly when the runtime signal fires', async () => {
  const channel = channelModule.createSimulationChannel();
  const worker = {
    postMessage() {},
    addEventListener() {},
    removeEventListener() {},
    terminate() {},
    onerror: null,
    onmessageerror: null,
    onmessage: null,
  };
  const seam = wasmModule.createWasmSeam({ channel, workerFactory: () => worker });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    seam.init({
      useWorker: true,
      signal: controller.signal,
      onWorkerFailure: () => {},
    }),
    (error) => error.code === 'worker-init-failed',
  );
});

test('production seam provider registration feeds getDemoSeams', () => {
  liveSeams.provideLiveDemoSeams();
  const seams = demoRuntime.getDemoSeams();
  assert.equal(typeof seams.renderer?.create, 'function');
  assert.equal(typeof seams.wasm?.init, 'function');
});
