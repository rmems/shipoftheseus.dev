import {
  LIVE_ORIGIN_LABEL,
  RECORDED_ORIGIN_LABEL,
  STATIC_ORIGIN_LABEL,
  UNAVAILABLE_ORIGIN_LABEL,
  type NativeEvidenceArtifact,
  type NativeEvidenceKind,
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

export function artifactSourceBlobUrl(artifact: NativeEvidenceArtifact): string {
  return `${artifact.provenance.sourceRepository}/blob/${artifact.provenance.sourceRevision}/${artifact.provenance.sourcePath}`;
}

export function artifactCommitUrl(artifact: NativeEvidenceArtifact): string {
  return `${artifact.provenance.sourceRepository}/commit/${artifact.provenance.sourceRevision}`;
}

const FIXED_FRACTION_DIGITS = 4;
const SCIENTIFIC_ABS_THRESHOLD = 1e-4;

function formattedNumberIsZero(formatted: string): boolean {
  return Number(formatted.replace(/,/g, '')) === 0;
}

export function formatResultValue(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }

  if (value === 0) {
    return '0';
  }

  if (Number.isInteger(value)) {
    return String(value);
  }

  if (Math.abs(value) < SCIENTIFIC_ABS_THRESHOLD) {
    return value.toExponential(FIXED_FRACTION_DIGITS);
  }

  const formatted = new Intl.NumberFormat('en-US', { maximumFractionDigits: FIXED_FRACTION_DIGITS }).format(value);
  if (formattedNumberIsZero(formatted)) {
    return value.toExponential(FIXED_FRACTION_DIGITS);
  }

  return formatted;
}
