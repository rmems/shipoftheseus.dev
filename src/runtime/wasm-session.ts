import {
  DEFAULT_ENCODER_MODE,
  ENCODER_MODES,
  NEUROMORPHIC_CONTRACT_VERSION_V5,
  initNeuromorphicAdapter,
  type NeuromorphicAdapter,
  type NeuromorphicState,
} from './neuromorphic-adapter';
import { DEMO_SEED, DEMO_TICK_MS } from './demo-stimulus';
import {
  createScriptedTelemetry,
  createTelemetryRecorder,
  type TelemetrySource,
  type TelemetrySourceKind,
  type TelemetryTrace,
} from './kinetic-telemetry';
import type {
  ReasonCode,
  WasmInitOptions,
  WasmSeam,
  WasmSession,
  WorkerFailurePhase,
} from './demo-runtime';
import type { SimulationChannel } from './simulation-channel';
import type { WorkerRequest, WorkerResponse } from './neuromorphic-worker';
import type { PerfProbe } from './perf-probe';

export const WASM_MODULE_URL = '/wasm/neuromorphic-adapter/neuromorphic_adapter.js';

/**
 * Live demo adapter configuration: contract 5 routes telemetry through
 * `kinetic-signals` before the default `axon-encoder` mode. The worker and the
 * main-thread fallback use the identical options.
 */
export const LIVE_ADAPTER_OPTIONS = {
  contractVersion: NEUROMORPHIC_CONTRACT_VERSION_V5,
  encoderMode: DEFAULT_ENCODER_MODE,
} as const;
const LIVE_ADAPTER_CONFIG = [
  LIVE_ADAPTER_OPTIONS.contractVersion,
  ENCODER_MODES[LIVE_ADAPTER_OPTIONS.encoderMode],
] as const;

/** Published after every completed tick for development/telemetry views. */
export interface TelemetryFrame {
  sequence: bigint;
  source: TelemetrySourceKind;
  state: NeuromorphicState;
  /** Replayable recording of this session so far (see `TelemetryTrace`). */
  trace: () => TelemetryTrace | null;
}

class SeamError extends Error {
  code: ReasonCode;

  constructor(code: ReasonCode, message: string) {
    super(message);
    this.name = 'NeuromorphicSeamError';
    this.code = code;
  }
}

interface Engine {
  input: (sequence: bigint, samples: Float32Array) => Promise<void>;
  step: () => Promise<NeuromorphicState>;
  dispose: () => void;
}

interface DriverOptions {
  telemetry: TelemetrySource;
  onFrame?: (frame: TelemetryFrame) => void;
  /** Opt-in timing (see `perf-probe.ts`); `null` in normal production visits. */
  probe?: PerfProbe | null;
}

/**
 * Fixed-cadence driver: each tick feeds one telemetry packet (pointer, or the
 * deterministic scripted path when idle), advances exactly one logical step,
 * then publishes the snapshot. Every packet is recorded so the session can be
 * replayed from `init`. rAF only controls presentation; the tick owns
 * simulation time.
 */
/** Surface an observer error without failing the caller (browser `reportError`). */
function reportObserverError(error: unknown): void {
  const report = (globalThis as { reportError?: (error: unknown) => void }).reportError;
  if (typeof report === 'function') {
    report(error);
  } else {
    console.error(error);
  }
}

function createDriver(
  engine: Engine,
  channel: SimulationChannel,
  onFailure: () => void,
  { telemetry, onFrame, probe = null }: DriverOptions,
): WasmSession {
  let timer: ReturnType<typeof setInterval> | null = null;
  let sequence = 0n;
  let inFlight = false;
  let disposed = false;
  const recorder = createTelemetryRecorder(DEMO_SEED, LIVE_ADAPTER_CONFIG);
  const trace = () => recorder.trace();
  // Frame observers (dev inspector, telemetry) are optional consumers. A
  // throwing observer must not be mistaken for a simulation failure, so its
  // error is reported and the session keeps running.
  const notifyFrame = (frame: TelemetryFrame) => {
    if (!onFrame) {
      return;
    }
    try {
      onFrame(frame);
    } catch (error) {
      reportObserverError(error);
    }
  };

  const tick = async () => {
    if (disposed || inFlight) {
      // A tick still in flight makes the simulation slip in wall-clock time
      // only; the sequence does not advance, so no step is skipped.
      if (inFlight) probe?.increment('tick-overrun');
      return;
    }
    inFlight = true;
    const started = probe ? probe.now() : 0;
    try {
      sequence += 1n;
      const packet = telemetry.sample(sequence);
      // Copy before input: the worker path transfers (detaches) the buffer.
      const recorded = Array.from(packet);
      let stageStart = probe ? probe.now() : 0;
      await engine.input(sequence, packet);
      if (probe) stageStart = lap(probe, 'tick-input', stageStart);
      const state = await engine.step();
      if (probe) stageStart = lap(probe, 'tick-step', stageStart);
      // Only completed ticks enter the recording, so it always ends at a
      // published snapshot and replays without phantom steps.
      recorder.record(sequence, recorded);
      channel.publish(state);
      if (probe) stageStart = lap(probe, 'publish', stageStart);
      notifyFrame({ sequence, source: telemetry.kind(), state, trace });
      if (probe) {
        lap(probe, 'telemetry', stageStart);
        lap(probe, 'tick', started);
        probe.increment('ticks');
        probe.mark('first-snapshot');
      }
    } catch {
      if (!disposed) {
        onFailure();
      }
    } finally {
      inFlight = false;
    }
  };

  return {
    pause() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    resume() {
      if (disposed || timer !== null) {
        return;
      }
      timer = setInterval(() => {
        void tick();
      }, DEMO_TICK_MS);
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      telemetry.dispose();
      engine.dispose();
    },
  };
}

/** Record `now - since` into `stage` and return `now`. */
function lap(probe: PerfProbe, stage: Parameters<PerfProbe['record']>[0], since: number): number {
  const now = probe.now();
  probe.record(stage, now - since);
  return now;
}

function moduleUrl(): string {
  return new URL(WASM_MODULE_URL, globalThis.location?.href ?? 'http://localhost/').href;
}

interface PendingRequest {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
}

function workerEngine(
  worker: Worker,
  signal: AbortSignal,
  onWorkerFailure: (phase: WorkerFailurePhase) => void,
): Promise<Engine> {
  let nextId = 1;
  let ready = false;
  let failed = false;
  const pending = new Map<number, PendingRequest>();

  const fail = (message: string) => {
    if (failed) {
      return;
    }
    failed = true;
    const error = new SeamError('worker-runtime-failed', message);
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
    if (ready) {
      onWorkerFailure('after-init');
    }
  };

  worker.onerror = (event) => {
    event.preventDefault();
    fail(event.message || 'simulation worker error');
  };
  worker.onmessageerror = () => fail('simulation worker message error');

  const request = (message: WorkerRequest, transfer: Transferable[] = []) =>
    new Promise<WorkerResponse>((resolve, reject) => {
      if (failed) {
        reject(new SeamError('worker-runtime-failed', 'simulation worker already failed'));
        return;
      }
      const id = 'id' in message ? message.id : 0;
      pending.set(id, { resolve, reject });
      worker.postMessage(message, transfer);
    });

  const engine: Engine = {
    async input(sequence, samples) {
      const response = await request(
        { id: nextId++, type: 'input', sequence, samples },
        [samples.buffer],
      );
      if (response.type === 'error') {
        throw new SeamError('worker-runtime-failed', response.message);
      }
    },
    async step() {
      const response = await request({ id: nextId++, type: 'step' });
      if (response.type !== 'state') {
        throw new SeamError(
          'worker-runtime-failed',
          response.type === 'error' ? response.message : 'unexpected worker reply',
        );
      }
      return response.state;
    },
    dispose() {
      worker.postMessage({ type: 'dispose' } satisfies WorkerRequest);
      worker.terminate();
    },
  };

  return new Promise<Engine>((resolve, reject) => {
    const abort = () => {
      cleanup();
      worker.terminate();
      reject(new SeamError('worker-init-failed', 'worker init aborted'));
    };
    const onMessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const id = 'id' in response ? response.id : 0;

      if (!ready) {
        if (response.type === 'ready') {
          ready = true;
          cleanup();
          resolve(engine);
        } else if (response.type === 'error') {
          cleanup();
          worker.terminate();
          reject(new SeamError('worker-init-failed', response.message));
        }
        return;
      }

      const requestEntry = pending.get(id);
      if (requestEntry) {
        pending.delete(id);
        requestEntry.resolve(response);
      }
    };
    const onEarlyError = () => {
      if (!ready) {
        cleanup();
        worker.terminate();
        reject(new SeamError('worker-init-failed', 'simulation worker failed to start'));
      }
    };
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onEarlyError);
      worker.onmessage = (event) => {
        const response = event.data as WorkerResponse;
        const entry = pending.get(response.id);
        if (entry) {
          pending.delete(response.id);
          entry.resolve(response);
        }
      };
    };

    signal.addEventListener('abort', abort, { once: true });
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onEarlyError);
    worker.postMessage({
      id: nextId++,
      type: 'init',
      seed: DEMO_SEED,
      moduleUrl: moduleUrl(),
      options: LIVE_ADAPTER_OPTIONS,
    } satisfies WorkerRequest);
  });
}

export interface WasmSeamOptions {
  channel: SimulationChannel;
  workerFactory?: () => Worker;
  mainThreadAdapter?: () => Promise<NeuromorphicAdapter>;
  /** Telemetry source per session; defaults to the scripted path. */
  telemetry?: () => TelemetrySource;
  onFrame?: (frame: TelemetryFrame) => void;
  /** Opt-in timing probe; never consulted by the simulation itself. */
  probe?: PerfProbe | null;
}

/**
 * WASM seam: prefers a dedicated module worker and retries on the bounded
 * main-thread path when workers are unavailable — the identical contract, not
 * a second implementation. Sessions publish every completed step's snapshot to
 * the simulation channel for the renderer seam to consume.
 */
export function createWasmSeam(options: WasmSeamOptions): WasmSeam {
  return {
    async init(initOptions: WasmInitOptions): Promise<WasmSession> {
      const reportFailure = () => initOptions.onWorkerFailure('after-init');
      const driver = (engine: Engine) => {
        let telemetry: TelemetrySource;
        try {
          telemetry = (options.telemetry ?? createScriptedTelemetry)();
        } catch (error) {
          // The engine is already initialized; do not leak its worker/WASM.
          engine.dispose();
          throw error;
        }
        return createDriver(engine, options.channel, reportFailure, {
          telemetry,
          onFrame: options.onFrame,
          probe: options.probe,
        });
      };

      if (initOptions.useWorker) {
        if (initOptions.signal.aborted) {
          throw new SeamError('worker-init-failed', 'worker init aborted');
        }
        const factory =
          options.workerFactory ??
          (() =>
            new Worker(new URL('./neuromorphic-worker.ts', import.meta.url), {
              type: 'module',
              name: 'neuromorphic-simulation',
            }));
        let worker: Worker;
        try {
          worker = factory();
        } catch {
          throw new SeamError('worker-unavailable', 'simulation worker is unavailable');
        }
        const engine = await workerEngine(worker, initOptions.signal, reportFailure);
        return driver(engine);
      }

      const loadAdapter =
        options.mainThreadAdapter ??
        (() =>
          initNeuromorphicAdapter(
            () => import(/* @vite-ignore */ moduleUrl()),
            DEMO_SEED,
            LIVE_ADAPTER_OPTIONS,
          ));
      try {
        const adapter = await loadAdapter();
        if (initOptions.signal.aborted) {
          adapter.dispose();
          throw new SeamError('wasm-init-failed', 'WASM init aborted');
        }
        const engine: Engine = {
          input: (sequence, samples) => {
            adapter.input(sequence, samples);
            return Promise.resolve();
          },
          step: () => Promise.resolve(adapter.step()),
          dispose: () => adapter.dispose(),
        };
        return driver(engine);
      } catch (error) {
        if (error instanceof SeamError) {
          throw error;
        }
        throw new SeamError('wasm-init-failed', error instanceof Error ? error.message : String(error));
      }
    },
  };
}
