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

  assert.equal(rendererCreateOptions[0].cameraMotionEnabled, false);
  assert.equal(typeof rendererCreateOptions[0].onRendererError, 'function');
  assert.equal(rendererCreateOptions[0].signal.aborted, false);
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
  assert.equal(rendererEvents.filter((event) => event === 'disposePartial').length, 1);
  assert.equal(rendererEvents.filter((event) => event === 'create').length, 1);
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
  assert.equal(rendererEvents.filter((event) => event === 'disposePartial').length, 1);
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

function trackingSession(events, label, { freeze = true } = {}) {
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
    freeze: freeze
      ? () => {
          events.push(`${label}:freeze`);
        }
      : undefined,
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
  assert.equal(rendererEvents.filter((event) => event === 'disposePartial').length, 1);
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
  await waitFor(() => events.includes('wasm:init') && events.includes('renderer:create'));
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(events.includes('renderer:create'));
  assert.equal(events.includes('renderer:dispose'), false);
  assert.equal(demo.getSnapshot().mode, 'initializing');

  demo.reportContextLost();

  assert.equal(demo.getSnapshot().mode, 'fallback');
  assert.equal(demo.getSnapshot().reason, 'webgl-context-lost');
  assert.equal(demo.getSnapshot().hasGraphicsSurface, false);
  assert.ok(events.includes('renderer:dispose'));
  assert.equal(events.filter((event) => event === 'disposePartial').length, 1);
  assert.equal(events.includes('wasm:dispose'), false);

  wasmInit.resolve();
  await started;

  assert.equal(demo.getSnapshot().mode, 'fallback');
  assert.equal(demo.getSnapshot().reason, 'webgl-context-lost');
  assert.equal(demo.getSnapshot().hasGraphicsSurface, false);
  assert.equal(events.filter((event) => event === 'renderer:dispose').length, 1);
  assert.equal(events.filter((event) => event === 'disposePartial').length, 1);
  assert.ok(events.includes('wasm:dispose'));
  assert.deepEqual(
    events.filter((event) => event === 'disposePartial' || event === 'renderer:dispose' || event === 'wasm:dispose'),
    ['disposePartial', 'renderer:dispose', 'wasm:dispose'],
  );
});

function createFakeIsland() {
  const status = { textContent: runtime.STATIC_DEMO_STATUS };
  const play = {
    hidden: true,
    disabled: false,
    textContent: 'Play animation',
    clickHandler: undefined,
    addEventListener(type, handler) {
      if (type === 'click') {
        play.clickHandler = handler;
      }
    },
    removeEventListener(type, handler) {
      if (type === 'click' && play.clickHandler === handler) {
        play.clickHandler = undefined;
      }
    },
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

function installBindingHost({ reducedMotion = false } = {}) {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const windowListeners = new Map();
  const motionListeners = new Set();
  const motionQuery = {
    matches: reducedMotion,
    addEventListener(type, handler) {
      if (type === 'change') {
        motionListeners.add(handler);
      }
    },
    removeEventListener(type, handler) {
      motionListeners.delete(handler);
    },
  };
  const document = {
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
  };
  const windowObject = {
    addEventListener(type, handler) {
      const list = windowListeners.get(type) ?? [];
      list.push(handler);
      windowListeners.set(type, list);
    },
    removeEventListener(type, handler) {
      windowListeners.set(
        type,
        (windowListeners.get(type) ?? []).filter((item) => item !== handler),
      );
    },
    matchMedia() {
      return motionQuery;
    },
  };
  globalThis.document = document;
  globalThis.window = windowObject;
  const restore = () => {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  };
  restore.dispatchWindow = (type, event) => {
    for (const handler of windowListeners.get(type) ?? []) {
      handler(event);
    }
  };
  restore.listenerCount = (type) => (windowListeners.get(type) ?? []).length;
  restore.motionQuery = motionQuery;
  restore.motionListenerCount = () => motionListeners.size;
  restore.dispatchMotion = (matches) => {
    motionQuery.matches = matches;
    for (const handler of [...motionListeners]) {
      handler({ matches });
    }
  };
  return restore;
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

function workerAwareSeams({ freeze = true } = {}) {
  const wasmCalls = [];
  const events = [];
  const captured = { onWorkerFailure: undefined };
  return {
    wasmCalls,
    events,
    captured,
    seams: {
      renderer: {
        async create(options) {
          captured.onRendererError = options.onRendererError;
          captured.signal = options.signal;
          return trackingSession(events, 'renderer', { freeze });
        },
      },
      wasm: {
        async init(options) {
          wasmCalls.push(options.useWorker);
          captured.onWorkerFailure = options.onWorkerFailure;
          return trackingSession(events, 'wasm');
        },
      },
    },
  };
}

test('binding freezes the live surface when the WASM seam reports after-init worker failure', async () => {
  const { seams, wasmCalls, events, captured } = workerAwareSeams({ freeze: true });
  const demo = runtime.createDemoRuntime({
    capabilities: capable,
    seams,
    inViewport: false,
    documentHidden: false,
  });

  const { root, status, play, surface } = createFakeIsland();
  const restoreHost = installBindingHost();
  let binding;

  try {
    binding = enhance.bindDemoIsland(root, demo);
    await waitFor(() => root.dataset.mode === 'live');

    assert.equal(typeof captured.onWorkerFailure, 'function');
    assert.deepEqual(wasmCalls, [true]);
    assert.equal(play.disabled, false);
    assert.equal(surface.hidden, false);

    captured.onWorkerFailure('after-init');
    await waitFor(() => root.dataset.mode === 'frozen');

    assert.equal(root.dataset.mode, 'frozen');
    assert.equal(root.dataset.reason, 'worker-runtime-failed');
    assert.equal(play.hidden, true);
    assert.equal(play.disabled, true);
    assert.equal(surface.hidden, false);
    assert.match(status.textContent, /last valid frame/);
    assert.ok(events.includes('renderer:freeze'));
    assert.deepEqual(wasmCalls, [true]);

    captured.onWorkerFailure('after-init');
    captured.onWorkerFailure('before-init');
    await Promise.resolve();
    assert.equal(root.dataset.mode, 'frozen');
    assert.deepEqual(wasmCalls, [true]);
    assert.equal(events.filter((event) => event === 'renderer:freeze').length, 1);

    binding.dispose();
    binding = undefined;
    captured.onWorkerFailure('after-init');
    captured.onWorkerFailure('before-init');
    await Promise.resolve();
    assert.deepEqual(wasmCalls, [true]);
    assert.equal(events.filter((event) => event === 'renderer:freeze').length, 1);
    assert.equal(demo.getSnapshot().mode, 'frozen');
  } finally {
    binding?.dispose();
    restoreHost();
  }
});

test('binding returns to the static diagram when a post-init worker failure cannot freeze', async () => {
  const { seams, wasmCalls, captured } = workerAwareSeams({ freeze: false });
  const demo = runtime.createDemoRuntime({
    capabilities: capable,
    seams,
    inViewport: false,
    documentHidden: false,
  });

  const { root, status, play, surface } = createFakeIsland();
  const restoreHost = installBindingHost();
  let binding;

  try {
    binding = enhance.bindDemoIsland(root, demo);
    await waitFor(() => root.dataset.mode === 'live');
    assert.deepEqual(wasmCalls, [true]);

    captured.onWorkerFailure('after-init');
    await waitFor(() => root.dataset.mode === 'fallback');

    assert.equal(root.dataset.mode, 'fallback');
    assert.equal(root.dataset.reason, 'worker-runtime-failed');
    assert.equal(play.hidden, true);
    assert.equal(play.disabled, true);
    assert.equal(surface.hidden, true);
    assert.match(status.textContent, /static diagram remains available/);
    assert.deepEqual(wasmCalls, [true]);

    binding.dispose();
    binding = undefined;
    captured.onWorkerFailure('after-init');
    captured.onWorkerFailure('before-init');
    await Promise.resolve();
    assert.deepEqual(wasmCalls, [true]);
  } finally {
    binding?.dispose();
    restoreHost();
  }
});

test('graphics and WASM initialization start independently', async () => {
  const events = [];
  const rendererCreate = deferred();
  const demo = runtime.createDemoRuntime({
    capabilities: capable,
    seams: {
      renderer: {
        async create() {
          events.push('renderer:start');
          await rendererCreate.promise;
          events.push('renderer:done');
          return trackingSession(events, 'renderer');
        },
      },
      wasm: {
        async init() {
          events.push('wasm:start');
          return trackingSession(events, 'wasm');
        },
      },
    },
    inViewport: true,
  });

  const started = demo.startIfAllowed();
  await waitFor(() => events.includes('wasm:start') && events.includes('renderer:start'));
  assert.equal(events.includes('renderer:done'), false);
  assert.equal(demo.getSnapshot().mode, 'initializing');

  rendererCreate.resolve();
  await started;
  assert.equal(demo.getSnapshot().mode, 'live');
  assert.ok(events.indexOf('wasm:start') < events.indexOf('renderer:done'));
});

test('dispose during pending renderer create aborts work and cleans up once', async () => {
  const events = [];
  const rendererCreate = deferred();
  const captured = { signal: undefined };
  const demo = runtime.createDemoRuntime({
    capabilities: capable,
    seams: {
      renderer: {
        async create(options) {
          captured.signal = options.signal;
          events.push('renderer:create');
          await rendererCreate.promise;
          return trackingSession(events, 'renderer');
        },
        disposePartial() {
          events.push('disposePartial');
        },
      },
      wasm: {
        async init(options) {
          events.push('wasm:init');
          await new Promise((_, reject) => {
            const fail = () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            };
            if (options.signal.aborted) {
              fail();
              return;
            }
            options.signal.addEventListener('abort', fail, { once: true });
          });
          return trackingSession(events, 'wasm');
        },
      },
    },
    inViewport: true,
  });

  const started = demo.startIfAllowed();
  await waitFor(() => captured.signal !== undefined && events.includes('wasm:init'));
  demo.dispose();

  assert.equal(captured.signal.aborted, true);
  assert.equal(events.filter((event) => event === 'disposePartial').length, 1);
  assert.equal(demo.getSnapshot().mode, 'static');

  rendererCreate.resolve();
  await started;

  assert.equal(demo.getSnapshot().mode, 'static');
  assert.equal(events.filter((event) => event === 'disposePartial').length, 1);
  assert.equal(events.filter((event) => event === 'renderer:dispose').length, 1);
  assert.equal(demo.getSnapshot().hasGraphicsSurface, false);
});

test('a live session that cannot pause fails closed', async () => {
  const rendererEvents = [];
  const demo = runtime.createDemoRuntime({
    capabilities: capable,
    seams: {
      renderer: {
        async create() {
          return {
            dispose() {
              rendererEvents.push('dispose');
            },
          };
        },
        disposePartial() {
          rendererEvents.push('disposePartial');
        },
      },
      wasm: {
        async init() {
          return trackingSession([], 'wasm');
        },
      },
    },
    inViewport: true,
  });

  await demo.startIfAllowed();
  const snapshot = demo.getSnapshot();

  assert.equal(snapshot.mode, 'fallback');
  assert.equal(snapshot.reason, 'renderer-error');
  assert.equal(snapshot.playEnabled, false);
  assert.equal(rendererEvents.filter((event) => event === 'disposePartial').length, 1);
  assert.ok(rendererEvents.includes('dispose'));
});

test('enabling reduced motion during a live session requires explicit Play without rebuilding', async () => {
  const { seams, rendererEvents, wasmCalls } = connectedSeams();
  const demo = runtime.createDemoRuntime({
    capabilities: capable,
    seams,
    inViewport: true,
  });

  await demo.startIfAllowed();
  assert.equal(demo.getSnapshot().mode, 'live');
  assert.equal(demo.getSnapshot().cameraMotionEnabled, true);

  demo.setPrefersReducedMotion(true);
  const paused = demo.getSnapshot();
  assert.equal(paused.mode, 'awaiting-play');
  assert.equal(paused.reason, 'reduced-motion');
  assert.equal(paused.cameraMotionEnabled, false);
  assert.equal(paused.playEnabled, true);
  assert.equal(rendererEvents.filter((event) => event === 'create').length, 1);
  assert.deepEqual(wasmCalls, [true]);

  demo.setPrefersReducedMotion(false);
  const gated = demo.getSnapshot();
  assert.equal(gated.mode, 'awaiting-play');
  assert.equal(gated.reason, 'ok');
  assert.equal(rendererEvents.filter((event) => event === 'create').length, 1);

  await demo.play();
  assert.equal(demo.getSnapshot().mode, 'live');
  assert.equal(demo.getSnapshot().cameraMotionEnabled, true);
  assert.equal(rendererEvents.filter((event) => event === 'create').length, 1);
  assert.deepEqual(wasmCalls, [true]);
});

test('Play paints initializing immediately, then the live surface after settlement', async () => {
  const rendererCreate = deferred();
  const demo = runtime.createDemoRuntime({
    capabilities: { ...capable, prefersReducedMotion: true },
    seams: {
      renderer: {
        async create() {
          await rendererCreate.promise;
          return trackingSession([], 'renderer');
        },
      },
      wasm: {
        async init() {
          return trackingSession([], 'wasm');
        },
      },
    },
    inViewport: true,
    documentHidden: false,
  });

  const { root, play, surface } = createFakeIsland();
  const restoreHost = installBindingHost({ reducedMotion: true });
  let binding;

  try {
    binding = enhance.bindDemoIsland(root, demo);
    await waitFor(() => root.dataset.mode === 'awaiting-play');
    assert.equal(play.disabled, false);
    assert.equal(play.textContent, 'Play animation');

    play.clickHandler();
    assert.equal(root.dataset.mode, 'initializing');
    assert.equal(play.disabled, true);
    assert.equal(play.textContent, 'Play animation');
    assert.equal(surface.hidden, true);

    rendererCreate.resolve();
    await waitFor(() => root.dataset.mode === 'live');
    assert.equal(play.disabled, false);
    assert.equal(play.textContent, 'Pause animation');
    assert.equal(surface.hidden, false);
  } finally {
    binding?.dispose();
    restoreHost();
  }
});

test('persisted pagehide pauses the island and pageshow restores it without disposing', async () => {
  const { seams, rendererEvents } = connectedSeams();
  const demo = runtime.createDemoRuntime({
    capabilities: capable,
    seams,
    inViewport: false,
    documentHidden: false,
  });

  const { root, play } = createFakeIsland();
  const restoreHost = installBindingHost();
  let binding;

  try {
    binding = enhance.bindDemoIsland(root, demo);
    await waitFor(() => root.dataset.mode === 'live');
    assert.equal(restoreHost.listenerCount('pagehide'), 1);
    assert.equal(restoreHost.listenerCount('pageshow'), 1);

    restoreHost.dispatchWindow('pagehide', { persisted: true });
    assert.equal(root.dataset.mode, 'live');
    assert.equal(demo.getSnapshot().cameraMotionEnabled, false);
    assert.equal(play.clickHandler !== undefined, true);
    assert.equal(restoreHost.listenerCount('pagehide'), 1);

    restoreHost.dispatchWindow('pageshow', { persisted: true });
    await waitFor(() => demo.getSnapshot().cameraMotionEnabled === true);
    assert.equal(root.dataset.mode, 'live');
    assert.equal(rendererEvents.filter((event) => event === 'create').length, 1);

    restoreHost.dispatchWindow('pagehide', { persisted: false });
    assert.equal(restoreHost.listenerCount('pagehide'), 0);
    assert.equal(restoreHost.listenerCount('pageshow'), 0);
    assert.equal(restoreHost.motionListenerCount(), 0);
    assert.equal(play.clickHandler, undefined);
    assert.equal(demo.getSnapshot().mode, 'static');
  } finally {
    binding?.dispose();
    restoreHost();
  }
});

test('binding fails closed when the renderer seam reports a runtime error', async () => {
  const { seams, captured } = workerAwareSeams();
  const demo = runtime.createDemoRuntime({
    capabilities: capable,
    seams,
    inViewport: false,
    documentHidden: false,
  });

  const { root, status, play, surface } = createFakeIsland();
  const restoreHost = installBindingHost();
  let binding;

  try {
    binding = enhance.bindDemoIsland(root, demo);
    await waitFor(() => root.dataset.mode === 'live');
    assert.equal(typeof captured.onRendererError, 'function');

    captured.onRendererError();
    await waitFor(() => root.dataset.mode === 'fallback');
    assert.equal(root.dataset.reason, 'renderer-error');
    assert.equal(play.hidden, true);
    assert.equal(play.disabled, true);
    assert.equal(surface.hidden, true);
    assert.match(status.textContent, /renderer stopped/i);

    binding.dispose();
    binding = undefined;
    captured.onRendererError();
    await Promise.resolve();
    assert.equal(demo.getSnapshot().mode, 'static');
  } finally {
    binding?.dispose();
    restoreHost();
  }
});

test('reduced-motion media query changes update the live gate and the listener is removed', async () => {
  const { seams, rendererEvents } = connectedSeams();
  const demo = runtime.createDemoRuntime({
    capabilities: capable,
    seams,
    inViewport: false,
    documentHidden: false,
  });

  const { root, play } = createFakeIsland();
  const restoreHost = installBindingHost();
  let binding;

  try {
    binding = enhance.bindDemoIsland(root, demo);
    await waitFor(() => root.dataset.mode === 'live');
    assert.equal(restoreHost.motionListenerCount(), 1);

    restoreHost.dispatchMotion(true);
    assert.equal(root.dataset.mode, 'awaiting-play');
    assert.equal(root.dataset.reason, 'reduced-motion');
    assert.equal(play.disabled, false);
    assert.equal(rendererEvents.filter((event) => event === 'create').length, 1);

    restoreHost.dispatchMotion(false);
    assert.equal(root.dataset.mode, 'awaiting-play');
    assert.equal(root.dataset.reason, 'ok');
    assert.equal(rendererEvents.filter((event) => event === 'create').length, 1);

    binding.dispose();
    binding = undefined;
    assert.equal(restoreHost.motionListenerCount(), 0);
    restoreHost.dispatchMotion(true);
    assert.equal(demo.getSnapshot().mode, 'static');
  } finally {
    binding?.dispose();
    restoreHost();
  }
});
