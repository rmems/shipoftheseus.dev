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
  type NativeEvidenceParameterValue,
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
// SemVer 2.0.0: no leading zeros, no empty pre-release/build identifiers.
const CRATE_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const CAPTURED_AT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
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

interface ArtifactEnvelope {
  id: string;
  kind: NativeEvidenceKind;
  title: string;
  summary?: string;
  capturedAt: string;
  recordStatus: NativeEvidenceRecordStatus;
  provenance: NativeEvidenceProvenance;
  hardware: NativeEvidenceHardware;
  workload: NativeEvidenceWorkload;
  results?: NativeEvidenceResult[];
  traces?: NativeEvidenceTraceEvent[];
}

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

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function filenameId(path: string): string {
  const filename = path.split(/[/\\]/).pop() ?? path;
  return filename.replace(/\.json$/i, '');
}

function assignOptionalString<T extends object>(
  target: T,
  key: string,
  value: string | undefined,
): T {
  if (value !== undefined) {
    Object.assign(target, { [key]: value });
  }

  return target;
}

function readOptionalNonEmptyString(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
  message: string,
  path?: string,
): { ok: true; text?: string } | ParseFailure {
  if (!(key in value)) {
    return { ok: true };
  }

  if (!nonEmptyString(value[key], maxLength)) {
    return fail('invalid-artifact', message, path);
  }

  return { ok: true, text: value[key] };
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

  const envelope = parseArtifactEnvelope(value, options);
  if (!envelope.ok) {
    return envelope;
  }

  return finalizeArtifact(envelope.envelope, options.path);
}

function parseSchemaHeader(value: Record<string, unknown>, path?: string): { ok: true } | ParseFailure {
  if ('schemaVersion' in value) {
    const version = value.schemaVersion;
    if (typeof version === 'number' && Number.isInteger(version) && version !== NATIVE_EVIDENCE_SCHEMA_VERSION) {
      return fail(
        'unsupported-version',
        `Unsupported native-evidence schema version ${String(version)}. Expected ${NATIVE_EVIDENCE_SCHEMA_VERSION}.`,
        path,
      );
    }
  }

  const extra = unknownKeys(value, ARTIFACT_KEYS);
  if (extra.length > 0) {
    return fail('invalid-artifact', `Unknown artifact field(s): ${extra.join(', ')}.`, path);
  }

  if (value.schema !== NATIVE_EVIDENCE_SCHEMA_ID) {
    return fail(
      'invalid-artifact',
      `schema must be "${NATIVE_EVIDENCE_SCHEMA_ID}".`,
      path,
    );
  }

  if (value.schemaVersion === NATIVE_EVIDENCE_SCHEMA_VERSION) {
    return { ok: true };
  }

  if (typeof value.schemaVersion === 'number') {
    return fail(
      'unsupported-version',
      `Unsupported native-evidence schema version ${String(value.schemaVersion)}. Expected ${NATIVE_EVIDENCE_SCHEMA_VERSION}.`,
      path,
    );
  }

  return fail('invalid-artifact', 'schemaVersion must be the integer 1.', path);
}

function parseIdConstraint(
  id: string,
  options: ParseNativeEvidenceOptions,
): { ok: true } | ParseFailure {
  if (!options.requireIdMatchesFilename || !options.path) {
    return { ok: true };
  }

  const expected = filenameId(options.path);
  if (expected === id) {
    return { ok: true };
  }

  return fail(
    'id-filename-mismatch',
    `Artifact id "${id}" must match filename "${expected}".`,
    options.path,
  );
}

function parseTitleAndSummary(
  value: Record<string, unknown>,
  path?: string,
): { ok: true; title: string; summary?: string } | ParseFailure {
  if (!nonEmptyString(value.title, MAX_TITLE_LENGTH)) {
    return fail('invalid-artifact', 'title must be a non-empty string.', path);
  }

  const summary = readOptionalNonEmptyString(
    value,
    'summary',
    MAX_SUMMARY_LENGTH,
    'summary must be a non-empty string when present.',
    path,
  );
  if (!summary.ok) {
    return summary;
  }

  return { ok: true, title: value.title, summary: summary.text };
}

interface CapturedInstant {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  nanoseconds: number;
}

function isGregorianLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isGregorianLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

function parseCapturedInstant(value: string): CapturedInstant | null {
  const match = CAPTURED_AT.exec(value);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? '';
  const monthDays = daysInMonth(year, month);

  if (monthDays === 0 || day < 1 || day > monthDays || hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    nanoseconds: Number(`${fraction}000000000`.slice(0, 9)),
  };
}

function parseCapturedAt(value: unknown, path?: string): { ok: true; capturedAt: string } | ParseFailure {
  if (typeof value === 'string' && parseCapturedInstant(value) !== null) {
    return { ok: true, capturedAt: value };
  }

  return fail('invalid-artifact', 'capturedAt must be an ISO-8601 UTC timestamp.', path);
}

export function compareCapturedAt(left: string, right: string): number {
  const leftInstant = parseCapturedInstant(left);
  const rightInstant = parseCapturedInstant(right);
  if (leftInstant === null || rightInstant === null) {
    return left.localeCompare(right, 'en');
  }

  const fields = ['year', 'month', 'day', 'hour', 'minute', 'second', 'nanoseconds'] as const;
  for (const field of fields) {
    if (leftInstant[field] !== rightInstant[field]) {
      return leftInstant[field] < rightInstant[field] ? -1 : 1;
    }
  }

  return 0;
}

function parseArtifactEnvelope(
  value: Record<string, unknown>,
  options: ParseNativeEvidenceOptions,
): { ok: true; envelope: ArtifactEnvelope } | ParseFailure {
  const header = parseSchemaHeader(value, options.path);
  if (!header.ok) {
    return header;
  }

  if (!nonEmptyString(value.id, 80) || !ARTIFACT_ID.test(value.id)) {
    return fail('invalid-artifact', 'id must be a kebab-case identifier.', options.path);
  }

  const idMatch = parseIdConstraint(value.id, options);
  if (!idMatch.ok) {
    return idMatch;
  }

  const kindResult = parseKind(value.kind, options.path);
  if (!kindResult.ok) {
    return kindResult;
  }

  const recordStatusResult = parseRecordStatus(value.recordStatus, options.path);
  if (!recordStatusResult.ok) {
    return recordStatusResult;
  }

  const titleSummary = parseTitleAndSummary(value, options.path);
  if (!titleSummary.ok) {
    return titleSummary;
  }

  const capturedAt = parseCapturedAt(value.capturedAt, options.path);
  if (!capturedAt.ok) {
    return capturedAt;
  }

  const records = parseArtifactRecords(value, kindResult.kind, recordStatusResult.status, options.path);
  if (!records.ok) {
    return records;
  }

  return {
    ok: true,
    envelope: {
      id: value.id,
      kind: kindResult.kind,
      title: titleSummary.title,
      summary: titleSummary.summary,
      capturedAt: capturedAt.capturedAt,
      recordStatus: recordStatusResult.status,
      provenance: records.provenance,
      hardware: records.hardware,
      workload: records.workload,
      results: records.results,
      traces: records.traces,
    },
  };
}

function parseArtifactRecords(
  value: Record<string, unknown>,
  kind: NativeEvidenceKind,
  recordStatus: NativeEvidenceRecordStatus,
  path?: string,
):
  | {
      ok: true;
      provenance: NativeEvidenceProvenance;
      hardware: NativeEvidenceHardware;
      workload: NativeEvidenceWorkload;
      results?: NativeEvidenceResult[];
      traces?: NativeEvidenceTraceEvent[];
    }
  | ParseFailure {
  const provenance = parseProvenance(value.provenance, recordStatus, path);
  if (!provenance.ok) {
    return provenance;
  }

  const hardware = parseHardware(value.hardware, kind, path);
  if (!hardware.ok) {
    return hardware;
  }

  const workload = parseWorkload(value.workload, path);
  if (!workload.ok) {
    return workload;
  }

  const results = parseResults(value.results, path);
  if (!results.ok) {
    return results;
  }

  const traces = parseTraces(value.traces, path);
  if (!traces.ok) {
    return traces;
  }

  return {
    ok: true,
    provenance: provenance.provenance,
    hardware: hardware.hardware,
    workload: workload.workload,
    results: results.results,
    traces: traces.traces,
  };
}

function finalizeArtifact(envelope: ArtifactEnvelope, path?: string): NativeEvidenceParseResult {
  switch (envelope.kind) {
    case 'cuda-benchmark':
      return finalizeCudaArtifact(envelope, path);
    case 'fpga-snn-trace':
      return finalizeFpgaArtifact(envelope, path);
    default:
      return assertNever(envelope.kind, 'native evidence kind');
  }
}

function finalizeCudaArtifact(
  envelope: ArtifactEnvelope,
  path?: string,
): NativeEvidenceParseResult {
  if (envelope.hardware.class !== 'cuda') {
    return fail('invalid-artifact', 'cuda-benchmark artifacts require hardware.class "cuda".', path);
  }

  if (envelope.results === undefined || envelope.results.length === 0) {
    return fail('invalid-artifact', 'cuda-benchmark artifacts require at least one result with units.', path);
  }

  const artifact: CudaBenchmarkArtifact = {
    schema: NATIVE_EVIDENCE_SCHEMA_ID,
    schemaVersion: NATIVE_EVIDENCE_SCHEMA_VERSION,
    id: envelope.id,
    kind: 'cuda-benchmark',
    title: envelope.title,
    summary: envelope.summary,
    capturedAt: envelope.capturedAt,
    recordStatus: envelope.recordStatus,
    provenance: envelope.provenance,
    hardware: { ...envelope.hardware, class: 'cuda' },
    workload: envelope.workload,
    results: envelope.results,
    traces: envelope.traces,
  };
  return { ok: true, artifact };
}

function finalizeFpgaArtifact(
  envelope: ArtifactEnvelope,
  path?: string,
): NativeEvidenceParseResult {
  if (envelope.hardware.class !== 'fpga') {
    return fail('invalid-artifact', 'fpga-snn-trace artifacts require hardware.class "fpga".', path);
  }

  if (envelope.traces === undefined || envelope.traces.length === 0) {
    return fail('invalid-artifact', 'fpga-snn-trace artifacts require at least one hardware trace event.', path);
  }

  const artifact: FpgaSnnTraceArtifact = {
    schema: NATIVE_EVIDENCE_SCHEMA_ID,
    schemaVersion: NATIVE_EVIDENCE_SCHEMA_VERSION,
    id: envelope.id,
    kind: 'fpga-snn-trace',
    title: envelope.title,
    summary: envelope.summary,
    capturedAt: envelope.capturedAt,
    recordStatus: envelope.recordStatus,
    provenance: envelope.provenance,
    hardware: { ...envelope.hardware, class: 'fpga' },
    workload: envelope.workload,
    traces: envelope.traces,
    results: envelope.results,
  };
  return { ok: true, artifact };
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

function parseCaptureCommand(
  value: Record<string, unknown>,
  recordStatus: NativeEvidenceRecordStatus,
  path?: string,
): { ok: true; captureCommand?: string } | ParseFailure {
  if (recordStatus === 'measured') {
    if (!nonEmptyString(value.captureCommand, 240)) {
      return fail(
        'invalid-artifact',
        'Measured artifacts require a non-empty provenance.captureCommand.',
        path,
      );
    }
    return { ok: true, captureCommand: value.captureCommand };
  }

  if (!('captureCommand' in value)) {
    return { ok: true };
  }

  if (!nonEmptyString(value.captureCommand, 240)) {
    return fail('invalid-artifact', 'provenance.captureCommand must be a non-empty string when present.', path);
  }

  return { ok: true, captureCommand: value.captureCommand };
}

function parseCrateVersion(
  value: Record<string, unknown>,
  path?: string,
): { ok: true; crateVersion?: string } | ParseFailure {
  if (!('crateVersion' in value)) {
    return { ok: true };
  }

  if (typeof value.crateVersion === 'string' && CRATE_VERSION.test(value.crateVersion)) {
    return { ok: true, crateVersion: value.crateVersion };
  }

  return fail('invalid-artifact', 'provenance.crateVersion must be a semantic version when present.', path);
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

  const crateName = readOptionalNonEmptyString(
    value,
    'crateName',
    80,
    'provenance.crateName must be a non-empty string when present.',
    path,
  );
  if (!crateName.ok) {
    return crateName;
  }

  const crateVersion = parseCrateVersion(value, path);
  if (!crateVersion.ok) {
    return crateVersion;
  }

  const capture = parseCaptureCommand(value, recordStatus, path);
  if (!capture.ok) {
    return capture;
  }

  const provenance: NativeEvidenceProvenance = {
    sourceRepository: value.sourceRepository.replace(/\.git$/, ''),
    sourceRevision: value.sourceRevision,
    sourcePath: value.sourcePath,
  };
  assignOptionalString(provenance, 'crateName', crateName.text);
  assignOptionalString(provenance, 'crateVersion', crateVersion.crateVersion);
  assignOptionalString(provenance, 'captureCommand', capture.captureCommand);
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

  const vendor = readOptionalNonEmptyString(
    value,
    'vendor',
    80,
    'hardware.vendor must be a non-empty string when present.',
    path,
  );
  if (!vendor.ok) {
    return vendor;
  }

  const architecture = readOptionalNonEmptyString(
    value,
    'architecture',
    80,
    'hardware.architecture must be a non-empty string when present.',
    path,
  );
  if (!architecture.ok) {
    return architecture;
  }

  const driverVersion = readOptionalNonEmptyString(
    value,
    'driverVersion',
    80,
    'hardware.driverVersion must be a non-empty string when present.',
    path,
  );
  if (!driverVersion.ok) {
    return driverVersion;
  }

  const hardware: NativeEvidenceHardware = {
    class: expectedClass,
    deviceName: value.deviceName,
  };
  assignOptionalString(hardware, 'vendor', vendor.text);
  assignOptionalString(hardware, 'architecture', architecture.text);
  assignOptionalString(hardware, 'driverVersion', driverVersion.text);
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

function parseWorkloadParameters(
  value: unknown,
  path?: string,
): { ok: true; parameters: Record<string, NativeEvidenceParameterValue> } | ParseFailure {
  if (!isRecord(value)) {
    return fail('invalid-artifact', 'workload.parameters must be an object when present.', path);
  }

  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_PARAMETERS) {
    return fail('invalid-artifact', 'workload.parameters must contain between 1 and 32 entries when present.', path);
  }

  const parameters = Object.create(null) as Record<string, NativeEvidenceParameterValue>;
  for (const [key, parameter] of entries) {
    const parsed = parseWorkloadParameter(key, parameter, path);
    if (!parsed.ok) {
      return parsed;
    }
    Object.defineProperty(parameters, key, {
      value: parsed.parameter,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return { ok: true, parameters };
}

function parseWorkloadParameter(
  key: string,
  parameter: unknown,
  path?: string,
): { ok: true; parameter: NativeEvidenceParameterValue } | ParseFailure {
  if (!nonEmptyString(key, 80)) {
    return fail('invalid-artifact', 'workload.parameters keys must be non-empty strings.', path);
  }

  if (typeof parameter === 'string' || typeof parameter === 'boolean') {
    return { ok: true, parameter };
  }

  if (typeof parameter === 'number' && Number.isFinite(parameter)) {
    return { ok: true, parameter };
  }

  if (typeof parameter === 'number') {
    return fail('invalid-artifact', 'workload.parameters numbers must be finite.', path);
  }

  return fail('invalid-artifact', 'workload.parameters values must be strings, numbers, or booleans.', path);
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

  const description = readOptionalNonEmptyString(
    value,
    'description',
    MAX_SUMMARY_LENGTH,
    'workload.description must be a non-empty string when present.',
    path,
  );
  if (!description.ok) {
    return description;
  }

  const workload: NativeEvidenceWorkload = { name: value.name };
  assignOptionalString(workload, 'description', description.text);
  if (!('parameters' in value)) {
    return { ok: true, workload };
  }

  const parameters = parseWorkloadParameters(value.parameters, path);
  if (!parameters.ok) {
    return parameters;
  }

  workload.parameters = parameters.parameters;
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

  if (!nonNegativeSafeInteger(value.timeNs)) {
    return fail(
      'invalid-artifact',
      `traces[${index}].timeNs must be a non-negative safe integer.`,
      path,
    );
  }

  if (!nonNegativeSafeInteger(value.neuronId)) {
    return fail(
      'invalid-artifact',
      `traces[${index}].neuronId must be a non-negative safe integer.`,
      path,
    );
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
  if (!value.startsWith('https://github.com/')) {
    return false;
  }

  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return false;
    }
    const parts = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    return parts.length === 2 && parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part));
  } catch {
    return false;
  }
}
