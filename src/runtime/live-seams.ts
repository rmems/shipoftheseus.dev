import { provideDemoSeams, type DemoSeams } from './demo-runtime';
import { createPointerTelemetry, createScriptedTelemetry } from './kinetic-telemetry';
import { createSimulationChannel } from './simulation-channel';
import {
  LIVE_SPIKE_EVENT_PROVENANCE,
  createSpikeEventBuffer,
  type SpikeEventBuffer,
  type SpikePropagationEvent,
} from './spike-events';
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

function spikeInspectorFor(buffer: SpikeEventBuffer, renderer: TopologyRendererSeam): SpikeEventInspector {
  return {
    stats() {
      const stats = buffer.stats();
      return { ...stats, latestStep: stats.latestStep?.toString() ?? null };
    },
    recent(limit = 16) {
      return buffer.events().slice(-limit).map(serializeEvent);
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
 */
export function createLiveDemoSeams(island?: HTMLElement): DemoSeams {
  const channel = createSimulationChannel();
  const surface = island?.querySelector<HTMLElement>('[data-demo-surface]') ?? island;
  const spikeEvents = createSpikeEventBuffer({ provenance: LIVE_SPIKE_EVENT_PROVENANCE });
  const renderer = createTopologyRendererSeam({ channel, island, spikeEvents });
  let latestFrame: TelemetryFrame | null = null;

  if (import.meta.env?.DEV) {
    (globalThis as { __neuromorphicTelemetry?: TelemetryInspector }).__neuromorphicTelemetry =
      inspectorFor(() => latestFrame);
    (globalThis as { __neuromorphicSpikeEvents?: SpikeEventInspector }).__neuromorphicSpikeEvents =
      spikeInspectorFor(spikeEvents, renderer);
  }

  return {
    renderer,
    wasm: createWasmSeam({
      channel,
      telemetry: () => (surface ? createPointerTelemetry(surface) : createScriptedTelemetry()),
      onFrame(frame) {
        latestFrame = frame;
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
