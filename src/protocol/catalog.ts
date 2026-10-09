import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { errorMessage } from './inspector';
import {
  PROTOCOL_FIXTURE_BYTE_LIMIT,
  PROTOCOL_FIXTURE_DIR,
  PROTOCOL_FIXTURE_URL_BASE,
  PROTOCOL_MANIFEST_FILE,
  PROTOCOL_VARIANTS,
  PROTOCOL_WIRE_VERSION,
  isProtocolVariant,
  type ProtocolVariant,
} from './provenance';

/**
 * Build-time ingest of the recorded protocol fixtures for the static
 * `/protocol/` page. It checks the manifest shape and that every fixture's
 * exact bytes match its out-of-band size and SHA-256, then exposes the bytes
 * as text. It never parses the envelopes: decoding and validation belong to
 * `corpus-ipc` inside the Rust/WASM adapter.
 */
export interface ProtocolFixture {
  id: string;
  file: string;
  url: string;
  variant: ProtocolVariant;
  bytes: number;
  sha256: string;
  derivation: string;
  /** The exact recorded bytes, decoded as UTF-8 for display only. */
  text: string;
}

export interface ProtocolFixtureCatalog {
  wireVersion: number;
  generator: string;
  sourceTrace: string;
  sourceStep: number;
  fixtures: ProtocolFixture[];
}

const MANIFEST_SCHEMA = 'shipoftheseus.protocol-fixtures';
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function fail(message: string): never {
  throw new Error(`Protocol fixture catalog failed closed: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) fail(`${key} must be a non-empty string`);
  return value;
}

function requireInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${key} must be a non-negative integer`);
  }
  return value;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function protocolFixtureDirectory(cwd = process.cwd()): string {
  return resolve(cwd, PROTOCOL_FIXTURE_DIR);
}

export function loadProtocolFixtureCatalog(directory = protocolFixtureDirectory()): ProtocolFixtureCatalog {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(resolve(directory, PROTOCOL_MANIFEST_FILE), 'utf8'));
  } catch (error) {
    fail(`${PROTOCOL_MANIFEST_FILE} is unreadable: ${errorMessage(error)}`);
  }
  if (!isRecord(manifest)) fail('manifest must be an object');
  if (manifest.schema !== MANIFEST_SCHEMA || manifest.schema_version !== 1) fail('unsupported manifest schema');
  if (manifest.wire_version !== PROTOCOL_WIRE_VERSION) fail('manifest wire_version must be 1');
  if (!Array.isArray(manifest.fixtures)) fail('fixtures must be an array');

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const fixtures = manifest.fixtures.map((entry: unknown): ProtocolFixture => {
    if (!isRecord(entry)) fail('every fixture entry must be an object');
    const id = requireString(entry, 'id');
    if (!SAFE_ID.test(id)) fail(`fixture id ${JSON.stringify(id)} is not a safe slug`);
    const file = requireString(entry, 'file');
    if (file !== `${id}.json`) fail(`fixture ${id} must be stored as ${id}.json`);
    const variant = entry.variant;
    if (!isProtocolVariant(variant)) fail(`fixture ${id} declares an unsupported variant`);
    const sha256 = requireString(entry, 'sha256');
    if (!SHA256_HEX.test(sha256)) fail(`fixture ${id} sha256 must be 64 lowercase hex characters`);
    const size = requireInteger(entry, 'bytes');
    const derivation = requireString(entry, 'derivation');

    const bytes = readFileSync(resolve(directory, file));
    if (bytes.length > PROTOCOL_FIXTURE_BYTE_LIMIT) fail(`fixture ${id} exceeds the byte limit`);
    if (bytes.length !== size) fail(`fixture ${id} is ${bytes.length} bytes, manifest says ${size}`);
    const actual = sha256Hex(bytes);
    if (actual !== sha256) fail(`fixture ${id} SHA-256 is ${actual}, manifest says ${sha256}`);

    return {
      id,
      file,
      url: `${PROTOCOL_FIXTURE_URL_BASE}${file}`,
      variant,
      bytes: size,
      sha256,
      derivation,
      text: decoder.decode(bytes),
    };
  });

  const variants = fixtures.map((fixture) => fixture.variant);
  if (variants.length !== PROTOCOL_VARIANTS.length || PROTOCOL_VARIANTS.some((variant) => !variants.includes(variant))) {
    fail('the catalog must hold exactly one Stimuli, one Spikes, and one EligibilityTraces fixture');
  }

  return {
    wireVersion: PROTOCOL_WIRE_VERSION,
    generator: requireString(manifest, 'generator'),
    sourceTrace: requireString(manifest, 'source_trace'),
    sourceStep: requireInteger(manifest, 'source_step'),
    fixtures,
  };
}
