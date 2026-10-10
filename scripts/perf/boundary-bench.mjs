// WASM ↔ JavaScript boundary microbenchmarks for the live contract-5 path
// (GitHub #10 / RM-1646). Self-contained (no imports) so the same code runs in
// Node (`measure-node.mjs`) and is injected into Chrome by
// `measure-browser.mjs`. Every number is a batch mean: `performance.now()` is
// coarsened to 100 µs in Chrome, so per-call timing of microsecond work would
// only measure the clock.
//
// Dependencies are passed in so nothing here reimplements the runtime:
//   WasmAdapter   — the generated wasm-bindgen class (raw Rust/WASM boundary)
//   wasmMemory    — the module's `WebAssembly.Memory`
//   initBridge    — `(options) => Promise<NeuromorphicAdapter>` (the shipped TS bridge)
//   createSpikeEventBuffer, scriptedTelemetry, DEMO_SEED — shipped runtime modules
//   createWorker  — optional `() => Worker` running the shipped worker module

/** Deterministic busy pointer drag, identical to the native harness's `pointer-active`. */
export function pointerActivePacket(sequence) {
  const step = Number(sequence);
  const mixed = (BigInt(sequence) * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
  const jitter = (Number(mixed >> 11n) / 2 ** 53 * 2 - 1) * 0.03;
  const sweep = (period) => {
    const phase = (step / period) % 1;
    return phase < 0.5 ? phase * 2 : 2 - phase * 2;
  };
  const pressure = BigInt(sequence) % 40n < 30n ? 0.6 + jitter * 5 : 0;
  return new Float32Array([sweep(12.5) + jitter, sweep(17) - jitter, pressure]);
}

const ENCODER_MODE_IDS = { delta: 0, temporal: 1, rate: 2 };

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function summarize(perOp) {
  const sorted = [...perOp].sort((left, right) => left - right);
  return {
    medianUs: Number((median(sorted) * 1000).toFixed(3)),
    minUs: Number((sorted[0] * 1000).toFixed(3)),
    maxUs: Number((sorted.at(-1) * 1000).toFixed(3)),
  };
}

/** Time `repeats` fresh runs of `run(ticks)`; return per-tick stats in µs. */
async function batch(now, repeats, ticks, run) {
  await run(Math.min(ticks, 200)); // warm-up (JIT, WASM tier-up)
  const perOp = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const start = now();
    await run(ticks);
    perOp.push((now() - start) / ticks);
  }
  return summarize(perOp);
}

function readAllGetters(state) {
  // Every field the bridge consumes, read exactly once.
  return [
    state.contract_version, state.seed, state.completed_step, state.last_sequence,
    state.membrane_potentials, state.spike_neurons, state.topology_rows, state.topology_targets,
    state.topology_weights, state.topology_delays, state.topology_node_ids, state.topology_edge_sources,
    state.topology_edge_targets, state.topology_edge_weights, state.topology_edge_delays,
    state.topology_polarities, state.topology_weight_bits, state.topology_outgoing_edge_offsets,
    state.topology_digest, state.protocol_wire_version, state.error_status, state.encoder_mode,
    state.encoder_name, state.encoded_spike_count, state.encoded_spike_channels,
    state.encoded_spike_total, state.encoder_features,
  ];
}

function snapshotBytes(state) {
  let bytes = 0;
  for (const value of Object.values(state)) {
    if (ArrayBuffer.isView(value)) bytes += value.byteLength;
  }
  return bytes;
}

export async function runBoundaryBench(deps, options = {}) {
  const {
    WasmAdapter,
    wasmMemory,
    initBridge,
    createSpikeEventBuffer,
    scriptedTelemetry,
    DEMO_SEED,
    createWorker,
    moduleUrl,
  } = deps;
  const now = deps.now ?? (() => performance.now());
  const ticks = options.ticks ?? 2000;
  const repeats = options.repeats ?? 7;
  const workerTimeoutMs = options.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
  const modes = options.modes ?? ['delta', 'temporal', 'rate'];
  const sources = {
    scripted: scriptedTelemetry,
    'pointer-active': pointerActivePacket,
  };
  const results = [];

  for (const [sourceName, packetFor] of Object.entries(sources)) {
    for (const mode of modes) {
      const config = new Uint8Array([5, ENCODER_MODE_IDS[mode]]);
      // Enough packets for the warm-up (200) and warm-state (64) runs too.
      const packets = Array.from({ length: Math.max(ticks, 256) }, (_, index) => packetFor(BigInt(index + 1)));
      const row = { source: sourceName, mode, ticks, repeats };

      // 1. Raw `input` only: packet copy-in + kinetic-signals + axon-encoder.
      row.rawInput = await batch(now, repeats, ticks, (count) => {
        const adapter = WasmAdapter.init(DEMO_SEED, config);
        for (let index = 0; index < count; index += 1) adapter.input(BigInt(index + 1), packets[index]);
        adapter.free();
      });

      // 2. Raw `input + step`, state wrapper freed immediately: adds
      //    synaptic-wiring propagation, the neuromod step, and the Rust-side
      //    `state()` clone the contract performs every step.
      row.rawTick = await batch(now, repeats, ticks, (count) => {
        const adapter = WasmAdapter.init(DEMO_SEED, config);
        for (let index = 0; index < count; index += 1) {
          adapter.input(BigInt(index + 1), packets[index]);
          adapter.step().free();
        }
        adapter.free();
      });

      // 3. Raw `state()` alone (Rust clone + wrapper), and the getters that
      //    copy every field out of WASM memory into JS-owned arrays.
      const warm = WasmAdapter.init(DEMO_SEED, config);
      for (let index = 0; index < 64; index += 1) {
        warm.input(BigInt(index + 1), packets[index]);
        warm.step().free();
      }
      row.rawState = await batch(now, repeats, ticks, (count) => {
        for (let index = 0; index < count; index += 1) warm.state().free();
      });
      const held = warm.state();
      row.getters = await batch(now, repeats, ticks, (count) => {
        let sink = 0;
        for (let index = 0; index < count; index += 1) sink += readAllGetters(held).length;
        return sink;
      });
      held.free();
      warm.free();

      // 4. The shipped bridge: `state()` = Rust clone + getters + validation
      //    + JS-owned copies; and the full main-thread tick (`input` + `step`).
      const bridgeWarm = await initBridge({ contractVersion: 5, encoderMode: mode });
      for (let index = 0; index < 64; index += 1) {
        bridgeWarm.input(BigInt(index + 1), packets[index]);
        bridgeWarm.step();
      }
      row.bridgeState = await batch(now, repeats, ticks, (count) => {
        for (let index = 0; index < count; index += 1) bridgeWarm.state();
      });
      const snapshot = bridgeWarm.state();
      row.snapshotBytes = snapshotBytes(snapshot);
      bridgeWarm.dispose();

      const recorded = [];
      row.bridgeTick = await batch(now, repeats, ticks, async (count) => {
        const adapter = await initBridge({ contractVersion: 5, encoderMode: mode });
        recorded.length = 0;
        for (let index = 0; index < count; index += 1) {
          adapter.input(BigInt(index + 1), packets[index]);
          recorded.push(adapter.step());
        }
        adapter.dispose();
      });

      // 5. Spike-event ingestion of those real snapshots (main thread).
      let emitted = 0;
      row.spikeIngest = await batch(now, repeats, recorded.length, (count) => {
        const buffer = createSpikeEventBuffer({ provenance: 'live-wasm' });
        for (let index = 0; index < count; index += 1) buffer.ingest(recorded[index]);
        emitted = buffer.stats().emitted;
        buffer.dispose();
      });
      row.spikesPerTick = Number(
        (recorded.reduce((sum, state) => sum + state.spikeNeurons.length, 0) / recorded.length).toFixed(3),
      );
      row.eventsPerTick = Number((emitted / recorded.length).toFixed(3));

      // 6. Worker round trip: the shipped worker module, request/response per
      //    tick with the snapshot buffers transferred back.
      if (createWorker) {
        row.workerTick = await workerBatch(createWorker, moduleUrl, DEMO_SEED, mode, packets, now, repeats, ticks, workerTimeoutMs);
      }
      results.push(row);
    }
  }

  // 7. WASM linear-memory growth over a synchronous run, with and without an
  //    explicit `free()` of each step's state wrapper. Without it the wrapper's
  //    Rust allocation lives until a GC finalizer runs.
  const memory = {};
  if (wasmMemory) {
    for (const freeEach of [false, true]) {
      const adapter = WasmAdapter.init(DEMO_SEED, new Uint8Array([5, 1]));
      const before = wasmMemory.buffer.byteLength;
      for (let index = 0; index < 5000; index += 1) {
        adapter.input(BigInt(index + 1), scriptedTelemetry(BigInt(index + 1)));
        const state = adapter.step();
        if (freeEach) state.free();
      }
      memory[freeEach ? 'withFree' : 'withoutFree'] = {
        steps: 5000,
        linearMemoryBeforeBytes: before,
        linearMemoryAfterBytes: wasmMemory.buffer.byteLength,
      };
      adapter.free();
    }
  }
  return { results, memory };
}

/** Longest wait for any single worker reply (init includes the WASM load). */
export const DEFAULT_WORKER_TIMEOUT_MS = 10_000;

/**
 * Request/response over a worker with failure handling: a load error, a
 * crash (`error`), an undeserializable reply (`messageerror`), or a reply
 * that does not arrive within `timeoutMs` rejects instead of hanging the run.
 * After the first failure every pending and later request rejects with it.
 * Timers are injectable so the behaviour is testable without a real worker.
 */
export function createWorkerRequester(worker, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
  const setTimer = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle));
  const pending = new Map();
  let failure = null;

  const take = (id) => {
    const entry = pending.get(id);
    if (!entry) return null;
    pending.delete(id);
    clearTimer(entry.timer);
    return entry;
  };
  const failAll = (error) => {
    failure ??= error;
    for (const id of [...pending.keys()]) take(id).reject(failure);
  };

  worker.onmessage = (event) => {
    take(event?.data?.id)?.resolve(event.data);
  };
  worker.onerror = (event) => {
    event?.preventDefault?.();
    failAll(new Error(`benchmark worker failed: ${event?.message || 'it did not load or it crashed'}`));
  };
  worker.onmessageerror = () => failAll(new Error('benchmark worker sent a reply that could not be deserialized'));

  return {
    request(message, transfer = []) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const timer = setTimer(() => {
          if (take(message.id)) {
            reject(new Error(`benchmark worker did not answer ${message.type} #${message.id} within ${timeoutMs} ms`));
          }
        }, timeoutMs);
        pending.set(message.id, { resolve, reject, timer });
        try {
          worker.postMessage(message, transfer);
        } catch (error) {
          take(message.id);
          reject(error);
        }
      });
    },
    pending: () => pending.size,
  };
}

async function workerBatch(createWorker, moduleUrl, seed, mode, packets, now, repeats, ticks, timeoutMs) {
  const perOp = [];
  for (let repeat = 0; repeat <= repeats; repeat += 1) {
    const worker = createWorker();
    try {
      const { request } = createWorkerRequester(worker, { timeoutMs });
      let nextId = 1;
      const ready = await request({
        id: nextId++,
        type: 'init',
        seed,
        moduleUrl,
        options: { contractVersion: 5, encoderMode: mode },
      });
      if (ready.type !== 'ready') throw new Error(`worker init failed: ${ready.message}`);
      const count = repeat === 0 ? Math.min(ticks, 200) : ticks;
      const start = now();
      for (let index = 0; index < count; index += 1) {
        const samples = new Float32Array(packets[index]);
        await request({ id: nextId++, type: 'input', sequence: BigInt(index + 1), samples }, [samples.buffer]);
        const reply = await request({ id: nextId++, type: 'step' });
        if (reply.type !== 'state') throw new Error(`worker step failed: ${reply.message}`);
      }
      const elapsed = (now() - start) / count;
      worker.postMessage({ type: 'dispose' });
      if (repeat > 0) perOp.push(elapsed); // repeat 0 is the warm-up
    } finally {
      // Always release the worker, including after a failed or timed-out run.
      worker.terminate();
    }
  }
  return summarize(perOp);
}
