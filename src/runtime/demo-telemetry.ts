import { type ExecutionOrigin } from '../native-evidence/view';
import { DEMO_TICK_MS } from './demo-stimulus';
import type { TelemetrySourceKind } from './kinetic-telemetry';
import {
  ENCODER_FEATURE_COUNT,
  NEUROMORPHIC_CONTRACT_VERSION_V4,
  NEUROMORPHIC_CONTRACT_VERSION_V5,
  type NeuromorphicState,
} from './neuromorphic-adapter';
import {
  LIVE_SPIKE_EVENT_PROVENANCE,
  delayStepsToMs,
  type SpikeEventProvenance,
  type SpikeStepBatch,
} from './spike-events';
import type { LiveTelemetrySources } from './telemetry-entry';

/**
 * Live telemetry for the neuromorphic demo (GitHub #9 / Linear RM-1652).
 *
 * This module is the DOM-free half of the telemetry panel: a fixed-size spike
 * raster ring, a throttled flush scheduler, the per-neuron and per-encoder
 * inspection models, and the controller that ties them to the live seams.
 * `telemetry-view.ts` only writes what the controller hands it. Both load on
 * first open of the panel (see `telemetry-entry.ts`, which holds the source
 * registry the live seams fill).
 *
 * **Sources.** Telemetry never computes or synthesizes simulation values.
 * Spikes come from the island's single `live-wasm` spike-event buffer
 * (`spike-events.ts`), which maps `neuromod` output spikes through the same
 * snapshot's `synaptic-wiring` projection. Everything else (membrane
 * potentials, topology, encoder mode and diagnostics, `kinetic-signals`
 * features) is read from the matching Rust/WASM snapshot on the simulation
 * channel. Fields the runtime does not export (for example the firing
 * threshold) are absent from every model here.
 *
 * **Cost.** Sampling happens only while the panel is open and enabled: one
 * buffer subscription that writes a few bytes per step into the raster ring.
 * DOM work happens in flushes, coalesced to a cadence that is independent of
 * the 20 Hz simulation step and of the display frame rate. A closed panel
 * holds no subscription, no timer, and no observer.
 */

/** Default panel refresh rate. */
export const DEFAULT_TELEMETRY_HZ = 4;
/** Refresh cap while `prefers-reduced-motion: reduce` applies. */
export const REDUCED_MOTION_TELEMETRY_HZ = 1;
/** One refresh per logical step is the most that can show new data. */
export const MAX_TELEMETRY_HZ = 1000 / DEMO_TICK_MS;
/** Steps the raster keeps (6 s at the 50 ms live step). */
export const DEFAULT_RASTER_STEPS = 120;
/** Upper bound on raster rows per step, so a bad snapshot cannot allocate unboundedly. */
export const MAX_RASTER_NEURONS = 1024;
/** Spike steps listed per inspected neuron. */
export const RECENT_SPIKE_LIMIT = 8;

/** Crate layers named next to each telemetry block. */
export type TelemetryLayer = 'kinetic-signals' | 'axon-encoder' | 'neuromod' | 'synaptic-wiring';

/**
 * Contract-5 `encoder_features` layout (`crates/neuromorphic-adapter/src/kinetic.rs`
 * `channel`). Indices are contract; these are display names only.
 */
export const KINETIC_FEATURE_LABELS: readonly string[] = Object.freeze([
  'x',
  'y',
  'pressure',
  '+vx',
  '−vx',
  '+vy',
  '−vy',
  'speed',
  'speed EMA 3',
  'speed EMA 12',
  '|Δ speed|',
  'speed volatility',
  'speed surprise',
  'pressure EMA 8',
  'x EMA 6',
  'y EMA 6',
]);

/** Status shown before any script runs, and whenever no live runtime is connected. */
export const TELEMETRY_STATIC_STATUS =
  'Telemetry reads the live Rust/WASM runtime. It needs JavaScript, WebGL, and WebAssembly; without them the static diagram is the complete demo.';

/** Report a telemetry failure without letting it reach the simulation. */
function reportTelemetryError(error: unknown): void {
  const host = globalThis as { reportError?: (error: unknown) => void };
  if (typeof host.reportError === 'function') {
    host.reportError(error);
    return;
  }
  queueMicrotask(() => {
    throw error;
  });
}

// ---------------------------------------------------------------------------
// Spike raster ring
// ---------------------------------------------------------------------------

/** The snapshot fields one raster row reads, from the batch's own snapshot. */
export type RasterSnapshot = Pick<
  NeuromorphicState,
  'completedStep' | 'topologyDigest' | 'topologyNodeIds' | 'encodedSpikeCount'
>;

export interface SpikeRasterStats {
  provenance: SpikeEventProvenance;
  capacity: number;
  rows: number;
  neuronCount: number;
  oldestStep: bigint | null;
  latestStep: bigint | null;
  topologyDigest: string | null;
  /** Lifetime counters (they survive `reset`). */
  recordedSteps: number;
  evictedRows: number;
  gapRows: number;
  resets: number;
}

/**
 * A fixed ring of the most recent steps × neurons. Rows are contiguous steps,
 * oldest first; a skipped step becomes an unsampled gap row rather than being
 * collapsed, so columns always mean consecutive simulation steps.
 */
export interface SpikeRaster {
  readonly provenance: SpikeEventProvenance;
  readonly capacity: number;
  /**
   * Record one step: `neuromod` spikes from the spike-event batch and the
   * `axon-encoder` count from the same step's snapshot. Atomic: a batch that
   * does not match its snapshot, or names a neuron outside the topology,
   * throws a `RangeError` and changes nothing.
   */
  record: (batch: Pick<SpikeStepBatch, 'provenance' | 'step' | 'topologyDigest' | 'spikeNeurons'>, snapshot: RasterSnapshot) => void;
  size: () => number;
  neuronCount: () => number;
  oldestStep: () => bigint | null;
  latestStep: () => bigint | null;
  topologyDigest: () => string | null;
  /** Visit rows oldest first. `encodedSpikes` is `-1` for an unsampled row. */
  forEachRow: (visit: (column: number, step: bigint, sampled: boolean, encodedSpikes: number) => void) => void;
  /** Visit every recorded spike, oldest row first. */
  forEachSpike: (visit: (column: number, neuron: number) => void) => void;
  /** Whether `neuron` spiked at `step`, or `null` if that step was not sampled. */
  spiked: (step: bigint, neuron: number) => boolean | null;
  /** Steps at which `neuron` spiked, newest first. */
  recentSpikeSteps: (neuron: number, limit?: number) => bigint[];
  /** Spikes and distinct spiking neurons inside the window. */
  totals: () => { spikes: number; activeNeurons: number; encodedSpikes: number; sampledRows: number };
  stats: () => SpikeRasterStats;
  /** Drop every row. Lifetime counters are kept. */
  reset: () => void;
}

export interface SpikeRasterOptions {
  provenance: SpikeEventProvenance;
  steps?: number;
}

export function createSpikeRaster(options: SpikeRasterOptions): SpikeRaster {
  const { provenance } = options;
  if (provenance !== 'live-wasm' && provenance !== 'fixture') {
    throw new RangeError(`unknown spike raster provenance ${String(provenance)}`);
  }
  const capacity = options.steps ?? DEFAULT_RASTER_STEPS;
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError('spike raster steps must be a positive integer');
  }

  let neurons = 0;
  let bits = new Uint8Array(0);
  const sampled = new Uint8Array(capacity);
  const encoded = new Int16Array(capacity).fill(-1);
  let head = 0;
  let size = 0;
  let oldest: bigint | null = null;
  let digest: string | null = null;
  const counters = { recordedSteps: 0, evictedRows: 0, gapRows: 0, resets: 0 };

  const slotAt = (offset: number) => (head + offset) % capacity;

  const clearRows = () => {
    head = 0;
    size = 0;
    oldest = null;
    sampled.fill(0);
    encoded.fill(-1);
    bits.fill(0);
  };

  const append = (step: bigint): number => {
    if (size === capacity) {
      head = (head + 1) % capacity;
      size -= 1;
      oldest = (oldest as bigint) + 1n;
      counters.evictedRows += 1;
    }
    const slot = slotAt(size);
    bits.fill(0, slot * neurons, (slot + 1) * neurons);
    sampled[slot] = 0;
    encoded[slot] = -1;
    size += 1;
    if (oldest === null) {
      oldest = step;
    }
    return slot;
  };

  /** The slot for `step`, opening gap rows or restarting as needed. */
  const rowFor = (step: bigint, topologyDigest: string, neuronCount: number): number => {
    if (neuronCount !== neurons || (digest !== null && topologyDigest !== digest)) {
      if (size > 0) {
        counters.resets += 1;
      }
      neurons = neuronCount;
      bits = new Uint8Array(capacity * neurons);
      clearRows();
    }
    digest = topologyDigest;
    if (oldest === null) {
      return append(step);
    }
    const newest = oldest + BigInt(size - 1);
    if (step === newest) {
      return slotAt(size - 1);
    }
    if (step < newest) {
      // The spike-event buffer never repeats a step, so a lower one is a
      // fresh adapter (for example the main-thread retry) counting again.
      counters.resets += 1;
      clearRows();
      return append(step);
    }
    const window = BigInt(capacity - 1);
    let first = newest + 1n;
    if (step - first > window) {
      // The gap is wider than the ring: none of the held rows stay visible.
      counters.gapRows += Number(step - first - window);
      clearRows();
      first = step - window;
    }
    for (let gap = first; gap < step; gap += 1n) {
      append(gap);
      counters.gapRows += 1;
    }
    return append(step);
  };

  const newestStep = () => (oldest === null ? null : oldest + BigInt(size - 1));

  const isSpike = (offset: number, neuron: number) => bits[slotAt(offset) * neurons + neuron] === 1;

  return {
    provenance,
    capacity,
    record(batch, snapshot) {
      if (batch.provenance !== provenance) {
        throw new RangeError(`a ${provenance} raster cannot record ${batch.provenance} spikes`);
      }
      if (batch.step !== snapshot.completedStep || batch.topologyDigest !== snapshot.topologyDigest) {
        throw new RangeError('spike raster: the batch and the snapshot describe different steps');
      }
      const neuronCount = snapshot.topologyNodeIds.length;
      if (!Number.isInteger(neuronCount) || neuronCount < 1 || neuronCount > MAX_RASTER_NEURONS) {
        throw new RangeError('spike raster: the topology has no usable neuron domain');
      }
      for (const neuron of batch.spikeNeurons) {
        if (!Number.isInteger(neuron) || neuron < 0 || neuron >= neuronCount) {
          throw new RangeError(`spike raster: neuron ${neuron} is outside the topology`);
        }
      }
      const count = snapshot.encodedSpikeCount;
      if (!Number.isInteger(count) || count < 0) {
        throw new RangeError('spike raster: encoded spike count must be a non-negative integer');
      }

      const slot = rowFor(batch.step, batch.topologyDigest, neuronCount);
      const base = slot * neurons;
      bits.fill(0, base, base + neurons);
      for (const neuron of batch.spikeNeurons) {
        bits[base + neuron] = 1;
      }
      sampled[slot] = 1;
      encoded[slot] = Math.min(count, 0x7fff);
      counters.recordedSteps += 1;
    },
    size: () => size,
    neuronCount: () => neurons,
    oldestStep: () => oldest,
    latestStep: newestStep,
    topologyDigest: () => digest,
    forEachRow(visit) {
      if (oldest === null) {
        return;
      }
      for (let offset = 0; offset < size; offset += 1) {
        const slot = slotAt(offset);
        visit(offset, oldest + BigInt(offset), sampled[slot] === 1, encoded[slot]);
      }
    },
    forEachSpike(visit) {
      for (let offset = 0; offset < size; offset += 1) {
        const base = slotAt(offset) * neurons;
        for (let neuron = 0; neuron < neurons; neuron += 1) {
          if (bits[base + neuron] === 1) {
            visit(offset, neuron);
          }
        }
      }
    },
    spiked(step, neuron) {
      if (oldest === null || step < oldest || neuron < 0 || neuron >= neurons) {
        return null;
      }
      const offset = step - oldest;
      if (offset >= BigInt(size)) {
        return null;
      }
      const index = Number(offset);
      return sampled[slotAt(index)] === 1 ? isSpike(index, neuron) : null;
    },
    recentSpikeSteps(neuron, limit = RECENT_SPIKE_LIMIT) {
      const steps: bigint[] = [];
      if (oldest === null || neuron < 0 || neuron >= neurons) {
        return steps;
      }
      for (let offset = size - 1; offset >= 0 && steps.length < limit; offset -= 1) {
        if (isSpike(offset, neuron)) {
          steps.push(oldest + BigInt(offset));
        }
      }
      return steps;
    },
    totals() {
      let spikes = 0;
      let encodedSpikes = 0;
      let sampledRows = 0;
      const active = new Uint8Array(neurons);
      for (let offset = 0; offset < size; offset += 1) {
        const slot = slotAt(offset);
        if (sampled[slot] === 1) {
          sampledRows += 1;
          encodedSpikes += encoded[slot];
        }
        const base = slot * neurons;
        for (let neuron = 0; neuron < neurons; neuron += 1) {
          if (bits[base + neuron] === 1) {
            spikes += 1;
            active[neuron] = 1;
          }
        }
      }
      return { spikes, activeNeurons: active.reduce((sum, value) => sum + value, 0), encodedSpikes, sampledRows };
    },
    stats() {
      return {
        provenance,
        capacity,
        rows: size,
        neuronCount: neurons,
        oldestStep: oldest,
        latestStep: newestStep(),
        topologyDigest: digest,
        ...counters,
      };
    },
    reset() {
      clearRows();
      digest = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Throttled flushes
// ---------------------------------------------------------------------------

export interface TelemetryClock {
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export const systemTelemetryClock: TelemetryClock = {
  now: () => globalThis.performance?.now?.() ?? Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Validate a cadence and cap it at one refresh per simulation step. */
export function normalizeTelemetryHz(hz: number): number {
  if (typeof hz !== 'number' || !Number.isFinite(hz) || hz <= 0) {
    throw new RangeError('telemetry cadence must be a positive number of hertz');
  }
  return Math.min(hz, MAX_TELEMETRY_HZ);
}

export interface FlushScheduler {
  /** Ask for a flush; requests coalesce into at most one per interval. */
  request: () => void;
  /** Flush immediately (user actions) and restart the interval. */
  flushNow: () => void;
  setCadenceHz: (hz: number) => void;
  cadenceHz: () => number;
  cancel: () => void;
  pending: () => boolean;
  flushes: () => number;
}

/**
 * Coalesces flush requests to a fixed maximum rate. Sampling calls `request`
 * on every simulation step; the flush itself runs at most once per
 * `1000 / cadenceHz` ms, and never without a request, so an idle simulation
 * costs no timers at all.
 */
export function createFlushScheduler(
  flush: () => void,
  options: { cadenceHz?: number; clock?: TelemetryClock } = {},
): FlushScheduler {
  const clock = options.clock ?? systemTelemetryClock;
  let hz = normalizeTelemetryHz(options.cadenceHz ?? DEFAULT_TELEMETRY_HZ);
  let handle: unknown = null;
  let lastFlush = Number.NEGATIVE_INFINITY;
  let count = 0;

  const run = () => {
    handle = null;
    lastFlush = clock.now();
    count += 1;
    try {
      flush();
    } catch (error) {
      reportTelemetryError(error);
    }
  };
  const schedule = () => {
    const delay = Math.max(0, lastFlush + 1000 / hz - clock.now());
    handle = clock.setTimeout(run, delay);
  };
  const cancel = () => {
    if (handle !== null) {
      clock.clearTimeout(handle);
      handle = null;
    }
  };

  return {
    request() {
      if (handle === null) {
        schedule();
      }
    },
    flushNow() {
      cancel();
      run();
    },
    setCadenceHz(next) {
      hz = normalizeTelemetryHz(next);
      if (handle !== null) {
        cancel();
        schedule();
      }
    },
    cadenceHz: () => hz,
    cancel,
    pending: () => handle !== null,
    flushes: () => count,
  };
}

// ---------------------------------------------------------------------------
// Inspection models: only fields the runtime exports
// ---------------------------------------------------------------------------

export type SynapsePolarity = 'excitatory' | 'inhibitory';

/** One `synaptic-wiring` synapse as the adapter's canonical projection exports it. */
export interface SynapseInspection {
  /** Canonical edge index, scoped by the topology digest (not an upstream `EdgeId`). */
  readonly edgeIndex: number;
  /** Upstream `NeuronId` at the other end: the target of an outgoing synapse, the source of an incoming one. */
  readonly peer: number;
  /** Signed upstream weight. */
  readonly weight: number;
  /** `synaptic-wiring` `DelayTicks`; one tick is one logical step. */
  readonly delaySteps: number;
  /** The delay at the live 50 ms step. */
  readonly delayMs: number;
  readonly polarity: SynapsePolarity;
}

/**
 * What the runtime exports about one neuron. There is deliberately no
 * threshold, resting potential, refractory state, or model tag: contract 5
 * does not export them.
 */
export interface NeuronInspection {
  /** Upstream `NeuronId`; also the index into `neuromod`'s LIF bank. */
  readonly neuron: number;
  /** `completed_step` of the snapshot the values come from. */
  readonly step: bigint;
  readonly topologyDigest: string;
  /** `neuromod` `get_membrane_potentials()[neuron]` at `step`. */
  readonly membranePotential: number;
  /** Whether the spike-event seam reported a spike at `step`; `null` when not sampled. */
  readonly spikedAtStep: boolean | null;
  /** Sampled spike steps inside the raster window, newest first. */
  readonly recentSpikeSteps: readonly bigint[];
  readonly outgoing: readonly SynapseInspection[];
  readonly incoming: readonly SynapseInspection[];
}

export type InspectableSnapshot = Pick<
  NeuromorphicState,
  | 'completedStep'
  | 'topologyDigest'
  | 'topologyNodeIds'
  | 'membranePotentials'
  | 'topologyEdgeSources'
  | 'topologyEdgeTargets'
  | 'topologyEdgeWeights'
  | 'topologyEdgeDelays'
  | 'topologyPolarities'
  | 'topologyOutgoingEdgeOffsets'
>;

function polarityName(tag: number): SynapsePolarity {
  if (tag === 0) return 'excitatory';
  if (tag === 1) return 'inhibitory';
  throw new RangeError(`unknown synapse polarity tag ${tag}`);
}

function synapse(snapshot: InspectableSnapshot, edge: number, peer: number): SynapseInspection {
  const delaySteps = snapshot.topologyEdgeDelays[edge];
  return Object.freeze({
    edgeIndex: edge,
    peer,
    weight: snapshot.topologyEdgeWeights[edge],
    delaySteps,
    delayMs: delayStepsToMs(delaySteps),
    polarity: polarityName(snapshot.topologyPolarities[edge]),
  });
}

/**
 * Inspect `neuron` in one snapshot. Outgoing synapses are the canonical CSR
 * range the spike-event seam maps spikes along (so they are exactly the edges
 * the renderer draws pulses on); incoming synapses are every canonical edge
 * that targets the neuron. Returns `null` for a neuron outside the topology.
 */
export function inspectNeuron(
  snapshot: InspectableSnapshot,
  raster: Pick<SpikeRaster, 'spiked' | 'recentSpikeSteps' | 'topologyDigest'> | null,
  neuron: number,
): NeuronInspection | null {
  const nodeIds = snapshot.topologyNodeIds;
  if (!Number.isInteger(neuron) || neuron < 0 || neuron >= nodeIds.length || nodeIds[neuron] !== neuron) {
    return null;
  }
  const membranePotential = snapshot.membranePotentials[neuron];
  if (typeof membranePotential !== 'number') {
    return null;
  }
  const offsets = snapshot.topologyOutgoingEdgeOffsets;
  const outgoing: SynapseInspection[] = [];
  for (let edge = offsets[neuron]; edge < offsets[neuron + 1]; edge += 1) {
    outgoing.push(synapse(snapshot, edge, snapshot.topologyEdgeTargets[edge]));
  }
  const incoming: SynapseInspection[] = [];
  for (let edge = 0; edge < snapshot.topologyEdgeTargets.length; edge += 1) {
    if (snapshot.topologyEdgeTargets[edge] === neuron) {
      incoming.push(synapse(snapshot, edge, snapshot.topologyEdgeSources[edge]));
    }
  }
  const sameTopology = raster !== null && raster.topologyDigest() === snapshot.topologyDigest;
  return Object.freeze({
    neuron,
    step: snapshot.completedStep,
    topologyDigest: snapshot.topologyDigest,
    membranePotential,
    spikedAtStep: sameTopology ? raster.spiked(snapshot.completedStep, neuron) : null,
    recentSpikeSteps: Object.freeze(sameTopology ? raster.recentSpikeSteps(neuron) : []),
    outgoing: Object.freeze(outgoing),
    incoming: Object.freeze(incoming),
  });
}

export interface EncoderFeature {
  readonly index: number;
  readonly label: string;
  /** Clamped `[0, 1]` `kinetic-signals` feature handed to `axon-encoder`. */
  readonly value: number;
}

/** `axon-encoder` and `kinetic-signals` state of one snapshot. */
export interface EncoderInspection {
  readonly contractVersion: number;
  readonly step: bigint;
  /** Active `axon-encoder` mode discriminant and name. */
  readonly mode: number;
  readonly name: string;
  /** Spikes the latest input encoded, and how many distinct channels fired. */
  readonly encodedSpikeCount: number;
  readonly encodedSpikeChannels: number;
  /** Cumulative encoded spikes since the adapter was constructed. */
  readonly encodedSpikeTotal: bigint;
  /** Contract 5 only; `null` when the snapshot does not export features. */
  readonly features: readonly EncoderFeature[] | null;
  /** Site input that produced the latest telemetry packet. */
  readonly inputSource: TelemetrySourceKind | null;
}

export type EncoderSnapshot = Pick<
  NeuromorphicState,
  | 'contractVersion'
  | 'completedStep'
  | 'encoderMode'
  | 'encoderName'
  | 'encodedSpikeCount'
  | 'encodedSpikeChannels'
  | 'encodedSpikeTotal'
  | 'encoderFeatures'
>;

/**
 * Encoder inspection for contracts that export encoder diagnostics (4 and 5).
 * Contract 3 snapshots carry bridge defaults rather than runtime diagnostics,
 * so they return `null` instead of being shown as if measured.
 */
export function inspectEncoder(
  snapshot: EncoderSnapshot,
  inputSource: TelemetrySourceKind | null,
): EncoderInspection | null {
  if (snapshot.contractVersion < NEUROMORPHIC_CONTRACT_VERSION_V4) {
    return null;
  }
  const exported =
    snapshot.contractVersion >= NEUROMORPHIC_CONTRACT_VERSION_V5 &&
    snapshot.encoderFeatures.length === ENCODER_FEATURE_COUNT;
  const features = exported
    ? Object.freeze(
        Array.from(snapshot.encoderFeatures, (value, index) =>
          Object.freeze({ index, label: KINETIC_FEATURE_LABELS[index], value }),
        ),
      )
    : null;
  return Object.freeze({
    contractVersion: snapshot.contractVersion,
    step: snapshot.completedStep,
    mode: snapshot.encoderMode,
    name: snapshot.encoderName,
    encodedSpikeCount: snapshot.encodedSpikeCount,
    encodedSpikeChannels: snapshot.encodedSpikeChannels,
    encodedSpikeTotal: snapshot.encodedSpikeTotal,
    features,
    inputSource,
  });
}

/**
 * Execution origin for the panel: `live-wasm` only when the shown values came
 * from the `live-wasm` buffer's runtime. Anything else is never labeled live.
 */
export function telemetryOrigin(provenance: SpikeEventProvenance | null): Exclude<ExecutionOrigin, 'recorded-cuda-fpga'> {
  return provenance === LIVE_SPIKE_EVENT_PROVENANCE ? 'live-wasm' : 'unavailable-wasm';
}

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function formatStep(step: bigint): string {
  return integer.format(step);
}

/** One line describing the raster window, from raster counts only. */
export function rasterSummary(raster: Pick<SpikeRaster, 'size' | 'oldestStep' | 'latestStep' | 'neuronCount' | 'totals'>): string {
  const oldest = raster.oldestStep();
  const latest = raster.latestStep();
  if (oldest === null || latest === null) {
    return 'No steps sampled yet.';
  }
  const rows = raster.size();
  const { spikes, activeNeurons, encodedSpikes } = raster.totals();
  const seconds = ((rows * DEMO_TICK_MS) / 1000).toFixed(1);
  return (
    `Steps ${formatStep(oldest)}–${formatStep(latest)} (${rows} steps, ${seconds} s at ${DEMO_TICK_MS} ms per step): ` +
    `${spikes} neuromod ${spikes === 1 ? 'spike' : 'spikes'} from ${activeNeurons} of ${raster.neuronCount()} neurons; ` +
    `${encodedSpikes} axon-encoder ${encodedSpikes === 1 ? 'spike' : 'spikes'} in.`
  );
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export type TelemetryState = 'unavailable' | 'disabled' | 'waiting' | 'streaming' | 'paused' | 'frozen';

export interface TelemetryViewModel {
  readonly state: TelemetryState;
  readonly origin: Exclude<ExecutionOrigin, 'recorded-cuda-fpga'>;
  readonly status: string;
  /** Effective refresh rate in hertz. */
  readonly cadenceHz: number;
  /** Provenance of the shown values, or `null` when nothing is shown. */
  readonly provenance: SpikeEventProvenance | null;
  /** Snapshot identity, or `null` when nothing is shown. */
  readonly snapshot: Readonly<{ step: bigint; contractVersion: number; topologyDigest: string }> | null;
  /** The raster ring, for drawing; read it, never record into it. */
  readonly raster: SpikeRaster;
  readonly rasterSummary: string;
  /** Spike-event buffer counters: propagation events in flight and lifetime totals. */
  readonly propagation: Readonly<{ inFlight: number; emitted: number; evicted: number }> | null;
  readonly nodeIds: readonly number[];
  readonly selectedNeuron: number | null;
  readonly neuron: NeuronInspection | null;
  readonly encoder: EncoderInspection | null;
}

/** The DOM facts the controller needs; `telemetry-view.ts` provides them. */
export interface TelemetryPanelPort {
  /** Whether the collapsible panel is open. Closed means no sampling at all. */
  isOpen: () => boolean;
  onToggle: (listener: () => void) => () => void;
  /** The demo island's `data-mode` (`live`, `awaiting-play`, `frozen`, …). */
  demoMode: () => string | undefined;
  /** Observe `data-mode`; the controller subscribes only while sampling. */
  onDemoModeChange: (listener: () => void) => () => void;
  prefersReducedMotion: () => boolean;
  /** Observe `prefers-reduced-motion`; the controller subscribes only while sampling. */
  onReducedMotionChange: (listener: () => void) => () => void;
}

export interface TelemetryControllerOptions {
  /** `null` when the island has no live seams (no JS runtime, tests, fallback). */
  sources: LiveTelemetrySources | null;
  panel: TelemetryPanelPort;
  render: (model: TelemetryViewModel) => void;
  cadenceHz?: number;
  rasterSteps?: number;
  clock?: TelemetryClock;
}

export interface TelemetryControllerInspection {
  open: boolean;
  enabled: boolean;
  /** Subscribed to the spike-event buffer and sampling. */
  sampling: boolean;
  cadenceHz: number;
  effectiveCadenceHz: number;
  samples: number;
  flushes: number;
  flushPending: boolean;
  rasterRows: number;
  latestStep: string | null;
  selectedNeuron: number | null;
}

export interface TelemetryController {
  /** Select a neuron by upstream `NeuronId`; renders immediately. */
  select: (neuron: number) => void;
  /**
   * Requested refresh rate. A performance budget may lower it at any time;
   * reduced motion caps the effective rate at {@link REDUCED_MOTION_TELEMETRY_HZ}.
   */
  setCadenceHz: (hz: number) => void;
  cadenceHz: () => number;
  effectiveCadenceHz: () => number;
  /** Turn telemetry off (or back on) without touching the simulation. */
  setEnabled: (enabled: boolean) => void;
  inspect: () => TelemetryControllerInspection;
  dispose: () => void;
}

/** Short, stable label for a topology digest (`sha256:` prefix of its hash). */
export function telemetryDigestLabel(digest: string): string {
  const hash = digest.split(':').at(-1) ?? digest;
  return `sha256:${hash.slice(0, 12)}`;
}

/**
 * Binds the panel to the live seams. While the panel is closed (or telemetry
 * is disabled) the controller holds no subscription, timer, or observer; the
 * simulation and renderer are never touched either way.
 */
export function createTelemetryController(options: TelemetryControllerOptions): TelemetryController {
  const { sources, panel, render } = options;
  const clock = options.clock ?? systemTelemetryClock;
  const provenance = sources?.spikeEvents.provenance ?? LIVE_SPIKE_EVENT_PROVENANCE;
  const raster = createSpikeRaster({ provenance, steps: options.rasterSteps });
  let requestedHz = normalizeTelemetryHz(options.cadenceHz ?? DEFAULT_TELEMETRY_HZ);
  let reducedMotion = false;
  let enabled = true;
  let disposed = false;
  let sampling = false;
  let latest: NeuromorphicState | null = null;
  let selected: number | null = null;
  let samples = 0;
  let unsubscribeBatches: (() => void) | null = null;
  let unsubscribeMode: (() => void) | null = null;
  let unsubscribeMotion: (() => void) | null = null;

  const effectiveHz = () =>
    reducedMotion ? Math.min(requestedHz, REDUCED_MOTION_TELEMETRY_HZ) : requestedHz;

  const model = (): TelemetryViewModel => {
    const mode = panel.demoMode();
    const base = {
      cadenceHz: effectiveHz(),
      raster,
      rasterSummary: rasterSummary(raster),
    };
    const empty = {
      ...base,
      origin: telemetryOrigin(null),
      provenance: null,
      snapshot: null,
      propagation: null,
      nodeIds: [],
      selectedNeuron: null,
      neuron: null,
      encoder: null,
    } as const;
    if (sources === null) {
      return { ...empty, state: 'unavailable', status: TELEMETRY_STATIC_STATUS };
    }
    if (!enabled) {
      return {
        ...empty,
        state: 'disabled',
        status: 'Telemetry is turned off. The simulation keeps running without it.',
      };
    }
    if (mode === 'fallback') {
      return {
        ...empty,
        state: 'unavailable',
        status: 'The live Rust/WASM runtime is unavailable here, so there is no telemetry. The static diagram remains available.',
      };
    }
    if (latest === null) {
      return {
        ...empty,
        state: 'waiting',
        status:
          mode === 'live' || mode === 'initializing'
            ? 'Waiting for the first step from the live Rust/WASM runtime.'
            : 'Telemetry streams while the live demo runs. Use Play animation to start it.',
      };
    }

    const nodeIds = Array.from(latest.topologyNodeIds);
    if (selected === null || !nodeIds.includes(selected)) {
      selected = nodeIds[0] ?? null;
    }
    const step = formatStep(latest.completedStep);
    let state: TelemetryState;
    let status: string;
    if (mode === 'live') {
      state = 'streaming';
      status = `Streaming from the live Rust/WASM runtime. Step ${step}, refreshed at ${effectiveHz()} Hz.`;
    } else if (mode === 'frozen') {
      state = 'frozen';
      status = `The simulation stopped. Showing its last valid step, ${step}.`;
    } else {
      state = 'paused';
      status = `Paused with the demo at step ${step}. Play animation resumes sampling.`;
    }
    const bufferStats = sources.spikeEvents.stats();
    return {
      ...base,
      state,
      status,
      origin: telemetryOrigin(provenance),
      provenance,
      snapshot: Object.freeze({
        step: latest.completedStep,
        contractVersion: latest.contractVersion,
        topologyDigest: latest.topologyDigest,
      }),
      propagation: Object.freeze({
        inFlight: bufferStats.size,
        emitted: bufferStats.emitted,
        evicted: bufferStats.evicted,
      }),
      nodeIds,
      selectedNeuron: selected,
      neuron: selected === null ? null : inspectNeuron(latest, raster, selected),
      encoder: inspectEncoder(latest, inputSourceAt(latest.completedStep)),
    };
  };

  /** The site input source of the displayed `step`, looked up by step (never "the latest"). */
  const inputSourceAt = (step: bigint): TelemetrySourceKind | null => sources?.inputSource(step) ?? null;

  const flush = () => {
    if (!disposed && panel.isOpen()) {
      render(model());
    }
  };
  const scheduler = createFlushScheduler(flush, { cadenceHz: requestedHz, clock });

  const onBatch = (batch: SpikeStepBatch) => {
    if (!sampling || sources === null) {
      return;
    }
    // The batch is delivered during the channel publish that produced it, so
    // `latest()` is that step's snapshot. Anything else is skipped, not guessed.
    const state = sources.channel.latest();
    if (!state || state.completedStep !== batch.step || state.topologyDigest !== batch.topologyDigest) {
      return;
    }
    raster.record(batch, state);
    latest = state;
    samples += 1;
    scheduler.request();
  };

  const startSampling = () => {
    if (sources === null) {
      return;
    }
    sampling = true;
    reducedMotion = panel.prefersReducedMotion();
    scheduler.setCadenceHz(effectiveHz());
    raster.reset();
    latest = sources.channel.latest();
    unsubscribeBatches = sources.spikeEvents.subscribe(onBatch);
    unsubscribeMode = panel.onDemoModeChange(() => scheduler.request());
    // The motion preference can change while the panel stays open.
    unsubscribeMotion = panel.onReducedMotionChange(() => {
      reducedMotion = panel.prefersReducedMotion();
      scheduler.setCadenceHz(effectiveHz());
      scheduler.request();
    });
  };

  const stopSampling = () => {
    sampling = false;
    unsubscribeBatches?.();
    unsubscribeBatches = null;
    unsubscribeMode?.();
    unsubscribeMode = null;
    unsubscribeMotion?.();
    unsubscribeMotion = null;
    scheduler.cancel();
    raster.reset();
    latest = null;
  };

  const sync = () => {
    if (disposed) {
      return;
    }
    const open = panel.isOpen();
    const shouldSample = open && enabled && sources !== null;
    if (shouldSample && !sampling) {
      startSampling();
    } else if (!shouldSample && sampling) {
      stopSampling();
    }
    if (open) {
      scheduler.flushNow();
    }
  };

  const unsubscribeToggle = panel.onToggle(sync);
  sync();

  return {
    select(neuron) {
      if (!Number.isInteger(neuron) || neuron < 0) {
        throw new RangeError('select a neuron by its non-negative NeuronId');
      }
      selected = neuron;
      if (!disposed && panel.isOpen()) {
        scheduler.flushNow();
      }
    },
    setCadenceHz(hz) {
      requestedHz = normalizeTelemetryHz(hz);
      scheduler.setCadenceHz(effectiveHz());
    },
    cadenceHz: () => requestedHz,
    effectiveCadenceHz: effectiveHz,
    setEnabled(next) {
      enabled = Boolean(next);
      sync();
    },
    inspect() {
      const latestStep = raster.latestStep();
      return {
        open: panel.isOpen(),
        enabled,
        sampling,
        cadenceHz: requestedHz,
        effectiveCadenceHz: effectiveHz(),
        samples,
        flushes: scheduler.flushes(),
        flushPending: scheduler.pending(),
        rasterRows: raster.size(),
        latestStep: latestStep === null ? null : latestStep.toString(),
        selectedNeuron: selected,
      };
    },
    dispose() {
      if (disposed) {
        return;
      }
      stopSampling();
      unsubscribeToggle();
      disposed = true;
    },
  };
}
