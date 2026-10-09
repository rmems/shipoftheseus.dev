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
  canonical_difference: string;
  canonical_dropped_fields: unknown;
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
  /**
   * How the input relates to corpus-ipc's re-encoding: `identical`, only
   * `formatting` (same JSON value), `dropped-fields` (input keys absent from
   * the re-encoding, listed in `droppedFields`), or `differs` (nothing more
   * specific is known).
   */
  canonicalDifference: CanonicalDifference;
  droppedFields: string[];
}

export type CanonicalDifference = 'identical' | 'formatting' | 'dropped-fields' | 'differs';
const CANONICAL_DIFFERENCES: ReadonlySet<string> = new Set(['identical', 'formatting', 'dropped-fields', 'differs']);

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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * A readable message for anything thrown: an `Error`, a string thrown by
 * wasm-bindgen glue, or another primitive. Objects never print as
 * `[object Object]`.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  switch (typeof error) {
    case 'string':
      return error;
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'symbol':
      return error.toString();
    default:
      return 'Unknown error';
  }
}

// Each `WasmProtocolInspection` getter allocates on the WASM side (strings and
// typed arrays are copied out of linear memory). The readers below call every
// getter at most once, check that local value, and copy it into JS-owned
// storage. Only the decoded variant's row getters are read.

function readStimuli(raw: RawProtocolInspection): NonNullable<ProtocolInspection['stimuli']> {
  const values = raw.stimulus_values;
  const validMask = raw.stimulus_valid_mask;
  if (
    !(values instanceof Float32Array) ||
    !(validMask === undefined || validMask instanceof Uint8Array) ||
    (validMask !== undefined && validMask.length !== values.length)
  ) {
    throw contractError('stimulus rows');
  }
  return { values: new Float32Array(values), validMask: validMask ? new Uint8Array(validMask) : null };
}

function readSpikes(raw: RawProtocolInspection): NonNullable<ProtocolInspection['spikes']> {
  const channels = raw.spike_channels;
  const times = raw.spike_times;
  const strengths = raw.spike_strengths;
  if (
    !(channels instanceof Uint16Array) ||
    !(times instanceof Uint32Array) ||
    !(strengths instanceof Float32Array) ||
    !sameLength(channels, times, strengths)
  ) {
    throw contractError('spike rows');
  }
  return { channels: new Uint16Array(channels), times: new Uint32Array(times), strengths: new Float32Array(strengths) };
}

function readTraces(raw: RawProtocolInspection): NonNullable<ProtocolInspection['traces']> {
  const channelIds = raw.trace_channel_ids;
  const values = raw.trace_values;
  const lastSpikeTimes = raw.trace_last_spike_times;
  if (
    !(channelIds instanceof Uint16Array) ||
    !(values instanceof Float32Array) ||
    !(lastSpikeTimes instanceof Uint32Array) ||
    !sameLength(channelIds, values, lastSpikeTimes)
  ) {
    throw contractError('trace rows');
  }
  return {
    channelIds: new Uint16Array(channelIds),
    values: new Float32Array(values),
    lastSpikeTimes: new Uint32Array(lastSpikeTimes),
  };
}

function readMetadata(raw: RawProtocolInspection): ProtocolInspection['metadata'] {
  const present = raw.metadata_present;
  if (typeof present !== 'boolean') throw contractError('metadata');
  if (!present) return null;
  const source = raw.metadata_source;
  const processingLatencyNs = raw.metadata_processing_latency_ns;
  const custom = raw.metadata_custom;
  if (!optionalString(source) || !optionalU64(processingLatencyNs) || !isStringPairs(custom)) {
    throw contractError('metadata');
  }
  return {
    source: source ?? null,
    processingLatencyNs: processingLatencyNs ?? null,
    custom: custom.map(([key, value]) => [key, value] as [string, string]),
  };
}

function readWireVersion(raw: RawProtocolInspection): Pick<ProtocolInspection, 'wireVersion' | 'wireWindow'> {
  const wireVersion = raw.wire_version;
  const minSupported = raw.wire_min_supported;
  const current = raw.wire_current;
  if (
    wireVersion !== PROTOCOL_WIRE_VERSION ||
    !Number.isInteger(minSupported) ||
    !Number.isInteger(current) ||
    wireVersion < minSupported ||
    wireVersion > current
  ) {
    throw contractError('wire version');
  }
  return { wireVersion, wireWindow: { minSupported, current } };
}

function readCanonical(
  raw: RawProtocolInspection,
): Pick<ProtocolInspection, 'canonicalJson' | 'canonicalMatchesInput' | 'canonicalDifference' | 'droppedFields'> {
  const canonicalJson = raw.canonical_json;
  const canonicalMatchesInput = raw.canonical_matches_input;
  const canonicalDifference = raw.canonical_difference;
  const droppedFields = raw.canonical_dropped_fields;
  if (
    typeof canonicalJson !== 'string' ||
    typeof canonicalMatchesInput !== 'boolean' ||
    !CANONICAL_DIFFERENCES.has(canonicalDifference) ||
    canonicalMatchesInput !== (canonicalDifference === 'identical') ||
    !isStringArray(droppedFields) ||
    (canonicalDifference === 'dropped-fields') !== droppedFields.length > 0
  ) {
    throw contractError('canonical encoding');
  }
  return {
    canonicalJson,
    canonicalMatchesInput,
    canonicalDifference: canonicalDifference as CanonicalDifference,
    droppedFields: [...droppedFields],
  };
}

/** Check one accepted inspection and copy it into JS-owned values. */
export function toProtocolInspection(
  raw: RawProtocolInspection,
  bytes: Uint8Array,
  expectedSha256: string,
  expectedVariant: ProtocolVariant,
): ProtocolInspection {
  if (!raw || typeof raw !== 'object') throw contractError('not an object');
  const variant = raw.variant;
  if (!isProtocolVariant(variant) || variant !== expectedVariant) throw contractError('variant');
  const sha256 = raw.sha256;
  const byteLength = raw.byte_length;
  if (sha256 !== expectedSha256 || byteLength !== bytes.length) throw contractError('digest or size');
  const batchId = raw.batch_id;
  const timestamp = raw.timestamp;
  if (!isU64(batchId) || !optionalU64(timestamp)) throw contractError('u64 values must be bigint');
  const sessionId = raw.session_id;
  if (!optionalString(sessionId)) throw contractError('strings');

  return {
    variant,
    ...readWireVersion(raw),
    sha256,
    byteLength,
    sessionId: sessionId ?? null,
    batchId,
    timestamp: timestamp ?? null,
    stimuli: variant === 'Stimuli' ? readStimuli(raw) : null,
    spikes: variant === 'Spikes' ? readSpikes(raw) : null,
    traces: variant === 'EligibilityTraces' ? readTraces(raw) : null,
    metadata: readMetadata(raw),
    ...readCanonical(raw),
  };
}

function adapterFailure(error: unknown): ProtocolFixtureError {
  if (error instanceof ProtocolFixtureError) return error;
  const message = errorMessage(error);
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
      `The Rust/WASM adapter failed to load: ${errorMessage(error)}`,
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

/**
 * Shortest decimal that round-trips to the same `f32`, for display. Keeps
 * the sign of `-0`, which `String(-0)` and `===` would both drop.
 */
export function formatF32(value: number): string {
  if (Object.is(value, -0)) return '-0';
  if (!Number.isFinite(value)) return String(value);
  for (let digits = 1; digits <= 9; digits += 1) {
    const candidate = Number(value.toPrecision(digits));
    if (Math.fround(candidate) === value) return String(candidate);
  }
  return String(value);
}
