// Behavior tests for the /labs/nir/ enhancement (`bindNirLab`,
// `renderNirInspector`) against a minimal fake DOM. The fake implements only
// what `src/runtime/enhance-nir.ts` touches: `dataset`, attributes, children,
// `textContent`, `hidden`, listeners, `querySelector(All)` for `[data-*]`
// selectors, and `document.createElement`. Real layout and CSS are covered by
// the headless-Chrome check described in the PR, not here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { loadTsModule } from './load-ts-module.mjs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const envelope = read('public/nir/lif-readout-example.v1.json');
const projection = read('src/data/nir/lif-readout-example.v1.inspection.json');
const projected = JSON.parse(projection);

const toDatasetKey = (attribute) =>
  attribute.replace(/^data-/, '').replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size ?? 0;
  }

  dispatch(type, event = {}) {
    const fired = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, currentTarget: this, ...event };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(fired);
    return fired;
  }
}

class FakeElement extends FakeEventTarget {
  constructor(tagName, { dataset = {}, attributes = {}, children = [] } = {}) {
    super();
    this.tagName = tagName.toUpperCase();
    this.dataset = { ...dataset };
    this.attributes = new Map(Object.entries(attributes));
    this.children = [...children];
    this.ownText = '';
    this.hidden = false;
    this.className = '';
  }

  get textContent() {
    if (this.children.length === 0) return this.ownText;
    return this.children.map((child) => (typeof child === 'string' ? child : child.textContent)).join('');
  }

  set textContent(value) {
    this.children = [];
    this.ownText = String(value);
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.ownText = '';
    this.children = [...nodes];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  *descendants() {
    for (const child of this.children) {
      if (child instanceof FakeElement) {
        yield child;
        yield* child.descendants();
      }
    }
  }

  matches(selector) {
    const attribute = /^\[([a-z-]+)\]$/.exec(selector);
    if (attribute) return toDatasetKey(attribute[1]) in this.dataset;
    const className = /^\.([a-z-]+)$/.exec(selector);
    if (className) return this.className.split(/\s+/).includes(className[1]);
    return this.tagName === selector.toUpperCase();
  }

  querySelectorAll(selector) {
    return [...this.descendants()].filter((element) => element.matches(selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

/** Mirrors the island markup in `src/pages/labs/nir.astro`. */
function buildIsland({ projectionText = projection } = {}) {
  const el = (tag, options) => new FakeElement(tag, options);
  const status = el('p', { dataset: { nirStatus: '' } });
  const selection = el('p', { dataset: { nirSelection: '' } });
  const body = el('div', { dataset: { nirInspectorBody: '' } });
  const inspector = el('aside', { dataset: { nirInspector: '' }, children: [selection, body] });
  inspector.hidden = true;
  const anchors = projected.nodes.map((node) =>
    el('a', { dataset: { nirNode: node.name, nirOperator: node.operator }, attributes: { href: `#nir-node-${node.name}` } }),
  );
  const edges = projected.edges.map((edge) => el('path', { dataset: { nirEdgeSource: edge.source, nirEdgeTarget: edge.target } }));
  const script = el('script', { dataset: { nirStaticProjection: '' } });
  script.textContent = JSON.stringify(projectionText);
  const svg = el('svg', { children: [...edges, ...anchors] });
  const island = el('section', {
    dataset: { nirLab: '', nirEnvelope: '/nir/lif-readout-example.v1.json', nirState: 'static' },
    children: [svg, status, inspector, script],
  });
  return { island, status, inspector, body, selection, anchors, edges };
}

function installGlobals() {
  const previous = { document: globalThis.document, window: globalThis.window };
  const document = new FakeEventTarget();
  document.createElement = (tag) => new FakeElement(tag);
  const window = new FakeEventTarget();
  globalThis.document = document;
  globalThis.window = window;
  return {
    document,
    window,
    restore() {
      globalThis.document = previous.document;
      globalThis.window = previous.window;
    },
  };
}

const enhance = await loadTsModule('../src/runtime/enhance-nir.ts');
const inspection = await loadTsModule('../src/runtime/nir-inspection.ts');
const wasm = await import(new URL('public/wasm/neuromorphic-adapter-labs/neuromorphic_adapter.js', root).href);
await wasm.default({ module_or_path: readFileSync(new URL('public/wasm/neuromorphic-adapter-labs/neuromorphic_adapter_bg.wasm', root)) });

/** Real `openNirInspection` over the committed labs package. */
const openWithCommittedWasm = (options) =>
  inspection.openNirInspection({ ...options, loadModule: async () => wasm, initModule: async () => undefined });

const fetchEnvelope = async () => envelope;
const selectedNames = (anchors) => anchors.filter((anchor) => 'selected' in anchor.dataset).map((anchor) => anchor.dataset.nirNode);
const activeEdges = (edges) => edges.filter((edge) => 'active' in edge.dataset).map((edge) => `${edge.dataset.nirEdgeSource}->${edge.dataset.nirEdgeTarget}`);
const tableRows = (body) =>
  body.querySelectorAll('tr').filter((row) => row.children[0]?.tagName === 'TH' && row.children[1]?.tagName === 'TD')
    .map((row) => row.children.map((cell) => cell.textContent).join(' | '));

test('selecting an operator renders its nir-rs fields and highlights its edges', async () => {
  const globals = installGlobals();
  try {
    const dom = buildIsland();
    const bound = enhance.bindNirLab(dom.island, { open: openWithCommittedWasm, fetchText: fetchEnvelope });
    assert.equal(dom.island.dataset.nirState, 'loading');
    await bound.ready;

    assert.equal(dom.island.dataset.nirState, 'ready');
    assert.equal(dom.status.textContent, enhance.nirReadyStatus('0.4.5'));
    assert.equal(dom.inspector.hidden, false);
    assert.deepEqual(selectedNames(dom.anchors), ['input'], 'the first operator is preselected');
    assert.deepEqual(activeEdges(dom.edges), ['input->fc1']);

    const lif = dom.anchors.find((anchor) => anchor.dataset.nirNode === 'lif1');
    const click = lif.dispatch('click');
    assert.equal(click.defaultPrevented, true, 'selection replaces the fragment jump');
    assert.deepEqual(selectedNames(dom.anchors), ['lif1']);
    assert.equal(lif.getAttribute('aria-current'), 'true');
    assert.equal(dom.anchors.filter((anchor) => anchor.getAttribute('aria-current')).length, 1);
    assert.deepEqual(activeEdges(dom.edges), ['fc1->lif1', 'lif1->fc2']);
    assert.equal(dom.selection.textContent, 'Showing lif1 (LIF).');
    assert.equal(dom.body.querySelector('h3').textContent, 'lif1');
    assert.match(dom.body.querySelector('.nir-inspector-operator').textContent, /^LIF · parsed by nir-rs 0\.4\.5 in Rust\/WASM$/);
    assert.deepEqual(tableRows(dom.body), [
      'tau | f64 | 4 | 0.02, 0.02, 0.02, 0.02',
      'r | f64 | 4 | 1, 1, 1, 1',
      'v_leak | f64 | 4 | 0, 0, 0, 0',
      'v_threshold | f64 | 4 | 1, 1, 1, 1',
      'v_reset | f64 | 4 | 0, 0, 0, 0',
    ]);
    for (const table of dom.body.querySelectorAll('table')) {
      assert.ok(dom.body.querySelectorAll('.nir-table-wrap').some((wrap) => wrap.children.includes(table)), 'tables sit in a scroll wrapper');
    }

    bound.dispose();
    assert.equal(lif.listenerCount('click'), 0);
    assert.equal(globals.document.listenerCount('astro:before-swap'), 0);
    assert.equal(globals.window.listenerCount('pagehide'), 0);
  } finally {
    globals.restore();
  }
});

test('a load failure keeps the static links and the hidden inspector', async () => {
  const globals = installGlobals();
  try {
    const dom = buildIsland();
    const bound = enhance.bindNirLab(dom.island, {
      loadModule: async () => {
        throw new Error('404 for the labs package');
      },
      fetchText: fetchEnvelope,
    });
    await bound.ready;

    assert.equal(dom.island.dataset.nirState, 'unavailable');
    assert.equal(dom.island.dataset.nirReason, 'wasm-init-failed');
    assert.equal(dom.status.textContent, enhance.NIR_UNAVAILABLE_STATUS);
    assert.equal(dom.inspector.hidden, true);
    for (const anchor of dom.anchors) {
      assert.equal(anchor.listenerCount('click'), 0, 'no click interception');
      assert.equal(anchor.dispatch('click').defaultPrevented, false, 'the fragment link still navigates');
      assert.match(anchor.getAttribute('href'), /^#nir-node-/);
    }
    assert.deepEqual(selectedNames(dom.anchors), []);
    bound.dispose();
  } finally {
    globals.restore();
  }
});

test('a static projection that does not match the WASM parse keeps the static page', async () => {
  const globals = installGlobals();
  try {
    const dom = buildIsland({ projectionText: projection.replace('"LIF"', '"IF"') });
    const bound = enhance.bindNirLab(dom.island, { open: openWithCommittedWasm, fetchText: fetchEnvelope });
    await bound.ready;
    assert.equal(dom.island.dataset.nirReason, 'projection-mismatch');
    assert.equal(dom.inspector.hidden, true);
    assert.equal(dom.anchors[0].listenerCount('click'), 0);
    bound.dispose();
  } finally {
    globals.restore();
  }
});

test('a malformed node view after load falls back without leaving a half-selected graph', async () => {
  const globals = installGlobals();
  try {
    const dom = buildIsland();
    let calls = 0;
    let disposed = 0;
    const bound = enhance.bindNirLab(dom.island, {
      open: async () => ({
        nirRsVersion: '0.4.5',
        nodeCount: 6,
        edgeCount: 5,
        node(name) {
          calls += 1;
          if (calls > 1) throw new inspection.NirInspectionUnavailableError('invalid-node', `bad ${name}`);
          return projected.nodes.find((node) => node.name === name);
        },
        dispose() {
          disposed += 1;
        },
      }),
      fetchText: fetchEnvelope,
    });
    await bound.ready;
    assert.equal(dom.island.dataset.nirState, 'ready');

    dom.anchors.find((anchor) => anchor.dataset.nirNode === 'fc2').dispatch('click');
    assert.equal(dom.island.dataset.nirState, 'unavailable');
    assert.equal(dom.island.dataset.nirReason, 'invalid-node');
    assert.equal(disposed, 1);
    assert.equal(dom.inspector.hidden, true);
    assert.equal(dom.body.children.length, 0);
    assert.deepEqual(selectedNames(dom.anchors), []);
    assert.deepEqual(activeEdges(dom.edges), []);
    assert.equal(dom.anchors.every((anchor) => anchor.listenerCount('click') === 0), true);
    bound.dispose();
    assert.equal(disposed, 1, 'dispose after fallback does not double-free');
  } finally {
    globals.restore();
  }
});

test('disposing while loading releases the late session and never enables selection', async () => {
  const globals = installGlobals();
  try {
    const dom = buildIsland();
    let resolveOpen;
    let disposed = 0;
    const bound = enhance.bindNirLab(dom.island, {
      open: () => new Promise((resolve) => {
        resolveOpen = resolve;
      }),
      fetchText: fetchEnvelope,
    });
    assert.equal(dom.island.dataset.nirState, 'loading');
    assert.equal(globals.document.listenerCount('astro:before-swap'), 1);

    globals.document.dispatch('astro:before-swap');
    assert.equal(globals.document.listenerCount('astro:before-swap'), 0);
    assert.equal(globals.window.listenerCount('pagehide'), 0);

    resolveOpen({
      nirRsVersion: '0.4.5',
      nodeCount: 6,
      edgeCount: 5,
      node: () => {
        throw new Error('must not be called after dispose');
      },
      dispose() {
        disposed += 1;
      },
    });
    await bound.ready;

    assert.equal(disposed, 1, 'the session that arrives after dispose is released');
    assert.equal(dom.inspector.hidden, true);
    assert.equal(dom.anchors.every((anchor) => anchor.listenerCount('click') === 0), true);
    assert.notEqual(dom.island.dataset.nirState, 'ready');
  } finally {
    globals.restore();
  }
});

test('a back/forward-cache pagehide keeps the lab; a real pagehide disposes it', async () => {
  const globals = installGlobals();
  try {
    const dom = buildIsland();
    const bound = enhance.bindNirLab(dom.island, { open: openWithCommittedWasm, fetchText: fetchEnvelope });
    await bound.ready;
    globals.window.dispatch('pagehide', { persisted: true });
    assert.equal(dom.anchors[0].listenerCount('click'), 1);
    globals.window.dispatch('pagehide', { persisted: false });
    assert.equal(dom.anchors[0].listenerCount('click'), 0);
    assert.equal(globals.window.listenerCount('pagehide'), 0);
  } finally {
    globals.restore();
  }
});

test('renderNirInspector wraps parameter and metadata tables and writes text only', () => {
  const globals = installGlobals();
  try {
    const body = new FakeElement('div');
    const node = {
      ...projected.nodes.find((candidate) => candidate.name === 'fc1'),
      metadata: [{ name: 'note', kind: 'string', dtype: 'string', shape: [], value_count: 1, values: ['<b>not html</b>'] }],
    };
    enhance.renderNirInspector(body, node, '0.4.5');

    const wraps = body.querySelectorAll('.nir-table-wrap');
    assert.equal(wraps.length, 2);
    assert.deepEqual(wraps.map((wrap) => wrap.children[0].children[0].textContent), ['Parameters', 'Metadata']);
    assert.ok(tableRows(body).includes('note | string | scalar | <b>not html</b>'));
    assert.match(body.querySelector('dl').textContent, /Receives frominput.*Sends tolif1/);
  } finally {
    globals.restore();
  }
});
