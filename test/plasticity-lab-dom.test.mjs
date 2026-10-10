// Behavior tests for the /labs/plasticity/ enhancement (`bindPlasticityLab`)
// against the shared fake DOM (`test/fake-dom.mjs`) and the committed labs
// WASM package. They drive the real controls: Step, Run (with Node's mock
// timers), Reward, Penalty, New episode, Reset, Run scripted session, and
// Probe. Layout, canvas drawing, and CSS are covered by the headless-Chrome
// check described in the PR, not here: the fake canvases return no context.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createFakeDocument, h } from './fake-dom.mjs';
import { loadTsModule } from './load-ts-module.mjs';

const root = new URL('../', import.meta.url);
const goldenText = readFileSync(new URL('src/data/plasticity/scripted-session.v1.json', root), 'utf8');
const LABS_GLUE = new URL('public/wasm/neuromorphic-adapter-labs/neuromorphic_adapter.js', root);
const LABS_BINARY = new URL('public/wasm/neuromorphic-adapter-labs/neuromorphic_adapter_bg.wasm', root);
const MODULATORS = ['dopamine', 'serotonin', 'acetylcholine', 'norepinephrine'];
const RUN_TICK_MS = 250;

/** `document` and `window` with just the listeners the enhancement registers. */
function eventTarget(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    listeners,
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
    },
    count: (type) => (listeners.get(type) ?? []).length,
  };
}

const fakeDocument = eventTarget({ ...createFakeDocument(), hidden: false });
const fakeWindow = eventTarget();
globalThis.document = fakeDocument;
globalThis.window = fakeWindow;

const enhance = await loadTsModule('../src/runtime/enhance-plasticity.ts');
const wasm = await import(LABS_GLUE.href);
await wasm.default({ module_or_path: readFileSync(LABS_BINARY) });

/** The island's markup, reduced to the hooks `bindPlasticityLab` reads. */
function buildIsland() {
  const field = (name, text = '—') => h('dd', { 'data-plasticity-field': name }, text);
  const action = (name) => h('button', { 'data-plasticity-action': name }, name);
  const stimulus = (value, checked) => {
    const input = h('input', { 'data-plasticity-stimulus': '' });
    input.value = value;
    input.checked = checked;
    return input;
  };
  const canvas = (hook) => {
    const element = h('canvas', { [hook]: '' });
    element.getContext = () => null;
    return element;
  };
  const cells = (hook, names) => names.map((name) => h('td', { [hook]: String(name) }, '—'));
  const rows = (hook, makeCells) => [0, 1].map((index) => h('tr', { [hook]: String(index) }, ...makeCells()));
  const golden = h('script', { 'data-plasticity-golden-source': '' }, JSON.stringify(goldenText).replaceAll('<', '\\u003c'));
  const inputs = [stimulus('quiet', false), stimulus('A', true), stimulus('B', false)];
  const island = h(
    'section',
    { 'data-plasticity-lab': '', 'data-plasticity-state': 'static', 'data-plasticity-golden': '' },
    h('p', { 'data-demo-origin': '', 'data-origin': 'unavailable' }, 'UNAVAILABLE · Rust/WASM'),
    h('p', { 'data-plasticity-status': '' }, 'static'),
    h(
      'div',
      { 'data-plasticity-controls': '', hidden: '' },
      ...inputs,
      ...['step', 'run', 'new-episode', 'reset', 'reward', 'penalty', 'scripted', 'probe'].map(action),
    ),
    h(
      'div',
      { 'data-plasticity-live': '', hidden: '' },
      field('last-step'),
      field('last-event'),
      field('observation'),
      field('queued', 'nothing queued'),
      ...MODULATORS.map((name) => h('li', { 'data-modulator': name }, h('span', { 'data-modulator-bar': '' }), h('span', { 'data-modulator-value': '' }, '—'))),
      canvas('data-plasticity-modulator-strip'),
      h('ol', { 'data-plasticity-event-log': '' }),
      h('p', { 'data-plasticity-event-empty': '' }, 'No reward or penalty yet.'),
      canvas('data-plasticity-raster'),
      field('raster-summary', ''),
      ...rows('data-plasticity-neuron', () => cells('data-cell', ['spiked', 'membrane', 'threshold'])),
      ...rows('data-plasticity-weights', () => cells('data-channel', [0, 1, 2, 3])),
      field('weight-change'),
      ...rows('data-plasticity-traces', () => cells('data-channel', [0, 1, 2, 3])),
      field('probe-caption', 'Not probed yet'),
      ...rows('data-plasticity-probe', () => cells('data-cell', ['a', 'b'])),
      field('golden-check', ''),
    ),
    golden,
  );
  return { island, inputs };
}

async function bindLab(options = {}) {
  const { island, inputs } = buildIsland();
  const bound = enhance.bindPlasticityLab(island, {
    loadModule: async () => wasm,
    initModule: async () => undefined,
    ...options,
  });
  await bound.ready;
  const one = (selector) => island.querySelector(selector);
  const text = (name) => one(`[data-plasticity-field="${name}"]`).textContent;
  const modulator = (name) => one(`[data-modulator="${name}"]`).querySelector('[data-modulator-value]').textContent;
  const cell = (rowHook, index, cellHook, name) => one(`[${rowHook}="${index}"]`).querySelector(`[${cellHook}="${name}"]`).textContent;
  const click = (name) => one(`[data-plasticity-action="${name}"]`).dispatch('click');
  const choose = (value) => {
    for (const input of inputs) input.checked = input.value === value;
  };
  const steps = () => Number(island.dataset.plasticitySteps);
  return { island, bound, one, text, modulator, cell, click, choose, steps };
}

test('binding reveals the controls and labels the lab LIVE once the labs package runs', async () => {
  const lab = await bindLab();
  try {
    assert.equal(lab.island.dataset.plasticityState, 'ready');
    assert.equal(lab.one('[data-plasticity-controls]').hidden, false);
    assert.equal(lab.one('[data-plasticity-live]').hidden, false);
    assert.equal(lab.one('[data-demo-origin]').textContent, 'LIVE · Rust/WASM');
    assert.equal(lab.one('[data-demo-origin]').dataset.origin, 'live');
    assert.equal(lab.steps(), 0);
    assert.equal(lab.text('weight-change'), 'No step yet.');
    for (const name of MODULATORS) assert.equal(lab.modulator(name), '0.00');
    assert.equal(lab.cell('data-plasticity-weights', 0, 'data-channel', 0), '0.5000 (±0.0000)');
  } finally {
    lab.bound.dispose();
  }
});

test('Step, Reward, and Penalty step the session and update the reward and network panels separately', async () => {
  const lab = await bindLab();
  try {
    await lab.click('step');
    assert.equal(lab.steps(), 1);
    assert.equal(lab.text('last-event'), 'none');
    assert.equal(lab.cell('data-plasticity-neuron', 0, 'data-cell', 'spiked'), 'yes', 'pattern A fires both neurons');
    assert.equal(lab.one('[data-plasticity-event-empty]').hidden, false);

    await lab.click('reward');
    assert.equal(lab.steps(), 2);
    assert.equal(lab.text('last-event'), 'Reward');
    assert.equal(lab.text('observation'), 'objective 1.00, stress 0.00');
    assert.equal(lab.modulator('dopamine'), '1.00');
    assert.equal(lab.modulator('norepinephrine'), '0.00');
    assert.match(lab.text('weight-change'), /^Step 2: 8 weights · largest \|Δw\| 0\.0\d{3}\.$/);

    lab.choose('B');
    await lab.click('penalty');
    assert.equal(lab.steps(), 3);
    assert.equal(lab.text('last-event'), 'Penalty');
    assert.equal(lab.modulator('dopamine'), '0.00');
    assert.equal(lab.modulator('norepinephrine'), '1.00');
    assert.equal(lab.cell('data-plasticity-neuron', 0, 'data-cell', 'spiked'), 'no', 'norepinephrine lowers the input gain');
    assert.match(lab.text('weight-change'), /no weight changed|float rounding only/);

    const log = lab.one('[data-plasticity-event-log]').children.map((entry) => entry.textContent);
    assert.deepEqual(log, [
      'Step 3: Penalty → dopamine 0.00, norepinephrine 1.00',
      'Step 2: Reward → dopamine 1.00, norepinephrine 0.00',
    ]);
    assert.equal(lab.one('[data-plasticity-event-empty]').hidden, true);
  } finally {
    lab.bound.dispose();
  }
});

test('Run steps on a timer, stops on Pause, and a reward queued while running lands on exactly the next step', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lab = await bindLab();
  try {
    const run = lab.one('[data-plasticity-action="run"]');
    await lab.click('run');
    assert.equal(run.getAttribute('aria-pressed'), 'true');
    assert.equal(run.textContent, 'Pause');
    t.mock.timers.tick(RUN_TICK_MS);
    t.mock.timers.tick(RUN_TICK_MS);
    await lab.click('probe'); // renders now without stepping
    assert.equal(lab.steps(), 2);

    // Queued while running: no step yet, the panel says what is pending.
    await lab.click('reward');
    assert.equal(lab.island.dataset.plasticityQueued, 'reward');
    assert.equal(lab.text('queued'), 'Reward, applied to the next step');
    await lab.click('probe');
    assert.equal(lab.steps(), 2);

    // A manual Step before the next tick takes the queued reward...
    await lab.click('step');
    assert.equal(lab.steps(), 3);
    assert.equal(lab.text('last-event'), 'Reward');
    assert.equal(lab.island.dataset.plasticityQueued, 'none');
    // ...and the following Run tick carries nothing.
    t.mock.timers.tick(RUN_TICK_MS);
    await lab.click('probe');
    assert.equal(lab.steps(), 4);
    assert.equal(lab.text('last-event'), 'none');

    // Queued while running and taken by the Run tick itself.
    await lab.click('penalty');
    t.mock.timers.tick(RUN_TICK_MS);
    await lab.click('probe');
    assert.equal(lab.steps(), 5);
    assert.equal(lab.text('last-event'), 'Penalty');

    await lab.click('run');
    assert.equal(run.getAttribute('aria-pressed'), 'false');
    assert.equal(run.textContent, 'Run');
    t.mock.timers.tick(RUN_TICK_MS * 8);
    await lab.click('probe');
    assert.equal(lab.steps(), 5, 'Pause stops the loop');
  } finally {
    lab.bound.dispose();
  }
});

test('Run pauses while the document is hidden', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lab = await bindLab();
  try {
    await lab.click('run');
    fakeDocument.hidden = true;
    t.mock.timers.tick(RUN_TICK_MS * 4);
    await lab.click('probe');
    assert.equal(lab.steps(), 0);
    fakeDocument.hidden = false;
    for (const listener of fakeDocument.listeners.get('visibilitychange') ?? []) listener();
    t.mock.timers.tick(RUN_TICK_MS);
    await lab.click('probe');
    assert.equal(lab.steps(), 1);
  } finally {
    fakeDocument.hidden = false;
    lab.bound.dispose();
  }
});

test('New episode renders one consistent reset state and drops a queued input', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lab = await bindLab();
  try {
    await lab.click('step');
    await lab.click('reward');
    const weights = [0, 1, 2, 3].map((channel) => lab.cell('data-plasticity-weights', 0, 'data-channel', channel));
    await lab.click('run');
    await lab.click('penalty');
    assert.equal(lab.island.dataset.plasticityQueued, 'penalty');
    await lab.click('new-episode');
    await lab.click('run');

    assert.equal(lab.island.dataset.plasticityEpisode, '2');
    assert.equal(lab.island.dataset.plasticityQueued, 'none');
    assert.equal(lab.steps(), 2);
    // Every per-step readout describes the reset network, not the old step.
    assert.equal(lab.text('last-step'), 'none yet in episode 2');
    assert.equal(lab.text('last-event'), '—');
    assert.equal(lab.text('observation'), '—');
    assert.equal(lab.island.dataset.plasticityLastEvent, '');
    for (const name of MODULATORS) assert.equal(lab.modulator(name), '0.00');
    for (const neuron of [0, 1]) {
      assert.equal(lab.cell('data-plasticity-neuron', neuron, 'data-cell', 'spiked'), '—');
      assert.equal(lab.cell('data-plasticity-neuron', neuron, 'data-cell', 'membrane'), '0.0000');
      for (const channel of [0, 1, 2, 3]) assert.equal(lab.cell('data-plasticity-traces', neuron, 'data-channel', channel), '0.00000');
    }
    assert.match(lab.text('weight-change'), /^Episode 2 started after step 2: .*weights and thresholds kept\. No step in this episode yet\.$/);
    // Learned weights survive the episode boundary.
    assert.deepEqual([0, 1, 2, 3].map((channel) => lab.cell('data-plasticity-weights', 0, 'data-channel', channel)), weights);
    // History views keep the earlier reward and penalty steps.
    assert.equal(lab.one('[data-plasticity-event-log]').children.length, 1);

    await lab.click('step');
    assert.equal(lab.text('last-step'), '3 (episode 2, Pattern A)');
    assert.equal(lab.text('last-event'), 'none', 'the dropped penalty never lands');
  } finally {
    lab.bound.dispose();
  }
});

test('Reset starts a fresh seeded session and clears the display', async () => {
  const lab = await bindLab();
  try {
    await lab.click('step');
    await lab.click('reward');
    await lab.click('scripted');
    assert.equal(lab.island.dataset.plasticityGolden, 'match');
    await lab.click('reset');
    assert.equal(lab.steps(), 0);
    assert.equal(lab.island.dataset.plasticityEpisode, '1');
    assert.equal(lab.island.dataset.plasticityGolden, '');
    assert.equal(lab.text('golden-check'), '');
    assert.equal(lab.text('last-step'), '—');
    assert.equal(lab.text('weight-change'), 'No step yet.');
    assert.equal(lab.text('probe-caption'), 'Not probed yet');
    assert.equal(lab.one('[data-plasticity-event-log]').children.length, 0);
    assert.equal(lab.one('[data-plasticity-event-empty]').hidden, false);
    assert.equal(lab.cell('data-plasticity-weights', 1, 'data-channel', 3), '0.5000 (±0.0000)');
    assert.equal(lab.cell('data-plasticity-probe', 0, 'data-cell', 'a'), '—');
  } finally {
    lab.bound.dispose();
  }
});

test('Run scripted session replays the golden and Probe shows the frozen spike counts', async () => {
  const lab = await bindLab();
  try {
    await lab.click('scripted');
    assert.equal(lab.island.dataset.plasticityGolden, 'match');
    assert.match(lab.text('golden-check'), /all 24 steps, the final weights, thresholds, traces, and both probes match the committed golden exactly/);
    assert.equal(lab.steps(), 24);
    assert.equal(lab.text('probe-caption'), 'Frozen probe after step 24');
    for (const neuron of [0, 1]) {
      assert.equal(lab.cell('data-plasticity-probe', neuron, 'data-cell', 'a'), '3');
      assert.equal(lab.cell('data-plasticity-probe', neuron, 'data-cell', 'b'), '2');
    }
    await lab.click('probe');
    assert.equal(lab.text('probe-caption'), 'Frozen probe after step 24');
    assert.equal(lab.steps(), 24, 'probing never steps');
  } finally {
    lab.bound.dispose();
  }
});

test('a package that fails to load keeps the static page and reports why', async () => {
  const lab = await bindLab({
    loadModule: async () => {
      throw new Error('blocked');
    },
  });
  assert.equal(lab.island.dataset.plasticityState, 'unavailable');
  assert.equal(lab.island.dataset.plasticityReason, 'wasm-init-failed');
  assert.equal(lab.one('[data-plasticity-controls]').hidden, true);
  assert.equal(lab.one('[data-plasticity-live]').hidden, true);
  assert.equal(lab.one('[data-demo-origin]').textContent, 'UNAVAILABLE · Rust/WASM');
  assert.equal(lab.one('[data-plasticity-status]').textContent, enhance.PLASTICITY_UNAVAILABLE_STATUS);
  lab.bound.dispose();
});

test('dispose removes every listener the binding added', async () => {
  const before = { swap: fakeDocument.count('astro:before-swap'), visibility: fakeDocument.count('visibilitychange'), pagehide: fakeWindow.count('pagehide') };
  const lab = await bindLab();
  assert.equal(lab.one('[data-plasticity-action="step"]').listenerCount('click'), 1);
  assert.equal(fakeDocument.count('visibilitychange'), before.visibility + 1);
  lab.bound.dispose();
  for (const button of lab.island.querySelectorAll('[data-plasticity-action]')) assert.equal(button.listenerCount('click'), 0);
  assert.equal(fakeDocument.count('astro:before-swap'), before.swap);
  assert.equal(fakeDocument.count('visibilitychange'), before.visibility);
  assert.equal(fakeWindow.count('pagehide'), before.pagehide);
});
