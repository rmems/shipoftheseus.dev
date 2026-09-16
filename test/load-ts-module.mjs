import { readFileSync } from 'node:fs';
import ts from 'typescript';

export async function loadTsModule(relativePath) {
  const sourceUrl = new URL(relativePath, import.meta.url);
  const source = readFileSync(sourceUrl, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
    fileName: sourceUrl.pathname,
    reportDiagnostics: false,
  });

  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(outputText)}`);
}

export function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}
