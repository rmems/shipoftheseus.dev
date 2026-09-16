import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { compareCapturedAt, parseNativeEvidenceJson } from './parse';
import type {
  LoadNativeEvidenceOptions,
  NativeEvidenceArtifact,
  NativeEvidenceCatalog,
  NativeEvidenceIssue,
  NativeEvidenceIssueCode,
} from './types';

export const MAX_ARTIFACT_BYTES = 256 * 1024;
export const MAX_CATALOG_DIRECTORY_DEPTH = 4;
export const MAX_CATALOG_JSON_FILES = 32;
export const MAX_CATALOG_BYTES = 1024 * 1024;

interface CatalogFile {
  path: string;
  size: number;
}

type CatalogDiscovery = { ok: true; files: CatalogFile[] } | { ok: false; issue: NativeEvidenceIssue };

function assertNever(value: never, label: string): never {
  throw new Error(`Unhandled ${label}: ${String(value)}`);
}

function catalogIssue(code: NativeEvidenceIssueCode, message: string, path?: string): NativeEvidenceIssue {
  return { code, message, path };
}

function failClosed(issues: NativeEvidenceIssue[]): NativeEvidenceCatalog {
  return { status: 'invalid', artifacts: [], issues };
}

function ioErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown filesystem error.';
}

function limitIssue(message: string, path: string): NativeEvidenceIssue {
  return catalogIssue('catalog-limit-exceeded', message, path);
}

function ioIssue(action: string, error: unknown, path: string): NativeEvidenceIssue {
  return catalogIssue('catalog-io-error', `Failed to ${action} native evidence path: ${ioErrorMessage(error)}`, path);
}

function listJsonFiles(directory: string): CatalogDiscovery {
  const files: CatalogFile[] = [];
  const pending: Array<{ path: string; depth: number }> = [{ path: directory, depth: 0 }];
  let catalogBytes = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }

    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch (error) {
      return { ok: false, issue: ioIssue('list', error, current.path) };
    }

    for (const entry of entries) {
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) {
        const depth = current.depth + 1;
        if (depth > MAX_CATALOG_DIRECTORY_DEPTH) {
          return {
            ok: false,
            issue: limitIssue(`Catalog directory depth exceeds the ${MAX_CATALOG_DIRECTORY_DEPTH} limit.`, path),
          };
        }
        pending.push({ path, depth });
        continue;
      }

      if (extname(entry.name) !== '.json') {
        continue;
      }

      if (files.length >= MAX_CATALOG_JSON_FILES) {
        return {
          ok: false,
          issue: limitIssue(`Catalog contains more than ${MAX_CATALOG_JSON_FILES} JSON artifacts.`, path),
        };
      }

      let size: number;
      try {
        size = statSync(path).size;
      } catch (error) {
        return { ok: false, issue: ioIssue('stat', error, path) };
      }

      if (size <= MAX_ARTIFACT_BYTES) {
        catalogBytes += size;
        if (catalogBytes > MAX_CATALOG_BYTES) {
          return {
            ok: false,
            issue: limitIssue(`Catalog exceeds the ${MAX_CATALOG_BYTES} byte ingest limit.`, path),
          };
        }
      }

      files.push({ path, size });
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return { ok: true, files };
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

function inspectCatalogDirectory(directory: string): NativeEvidenceCatalog | undefined {
  try {
    if (!existsSync(directory)) {
      return { status: 'missing', artifacts: [], issues: [] };
    }

    const stats = statSync(directory);
    if (!stats.isDirectory()) {
      return failClosed([
        catalogIssue('invalid-artifact', 'Native evidence path exists but is not a directory.', directory),
      ]);
    }
  } catch (error) {
    return failClosed([ioIssue('access', error, directory)]);
  }

  return undefined;
}

export function loadNativeEvidenceDirectory(
  directory: string,
  options: LoadNativeEvidenceOptions = {},
): NativeEvidenceCatalog {
  const allowSynthetic = options.allowSynthetic ?? false;
  const requireIdMatchesFilename = options.requireIdMatchesFilename ?? true;
  const inspected = inspectCatalogDirectory(directory);
  if (inspected) {
    return inspected;
  }

  const listed = listJsonFiles(directory);
  if (!listed.ok) {
    return failClosed([listed.issue]);
  }
  if (listed.files.length === 0) {
    return { status: 'empty', artifacts: [], issues: [] };
  }

  const issues: NativeEvidenceIssue[] = [];
  const parsed: NativeEvidenceArtifact[] = [];
  const seenIds = new Map<string, string>();

  for (const file of listed.files) {
    if (file.size > MAX_ARTIFACT_BYTES) {
      issues.push(
        catalogIssue('invalid-artifact', `Artifact exceeds the ${MAX_ARTIFACT_BYTES} byte ingest limit.`, file.path),
      );
      continue;
    }

    let text: string;
    try {
      text = readFileSync(file.path, 'utf8');
    } catch (error) {
      issues.push(ioIssue('read', error, file.path));
      continue;
    }

    const result = parseNativeEvidenceJson(text, { path: file.path, requireIdMatchesFilename });
    if (!result.ok) {
      issues.push(result.issue);
      continue;
    }

    if (!allowSynthetic && result.artifact.recordStatus === 'synthetic') {
      issues.push({
        code: 'synthetic-not-publishable',
        message: 'Synthetic fixtures cannot be published as native evidence.',
        path: file.path,
      });
      continue;
    }

    const previous = seenIds.get(result.artifact.id);
    if (previous) {
      issues.push({
        code: 'duplicate-id',
        message: `Duplicate artifact id "${result.artifact.id}" also appears in ${previous}.`,
        path: file.path,
      });
      continue;
    }

    seenIds.set(result.artifact.id, file.path);
    parsed.push(result.artifact);
  }

  if (issues.length > 0) {
    return failClosed(issues);
  }

  parsed.sort((left, right) => {
    const byDate = compareCapturedAt(right.capturedAt, left.capturedAt);
    return byDate !== 0 ? byDate : left.id.localeCompare(right.id, 'en');
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
        case 'catalog-limit-exceeded':
        case 'catalog-io-error':
          return `${issue.path ?? 'artifact'}: ${issue.code}: ${issue.message}`;
        default:
          return assertNever(issue.code, 'native evidence issue');
      }
    })
    .join('\n');
}
