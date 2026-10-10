// Transpile a runtime TypeScript module (and its relative imports, inlined as
// data: URLs) into one ES module source string, the same way
// `test/load-ts-module.mjs` loads modules for `node --test`. The measurement
// scripts use it to run the shipped runtime modules in Node and to inject them
// into an already-built page in Chrome without a dev server.
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const relativeImport = /from\s+(['"])(\.\.?\/[^'"]+)\1/g;

function transpile(sourceUrl) {
  const { outputText } = ts.transpileModule(readFileSync(sourceUrl, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
    fileName: sourceUrl.pathname,
    reportDiagnostics: false,
  });
  return outputText;
}

function inline(sourceUrl) {
  return transpile(sourceUrl).replace(relativeImport, (_match, _quote, spec) => {
    const child = new URL(spec.endsWith('.ts') ? spec : `${spec}.ts`, sourceUrl);
    return `from ${JSON.stringify(dataUrl(inline(child)))}`;
  });
}

export function dataUrl(source) {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}

/** ES module source for `src/runtime/<name>.ts` with its imports inlined. */
export function runtimeModuleSource(name) {
  return inline(new URL(`../../src/runtime/${name}.ts`, import.meta.url));
}

/** The same for an arbitrary TypeScript file (e.g. a bridge variant to compare). */
export function tsFileSource(fileUrl) {
  return inline(fileUrl);
}
