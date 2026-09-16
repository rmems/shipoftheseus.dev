import { readFileSync } from 'node:fs';
import ts from 'typescript';

const relativeImport = /from\s+(['"])(\.\.?\/[^'"]+)\1/g;

function toFileUrl(relativePath, parentUrl) {
  const withExtension = relativePath.endsWith('.ts') ? relativePath : `${relativePath}.ts`;
  return new URL(withExtension, parentUrl);
}

function transpileFile(sourceUrl) {
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
  return outputText;
}

function rewriteRelativeImports(outputText, sourceUrl) {
  return outputText.replace(relativeImport, (_match, _quote, spec) => {
    const childUrl = toFileUrl(spec, sourceUrl);
    const childText = rewriteRelativeImports(transpileFile(childUrl), childUrl);
    return `from ${JSON.stringify(`data:text/javascript;charset=utf-8,${encodeURIComponent(childText)}`)}`;
  });
}

export async function loadTsModule(relativePath) {
  const sourceUrl = new URL(relativePath, import.meta.url);
  const rewritten = rewriteRelativeImports(transpileFile(sourceUrl), sourceUrl);
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(rewritten)}`);
}

export function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}
