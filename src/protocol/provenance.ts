/**
 * Recorded provenance for the `/protocol/` viewer (GitHub #21 / RM-1657).
 *
 * These values describe the locked `corpus-ipc` surface the Rust/WASM adapter
 * links. They are display constants, checked by `test/protocol-viewer.test.mjs`
 * against `crates/neuromorphic-adapter/Cargo.toml`, `Cargo.lock`, and the
 * adapter's own exports. Nothing here re-describes the IPC schema.
 */
export const CORPUS_IPC_CRATE = 'corpus-ipc';
export const CORPUS_IPC_VERSION = '0.1.0';
export const CORPUS_IPC_REQUIREMENT = '=0.1.0';
export const CORPUS_IPC_SOURCE_REPOSITORY = 'https://github.com/Limen-Neural/corpus-ipc';
/** Audited source tag, also recorded in the crate's `.cargo_vcs_info.json`. */
export const CORPUS_IPC_SOURCE_SHA = 'd99e6544d7925dc0ccfe69fdff372352b0a9d041';
/** crates.io archive SHA-256, identical to the `Cargo.lock` checksum. */
export const CORPUS_IPC_ARCHIVE_SHA256 = 'eec6624caf88783f1c35109fe1c27615fc85c986249d480c8efabb72d5f92081';
export const CORPUS_IPC_FEATURES = 'default-features = false (no zmq, no server)';
export const CORPUS_IPC_LOCKFILE = 'crates/neuromorphic-adapter/Cargo.lock';
export const PROTOCOL_TRANSPORT = 'Offline: checked-in fixture bytes. No ZeroMQ, HTTP service, proxy, or live producer.';
export const PROTOCOL_DECODE_PATH = 'WireEnvelope::<IpcMessage>::decode_json, then Validate::validate()';
export const PROTOCOL_WIRE_VERSION = 1;

/** Mirrors `MAX_PROTOCOL_FIXTURE_BYTES`; the adapter's export is authoritative. */
export const PROTOCOL_FIXTURE_BYTE_LIMIT = 64 * 1024;
export const PROTOCOL_FIXTURE_DIR = 'public/protocol/fixtures/v1';
export const PROTOCOL_FIXTURE_URL_BASE = '/protocol/fixtures/v1/';
export const PROTOCOL_MANIFEST_FILE = 'manifest.json';
export const PROTOCOL_FIXTURE_GENERATOR = 'crates/neuromorphic-adapter/tests/protocol_fixtures.rs';
export const PROTOCOL_WASM_MODULE_URL = '/wasm/neuromorphic-adapter/neuromorphic_adapter.js';

export const PROTOCOL_VARIANTS = ['Stimuli', 'Spikes', 'EligibilityTraces'] as const;
export type ProtocolVariant = (typeof PROTOCOL_VARIANTS)[number];

export function isProtocolVariant(value: unknown): value is ProtocolVariant {
  return typeof value === 'string' && (PROTOCOL_VARIANTS as readonly string[]).includes(value);
}

/**
 * Stable adapter reason codes (`ProtocolErrorCode::as_str` in
 * `crates/neuromorphic-adapter/src/protocol.rs`), with reader-facing meaning.
 */
export const PROTOCOL_ERROR_CODES = {
  'expected-variant-unsupported': 'The declared variant is not Stimuli, Spikes, or EligibilityTraces.',
  'expected-digest-invalid': 'The out-of-band SHA-256 is not 64 lowercase hex characters.',
  oversize: 'The bytes exceed the pre-parse limit; nothing is hashed or parsed.',
  'digest-mismatch': 'SHA-256 over the exact bytes differs from the out-of-band digest.',
  'malformed-json': 'The bytes are not one syntactically valid JSON document.',
  'envelope-not-object': 'The document is not a JSON object (for example legacy "Ping").',
  'wire-version-missing': 'No wire_version. Legacy unversioned JSON is not accepted here.',
  'wire-version-null': 'wire_version is null.',
  'wire-version-duplicate': 'wire_version appears more than once.',
  'wire-version-invalid': 'wire_version is not a non-negative integer that fits u32.',
  'wire-version-too-old': 'wire_version is below the oldest version corpus-ipc supports.',
  'wire-version-too-new': 'wire_version is newer than corpus-ipc understands.',
  'payload-missing': 'No payload after the version check.',
  'payload-null': 'payload is null.',
  'payload-duplicate': 'payload appears more than once.',
  'unknown-variant': 'The payload names an IpcMessage variant corpus-ipc does not define.',
  'invalid-typed-data': 'The payload does not match the typed corpus-ipc schema.',
  'validation-failed': 'corpus-ipc validation rejected the payload (finite values, limits, lengths, unique ids).',
  'kind-mismatch': 'The decoded variant differs from the declared one.',
  'canonical-encoding-failed': 'corpus-ipc could not re-encode the accepted envelope.',
} as const;
export type ProtocolErrorCode = keyof typeof PROTOCOL_ERROR_CODES;

export function isProtocolErrorCode(value: unknown): value is ProtocolErrorCode {
  return typeof value === 'string' && Object.hasOwn(PROTOCOL_ERROR_CODES, value);
}
