import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTsModule, readSource } from './load-ts-module.mjs';

const runtime = await loadTsModule('../src/runtime/demo-runtime.ts');

const capable = {
  prefersReducedMotion: false,
  webgl: true,
  wasm: true,
  worker: true,
};

function connectedSeams({
  rendererFail = false,
  wasmFail = false,
  workerFailOnFirst = false,
  freeze = true,
} = {}) {
  const wasmCalls = [];
  const rendererEvents = [];

  return {
    wasmCalls,
    rendererEvents,
    seams: {
      renderer: {
        async create() {
          rendererEvents.push('create');
          if (rendererFail) {
            throw Object.assign(new Error('renderer failed'), { code: 'renderer-error' });
          }

          return {
            dispose() {
              rendererEvents.push('dispose');
            },
            pause() {
              rendererEvents.push('pause');
            },
            resume() {
              rendererEvents.push('resume');
            },
            freeze: freeze
              ? () => {
                  rendererEvents.push('freeze');
                }
              : undefined,
          };
        },
        disposePartial() {
          rendererEvents.push('disposePartial');
        },
      },
      wasm: {
        async init({ useWorker }) {
          wasmCalls.push(useWorker);
          if (workerFailOnFirst && useWorker) {
            throw new Error('worker failed before init');
          }
          if (wasmFail) {
            throw Object.assign(new Error('wasm failed'), { code: 'wasm-init-failed' });
          }

          return {
            dispose() {},
            pause() {},
            resume() {},
          };
        },
      },
    },
  };
}

test('reduced-motion keeps the static representation until an explicit play action', async () => {
  const { seams, wasmCalls } = connectedSeams();
  const demo = runtime.createDemoRuntime({
    capabilities: { ...capable, prefersReducedMotion: true },
    seams,
    inViewport: true,
  });

  await demo.startIfAllowed();
  const waiting = demo.getSnapshot();

  assert.equal(waiting.mode, 'awaiting-play');
  assert.equal(waiting.reason, 'reduced-motion');
  assert.equal(waiting.playVisible, true);
  assert.equal(waiting.playEnabled, true);
  assert.equal(waiting.playLabel, 'Play animation');
  assert.equal(waiting.cameraMotionEnabled, false);
  assert.match(waiting.status, /Play animation/);
  assert.deepEqual(wasmCalls, []);

  await demo.play();
  const live = demo.getSnapshot();

  assert.equal(live.mode, 'live');
  assert.equal(live.cameraMotionEnabled, false);
  assert.equal(live.playLabel, 'Pause animation');
  assert.match(live.status, /camera motion stays off/i);
  assert.deepEqual(wasmCalls, [true]);
});

test('a capable viewport auto-starts only when reduced motion is not requested', async () => {
  const reduced = runtime.createDemoRuntime({
    capabilities: { ...capable, prefersReducedMotion: true },
    seams: connectedSeams().seams,
    inViewport: true,
  });
  const motion = runtime.createDemoRuntime({
    capabilities: capable,
    seams: connectedSeams().seams,
    inViewport: true,
  });

  await reduced.startIfAllowed();
  await motion.startIfAllowed();

  assert.equal(reduced.getSnapshot().mode, 'awaiting-play');
  assert.equal(motion.getSnapshot().mode, 'live');
  assert.equal(motion.getSnapshot().cameraMotionEnabled, true);
});

test('missing WebGL disposes partial graphics and never enables live controls', async () => {
  const { seams, rendererEvents } = connectedSeams({ rendererFail: true });
  const demo = runtime.createDemoRuntime({
    capabilities: capable,
    seams,
    inViewport: true,
  });

  await demo.startIfAllowed();
  const snapshot = demo.getSnapshot();

  assert.equal(snapshot.mode, 'fallback');
  assert.equal(snapshot.reason, 'renderer-error');
  assert.equal(snapshot.playVisible, false);
  assert.equal(snapshot.liveControlsEnabled, false);
  assert.match(snapshot.status, /static diagram remains available/);
  assert.ok(rendererEvents.includes('disposePartial'));
});

test('capability probes treat a missing WebGL context as no-webgl without attempting seams', async () => {
  const { seams, rendererEvents, wasmCalls } = connectedSeams();
  const demo = runtime.createDemoRuntime({
    capabilities: { ...capable, webgl: false },
    seams,
    inViewport: true,
  });

  await demo.startIfAllowed();
  const snapshot = demo.getSnapshot();

  assert.equal(snapshot.reason, 'no-webgl');
  assert.equal(snapshot.playEnabled, false);
  assert.deepEqual(rendererEvents, []);
  assert.deepEqual(wasmCalls, []);
});

test('WASM unavailability keeps the static diagram and disables live-only controls', async () => {
  const demo = runtime.createDemoRuntime({
    capabilities: { ...capable, wasm: false },
    seams: connectedSeams().seams,
    inViewport: true,
  });

  await demo.startIfAllowed();
  const snapshot = demo.getSnapshot();

  assert.equal(snapshot.mode, 'fallback');
  assert.equal(snapshot.reason, 'no-wasm');
  assert.equal(snapshot.playVisible, false);
  assert.match(snapshot.status, /WebAssembly is unavailable/);
});

test('WASM initialization failure does not create a JavaScript substitute', async () => {
  const { seams, wasmCalls } = connectedSeams({ wasmFail: true });
  const demo = runtime.createDemoRuntime({
    capabilities: capable,
    seams,
    inViewport: true,
  });

  await demo.startIfAllowed();
  const snapshot = demo.getSnapshot();

  assert.equal(snapshot.reason, 'wasm-init-failed');
  assert.equal(snapshot.mode, 'fallback');
  assert.equal(snapshot.hasGraphicsSurface, false);
  assert.deepEqual(wasmCalls, [true, false]);
});

test('a worker failure before initialization retries once on the main thread', async () => {
  const { seams, wasmCalls } = connectedSeams({ workerFailOnFirst: true });
  const demo = runtime.createDemoRuntime({
    capabilities: capable,
    seams,
    inViewport: true,
  });

  await demo.startIfAllowed();

  assert.equal(demo.getSnapshot().mode, 'live');
  assert.deepEqual(wasmCalls, [true, false]);
});

test('worker unavailability uses a single bounded main-thread attempt', async () => {
  const { seams, wasmCalls } = connectedSeams();
  const demo = runtime.createDemoRuntime({
    capabilities: { ...capable, worker: false },
    seams,
    inViewport: true,
  });

  await demo.startIfAllowed();

  assert.equal(demo.getSnapshot().mode, 'live');
  assert.deepEqual(wasmCalls, [false]);
});

test('a worker failure after initialization freezes the last valid frame', async () => {
  const { seams, rendererEvents, wasmCalls } = connectedSeams({ freeze: true });
  const demo = runtime.createDemoRuntime({
    capabilities: capable,
    seams,
    inViewport: true,
  });

  await demo.startIfAllowed();
  await demo.reportWorkerFailure('after-init');
  const snapshot = demo.getSnapshot();

  assert.equal(snapshot.mode, 'frozen');
  assert.equal(snapshot.freezeFrame, true);
  assert.equal(snapshot.playEnabled, false);
  assert.match(snapshot.status, /last valid frame/);
  assert.ok(rendererEvents.includes('freeze'));
  assert.deepEqual(wasmCalls, [true]);

  await demo.play();
  assert.equal(demo.getSnapshot().mode, 'frozen');
  assert.deepEqual(wasmCalls, [true]);
});

test('a later worker failure without a freeze path falls back to the static diagram', async () => {
  const { seams } = connectedSeams({ freeze: false });
  const demo = runtime.createDemoRuntime({
    capabilities: capable,
    seams,
    inViewport: true,
  });

  await demo.startIfAllowed();
  await demo.reportWorkerFailure('after-init');
  const snapshot = demo.getSnapshot();

  assert.equal(snapshot.mode, 'fallback');
  assert.equal(snapshot.hasGraphicsSurface, false);
  assert.match(snapshot.status, /static diagram remains available/);
});

test('graphics context loss disposes renderer state and preserves fallback copy', async () => {
  const { seams, rendererEvents } = connectedSeams();
  const demo = runtime.createDemoRuntime({
    capabilities: capable,
    seams,
    inViewport: true,
  });

  await demo.startIfAllowed();
  demo.reportContextLost();
  const snapshot = demo.getSnapshot();

  assert.equal(snapshot.reason, 'webgl-context-lost');
  assert.equal(snapshot.mode, 'fallback');
  assert.ok(rendererEvents.includes('disposePartial'));
  assert.ok(rendererEvents.includes('dispose'));
});

test('missing renderer/WASM seams stay on the static representation', async () => {
  const demo = runtime.createDemoRuntime({
    capabilities: capable,
    inViewport: true,
  });

  await demo.startIfAllowed();
  const snapshot = demo.getSnapshot();

  assert.equal(snapshot.reason, 'adapter-unavailable');
  assert.equal(snapshot.playVisible, false);
  assert.match(snapshot.status, /not connected yet/);
});

test('both graphics and WASM missing keep navigation-safe fallback copy', async () => {
  const demo = runtime.createDemoRuntime({
    capabilities: { prefersReducedMotion: false, webgl: false, wasm: false, worker: false },
  });

  await demo.startIfAllowed();
  const snapshot = demo.getSnapshot();

  assert.equal(snapshot.reason, 'unavailable');
  assert.match(snapshot.status, /navigation remain usable/);
});

test('applyDemoView exposes status, play affordance, and reason for assistive tech', () => {
  const elements = {
    root: { dataset: {} },
    status: { textContent: '' },
    play: { hidden: true, disabled: false, textContent: '' },
    surface: { hidden: true },
  };

  runtime.applyDemoView(
    {
      mode: 'awaiting-play',
      reason: 'reduced-motion',
      status: 'Motion is paused. Play animation to start the live visualization.',
      liveControlsEnabled: true,
      playVisible: true,
      playEnabled: true,
      playLabel: 'Play animation',
      cameraMotionEnabled: false,
      freezeFrame: false,
      hasGraphicsSurface: false,
    },
    elements,
  );

  assert.equal(elements.root.dataset.mode, 'awaiting-play');
  assert.equal(elements.root.dataset.reason, 'reduced-motion');
  assert.equal(elements.play.hidden, false);
  assert.equal(elements.play.disabled, false);
  assert.equal(elements.play.textContent, 'Play animation');
  assert.equal(elements.surface.hidden, true);
  assert.match(elements.status.textContent, /Play animation/);
});

test('WebGL detection never probes WebGPU and capability hosts can fail closed', () => {
  const contexts = [];
  const host = {
    matchMedia: () => ({ matches: true }),
    WebAssembly: { instantiate() {} },
    Worker: function Worker() {},
    document: {
      createElement: () => ({
        getContext: (id) => {
          contexts.push(id);
          return null;
        },
      }),
    },
  };

  const detected = runtime.detectCapabilities(host);

  assert.equal(detected.prefersReducedMotion, true);
  assert.equal(detected.webgl, false);
  assert.equal(detected.wasm, true);
  assert.deepEqual(contexts, ['webgl2', 'webgl']);
  assert.equal(contexts.includes('webgpu'), false);
  assert.equal(contexts.includes('gpu'), false);
});

test('runtime sources do not add a WebGPU fallback or a local simulator', () => {
  const files = [
    readSource('../src/runtime/demo-runtime.ts'),
    readSource('../src/runtime/enhance-demo.ts'),
    readSource('../src/components/NeuromorphicDemo.astro'),
  ].join('\n');

  assert.doesNotMatch(files, /webgpu/i);
  assert.doesNotMatch(files, /navigator\.gpu/);
  assert.doesNotMatch(files, /spikeTrain|fakeNeuron|toySnn|simulateNetwork/i);
});
