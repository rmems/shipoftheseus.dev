import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { loadTsModule } from './load-ts-module.mjs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const GOLDEN_PATH = 'src/data/plasticity/scripted-session.v1.json';
const LABS_GLUE = new URL('public/wasm/neuromorphic-adapter-labs/neuromorphic_adapter.js', root);
const LABS_BINARY = new URL('public/wasm/neuromorphic-adapter-labs/neuromorphic_adapter_bg.wasm', root);

const goldenText = read(GOLDEN_PATH);
const lab = await loadTsModule('../src/runtime/plasticity-lab.ts');
const golden = lab.parsePlasticityGolden(JSON.parse(goldenText));

let wasmModule;
async function committedLabsWasm() {
  if (!wasmModule) {
    wasmModule = await import(LABS_GLUE.href);
    await wasmModule.default({ module_or_path: readFileSync(LABS_BINARY) });
  }
  return wasmModule;
}

async function freshSession(seed = BigInt(golden.seed)) {
  return lab.createPlasticitySession(await committedLabsWasm(), seed);
}

test('the committed labs package replays the golden scripted session bit for bit', async () => {
  const session = await freshSession();
  try {
    const seen = [];
    const replay = lab.replayGolden(session, golden, (view) => seen.push(view.step));
    assert.equal(replay.mismatch, null, JSON.stringify(replay.mismatch));
    assert.equal(replay.steps.length, golden.steps.length);
    assert.deepEqual(seen, golden.steps.map((step) => BigInt(step.step)));
    assert.deepEqual(Array.from(replay.probeAfter.patternA), golden.probe_after.pattern_a_spikes);
    assert.deepEqual(Array.from(replay.probeAfter.patternB), golden.probe_after.pattern_b_spikes);
  } finally {
    session.dispose();
  }
});

test('a replay that diverges from the golden names the first differing step and field', async () => {
  const tampered = lab.parsePlasticityGolden(JSON.parse(goldenText));
  const rewardStep = tampered.steps.find((step) => step.event === 'reward');
  rewardStep.weight_changes[0][3] ^= 1;
  const session = await freshSession();
  try {
    const replay = lab.replayGolden(session, tampered);
    assert.deepEqual(replay.mismatch, { step: rewardStep.step, field: 'weight changes' });
    assert.equal(replay.steps.length, rewardStep.step);
  } finally {
    session.dispose();
  }
  const otherSeed = await freshSession(BigInt(golden.seed) + 1n);
  try {
    assert.throws(() => lab.replayGolden(otherSeed, golden), /golden seed/);
  } finally {
    otherSeed.dispose();
  }
});

test('reward and penalty pass through limbic-critic into separate modulator channels', async () => {
  const session = await freshSession();
  try {
    const quiet = session.step('A', 'none');
    assert.deepEqual(Array.from(quiet.modulators), [0, 0, 0, 0]);
    const reward = session.step('quiet', 'reward');
    assert.equal(reward.objective, 1);
    assert.equal(reward.stress, 0);
    assert.deepEqual(Array.from(reward.modulators), [1, 0, 0, 0]);
    assert.ok(lab.largestWeightChange(reward) > 1e-3, 'dopamine pays out the traces pattern A left');
    const penalty = session.step('quiet', 'penalty');
    assert.equal(penalty.objective, -1);
    assert.equal(penalty.stress, 1);
    assert.deepEqual(Array.from(penalty.modulators), [0, 0, 0, 1]);
    // No dopamine, so no learning: at most the renormalization pass settling
    // the L1 budget by float rounding.
    assert.ok(lab.largestWeightChange(penalty) <= lab.RENORMALIZATION_ROUNDING);
    assert.deepEqual(Array.from(session.state().modulators), [0, 0, 0, 1]);
    // Norepinephrine lowers neuromod's input gain to 10 %: no output spikes.
    assert.deepEqual(Array.from(session.step('B', 'penalty').outputSpikes), []);
    assert.deepEqual(Array.from(session.step('B', 'none').outputSpikes), [0, 1]);
  } finally {
    session.dispose();
  }
});

test('the probe is frozen and a new episode keeps weights while clearing traces', async () => {
  const session = await freshSession();
  try {
    for (const step of golden.steps.slice(0, 6)) session.step(step.stimulus, step.event);
    const before = session.state();
    const probe = session.probe();
    assert.equal(probe.stepsPerPattern, golden.network.probe_steps);
    assert.deepEqual(session.probe(), probe);
    const after = session.state();
    assert.deepEqual(after.weights, before.weights);
    assert.deepEqual(after.eligibility, before.eligibility);
    assert.deepEqual(after.membranePotentials, before.membranePotentials);
    assert.equal(after.engineStep, before.engineStep);

    session.newEpisode();
    const episode = session.state();
    assert.equal(episode.episode, 2);
    assert.equal(episode.engineStep, 0n);
    assert.deepEqual(episode.weights, before.weights);
    assert.ok(Array.from(episode.eligibility).every((value) => value === 0));
    assert.equal(episode.completedSteps, 6n);
  } finally {
    session.dispose();
  }
});

test('invalid codes fail closed with stable reason codes and a disposed session refuses work', async () => {
  const wasm = await committedLabsWasm();
  const handle = wasm.WasmPlasticityLab.create(1n);
  try {
    assert.throws(() => handle.step(3, 0), /^plasticity-stimulus-invalid:/);
    assert.throws(() => handle.step(0, 7), /^plasticity-event-invalid:/);
    assert.equal(handle.completed_steps, 0n);
    assert.equal(handle.lab_version, lab.PLASTICITY_LAB_VERSION);
    assert.equal(handle.neuron_count, golden.network.lif_neurons);
    assert.equal(handle.channel_count, golden.network.channels);
  } finally {
    handle.free();
  }
  assert.equal(lab.plasticityErrorCode('plasticity-step-failed: network step failed'), 'plasticity-step-failed');
  assert.equal(lab.plasticityErrorCode(new Error('boom')), 'plasticity-step-failed');

  const session = await freshSession();
  session.dispose();
  session.dispose();
  assert.throws(() => session.step('A', 'none'), /disposed/);
});

test('the golden parser rejects malformed or mislabelled sessions', () => {
  const reject = (mutate) => {
    const candidate = JSON.parse(goldenText);
    mutate(candidate);
    assert.throws(() => lab.parsePlasticityGolden(candidate), (error) => error.code === 'invalid-golden');
  };
  reject((value) => { value.format = 'other'; });
  reject((value) => { value.lab_version = 2; });
  reject((value) => { value.seed = 17; });
  reject((value) => { value.seed = '18446744073709551616'; });
  reject((value) => { value.steps[3].stimulus = 'C'; });
  reject((value) => { value.steps[3].step = 9; });
  reject((value) => { value.steps[5].weight_changes.push([2, 0, 0, 0]); });
  reject((value) => { value.steps[0].output_spikes = [5]; });
  reject((value) => { value.final_weight_bits.pop(); });
  reject((value) => { value.probe_after.pattern_a_spikes = [-1, 3]; });
  assert.throws(() => lab.decodeEmbeddedGolden('{"not":"a string"}'), /not a string literal/);
  const embedded = JSON.stringify(goldenText).replaceAll('<', '\\u003c');
  assert.equal(lab.decodeEmbeddedGolden(embedded).seed, golden.seed);
});

test('the golden documents its generator and the claims the page makes', () => {
  assert.match(golden.regenerate, /--features plasticity --test plasticity_session regenerate_plasticity_golden -- --ignored --exact/);
  assert.ok(readFileSync(new URL(golden.generator, root)));
  assert.equal(lab.f32FromBits(golden.network.initial_weight_bits), 0.5);
  assert.equal(lab.bitsFromF32(0.5), golden.network.initial_weight_bits);
  // Reward pays out traces; penalty and plain steps never learn.
  for (const step of golden.steps) {
    const dopamine = lab.f32FromBits(step.modulator_bits[0]);
    const largest = lab.largestGoldenWeightChange(step);
    if (dopamine > 0) assert.ok(largest > 1e-3, `step ${step.step}`);
    else assert.ok(largest <= lab.RENORMALIZATION_ROUNDING, `step ${step.step}`);
  }
  for (let neuron = 0; neuron < golden.network.lif_neurons; neuron += 1) {
    assert.equal(golden.probe_before.pattern_a_spikes[neuron], golden.probe_before.pattern_b_spikes[neuron]);
    assert.ok(golden.probe_after.pattern_a_spikes[neuron] > golden.probe_after.pattern_b_spikes[neuron]);
  }
});

test('the provenance the page shows matches the locked crates', () => {
  const manifest = read('crates/neuromorphic-adapter/Cargo.toml');
  const lock = read('crates/neuromorphic-adapter/Cargo.lock').replaceAll('\r\n', '\n');
  assert.match(manifest, new RegExp(`^limbic-critic = \\{ version = "=${lab.LIMBIC_CRITIC_VERSION.replaceAll('.', '\\.')}", optional = true \\}$`, 'm'));
  assert.match(
    manifest,
    new RegExp(`^plasticity-lab = \\{ git = "${lab.PLASTICITY_LAB_REPOSITORY}\\.git", rev = "${lab.PLASTICITY_LAB_REVISION}", default-features = false, features = \\["critic", "wasm-js"\\], optional = true \\}$`, 'm'),
  );
  assert.match(manifest, /^plasticity = \["dep:limbic-critic", "dep:plasticity-lab"\]$/m);
  assert.ok(lock.includes(`name = "limbic-critic"\nversion = "${lab.LIMBIC_CRITIC_VERSION}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${lab.LIMBIC_CRITIC_CHECKSUM}"`));
  assert.ok(lock.includes(`name = "plasticity-lab"\nversion = "${lab.PLASTICITY_LAB_CRATE_VERSION}"\nsource = "git+${lab.PLASTICITY_LAB_REPOSITORY}.git?rev=${lab.PLASTICITY_LAB_REVISION}#${lab.PLASTICITY_LAB_REVISION}"`));
  assert.ok(lock.includes(`name = "neuromod"\nversion = "${lab.NEUROMOD_VERSION}"`));
  assert.equal(lock.split('name = "neuromod"\n').length - 1, 1, 'one neuromod for the homepage adapter and plasticity-lab');
  assert.equal(lab.PLASTICITY_GOLDEN_PATH, GOLDEN_PATH);
  assert.equal(lab.PLASTICITY_WASM_MODULE_URL, '/wasm/neuromorphic-adapter-labs/neuromorphic_adapter.js');
});

test('a queued reward applies to exactly the next step, whichever control takes it', async () => {
  const queue = lab.createRewardInputQueue();
  const session = await freshSession();
  try {
    // Reward clicked while running, then a manual Step before the next tick:
    // the Step carries the reward, and the following tick carries nothing.
    queue.queue('reward');
    assert.equal(queue.pending(), 'reward');
    const manual = lab.stepWithRewardInput(session, 'A', queue);
    assert.equal(manual.event, 'reward');
    assert.deepEqual(Array.from(manual.modulators), [1, 0, 0, 0]);
    assert.equal(queue.pending(), 'none');
    const tick = lab.stepWithRewardInput(session, 'A', queue);
    assert.equal(tick.event, 'none');
    assert.deepEqual(Array.from(tick.modulators), [0, 0, 0, 0]);

    // A later click before the step replaces the queued one.
    queue.queue('reward');
    queue.queue('penalty');
    assert.equal(lab.stepWithRewardInput(session, 'quiet', queue).event, 'penalty');
    assert.equal(lab.stepWithRewardInput(session, 'quiet', queue).event, 'none');

    // Cleared input (Reset, New episode, scripted session) never lands.
    queue.queue('reward');
    queue.clear();
    assert.equal(lab.stepWithRewardInput(session, 'quiet', queue).event, 'none');
    assert.throws(() => queue.queue('bonus'), RangeError);
  } finally {
    session.dispose();
  }
});

test('modulator history and the spike raster are separate, bounded rings', async () => {
  const history = lab.createModulatorHistory(4, 2);
  const raster = lab.createPlasticityRaster();
  assert.equal(raster.capacity, lab.PLASTICITY_HISTORY_STEPS);
  const session = await freshSession();
  try {
    const events = ['none', 'reward', 'none', 'penalty', 'none', 'reward'];
    for (const event of events) {
      const view = session.step('A', event);
      history.record(view);
      lab.recordPlasticitySpikes(raster, view, session.channels, session.neurons);
    }
  } finally {
    session.dispose();
  }
  assert.equal(history.size(), 4);
  const steps = [];
  history.forEach((row, column) => steps.push([row.step, column]));
  assert.deepEqual(steps, [[3n, 0], [4n, 1], [5n, 2], [6n, 3]]);
  assert.deepEqual(history.events().map((row) => [row.step, row.event]), [[6n, 'reward'], [4n, 'penalty']]);
  assert.deepEqual(history.latest().modulators, [1, 0, 0, 0]);
  assert.equal(raster.size(), 6);
  assert.equal(raster.neuronCount(), 6, 'four input rows plus two LIF rows');
  assert.equal(raster.spiked(1n, 4), true, 'LIF neuron 0 fires while pattern A is on');
  history.reset();
  assert.equal(history.size(), 0);
  assert.throws(() => lab.createModulatorHistory(0), RangeError);
});
