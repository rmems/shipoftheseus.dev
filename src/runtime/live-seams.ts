import {
  createAdaptiveQuality,
  telemetryCadenceMs,
  type AdaptiveQualityController,
  type AdaptiveQualityStats,
  type QualitySettings,
} from './adaptive-quality';
import { provideDemoSeams, type DemoSeams } from './demo-runtime';
import { createPointerTelemetry, createScriptedTelemetry } from './kinetic-telemetry';
import { createPerfProbe, perfProbeRequested, timed, type PerfProbe, type PerfSummary } from './perf-probe';
import { createSimulationChannel } from './simulation-channel';
import {
  LIVE_SPIKE_EVENT_PROVENANCE,
  createSpikeEventBuffer,
  type SpikeEventBuffer,
  type SpikePropagationEvent,
} from './spike-events';
import { createInputSourceHistory, registerLiveTelemetrySources } from './telemetry-entry';
import { createTopologyRendererSeam, type TopologyRendererSeam } from './topology-renderer';
import { createWasmSeam, type TelemetryFrame } from './wasm-session';

/** Development-only inspector installed on `globalThis` by `astro dev`. */
export interface TelemetryInspector {
  latest: () => {
    sequence: string;
    source: TelemetryFrame['source'];
    encoderName: string;
    encodedSpikeCount: number;
    features: number[];
  } | null;
  trace: () => ReturnType<TelemetryFrame['trace']>;
}

function inspectorFor(frame: () => TelemetryFrame | null): TelemetryInspector {
  return {
    latest() {
      const current = frame();
      return current
        ? {
            sequence: current.sequence.toString(),
            source: current.source,
            encoderName: current.state.encoderName,
            encodedSpikeCount: current.state.encodedSpikeCount,
            features: Array.from(current.state.encoderFeatures),
          }
        : null;
    },
    trace: () => frame()?.trace() ?? null,
  };
}

/** Development-only spike-event inspector installed on `globalThis` by `astro dev`. */
export interface SpikeEventInspector {
  /** Buffer counters; `u64` steps are decimal strings. */
  stats: () => Record<string, string | number | null>;
  /** The newest buffered events (default 16), oldest first. */
  recent: (limit?: number) => Array<Record<string, string | number>>;
  /** The renderer's most recent frame, or `null` without a live session. */
  renderer: () => ReturnType<TopologyRendererSeam['inspect']>;
}

function serializeEvent(event: SpikePropagationEvent): Record<string, string | number> {
  return {
    provenance: event.provenance,
    emittedStep: event.emittedStep.toString(),
    arrivalStep: event.arrivalStep.toString(),
    sourceNeuron: event.sourceNeuron,
    targetNeuron: event.targetNeuron,
    edgeIndex: event.edgeIndex,
    delaySteps: event.delaySteps,
    polarity: event.polarity,
  };
}

/**
 * Performance inspector installed on `globalThis.__neuromorphicPerf` under
 * `astro dev` or with `?neuromorphic-perf` (see `perf-probe.ts`).
 */
export interface PerfInspector {
  summary: () => PerfSummary;
  reset: () => void;
  quality: () => AdaptiveQualityStats;
  /** Pin a quality level for measurement; `null` resumes adapting. */
  forceQuality: (level: number | null) => void;
  renderer: () => ReturnType<TopologyRendererSeam['inspect']>;
  /** Spike-event buffer counters; the `u64` step is a decimal string. */
  spikeEvents: () => Record<string, string | number | null>;
}

/** Mirror the presentation quality onto the island for DOM consumers (#9, #13). */
function reflectQuality(island: HTMLElement | undefined, settings: QualitySettings): void {
  if (!island) {
    return;
  }
  island.dataset.demoQuality = settings.name;
  island.dataset.demoTelemetryCadenceMs = String(telemetryCadenceMs(settings));
}

/** Same buffer, with `ingest` timed into the probe. */
function withIngestTiming(buffer: SpikeEventBuffer, probe: PerfProbe): SpikeEventBuffer {
  return { ...buffer, ingest: (snapshot) => timed(probe, 'spike-ingest', () => buffer.ingest(snapshot)) };
}

/** Build the development spike-event inspector (exported for tests). */
export function createSpikeEventInspector(
  buffer: SpikeEventBuffer,
  renderer: Pick<TopologyRendererSeam, 'inspect'>,
): SpikeEventInspector {
  return {
    stats() {
      const stats = buffer.stats();
      return { ...stats, latestStep: stats.latestStep?.toString() ?? null };
    },
    recent(limit = 16) {
      const events = buffer.events();
      // 0, negative, and NaN return none; anything above the size returns all.
      const count = Number.isNaN(limit) ? 0 : Math.max(0, Math.min(Math.floor(limit), events.length));
      return events.slice(events.length - count).map(serializeEvent);
    },
    renderer: () => renderer.inspect(),
  };
}

/**
 * Production seams for the live neuromorphic demo. One simulation channel per
 * island couples the WASM seam's snapshots to the renderer seam, keeping
 * rendering state separate from simulation state. `three` and the generated
 * adapter module load lazily inside the seams, so static readers never pay
 * for code they cannot run.
 *
 * Pointer/touch input over the island's render surface feeds the contract-5
 * telemetry path; without interaction the deterministic scripted path runs.
 * The island's `data-demo-input-source` reflects which source is active.
 *
 * Spike propagation events come only from this channel's WASM snapshots, so
 * the island's single spike-event buffer is tagged `live-wasm`; fixture
 * events never enter the shipped path.
 *
 * Presentation quality adapts per island (`adaptive-quality.ts`). The active
 * level and the telemetry refresh cadence are mirrored onto the island as
 * `data-demo-quality` and `data-demo-telemetry-cadence-ms`, and the renderer
 * seam exposes the controller's read side as `renderer.quality`. Quality
 * never reaches the WASM seam.
 */
export function createLiveDemoSeams(
  island?: HTMLElement,
  options: { quality?: AdaptiveQualityController; probe?: PerfProbe | null } = {},
): DemoSeams & { renderer: TopologyRendererSeam } {
  const channel = createSimulationChannel();
  const surface = island?.querySelector<HTMLElement>('[data-demo-surface]') ?? island;
  const probe =
    options.probe !== undefined
      ? options.probe
      : import.meta.env?.DEV || perfProbeRequested()
        ? createPerfProbe()
        : null;
  const quality = options.quality ?? createAdaptiveQuality();
  const spikeEvents = createSpikeEventBuffer({ provenance: LIVE_SPIKE_EVENT_PROVENANCE });
  const renderer = createTopologyRendererSeam({
    channel,
    island,
    spikeEvents: probe ? withIngestTiming(spikeEvents, probe) : spikeEvents,
    quality,
    probe,
  });
  let latestFrame: TelemetryFrame | null = null;
  const inputSources = createInputSourceHistory();
  reflectQuality(island, quality.current());
  quality.subscribe((settings) => {
    reflectQuality(island, settings);
    probe?.increment('quality-changes');
  });

  if (island) {
    // The telemetry panel (#9) reads this island's live-wasm buffer and
    // snapshots; it never feeds or steps the simulation.
    registerLiveTelemetrySources(island, {
      spikeEvents,
      channel,
      inputSource: (step) => inputSources.at(step),
    });
  }

  if (import.meta.env?.DEV) {
    (globalThis as { __neuromorphicTelemetry?: TelemetryInspector }).__neuromorphicTelemetry =
      inspectorFor(() => latestFrame);
    (globalThis as { __neuromorphicSpikeEvents?: SpikeEventInspector }).__neuromorphicSpikeEvents =
      createSpikeEventInspector(spikeEvents, renderer);
  }
  if (probe) {
    (globalThis as { __neuromorphicPerf?: PerfInspector }).__neuromorphicPerf = {
      summary: () => probe.summary(),
      reset: () => probe.reset(),
      quality: () => quality.stats(),
      forceQuality: (level) => quality.force(level),
      renderer: () => renderer.inspect(),
      spikeEvents: () => {
        const stats = spikeEvents.stats();
        return { ...stats, latestStep: stats.latestStep?.toString() ?? null };
      },
    };
  }

  return {
    renderer,
    wasm: createWasmSeam({
      channel,
      telemetry: () => (surface ? createPointerTelemetry(surface) : createScriptedTelemetry()),
      probe,
      onFrame(frame) {
        latestFrame = frame;
        inputSources.record(frame.state.completedStep, frame.source);
        if (island && island.dataset.demoInputSource !== frame.source) {
          island.dataset.demoInputSource = frame.source;
        }
      },
    }),
  };
}

export function provideLiveDemoSeams(): void {
  provideDemoSeams((island?: HTMLElement) => createLiveDemoSeams(island));
}
