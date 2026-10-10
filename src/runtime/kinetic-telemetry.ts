import { TELEMETRY_PACKET_LENGTH } from './neuromorphic-adapter';
import { scriptedTelemetry } from './demo-stimulus';

/**
 * Site-layer telemetry for the contract-5 sensory pipeline:
 *
 *   pointer/touch/demo telemetry → kinetic-signals → axon-encoder → neuromod
 *
 * This module owns raw DOM input handling only. It turns pointer events into
 * one island-relative `[x, y, pressure]` packet per logical tick. All feature
 * extraction, clamping, and spike encoding happen in the Rust adapter; nothing
 * here computes features or spikes.
 */

export type TelemetrySourceKind = 'pointer' | 'scripted';

export interface TelemetrySource {
  /** One packet for this logical tick. Called exactly once per sequence. */
  sample: (sequence: bigint) => Float32Array;
  /** Where the most recent packet came from. */
  kind: () => TelemetrySourceKind;
  dispose: () => void;
}

/** Ticks without pointer activity before the scripted source resumes (3 s). */
export const POINTER_IDLE_TICKS = 60n;

interface PointerTarget {
  getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
  addEventListener: (type: string, listener: (event: PointerEvent) => void) => void;
  removeEventListener: (type: string, listener: (event: PointerEvent) => void) => void;
}

/**
 * Only the primary pointer drives telemetry. With several touches down, a
 * second finger must not replace the first one's packets or end its input
 * when it lifts. Mouse and pen pointers are always primary. Events without the
 * flag (synthetic or very old browsers) count as primary.
 */
function isPrimaryPointer(event: Pick<PointerEvent, 'isPrimary'> | undefined): boolean {
  return event?.isPrimary !== false;
}

function pointerIdOf(event: Pick<PointerEvent, 'pointerId'> | undefined): number | null {
  return typeof event?.pointerId === 'number' ? event.pointerId : null;
}

/** `true` when an event may act on a packet; unknown ids match conservatively. */
function sharesPointer(eventId: number | null, packetId: number | null): boolean {
  return eventId === null || packetId === null || eventId === packetId;
}

export function createScriptedTelemetry(): TelemetrySource {
  return {
    sample: scriptedTelemetry,
    kind: () => 'scripted',
    dispose: () => {},
  };
}

/**
 * Latches the latest pointer position over `target` and emits it on each
 * tick. Coordinates are relative to the target's box, so `0..1` means inside
 * it; values outside are passed through and clamped by Rust. When the pointer
 * has been idle for {@link POINTER_IDLE_TICKS}, or has left the target, the
 * deterministic scripted source takes over so the demo keeps running without
 * interaction.
 */
export function createPointerTelemetry(
  target: PointerTarget,
  fallback: TelemetrySource = createScriptedTelemetry(),
): TelemetrySource {
  let latest: Float32Array | null = null;
  // The packet to deliver after `latest` when a press was released (or moved
  // with zero pressure) before any tick sampled it.
  let next: Float32Array | null = null;
  // Which pointer produced each latched packet (`null` when the event carried
  // no id). A leave or cancel only affects packets from its own pointer, so a
  // mouse leaving a touchscreen laptop's island cannot end a touch, and a
  // canceled touch can never reach the simulation through a queued packet.
  let latestId: number | null = null;
  let nextId: number | null = null;
  let dirty = false;
  let lastActiveSequence: bigint | null = null;
  let leftBeforeSample = false;
  let lastKind: TelemetrySourceKind = 'scripted';

  const onMove = (event: PointerEvent) => {
    if (!isPrimaryPointer(event)) {
      return;
    }
    const box = target.getBoundingClientRect();
    if (!(box.width > 0 && box.height > 0)) {
      return;
    }
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }
    // Mouse hover reports pressure 0; pressed buttons and touch report > 0.
    const pressure = Number.isFinite(event.pressure) ? event.pressure : 0;
    const packet = new Float32Array([x, y, pressure]);
    const id = pointerIdOf(event);
    if (next) {
      // A press is already queued ahead of this packet; keep only the newest.
      next = packet;
      nextId = id;
    } else if (dirty && latest && latest[2] > 0 && pressure === 0) {
      // A quick tap pressed and released between two ticks. Deliver the press
      // on the next tick and the release on the one after, so the pressed
      // phase still reaches the extractor.
      next = packet;
      nextId = id;
    } else {
      latest = packet;
      latestId = id;
    }
    dirty = true;
    leftBeforeSample = false;
  };
  const release = () => {
    latest = null;
    next = null;
    latestId = null;
    nextId = null;
    dirty = false;
    lastActiveSequence = null;
    leftBeforeSample = false;
  };
  // A tap can start and leave between two ticks (touch fires pointerleave
  // right after pointerup); deliver its unsampled packet once before release.
  const onLeave = (event?: PointerEvent) => {
    if (!isPrimaryPointer(event)) {
      return;
    }
    // Only the pointer that produced the newest packet ends pointer input.
    if (!sharesPointer(pointerIdOf(event), next ? nextId : latestId)) {
      return;
    }
    if (dirty) leftBeforeSample = true;
    else release();
  };
  // A cancel means the browser took over the gesture (usually touch
  // scrolling). Its pending packet was never a completed interaction, so drop
  // it now and let the next tick use the scripted source.
  const onCancel = (event?: PointerEvent) => {
    if (!isPrimaryPointer(event)) {
      return;
    }
    const id = pointerIdOf(event);
    const ownsLatest = latest !== null && sharesPointer(id, latestId);
    const ownsNext = next !== null && sharesPointer(id, nextId);
    if (ownsLatest && next && !ownsNext) {
      // The canceled pointer's packet is dropped; another pointer's queued
      // packet becomes the one the next tick delivers.
      latest = next;
      latestId = nextId;
      next = null;
      nextId = null;
      dirty = true;
    } else if (ownsLatest || (latest === null && ownsNext)) {
      release();
    } else if (ownsNext) {
      next = null;
      nextId = null;
    }
  };

  const moveEvents = ['pointermove', 'pointerdown', 'pointerup'] as const;
  for (const type of moveEvents) target.addEventListener(type, onMove);
  target.addEventListener('pointerleave', onLeave);
  target.addEventListener('pointercancel', onCancel);

  return {
    sample(sequence) {
      if (latest && dirty) {
        lastActiveSequence = sequence;
        dirty = false;
      }
      const active =
        latest !== null &&
        lastActiveSequence !== null &&
        sequence - lastActiveSequence < POINTER_IDLE_TICKS;
      lastKind = active ? 'pointer' : 'scripted';
      const packet = active && latest ? new Float32Array(latest) : fallback.sample(sequence);
      if (next) {
        latest = next;
        next = null;
        dirty = true;
      } else if (leftBeforeSample) {
        release();
      }
      return packet;
    },
    kind: () => lastKind,
    dispose() {
      for (const type of moveEvents) target.removeEventListener(type, onMove);
      target.removeEventListener('pointerleave', onLeave);
      target.removeEventListener('pointercancel', onCancel);
      fallback.dispose();
    },
  };
}

/**
 * A recorded input trace in the same JSON shape as the adapter's golden
 * fixtures (`crates/neuromorphic-adapter/tests/fixtures/*.json`), minus the
 * `expected` blocks. `u64` values are decimal strings. Replaying it from
 * `init` with the same seed and config reproduces the session bit-exactly.
 */
export interface TelemetryTrace {
  seed: string;
  config: number[];
  operations: Array<{ op: 'input'; sequence: string; samples: number[] } | { op: 'step' }>;
}

/**
 * Bounded recorder of the first `capacity` ticks after `init` (default 5 min at
 * the 50 ms demo tick). Replay must start from `init`, so it stops recording
 * rather than dropping early ticks.
 */
export function createTelemetryRecorder(seed: bigint, config: readonly number[], capacity = 6000) {
  const ticks: Array<{ sequence: bigint; samples: number[] }> = [];
  let truncated = false;

  return {
    /** Record one completed tick (call after its input and step succeeded). */
    record(sequence: bigint, packet: ArrayLike<number>) {
      if (packet.length !== TELEMETRY_PACKET_LENGTH) {
        throw new RangeError('telemetry packets must be [x, y, pressure]');
      }
      if (ticks.length >= capacity) {
        truncated = true;
        return;
      }
      ticks.push({ sequence, samples: Array.from(packet) });
    },
    /** Export the recording, or `null` once it exceeded its capacity. */
    trace(): TelemetryTrace | null {
      if (truncated) {
        return null;
      }
      return {
        seed: seed.toString(),
        config: [...config],
        operations: ticks.flatMap(({ sequence, samples }) => [
          { op: 'input' as const, sequence: sequence.toString(), samples: [...samples] },
          { op: 'step' as const },
        ]),
      };
    },
  };
}
