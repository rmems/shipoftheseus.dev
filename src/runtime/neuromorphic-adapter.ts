/** Browser-safe bridge for the generated `neuromorphic-adapter` WASM package. */
export const NEUROMORPHIC_CONTRACT_VERSION = 3;
export const CORPUS_IPC_WIRE_VERSION = 1;
const BROWSER_TOPOLOGY_DIGEST =
  'synaptic-wiring.topology.digest.v1:sha256:26875faf05121b9afda27a533760369da67ba9110599fb61533f08961ff6e971';
// Audited canonical projection for the fixed `synaptic-wiring` browser topology.
// The bridge recomputes this identity from exported contents instead of trusting
// the digest string reported by the generated Rust/WASM package.
const BROWSER_TOPOLOGY_NODE_IDS = new Uint32Array([...Array(16).keys()]);
const BROWSER_TOPOLOGY_OUTGOING_EDGE_OFFSETS = new Uint32Array(
  [...Array(17).keys()].map((index) => index * 4),
);
const BROWSER_TOPOLOGY_EDGE_SOURCES = new Uint32Array(
  [...Array(16).keys()].flatMap((source) => Array(4).fill(source)),
);
const BROWSER_TOPOLOGY_EDGE_TARGETS = new Uint32Array([
  1, 2, 12, 14, 3, 8, 12, 15, 0, 1, 3, 4, 2, 4, 5, 8,
  2, 3, 7, 14, 3, 4, 6, 7, 0, 5, 7, 8, 5, 6, 11, 15,
  6, 7, 9, 10, 8, 10, 11, 14, 4, 8, 9, 13, 9, 12, 13, 15,
  10, 11, 13, 14, 11, 12, 14, 15, 0, 9, 12, 15, 0, 5, 13, 14,
]);
const BROWSER_TOPOLOGY_EDGE_DELAYS = new Uint16Array([
  3, 1, 1, 4, 1, 4, 1, 1, 1, 2, 1, 2, 3, 1, 3, 3,
  2, 4, 1, 2, 3, 1, 3, 1, 3, 1, 4, 1, 1, 2, 1, 2,
  2, 3, 2, 3, 4, 2, 4, 4, 2, 3, 1, 2, 1, 1, 1, 4,
  1, 2, 1, 2, 2, 3, 2, 3, 3, 3, 3, 2, 2, 1, 3, 1,
]);
const BROWSER_TOPOLOGY_POLARITIES = new Uint8Array([
  ...Array(16).fill(1),
  ...Array(48).fill(0),
]);
const BROWSER_TOPOLOGY_WEIGHT_BITS = new Uint32Array([
  3210213374, 3209821784, 3205905881, 3205122701, 3209004865, 3207046914, 3205480553, 3204163308,
  3209754308, 3209362717, 3208579536, 3208187946, 3208545798, 3207762618, 3207371028, 3206196257,
  1060636822, 1060245232, 1058678871, 1054910871, 1059819904, 1059428314, 1058645133, 1058253543,
  1060569346, 1058611395, 1057828214, 1057436624, 1058186066, 1057794476, 1054708442, 1062658772,
  1057369148, 1056977558, 1055424146, 1054640966, 1055356670, 1053790309, 1063374476, 1062199706,
  1057301672, 1054506013, 1053722833, 1062165968, 1063307000, 1062132230, 1061740639, 1060957458,
  1062490082, 1062098491, 1061315310, 1060923720, 1061673163, 1061281572, 1060498392, 1060106802,
  1057166719, 1062031015, 1060856244, 1059681474, 1056518174, 1063172048, 1060039326, 1059647736,
]);
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
    raw.topology_digest !== BROWSER_TOPOLOGY_DIGEST ||
    !hasExpectedTopologyProjection(raw) ||
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
    !hasCanonicalEdgeOrder(
      raw.topology_edge_sources,
      raw.topology_edge_targets,
      raw.topology_edge_delays,
      raw.topology_polarities,
      raw.topology_weight_bits,
    ) ||
    !hasMatchingWeightBits(raw.topology_edge_weights, raw.topology_weight_bits) ||
    !hasMatchingRoutedTopology(
      raw.topology_rows,
      raw.topology_targets,
      raw.topology_weights,
      raw.topology_delays,
      raw.topology_edge_sources,
      raw.topology_edge_targets,
      raw.topology_edge_weights,
      raw.topology_edge_delays,
    ) ||
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

function hasMatchingWeightBits(weights: Float32Array, bits: Uint32Array): boolean {
  const weightBits = new Uint32Array(weights.buffer, weights.byteOffset, weights.length);
  return weightBits.every((weight, index) => weight === bits[index]);
}

function hasExpectedTopologyProjection(raw: RawWasmState): boolean {
  return (
    hasMatchingTypedArray(raw.topology_node_ids, BROWSER_TOPOLOGY_NODE_IDS) &&
    hasMatchingTypedArray(raw.topology_edge_sources, BROWSER_TOPOLOGY_EDGE_SOURCES) &&
    hasMatchingTypedArray(raw.topology_edge_targets, BROWSER_TOPOLOGY_EDGE_TARGETS) &&
    hasMatchingTypedArray(raw.topology_edge_delays, BROWSER_TOPOLOGY_EDGE_DELAYS) &&
    hasMatchingTypedArray(raw.topology_polarities, BROWSER_TOPOLOGY_POLARITIES) &&
    hasMatchingTypedArray(raw.topology_weight_bits, BROWSER_TOPOLOGY_WEIGHT_BITS) &&
    hasMatchingTypedArray(raw.topology_outgoing_edge_offsets, BROWSER_TOPOLOGY_OUTGOING_EDGE_OFFSETS)
  );
}

function hasMatchingTypedArray(
  actual: Uint8Array | Uint16Array | Uint32Array,
  expected: Uint8Array | Uint16Array | Uint32Array,
): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function hasCanonicalEdgeOrder(
  sources: Uint32Array,
  targets: Uint32Array,
  delays: Uint16Array,
  polarities: Uint8Array,
  weightBits: Uint32Array,
): boolean {
  for (let edge = 1; edge < sources.length; edge += 1) {
    const previous = edge - 1;
    if (sources[previous] !== sources[edge]) {
      if (sources[previous] > sources[edge]) return false;
      continue;
    }
    if (targets[previous] !== targets[edge]) {
      if (targets[previous] > targets[edge]) return false;
      continue;
    }
    if (delays[previous] !== delays[edge]) {
      if (delays[previous] > delays[edge]) return false;
      continue;
    }
    if (polarities[previous] !== polarities[edge]) {
      if (polarities[previous] > polarities[edge]) return false;
      continue;
    }
    if (weightBits[previous] > weightBits[edge]) return false;
  }
  return true;
}

function hasMatchingRoutedTopology(
  rows: Uint32Array,
  targets: Uint32Array,
  weights: Float32Array,
  delays: Uint16Array,
  canonicalSources: Uint32Array,
  canonicalTargets: Uint32Array,
  canonicalWeights: Float32Array,
  canonicalDelays: Uint16Array,
): boolean {
  const canonicalWeightBits = new Uint32Array(
    canonicalWeights.buffer,
    canonicalWeights.byteOffset,
    canonicalWeights.length,
  );
  const routedWeightBits = new Uint32Array(weights.buffer, weights.byteOffset, weights.length);
  const canonicalTuples = new Map<string, number>();

  for (let edge = 0; edge < canonicalSources.length; edge += 1) {
    const key = topologyTupleKey(
      canonicalSources[edge],
      canonicalTargets[edge],
      canonicalDelays[edge],
      canonicalWeightBits[edge],
    );
    canonicalTuples.set(key, (canonicalTuples.get(key) ?? 0) + 1);
  }

  for (let source = 0; source < rows.length - 1; source += 1) {
    for (let edge = rows[source]; edge < rows[source + 1]; edge += 1) {
      const key = topologyTupleKey(source, targets[edge], delays[edge], routedWeightBits[edge]);
      const remaining = canonicalTuples.get(key);
      if (!remaining) return false;
      if (remaining === 1) canonicalTuples.delete(key);
      else canonicalTuples.set(key, remaining - 1);
    }
  }

  return canonicalTuples.size === 0;
}

function topologyTupleKey(source: number, target: number, delay: number, weightBits: number): string {
  return `${source}:${target}:${delay}:${weightBits}`;
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
