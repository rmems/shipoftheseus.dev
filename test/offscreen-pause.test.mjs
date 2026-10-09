import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import test, { mock } from 'node:test';

import { loadTsModule } from './load-ts-module.mjs';

const runtime = await loadTsModule('../src/runtime/demo-runtime.ts');
const enhance = await loadTsModule('../src/runtime/enhance-demo.ts');
const channelModule = await loadTsModule('../src/runtime/simulation-channel.ts');
const wasmSession = await loadTsModule('../src/runtime/wasm-session.ts');
const stimulus = await loadTsModule('../src/runtime/demo-stimulus.ts');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeIsland() {
  const element = (extra = {}) => ({ hidden: true, textContent: '', disabled: false, dataset: {}, ...extra });
  const play = element({
    addEventListener() {},
    removeEventListener() {},
  });
  const elements = {
    '[data-demo-status]': element(),
    '[data-demo-play]': play,
    '[data-demo-surface]': element(),
    '[data-demo-origin]': element(),
  };
  return {
    dataset: {},
    querySelector: (selector) => elements[selector] ?? null,
    addEventListener() {},
    removeEventListener() {},
  };
}

/** A browser host with a controllable IntersectionObserver and page visibility. */
function installHost() {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    IntersectionObserver: globalThis.IntersectionObserver,
  };
  const documentListeners = new Map();
  const observers = [];
  class FakeIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.targets = [];
      this.disconnected = false;
      observers.push(this);
    }
    observe(target) {
      this.targets.push(target);
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  globalThis.document = {
    hidden: false,
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (documentListeners.get(type) === listener) documentListeners.delete(type);
    },
  };
  globalThis.IntersectionObserver = FakeIntersectionObserver;
  globalThis.window = {
    IntersectionObserver: FakeIntersectionObserver,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  return {
    observers,
    documentListeners,
    setVisible(visible) {
      for (const observer of observers) {
        observer.callback(observer.targets.map((target) => ({ target, isIntersecting: visible })));
      }
    },
    setHidden(hidden) {
      globalThis.document.hidden = hidden;
      documentListeners.get('visibilitychange')?.();
    },
    restore() {
      globalThis.window = previous.window;
      globalThis.document = previous.document;
      globalThis.IntersectionObserver = previous.IntersectionObserver;
    },
  };
}

test('offscreen and hidden islands stop both simulation ticks and rendering, then resume', async (t) => {
  mock.timers.enable({ apis: ['setInterval'] });
  const host = installHost();
  t.after(() => {
    host.restore();
    mock.timers.reset();
  });

  // Real fixed-cadence WASM seam over a counting adapter; a renderer session
  // that records whether its frame loop would be running.
  const counts = { steps: 0, rendererRunning: false, rendererPauses: 0, rendererResumes: 0, disposed: 0 };
  const channel = channelModule.createSimulationChannel();
  const wasm = wasmSession.createWasmSeam({
    channel,
    mainThreadAdapter: async () => ({
      input() {},
      step() {
        counts.steps += 1;
        return { completedStep: BigInt(counts.steps) };
      },
      state() {},
      dispose() {
        counts.disposed += 1;
      },
    }),
  });
  const renderer = {
    async create() {
      return {
        pause() {
          counts.rendererRunning = false;
          counts.rendererPauses += 1;
        },
        resume() {
          counts.rendererRunning = true;
          counts.rendererResumes += 1;
        },
        dispose() {
          counts.rendererRunning = false;
        },
        freeze() {},
        setCameraMotionEnabled() {},
      };
    },
  };
  const demo = runtime.createDemoRuntime({
    capabilities: { prefersReducedMotion: false, webgl: true, wasm: true, worker: false },
    seams: { renderer, wasm },
    inViewport: false,
    documentHidden: false,
  });
  const island = fakeIsland();
  const binding = enhance.bindDemoIsland(island, demo);
  const ticks = async (count) => {
    for (let index = 0; index < count; index += 1) {
      mock.timers.tick(stimulus.DEMO_TICK_MS);
      await flush();
    }
  };

  assert.equal(host.observers.length, 1, 'the island is observed for viewport visibility');
  assert.equal(host.observers[0].options.threshold, 0.2);
  await flush();
  await ticks(5);
  assert.equal(counts.steps, 0, 'nothing runs before the island enters the viewport');
  assert.equal(island.dataset.mode, 'awaiting-play');

  host.setVisible(true);
  await flush();
  await flush();
  assert.equal(island.dataset.mode, 'live');
  assert.equal(counts.rendererRunning, true);
  await ticks(6);
  assert.equal(counts.steps, 6, 'one logical step per fixed tick while visible');

  host.setVisible(false);
  await flush();
  await ticks(20);
  assert.equal(counts.steps, 6, 'offscreen: the simulation does not step');
  assert.equal(counts.rendererRunning, false, 'offscreen: the frame loop is paused');

  host.setVisible(true);
  await flush();
  await ticks(3);
  assert.equal(counts.steps, 9, 'back in view: ticking resumes');
  assert.equal(counts.rendererRunning, true);

  host.setHidden(true);
  await flush();
  await ticks(20);
  assert.equal(counts.steps, 9, 'hidden page: the simulation does not step');
  assert.equal(counts.rendererRunning, false, 'hidden page: the frame loop is paused');

  host.setHidden(false);
  await flush();
  await ticks(2);
  assert.equal(counts.steps, 11);
  assert.equal(counts.rendererRunning, true);
  assert.equal(counts.rendererPauses, 2);
  assert.equal(counts.rendererResumes, 3);

  binding.dispose();
  await ticks(5);
  assert.equal(counts.steps, 11, 'disposed islands never tick again');
  assert.equal(counts.disposed, 1);
  assert.equal(host.observers[0].disconnected, true);
  assert.equal(host.documentListeners.has('visibilitychange'), false);
});
