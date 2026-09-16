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
    'src/pages/about.astro',
    'src/pages/projects.astro',
    'src/pages/notes/index.astro',
    'src/pages/contact.astro',
    'src/pages/resume.astro',
  ]) {
    assert.equal(existsSync(new URL(`../${route}`, import.meta.url)), true, `${route} is missing`);
  }
});

test('the responsive stylesheet does not force horizontal scrolling on narrow screens', () => {
  const styles = read('src/styles/global.css');

  assert.doesNotMatch(styles, /min-width:320px/);
  assert.match(styles, /@media\(max-width:360px\)/);
});

test('the static site does not depend on remotely hosted fonts', () => {
  assert.doesNotMatch(read('src/styles/global.css'), /@import\s+url/);
});

test('publishing handoff values become live only when configured', () => {
  const contact = read('src/pages/contact.astro');
  const resume = read('src/pages/resume.astro');

  assert.match(contact, /site\.email/);
  assert.match(contact, /mailto:\$\{site\.email\}/);
  assert.match(resume, /site\.resumePath/);
  assert.match(resume, /href=\{site\.resumePath\}/);
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

test('supported Node versions match the locked build tooling', () => {
  const packageJson = JSON.parse(read('package.json'));
  const readme = read('README.md');

  assert.equal(packageJson.engines.node, '^20.19.0 || >=22.12.0');
  assert.match(readme, /20\.19\+.*22\.12\+/);
});

test('small text uses accessible muted and signal color tokens', () => {
  assert.equal(existsSync(new URL('../src/styles/review-fixes.css', import.meta.url)), true);
  const reviewFixes = read('src/styles/review-fixes.css');

  assert.match(reviewFixes, /--muted:\s*#65655e/);
  assert.match(reviewFixes, /--signal:\s*#a94422/);
});
