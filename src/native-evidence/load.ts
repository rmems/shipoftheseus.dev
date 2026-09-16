import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
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

interface CatalogDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface CatalogFile {
  path: string;
  size: number;
}

interface DiscoveryFrame {
  path: string;
  depth: number;
}

interface DiscoveryTotals {
  bytes: number;
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

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }

  return typeof error.code === 'string' ? error.code : undefined;
}

function limitIssue(message: string, path: string): NativeEvidenceIssue {
  return catalogIssue('catalog-limit-exceeded', message, path);
}

function ioIssue(action: string, error: unknown, path: string): NativeEvidenceIssue {
  return catalogIssue('catalog-io-error', `Failed to ${action} native evidence path: ${ioErrorMessage(error)}`, path);
}

function symlinkIssue(path: string, kind: 'root' | 'entry'): NativeEvidenceIssue {
  if (kind === 'root') {
    return catalogIssue(
      'catalog-io-error',
      'Native evidence catalog root must be a real directory, not a symbolic link.',
      path,
    );
  }

  return catalogIssue(
    'catalog-io-error',
    'Native evidence catalog entries must be regular files inside the catalog directory.',
    path,
  );
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

type DirectoryListing = { ok: true; entries: CatalogDirent[] } | { ok: false; issue: NativeEvidenceIssue };

function readDirectoryEntries(directory: string): DirectoryListing {
  try {
    return { ok: true, entries: readdirSync(directory, { withFileTypes: true }) };
  } catch (error) {
    return { ok: false, issue: ioIssue('list', error, directory) };
  }
}

function enqueueDirectory(
  path: string,
  depth: number,
  pending: DiscoveryFrame[],
): NativeEvidenceIssue | undefined {
  if (depth > MAX_CATALOG_DIRECTORY_DEPTH) {
    return limitIssue(`Catalog directory depth exceeds the ${MAX_CATALOG_DIRECTORY_DEPTH} limit.`, path);
  }

  pending.push({ path, depth });
  return undefined;
}

function appendCatalogFile(
  path: string,
  size: number,
  files: CatalogFile[],
  totals: DiscoveryTotals,
): NativeEvidenceIssue | undefined {
  if (files.length >= MAX_CATALOG_JSON_FILES) {
    return limitIssue(`Catalog contains more than ${MAX_CATALOG_JSON_FILES} JSON artifacts.`, path);
  }

  if (size <= MAX_ARTIFACT_BYTES) {
    totals.bytes += size;
    if (totals.bytes > MAX_CATALOG_BYTES) {
      return limitIssue(`Catalog exceeds the ${MAX_CATALOG_BYTES} byte ingest limit.`, path);
    }
  }

  files.push({ path, size });
  return undefined;
}

function collectRegularJsonFile(
  path: string,
  files: CatalogFile[],
  totals: DiscoveryTotals,
): NativeEvidenceIssue | undefined {
  if (extname(path) !== '.json') {
    return undefined;
  }

  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    return ioIssue('stat', error, path);
  }

  if (stats.isSymbolicLink() || !stats.isFile()) {
    return symlinkIssue(path, 'entry');
  }

  return appendCatalogFile(path, stats.size, files, totals);
}

function processDirectoryEntry(
  entry: CatalogDirent,
  current: DiscoveryFrame,
  pending: DiscoveryFrame[],
  files: CatalogFile[],
  totals: DiscoveryTotals,
): NativeEvidenceIssue | undefined {
  const path = join(current.path, entry.name);
  if (entry.isSymbolicLink()) {
    return symlinkIssue(path, 'entry');
  }
  if (entry.isDirectory()) {
    return enqueueDirectory(path, current.depth + 1, pending);
  }

  return collectRegularJsonFile(path, files, totals);
}

function processDirectory(
  current: DiscoveryFrame,
  pending: DiscoveryFrame[],
  files: CatalogFile[],
  totals: DiscoveryTotals,
): NativeEvidenceIssue | undefined {
  const listed = readDirectoryEntries(current.path);
  if (!listed.ok) {
    return listed.issue;
  }

  for (const entry of listed.entries) {
    const issue = processDirectoryEntry(entry, current, pending, files, totals);
    if (issue) {
      return issue;
    }
  }

  return undefined;
}

function listJsonFiles(directory: string): CatalogDiscovery {
  const files: CatalogFile[] = [];
  const pending: DiscoveryFrame[] = [{ path: directory, depth: 0 }];
  const totals: DiscoveryTotals = { bytes: 0 };

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }

    const issue = processDirectory(current, pending, files, totals);
    if (issue) {
      return { ok: false, issue };
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return { ok: true, files };
}

function inspectCatalogDirectory(directory: string): NativeEvidenceCatalog | undefined {
  try {
    const stats = lstatSync(directory);
    if (stats.isSymbolicLink()) {
      return failClosed([symlinkIssue(directory, 'root')]);
    }
    if (!stats.isDirectory()) {
      return failClosed([
        catalogIssue('invalid-artifact', 'Native evidence path exists but is not a directory.', directory),
      ]);
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { status: 'missing', artifacts: [], issues: [] };
    }

    return failClosed([ioIssue('access', error, directory)]);
  }

  return undefined;
}

function catalogRelativePath(directory: string, filePath: string): string | NativeEvidenceIssue {
  const relativePath = relative(directory, filePath).replaceAll('\\', '/');
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith('../') ||
    relativePath.startsWith('/')
  ) {
    return catalogIssue('catalog-io-error', 'Native evidence artifact path escaped the catalog root.', filePath);
  }

  return relativePath;
}

function ingestDiscoveredFile(
  directory: string,
  file: CatalogFile,
  options: Required<Pick<LoadNativeEvidenceOptions, 'allowSynthetic' | 'requireIdMatchesFilename'>>,
  parsed: NativeEvidenceArtifact[],
  issues: NativeEvidenceIssue[],
  seenIds: Map<string, string>,
): void {
  if (file.size > MAX_ARTIFACT_BYTES) {
    issues.push(
      catalogIssue('invalid-artifact', `Artifact exceeds the ${MAX_ARTIFACT_BYTES} byte ingest limit.`, file.path),
    );
    return;
  }

  const catalogPath = catalogRelativePath(directory, file.path);
  if (typeof catalogPath !== 'string') {
    issues.push(catalogPath);
    return;
  }

  let text: string;
  try {
    text = readFileSync(file.path, 'utf8');
  } catch (error) {
    issues.push(ioIssue('read', error, file.path));
    return;
  }

  const result = parseNativeEvidenceJson(text, {
    path: file.path,
    requireIdMatchesFilename: options.requireIdMatchesFilename,
  });
  if (!result.ok) {
    issues.push(result.issue);
    return;
  }

  if (!options.allowSynthetic && result.artifact.recordStatus === 'synthetic') {
    issues.push({
      code: 'synthetic-not-publishable',
      message: 'Synthetic fixtures cannot be published as native evidence.',
      path: file.path,
    });
    return;
  }

  const previous = seenIds.get(result.artifact.id);
  if (previous) {
    issues.push({
      code: 'duplicate-id',
      message: `Duplicate artifact id "${result.artifact.id}" also appears in ${previous}.`,
      path: file.path,
    });
    return;
  }

  seenIds.set(result.artifact.id, file.path);
  parsed.push({ ...result.artifact, catalogPath });
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
    ingestDiscoveredFile(directory, file, { allowSynthetic, requireIdMatchesFilename }, parsed, issues, seenIds);
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
