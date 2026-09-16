export const NATIVE_EVIDENCE_SCHEMA_ID = 'shipoftheseus.native-evidence';
export const NATIVE_EVIDENCE_SCHEMA_VERSION = 1;

export const LIVE_ORIGIN_LABEL = 'LIVE · Rust/WASM';
export const STATIC_ORIGIN_LABEL = 'STATIC · diagram';
export const UNAVAILABLE_ORIGIN_LABEL = 'UNAVAILABLE · Rust/WASM';
export const RECORDED_ORIGIN_LABEL = 'RECORDED · CUDA/FPGA';

export const EMPTY_NATIVE_EVIDENCE_COPY =
  'No versioned CUDA or FPGA artifacts are published yet. Native-only acceleration is represented here only when a capture includes hardware, workload, units, source repository, source revision, and capture provenance.';

export const NATIVE_EVIDENCE_CATALOG_DIR = 'src/content/native-evidence';

export const FORBIDDEN_BROWSER_DEPENDENCY_NAMES = [
  'myelin-accelerator',
  'cust',
  'zeromq',
  'zeromq.js',
  'hdf5',
  'hdf5-wasm',
] as const;

export type NativeEvidenceKind = 'cuda-benchmark' | 'fpga-snn-trace';
export type NativeEvidenceRecordStatus = 'measured' | 'synthetic';
export type NativeEvidenceHardwareClass = 'cuda' | 'fpga';
export type NativeEvidenceStatistic = 'mean' | 'p50' | 'p95' | 'p99' | 'min' | 'max' | 'count' | 'other';
export type NativeEvidenceTraceKind = 'spike' | 'inhibit' | 'reset';
export type NativeEvidenceParameterValue = string | number | boolean;

export type NativeEvidenceIssueCode =
  | 'invalid-json'
  | 'unsupported-version'
  | 'invalid-artifact'
  | 'duplicate-id'
  | 'id-filename-mismatch'
  | 'synthetic-not-publishable'
  | 'catalog-limit-exceeded'
  | 'catalog-io-error';

export type NativeEvidenceCatalogStatus = 'missing' | 'empty' | 'ok' | 'invalid';

export interface NativeEvidenceIssue {
  code: NativeEvidenceIssueCode;
  message: string;
  path?: string;
}

export interface NativeEvidenceProvenance {
  sourceRepository: string;
  sourceRevision: string;
  sourcePath: string;
  crateName?: string;
  crateVersion?: string;
  /** Required and non-empty when recordStatus is "measured". */
  captureCommand?: string;
}

export interface NativeEvidenceHardware {
  class: NativeEvidenceHardwareClass;
  deviceName: string;
  vendor?: string;
  architecture?: string;
  driverVersion?: string;
}

export interface NativeEvidenceWorkload {
  name: string;
  description?: string;
  parameters?: Record<string, NativeEvidenceParameterValue>;
}

export interface NativeEvidenceResult {
  name: string;
  value: number;
  unit: string;
  statistic?: NativeEvidenceStatistic;
}

export interface NativeEvidenceTraceEvent {
  timeNs: number;
  neuronId: number;
  event: NativeEvidenceTraceKind;
}

interface NativeEvidenceBase {
  schema: typeof NATIVE_EVIDENCE_SCHEMA_ID;
  schemaVersion: typeof NATIVE_EVIDENCE_SCHEMA_VERSION;
  id: string;
  title: string;
  summary?: string;
  capturedAt: string;
  recordStatus: NativeEvidenceRecordStatus;
  provenance: NativeEvidenceProvenance;
  workload: NativeEvidenceWorkload;
}

export interface CudaBenchmarkArtifact extends NativeEvidenceBase {
  kind: 'cuda-benchmark';
  hardware: NativeEvidenceHardware & { class: 'cuda' };
  results: NativeEvidenceResult[];
  traces?: NativeEvidenceTraceEvent[];
}

export interface FpgaSnnTraceArtifact extends NativeEvidenceBase {
  kind: 'fpga-snn-trace';
  hardware: NativeEvidenceHardware & { class: 'fpga' };
  traces: NativeEvidenceTraceEvent[];
  results?: NativeEvidenceResult[];
}

export type NativeEvidenceArtifact = CudaBenchmarkArtifact | FpgaSnnTraceArtifact;

export interface NativeEvidenceCatalog {
  status: NativeEvidenceCatalogStatus;
  artifacts: NativeEvidenceArtifact[];
  issues: NativeEvidenceIssue[];
}

export interface ParseNativeEvidenceOptions {
  path?: string;
  requireIdMatchesFilename?: boolean;
}

export interface LoadNativeEvidenceOptions {
  allowSynthetic?: boolean;
  requireIdMatchesFilename?: boolean;
}
