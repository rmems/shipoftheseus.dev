// Page-side tasks for `measure-browser.mjs`. Each export is serialized with
// `Function.prototype.toString` and evaluated inside the page, so every
// function must be self-contained (no references to module scope).

export async function waitForLive() {
  const island = document.querySelector('[data-neuromorphic-demo]');
  if (!island) return { mode: 'missing' };
  // The surface stays hidden until the island is live, so scroll the island.
  island.scrollIntoView({ block: 'center' });
  const start = performance.now();
  while (island.dataset.mode !== 'live') {
    if (performance.now() - start > 30_000) {
      return { mode: island.dataset.mode, reason: island.dataset.reason };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const waitedMs = performance.now() - start;
  island.querySelector('[data-demo-surface]').scrollIntoView({ block: 'center' });
  return { mode: 'live', reason: island.dataset.reason, waitedMs };
}

export function environment() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  const info = gl?.getExtension('WEBGL_debug_renderer_info');
  const webgl = gl
    ? {
        version: gl.getParameter(gl.VERSION),
        shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
        vendor: info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : null,
        renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null,
        timerQueryExtension: Boolean(gl.getExtension('EXT_disjoint_timer_query_webgl2')),
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      }
    : null;
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  let resolution = Number.POSITIVE_INFINITY;
  let previous = performance.now();
  for (let index = 0; index < 100_000 && resolution === Number.POSITIVE_INFINITY; index += 1) {
    const current = performance.now();
    if (current > previous) resolution = current - previous;
    previous = current;
  }
  return {
    userAgent: navigator.userAgent,
    devicePixelRatio,
    viewport: [innerWidth, innerHeight],
    screen: [screen.width, screen.height],
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGb: navigator.deviceMemory ?? null,
    crossOriginIsolated,
    prefersReducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    visibilityState: document.visibilityState,
    timerResolutionMs: resolution,
    webgl,
  };
}

export function startup() {
  const navigation = performance.getEntriesByType('navigation')[0];
  const resources = performance
    .getEntriesByType('resource')
    .filter((entry) => /wasm|three|neuromorphic|NeuromorphicDemo/i.test(entry.name))
    .map((entry) => ({
      file: new URL(entry.name).pathname,
      startMs: Number(entry.startTime.toFixed(1)),
      durationMs: Number(entry.duration.toFixed(1)),
      decodedBodyBytes: entry.decodedBodySize,
    }));
  const summary = globalThis.__neuromorphicPerf?.summary();
  const absolute = {};
  for (const [name, at] of Object.entries(summary?.marks ?? {})) {
    absolute[name] = Number((summary.originMs + at).toFixed(1));
  }
  return {
    domContentLoadedMs: Number(navigation.domContentLoadedEventEnd.toFixed(1)),
    loadEventMs: Number(navigation.loadEventEnd.toFixed(1)),
    probeCreatedMs: summary ? Number(summary.originMs.toFixed(1)) : null,
    marksSinceNavigationStartMs: absolute,
    resources,
  };
}

export async function measureWindow({ durationMs, level }) {
  const perf = globalThis.__neuromorphicPerf;
  const island = document.querySelector('[data-neuromorphic-demo]');
  if (!perf) throw new Error('perf probe is not installed (missing ?neuromorphic-perf)');
  perf.forceQuality(level === undefined ? null : level);
  await new Promise((resolve) => setTimeout(resolve, 400));
  perf.reset();
  const sources = {};
  const startedAt = performance.now();
  while (performance.now() - startedAt < durationMs) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const source = island.dataset.demoInputSource ?? 'unknown';
    sources[source] = (sources[source] ?? 0) + 1;
  }
  const memory = performance.memory
    ? { usedJsHeapBytes: performance.memory.usedJSHeapSize, totalJsHeapBytes: performance.memory.totalJSHeapSize }
    : null;
  return {
    durationMs: performance.now() - startedAt,
    summary: perf.summary(),
    quality: perf.quality(),
    renderer: perf.renderer(),
    spikeEvents: perf.spikeEvents(),
    inputSourceSamples: sources,
    island: {
      mode: island.dataset.mode,
      quality: island.dataset.demoQuality,
      telemetryCadenceMs: island.dataset.demoTelemetryCadenceMs,
    },
    memory,
  };
}

/** The render surface's visible box (scrolled into view, clipped to the viewport). */
export async function surfaceRect() {
  const surface = document.querySelector('[data-demo-surface]');
  surface.scrollIntoView({ block: 'center', inline: 'center' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const box = surface.getBoundingClientRect();
  const left = Math.max(0, box.left);
  const top = Math.max(0, box.top);
  const right = Math.min(innerWidth, box.right);
  const bottom = Math.min(innerHeight, box.bottom);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top), full: [box.width, box.height] };
}

export async function offscreenCheck({ durationMs }) {
  const perf = globalThis.__neuromorphicPerf;
  const island = document.querySelector('[data-neuromorphic-demo]');
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  perf.forceQuality(null);
  const spacer = document.createElement('div');
  spacer.style.height = '6000px';
  document.body.append(spacer);
  window.scrollTo(0, document.documentElement.scrollHeight);
  await pause(600);
  const box = island.getBoundingClientRect();
  perf.reset();
  await pause(durationMs);
  const offscreen = perf.summary().counters;
  const offscreenView = { islandBottom: box.bottom, islandTop: box.top, viewportHeight: innerHeight, mode: island.dataset.mode };
  island.querySelector('[data-demo-surface]').scrollIntoView({ block: 'center' });
  await pause(600);
  perf.reset();
  await pause(durationMs);
  const resumed = perf.summary().counters;
  spacer.remove();
  return { offscreen, offscreenView, resumed };
}

export async function countersFor({ durationMs }) {
  const perf = globalThis.__neuromorphicPerf;
  perf.reset();
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  return { counters: perf.summary().counters, visibilityState: document.visibilityState };
}

export function simulateHidden(hidden) {
  if (hidden) {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  } else {
    delete document.hidden;
    delete document.visibilityState;
  }
  document.dispatchEvent(new Event('visibilitychange'));
  return document.visibilityState;
}

export async function boundaryBench({ benchUrl, bridgeUrl, spikesUrl, stimulusUrl, workerSource, ticks, repeats }) {
  const generated = await import('/wasm/neuromorphic-adapter/neuromorphic_adapter.js');
  const wasmExports = await generated.default();
  const bench = await import(benchUrl);
  const bridge = await import(bridgeUrl);
  const spikes = await import(spikesUrl);
  const stimulus = await import(stimulusUrl);
  const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
  try {
    return await bench.runBoundaryBench(
      {
        WasmAdapter: generated.WasmAdapter,
        wasmMemory: wasmExports.memory,
        initBridge: (options) =>
          bridge.initNeuromorphicAdapter(
            async () => ({ default: async () => {}, WasmAdapter: generated.WasmAdapter }),
            stimulus.DEMO_SEED,
            options,
          ),
        createSpikeEventBuffer: spikes.createSpikeEventBuffer,
        scriptedTelemetry: stimulus.scriptedTelemetry,
        DEMO_SEED: stimulus.DEMO_SEED,
        createWorker: () => new Worker(workerUrl, { type: 'module', name: 'neuromorphic-simulation-bench' }),
        moduleUrl: new URL('/wasm/neuromorphic-adapter/neuromorphic_adapter.js', location.href).href,
      },
      { ticks, repeats },
    );
  } finally {
    URL.revokeObjectURL(workerUrl);
  }
}

/**
 * Synthetic render stress through the shipped renderer seam. Topologies and
 * spikes are fixtures (`provenance: 'fixture'`), never the live path: they
 * exist only to measure how drawing cost grows with nodes, edges, and pulses.
 */
export async function renderStress({ rendererUrl, channelUrl, spikesUrl, qualityUrl, probeUrl, cases, durationMs, gpuTimer }) {
  const rendererModule = await import(rendererUrl);
  const channelModule = await import(channelUrl);
  const spikes = await import(spikesUrl);
  const qualityModule = await import(qualityUrl);
  const probeModule = await import(probeUrl);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const island = document.createElement('div');
  island.style.cssText = 'position:fixed;left:0;top:0;width:960px;height:540px;z-index:9999;background:#fff';
  const surface = document.createElement('div');
  surface.dataset.demoSurface = '';
  surface.style.cssText = 'width:100%;height:100%';
  island.append(surface);
  document.body.append(island);

  // Optional GPU timing: wrap each animation frame in a TIME_ELAPSED query.
  let gpu = null;
  if (gpuTimer) {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    let context = null;
    HTMLCanvasElement.prototype.getContext = function getContext(type, ...rest) {
      const result = originalGetContext.call(this, type, ...rest);
      if (type === 'webgl2' && result && !context) context = result;
      return result;
    };
    gpu = {
      get context() {
        return context;
      },
      restore() {
        HTMLCanvasElement.prototype.getContext = originalGetContext;
      },
    };
  }

  function topology(nodes, fanOut) {
    const sources = [];
    const targets = [];
    const weights = [];
    const delays = [];
    const polarities = [];
    const offsets = [0];
    for (let source = 0; source < nodes; source += 1) {
      const step = Math.max(1, Math.floor(nodes / (fanOut + 1)));
      const picked = new Set();
      for (let k = 1; picked.size < fanOut; k += 1) {
        const target = (source + k * step + (k > fanOut ? k : 0)) % nodes;
        if (target !== source) picked.add(target);
      }
      for (const target of [...picked].sort((a, b) => a - b)) {
        sources.push(source);
        targets.push(target);
        const inhibitory = source < nodes / 4;
        weights.push((inhibitory ? -1 : 1) * (0.2 + ((source * 7 + target * 13) % 10) / 20));
        delays.push(1 + ((source + target) % 4));
        polarities.push(inhibitory ? 1 : 0);
      }
      offsets.push(sources.length);
    }
    return {
      topologyDigest: `fixture-stress-${nodes}-${fanOut}`,
      topologyNodeIds: new Uint32Array([...Array(nodes).keys()]),
      topologyEdgeSources: new Uint32Array(sources),
      topologyEdgeTargets: new Uint32Array(targets),
      topologyEdgeWeights: new Float32Array(weights),
      topologyEdgeDelays: new Uint16Array(delays),
      topologyPolarities: new Uint8Array(polarities),
      topologyOutgoingEdgeOffsets: new Uint32Array(offsets),
    };
  }

  const results = [];
  for (const { nodes, fanOut, firing, level } of cases) {
    const fixture = topology(nodes, fanOut);
    const channel = channelModule.createSimulationChannel();
    const buffer = spikes.createSpikeEventBuffer({ provenance: 'fixture', capacity: 16384 });
    const quality = qualityModule.createAdaptiveQuality();
    // `level: null` leaves the controller adapting; record what it does.
    if (level !== null) quality.force(level);
    const timeline = [];
    let measuring = false;
    const startedAt = performance.now();
    quality.subscribe((settings) => {
      if (measuring) timeline.push({ atMs: Math.round(performance.now() - startedAt), level: settings.level, name: settings.name });
    });
    const probe = probeModule.createPerfProbe();
    const timedBuffer = { ...buffer, ingest: (snapshot) => probeModule.timed(probe, 'spike-ingest', () => buffer.ingest(snapshot)) };
    const seam = rendererModule.createTopologyRendererSeam({ channel, island, spikeEvents: timedBuffer, quality, probe });
    let step = 0n;
    const publish = () => {
      step += 1n;
      const spiking = [];
      for (let neuron = 0; neuron < nodes; neuron += 1) {
        const hash = ((neuron + 1) * 2654435761 + Number(step) * 40503) % 1000;
        if (hash < firing * 1000) spiking.push(neuron);
      }
      const potentials = new Float32Array(nodes);
      for (let neuron = 0; neuron < nodes; neuron += 1) potentials[neuron] = ((neuron * 31 + Number(step) * 17) % 100) / 100;
      channel.publish({ ...fixture, completedStep: step, spikeNeurons: new Uint32Array(spiking), membranePotentials: potentials });
    };
    publish();
    const errors = [];
    const session = await seam.create({
      cameraMotionEnabled: true,
      signal: new AbortController().signal,
      onRendererError: () => errors.push('renderer-error'),
    });
    session.resume();
    const timer = setInterval(publish, 50);

    let gpuFrames = null;
    let originalRaf = null;
    if (gpu?.context) {
      const gl = gpu.context;
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      if (ext) {
        gpuFrames = [];
        const outstanding = [];
        originalRaf = window.requestAnimationFrame;
        window.requestAnimationFrame = (callback) =>
          originalRaf.call(window, (time) => {
            const query = gl.createQuery();
            gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
            callback(time);
            gl.endQuery(ext.TIME_ELAPSED_EXT);
            outstanding.push(query);
            while (outstanding.length && gl.getQueryParameter(outstanding[0], gl.QUERY_RESULT_AVAILABLE)) {
              const done = outstanding.shift();
              if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) gpuFrames.push(gl.getQueryParameter(done, gl.QUERY_RESULT) / 1e6);
              gl.deleteQuery(done);
            }
          });
      }
    }

    await pause(500);
    probe.reset();
    if (gpuFrames) gpuFrames.length = 0;
    measuring = true;
    await pause(durationMs);
    measuring = false;
    const summary = probe.summary();
    const inspection = seam.inspect();
    if (originalRaf) window.requestAnimationFrame = originalRaf;
    clearInterval(timer);
    session.dispose();
    buffer.dispose();
    let gpuSummary = null;
    if (gpuFrames && gpuFrames.length) {
      const sorted = [...gpuFrames].sort((a, b) => a - b);
      const totalMs = sorted.reduce((sum, value) => sum + value, 0);
      gpuSummary = {
        // Every animation-frame callback, drawn or skipped by the frame cap.
        callbacks: sorted.length,
        totalMs,
        p95PerCallbackMs: sorted[Math.ceil(0.95 * sorted.length) - 1],
        maxPerCallbackMs: sorted.at(-1),
      };
    }
    const drawn = summary.counters['frames-drawn'] ?? 0;
    if (gpuSummary) gpuSummary.perDrawnFrameMs = drawn ? gpuSummary.totalMs / drawn : 0;
    results.push({
      nodes,
      fanOut,
      edges: fixture.topologyEdgeSources.length,
      firing,
      level,
      timeline,
      qualityStats: quality.stats(),
      quality: inspection?.quality,
      pixelRatio: inspection?.pixelRatio,
      eventsPerStep: Math.round(firing * nodes) * fanOut,
      meanPulsesPerDrawnFrame: drawn ? (summary.counters['pulses-drawn'] ?? 0) / drawn : 0,
      framesDrawn: drawn,
      framesSkipped: summary.counters['frames-skipped'] ?? 0,
      frameWork: summary.stages['frame-work'] ?? null,
      frameInterval: summary.stages['frame-interval'] ?? null,
      spikeIngest: summary.stages['spike-ingest'] ?? null,
      gpu: gpuSummary,
      errors,
    });
  }
  gpu?.restore();
  island.remove();
  return results;
}
