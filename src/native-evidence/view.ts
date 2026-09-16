import {
  LIVE_ORIGIN_LABEL,
  NATIVE_EVIDENCE_CATALOG_DIR,
  RECORDED_ORIGIN_LABEL,
  STATIC_ORIGIN_LABEL,
  UNAVAILABLE_ORIGIN_LABEL,
  type NativeEvidenceArtifact,
  type NativeEvidenceKind,
  type NativeEvidenceParameterValue,
} from './types';

function assertNever(value: never, label: string): never {
  throw new Error(`Unhandled ${label}: ${String(value)}`);
}

export type ExecutionOrigin = 'live-wasm' | 'static-diagram' | 'unavailable-wasm' | 'recorded-cuda-fpga';

export function executionOriginLabel(origin: ExecutionOrigin): string {
  switch (origin) {
    case 'live-wasm':
      return LIVE_ORIGIN_LABEL;
    case 'static-diagram':
      return STATIC_ORIGIN_LABEL;
    case 'unavailable-wasm':
      return UNAVAILABLE_ORIGIN_LABEL;
    case 'recorded-cuda-fpga':
      return RECORDED_ORIGIN_LABEL;
    default:
      return assertNever(origin, 'execution origin');
  }
}

export function executionOriginData(origin: ExecutionOrigin): 'live' | 'static' | 'unavailable' | 'recorded' {
  switch (origin) {
    case 'live-wasm':
      return 'live';
    case 'static-diagram':
      return 'static';
    case 'unavailable-wasm':
      return 'unavailable';
    case 'recorded-cuda-fpga':
      return 'recorded';
    default:
      return assertNever(origin, 'execution origin');
  }
}

export function nativeEvidenceKindLabel(kind: NativeEvidenceKind): string {
  switch (kind) {
    case 'cuda-benchmark':
      return 'CUDA benchmark';
    case 'fpga-snn-trace':
      return 'FPGA/SNN trace';
    default:
      return assertNever(kind, 'native evidence kind');
  }
}

export const PORTFOLIO_REPOSITORY_URL = 'https://github.com/rmems/shipoftheseus.dev';
export const PORTFOLIO_DEFAULT_REF = 'main';

export function artifactSourceBlobUrl(artifact: NativeEvidenceArtifact): string {
  return `${artifact.provenance.sourceRepository}/blob/${artifact.provenance.sourceRevision}/${artifact.provenance.sourcePath}`;
}

export function artifactCatalogPath(artifact: NativeEvidenceArtifact): string {
  return `${NATIVE_EVIDENCE_CATALOG_DIR}/${artifact.id}.json`;
}

export function artifactCatalogBlobUrl(artifact: NativeEvidenceArtifact): string {
  return `${PORTFOLIO_REPOSITORY_URL}/blob/${PORTFOLIO_DEFAULT_REF}/${artifactCatalogPath(artifact)}`;
}

export function artifactCommitUrl(artifact: NativeEvidenceArtifact): string {
  return `${artifact.provenance.sourceRepository}/commit/${artifact.provenance.sourceRevision}`;
}

export const TRACE_PREVIEW_LIMIT = 12;
const SAFE_CAPTURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const SAFE_CAPTURE_FEATURES = /^[A-Za-z0-9_,]+$/;

export function formatResultValue(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }

  if (value === 0) {
    return '0';
  }

  return String(value);
}

export function formatWorkloadParameterValue(value: NativeEvidenceParameterValue): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
      return formatResultValue(value);
    case 'boolean':
      return value ? 'true' : 'false';
    default:
      return assertNever(value, 'workload parameter value');
  }
}

export function sortedWorkloadParameterEntries(
  parameters: Record<string, NativeEvidenceParameterValue>,
): Array<[string, NativeEvidenceParameterValue]> {
  return Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right, 'en'));
}

function isSafeCargoCapture(tokens: string[]): boolean {
  if (tokens[0] !== 'cargo' || tokens[1] !== 'run') {
    return false;
  }

  for (let index = 2; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const argument = tokens[index + 1];
    if (flag === '--example' && argument !== undefined && SAFE_CAPTURE_NAME.test(argument)) {
      continue;
    }
    if (flag === '--features' && argument !== undefined && SAFE_CAPTURE_FEATURES.test(argument)) {
      continue;
    }
    return false;
  }

  return true;
}

export function displayCaptureMethod(command: string): string {
  const tokens = command.trim().split(/\s+/);
  if (!isSafeCargoCapture(tokens)) {
    return 'Recorded native capture';
  }

  const parts = ['cargo'];
  for (let index = 2; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const argument = tokens[index + 1];
    if (flag === '--example' && argument !== undefined) {
      parts.push(`example ${argument}`);
      continue;
    }
    if (flag === '--features' && argument !== undefined) {
      parts.push(`features ${argument}`);
    }
  }

  return parts.join(' · ');
}

export function tracePreviewCaption(eventCount: number): string {
  if (eventCount > TRACE_PREVIEW_LIMIT) {
    return `Recorded hardware trace preview (showing first ${TRACE_PREVIEW_LIMIT} of ${eventCount} events)`;
  }

  return `Recorded hardware trace (${eventCount} events)`;
}
