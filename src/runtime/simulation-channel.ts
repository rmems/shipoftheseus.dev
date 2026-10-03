import type { NeuromorphicState } from './neuromorphic-adapter';

/**
 * One-way channel carrying the latest simulation snapshot from the WASM seam to
 * the renderer seam. Rendering state stays separate from simulation state: the
 * renderer only ever sees immutable snapshots published here.
 */
export interface SimulationChannel {
  publish: (state: NeuromorphicState) => void;
  subscribe: (listener: (state: NeuromorphicState) => void) => () => void;
  latest: () => NeuromorphicState | null;
}

export function createSimulationChannel(): SimulationChannel {
  const listeners = new Set<(state: NeuromorphicState) => void>();
  let latest: NeuromorphicState | null = null;

  return {
    publish(state) {
      latest = state;
      for (const listener of listeners) {
        listener(state);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    latest() {
      return latest;
    },
  };
}
