/**
 * Reward-modulated learning lab (`/labs/plasticity/`, GitHub #17 / RM-1654).
 *
 * DOM-free half of the lab: the committed golden's shape, the bridge to the
 * `WasmPlasticityLab` export of the labs adapter package, the golden replay
 * check, and the bounded per-step history the view draws from.
 *
 * Nothing here computes a learning value. `limbic-critic` maps reward input
 * to modulators, `plasticity-lab` steps `neuromod` with them, and `neuromod`
 * owns spikes, eligibility traces, and weight changes, all inside Rust/WASM.
 * This module copies those results out of WASM and compares them with the
 * golden the adapter's native Rust test generated.
 */

import { createSpikeRaster, type SpikeRaster } from './demo-telemetry';
import { LIVE_SPIKE_EVENT_PROVENANCE } from './spike-events';

/**
 * The labs build of the adapter (`--features nir,protocol,plasticity`). The
 * homepage loads the lean default package at `/wasm/neuromorphic-adapter/`,
 * which does not contain `WasmPlasticityLab`.
 */
export const PLASTICITY_WASM_MODULE_URL = '/wasm/neuromorphic-adapter-labs/neuromorphic_adapter.js';
export const PLASTICITY_GOLDEN_FORMAT = 'shipoftheseus.plasticity-session';
export const PLASTICITY_GOLDEN_VERSION = 1;
/** Mirrors `PLASTICITY_LAB_VERSION`; the package's `lab_version` is authoritative. */
export const PLASTICITY_LAB_VERSION = 1;
/** Steps the raster and the modulator strip keep. */
export const PLASTICITY_HISTORY_STEPS = 48;
/** Reward and penalty events the event log keeps. */
export const PLASTICITY_EVENT_LOG_LIMIT = 8;
/** Interactive run cadence, and the cap under `prefers-reduced-motion`. */
export const PLASTICITY_RUN_HZ = 4;
export const PLASTICITY_REDUCED_MOTION_RUN_HZ = 1;

/**
 * Locked upstream surfaces, shown as provenance. `test/plasticity-lab.test.mjs`
 * checks them against `crates/neuromorphic-adapter/Cargo.toml` and `Cargo.lock`.
 */
export const LIMBIC_CRITIC_VERSION = '0.3.0';
export const LIMBIC_CRITIC_CHECKSUM = '0afb84406e35b755770254f4418c4b7b92b79c089f10e5c671b9ae2016a79329';
export const PLASTICITY_LAB_REPOSITORY = 'https://github.com/Limen-Neural/plasticity-lab';
export const PLASTICITY_LAB_REVISION = 'c80fac2eb96a140df9cfd999278bce414a329a56';
export const PLASTICITY_LAB_CRATE_VERSION = '0.2.1';
export const NEUROMOD_VERSION = '0.7.0';
export const PLASTICITY_GOLDEN_PATH = 'src/data/plasticity/scripted-session.v1.json';

export const STIMULUS_NAMES = ['quiet', 'A', 'B'] as const;
export type StimulusName = (typeof STIMULUS_NAMES)[number];
export const REWARD_EVENT_NAMES = ['none', 'reward', 'penalty'] as const;
export type RewardEventName = (typeof REWARD_EVENT_NAMES)[number];
/** Modulator order in every vector the adapter returns. */
export const MODULATOR_NAMES = ['dopamine', 'serotonin', 'acetylcholine', 'norepinephrine'] as const;

export function stimulusCode(name: StimulusName): number {
  return STIMULUS_NAMES.indexOf(name);
}

export function rewardEventCode(name: RewardEventName): number {
  return REWARD_EVENT_NAMES.indexOf(name);
}

export function isStimulusName(value: unknown): value is StimulusName {
  return typeof value === 'string' && (STIMULUS_NAMES as readonly string[]).includes(value);
}

export function isRewardEventName(value: unknown): value is RewardEventName {
  return typeof value === 'string' && (REWARD_EVENT_NAMES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// f32 bits
// ---------------------------------------------------------------------------

const bitsView = new DataView(new ArrayBuffer(4));

/** The `f32` a golden bit pattern encodes, widened to a JS number. */
export function f32FromBits(bits: number): number {
  bitsView.setUint32(0, bits >>> 0);
  return bitsView.getFloat32(0);
}

/** The bit pattern of `value` rounded to `f32`. */
export function bitsFromF32(value: number): number {
  bitsView.setFloat32(0, value);
  return bitsView.getUint32(0);
}

/**
 * `neuromod` renormalizes each neuron's weights to its L1 budget after every
 * training step. When the budget already holds this changes nothing, but
 * float rounding can move a weight by about one unit in the last place
 * (~6e-8). The view reports magnitudes so such a step never reads as
 * learning; this is the bound the tests use for "rounding only".
 */
export const RENORMALIZATION_ROUNDING = 1e-6;

/** Largest `|after − before|` in flattened `[neuron, channel, before, after]` rows. */
export function largestChange(rows: ArrayLike<number>): number {
  let largest = 0;
  for (let index = 0; index + 3 < rows.length; index += 4) {
    largest = Math.max(largest, Math.abs(f32FromBits(rows[index + 3]) - f32FromBits(rows[index + 2])));
  }
  return largest;
}

export function largestWeightChange(view: Pick<PlasticityStepView, 'weightChanges'>): number {
  return largestChange(view.weightChanges);
}

export function largestGoldenWeightChange(step: Pick<PlasticityGoldenStep, 'weight_changes'>): number {
  return largestChange(step.weight_changes.flat());
}

// ---------------------------------------------------------------------------
// Display text, shared by the build-time render and the live view
// ---------------------------------------------------------------------------

export const STIMULUS_LABELS: Record<StimulusName, string> = {
  quiet: 'Quiet',
  A: 'Pattern A',
  B: 'Pattern B',
};

export const REWARD_EVENT_LABELS: Record<RewardEventName, string> = {
  none: '—',
  reward: 'Reward',
  penalty: 'Penalty',
};

export function formatWeight(value: number): string {
  return value.toFixed(4);
}

export function formatSignedDelta(value: number): string {
  const rounded = Number(value.toFixed(4));
  if (rounded === 0) return '±0.0000';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toFixed(4)}`;
}

export function formatModulator(value: number): string {
  return value.toFixed(2);
}

export function formatSpikeList(prefix: string, indices: ArrayLike<number>): string {
  return indices.length === 0 ? 'none' : Array.from(indices, (index) => `${prefix}${index}`).join(' ');
}

/** "8 weights · largest |Δw| 0.0190", or a rounding-only / no-change note. */
export function formatWeightChangeSummary(count: number, largest: number): string {
  if (count === 0) return 'no weight changed';
  const noun = count === 1 ? 'weight' : 'weights';
  if (largest <= RENORMALIZATION_ROUNDING) {
    return `${count} ${noun} moved by float rounding only (largest |Δw| ${largest.toExponential(1)})`;
  }
  return `${count} ${noun} · largest |Δw| ${largest.toFixed(4)}`;
}

// ---------------------------------------------------------------------------
// Golden
// ---------------------------------------------------------------------------

/** `[neuron, channel, before_bits, after_bits]`. */
export type WeightChangeRow = readonly [number, number, number, number];

export interface PlasticityGoldenStep {
  step: number;
  episode: number;
  new_episode: boolean;
  stimulus: StimulusName;
  event: RewardEventName;
  objective_bits: number;
  stress_bits: number;
  modulator_bits: number[];
  input_spikes: number[];
  output_spikes: number[];
  membrane_bits: number[];
  threshold_bits: number[];
  weight_changes: WeightChangeRow[];
}

export interface PlasticityGoldenProbe {
  pattern_a_spikes: number[];
  pattern_b_spikes: number[];
}

export interface PlasticityGoldenNetwork {
  lif_neurons: number;
  channels: number;
  initial_weight_bits: number;
  initial_threshold_bits: number;
  tau_eligibility_bits: number;
  reward_lr_bits: number;
  training_amplitude_bits: number;
  probe_amplitude_bits: number;
  probe_steps: number;
  probe_stream: string;
}

export interface PlasticityGolden {
  format: string;
  format_version: number;
  lab_version: number;
  generator: string;
  regenerate: string;
  seed: string;
  network: PlasticityGoldenNetwork;
  probe_before: PlasticityGoldenProbe;
  steps: PlasticityGoldenStep[];
  final_weight_bits: number[];
  final_threshold_bits: number[];
  final_eligibility_bits: number[];
  probe_after: PlasticityGoldenProbe;
}

export class PlasticityLabUnavailableError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PlasticityLabUnavailableError';
    this.code = code;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
const isBits = (value: unknown): value is number => isCount(value) && (value as number) <= 0xffffffff;
const isCountArray = (value: unknown, length?: number): value is number[] =>
  Array.isArray(value) && value.every(isCount) && (length === undefined || value.length === length);
const isBitsArray = (value: unknown, length?: number): value is number[] =>
  Array.isArray(value) && value.every(isBits) && (length === undefined || value.length === length);

function isProbe(value: unknown, neurons: number): value is PlasticityGoldenProbe {
  return isObject(value) && isCountArray(value.pattern_a_spikes, neurons) && isCountArray(value.pattern_b_spikes, neurons);
}

function isWeightChange(value: unknown, neurons: number, channels: number): value is WeightChangeRow {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    isCount(value[0]) &&
    value[0] < neurons &&
    isCount(value[1]) &&
    value[1] < channels &&
    isBits(value[2]) &&
    isBits(value[3])
  );
}

function isGoldenStep(value: unknown, neurons: number, channels: number): value is PlasticityGoldenStep {
  if (!isObject(value)) return false;
  return (
    isCount(value.step) &&
    isCount(value.episode) &&
    typeof value.new_episode === 'boolean' &&
    isStimulusName(value.stimulus) &&
    isRewardEventName(value.event) &&
    isBits(value.objective_bits) &&
    isBits(value.stress_bits) &&
    isBitsArray(value.modulator_bits, MODULATOR_NAMES.length) &&
    isCountArray(value.input_spikes) &&
    value.input_spikes.every((channel) => channel < channels) &&
    isCountArray(value.output_spikes) &&
    value.output_spikes.every((neuron) => neuron < neurons) &&
    isBitsArray(value.membrane_bits, neurons) &&
    isBitsArray(value.threshold_bits, neurons) &&
    Array.isArray(value.weight_changes) &&
    value.weight_changes.every((change) => isWeightChange(change, neurons, channels))
  );
}

/**
 * Structural check of the committed golden. Throws on any surprise so a
 * malformed file can never be rendered as if it were a recorded session.
 */
export function parsePlasticityGolden(value: unknown): PlasticityGolden {
  const fail = (reason: string): never => {
    throw new PlasticityLabUnavailableError('invalid-golden', `The plasticity golden is malformed: ${reason}.`);
  };
  if (!isObject(value)) return fail('not an object');
  if (value.format !== PLASTICITY_GOLDEN_FORMAT || value.format_version !== PLASTICITY_GOLDEN_VERSION) {
    return fail('unsupported format or version');
  }
  if (value.lab_version !== PLASTICITY_LAB_VERSION) return fail('unsupported lab version');
  if (typeof value.generator !== 'string' || typeof value.regenerate !== 'string') return fail('missing generator');
  if (typeof value.seed !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value.seed) || BigInt(value.seed) > 0xffffffffffffffffn) {
    return fail('seed is not a u64 decimal string');
  }
  const network = value.network;
  if (
    !isObject(network) ||
    !isCount(network.lif_neurons) ||
    network.lif_neurons < 1 ||
    !isCount(network.channels) ||
    network.channels < 1 ||
    !isBits(network.initial_weight_bits) ||
    !isBits(network.initial_threshold_bits) ||
    !isBits(network.tau_eligibility_bits) ||
    !isBits(network.reward_lr_bits) ||
    !isBits(network.training_amplitude_bits) ||
    !isBits(network.probe_amplitude_bits) ||
    !isCount(network.probe_steps) ||
    typeof network.probe_stream !== 'string'
  ) {
    return fail('network description');
  }
  const neurons = network.lif_neurons;
  const channels = network.channels;
  if (!isProbe(value.probe_before, neurons) || !isProbe(value.probe_after, neurons)) return fail('probe counts');
  if (!Array.isArray(value.steps) || value.steps.length === 0) return fail('no steps');
  value.steps.forEach((step, index) => {
    if (!isGoldenStep(step, neurons, channels) || step.step !== index + 1) fail(`step ${index + 1}`);
  });
  if (
    !isBitsArray(value.final_weight_bits, neurons * channels) ||
    !isBitsArray(value.final_threshold_bits, neurons) ||
    !isBitsArray(value.final_eligibility_bits, neurons * channels)
  ) {
    return fail('final state');
  }
  return value as unknown as PlasticityGolden;
}

/**
 * Decode the golden the page embedded as a JSON string literal. `JSON.parse`
 * only decodes data, and the result goes through `parsePlasticityGolden`.
 */
export function decodeEmbeddedGolden(embedded: string | null): PlasticityGolden {
  let text: unknown;
  let value: unknown;
  try {
    text = JSON.parse(embedded ?? '');
    if (typeof text !== 'string') throw new Error('not a string literal');
    value = JSON.parse(text);
  } catch (error) {
    throw new PlasticityLabUnavailableError('invalid-golden', errorMessage(error));
  }
  return parsePlasticityGolden(value);
}

// ---------------------------------------------------------------------------
// WASM bridge
// ---------------------------------------------------------------------------

export interface WasmPlasticityStepHandle {
  readonly step: bigint;
  readonly episode: number;
  readonly stimulus: string;
  readonly event: string;
  readonly objective: number;
  readonly stress: number;
  readonly modulators: Float32Array;
  readonly input_spikes: Uint32Array;
  readonly output_spikes: Uint32Array;
  readonly membrane_potentials: Float32Array;
  readonly thresholds: Float32Array;
  readonly weight_changes: Uint32Array;
  free(): void;
}

export interface WasmPlasticityProbeHandle {
  readonly steps_per_pattern: number;
  readonly pattern_a_spikes: Uint32Array;
  readonly pattern_b_spikes: Uint32Array;
  free(): void;
}

export interface WasmPlasticityLabHandle {
  readonly lab_version: number;
  readonly neuron_count: number;
  readonly channel_count: number;
  readonly seed: bigint;
  readonly completed_steps: bigint;
  readonly episode: number;
  readonly engine_step: bigint;
  readonly weights: Float32Array;
  readonly eligibility: Float32Array;
  readonly thresholds: Float32Array;
  readonly membrane_potentials: Float32Array;
  readonly modulators: Float32Array;
  step(stimulus: number, event: number): WasmPlasticityStepHandle;
  newEpisode(): void;
  probe(): WasmPlasticityProbeHandle;
  free(): void;
}

export interface PlasticityWasmModule {
  default: (input?: unknown) => Promise<unknown>;
  WasmPlasticityLab: { create(seed: bigint): WasmPlasticityLabHandle };
}

/** One step, copied out of WASM into JS-owned arrays. */
export interface PlasticityStepView {
  step: bigint;
  episode: number;
  stimulus: StimulusName;
  event: RewardEventName;
  objective: number;
  stress: number;
  /** Dopamine, serotonin, acetylcholine, norepinephrine (`limbic-critic`). */
  modulators: Float32Array;
  inputSpikes: Uint32Array;
  outputSpikes: Uint32Array;
  membranePotentials: Float32Array;
  thresholds: Float32Array;
  /** Flattened `[neuron, channel, before_bits, after_bits]` rows. */
  weightChanges: Uint32Array;
}

export interface PlasticityProbeView {
  stepsPerPattern: number;
  patternA: Uint32Array;
  patternB: Uint32Array;
}

export interface PlasticityStateView {
  completedSteps: bigint;
  episode: number;
  engineStep: bigint;
  weights: Float32Array;
  eligibility: Float32Array;
  thresholds: Float32Array;
  membranePotentials: Float32Array;
  modulators: Float32Array;
}

export interface PlasticitySession {
  readonly seed: bigint;
  readonly neurons: number;
  readonly channels: number;
  step: (stimulus: StimulusName, event: RewardEventName) => PlasticityStepView;
  newEpisode: () => void;
  probe: () => PlasticityProbeView;
  state: () => PlasticityStateView;
  dispose: () => void;
}

/**
 * The reward input waiting for the next step. There is one slot: a reward or
 * penalty clicked while the lab runs applies to exactly the next step,
 * whether Run or Step advances it, and a later click replaces it. The view
 * clears it on Reset, New episode, and the scripted session, because the step
 * it was meant for no longer comes.
 */
export interface RewardInputQueue {
  /** Queue `event` for the next step, replacing anything already queued. */
  queue: (event: RewardEventName) => void;
  /** The queued event, or `none` (does not consume it). */
  pending: () => RewardEventName;
  /** Consume the queued event for the step about to run (`none` if empty). */
  take: () => RewardEventName;
  clear: () => void;
}

export function createRewardInputQueue(): RewardInputQueue {
  let queued: RewardEventName = 'none';
  return {
    queue(event) {
      if (!isRewardEventName(event)) throw new RangeError(`unknown reward input ${String(event)}`);
      queued = event;
    },
    pending: () => queued,
    take() {
      const event = queued;
      queued = 'none';
      return event;
    },
    clear() {
      queued = 'none';
    },
  };
}

/**
 * Advance `session` by one step of `stimulus`, consuming the queued reward
 * input. Every step the lab takes goes through here, so a queued event can
 * neither be skipped by a manual Step nor land on a later step.
 */
export function stepWithRewardInput(
  session: PlasticitySession,
  stimulus: StimulusName,
  rewardInput: RewardInputQueue,
): PlasticityStepView {
  return session.step(stimulus, rewardInput.take());
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  // wasm-bindgen surfaces Rust errors as thrown JavaScript strings.
  if (typeof error === 'string') return error;
  return 'unexpected non-error exception';
}

/** `"<code>: <message>"` from the adapter, or a generic code. */
export function plasticityErrorCode(error: unknown): string {
  if (error instanceof PlasticityLabUnavailableError) return error.code;
  const match = /^(plasticity-[a-z-]+):/.exec(errorMessage(error));
  return match ? match[1] : 'plasticity-step-failed';
}

/** A fresh session over a new `WasmPlasticityLab`, which this owns. */
export function createPlasticitySession(module: PlasticityWasmModule, seed: bigint): PlasticitySession {
  const handle = module.WasmPlasticityLab.create(seed);
  if (handle.lab_version !== PLASTICITY_LAB_VERSION) {
    handle.free();
    throw new PlasticityLabUnavailableError('lab-version-mismatch', 'The labs package runs a different plasticity lab version.');
  }
  let disposed = false;
  const live = () => {
    if (disposed) throw new PlasticityLabUnavailableError('disposed', 'The plasticity session has been disposed.');
    return handle;
  };
  return {
    seed: handle.seed,
    neurons: handle.neuron_count,
    channels: handle.channel_count,
    step(stimulus, event) {
      const result = live().step(stimulusCode(stimulus), rewardEventCode(event));
      try {
        const stepStimulus = result.stimulus;
        const stepEvent = result.event;
        if (!isStimulusName(stepStimulus) || !isRewardEventName(stepEvent)) {
          throw new PlasticityLabUnavailableError('invalid-step', 'The Rust/WASM step is malformed.');
        }
        return {
          step: result.step,
          episode: result.episode,
          stimulus: stepStimulus,
          event: stepEvent,
          objective: result.objective,
          stress: result.stress,
          modulators: result.modulators,
          inputSpikes: result.input_spikes,
          outputSpikes: result.output_spikes,
          membranePotentials: result.membrane_potentials,
          thresholds: result.thresholds,
          weightChanges: result.weight_changes,
        };
      } finally {
        result.free();
      }
    },
    newEpisode() {
      live().newEpisode();
    },
    probe() {
      const result = live().probe();
      try {
        return {
          stepsPerPattern: result.steps_per_pattern,
          patternA: result.pattern_a_spikes,
          patternB: result.pattern_b_spikes,
        };
      } finally {
        result.free();
      }
    },
    state() {
      const lab = live();
      return {
        completedSteps: lab.completed_steps,
        episode: lab.episode,
        engineStep: lab.engine_step,
        weights: lab.weights,
        eligibility: lab.eligibility,
        thresholds: lab.thresholds,
        membranePotentials: lab.membrane_potentials,
        modulators: lab.modulators,
      };
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        handle.free();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Golden replay
// ---------------------------------------------------------------------------

export interface GoldenMismatch {
  /** 1-based step, or `null` for the probes and final state. */
  step: number | null;
  field: string;
}

const sameBits = (actual: ArrayLike<number>, expected: readonly number[]): boolean =>
  actual.length === expected.length && expected.every((bits, index) => bitsFromF32(actual[index]) === bits);
const sameIntegers = (actual: ArrayLike<number>, expected: readonly number[]): boolean =>
  actual.length === expected.length && expected.every((value, index) => actual[index] === value);

/** The first field of `view` that differs from `golden`, or `null`. */
export function compareStepWithGolden(view: PlasticityStepView, golden: PlasticityGoldenStep): GoldenMismatch | null {
  const at = (field: string): GoldenMismatch => ({ step: golden.step, field });
  if (view.step !== BigInt(golden.step)) return at('step');
  if (view.episode !== golden.episode) return at('episode');
  if (view.stimulus !== golden.stimulus) return at('stimulus');
  if (view.event !== golden.event) return at('event');
  if (bitsFromF32(view.objective) !== golden.objective_bits) return at('objective');
  if (bitsFromF32(view.stress) !== golden.stress_bits) return at('stress');
  if (!sameBits(view.modulators, golden.modulator_bits)) return at('modulators');
  if (!sameIntegers(view.inputSpikes, golden.input_spikes)) return at('input spikes');
  if (!sameIntegers(view.outputSpikes, golden.output_spikes)) return at('output spikes');
  if (!sameBits(view.membranePotentials, golden.membrane_bits)) return at('membrane potentials');
  if (!sameBits(view.thresholds, golden.threshold_bits)) return at('thresholds');
  if (!sameIntegers(view.weightChanges, golden.weight_changes.flat())) return at('weight changes');
  return null;
}

function compareProbe(view: PlasticityProbeView, golden: PlasticityGoldenProbe, label: string): GoldenMismatch | null {
  return sameIntegers(view.patternA, golden.pattern_a_spikes) && sameIntegers(view.patternB, golden.pattern_b_spikes)
    ? null
    : { step: null, field: label };
}

export interface GoldenReplay {
  steps: PlasticityStepView[];
  probeBefore: PlasticityProbeView;
  probeAfter: PlasticityProbeView | null;
  /** The first difference from the golden, or `null` when every value matches. */
  mismatch: GoldenMismatch | null;
}

/**
 * Replay the golden's script on `session`, which must be fresh and seeded
 * with the golden seed. Every step is compared as it runs; replay stops at
 * the first mismatch. `onStep` sees each step before it is compared.
 */
export function replayGolden(
  session: PlasticitySession,
  golden: PlasticityGolden,
  onStep?: (view: PlasticityStepView) => void,
): GoldenReplay {
  if (session.seed !== BigInt(golden.seed)) {
    throw new PlasticityLabUnavailableError('seed-mismatch', 'The session is not seeded with the golden seed.');
  }
  const steps: PlasticityStepView[] = [];
  const probeBefore = session.probe();
  const first = compareProbe(probeBefore, golden.probe_before, 'probe before');
  if (first) return { steps, probeBefore, probeAfter: null, mismatch: first };
  for (const expected of golden.steps) {
    if (expected.new_episode) session.newEpisode();
    const view = session.step(expected.stimulus, expected.event);
    steps.push(view);
    onStep?.(view);
    const mismatch = compareStepWithGolden(view, expected);
    if (mismatch) return { steps, probeBefore, probeAfter: null, mismatch };
  }
  const state = session.state();
  let mismatch: GoldenMismatch | null = null;
  if (!sameBits(state.weights, golden.final_weight_bits)) mismatch = { step: null, field: 'final weights' };
  else if (!sameBits(state.thresholds, golden.final_threshold_bits)) mismatch = { step: null, field: 'final thresholds' };
  else if (!sameBits(state.eligibility, golden.final_eligibility_bits)) mismatch = { step: null, field: 'final eligibility traces' };
  const probeAfter = session.probe();
  mismatch ??= compareProbe(probeAfter, golden.probe_after, 'probe after');
  return { steps, probeBefore, probeAfter, mismatch };
}

// ---------------------------------------------------------------------------
// Bounded histories: modulators and spikes are kept apart
// ---------------------------------------------------------------------------

/** One step of reward input and `limbic-critic` output. */
export interface ModulatorHistoryRow {
  step: bigint;
  episode: number;
  stimulus: StimulusName;
  event: RewardEventName;
  objective: number;
  stress: number;
  /** Dopamine, serotonin, acetylcholine, norepinephrine. */
  modulators: readonly [number, number, number, number];
}

export interface ModulatorHistory {
  readonly capacity: number;
  record: (view: PlasticityStepView) => void;
  size: () => number;
  /** Rows oldest first, with their column in the ring window. */
  forEach: (visit: (row: ModulatorHistoryRow, column: number) => void) => void;
  latest: () => ModulatorHistoryRow | null;
  /** The most recent reward and penalty steps, newest first. */
  events: () => ModulatorHistoryRow[];
  reset: () => void;
}

/**
 * The reward/modulator side of the lab: a fixed ring of the latest steps'
 * reward input and `limbic-critic` vectors, plus a fixed list of the latest
 * reward and penalty steps. Spikes never enter it; they go to the spike
 * raster (`recordPlasticitySpikes`). Memory stays constant however long a
 * session runs.
 */
export function createModulatorHistory(
  capacity = PLASTICITY_HISTORY_STEPS,
  eventLimit = PLASTICITY_EVENT_LOG_LIMIT,
): ModulatorHistory {
  if (!Number.isInteger(capacity) || capacity < 1 || !Number.isInteger(eventLimit) || eventLimit < 1) {
    throw new RangeError('modulator history sizes must be positive integers');
  }
  const rows: (ModulatorHistoryRow | null)[] = new Array(capacity).fill(null);
  let head = 0;
  let size = 0;
  let events: ModulatorHistoryRow[] = [];
  return {
    capacity,
    record(view) {
      if (view.modulators.length !== MODULATOR_NAMES.length) {
        throw new RangeError('a modulator vector has four entries');
      }
      const row: ModulatorHistoryRow = {
        step: view.step,
        episode: view.episode,
        stimulus: view.stimulus,
        event: view.event,
        objective: view.objective,
        stress: view.stress,
        modulators: [view.modulators[0], view.modulators[1], view.modulators[2], view.modulators[3]],
      };
      rows[(head + size) % capacity] = row;
      if (size < capacity) size += 1;
      else head = (head + 1) % capacity;
      if (view.event !== 'none') {
        events = [row, ...events].slice(0, eventLimit);
      }
    },
    size: () => size,
    forEach(visit) {
      for (let offset = 0; offset < size; offset += 1) {
        const row = rows[(head + offset) % capacity];
        if (row) visit(row, offset);
      }
    },
    latest: () => (size === 0 ? null : rows[(head + size - 1) % capacity]),
    events: () => events.slice(),
    reset() {
      rows.fill(null);
      head = 0;
      size = 0;
      events = [];
    },
  };
}

/** Raster scope for the lab; the telemetry ring uses it to detect restarts. */
export const PLASTICITY_RASTER_SCOPE = `plasticity-lab-v${PLASTICITY_LAB_VERSION}`;

/** Raster rows: input channels first, then LIF neurons. */
export function plasticityRasterRows(channels: number, neurons: number): Uint32Array {
  return Uint32Array.from({ length: channels + neurons }, (_, index) => index);
}

/** A spike raster (the telemetry panel's bounded ring) sized for the lab's window. */
export function createPlasticityRaster(): SpikeRaster {
  return createSpikeRaster({ provenance: LIVE_SPIKE_EVENT_PROVENANCE, steps: PLASTICITY_HISTORY_STEPS });
}

/**
 * Record one step's `neuromod` spikes into the shared telemetry raster ring.
 * Input-channel Bernoulli spikes take rows `0..channels`, LIF spikes the rows
 * after them. The ring's per-step lane counts the input spikes.
 */
export function recordPlasticitySpikes(
  raster: SpikeRaster,
  view: PlasticityStepView,
  channels: number,
  neurons: number,
): void {
  const rows = plasticityRasterRows(channels, neurons);
  const spikeNeurons = [...view.inputSpikes, ...Array.from(view.outputSpikes, (neuron) => channels + neuron)];
  raster.record(
    { provenance: LIVE_SPIKE_EVENT_PROVENANCE, step: view.step, topologyDigest: PLASTICITY_RASTER_SCOPE, spikeNeurons },
    {
      completedStep: view.step,
      topologyDigest: PLASTICITY_RASTER_SCOPE,
      topologyNodeIds: rows,
      encodedSpikeCount: view.inputSpikes.length,
    },
  );
}

