/** Browser-safe bridge for the generated `neuromorphic-adapter` WASM package. */
export const NEUROMORPHIC_CONTRACT_VERSION = 1;
export const CORPUS_IPC_WIRE_VERSION = 1;
const MAX_U64 = (1n << 64n) - 1n;
const RUNTIME_ERROR_STATUSES = new Set([
  'ok',
  'input-sequence-not-increasing',
  'input-non-finite-samples',
  'step-propagation-failed',
  'step-neuromod-failed',
  'step-spike-index-out-of-range',
]);

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
  topologyNodeIds: Uint32Array;
  topologyEdgeSources: Uint32Array;
  topologyEdgeTargets: Uint32Array;
  topologyEdgeWeights: Float32Array;
  topologyEdgeDelays: Uint16Array;
  topologyPolarities: Uint8Array;
  topologyWeightBits: Uint32Array;
  topologyOutgoingEdgeOffsets: Uint32Array;
  topologyDigest: string;
  protocolWireVersion: number;
  errorStatus: string;
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
  topology_node_ids: Uint32Array;
  topology_edge_sources: Uint32Array;
  topology_edge_targets: Uint32Array;
  topology_edge_weights: Float32Array;
  topology_edge_delays: Uint16Array;
  topology_polarities: Uint8Array;
  topology_weight_bits: Uint32Array;
  topology_outgoing_edge_offsets: Uint32Array;
  topology_digest: string;
  protocol_wire_version: number;
  error_status: string;
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
    !isU64(raw.seed) ||
    !isU64(raw.completed_step) ||
    !isU64(raw.last_sequence) ||
    !(raw.membrane_potentials instanceof Float32Array) ||
    !(raw.spike_neurons instanceof Uint32Array) ||
    !(raw.topology_rows instanceof Uint32Array) ||
    !(raw.topology_targets instanceof Uint32Array) ||
    !(raw.topology_weights instanceof Float32Array) ||
    !(raw.topology_delays instanceof Uint16Array) ||
    !(raw.topology_node_ids instanceof Uint32Array) ||
    !(raw.topology_edge_sources instanceof Uint32Array) ||
    !(raw.topology_edge_targets instanceof Uint32Array) ||
    !(raw.topology_edge_weights instanceof Float32Array) ||
    !(raw.topology_edge_delays instanceof Uint16Array) ||
    !(raw.topology_polarities instanceof Uint8Array) ||
    !(raw.topology_weight_bits instanceof Uint32Array) ||
    !(raw.topology_outgoing_edge_offsets instanceof Uint32Array) ||
    raw.topology_rows.length < 2 ||
    raw.topology_rows[0] !== 0 ||
    raw.topology_rows.at(-1) !== raw.topology_targets.length ||
    raw.topology_targets.length !== raw.topology_weights.length ||
    raw.topology_targets.length !== raw.topology_delays.length ||
    raw.topology_edge_sources.length !== raw.topology_targets.length ||
    raw.topology_edge_sources.length !== raw.topology_edge_targets.length ||
    raw.topology_edge_sources.length !== raw.topology_edge_weights.length ||
    raw.topology_edge_sources.length !== raw.topology_edge_delays.length ||
    raw.topology_edge_sources.length !== raw.topology_polarities.length ||
    raw.topology_edge_sources.length !== raw.topology_weight_bits.length ||
    raw.topology_node_ids.length !== raw.topology_rows.length - 1 ||
    raw.topology_outgoing_edge_offsets.length !== raw.topology_node_ids.length + 1 ||
    raw.topology_outgoing_edge_offsets[0] !== 0 ||
    raw.topology_outgoing_edge_offsets.at(-1) !== raw.topology_edge_sources.length ||
    raw.membrane_potentials.length !== raw.topology_rows.length - 1 ||
    typeof raw.topology_digest !== 'string' ||
    !raw.topology_digest.trim() ||
    raw.protocol_wire_version !== CORPUS_IPC_WIRE_VERSION ||
    typeof raw.error_status !== 'string' ||
    !RUNTIME_ERROR_STATUSES.has(raw.error_status) ||
    !allFinite(raw.membrane_potentials) ||
    !allFinite(raw.topology_weights) ||
    !allFinite(raw.topology_edge_weights) ||
    !isMonotonicTopologyRows(raw.topology_rows) ||
    !hasValidTopologyTargets(raw.topology_targets, raw.topology_rows.length - 1) ||
    !hasValidTopologyTargets(raw.topology_edge_sources, raw.topology_node_ids.length) ||
    !hasValidTopologyTargets(raw.topology_edge_targets, raw.topology_node_ids.length) ||
    !hasValidTopologyTargets(raw.topology_node_ids, raw.topology_node_ids.length) ||
    !hasValidTopologyTargets(raw.topology_outgoing_edge_offsets, raw.topology_edge_sources.length + 1) ||
    !raw.topology_polarities.every((polarity) => polarity === 0 || polarity === 1) ||
    !isMonotonicTopologyRows(raw.topology_outgoing_edge_offsets) ||
    !hasCanonicalOutgoingEdges(raw.topology_node_ids, raw.topology_edge_sources, raw.topology_outgoing_edge_offsets) ||
    !hasValidSpikeNeurons(raw.spike_neurons, raw.membrane_potentials.length)
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
    topologyNodeIds: new Uint32Array(raw.topology_node_ids),
    topologyEdgeSources: new Uint32Array(raw.topology_edge_sources),
    topologyEdgeTargets: new Uint32Array(raw.topology_edge_targets),
    topologyEdgeWeights: new Float32Array(raw.topology_edge_weights),
    topologyEdgeDelays: new Uint16Array(raw.topology_edge_delays),
    topologyPolarities: new Uint8Array(raw.topology_polarities),
    topologyWeightBits: new Uint32Array(raw.topology_weight_bits),
    topologyOutgoingEdgeOffsets: new Uint32Array(raw.topology_outgoing_edge_offsets),
    topologyDigest: raw.topology_digest,
    protocolWireVersion: raw.protocol_wire_version,
    errorStatus: raw.error_status,
  };
}

function isU64(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_U64;
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

function hasValidSpikeNeurons(spikes: Uint32Array, nodeCount: number): boolean {
  return spikes.every((spike) => spike < nodeCount);
}

function hasCanonicalOutgoingEdges(
  nodeIds: Uint32Array,
  sources: Uint32Array,
  offsets: Uint32Array,
): boolean {
  for (let node = 0; node < nodeIds.length; node += 1) {
    if (nodeIds[node] !== node) return false;
    for (let edge = offsets[node]; edge < offsets[node + 1]; edge += 1) {
      if (sources[edge] !== nodeIds[node]) return false;
    }
  }
  return true;
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
  if (!isU64(seed)) {
    throw new AdapterUnavailableError('The Rust/WASM runtime seed must be a u64 value.');
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
      if (!isU64(sequence)) {
        throw new AdapterUnavailableError('The Rust/WASM input sequence must be a u64 value.');
      }
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
