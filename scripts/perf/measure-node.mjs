// WASM ↔ JS boundary measurements in Node, against the committed `web` package
// and the shipped TypeScript bridge (GitHub #10 / RM-1646).
//
//   node scripts/perf/measure-node.mjs [--ticks 2000] [--repeats 7] [--json] [--bridge <file.ts>]
//
// `--bridge` benchmarks a bridge variant (e.g. a previous revision of
// `src/runtime/neuromorphic-adapter.ts`) instead of the shipped one.
//
// Node's V8 is not Chrome's, and Node has no worker-transfer path here, so
// treat these as a second engine data point; `measure-browser.mjs` is the
// Chrome measurement. Machine-dependent; never part of `npm test`.
import { readFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { argv, arch, platform, stdout, versions } from 'node:process';
import { pathToFileURL } from 'node:url';

import { runBoundaryBench } from './boundary-bench.mjs';
import { dataUrl, runtimeModuleSource, tsFileSource } from './ts-source.mjs';

function option(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? Number(argv[index + 1]) : fallback;
}

const packageUrl = new URL('../../public/wasm/neuromorphic-adapter/', import.meta.url);
const generated = await import(new URL('neuromorphic_adapter.js', packageUrl).href);
const exports = await generated.default({
  module_or_path: readFileSync(new URL('neuromorphic_adapter_bg.wasm', packageUrl)),
});
const bridgeIndex = argv.indexOf('--bridge');
const bridgeFile = bridgeIndex >= 0 ? argv[bridgeIndex + 1] : null;
const bridge = await import(
  dataUrl(bridgeFile ? tsFileSource(pathToFileURL(resolve(bridgeFile))) : runtimeModuleSource('neuromorphic-adapter')),
);
const spikes = await import(dataUrl(runtimeModuleSource('spike-events')));
const stimulus = await import(dataUrl(runtimeModuleSource('demo-stimulus')));

const report = await runBoundaryBench(
  {
    WasmAdapter: generated.WasmAdapter,
    wasmMemory: exports.memory,
    initBridge: (options) =>
      bridge.initNeuromorphicAdapter(
        async () => ({ default: async () => {}, WasmAdapter: generated.WasmAdapter }),
        stimulus.DEMO_SEED,
        options,
      ),
    createSpikeEventBuffer: spikes.createSpikeEventBuffer,
    scriptedTelemetry: stimulus.scriptedTelemetry,
    DEMO_SEED: stimulus.DEMO_SEED,
  },
  { ticks: option('ticks', 2000), repeats: option('repeats', 7) },
);

const context = {
  bridge: bridgeFile ?? 'src/runtime/neuromorphic-adapter.ts',
  engine: `Node ${versions.node} (V8 ${versions.v8})`,
  platform: `${platform}-${arch}`,
  cpu: cpus()[0]?.model.trim(),
  logicalCores: cpus().length,
  memoryBytes: totalmem(),
};

if (argv.includes('--json')) {
  stdout.write(`${JSON.stringify({ context, ...report }, null, 2)}\n`);
} else {
  stdout.write(`# WASM boundary (Node) — ${context.engine}, ${context.cpu}, ${context.platform}\n`);
  stdout.write('| input | mode | raw input µs | raw input+step µs | raw state() µs | getters µs | bridge state() µs | bridge tick µs | spike ingest µs | spikes/tick | events/tick | snapshot bytes |\n');
  stdout.write('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n');
  for (const row of report.results) {
    stdout.write(
      `| ${row.source} | ${row.mode} | ${row.rawInput.medianUs} | ${row.rawTick.medianUs} | ${row.rawState.medianUs} | ${row.getters.medianUs} | ${row.bridgeState.medianUs} | ${row.bridgeTick.medianUs} | ${row.spikeIngest.medianUs} | ${row.spikesPerTick} | ${row.eventsPerTick} | ${row.snapshotBytes} |\n`,
    );
  }
  stdout.write(`\nWASM linear memory over 5000 synchronous steps: ${JSON.stringify(report.memory)}\n`);
}
