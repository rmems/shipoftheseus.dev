import { DEMO_TICK_MS } from './demo-stimulus';
import type { NeuromorphicState } from './neuromorphic-adapter';
import type { SimulationChannel } from './simulation-channel';

/**
 * Spike propagation events: the seam between the live simulation and anything
 * that draws or measures spikes travelling along synapses. The topology
 * renderer consumes it today; the spike raster/telemetry view (GitHub #9) and
 * the performance budgets (GitHub #10) are meant to consume the same buffer.
 *
 * **Provenance.** A live event has exactly one origin: a `neuromod` spike
 * (`spike_neurons` of an adapter snapshot the bridge has already validated)
 * mapped through the same snapshot's `synaptic-wiring` projection, that is the
 * canonical CSR range `topology_outgoing_edge_offsets[n]..[n + 1]` and that
 * range's edge targets, delays, polarities, and weights. Nothing in this module
 * generates spikes. A buffer is bound to one provenance when it is created; the
 * live seams create the only `live-wasm` buffer and feed it from the simulation
 * channel. `fixture` buffers exist for tests and must never be fed from the
 * live channel.
 *
 * **Timing.** Edge delays are `synaptic-wiring` `DelayTicks`: a spike from `s`
 * on mesh tick `t` reaches its targets on tick `t + delay`. The adapter calls
 * `mesh.propagate` exactly once per logical `step`, so one delay tick is one
 * step, and the live demo advances one step every {@link SPIKE_EVENT_STEP_MS}
 * (50 ms). An event emitted at `completed_step = N` on an edge with delay `d`
 * therefore arrives at step `N + d`, `d × 50 ms` later at the live cadence.
 *
 * **Bounds.** A buffer holds at most `capacity` events in a fixed ring. The
 * oldest events are evicted first, every event retires `retainSteps` after it
 * arrives, and `clear()` (pause) and `dispose()` empty it. Ingestion happens
 * when a snapshot is published, never inside a render frame.
 */

/** Where an event came from. Telemetry must keep the two apart. */
export type SpikeEventProvenance = 'live-wasm' | 'fixture';

/** The provenance of every event the shipped live surface produces. */
export const LIVE_SPIKE_EVENT_PROVENANCE: SpikeEventProvenance = 'live-wasm';

/** Wall-clock length of one logical step (one delay tick) in the live demo. */
export const SPIKE_EVENT_STEP_MS = DEMO_TICK_MS;

/**
 * Default ring capacity. The live topology has 64 edges with delays of 1 to
 * 4 steps, so even if every neuron spikes on every step at most
 * `64 × (4 + 1) = 320` events are live at once (with the default retention).
 */
export const DEFAULT_SPIKE_EVENT_CAPACITY = 512;

/** Steps an event stays buffered after its arrival step (lets its tail land). */
export const DEFAULT_SPIKE_EVENT_RETAIN_STEPS = 1;

/** Length of a drawn pulse, in steps of travel time. */
export const PULSE_TAIL_STEPS = 0.6;

/** Snapshot fields the mapping reads. A full `NeuromorphicState` satisfies it. */
export type SpikeSnapshot = Pick<
  NeuromorphicState,
  | 'completedStep'
  | 'spikeNeurons'
  | 'topologyDigest'
  | 'topologyNodeIds'
  | 'topologyEdgeSources'
  | 'topologyEdgeTargets'
  | 'topologyEdgeWeights'
  | 'topologyEdgeDelays'
  | 'topologyPolarities'
  | 'topologyOutgoingEdgeOffsets'
>;

/**
 * One spike travelling along one synapse. `(topologyDigest, emittedStep,
 * edgeIndex)` identifies an event uniquely: an edge carries at most one new
 * spike per step.
 */
export interface SpikePropagationEvent {
  readonly provenance: SpikeEventProvenance;
  /** Topology the edge index is scoped to. */
  readonly topologyDigest: string;
  /** `completed_step` of the snapshot that reported the source spike. */
  readonly emittedStep: bigint;
  /** `emittedStep + delaySteps`: the step the spike reaches its target. */
  readonly arrivalStep: bigint;
  /** Upstream `NeuronId` that spiked (index into `spike_neurons`' domain). */
  readonly sourceNeuron: number;
  /** Upstream `NeuronId` the synapse delivers to. */
  readonly targetNeuron: number;
  /** Canonical edge index (see the topology projection handoff). */
  readonly edgeIndex: number;
  /** `synaptic-wiring` delay in steps. */
  readonly delaySteps: number;
  /** `0` excitatory, `1` inhibitory. */
  readonly polarity: number;
  /** Signed upstream synaptic weight. */
  readonly weight: number;
}

/** Everything one ingested snapshot contributed, for per-step consumers. */
export interface SpikeStepBatch {
  readonly provenance: SpikeEventProvenance;
  readonly step: bigint;
  readonly topologyDigest: string;
  /** Copy of the snapshot's `spike_neurons`, in adapter order. */
  readonly spikeNeurons: readonly number[];
  /** Every propagation event of this step, including any evicted on arrival. */
  readonly events: readonly SpikePropagationEvent[];
}

export interface SpikeEventBufferStats {
  provenance: SpikeEventProvenance;
  capacity: number;
  /** Events currently buffered. */
  size: number;
  /** Step of the most recent ingested snapshot, or `null` after a clear. */
  latestStep: bigint | null;
  topologyDigest: string | null;
  /** Lifetime counters (they survive `clear`). */
  ingestedSteps: number;
  emitted: number;
  retired: number;
  evicted: number;
  /** Times a non-increasing step or a new topology restarted the buffer. */
  resets: number;
  clears: number;
}

export interface SpikeEventBuffer {
  readonly provenance: SpikeEventProvenance;
  readonly capacity: number;
  /**
   * Map one completed-step snapshot through its topology and append the
   * events. Atomic: an invalid snapshot throws a `RangeError` and leaves the
   * buffer unchanged. Returns `null` for a repeated step or after `dispose`.
   */
  ingest: (snapshot: SpikeSnapshot) => SpikeStepBatch | null;
  /** Visit buffered events oldest first. Stops early if the buffer changes. */
  forEach: (visit: (event: SpikePropagationEvent) => void) => void;
  /** Copy of the buffered events, oldest first. */
  events: () => SpikePropagationEvent[];
  size: () => number;
  latestStep: () => bigint | null;
  stats: () => SpikeEventBufferStats;
  /**
   * Called once per successful ingest, after the buffer is updated, in step
   * order for every subscriber. An `ingest` made from inside a listener is
   * applied immediately but its batch is queued until all subscribers have
   * received the current one, so `batch.step` (not `latestStep()`) is the
   * authoritative step during delivery. Listener errors are reported, not
   * thrown.
   */
  subscribe: (listener: (batch: SpikeStepBatch) => void) => () => void;
  /** Drop every buffered event (pause). Lifetime counters are kept. */
  clear: () => void;
  /** Clear, drop listeners, and ignore all later ingests. */
  dispose: () => void;
}

export interface SpikeEventBufferOptions {
  provenance: SpikeEventProvenance;
  capacity?: number;
  retainSteps?: number;
}

function mappingError(message: string): RangeError {
  return new RangeError(`spike event mapping: ${message}`);
}

/**
 * Pure mapping from one snapshot's `neuromod` spikes to propagation events
 * along that snapshot's `synaptic-wiring` edges. `spike_neurons` index the
 * `neuromod` LIF bank, which the adapter sizes to the topology's `NeuronId`
 * domain (the bridge rejects snapshots where they differ), so a spike at
 * neuron `n` leaves along canonical edges `offsets[n]..offsets[n + 1]`.
 * Throws a `RangeError` instead of guessing when the projection is
 * inconsistent.
 */
export function mapSpikesThroughTopology(
  snapshot: SpikeSnapshot,
  provenance: SpikeEventProvenance,
): SpikePropagationEvent[] {
  const {
    completedStep,
    spikeNeurons,
    topologyDigest,
    topologyNodeIds: nodeIds,
    topologyEdgeSources: sources,
    topologyEdgeTargets: targets,
    topologyEdgeWeights: weights,
    topologyEdgeDelays: delays,
    topologyPolarities: polarities,
    topologyOutgoingEdgeOffsets: offsets,
  } = snapshot;
  if (typeof completedStep !== 'bigint' || completedStep < 0n) {
    throw mappingError('completed step must be a non-negative bigint');
  }
  const nodeCount = nodeIds.length;
  const edgeCount = sources.length;
  if (
    offsets.length !== nodeCount + 1 ||
    offsets[nodeCount] !== edgeCount ||
    targets.length !== edgeCount ||
    weights.length !== edgeCount ||
    delays.length !== edgeCount ||
    polarities.length !== edgeCount
  ) {
    throw mappingError('topology arrays disagree on node or edge count');
  }

  const seen = new Uint8Array(nodeCount);
  const events: SpikePropagationEvent[] = [];
  for (const neuron of spikeNeurons) {
    if (neuron >= nodeCount || nodeIds[neuron] !== neuron) {
      throw mappingError(`spike neuron ${neuron} is outside the topology`);
    }
    if (seen[neuron]) {
      throw mappingError(`spike neuron ${neuron} is reported twice in one step`);
    }
    seen[neuron] = 1;
    const start = offsets[neuron];
    const end = offsets[neuron + 1];
    if (start > end || end > edgeCount) {
      throw mappingError(`outgoing edge range of neuron ${neuron} is invalid`);
    }
    for (let edge = start; edge < end; edge += 1) {
      const target = targets[edge];
      if (sources[edge] !== neuron || target >= nodeCount) {
        throw mappingError(`edge ${edge} does not leave neuron ${neuron}`);
      }
      const delaySteps = delays[edge];
      events.push(
        Object.freeze({
          provenance,
          topologyDigest,
          emittedStep: completedStep,
          arrivalStep: completedStep + BigInt(delaySteps),
          sourceNeuron: neuron,
          targetNeuron: target,
          edgeIndex: edge,
          delaySteps,
          polarity: polarities[edge],
          weight: weights[edge],
        }),
      );
    }
  }
  return events;
}

/** Convert a `synaptic-wiring` delay to wall-clock time at a step cadence. */
export function delayStepsToMs(delaySteps: number, stepMs: number = SPIKE_EVENT_STEP_MS): number {
  return delaySteps * stepMs;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function edgePosition(delaySteps: number, elapsedSteps: number): number {
  if (delaySteps <= 0) {
    return elapsedSteps >= 0 ? 1 : 0;
  }
  return clamp01(elapsedSteps / delaySteps);
}

/**
 * Tail position. On a zero-delay edge the pulse spans the whole edge until
 * `tailSteps` have passed; otherwise the tail trails the head by `tailSteps`.
 */
function tailPosition(delaySteps: number, elapsedSteps: number, tailSteps: number): number {
  if (delaySteps <= 0) {
    return elapsedSteps >= tailSteps ? 1 : 0;
  }
  return edgePosition(delaySteps, elapsedSteps - tailSteps);
}

/** A pulse's extent along its edge, as fractions from source (0) to target (1). */
export interface PropagationSpan {
  head: number;
  tail: number;
}

/**
 * Allocation-free form of {@link propagationSpan} for per-frame use: writes
 * the span into the caller-owned `out` and returns `true`, or returns `false`
 * (leaving `out` untouched) when the pulse is not visible.
 */
export function propagationSpanInto(
  out: PropagationSpan,
  delaySteps: number,
  elapsedSteps: number,
  tailSteps: number = PULSE_TAIL_STEPS,
): boolean {
  // `isFinite` also rejects NaN, which `elapsedSteps < 0` alone would let through.
  if (!Number.isFinite(elapsedSteps) || elapsedSteps < 0) {
    return false;
  }
  const tail = tailPosition(delaySteps, elapsedSteps, tailSteps);
  if (tail >= 1) {
    return false;
  }
  out.head = edgePosition(delaySteps, elapsedSteps);
  out.tail = tail;
  return true;
}

/**
 * Where a pulse is on its edge, as fractions from source (0) to target (1),
 * `elapsedSteps` after emission. The head moves at `1 / delaySteps` edge per
 * step, so it reaches the target exactly at the arrival step; the tail trails
 * by `tailSteps`. Returns `null` before emission and after the tail lands. A
 * zero-delay edge shows the whole edge for `tailSteps`. Allocates its result;
 * frame loops use {@link propagationSpanInto}.
 */
export function propagationSpan(
  delaySteps: number,
  elapsedSteps: number,
  tailSteps: number = PULSE_TAIL_STEPS,
): PropagationSpan | null {
  const span = { head: 0, tail: 0 };
  return propagationSpanInto(span, delaySteps, elapsedSteps, tailSteps) ? span : null;
}

/**
 * Report a listener failure without interrupting ingestion: a telemetry
 * consumer must never be able to stop the renderer's event stream.
 */
function reportListenerError(error: unknown): void {
  const host = globalThis as { reportError?: (error: unknown) => void };
  if (typeof host.reportError === 'function') {
    host.reportError(error);
    return;
  }
  queueMicrotask(() => {
    throw error;
  });
}

/** Fixed-capacity ring of propagation events for one provenance. */
export function createSpikeEventBuffer(options: SpikeEventBufferOptions): SpikeEventBuffer {
  const { provenance } = options;
  if (provenance !== 'live-wasm' && provenance !== 'fixture') {
    throw new RangeError(`unknown spike event provenance ${String(provenance)}`);
  }
  const capacity = options.capacity ?? DEFAULT_SPIKE_EVENT_CAPACITY;
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError('spike event capacity must be a positive integer');
  }
  const retainSteps = options.retainSteps ?? DEFAULT_SPIKE_EVENT_RETAIN_STEPS;
  if (!Number.isInteger(retainSteps) || retainSteps < 0) {
    throw new RangeError('spike event retention must be a non-negative integer');
  }
  const retain = BigInt(retainSteps);

  const slots: (SpikePropagationEvent | undefined)[] = new Array(capacity);
  // Copy-on-write: (un)subscribing replaces the array, so a delivery loop
  // keeps iterating the snapshot it started with.
  let listeners: readonly ((batch: SpikeStepBatch) => void)[] = [];
  let head = 0;
  let size = 0;
  let version = 0;
  let latestStep: bigint | null = null;
  let digest: string | null = null;
  let disposed = false;
  const counters = { ingestedSteps: 0, emitted: 0, retired: 0, evicted: 0, resets: 0, clears: 0 };

  const slotAt = (offset: number) => (head + offset) % capacity;

  const emptySlots = () => {
    for (let offset = 0; offset < size; offset += 1) {
      slots[slotAt(offset)] = undefined;
    }
    head = 0;
    size = 0;
    version += 1;
  };

  const retireThrough = (step: bigint) => {
    let kept = 0;
    for (let offset = 0; offset < size; offset += 1) {
      const event = slots[slotAt(offset)] as SpikePropagationEvent;
      if (event.arrivalStep + retain <= step) {
        counters.retired += 1;
        continue;
      }
      // Stable in-place compaction: writes never pass the read cursor.
      slots[slotAt(kept)] = event;
      kept += 1;
    }
    for (let offset = kept; offset < size; offset += 1) {
      slots[slotAt(offset)] = undefined;
    }
    size = kept;
  };

  const push = (event: SpikePropagationEvent) => {
    if (size === capacity) {
      slots[head] = undefined;
      head = (head + 1) % capacity;
      size -= 1;
      counters.evicted += 1;
    }
    slots[slotAt(size)] = event;
    size += 1;
  };

  // Batches go out strictly in ingest order. A subscriber that ingests
  // re-entrantly only queues its batch; it is delivered once every subscriber
  // has received the current one, so no subscriber ever sees steps go
  // backward.
  const outbox: SpikeStepBatch[] = [];
  let delivering = false;
  const deliver = (batch: SpikeStepBatch) => {
    outbox.push(batch);
    if (delivering) {
      return;
    }
    delivering = true;
    try {
      for (let next = outbox.shift(); next && !disposed; next = outbox.shift()) {
        for (const listener of listeners) {
          if (disposed) {
            break;
          }
          try {
            listener(next);
          } catch (error) {
            reportListenerError(error);
          }
        }
      }
    } finally {
      outbox.length = 0;
      delivering = false;
    }
  };

  return {
    provenance,
    capacity,
    ingest(snapshot) {
      if (disposed) {
        return null;
      }
      const step = snapshot.completedStep;
      const restart =
        latestStep !== null && (snapshot.topologyDigest !== digest || step < latestStep);
      if (!restart && latestStep !== null && step === latestStep) {
        return null;
      }
      // Map before touching the ring so a bad snapshot cannot half-apply.
      const mapped = mapSpikesThroughTopology(snapshot, provenance);

      if (restart) {
        emptySlots();
        counters.resets += 1;
      } else {
        retireThrough(step);
      }
      const overflow = Math.max(0, mapped.length - capacity);
      counters.evicted += overflow;
      for (let index = overflow; index < mapped.length; index += 1) {
        push(mapped[index]);
      }
      latestStep = step;
      digest = snapshot.topologyDigest;
      counters.ingestedSteps += 1;
      counters.emitted += mapped.length;
      version += 1;

      const batch: SpikeStepBatch = Object.freeze({
        provenance,
        step,
        topologyDigest: snapshot.topologyDigest,
        spikeNeurons: Object.freeze(Array.from(snapshot.spikeNeurons)),
        events: Object.freeze(mapped),
      });
      deliver(batch);
      return batch;
    },
    forEach(visit) {
      const startVersion = version;
      const count = size;
      for (let offset = 0; offset < count; offset += 1) {
        if (version !== startVersion) {
          return;
        }
        visit(slots[slotAt(offset)] as SpikePropagationEvent);
      }
    },
    events() {
      const copy: SpikePropagationEvent[] = [];
      for (let offset = 0; offset < size; offset += 1) {
        copy.push(slots[slotAt(offset)] as SpikePropagationEvent);
      }
      return copy;
    },
    size: () => size,
    latestStep: () => latestStep,
    stats() {
      return {
        provenance,
        capacity,
        size,
        latestStep,
        topologyDigest: digest,
        ...counters,
      };
    },
    subscribe(listener) {
      if (disposed) {
        return () => {};
      }
      // Set semantics: subscribing the same listener twice registers it once.
      if (!listeners.includes(listener)) {
        listeners = [...listeners, listener];
      }
      return () => {
        listeners = listeners.filter((registered) => registered !== listener);
      };
    },
    clear() {
      emptySlots();
      latestStep = null;
      digest = null;
      counters.clears += 1;
    },
    dispose() {
      if (disposed) {
        return;
      }
      emptySlots();
      latestStep = null;
      digest = null;
      listeners = [];
      disposed = true;
    },
  };
}

export interface SpikeEventFeed {
  /** Start ingesting; stopping (pause) also clears the buffer. */
  setActive: (active: boolean) => void;
  /** Unsubscribe from the channel and clear the buffer. Idempotent. */
  detach: () => void;
}

/**
 * Feed every snapshot published on `channel` into `buffer` while active.
 * Ingestion runs on publish, outside any render frame. A snapshot that cannot
 * be mapped is reported through `onError` (the renderer fails closed) instead
 * of being dropped silently.
 */
export function feedSpikeEvents(
  channel: Pick<SimulationChannel, 'subscribe'>,
  buffer: SpikeEventBuffer,
  onError: (error: unknown) => void,
): SpikeEventFeed {
  let active = false;
  let detached = false;
  const unsubscribe = channel.subscribe((state) => {
    if (!active || detached) {
      return;
    }
    try {
      buffer.ingest(state);
    } catch (error) {
      onError(error);
    }
  });

  return {
    setActive(next) {
      if (detached) {
        return;
      }
      if (active && !next) {
        buffer.clear();
      }
      active = next;
    },
    detach() {
      if (detached) {
        return;
      }
      detached = true;
      active = false;
      unsubscribe();
      buffer.clear();
    },
  };
}
