import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTsModule, readSource } from './load-ts-module.mjs';

const runtime = await loadTsModule('../src/runtime/demo-runtime.ts');
const enhance = await loadTsModule('../src/runtime/enhance-demo.ts');

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
  const rendererCreateOptions = [];
  const wasmEvents = [];
  const wasmDisposeCount = { value: 0 };

  return {
    wasmCalls,
    rendererEvents,
    rendererCreateOptions,
    wasmEvents,
    wasmDisposeCount,
    seams: {
      renderer: {
        async create(options) {
          rendererEvents.push('create');
          rendererCreateOptions.push(options);
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
            dispose() {
              wasmEvents.push('dispose');
              wasmDisposeCount.value += 1;
            },
            pause() {
              wasmEvents.push('pause');
            },
            resume() {
              wasmEvents.push('resume');
            },
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

test('the renderer create seam receives camera motion disabled under reduced motion', async () => {
  const { seams, rendererCreateOptions } = connectedSeams();
  const demo = runtime.createDemoRuntime({
    capabilities: { ...capable, prefersReducedMotion: true },
    seams,
    inViewport: true,
  });

  await demo.play();

  assert.deepEqual(rendererCreateOptions, [{ cameraMotionEnabled: false }]);
  assert.equal(demo.getSnapshot().cameraMotionEnabled, false);
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, attempts = 30) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error('timed out waiting for runtime condition');
}

function trackingSession(events, label) {
  return {
    dispose() {
      events.push(`${label}:dispose`);
    },
    pause() {
      events.push(`${label}:pause`);
    },
    resume() {
      events.push(`${label}:resume`);
    },
    freeze() {
      events.push(`${label}:freeze`);
    },
  };
}

test('context loss during a deferred init keeps fallback after the pending create settles', async () => {
  const rendererEvents = [];
  const rendererCreate = deferred();
  const demo = runtime.createDemoRuntime({
    capabilities: capable,
    seams: {
      renderer: {
        async create() {
          rendererEvents.push('create');
          await rendererCreate.promise;
          return trackingSession(rendererEvents, 'renderer');
        },
        disposePartial() {
          rendererEvents.push('disposePartial');
        },
      },
      wasm: {
        async init() {
          return trackingSession(rendererEvents, 'wasm');
        },
      },
    },
    inViewport: true,
  });

  const started = demo.startIfAllowed();
  await waitFor(() => rendererEvents.includes('create'));
  demo.reportContextLost();
  assert.equal(demo.getSnapshot().mode, 'fallback');
  assert.equal(demo.getSnapshot().reason, 'webgl-context-lost');

  rendererCreate.resolve();
  await started;

  assert.equal(demo.getSnapshot().mode, 'fallback');
  assert.equal(demo.getSnapshot().reason, 'webgl-context-lost');
  assert.equal(demo.getSnapshot().hasGraphicsSurface, false);
  assert.ok(rendererEvents.includes('disposePartial'));
  assert.ok(rendererEvents.includes('renderer:dispose'));
});

test('a pending worker failure event retries once on the main thread without leaking the retry', async () => {
  const events = [];
  const workerInit = deferred();
  const mainInit = deferred();
  const wasmCalls = [];
  const demo = runtime.createDemoRuntime({
    capabilities: capable,
    seams: {
      renderer: {
        async create() {
          return trackingSession(events, 'renderer');
        },
      },
      wasm: {
        async init({ useWorker }) {
          wasmCalls.push(useWorker);
          if (useWorker) {
            return workerInit.promise;
          }
          return mainInit.promise;
        },
      },
    },
    inViewport: true,
  });

  const started = demo.startIfAllowed();
  await waitFor(() => wasmCalls.includes(true));
  const reported = demo.reportWorkerFailure('before-init');
  const mainSession = trackingSession(events, 'main');
  const workerSession = trackingSession(events, 'worker');
  mainInit.resolve(mainSession);
  await reported;
  workerInit.resolve(workerSession);
  await started;

  assert.equal(demo.getSnapshot().mode, 'live');
  assert.deepEqual(wasmCalls, [true, false]);
  assert.ok(events.includes('worker:dispose'));
  assert.equal(events.includes('main:dispose'), false);
  demo.dispose();
  assert.ok(events.includes('main:dispose'));
});

test('Play-Pause-Play resumes the same renderer and WASM sessions', async () => {
  const { seams, rendererEvents, wasmCalls, wasmEvents, wasmDisposeCount } = connectedSeams();
  const demo = runtime.createDemoRuntime({
    capabilities: capable,
    seams,
    inViewport: true,
  });

  await demo.startIfAllowed();
  assert.equal(demo.getSnapshot().mode, 'live');
  assert.equal(rendererEvents.filter((event) => event === 'resume').length, 0);
  assert.equal(wasmEvents.filter((event) => event === 'resume').length, 0);
  await demo.play();
  assert.equal(demo.getSnapshot().mode, 'awaiting-play');
  await demo.play();
  assert.equal(demo.getSnapshot().mode, 'live');
  assert.equal(rendererEvents.filter((event) => event === 'create').length, 1);
  assert.deepEqual(wasmCalls, [true]);
  assert.equal(rendererEvents.filter((event) => event === 'dispose').length, 0);
  assert.equal(wasmDisposeCount.value, 0);
  assert.equal(rendererEvents.filter((event) => event === 'pause').length, 1);
  assert.equal(rendererEvents.filter((event) => event === 'resume').length, 1);
  assert.equal(wasmEvents.filter((event) => event === 'pause').length, 1);
  assert.equal(wasmEvents.filter((event) => event === 'resume').length, 1);

  demo.dispose();
  assert.equal(rendererEvents.filter((event) => event === 'dispose').length, 1);
  assert.equal(wasmDisposeCount.value, 1);
});

test('a deferred init that hides the document pauses instead of becoming live', async () => {
  const events = [];
  const rendererCreate = deferred();
  const demo = runtime.createDemoRuntime({
    capabilities: capable,
    seams: {
      renderer: {
        async create() {
          events.push('renderer:create');
          await rendererCreate.promise;
          return trackingSession(events, 'renderer');
        },
      },
      wasm: {
        async init() {
          return trackingSession(events, 'wasm');
        },
      },
    },
    inViewport: true,
    documentHidden: false,
  });

  const started = demo.startIfAllowed();
  await waitFor(() => events.includes('renderer:create'));
  demo.setDocumentHidden(true);
  rendererCreate.resolve();
  await started;

  assert.equal(demo.getSnapshot().mode, 'awaiting-play');
  assert.equal(demo.getSnapshot().cameraMotionEnabled, false);
  assert.ok(events.includes('renderer:pause'));
  assert.equal(events.filter((event) => event === 'renderer:dispose').length, 0);

  await demo.setDocumentHidden(false);
  assert.equal(demo.getSnapshot().mode, 'live');
  assert.equal(events.filter((event) => event === 'renderer:pause').length, 1);
  assert.equal(events.filter((event) => event === 'renderer:resume').length, 1);
  assert.equal(events.filter((event) => event === 'wasm:pause').length, 1);
  assert.equal(events.filter((event) => event === 'wasm:resume').length, 1);
  assert.equal(events.filter((event) => event === 'renderer:create').length, 1);
});

test('a deferred init that leaves the viewport pauses instead of becoming live', async () => {
  const events = [];
  const rendererCreate = deferred();
  const demo = runtime.createDemoRuntime({
    capabilities: capable,
    seams: {
      renderer: {
        async create() {
          events.push('renderer:create');
          await rendererCreate.promise;
          return trackingSession(events, 'renderer');
        },
      },
      wasm: {
        async init() {
          return trackingSession(events, 'wasm');
        },
      },
    },
    inViewport: true,
  });

  const started = demo.startIfAllowed();
  await waitFor(() => events.includes('renderer:create'));
  demo.setInViewport(false);
  rendererCreate.resolve();
  await started;

  assert.equal(demo.getSnapshot().mode, 'awaiting-play');
  assert.equal(demo.getSnapshot().cameraMotionEnabled, false);
  assert.ok(events.includes('renderer:pause'));
  assert.equal(events.filter((event) => event === 'renderer:create').length, 1);

  await demo.setInViewport(true);
  assert.equal(demo.getSnapshot().mode, 'live');
  assert.equal(events.filter((event) => event === 'renderer:pause').length, 1);
  assert.equal(events.filter((event) => event === 'renderer:resume').length, 1);
  assert.equal(events.filter((event) => event === 'wasm:pause').length, 1);
  assert.equal(events.filter((event) => event === 'wasm:resume').length, 1);
  assert.equal(events.filter((event) => event === 'renderer:create').length, 1);
});

test('foreground and viewport return resume existing sessions exactly once', async () => {
  const { seams, rendererEvents, wasmEvents } = connectedSeams();
  const demo = runtime.createDemoRuntime({
    capabilities: capable,
    seams,
    inViewport: true,
  });

  await demo.startIfAllowed();
  assert.equal(demo.getSnapshot().mode, 'live');
  assert.equal(rendererEvents.filter((event) => event === 'resume').length, 0);
  assert.equal(wasmEvents.filter((event) => event === 'resume').length, 0);

  await demo.setInViewport(false);
  assert.equal(demo.getSnapshot().mode, 'live');
  assert.equal(rendererEvents.filter((event) => event === 'pause').length, 1);
  assert.equal(wasmEvents.filter((event) => event === 'pause').length, 1);

  await demo.setInViewport(true);
  assert.equal(demo.getSnapshot().mode, 'live');
  assert.equal(rendererEvents.filter((event) => event === 'resume').length, 1);
  assert.equal(wasmEvents.filter((event) => event === 'resume').length, 1);
  assert.equal(rendererEvents.filter((event) => event === 'create').length, 1);

  await demo.setInViewport(true);
  assert.equal(rendererEvents.filter((event) => event === 'resume').length, 1);
  assert.equal(wasmEvents.filter((event) => event === 'resume').length, 1);

  await demo.setDocumentHidden(true);
  assert.equal(rendererEvents.filter((event) => event === 'pause').length, 2);
  assert.equal(wasmEvents.filter((event) => event === 'pause').length, 2);

  await demo.setDocumentHidden(false);
  assert.equal(demo.getSnapshot().mode, 'live');
  assert.equal(rendererEvents.filter((event) => event === 'resume').length, 2);
  assert.equal(wasmEvents.filter((event) => event === 'resume').length, 2);
  assert.equal(rendererEvents.filter((event) => event === 'create').length, 1);
});

test('context loss after renderer create and before WASM init disposes the renderer immediately', async () => {
  const events = [];
  const wasmInit = deferred();
  const demo = runtime.createDemoRuntime({
    capabilities: capable,
    seams: {
      renderer: {
        async create() {
          events.push('renderer:create');
          return trackingSession(events, 'renderer');
        },
        disposePartial() {
          events.push('disposePartial');
        },
      },
      wasm: {
        async init() {
          events.push('wasm:init');
          await wasmInit.promise;
          return trackingSession(events, 'wasm');
        },
      },
    },
    inViewport: true,
  });

  const started = demo.startIfAllowed();
  await waitFor(() => events.includes('wasm:init'));
  assert.ok(events.includes('renderer:create'));
  assert.equal(events.includes('renderer:dispose'), false);
  assert.equal(demo.getSnapshot().mode, 'initializing');

  demo.reportContextLost();

  assert.equal(demo.getSnapshot().mode, 'fallback');
  assert.equal(demo.getSnapshot().reason, 'webgl-context-lost');
  assert.equal(demo.getSnapshot().hasGraphicsSurface, false);
  assert.ok(events.includes('renderer:dispose'));
  assert.ok(events.includes('disposePartial'));
  assert.equal(events.includes('wasm:dispose'), false);

  wasmInit.resolve();
  await started;

  assert.equal(demo.getSnapshot().mode, 'fallback');
  assert.equal(demo.getSnapshot().reason, 'webgl-context-lost');
  assert.equal(demo.getSnapshot().hasGraphicsSurface, false);
  assert.equal(events.filter((event) => event === 'renderer:dispose').length, 1);
  assert.ok(events.includes('wasm:dispose'));
});

function createFakeIsland() {
  const status = { textContent: runtime.STATIC_DEMO_STATUS };
  const play = {
    hidden: true,
    disabled: false,
    textContent: 'Play animation',
    addEventListener() {},
    removeEventListener() {},
  };
  const surface = { hidden: true };
  const elements = {
    '[data-demo-status]': status,
    '[data-demo-play]': play,
    '[data-demo-surface]': surface,
  };
  const root = {
    dataset: {},
    querySelector(selector) {
      return elements[selector] ?? null;
    },
    addEventListener() {},
    removeEventListener() {},
  };

  return { root, status, play, surface };
}

function installBindingHost() {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const document = {
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
  };
  const window = {
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.document = document;
  globalThis.window = window;
  return () => {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  };
}

test('binding paints the live surface after deferred init from a viewport return', async () => {
  const wasmInit = deferred();
  const demo = runtime.createDemoRuntime({
    capabilities: capable,
    seams: {
      renderer: {
        async create() {
          return trackingSession([], 'renderer');
        },
      },
      wasm: {
        async init() {
          await wasmInit.promise;
          return trackingSession([], 'wasm');
        },
      },
    },
    inViewport: false,
    documentHidden: false,
  });

  const { root, status, play, surface } = createFakeIsland();
  const restoreHost = installBindingHost();
  let binding;

  try {
    binding = enhance.bindDemoIsland(root, demo);

    assert.equal(root.dataset.mode, 'initializing');
    assert.equal(play.hidden, false);
    assert.equal(play.disabled, true);
    assert.equal(play.textContent, 'Play animation');
    assert.equal(surface.hidden, true);
    assert.equal(demo.getSnapshot().mode, 'initializing');

    wasmInit.resolve();
    await waitFor(() => root.dataset.mode === 'live');

    assert.equal(root.dataset.mode, 'live');
    assert.equal(root.dataset.reason, 'ok');
    assert.equal(surface.hidden, false);
    assert.equal(play.hidden, false);
    assert.equal(play.disabled, false);
    assert.equal(play.textContent, 'Pause animation');
    assert.match(status.textContent, /Live visualization is running/);
    assert.equal(demo.getSnapshot().hasGraphicsSurface, true);
  } finally {
    binding?.dispose();
    restoreHost();
  }
});
