import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('portfolio content model exposes the three named projects and clear publishing placeholders', () => {
  assert.equal(existsSync(new URL('../src/data/projects.ts', import.meta.url)), true);
  assert.equal(existsSync(new URL('../CONTENT.md', import.meta.url)), true);

  const projects = read('src/data/projects.ts');
  const handoff = read('CONTENT.md');

  assert.match(projects, /Ship of Theseus Workstation/);
  assert.match(projects, /Synthetic Factory/);
  assert.match(projects, /Grok-1\/SAAQ research/);
  assert.match(handoff, /GitHub/);
  assert.match(handoff, /LinkedIn/);
  assert.match(handoff, /résumé/i);
});

test('every requested primary route is backed by an Astro page', () => {
  for (const route of [
    'src/pages/index.astro',
    'src/pages/work.astro',
    'src/pages/about.astro',
    'src/pages/projects.astro',
    'src/pages/notes/index.astro',
    'src/pages/contact.astro',
    'src/pages/resume.astro',
    'src/pages/evidence.astro',
  ]) {
    assert.equal(existsSync(new URL(`../${route}`, import.meta.url)), true, `${route} is missing`);
  }
});

test('the responsive stylesheet does not force horizontal scrolling on narrow screens', () => {
  const styles = read('src/styles/global.css');

  assert.doesNotMatch(styles, /min-width:320px/);
  assert.match(styles, /@media\s*\(max-width:\s*360px\)/);
});

test('the static site does not depend on remotely hosted fonts', () => {
  assert.doesNotMatch(read('src/styles/global.css'), /@import\s+url/);
});

test('publishing handoff values become live only when configured', () => {
  const contact = read('src/pages/contact.astro');
  const resume = read('src/pages/resume.astro');
  const site = read('src/data/site.ts');

  assert.match(contact, /site\.email/);
  assert.match(contact, /mailto:\$\{site\.email\}/);
  assert.match(resume, /site\.resumePath/);
  assert.match(resume, /href=\{site\.resumePath\}/);
  assert.match(site, /site\.resumePath \? \[\{ href: '\/resume\/', label: 'Résumé' \}\] : \[\]/);
});

test('the work page expands existing project data without unsupported outcomes or links', () => {
  const work = read('src/pages/work.astro');
  const projects = read('src/data/projects.ts');

  assert.match(work, /projects\.map/);
  assert.match(work, /Questions in view/);
  assert.match(work, /Working areas/);
  assert.match(projects, /questions: \[/);
  assert.match(work, /intentionally avoid outcomes or links that are not ready to be supported publicly/);
  assert.doesNotMatch(projects, /https?:\/\//);
});

test('public identity links use the verified profile destinations', () => {
  const identity = read('src/data/site.ts');

  assert.match(identity, /fullName: 'Raul Cardenas Montoya'/);
  assert.match(identity, /github: 'https:\/\/github\.com\/rmems'/);
  assert.match(identity, /linkedin: 'https:\/\/www\.linkedin\.com\/in\/raul-cardenas-montoya-8aa09839a'/);
  assert.match(identity, /huggingface: 'https:\/\/huggingface\.co\/rmems'/);
});

test('the about page includes a local, accessible portrait', () => {
  assert.equal(existsSync(new URL('../public/assets/raul-cardenas-montoya.jpg', import.meta.url)), true);
  assert.match(read('src/pages/about.astro'), /raul-cardenas-montoya\.jpg/);
  assert.match(read('src/pages/about.astro'), /alt="Raul Cardenas Montoya"/);
});

test('notes publish only non-draft Markdown entries and format date-only values in UTC', () => {
  const config = read('src/content.config.ts');
  const index = read('src/pages/notes/index.astro');
  const detail = read('src/pages/notes/[...slug].astro');

  assert.match(config, /pattern: '\*\*\/\*\.md'/);
  assert.doesNotMatch(config, /mdx/);
  assert.match(index, /getCollection\('notes', \(\{ data \}\) => !data\.draft\)/);
  assert.match(detail, /getCollection\('notes', \(\{ data \}\) => !data\.draft\)/);
  assert.match(index, /timeZone: 'UTC'/);
  assert.match(detail, /timeZone: 'UTC'/);
});

test('editable project cards receive their ordinal from the rendered collection order', () => {
  assert.match(read('src/pages/index.astro'), /map\(\(project, index\) => <ProjectCard project=\{project\} index=\{index\}/);
  assert.match(read('src/pages/projects.astro'), /map\(\(project, index\) => <ProjectCard project=\{project\} index=\{index\}/);
  assert.match(read('src/components/ProjectCard.astro'), /project, index/);
  assert.doesNotMatch(read('src/components/ProjectCard.astro'), /\.indexOf\(project\.slug\)/);
});

test('project cards expose configured external project links', () => {
  const card = read('src/components/ProjectCard.astro');
  const projects = read('src/data/projects.ts');
  const styles = read('src/styles/global.css');

  assert.match(projects, /links: \{ label: string; href: string \}\[\]/);
  assert.match(card, /project\.links\.map/);
  assert.match(card, /href=\{link\.href\}/);
  assert.match(card, /\{link\.label\}/);
  assert.match(styles, /\.project-external-link/);
});

test('supported Node versions match the locked build tooling', () => {
  const packageJson = JSON.parse(read('package.json'));
  const readme = read('README.md');

  assert.equal(packageJson.engines.node, '^20.19.0 || >=22.12.0');
  assert.match(readme, /20\.19\+.*22\.12\+/);
});

test('visual foundations use accessible tokens and honor reduced motion', () => {
  const styles = read('src/styles/global.css');

  assert.match(styles, /--muted:\s*#62635c/);
  assert.match(styles, /--signal:\s*#a94422/);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
  assert.match(styles, /animation:\s*none/);
  assert.match(styles, /button:focus-visible/);
  assert.match(styles, /:focus-visible/);
});

test('the homepage ships a static neuromorphic diagram that remains usable without JavaScript', () => {
  const page = read('src/pages/index.astro');
  const island = read('src/components/NeuromorphicDemo.astro');
  const enhance = read('src/runtime/enhance-demo.ts');

  assert.match(page, /NeuromorphicDemo/);
  assert.doesNotMatch(page, /NativeEvidence/);
  assert.doesNotMatch(page, /loadPublishedNativeEvidence/);
  assert.doesNotMatch(read('docs/architecture/native-evidence.md'), /accepted for V1/);
  assert.match(read('docs/architecture/native-evidence.md'), /V2 isolated recorded-evidence surface outside the V1 critical path/);
  assert.match(read('src/data/site.ts'), /href: '\/evidence\/'/);
  assert.match(island, /data-neuromorphic-demo/);
  assert.match(island, /aria-labelledby="demo-title"/);
  assert.match(island, /<noscript>/);
  assert.match(island, /Play animation/);
  assert.match(island, /aria-live="polite"/);
  assert.match(island, /role="status"/);
  assert.match(island, /Static neuromorphic pipeline/);
  assert.match(island, /origin="static-diagram"/);
  assert.match(island, /runtimeBound/);
  assert.doesNotMatch(island, /origin="live-wasm"/);
  assert.doesNotMatch(island, /LIVE · Rust\/WASM/);
  assert.match(read('src/components/ExecutionOrigin.astro'), /executionOriginLabel/);
  assert.match(read('src/native-evidence/types.ts'), /LIVE · Rust\/WASM/);
  assert.match(island, /href="\/evidence\/"/);
  assert.match(island, /data-demo-play hidden/);
  assert.match(enhance, /IntersectionObserver/);
  assert.match(enhance, /data-demo-origin/);
  assert.match(enhance, /astro:before-swap/);
  assert.match(enhance, /visibilitychange/);
  assert.match(enhance, /setInViewport\(visible\)\.then\(paint\)/);
  assert.match(enhance, /setDocumentHidden\(document\.hidden\)\.then\(paint\)/);
  assert.match(enhance, /onSnapshotChange\(paint\)/);
  assert.match(enhance, /pageshow/);
  assert.match(enhance, /event.persisted/);
  assert.match(enhance, /removeEventListener\('change', onMotionChange\)/);
  assert.match(enhance, /const pending = boundRuntime.play\(\)/);
  assert.match(read('src/runtime/demo-runtime.ts'), /onWorkerFailure:/);
  assert.match(read('src/runtime/demo-runtime.ts'), /onRendererError:/);
  assert.match(read('src/runtime/demo-runtime.ts'), /signal: AbortSignal/);
  assert.match(enhance, /removeEventListener\('webglcontextlost', onContextLost, contextLostCapture\)/);
  assert.match(enhance, /addEventListener\('webglcontextlost', onContextLost, contextLostCapture\)/);
  assert.doesNotMatch(island, /client:only/);
});

test('page metadata includes canonical and complete social sharing basics', () => {
  const layout = read('src/layouts/BaseLayout.astro');

  assert.match(layout, /property="og:url"/);
  assert.match(layout, /property="og:image:alt"/);
  assert.match(layout, /name="twitter:title"/);
  assert.match(layout, /name="theme-color"/);
});

test('portfolio stays static without a repository hosting configuration', () => {
  const astroConfig = read('astro.config.mjs');
  const workflow = read('.github/workflows/quality.yml');
  const readme = read('README.md');

  assert.match(astroConfig, /output:\s*'static'/);
  assert.match(workflow, /npm run validate/);
  assert.doesNotMatch(workflow, /deploy|wrangler|cloudflare/i);
  assert.match(readme, /hooks\.shipoftheseus\.dev/);
  for (const path of ['.openai/hosting.json', 'public/_redirects', '_redirects', 'wrangler.toml', 'netlify.toml']) {
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), false, `${path} requires explicit approval`);
  }
});

test('quality CI validates the locked Rust/WASM adapter before the frontend contract', () => {
  const workflow = read('.github/workflows/quality.yml');

  assert.match(workflow, /dtolnay\/rust-toolchain@1\.98\.1/);
  assert.match(workflow, /wasm32-unknown-unknown/);
  assert.match(workflow, /cargo fmt --manifest-path crates\/neuromorphic-adapter\/Cargo\.toml --check/);
  assert.match(workflow, /cargo clippy --manifest-path crates\/neuromorphic-adapter\/Cargo\.toml --locked --all-targets -- -D warnings/);
  assert.match(workflow, /cargo test --manifest-path crates\/neuromorphic-adapter\/Cargo\.toml --locked/);
  assert.match(workflow, /cargo check --manifest-path crates\/neuromorphic-adapter\/Cargo\.toml --locked --target wasm32-unknown-unknown/);
  assert.match(workflow, /cargo install wasm-bindgen-cli --version 0\.2\.126 --locked/);
  assert.match(workflow, /WASM_BINDGEN_BIN="\$\(command -v wasm-bindgen\)" BROWSER_BIN="\$\(command -v google-chrome-stable\)" npm run validate/);
  const packageJson = read('package.json');
  assert.match(packageJson, /"validate:rust":/);
  assert.match(packageJson, /"validate": "npm test && npm run lint && npm run typecheck && npm run build && npm run validate:rust && npm run test:wasm-adapter && npm run test:wasm-browser"/);
});
