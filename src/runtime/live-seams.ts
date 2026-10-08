import { provideDemoSeams, type DemoSeams } from './demo-runtime';
import { createPointerTelemetry, createScriptedTelemetry } from './kinetic-telemetry';
import { createSimulationChannel } from './simulation-channel';
import { createTopologyRendererSeam } from './topology-renderer';
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
 */
export function createLiveDemoSeams(island?: HTMLElement): DemoSeams {
  const channel = createSimulationChannel();
  const surface = island?.querySelector<HTMLElement>('[data-demo-surface]') ?? island;
  let latestFrame: TelemetryFrame | null = null;

  if (import.meta.env?.DEV) {
    (globalThis as { __neuromorphicTelemetry?: TelemetryInspector }).__neuromorphicTelemetry =
      inspectorFor(() => latestFrame);
  }

  return {
    renderer: createTopologyRendererSeam({ channel, island }),
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
