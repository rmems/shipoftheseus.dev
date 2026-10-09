import type { TelemetryController } from './demo-telemetry';
import type { TelemetrySourceKind } from './kinetic-telemetry';
import type { SimulationChannel } from './simulation-channel';
import { LIVE_SPIKE_EVENT_PROVENANCE, type SpikeEventBuffer } from './spike-events';

/**
 * The always-loaded part of the demo telemetry panel (GitHub #9): the
 * per-island registry of live sources and controllers, and a binder that
 * loads the panel's logic (`demo-telemetry.ts`) and view
 * (`telemetry-view.ts`) only when a reader first opens the panel. A page
 * whose panel stays closed never downloads or runs that code.
 */

/** What the live seams give the telemetry panel. Nothing here is writable. */
export interface LiveTelemetrySources {
  /** The island's spike-event buffer. Must be the `live-wasm` buffer. */
  readonly spikeEvents: Pick<SpikeEventBuffer, 'provenance' | 'subscribe' | 'stats'>;
  /** The island's simulation channel; telemetry only reads `latest()`. */
  readonly channel: Pick<SimulationChannel, 'latest'>;
  /** Where the latest telemetry packet came from (site DOM input). */
  readonly inputSource: () => TelemetrySourceKind | null;
}

const liveSources = new WeakMap<object, LiveTelemetrySources>();
const controllers = new WeakMap<object, TelemetryController>();

/**
 * Called by `live-seams.ts` for each island. Only the `live-wasm` buffer may
 * back the panel, so a mislabeled source fails here instead of in the UI.
 */
export function registerLiveTelemetrySources(island: object, sources: LiveTelemetrySources): void {
  if (sources.spikeEvents.provenance !== LIVE_SPIKE_EVENT_PROVENANCE) {
    throw new RangeError('demo telemetry reads only the live-wasm spike-event buffer');
  }
  liveSources.set(island, sources);
}

export function liveTelemetrySources(island: object): LiveTelemetrySources | null {
  return liveSources.get(island) ?? null;
}

/** Record the island's bound controller; returns the matching unregister. */
export function registerDemoTelemetry(island: object, controller: TelemetryController): () => void {
  controllers.set(island, controller);
  return () => {
    if (controllers.get(island) === controller) {
      controllers.delete(island);
    }
  };
}

/**
 * The island's telemetry controller, so a performance budget can lower the
 * refresh rate (`setCadenceHz`) or turn telemetry off (`setEnabled(false)`)
 * without touching the simulation. `null` until the panel is first opened,
 * when telemetry costs nothing.
 */
export function getDemoTelemetry(island: object): TelemetryController | null {
  return controllers.get(island) ?? null;
}

interface PanelHost {
  querySelector?: (selector: string) => Element | null;
}

/**
 * Bind the island's telemetry panel, loading its code on first open. Returns
 * `null` for an island without a panel. If loading fails, the panel keeps its
 * static explanation and the next open retries.
 */
export function bindDemoTelemetryPanel(island: HTMLElement): { dispose: () => void } | null {
  const panel = (island as PanelHost).querySelector?.('details[data-demo-telemetry]') as HTMLDetailsElement | null | undefined;
  if (!panel) {
    return null;
  }
  let disposed = false;
  let loading = false;
  let binding: { dispose: () => void } | null = null;

  const load = () => {
    if (loading || disposed) {
      return;
    }
    loading = true;
    import('./telemetry-view')
      .then(({ bindDemoTelemetry }) => {
        if (!disposed) {
          binding = bindDemoTelemetry(island);
        }
      })
      .catch(() => {
        loading = false;
      });
  };
  const onToggle = () => {
    if (panel.open) {
      load();
    }
  };
  panel.addEventListener('toggle', onToggle);
  if (panel.open) {
    load();
  }

  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      panel.removeEventListener('toggle', onToggle);
      binding?.dispose();
      binding = null;
    },
  };
}
