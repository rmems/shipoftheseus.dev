import {
  NATIVE_EVIDENCE_SCHEMA_ID,
  NATIVE_EVIDENCE_SCHEMA_VERSION,
  type CudaBenchmarkArtifact,
  type FpgaSnnTraceArtifact,
  type NativeEvidenceArtifact,
  type NativeEvidenceHardware,
  type NativeEvidenceIssue,
  type NativeEvidenceIssueCode,
  type NativeEvidenceKind,
  type NativeEvidenceProvenance,
  type NativeEvidenceRecordStatus,
  type NativeEvidenceResult,
  type NativeEvidenceStatistic,
  type NativeEvidenceTraceEvent,
  type NativeEvidenceWorkload,
  type ParseNativeEvidenceOptions,
} from './types';

const MAX_TITLE_LENGTH = 160;
const MAX_SUMMARY_LENGTH = 500;
const MAX_RESULTS = 64;
const MAX_TRACES = 4096;
const MAX_PARAMETERS = 32;
const ARTIFACT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_REVISION = /^[a-f0-9]{40}$/;
const SOURCE_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/;
const CRATE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CAPTURED_AT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const UNIT = /^[^\s](?:.*[^\s])?$/;

const ARTIFACT_KEYS = new Set([
  'schema',
  'schemaVersion',
  'id',
  'kind',
  'title',
  'summary',
  'capturedAt',
  'recordStatus',
  'provenance',
  'hardware',
  'workload',
  'results',
  'traces',
]);

const PROVENANCE_KEYS = new Set([
  'sourceRepository',
  'sourceRevision',
  'sourcePath',
  'crateName',
  'crateVersion',
  'captureCommand',
]);

const HARDWARE_KEYS = new Set(['class', 'deviceName', 'vendor', 'architecture', 'driverVersion']);
const WORKLOAD_KEYS = new Set(['name', 'description', 'parameters']);
const RESULT_KEYS = new Set(['name', 'value', 'unit', 'statistic']);
const TRACE_KEYS = new Set(['timeNs', 'neuronId', 'event']);

export type NativeEvidenceParseResult =
  | { ok: true; artifact: NativeEvidenceArtifact }
  | { ok: false; issue: NativeEvidenceIssue };

type ParseFailure = Extract<NativeEvidenceParseResult, { ok: false }>;

function assertNever(value: never, label: string): never {
  throw new Error(`Unhandled ${label}: ${String(value)}`);
}

function fail(
  code: NativeEvidenceIssueCode,
  message: string,
  path?: string,
): ParseFailure {
  return { ok: false, issue: { code, message, path } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownKeys(value: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function nonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= maxLength;
}

function optionalNonEmptyString(value: unknown, maxLength: number): value is string {
  return nonEmptyString(value, maxLength);
}

function filenameId(path: string): string {
  const filename = path.split(/[/\\]/).pop() ?? path;
  return filename.replace(/\.json$/i, '');
}

export function parseNativeEvidenceJson(
  text: string,
  options: ParseNativeEvidenceOptions = {},
): NativeEvidenceParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return fail('invalid-json', 'Artifact is not valid JSON.', options.path);
  }

  return parseNativeEvidenceValue(parsed, options);
}

export function parseNativeEvidenceValue(
  value: unknown,
  options: ParseNativeEvidenceOptions = {},
): NativeEvidenceParseResult {
  if (!isRecord(value)) {
    return fail('invalid-artifact', 'Artifact must be a JSON object.', options.path);
  }

  if ('schemaVersion' in value) {
    const version = value.schemaVersion;
    if (typeof version === 'number' && Number.isInteger(version) && version !== NATIVE_EVIDENCE_SCHEMA_VERSION) {
      return fail(
        'unsupported-version',
        `Unsupported native-evidence schema version ${String(version)}. Expected ${NATIVE_EVIDENCE_SCHEMA_VERSION}.`,
        options.path,
      );
    }
  }

  const extra = unknownKeys(value, ARTIFACT_KEYS);
  if (extra.length > 0) {
    return fail('invalid-artifact', `Unknown artifact field(s): ${extra.join(', ')}.`, options.path);
  }

  if (value.schema !== NATIVE_EVIDENCE_SCHEMA_ID) {
    return fail(
      'invalid-artifact',
      `schema must be "${NATIVE_EVIDENCE_SCHEMA_ID}".`,
      options.path,
    );
  }

  if (value.schemaVersion !== NATIVE_EVIDENCE_SCHEMA_VERSION) {
    if (typeof value.schemaVersion === 'number') {
      return fail(
        'unsupported-version',
        `Unsupported native-evidence schema version ${String(value.schemaVersion)}. Expected ${NATIVE_EVIDENCE_SCHEMA_VERSION}.`,
        options.path,
      );
    }
    return fail('invalid-artifact', 'schemaVersion must be the integer 1.', options.path);
  }

  if (!nonEmptyString(value.id, 80) || !ARTIFACT_ID.test(value.id)) {
    return fail('invalid-artifact', 'id must be a kebab-case identifier.', options.path);
  }

  if (options.requireIdMatchesFilename && options.path) {
    const expected = filenameId(options.path);
    if (expected !== value.id) {
      return fail(
        'id-filename-mismatch',
        `Artifact id "${value.id}" must match filename "${expected}".`,
        options.path,
      );
    }
  }

  const kindResult = parseKind(value.kind, options.path);
  if (!kindResult.ok) {
    return kindResult;
  }

  const recordStatusResult = parseRecordStatus(value.recordStatus, options.path);
  if (!recordStatusResult.ok) {
    return recordStatusResult;
  }

  if (!nonEmptyString(value.title, MAX_TITLE_LENGTH)) {
    return fail('invalid-artifact', 'title must be a non-empty string.', options.path);
  }

  let summary: string | undefined;
  if ('summary' in value) {
    if (!optionalNonEmptyString(value.summary, MAX_SUMMARY_LENGTH)) {
      return fail('invalid-artifact', 'summary must be a non-empty string when present.', options.path);
    }
    summary = value.summary;
  }

  if (typeof value.capturedAt !== 'string' || !CAPTURED_AT.test(value.capturedAt) || Number.isNaN(Date.parse(value.capturedAt))) {
    return fail('invalid-artifact', 'capturedAt must be an ISO-8601 UTC timestamp.', options.path);
  }

  const provenance = parseProvenance(value.provenance, recordStatusResult.status, options.path);
  if (!provenance.ok) {
    return provenance;
  }

  const hardware = parseHardware(value.hardware, kindResult.kind, options.path);
  if (!hardware.ok) {
    return hardware;
  }

  const workload = parseWorkload(value.workload, options.path);
  if (!workload.ok) {
    return workload;
  }

  const results = parseResults(value.results, options.path);
  if (!results.ok) {
    return results;
  }

  const traces = parseTraces(value.traces, options.path);
  if (!traces.ok) {
    return traces;
  }

  switch (kindResult.kind) {
    case 'cuda-benchmark': {
      if (hardware.hardware.class !== 'cuda') {
        return fail('invalid-artifact', 'cuda-benchmark artifacts require hardware.class "cuda".', options.path);
      }
      if (results.results === undefined || results.results.length === 0) {
        return fail('invalid-artifact', 'cuda-benchmark artifacts require at least one result with units.', options.path);
      }
      const artifact: CudaBenchmarkArtifact = {
        schema: NATIVE_EVIDENCE_SCHEMA_ID,
        schemaVersion: NATIVE_EVIDENCE_SCHEMA_VERSION,
        id: value.id,
        kind: 'cuda-benchmark',
        title: value.title,
        summary,
        capturedAt: value.capturedAt,
        recordStatus: recordStatusResult.status,
        provenance: provenance.provenance,
        hardware: { ...hardware.hardware, class: 'cuda' },
        workload: workload.workload,
        results: results.results,
        traces: traces.traces,
      };
      return { ok: true, artifact };
    }
    case 'fpga-snn-trace': {
      if (hardware.hardware.class !== 'fpga') {
        return fail('invalid-artifact', 'fpga-snn-trace artifacts require hardware.class "fpga".', options.path);
      }
      if (traces.traces === undefined || traces.traces.length === 0) {
        return fail('invalid-artifact', 'fpga-snn-trace artifacts require at least one hardware trace event.', options.path);
      }
      const artifact: FpgaSnnTraceArtifact = {
        schema: NATIVE_EVIDENCE_SCHEMA_ID,
        schemaVersion: NATIVE_EVIDENCE_SCHEMA_VERSION,
        id: value.id,
        kind: 'fpga-snn-trace',
        title: value.title,
        summary,
        capturedAt: value.capturedAt,
        recordStatus: recordStatusResult.status,
        provenance: provenance.provenance,
        hardware: { ...hardware.hardware, class: 'fpga' },
        workload: workload.workload,
        traces: traces.traces,
        results: results.results,
      };
      return { ok: true, artifact };
    }
    default:
      return assertNever(kindResult.kind, 'native evidence kind');
  }
}

function parseKind(
  value: unknown,
  path?: string,
): { ok: true; kind: NativeEvidenceKind } | ParseFailure {
  if (value === 'cuda-benchmark' || value === 'fpga-snn-trace') {
    return { ok: true, kind: value };
  }

  return fail('invalid-artifact', 'kind must be "cuda-benchmark" or "fpga-snn-trace".', path);
}

function parseRecordStatus(
  value: unknown,
  path?: string,
): { ok: true; status: NativeEvidenceRecordStatus } | ParseFailure {
  if (value === 'measured' || value === 'synthetic') {
    return { ok: true, status: value };
  }

  return fail('invalid-artifact', 'recordStatus must be "measured" or "synthetic".', path);
}

function parseProvenance(
  value: unknown,
  recordStatus: NativeEvidenceRecordStatus,
  path?: string,
): { ok: true; provenance: NativeEvidenceProvenance } | ParseFailure {
  if (!isRecord(value)) {
    return fail('invalid-artifact', 'provenance must be an object.', path);
  }

  const extra = unknownKeys(value, PROVENANCE_KEYS);
  if (extra.length > 0) {
    return fail('invalid-artifact', `Unknown provenance field(s): ${extra.join(', ')}.`, path);
  }

  if (typeof value.sourceRepository !== 'string' || !isGitHubRepositoryUrl(value.sourceRepository)) {
    return fail('invalid-artifact', 'provenance.sourceRepository must be an https GitHub repository URL.', path);
  }

  if (typeof value.sourceRevision !== 'string' || !SOURCE_REVISION.test(value.sourceRevision)) {
    return fail('invalid-artifact', 'provenance.sourceRevision must be a 40-character lowercase Git SHA.', path);
  }

  if (typeof value.sourcePath !== 'string' || !SOURCE_PATH.test(value.sourcePath)) {
    return fail('invalid-artifact', 'provenance.sourcePath must be a relative repository path.', path);
  }

  const provenance: NativeEvidenceProvenance = {
    sourceRepository: value.sourceRepository.replace(/\.git$/, ''),
    sourceRevision: value.sourceRevision,
    sourcePath: value.sourcePath,
  };

  if ('crateName' in value) {
    if (!nonEmptyString(value.crateName, 80)) {
      return fail('invalid-artifact', 'provenance.crateName must be a non-empty string when present.', path);
    }
    provenance.crateName = value.crateName;
  }

  if ('crateVersion' in value) {
    if (typeof value.crateVersion !== 'string' || !CRATE_VERSION.test(value.crateVersion)) {
      return fail('invalid-artifact', 'provenance.crateVersion must be a semantic version when present.', path);
    }
    provenance.crateVersion = value.crateVersion;
  }

  if (recordStatus === 'measured') {
    if (!nonEmptyString(value.captureCommand, 240)) {
      return fail(
        'invalid-artifact',
        'Measured artifacts require a non-empty provenance.captureCommand.',
        path,
      );
    }
    provenance.captureCommand = value.captureCommand;
  } else if ('captureCommand' in value) {
    if (!nonEmptyString(value.captureCommand, 240)) {
      return fail('invalid-artifact', 'provenance.captureCommand must be a non-empty string when present.', path);
    }
    provenance.captureCommand = value.captureCommand;
  }

  return { ok: true, provenance };
}

function parseHardware(
  value: unknown,
  kind: NativeEvidenceKind,
  path?: string,
): { ok: true; hardware: NativeEvidenceHardware } | ParseFailure {
  if (!isRecord(value)) {
    return fail('invalid-artifact', 'hardware must be an object.', path);
  }

  const extra = unknownKeys(value, HARDWARE_KEYS);
  if (extra.length > 0) {
    return fail('invalid-artifact', `Unknown hardware field(s): ${extra.join(', ')}.`, path);
  }

  const expectedClass = hardwareClassForKind(kind);
  if (value.class !== expectedClass) {
    return fail('invalid-artifact', `hardware.class must be "${expectedClass}" for ${kind} artifacts.`, path);
  }

  if (!nonEmptyString(value.deviceName, 160)) {
    return fail('invalid-artifact', 'hardware.deviceName must be a non-empty string.', path);
  }

  const hardware: NativeEvidenceHardware = {
    class: expectedClass,
    deviceName: value.deviceName,
  };

  if ('vendor' in value) {
    if (!nonEmptyString(value.vendor, 80)) {
      return fail('invalid-artifact', 'hardware.vendor must be a non-empty string when present.', path);
    }
    hardware.vendor = value.vendor;
  }

  if ('architecture' in value) {
    if (!nonEmptyString(value.architecture, 80)) {
      return fail('invalid-artifact', 'hardware.architecture must be a non-empty string when present.', path);
    }
    hardware.architecture = value.architecture;
  }

  if ('driverVersion' in value) {
    if (!nonEmptyString(value.driverVersion, 80)) {
      return fail('invalid-artifact', 'hardware.driverVersion must be a non-empty string when present.', path);
    }
    hardware.driverVersion = value.driverVersion;
  }

  return { ok: true, hardware };
}

function hardwareClassForKind(kind: NativeEvidenceKind): NativeEvidenceHardware['class'] {
  switch (kind) {
    case 'cuda-benchmark':
      return 'cuda';
    case 'fpga-snn-trace':
      return 'fpga';
    default:
      return assertNever(kind, 'native evidence kind');
  }
}

function parseWorkload(
  value: unknown,
  path?: string,
): { ok: true; workload: NativeEvidenceWorkload } | ParseFailure {
  if (!isRecord(value)) {
    return fail('invalid-artifact', 'workload must be an object.', path);
  }

  const extra = unknownKeys(value, WORKLOAD_KEYS);
  if (extra.length > 0) {
    return fail('invalid-artifact', `Unknown workload field(s): ${extra.join(', ')}.`, path);
  }

  if (!nonEmptyString(value.name, 160)) {
    return fail('invalid-artifact', 'workload.name must be a non-empty string.', path);
  }

  const workload: NativeEvidenceWorkload = { name: value.name };

  if ('description' in value) {
    if (!optionalNonEmptyString(value.description, MAX_SUMMARY_LENGTH)) {
      return fail('invalid-artifact', 'workload.description must be a non-empty string when present.', path);
    }
    workload.description = value.description;
  }

  if ('parameters' in value) {
    if (!isRecord(value.parameters)) {
      return fail('invalid-artifact', 'workload.parameters must be an object when present.', path);
    }
    const entries = Object.entries(value.parameters);
    if (entries.length === 0 || entries.length > MAX_PARAMETERS) {
      return fail('invalid-artifact', 'workload.parameters must contain between 1 and 32 entries when present.', path);
    }
    const parameters: Record<string, string | number | boolean> = {};
    for (const [key, parameter] of entries) {
      if (!nonEmptyString(key, 80)) {
        return fail('invalid-artifact', 'workload.parameters keys must be non-empty strings.', path);
      }
      if (typeof parameter !== 'string' && typeof parameter !== 'number' && typeof parameter !== 'boolean') {
        return fail('invalid-artifact', 'workload.parameters values must be strings, numbers, or booleans.', path);
      }
      if (typeof parameter === 'number' && !Number.isFinite(parameter)) {
        return fail('invalid-artifact', 'workload.parameters numbers must be finite.', path);
      }
      parameters[key] = parameter;
    }
    workload.parameters = parameters;
  }

  return { ok: true, workload };
}

function parseResults(
  value: unknown,
  path?: string,
): { ok: true; results?: NativeEvidenceResult[] } | ParseFailure {
  if (value === undefined) {
    return { ok: true, results: undefined };
  }

  if (!Array.isArray(value)) {
    return fail('invalid-artifact', 'results must be an array when present.', path);
  }

  if (value.length === 0 || value.length > MAX_RESULTS) {
    return fail('invalid-artifact', `results must contain between 1 and ${MAX_RESULTS} entries when present.`, path);
  }

  const results: NativeEvidenceResult[] = [];
  for (const [index, entry] of value.entries()) {
    const parsed = parseResult(entry, path, index);
    if (!parsed.ok) {
      return parsed;
    }
    results.push(parsed.result);
  }

  return { ok: true, results };
}

function parseResult(
  value: unknown,
  path: string | undefined,
  index: number,
): { ok: true; result: NativeEvidenceResult } | ParseFailure {
  if (!isRecord(value)) {
    return fail('invalid-artifact', `results[${index}] must be an object.`, path);
  }

  const extra = unknownKeys(value, RESULT_KEYS);
  if (extra.length > 0) {
    return fail('invalid-artifact', `Unknown results[${index}] field(s): ${extra.join(', ')}.`, path);
  }

  if (!nonEmptyString(value.name, 80)) {
    return fail('invalid-artifact', `results[${index}].name must be a non-empty string.`, path);
  }

  if (typeof value.value !== 'number' || !Number.isFinite(value.value)) {
    return fail('invalid-artifact', `results[${index}].value must be a finite number.`, path);
  }

  if (typeof value.unit !== 'string' || !UNIT.test(value.unit) || value.unit.length > 32) {
    return fail('invalid-artifact', `results[${index}].unit must be a non-empty unit string.`, path);
  }

  const result: NativeEvidenceResult = {
    name: value.name,
    value: value.value,
    unit: value.unit,
  };

  if ('statistic' in value) {
    const statistic = parseStatistic(value.statistic, path, index);
    if (!statistic.ok) {
      return statistic;
    }
    result.statistic = statistic.statistic;
  }

  return { ok: true, result };
}

function parseStatistic(
  value: unknown,
  path: string | undefined,
  index: number,
): { ok: true; statistic: NativeEvidenceStatistic } | ParseFailure {
  switch (value) {
    case 'mean':
    case 'p50':
    case 'p95':
    case 'p99':
    case 'min':
    case 'max':
    case 'count':
    case 'other':
      return { ok: true, statistic: value };
    default:
      return fail(
        'invalid-artifact',
        `results[${index}].statistic must be mean, p50, p95, p99, min, max, count, or other.`,
        path,
      );
  }
}

function parseTraces(
  value: unknown,
  path?: string,
): { ok: true; traces?: NativeEvidenceTraceEvent[] } | ParseFailure {
  if (value === undefined) {
    return { ok: true, traces: undefined };
  }

  if (!Array.isArray(value)) {
    return fail('invalid-artifact', 'traces must be an array when present.', path);
  }

  if (value.length === 0 || value.length > MAX_TRACES) {
    return fail('invalid-artifact', `traces must contain between 1 and ${MAX_TRACES} events when present.`, path);
  }

  const traces: NativeEvidenceTraceEvent[] = [];
  for (const [index, entry] of value.entries()) {
    const parsed = parseTrace(entry, path, index);
    if (!parsed.ok) {
      return parsed;
    }
    traces.push(parsed.trace);
  }

  return { ok: true, traces };
}

function parseTrace(
  value: unknown,
  path: string | undefined,
  index: number,
): { ok: true; trace: NativeEvidenceTraceEvent } | ParseFailure {
  if (!isRecord(value)) {
    return fail('invalid-artifact', `traces[${index}] must be an object.`, path);
  }

  const extra = unknownKeys(value, TRACE_KEYS);
  if (extra.length > 0) {
    return fail('invalid-artifact', `Unknown traces[${index}] field(s): ${extra.join(', ')}.`, path);
  }

  if (typeof value.timeNs !== 'number' || !Number.isInteger(value.timeNs) || value.timeNs < 0) {
    return fail('invalid-artifact', `traces[${index}].timeNs must be a non-negative integer.`, path);
  }

  if (typeof value.neuronId !== 'number' || !Number.isInteger(value.neuronId) || value.neuronId < 0) {
    return fail('invalid-artifact', `traces[${index}].neuronId must be a non-negative integer.`, path);
  }

  const event = parseTraceEvent(value.event, path, index);
  if (!event.ok) {
    return event;
  }

  return {
    ok: true,
    trace: {
      timeNs: value.timeNs,
      neuronId: value.neuronId,
      event: event.event,
    },
  };
}

function parseTraceEvent(
  value: unknown,
  path: string | undefined,
  index: number,
): { ok: true; event: NativeEvidenceTraceEvent['event'] } | ParseFailure {
  switch (value) {
    case 'spike':
    case 'inhibit':
    case 'reset':
      return { ok: true, event: value };
    default:
      return fail('invalid-artifact', `traces[${index}].event must be spike, inhibit, or reset.`, path);
  }
}

export function isGitHubRepositoryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.search || url.hash) {
      return false;
    }
    const parts = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    return parts.length === 2 && parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part));
  } catch {
    return false;
  }
}
