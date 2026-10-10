import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { loadTsModule, readSource } from './load-ts-module.mjs';

// Smoke coverage for the committed measurement harness (scripts/perf/). The
// harness itself is machine-dependent and never runs in `npm test`; this only
// keeps its pure parts and its wiring to the shipped runtime from rotting.
// Timing values are not asserted.
const { createWorkerRequester, pointerActivePacket, runBoundaryBench } = await import('../scripts/perf/boundary-bench.mjs');
const { launchChrome } = await import('../scripts/perf/cdp.mjs');
const adapterModule = await loadTsModule('../src/runtime/neuromorphic-adapter.ts');
const spikes = await loadTsModule('../src/runtime/spike-events.ts');
const stimulus = await loadTsModule('../src/runtime/demo-stimulus.ts');

test('the synthetic active-pointer workload is deterministic and stays on the island', () => {
  const pressures = new Set();
  let previous = null;
  let moving = 0;
  for (let sequence = 1n; sequence <= 400n; sequence += 1n) {
    const packet = pointerActivePacket(sequence);
    assert.deepEqual(packet, pointerActivePacket(sequence));
    assert.equal(packet.length, 3);
    const [x, y, pressure] = packet;
    assert.ok(x > -0.05 && x < 1.05 && y > -0.05 && y < 1.05, `packet ${sequence} leaves the island`);
    pressures.add(pressure > 0);
    if (previous && Math.hypot(x - previous[0], y - previous[1]) > 0.05) moving += 1;
    previous = packet;
  }
  assert.deepEqual([...pressures].sort(), [false, true], 'the drag presses and releases');
  assert.ok(moving > 300, 'the workload is a fast drag, not a held pointer');
});

test('the boundary benchmark runs against the committed WASM package and shipped bridge', async () => {
  const generated = await import(new URL('../public/wasm/neuromorphic-adapter/neuromorphic_adapter.js', import.meta.url).href);
  const exports = await generated.default({
    module_or_path: readFileSync(new URL('../public/wasm/neuromorphic-adapter/neuromorphic_adapter_bg.wasm', import.meta.url)),
  });
  const report = await runBoundaryBench(
    {
      WasmAdapter: generated.WasmAdapter,
      wasmMemory: exports.memory,
      initBridge: (options) =>
        adapterModule.initNeuromorphicAdapter(
          async () => ({ default: async () => {}, WasmAdapter: generated.WasmAdapter }),
          stimulus.DEMO_SEED,
          options,
        ),
      createSpikeEventBuffer: spikes.createSpikeEventBuffer,
      scriptedTelemetry: stimulus.scriptedTelemetry,
      DEMO_SEED: stimulus.DEMO_SEED,
    },
    { ticks: 20, repeats: 1, modes: ['temporal'] },
  );
  assert.deepEqual(report.results.map((row) => `${row.source}/${row.mode}`), ['scripted/temporal', 'pointer-active/temporal']);
  for (const row of report.results) {
    for (const key of ['rawInput', 'rawTick', 'rawState', 'getters', 'bridgeState', 'bridgeTick', 'spikeIngest']) {
      assert.ok(Number.isFinite(row[key].medianUs), `${key} is reported`);
    }
    assert.ok(row.snapshotBytes > 2000, 'the contract-5 snapshot carries the full topology projection');
  }
  assert.equal(
    report.memory.withFree.linearMemoryAfterBytes,
    report.memory.withFree.linearMemoryBeforeBytes,
    'freeing each state keeps WASM linear memory flat',
  );
});

test('the browser harness only runs fixture topologies through the renderer, never the live path', () => {
  const tasks = readSource('../scripts/perf/page-tasks.mjs');
  assert.match(tasks, /createSpikeEventBuffer\(\{ provenance: 'fixture'/);
  assert.doesNotMatch(tasks, /provenance: 'live-wasm'/);
  const harness = readSource('../scripts/perf/measure-browser.mjs');
  assert.match(harness, /neuromorphic-perf/);
  assert.match(readSource('../src/runtime/perf-probe.ts'), /PERF_PROBE_QUERY = 'neuromorphic-perf'/);
});

// ---------------------------------------------------------------------------
// Worker requests fail instead of hanging (PR #50 review, boundary-bench.mjs)
// ---------------------------------------------------------------------------

function fakeWorker({ throwOnPost = false } = {}) {
  const posted = [];
  return {
    posted,
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(message) {
      if (throwOnPost) throw new Error('DataCloneError');
      posted.push(message);
    },
    reply(data) {
      this.onmessage?.({ data });
    },
  };
}

function fakeTimers() {
  const timers = new Map();
  let nextId = 1;
  return {
    setTimeout(callback, ms) {
      const id = nextId++;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    active: () => timers.size,
    fireAll() {
      for (const [id, timer] of [...timers]) {
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

test('worker requests resolve by id and clear their timeouts', async () => {
  const worker = fakeWorker();
  const timers = fakeTimers();
  const requester = createWorkerRequester(worker, { timeoutMs: 50, ...timers });
  const first = requester.request({ id: 1, type: 'init' });
  const second = requester.request({ id: 2, type: 'step' });
  assert.equal(requester.pending(), 2);
  assert.equal(timers.active(), 2);
  worker.reply({ id: 2, type: 'state' });
  worker.reply({ id: 1, type: 'ready' });
  worker.reply({ id: 99, type: 'state' });
  assert.deepEqual(await first, { id: 1, type: 'ready' });
  assert.deepEqual(await second, { id: 2, type: 'state' });
  assert.equal(requester.pending(), 0);
  assert.equal(timers.active(), 0, 'answered requests leave no timer behind');
});

test('a worker that never answers times out instead of stalling the run', async () => {
  const worker = fakeWorker();
  const timers = fakeTimers();
  const requester = createWorkerRequester(worker, { timeoutMs: 50, ...timers });
  const pending = requester.request({ id: 1, type: 'init' });
  timers.fireAll();
  await assert.rejects(pending, /did not answer init #1 within 50 ms/);
  assert.equal(requester.pending(), 0);
  worker.reply({ id: 1, type: 'ready' });
});

test('a worker load error or crash rejects every pending and later request', async () => {
  for (const failure of ['error', 'messageerror']) {
    const worker = fakeWorker();
    const timers = fakeTimers();
    const requester = createWorkerRequester(worker, { timeoutMs: 50, ...timers });
    const pending = [requester.request({ id: 1, type: 'input' }), requester.request({ id: 2, type: 'step' })];
    let prevented = false;
    if (failure === 'error') {
      worker.onerror({ message: 'Failed to load module script', preventDefault: () => (prevented = true) });
    } else {
      worker.onmessageerror({});
    }
    for (const request of pending) {
      await assert.rejects(request, failure === 'error' ? /Failed to load module script/ : /could not be deserialized/);
    }
    if (failure === 'error') assert.equal(prevented, true, 'the error is handled, not reported as uncaught');
    assert.equal(timers.active(), 0, 'failed requests leave no timer behind');
    await assert.rejects(requester.request({ id: 3, type: 'step' }), failure === 'error' ? /Failed to load/ : /deserialized/);
  }
});

test('a request whose message cannot be posted rejects at once', async () => {
  const timers = fakeTimers();
  const requester = createWorkerRequester(fakeWorker({ throwOnPost: true }), { timeoutMs: 50, ...timers });
  await assert.rejects(requester.request({ id: 1, type: 'input' }), /DataCloneError/);
  assert.equal(requester.pending(), 0);
  assert.equal(timers.active(), 0);
});

// ---------------------------------------------------------------------------
// A failed browser start releases the process and its profile (PR #50 review)
// ---------------------------------------------------------------------------

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A stand-in "browser": a Node script that may write DevToolsActivePort, then idles. */
async function fakeBrowser(root, { port = null } = {}) {
  const script = join(root, 'fake-browser.mjs');
  writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const profile = process.argv.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
writeFileSync(${JSON.stringify(join(root, 'pid'))}, String(process.pid));
${port === null ? '' : `writeFileSync(join(profile, 'DevToolsActivePort'), '${port}\\n/devtools/browser/fake');`}
setInterval(() => {}, 1000);
`,
  );
  return script;
}

async function profilesIn(root) {
  return readdirSync(root).filter((name) => name.startsWith('neuromorphic-perf-chrome-'));
}

test('launchChrome kills the browser and removes its profile when CDP cannot connect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perf-harness-cdp-'));
  try {
    const script = await fakeBrowser(root, { port: await closedPort() });
    await assert.rejects(
      launchChrome({ binary: process.execPath, binaryArgs: [script], profileRoot: root, startupTimeoutMs: 5000 }),
      /could not connect|timed out connecting/,
    );
    const pid = Number(readFileSync(join(root, 'pid'), 'utf8'));
    assert.equal(isAlive(pid), false, 'the browser process was killed');
    assert.deepEqual(await profilesIn(root), [], 'the temporary profile was removed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('launchChrome cleans up when the browser never exposes an endpoint or cannot start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perf-harness-cdp-'));
  try {
    const script = await fakeBrowser(root);
    await assert.rejects(
      launchChrome({ binary: process.execPath, binaryArgs: [script], profileRoot: root, startupTimeoutMs: 300 }),
      /did not expose a DevTools endpoint/,
    );
    const pid = Number(readFileSync(join(root, 'pid'), 'utf8'));
    assert.equal(isAlive(pid), false, 'the silent browser was killed');
    assert.deepEqual(await profilesIn(root), []);

    await assert.rejects(
      launchChrome({ binary: join(root, 'no-such-browser.exe'), profileRoot: root, startupTimeoutMs: 2000 }),
      /could not start the browser|exited during startup/,
    );
    assert.deepEqual(await profilesIn(root), [], 'a binary that cannot spawn leaves no profile either');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('measure-browser starts its server and browser inside the cleanup block', () => {
  const harness = readSource('../scripts/perf/measure-browser.mjs');
  const start = /\r?\ntry \{\r?\n {2}server = await serve\(dist\);/.exec(harness);
  assert.ok(start, 'the server starts inside try');
  assert.ok(harness.indexOf('chrome = await launchChrome(', start.index) > start.index, 'the browser starts inside try');
  assert.match(harness, /\} finally \{\r?\n {2}await chrome\?\.close\(\);\r?\n {2}if \(server\) \{/);
});
