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
    'src/pages/labs/index.astro',
    'src/pages/labs/nir.astro',
    'src/pages/labs/plasticity.astro',
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

test('the protocol route replays recorded corpus-ipc fixtures static-first and labels them distinctly', () => {
  assert.equal(existsSync(new URL('../src/pages/protocol.astro', import.meta.url)), true);
  const page = read('src/pages/protocol.astro');
  const card = read('src/components/ProtocolFixtureCard.astro');
  const enhance = read('src/protocol/enhance-protocol.ts');
  const inspector = read('src/protocol/inspector.ts');
  const catalog = read('src/protocol/catalog.ts');
  const styles = read('src/styles/protocol.css');

  // Static-first: rendered at build time from the checked-in fixtures.
  assert.match(page, /loadProtocolFixtureCatalog\(\)/);
  assert.match(page, /import '\.\.\/styles\/protocol\.css'/);
  assert.match(page, /data-protocol-viewer/);
  assert.match(page, /data-protocol-checks hidden/);
  assert.match(page, /role="status"/);
  assert.doesNotMatch(page, /client:(only|load|visible|idle)/);
  assert.match(card, /<pre><code>\{fixture\.text\}<\/code><\/pre>/);
  assert.match(card, /data-fixture-sha256=\{fixture\.sha256\}/);
  assert.match(card, /<details class="protocol-bytes" open>/);
  assert.match(enhance, /The recorded bytes and digests above remain the reference/);
  assert.match(inspector, /readBoundedBytes/);
  assert.doesNotMatch(`${catalog}${inspector}${enhance}`, /JSON\.parse\(\s*(text|bytes|decoder)/);

  // Distinct origin label, never the live Rust/WASM one.
  assert.match(page, /<ExecutionOrigin origin="recorded-protocol" \/>/);
  assert.doesNotMatch(page, /<ExecutionOrigin origin="live-wasm"/);
  assert.match(read('src/native-evidence/types.ts'), /PROTOCOL_ORIGIN_LABEL = 'RECORDED · corpus-ipc wire v1'/);
  assert.match(read('src/native-evidence/view.ts'), /case 'recorded-protocol':\s+return 'protocol';/);
  assert.match(styles, /\.execution-origin\[data-origin='protocol'\]/);
  assert.doesNotMatch(read('src/styles/global.css'), /data-origin='protocol'/);

  // Linked from the evidence intro; offline transport only.
  assert.match(read('src/pages/evidence.astro'), /href="\/protocol\/"/);
  assert.match(read('src/protocol/provenance.ts'), /No ZeroMQ, HTTP service, proxy, or live producer/);
  for (const file of ['manifest.json', 'kinetic-seed9-step7-stimuli.json', 'kinetic-seed9-step7-spikes.json', 'kinetic-seed9-step7-eligibility-traces.json']) {
    assert.equal(existsSync(new URL(`../public/protocol/fixtures/v1/${file}`, import.meta.url)), true, `${file} is missing`);
  }
});

test('the browser adapter keeps corpus-ipc on its no-default surface without ZeroMQ or the server', () => {
  const cargoToml = read('crates/neuromorphic-adapter/Cargo.toml');
  const policy = read('scripts/verify-browser-dependencies.mjs');
  const profiles = read('scripts/wasm-profiles.mjs');
  const packageJson = read('package.json');

  assert.match(cargoToml, /^corpus-ipc = \{ version = "=0\.1\.0", default-features = false \}$/m);
  assert.doesNotMatch(cargoToml, /corpus-ipc[^\n]*features = \[/);
  for (const name of ['zmq', 'zeromq', 'axum', 'axum-core', 'tokio', 'tokio-macros', 'hyper', 'tower', 'mio', 'socket2']) {
    assert.match(policy, new RegExp(`'${name}',`), `${name} must stay forbidden in the browser graph`);
  }
  assert.match(policy, /NATIVE_BUILD_PACKAGES = new Set\(\['bindgen', 'cc', 'cmake', 'pkg-config', 'vcpkg'\]\)/);
  assert.match(policy, /feature === 'server' \|\| feature === 'zmq'/);
  assert.match(packageJson, /node scripts\/verify-browser-dependencies\.mjs/);

  // The protocol decode path is a labs-only cargo feature.
  assert.match(cargoToml, /^protocol = \["dep:serde_json", "dep:sha2"\]$/m);
  assert.match(cargoToml, /^sha2 = \{ version = "=0\.10\.9", default-features = false, optional = true \}$/m);
  assert.match(profiles, /features: Object\.freeze\(\['nir', 'protocol', 'plasticity'\]\)/);
  assert.match(profiles, /excludedDirectDependencies: Object\.freeze\(\['nir-rs', 'serde', 'serde_json', 'sha2', 'plasticity-lab', 'limbic-critic'\]\)/);
  assert.match(read('src/protocol/provenance.ts'), /'\/wasm\/neuromorphic-adapter-labs\/neuromorphic_adapter\.js'/);
  assert.doesNotMatch(read('public/wasm/neuromorphic-adapter/neuromorphic_adapter.js'), /inspectProtocolFixture/);
  assert.match(read('public/wasm/neuromorphic-adapter-labs/neuromorphic_adapter.js'), /inspectProtocolFixture/);
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
  const readme = read('README.md');

  assert.match(workflow, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/);
  assert.match(workflow, /dtolnay\/rust-toolchain@ce678459e9fc7500d337468f904b95f1b5c10b5e/);
  assert.match(workflow, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/);
  assert.match(workflow, /wasm32-unknown-unknown/);
  assert.match(workflow, /cargo fmt --manifest-path crates\/neuromorphic-adapter\/Cargo\.toml --check/);
  assert.match(workflow, /cargo clippy --manifest-path crates\/neuromorphic-adapter\/Cargo\.toml --locked --all-targets -- -D warnings/);
  assert.match(workflow, /cargo test --manifest-path crates\/neuromorphic-adapter\/Cargo\.toml --locked/);
  assert.match(workflow, /cargo check --manifest-path crates\/neuromorphic-adapter\/Cargo\.toml --locked --target wasm32-unknown-unknown/);
  assert.match(workflow, /cargo install wasm-bindgen-cli --version 0\.2\.126 --locked/);
  assert.match(workflow, /browser-actions\/setup-chrome@c785b87e244131f27c9f19c1a33e2ead956ab7ce/);
  assert.match(workflow, /chrome-version: stable/);
  assert.match(workflow, /BROWSER_BIN="\$\{\{ steps\.chrome\.outputs\.chrome-path \}\}" npm run validate/);
  const packageJson = read('package.json');
  assert.match(packageJson, /"validate:rust":/);
  assert.match(packageJson, /"validate": "npm test && npm run lint && npm run typecheck && npm run build && npm run validate:rust && npm run test:wasm-adapter && npm run test:wasm-web-pkg && npm run test:wasm-browser"/);
  assert.match(readme, /Rust 1\.98\.1/);
  assert.match(readme, /wasm32-unknown-unknown/);
  assert.match(readme, /wasm-bindgen-cli 0\.2\.126/);
});

test('primary navigation lists Labs between Evidence and About', () => {
  const site = read('src/data/site.ts');
  const evidence = site.indexOf("{ href: '/evidence/', label: 'Evidence' }");
  const labs = site.indexOf("{ href: '/labs/', label: 'Labs' }");
  const about = site.indexOf("{ href: '/about/', label: 'About' }");

  assert.ok(evidence >= 0 && labs > evidence && about > labs, 'Labs must sit between Evidence and About');
  assert.equal(site.match(/label: 'Labs'/g).length, 1);
});

test('the labs index is a list driven by one data array', () => {
  const index = read('src/pages/labs/index.astro');
  const labs = read('src/data/labs.ts');

  assert.match(index, /labs\.map\(\(lab\) =>/);
  assert.match(index, /<ExecutionOrigin origin=\{lab\.origin\} \/>/);
  assert.match(index, /href=\{lab\.href\}/);
  assert.match(labs, /export const labs: readonly LabEntry\[\] = \[/);
  assert.match(labs, /href: '\/labs\/nir\/'/);
  assert.match(labs, /origin: 'imported-nir'/);
  assert.match(labs, /href: '\/labs\/plasticity\/'/);
  assert.match(labs, /origin: 'live-wasm',\s*\n\s*crates: \['limbic-critic', 'plasticity-lab', 'neuromod'\]/);
});

test('the plasticity lab is static-first, keeps reward state apart from spike state, and states its limits', () => {
  const page = read('src/pages/labs/plasticity.astro');
  const enhance = read('src/runtime/enhance-plasticity.ts');
  const runtime = read('src/runtime/plasticity-lab.ts');
  const styles = read('src/styles/plasticity-lab.css');

  // Static first: the committed golden session renders at build time.
  assert.match(page, /scripted-session\.v1\.json\?raw/);
  assert.match(page, /parsePlasticityGolden\(JSON\.parse\(goldenText\)\)/);
  assert.match(page, /data-plasticity-golden-source/);
  assert.match(page, /goldenRows\.map\(\(row\) =>/);
  assert.match(page, /data-plasticity-controls hidden/);
  assert.match(page, /data-plasticity-live hidden/);
  assert.match(page, /<noscript>/);
  assert.match(page, /role="status"/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /<ExecutionOrigin origin="unavailable-wasm" runtimeBound \/>/);
  assert.match(page, /import '\.\.\/\.\.\/styles\/plasticity-lab\.css'/);
  assert.doesNotMatch(page, /client:/);

  // Reward/modulator state and neuron/spike state live in separate panels.
  assert.match(page, /data-plasticity-panel="reward"/);
  assert.match(page, /data-plasticity-panel="network"/);
  assert.ok(page.indexOf('data-plasticity-panel="reward"') < page.indexOf('data-plasticity-panel="network"'));
  assert.ok(!page.slice(page.indexOf('data-plasticity-panel="reward"'), page.indexOf('data-plasticity-panel="network"')).includes('data-plasticity-raster'));
  assert.match(styles, /\.plasticity-panel-reward \{\s*border: 1px dashed var\(--signal\)/);
  assert.match(styles, /\.plasticity-panel-network \{\s*border: 1px solid var\(--ink\)/);

  // Enabled mechanisms and the limits of the crates are stated plainly.
  assert.match(page, /What is enabled, exactly\./);
  assert.match(page, /not an actor-critic/);
  assert.match(page, /No penalty-driven weakening/);
  assert.match(page, /SimpleCritic::try_assess/);
  assert.match(page, /bridge::to_neuromodulators/);
  assert.match(page, /train_step_with_modulators_and_rng/);
  assert.match(page, /run_eval_with_rng/);

  // Bounded buffers, throttled rendering, pausing, and reduced motion.
  assert.match(runtime, /createSpikeRaster/);
  assert.match(runtime, /export const PLASTICITY_HISTORY_STEPS = \d+;/);
  assert.match(enhance, /createFlushScheduler/);
  assert.match(enhance, /prefers-reduced-motion: reduce/);
  assert.match(enhance, /visibilitychange/);
  assert.match(enhance, /IntersectionObserver/);
  assert.match(enhance, /document\.hidden/);
  assert.match(enhance, /astro:before-swap/);
  assert.match(enhance, /pagehide/);
  assert.match(enhance, /session\?\.dispose\(\)/);
  assert.match(enhance, /executionOriginLabel\(originKind\)/);
});

test('the plasticity lab ships only in the labs package and never touches the homepage', () => {
  const lib = read('crates/neuromorphic-adapter/src/lib.rs');
  const manifest = read('crates/neuromorphic-adapter/Cargo.toml');

  assert.match(lib, /#\[cfg\(feature = "plasticity"\)\]\s*\npub mod plasticity;/);
  assert.match(manifest, /^plasticity = \["dep:limbic-critic", "dep:plasticity-lab"\]$/m);
  assert.match(manifest, /^\[\[test\]\]\r?\nname = "plasticity_session"\r?\nrequired-features = \["plasticity"\]$/m);
  assert.match(read('src/runtime/plasticity-lab.ts'), /'\/wasm\/neuromorphic-adapter-labs\/neuromorphic_adapter\.js'/);
  assert.match(read('public/wasm/neuromorphic-adapter-labs/neuromorphic_adapter.js'), /WasmPlasticityLab/);
  assert.doesNotMatch(read('public/wasm/neuromorphic-adapter/neuromorphic_adapter.js'), /WasmPlasticityLab/);
  for (const path of ['src/pages/index.astro', 'src/components/NeuromorphicDemo.astro', 'src/runtime/enhance-demo.ts', 'src/runtime/wasm-session.ts', 'src/runtime/neuromorphic-worker.ts']) {
    assert.doesNotMatch(read(path), /plasticity|neuromorphic-adapter-labs/i, `${path} must not reach the plasticity lab`);
  }
  assert.match(read('.gitattributes'), /^src\/data\/plasticity\/\*\.json text eol=lf$/m);
});

test('the NIR lab is static-first and labelled as imported structure, not the live simulation', () => {
  const page = read('src/pages/labs/nir.astro');
  const enhance = read('src/runtime/enhance-nir.ts');
  const types = read('src/native-evidence/types.ts');
  const home = read('src/pages/index.astro');
  const demo = read('src/components/NeuromorphicDemo.astro');

  assert.match(page, /<ExecutionOrigin origin="imported-nir" \/>/);
  assert.match(types, /IMPORTED_NIR_ORIGIN_LABEL = 'IMPORTED · NIR structure'/);
  assert.match(page, /not a simulation/);
  assert.match(page, /data-nir-lab/);
  assert.match(page, /layoutNirDiagram\(projection\)/);
  assert.match(page, /lif-readout-example\.v1\.inspection\.json\?raw/);
  assert.match(page, /data-nir-static-projection/);
  assert.match(page, /<svg viewBox=/);
  assert.match(page, /href=\{`#\$\{node\.anchorId\}`\}/);
  assert.match(page, /<table class="nir-field-table">/);
  assert.match(page, /<noscript>/);
  assert.match(page, /role="status"/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /data-nir-inspector aria-label="Operator inspector" hidden/);
  assert.match(page, /import '\.\.\/\.\.\/styles\/nir-lab\.css'/);
  assert.doesNotMatch(page, /client:/);
  assert.doesNotMatch(page, /origin="live-wasm"/);
  assert.match(enhance, /astro:before-swap/);
  assert.match(enhance, /pagehide/);
  assert.match(enhance, /session\?\.dispose\(\)/);
  assert.doesNotMatch(home, /labs\/nir|imported-nir/);
  assert.doesNotMatch(demo, /imported-nir/);
});

test('the NIR browser path never ships native HDF5', () => {
  const manifest = read('crates/neuromorphic-adapter/Cargo.toml');
  const policy = read('scripts/verify-browser-dependencies.mjs');

  assert.match(manifest, /nir-rs = \{ version = "=0\.4\.5", default-features = false, features = \["serde"\], optional = true \}/);
  assert.match(manifest, /\[features\]\s*\ndefault = \[\]/);
  assert.match(manifest, /nir = \["dep:nir-rs", "dep:serde", "dep:serde_json"\]/);
  assert.doesNotMatch(manifest, /hdf5/);
  assert.match(policy, /\/hdf5\/i\.test\(pkg\.name\)/);
  assert.match(policy, /NATIVE_FEATURES = new Set\(\['hdf5'\]\)/);
  assert.equal(existsSync(new URL('../public/nir/lif-readout-example.v1.json', import.meta.url)), true);
  assert.doesNotMatch(read('public/nir/lif-readout-example.v1.json'), /\.nir"|hdf5/i);
});

test('NIR inspection ships only in the labs package, never in the homepage package', () => {
  const lib = read('crates/neuromorphic-adapter/src/lib.rs');
  const packageJson = JSON.parse(read('package.json'));
  const rust = packageJson.scripts['validate:rust'];

  assert.match(lib, /#\[cfg\(feature = "nir"\)\]\s*\npub mod nir;/);
  for (const command of ['clippy', 'test', 'check']) {
    const runs = rust.split(' && ').filter((step) => step.includes(` ${command} `));
    assert.equal(runs.length, 2, `${command} must run for the default build and with every labs feature`);
    assert.equal(runs.filter((step) => step.includes('--all-features')).length, 1, command);
    assert.equal(runs.filter((step) => step.includes('--features')).length, 0, `${command} uses --all-features, not a partial list`);
  }
  assert.match(rust, /node scripts\/verify-browser-dependencies\.mjs$/);
  assert.match(read('src/runtime/nir-inspection.ts'), /'\/wasm\/neuromorphic-adapter-labs\/neuromorphic_adapter\.js'/);
  assert.match(read('src/runtime/wasm-session.ts'), /'\/wasm\/neuromorphic-adapter\/neuromorphic_adapter\.js'/);
  assert.match(read('scripts/wasm-profiles.mjs'), /outputDirectory: 'public\/wasm\/neuromorphic-adapter-labs'/);
  for (const file of ['neuromorphic_adapter.js', 'neuromorphic_adapter.d.ts', 'neuromorphic_adapter_bg.wasm']) {
    assert.equal(existsSync(new URL(`../public/wasm/neuromorphic-adapter-labs/${file}`, import.meta.url)), true, file);
  }
  assert.doesNotMatch(read('public/wasm/neuromorphic-adapter/neuromorphic_adapter.js'), /WasmNirInspection/);
});
