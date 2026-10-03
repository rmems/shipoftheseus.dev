import { provideDemoSeams, type DemoSeams } from './demo-runtime';
import { createSimulationChannel } from './simulation-channel';
import { createTopologyRendererSeam } from './topology-renderer';
import { createWasmSeam } from './wasm-session';

/**
 * Production seams for the live neuromorphic demo. One simulation channel per
 * island couples the WASM seam's snapshots to the renderer seam, keeping
 * rendering state separate from simulation state. `three` and the generated
 * adapter module load lazily inside the seams, so static readers never pay
 * for code they cannot run.
 */
export function createLiveDemoSeams(island?: HTMLElement): DemoSeams {
  const channel = createSimulationChannel();
  return {
    renderer: createTopologyRendererSeam({ channel, island }),
    wasm: createWasmSeam({ channel }),
  };
}

export function provideLiveDemoSeams(): void {
  provideDemoSeams((island?: HTMLElement) => createLiveDemoSeams(island));
}
