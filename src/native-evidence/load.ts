import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parseNativeEvidenceJson } from './parse';
import type {
  LoadNativeEvidenceOptions,
  NativeEvidenceArtifact,
  NativeEvidenceCatalog,
  NativeEvidenceIssue,
} from './types';

const MAX_ARTIFACT_BYTES = 256 * 1024;

function assertNever(value: never, label: string): never {
  throw new Error(`Unhandled ${label}: ${String(value)}`);
}

function listJsonFiles(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonFiles(path));
      continue;
    }

    if (entry.isFile() && extname(entry.name) === '.json') {
      files.push(path);
    }
  }

  return files.sort();
}

function catalogStatus(artifactCount: number, issueCount: number, missing: boolean): NativeEvidenceCatalog['status'] {
  if (issueCount > 0) {
    return 'invalid';
  }
  if (missing) {
    return 'missing';
  }
  if (artifactCount === 0) {
    return 'empty';
  }
  return 'ok';
}

export function loadNativeEvidenceDirectory(
  directory: string,
  options: LoadNativeEvidenceOptions = {},
): NativeEvidenceCatalog {
  const allowSynthetic = options.allowSynthetic ?? false;
  const requireIdMatchesFilename = options.requireIdMatchesFilename ?? true;

  if (!existsSync(directory)) {
    return { status: 'missing', artifacts: [], issues: [] };
  }

  const stats = statSync(directory);
  if (!stats.isDirectory()) {
    return {
      status: 'invalid',
      artifacts: [],
      issues: [{ code: 'invalid-artifact', message: 'Native evidence path exists but is not a directory.', path: directory }],
    };
  }

  const files = listJsonFiles(directory);
  if (files.length === 0) {
    return { status: 'empty', artifacts: [], issues: [] };
  }

  const issues: NativeEvidenceIssue[] = [];
  const parsed: NativeEvidenceArtifact[] = [];
  const seenIds = new Map<string, string>();

  for (const path of files) {
    const size = statSync(path).size;
    if (size > MAX_ARTIFACT_BYTES) {
      issues.push({
        code: 'invalid-artifact',
        message: `Artifact exceeds the ${MAX_ARTIFACT_BYTES} byte ingest limit.`,
        path,
      });
      continue;
    }

    const text = readFileSync(path, 'utf8');
    const result = parseNativeEvidenceJson(text, { path, requireIdMatchesFilename });
    if (!result.ok) {
      issues.push(result.issue);
      continue;
    }

    if (!allowSynthetic && result.artifact.recordStatus === 'synthetic') {
      issues.push({
        code: 'synthetic-not-publishable',
        message: 'Synthetic fixtures cannot be published as native evidence.',
        path,
      });
      continue;
    }

    const previous = seenIds.get(result.artifact.id);
    if (previous) {
      issues.push({
        code: 'duplicate-id',
        message: `Duplicate artifact id "${result.artifact.id}" also appears in ${previous}.`,
        path,
      });
      continue;
    }

    seenIds.set(result.artifact.id, path);
    parsed.push(result.artifact);
  }

  if (issues.length > 0) {
    return { status: 'invalid', artifacts: [], issues };
  }

  parsed.sort((left, right) => {
    const byDate = right.capturedAt.localeCompare(left.capturedAt);
    return byDate !== 0 ? byDate : left.id.localeCompare(right.id);
  });

  return {
    status: catalogStatus(parsed.length, issues.length, false),
    artifacts: parsed,
    issues,
  };
}

export function formatNativeEvidenceIssues(issues: NativeEvidenceIssue[]): string {
  return issues
    .map((issue) => {
      switch (issue.code) {
        case 'invalid-json':
        case 'unsupported-version':
        case 'invalid-artifact':
        case 'duplicate-id':
        case 'id-filename-mismatch':
        case 'synthetic-not-publishable':
          return `${issue.path ?? 'artifact'}: ${issue.code}: ${issue.message}`;
        default:
          return assertNever(issue.code, 'native evidence issue');
      }
    })
    .join('\n');
}
