import { resolve } from 'node:path';
import { formatNativeEvidenceIssues, loadNativeEvidenceDirectory } from './load';
import { NATIVE_EVIDENCE_CATALOG_DIR, type NativeEvidenceCatalog } from './types';

export function publishedNativeEvidenceDirectory(cwd = process.cwd()): string {
  return resolve(cwd, NATIVE_EVIDENCE_CATALOG_DIR);
}

export function loadPublishedNativeEvidence(cwd = process.cwd()): NativeEvidenceCatalog {
  const catalog = loadNativeEvidenceDirectory(publishedNativeEvidenceDirectory(cwd), {
    allowSynthetic: false,
    requireIdMatchesFilename: true,
  });

  if (catalog.issues.length > 0) {
    throw new Error(`Native evidence catalog failed closed.\n${formatNativeEvidenceIssues(catalog.issues)}`);
  }

  return catalog;
}
