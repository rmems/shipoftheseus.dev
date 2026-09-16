/** Browser-safe bridge for the generated `neuromorphic-adapter` WASM package. */
export const NEUROMORPHIC_CONTRACT_VERSION = 1;
export const CORPUS_IPC_WIRE_VERSION = 1;

export interface NeuromorphicState {
  contractVersion: number;
  seed: bigint;
  completedStep: bigint;
  lastSequence: bigint;
  membranePotentials: Float32Array;
  spikeNeurons: Uint32Array;
  topologyRows: Uint32Array;
  topologyTargets: Uint32Array;
  topologyWeights: Float32Array;
  topologyDelays: Uint16Array;
  topologyDigest: string;
  protocolWireVersion: number;
}

interface RawWasmState {
  contract_version: number;
  seed: bigint;
  completed_step: bigint;
  last_sequence: bigint;
  membrane_potentials: Float32Array;
  spike_neurons: Uint32Array;
  topology_rows: Uint32Array;
  topology_targets: Uint32Array;
  topology_weights: Float32Array;
  topology_delays: Uint16Array;
  topology_digest: string;
  protocol_wire_version: number;
}

interface RawWasmAdapter {
  input(sequence: bigint, samples: Float32Array): void;
  step(): RawWasmState;
  state(): RawWasmState;
  dispose(): void;
}

export interface NeuromorphicWasmModule {
  default(): Promise<unknown>;
  WasmAdapter: {
    init(seed: bigint, config: Uint8Array): RawWasmAdapter;
  };
}

export interface NeuromorphicAdapter {
  input(sequence: bigint, samples: Float32Array): void;
  step(): NeuromorphicState;
  state(): NeuromorphicState;
  dispose(): void;
}

export class AdapterUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterUnavailableError';
  }
}

function snapshot(raw: RawWasmState): NeuromorphicState {
  if (
    !raw ||
    typeof raw !== 'object' ||
    raw.contract_version !== NEUROMORPHIC_CONTRACT_VERSION ||
    typeof raw.seed !== 'bigint' ||
    typeof raw.completed_step !== 'bigint' ||
    typeof raw.last_sequence !== 'bigint' ||
    !(raw.membrane_potentials instanceof Float32Array) ||
    !(raw.spike_neurons instanceof Uint32Array) ||
    !(raw.topology_rows instanceof Uint32Array) ||
    !(raw.topology_targets instanceof Uint32Array) ||
    !(raw.topology_weights instanceof Float32Array) ||
    !(raw.topology_delays instanceof Uint16Array) ||
    raw.topology_rows.length < 2 ||
    raw.topology_rows[0] !== 0 ||
    raw.topology_rows[raw.topology_rows.length - 1] !== raw.topology_targets.length ||
    raw.topology_targets.length !== raw.topology_weights.length ||
    raw.topology_targets.length !== raw.topology_delays.length ||
    raw.membrane_potentials.length !== raw.topology_rows.length - 1 ||
    !raw.topology_digest.trim() ||
    raw.protocol_wire_version !== CORPUS_IPC_WIRE_VERSION ||
    !allFinite(raw.membrane_potentials) ||
    !allFinite(raw.topology_weights) ||
    !isMonotonicTopologyRows(raw.topology_rows) ||
    !hasValidTopologyTargets(raw.topology_targets, raw.topology_rows.length - 1)
  ) {
    throw new AdapterUnavailableError('The Rust/WASM runtime returned an invalid contract state.');
  }

  return {
    contractVersion: raw.contract_version,
    seed: raw.seed,
    completedStep: raw.completed_step,
    lastSequence: raw.last_sequence,
    membranePotentials: new Float32Array(raw.membrane_potentials),
    spikeNeurons: new Uint32Array(raw.spike_neurons),
    topologyRows: new Uint32Array(raw.topology_rows),
    topologyTargets: new Uint32Array(raw.topology_targets),
    topologyWeights: new Float32Array(raw.topology_weights),
    topologyDelays: new Uint16Array(raw.topology_delays),
    topologyDigest: raw.topology_digest,
    protocolWireVersion: raw.protocol_wire_version,
  };
}

function allFinite(values: Float32Array): boolean {
  return values.every(Number.isFinite);
}

function isMonotonicTopologyRows(rows: Uint32Array): boolean {
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index - 1] > rows[index]) {
      return false;
    }
  }
  return true;
}

function hasValidTopologyTargets(targets: Uint32Array, nodeCount: number): boolean {
  return targets.every((target) => target < nodeCount);
}

/**
 * Defers WASM loading until the Astro island chooses progressive enhancement.
 * Neither the static document nor fallback UI imports a generated package.
 */
export async function initNeuromorphicAdapter(
  loadWasmModule: () => Promise<NeuromorphicWasmModule>,
  seed: bigint,
): Promise<NeuromorphicAdapter> {
  if (typeof WebAssembly === 'undefined') {
    throw new AdapterUnavailableError('WebAssembly is unavailable in this browser.');
  }

  const wasm = await loadWasmModule();
  await wasm.default();
  const runtime = wasm.WasmAdapter.init(seed, new Uint8Array([NEUROMORPHIC_CONTRACT_VERSION]));
  let disposed = false;

  const ensureActive = (): void => {
    if (disposed) {
      throw new AdapterUnavailableError('The Rust/WASM runtime has already been disposed.');
    }
  };

  return {
    input(sequence, samples) {
      ensureActive();
      runtime.input(sequence, new Float32Array(samples));
    },
    step() {
      ensureActive();
      return snapshot(runtime.step());
    },
    state() {
      ensureActive();
      return snapshot(runtime.state());
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        runtime.dispose();
      }
    },
  };
}
