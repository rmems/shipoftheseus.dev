import {
  initNeuromorphicAdapter,
  type NeuromorphicAdapter,
  type NeuromorphicState,
} from './neuromorphic-adapter';

/**
 * Dedicated simulation worker. Mirrors the adapter's init/input/step/dispose
 * contract: every request carries a tagged id, and each step replies with a
 * fresh snapshot whose typed-array buffers are transferred (never shared) to
 * the main thread.
 */

export interface WorkerInitRequest {
  id: number;
  type: 'init';
  seed: bigint;
  moduleUrl: string;
}

export interface WorkerInputRequest {
  id: number;
  type: 'input';
  sequence: bigint;
  samples: Float32Array;
}

export interface WorkerStepRequest {
  id: number;
  type: 'step';
}

export interface WorkerDisposeRequest {
  type: 'dispose';
}

export type WorkerRequest =
  | WorkerInitRequest
  | WorkerInputRequest
  | WorkerStepRequest
  | WorkerDisposeRequest;

export type WorkerResponse =
  | { id: number; type: 'ready' }
  | { id: number; type: 'ack' }
  | { id: number; type: 'state'; state: NeuromorphicState }
  | { id: number; type: 'error'; message: string };

const ctx = self as unknown as {
  postMessage: (message: WorkerResponse, transfer?: Transferable[]) => void;
  close: () => void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

let adapter: NeuromorphicAdapter | null = null;

function postState(id: number, state: NeuromorphicState): void {
  const transfer = [
    state.membranePotentials,
    state.spikeNeurons,
    state.topologyRows,
    state.topologyTargets,
    state.topologyWeights,
    state.topologyDelays,
    state.topologyNodeIds,
    state.topologyEdgeSources,
    state.topologyEdgeTargets,
    state.topologyEdgeWeights,
    state.topologyEdgeDelays,
    state.topologyPolarities,
    state.topologyWeightBits,
    state.topologyOutgoingEdgeOffsets,
  ].map((view) => view.buffer);
  ctx.postMessage({ id, type: 'state', state }, transfer);
}

function postError(id: number, error: unknown): void {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'unknown simulation error';
  ctx.postMessage({ id, type: 'error', message });
}

ctx.onmessage = (event) => {
  const request = event.data;
  void (async () => {
    switch (request.type) {
      case 'init': {
        try {
          const moduleUrl = request.moduleUrl;
          adapter = await initNeuromorphicAdapter(
            () => import(/* @vite-ignore */ moduleUrl),
            request.seed,
          );
          ctx.postMessage({ id: request.id, type: 'ready' });
        } catch (error) {
          postError(request.id, error);
        }
        return;
      }
      case 'input': {
        if (!adapter) {
          postError(request.id, new Error('worker received input before init'));
          return;
        }
        try {
          adapter.input(request.sequence, request.samples);
          ctx.postMessage({ id: request.id, type: 'ack' });
        } catch (error) {
          postError(request.id, error);
        }
        return;
      }
      case 'step': {
        if (!adapter) {
          postError(request.id, new Error('worker received step before init'));
          return;
        }
        try {
          postState(request.id, adapter.step());
        } catch (error) {
          postError(request.id, error);
        }
        return;
      }
      case 'dispose': {
        adapter?.dispose();
        adapter = null;
        ctx.close();
        return;
      }
    }
  })();
};
