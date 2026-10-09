/**
 * Browser bridge to the recorded-protocol export of the single
 * `neuromorphic-adapter` WASM package. Rust (`corpus-ipc`) enforces the byte
 * limit, digest, wire version, schema, validation, and kind; this module only
 * moves bytes in, checks the adapter's output contract, and copies the result
 * into JS-owned values. Every `u64` stays a `bigint`.
 */
import {
  PROTOCOL_WIRE_VERSION,
  isProtocolErrorCode,
  isProtocolVariant,
  type ProtocolErrorCode,
  type ProtocolVariant,
} from './provenance';

/** Adapter reason codes plus bridge-side failures that also fail closed. */
export type ProtocolFailureCode =
  | ProtocolErrorCode
  | 'wasm-unavailable'
  | 'fetch-failed'
  | 'adapter-error'
  | 'adapter-contract';

export class ProtocolFixtureError extends Error {
  readonly code: ProtocolFailureCode;

  constructor(code: ProtocolFailureCode, message: string) {
    super(message);
    this.name = 'ProtocolFixtureError';
    this.code = code;
  }
}

interface RawProtocolInspection {
  variant: string;
  wire_version: number;
  wire_min_supported: number;
  wire_current: number;
  sha256: string;
  byte_length: number;
  session_id: string | undefined;
  batch_id: bigint;
  timestamp: bigint | undefined;
  stimulus_values: Float32Array;
  stimulus_valid_mask: Uint8Array | undefined;
  spike_channels: Uint16Array;
  spike_times: Uint32Array;
  spike_strengths: Float32Array;
  trace_channel_ids: Uint16Array;
  trace_values: Float32Array;
  trace_last_spike_times: Uint32Array;
  metadata_present: boolean;
  metadata_source: string | undefined;
  metadata_processing_latency_ns: bigint | undefined;
  metadata_custom: unknown;
  canonical_json: string;
  canonical_matches_input: boolean;
  free?: () => void;
}

export interface ProtocolWasmModule {
  default(): Promise<unknown>;
  inspectProtocolFixture(bytes: Uint8Array, expectedSha256: string, expectedVariant: string): RawProtocolInspection;
  protocolFixtureByteLimit(): number;
}

export interface ProtocolInspection {
  variant: ProtocolVariant;
  wireVersion: number;
  wireWindow: { minSupported: number; current: number };
  sha256: string;
  byteLength: number;
  sessionId: string | null;
  batchId: bigint;
  timestamp: bigint | null;
  stimuli: { values: Float32Array; validMask: Uint8Array | null } | null;
  spikes: { channels: Uint16Array; times: Uint32Array; strengths: Float32Array } | null;
  traces: { channelIds: Uint16Array; values: Float32Array; lastSpikeTimes: Uint32Array } | null;
  metadata: { source: string | null; processingLatencyNs: bigint | null; custom: Array<[string, string]> } | null;
  canonicalJson: string;
  canonicalMatchesInput: boolean;
}

export interface ProtocolInspector {
  /** The adapter's pre-parse byte limit. */
  byteLimit: number;
  inspect(bytes: Uint8Array, expectedSha256: string, expectedVariant: ProtocolVariant): ProtocolInspection;
}

const MAX_U64 = (1n << 64n) - 1n;

function isU64(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_U64;
}

function optionalU64(value: unknown): value is bigint | undefined {
  return value === undefined || isU64(value);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isStringPairs(value: unknown): value is Array<[string, string]> {
  return (
    Array.isArray(value) &&
    value.every(
      (pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string',
    )
  );
}

function contractError(detail: string): ProtocolFixtureError {
  return new ProtocolFixtureError('adapter-contract', `The Rust/WASM adapter returned an invalid inspection: ${detail}.`);
}

function sameLength(...arrays: ArrayLike<unknown>[]): boolean {
  return arrays.every((array) => array.length === arrays[0].length);
}

/** Copy one accepted inspection into JS-owned values after checking its shape. */
export function toProtocolInspection(
  raw: RawProtocolInspection,
  bytes: Uint8Array,
  expectedSha256: string,
  expectedVariant: ProtocolVariant,
): ProtocolInspection {
  if (!raw || typeof raw !== 'object') throw contractError('not an object');
  if (!isProtocolVariant(raw.variant) || raw.variant !== expectedVariant) throw contractError('variant');
  if (
    raw.wire_version !== PROTOCOL_WIRE_VERSION ||
    !Number.isInteger(raw.wire_min_supported) ||
    !Number.isInteger(raw.wire_current) ||
    raw.wire_version < raw.wire_min_supported ||
    raw.wire_version > raw.wire_current
  ) {
    throw contractError('wire version');
  }
  if (raw.sha256 !== expectedSha256 || raw.byte_length !== bytes.length) throw contractError('digest or size');
  if (!isU64(raw.batch_id) || !optionalU64(raw.timestamp) || !optionalU64(raw.metadata_processing_latency_ns)) {
    throw contractError('u64 values must be bigint');
  }
  if (!optionalString(raw.session_id) || !optionalString(raw.metadata_source)) throw contractError('strings');
  if (
    !(raw.stimulus_values instanceof Float32Array) ||
    !(raw.stimulus_valid_mask === undefined || raw.stimulus_valid_mask instanceof Uint8Array) ||
    !(raw.spike_channels instanceof Uint16Array) ||
    !(raw.spike_times instanceof Uint32Array) ||
    !(raw.spike_strengths instanceof Float32Array) ||
    !(raw.trace_channel_ids instanceof Uint16Array) ||
    !(raw.trace_values instanceof Float32Array) ||
    !(raw.trace_last_spike_times instanceof Uint32Array) ||
    !sameLength(raw.spike_channels, raw.spike_times, raw.spike_strengths) ||
    !sameLength(raw.trace_channel_ids, raw.trace_values, raw.trace_last_spike_times)
  ) {
    throw contractError('typed arrays');
  }
  if (typeof raw.metadata_present !== 'boolean' || !isStringPairs(raw.metadata_custom)) throw contractError('metadata');
  if (typeof raw.canonical_json !== 'string' || typeof raw.canonical_matches_input !== 'boolean') {
    throw contractError('canonical encoding');
  }

  const variant = raw.variant;
  return {
    variant,
    wireVersion: raw.wire_version,
    wireWindow: { minSupported: raw.wire_min_supported, current: raw.wire_current },
    sha256: raw.sha256,
    byteLength: raw.byte_length,
    sessionId: raw.session_id ?? null,
    batchId: raw.batch_id,
    timestamp: raw.timestamp ?? null,
    stimuli:
      variant === 'Stimuli'
        ? {
            values: new Float32Array(raw.stimulus_values),
            validMask: raw.stimulus_valid_mask ? new Uint8Array(raw.stimulus_valid_mask) : null,
          }
        : null,
    spikes:
      variant === 'Spikes'
        ? {
            channels: new Uint16Array(raw.spike_channels),
            times: new Uint32Array(raw.spike_times),
            strengths: new Float32Array(raw.spike_strengths),
          }
        : null,
    traces:
      variant === 'EligibilityTraces'
        ? {
            channelIds: new Uint16Array(raw.trace_channel_ids),
            values: new Float32Array(raw.trace_values),
            lastSpikeTimes: new Uint32Array(raw.trace_last_spike_times),
          }
        : null,
    metadata: raw.metadata_present
      ? {
          source: raw.metadata_source ?? null,
          processingLatencyNs: raw.metadata_processing_latency_ns ?? null,
          custom: raw.metadata_custom.map(([key, value]) => [key, value] as [string, string]),
        }
      : null,
    canonicalJson: raw.canonical_json,
    canonicalMatchesInput: raw.canonical_matches_input,
  };
}

function adapterFailure(error: unknown): ProtocolFixtureError {
  if (error instanceof ProtocolFixtureError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return isProtocolErrorCode(code)
    ? new ProtocolFixtureError(code, message)
    : new ProtocolFixtureError('adapter-error', message);
}

/**
 * Load the adapter package and return an inspector. Throws
 * `ProtocolFixtureError('wasm-unavailable')` when WebAssembly or `bigint` is
 * missing or the package fails to load; callers keep the static view.
 */
export async function createProtocolInspector(
  loadWasmModule: () => Promise<ProtocolWasmModule>,
): Promise<ProtocolInspector> {
  if (typeof WebAssembly === 'undefined' || typeof BigInt === 'undefined') {
    throw new ProtocolFixtureError('wasm-unavailable', 'WebAssembly with BigInt support is unavailable in this browser.');
  }
  let wasm: ProtocolWasmModule;
  try {
    wasm = await loadWasmModule();
    await wasm.default();
  } catch (error) {
    throw new ProtocolFixtureError(
      'wasm-unavailable',
      `The Rust/WASM adapter failed to load: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof wasm.inspectProtocolFixture !== 'function' || typeof wasm.protocolFixtureByteLimit !== 'function') {
    throw new ProtocolFixtureError('wasm-unavailable', 'The Rust/WASM adapter does not export the protocol viewer.');
  }
  const byteLimit = wasm.protocolFixtureByteLimit();
  if (!Number.isSafeInteger(byteLimit) || byteLimit <= 0) {
    throw contractError('byte limit');
  }

  return {
    byteLimit,
    inspect(bytes, expectedSha256, expectedVariant) {
      let raw: RawProtocolInspection;
      try {
        // wasm-bindgen copies the bytes into WASM memory before Rust runs.
        raw = wasm.inspectProtocolFixture(bytes, expectedSha256, expectedVariant);
      } catch (error) {
        throw adapterFailure(error);
      }
      try {
        return toProtocolInspection(raw, bytes, expectedSha256, expectedVariant);
      } finally {
        raw.free?.();
      }
    },
  };
}

/**
 * Read at most `limit + 1` bytes so an oversize response is never buffered in
 * full; the adapter then reports `oversize` itself.
 */
export async function readBoundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok) {
    throw new ProtocolFixtureError('fetch-failed', `Fixture request failed with HTTP ${response.status}.`);
  }
  const cap = limit + 1;
  if (!response.body) {
    const whole = new Uint8Array(await response.arrayBuffer());
    return whole.length > cap ? whole.slice(0, cap) : whole;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  if (total >= cap) await reader.cancel();
  const bytes = new Uint8Array(Math.min(total, cap));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, bytes.length - offset);
    bytes.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset === bytes.length) break;
  }
  return bytes;
}

/** Shortest decimal that round-trips to the same `f32`, for display. */
export function formatF32(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  for (let digits = 1; digits <= 9; digits += 1) {
    const candidate = Number(value.toPrecision(digits));
    if (Math.fround(candidate) === value) return String(candidate);
  }
  return String(value);
}
