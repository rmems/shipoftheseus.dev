// Chrome measurement harness for the live neuromorphic demo (GitHub #10 / RM-1646).
//
//   npm run build
//   node scripts/perf/measure-browser.mjs --browser "<path to chrome>" [--headed]
//        [--seconds 8] [--dpr 2] [--skip-bench] [--skip-stress] [--out results.json]
//
// Serves the built `dist/` from an in-process static server, opens the home
// page with `?neuromorphic-perf` (the production opt-in for the timing probe),
// and records: browser/GPU context, startup marks, live frame and tick timing
// per quality level with scripted and active-pointer input, offscreen and
// hidden behaviour, WASM ↔ JS boundary microbenchmarks (including the shipped
// worker), and a synthetic-topology render stress through the shipped
// renderer seam. Results go to stdout as JSON (and `--out`).
//
// `--bridge <file.ts>` swaps the TypeScript bridge used by the boundary
// benchmark (to compare revisions); `--skip-live` measures only the benchmarks;
// `--cpu-throttle <rate>` adds an adaptive-quality run on the largest synthetic
// topology under Chrome's main-thread CPU throttling.
//
// Machine-dependent and slow (minutes); never part of `npm test`. Headless
// Chrome may render WebGL in software: always read `environment.webgl.renderer`
// before treating frame numbers as GPU numbers.
import { createReadStream, readFileSync, readdirSync } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { cpus, release, totalmem, type as osType } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { argv, stdout } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';

import { pointerActivePacket } from './boundary-bench.mjs';
import { launchChrome, openPage } from './cdp.mjs';
import * as tasks from './page-tasks.mjs';
import { dataUrl, runtimeModuleSource, tsFileSource } from './ts-source.mjs';

const repository = resolve(import.meta.dirname, '..', '..');

function flag(name) {
  return argv.includes(`--${name}`);
}
function option(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
}

const browser = option('browser', process.env.BROWSER_BIN);
if (!browser) throw new Error('pass --browser <path to chrome> or set BROWSER_BIN');
const headed = flag('headed');
const seconds = Number(option('seconds', 8));
const dist = resolve(repository, option('dist', 'dist'));
const emulatedDpr = option('dpr', null);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
};
const threeBuild = join(repository, 'node_modules', 'three', 'build');

function serve(root) {
  const server = createServer(async (request, response) => {
    try {
      const { pathname } = new URL(request.url, 'http://localhost');
      let base = root;
      let relative = decodeURIComponent(pathname);
      if (relative.startsWith('/__perf/three/')) {
        base = threeBuild;
        relative = relative.slice('/__perf/three/'.length);
      }
      let file = normalize(join(base, relative));
      if (!file.startsWith(base + sep) && file !== base) throw new Error('outside root');
      let info = await stat(file).catch(() => null);
      if (info?.isDirectory()) {
        file = join(file, 'index.html');
        info = await stat(file).catch(() => null);
      }
      if (!info) {
        response.writeHead(404).end('not found');
        return;
      }
      response.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(400).end('bad request');
    }
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => resolveServer(server));
  });
}

function call(fn, argument) {
  return `(${fn.toString()})(${argument === undefined ? '' : JSON.stringify(argument)})`;
}

function bundleSizes() {
  const files = [];
  const assets = join(dist, '_astro');
  for (const name of readdirSync(assets)) {
    if (name.endsWith('.js')) files.push(join(assets, name));
  }
  files.push(join(dist, 'wasm', 'neuromorphic-adapter', 'neuromorphic_adapter.js'));
  files.push(join(dist, 'wasm', 'neuromorphic-adapter', 'neuromorphic_adapter_bg.wasm'));
  return files.map((file) => {
    const bytes = readFileSync(file);
    return {
      file: file.slice(dist.length).replaceAll('\\', '/'),
      bytes: bytes.length,
      gzipBytes: gzipSync(bytes, { level: 9 }).length,
      brotliBytes: brotliCompressSync(bytes).length,
    };
  });
}

async function drivePointer(page, box, durationMs) {
  const at = (sequence) => {
    const [x, y] = pointerActivePacket(BigInt(sequence));
    return {
      x: box.left + Math.min(0.98, Math.max(0.02, x)) * box.width,
      y: box.top + Math.min(0.98, Math.max(0.02, y)) * box.height,
    };
  };
  const send = (type, point, buttons) =>
    page.send('Input.dispatchMouseEvent', {
      type,
      x: point.x,
      y: point.y,
      button: buttons ? 'left' : 'none',
      buttons,
      clickCount: type === 'mouseMoved' ? 0 : 1,
    });
  const started = Date.now();
  let sequence = 1;
  let pressed = false;
  // ~60 Hz pointer events; pressed 3 s, released 1 s.
  while (Date.now() - started < durationMs) {
    const point = at(sequence);
    const shouldPress = (Date.now() - started) % 4000 < 3000;
    if (shouldPress && !pressed) {
      await send('mousePressed', point, 1);
      pressed = true;
    } else if (!shouldPress && pressed) {
      await send('mouseReleased', point, 0);
      pressed = false;
    }
    await send('mouseMoved', point, pressed ? 1 : 0);
    sequence += 1;
    await delay(16);
  }
  if (pressed) await send('mouseReleased', at(sequence), 0);
  return { moveEvents: sequence - 1, visibleSurface: box };
}

async function measureLive(page, report, windowMs) {
  await page.navigate(`${origin}/?neuromorphic-perf`);
  report.environment = await page.evaluate(call(tasks.environment));
  report.live = await page.evaluate(call(tasks.waitForLive));
  if (report.live.mode !== 'live') throw new Error(`demo did not go live: ${JSON.stringify(report.live)}`);
  await delay(1000);
  report.startup = await page.evaluate(call(tasks.startup));

  report.scenarios = {};
  report.scenarios['scripted-adaptive'] = await page.evaluate(call(tasks.measureWindow, { durationMs: windowMs }));
  for (const level of [0, 1, 2, 3]) {
    report.scenarios[`scripted-level-${level}`] = await page.evaluate(
      call(tasks.measureWindow, { durationMs: windowMs, level }),
    );
  }
  for (const level of [0, 3]) {
    const box = await page.evaluate(call(tasks.surfaceRect));
    if (!(box.width > 0 && box.height > 0)) throw new Error(`render surface is not visible: ${JSON.stringify(box)}`);
    const measured = page.evaluate(call(tasks.measureWindow, { durationMs: windowMs, level }));
    // Start inside the settle period so the whole measured window has input.
    await delay(200);
    const pointer = await drivePointer(page, box, windowMs + 200);
    report.scenarios[`pointer-active-level-${level}`] = { ...(await measured), pointer };
  }

  report.offscreen = await page.evaluate(call(tasks.offscreenCheck, { durationMs: 3000 }));

  // Background: minimize the real window when possible; otherwise simulate.
  const hidden = { method: 'minimize window (Browser.setWindowBounds)' };
  try {
    const { windowId } = await chrome.connection.send('Browser.getWindowForTarget', { targetId: page.targetId });
    await chrome.connection.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await delay(600);
    hidden.minimized = await page.evaluate(call(tasks.countersFor, { durationMs: 3000 }));
    await chrome.connection.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await delay(600);
  } catch (error) {
    hidden.minimizeError = String(error);
  }
  if (hidden.minimized?.visibilityState !== 'hidden') {
    hidden.method = 'simulated visibilitychange (document.hidden overridden)';
    await page.evaluate(call(tasks.simulateHidden, true));
    await delay(300);
    hidden.simulated = await page.evaluate(call(tasks.countersFor, { durationMs: 3000 }));
    await page.evaluate(call(tasks.simulateHidden, false));
  }
  await delay(800);
  hidden.resumed = await page.evaluate(call(tasks.countersFor, { durationMs: 2000 }));
  report.hidden = hidden;
}

async function measureBoundary(page, report) {
  // A page without the live island, so the benchmark does not compete with it.
  await page.navigate(`${origin}/about/`);
  const bridge = option('bridge', null);
  report.boundary = await page.evaluate(
    call(tasks.boundaryBench, {
      benchUrl: dataUrl(readFileSync(new URL('./boundary-bench.mjs', import.meta.url), 'utf8')),
      // `--bridge <file.ts>` benchmarks a bridge variant (e.g. a previous revision).
      bridgeUrl: dataUrl(
        bridge ? tsFileSource(pathToFileURL(resolve(bridge))) : runtimeModuleSource('neuromorphic-adapter'),
      ),
      spikesUrl: dataUrl(runtimeModuleSource('spike-events')),
      stimulusUrl: dataUrl(runtimeModuleSource('demo-stimulus')),
      workerSource: runtimeModuleSource('neuromorphic-worker'),
      ticks: Number(option('ticks', 2000)),
      repeats: Number(option('repeats', 7)),
    }),
    { timeoutMs: 900_000 },
  );
  report.boundary.bridge = bridge ?? 'src/runtime/neuromorphic-adapter.ts';
}

function stressModules() {
  // The renderer loads `three` by bare specifier; point it at the same
  // installed build the site bundles.
  const renderer = runtimeModuleSource('topology-renderer').replace(
    "import('three')",
    `import(${JSON.stringify(`${origin}/__perf/three/three.module.js`)})`,
  );
  return {
    rendererUrl: dataUrl(renderer),
    channelUrl: dataUrl(runtimeModuleSource('simulation-channel')),
    spikesUrl: dataUrl(runtimeModuleSource('spike-events')),
    qualityUrl: dataUrl(runtimeModuleSource('adaptive-quality')),
    probeUrl: dataUrl(runtimeModuleSource('perf-probe')),
  };
}

async function measureRenderStress(page, report, windowMs) {
  await page.navigate(`${origin}/about/`);
  report.environment ??= await page.evaluate(call(tasks.environment));
  const cases = [];
  for (const [nodes, fanOut] of [[16, 4], [64, 8], [256, 16], [1024, 32]]) {
    for (const level of [0, 1, 2, 3]) cases.push({ nodes, fanOut, firing: 0.25, level });
  }
  report.renderStress = await page.evaluate(
    call(tasks.renderStress, {
      ...stressModules(),
      cases,
      durationMs: Math.max(2000, Math.round(windowMs / 2)),
      // EXT_disjoint_timer_query_webgl2 wrapping is opt-in: on the reference
      // machine its per-frame values did not track the workload.
      gpuTimer: flag('gpu-timer') && Boolean(report.environment.webgl?.timerQueryExtension),
    }),
    { timeoutMs: 900_000 },
  );
}

/**
 * Let the controller adapt (nothing pinned) on the largest synthetic topology
 * while Chrome throttles the page's main thread (`--cpu-throttle <rate>`).
 */
async function measureAdaptiveStress(page, report, rate) {
  await page.navigate(`${origin}/about/`);
  report.environment ??= await page.evaluate(call(tasks.environment));
  await page.send('Emulation.setCPUThrottlingRate', { rate });
  try {
    report.adaptiveStress = {
      cpuThrottlingRate: rate,
      results: await page.evaluate(
        call(tasks.renderStress, {
          ...stressModules(),
          cases: [{ nodes: 1024, fanOut: 32, firing: 0.25, level: null }],
          durationMs: 20_000,
          gpuTimer: false,
        }),
        { timeoutMs: 900_000 },
      ),
    };
  } finally {
    await page.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
}

// Set during startup inside the try below, so a failure at any point (server,
// browser launch, CDP connection) still releases whatever already started.
let server = null;
let origin = null;
let chrome = null;
const report = {
  harness: 'scripts/perf/measure-browser.mjs',
  recordedAt: new Date().toISOString(),
  context: {
    mode: headed ? 'headed' : 'headless (--headless=new)',
    os: `${osType()} ${release()}`,
    cpu: cpus()[0]?.model.trim(),
    logicalCores: cpus().length,
    memoryBytes: totalmem(),
    emulatedDevicePixelRatio: emulatedDpr ? Number(emulatedDpr) : null,
  },
};

try {
  server = await serve(dist);
  origin = `http://127.0.0.1:${server.address().port}`;
  chrome = await launchChrome({ binary: browser, headless: !headed });
  report.context.browser = await chrome.connection.send('Browser.getVersion');
  const page = await openPage(chrome.connection);
  if (emulatedDpr) {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 900,
      deviceScaleFactor: Number(emulatedDpr),
      mobile: false,
    });
  }
  report.bundle = bundleSizes();
  const windowMs = seconds * 1000;
  if (!flag('skip-live')) await measureLive(page, report, windowMs);
  if (!flag('skip-bench')) await measureBoundary(page, report);
  if (!flag('skip-stress')) await measureRenderStress(page, report, windowMs);
  if (option('cpu-throttle', null)) await measureAdaptiveStress(page, report, Number(option('cpu-throttle')));
  report.pageErrors = [...page.errors];
} finally {
  await chrome?.close();
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

const json = JSON.stringify(report, null, 2);
const out = option('out', null);
if (out) await writeFile(out, `${json}\n`);
stdout.write(`${json}\n`);
