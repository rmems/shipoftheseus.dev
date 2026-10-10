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
  /**
   * The site input source (`pointer`/`scripted`) of the packet that produced
   * `step`, or `null` once that step has left the recent history. Keyed by
   * step, so a paused or frozen panel still finds the source of the snapshot
   * it shows after a tick that was in flight has published a newer one.
   */
  readonly inputSource: (step: bigint) => TelemetrySourceKind | null;
}

/** Completed steps whose input source the live seams remember. */
export const INPUT_SOURCE_HISTORY_STEPS = 128;

const SOURCE_CODES: Record<TelemetrySourceKind, number> = { pointer: 1, scripted: 2 };
const SOURCE_KINDS: readonly (TelemetrySourceKind | null)[] = [null, 'pointer', 'scripted'];

export interface InputSourceHistory {
  /** Remember the source of a completed step. O(1); allocates nothing. */
  record: (step: bigint, source: TelemetrySourceKind) => void;
  /** The source of `step`, or `null` if it was never recorded or was overwritten. */
  at: (step: bigint) => TelemetrySourceKind | null;
}

/**
 * A fixed ring of the most recent completed steps' input sources, indexed by
 * step. The live seams write one slot per tick; the panel reads it only when
 * it renders.
 */
export function createInputSourceHistory(capacity: number = INPUT_SOURCE_HISTORY_STEPS): InputSourceHistory {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError('input source history capacity must be a positive integer');
  }
  const size = BigInt(capacity);
  const steps = new BigUint64Array(capacity);
  const kinds = new Uint8Array(capacity);
  return {
    record(step, source) {
      const slot = Number(step % size);
      steps[slot] = step;
      kinds[slot] = SOURCE_CODES[source] ?? 0;
    },
    at(step) {
      if (typeof step !== 'bigint' || step < 0n) {
        return null;
      }
      const slot = Number(step % size);
      return steps[slot] === step ? (SOURCE_KINDS[kinds[slot]] ?? null) : null;
    },
  };
}

/**
 * A performance budget's ceiling for the panel's refresh rate (GitHub #10).
 * It can only lower the panel's own cadence (default 4 Hz, 1 Hz under reduced
 * motion), never raise it.
 */
export interface TelemetryCadenceCap {
  /** Highest refresh rate the budget allows right now, in hertz. */
  readonly maxHz: () => number;
  /** Called on every change of `maxHz`; returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
}

const liveSources = new WeakMap<object, LiveTelemetrySources>();
const controllers = new WeakMap<object, TelemetryController>();
const cadenceCaps = new WeakMap<object, TelemetryCadenceCap>();
/** Unsubscribes the island's controller from its cap. */
const capFollowers = new WeakMap<object, () => void>();

/** Apply the island's cap to its controller now and on every change. */
function followCadenceCap(island: object): void {
  capFollowers.get(island)?.();
  capFollowers.delete(island);
  const cap = cadenceCaps.get(island);
  const controller = controllers.get(island);
  if (!cap || !controller) {
    return;
  }
  const apply = () => controller.setCadenceCapHz(cap.maxHz());
  apply();
  capFollowers.set(island, cap.subscribe(apply));
}

/**
 * Called by `live-seams.ts` with the island's adaptive quality cadence. The
 * panel picks it up when it is first opened and on every quality change.
 */
export function registerTelemetryCadenceCap(island: object, cap: TelemetryCadenceCap): void {
  cadenceCaps.set(island, cap);
  followCadenceCap(island);
}

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
  followCadenceCap(island);
  return () => {
    if (controllers.get(island) === controller) {
      capFollowers.get(island)?.();
      capFollowers.delete(island);
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
