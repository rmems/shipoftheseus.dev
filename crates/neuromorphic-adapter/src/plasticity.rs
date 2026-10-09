//! Reward-modulated learning lab (`/labs/plasticity/`, GitHub #17 / RM-1654).
//!
//! The adapter composes three upstream crates and owns no learning rule:
//!
//! - **`limbic-critic`** maps a reward or penalty observation to a
//!   [`ModulatorVector`] with its stateless [`SimpleCritic`]. It is a
//!   reward-shaping / modulator-mapping primitive, not an actor-critic and not
//!   a learned value function.
//! - **`plasticity-lab`** converts that vector into `neuromod` modulators
//!   through its `bridge` module (`critic` feature), advances each training
//!   step with [`PlasticityTrainer::train_step_with_modulators_and_rng`], and
//!   runs the held-out probe as plasticity-frozen evaluation with
//!   [`PlasticityTrainer::run_eval_with_rng`].
//! - **`neuromod`** owns the network, its LIF dynamics, lateral inhibition,
//!   per-synapse eligibility traces, dopamine-gated reward-modulated STDP, L1
//!   weight renormalization, and modulator-driven threshold and leak retuning.
//!
//! This module only chooses the network shape and initial values (through
//! `neuromod`'s public API), builds stimulus vectors for two fixed input
//! patterns, implements `limbic-critic`'s `Environment` trait for the reward
//! buttons, and reads state back for display. Every value it returns comes
//! from those crates.
//!
//! Determinism: one caller-seeded [`StdRng`] drives every training step; the
//! probe uses a second, independent stream derived from the same seed and a
//! fresh copy of the network, so probing never changes the session.

use limbic_critic::{Environment, ModulatorVector, SimpleCritic};
use neuromod::{NeuroModulators, RmStdpConfig, SeedableRng, SpikingNetwork, StdRng};
use plasticity_lab::{EvaluationExample, PlasticityTrainer, TrainingConfig, to_neuromodulators};
use wasm_bindgen::prelude::*;

/// Version of this lab's configuration and step semantics. Any change that
/// alters what a seed and script produce bumps it and regenerates the golden.
pub const PLASTICITY_LAB_VERSION: u32 = 1;
/// LIF neurons in the lab network (no Izhikevich bank).
pub const LAB_NEURONS: usize = 2;
/// Input channels. Pattern A drives channels 0–1, pattern B drives 2–3.
pub const LAB_CHANNELS: usize = 4;
/// Equal-share initial weight: `neuromod`'s L1 budget (2.0) over four channels,
/// the initialization upstream documents for `with_dimensions` networks.
pub const INITIAL_WEIGHT: f32 = 0.5;
/// Initial LIF threshold, as in `plasticity-lab`'s delayed-association test.
pub const INITIAL_THRESHOLD: f32 = 0.12;
/// R-STDP eligibility time constant (steps), as in that test.
pub const TAU_ELIGIBILITY: f32 = 100.0;
/// R-STDP trace-to-weight learning rate, as in that test.
pub const REWARD_LR: f32 = 8.0;
/// Stimulus amplitude while a pattern is presented during training.
pub const TRAINING_AMPLITUDE: f32 = 0.8;
/// Stimulus amplitude during the frozen probe, low enough not to saturate.
pub const PROBE_AMPLITUDE: f32 = 0.15;
/// Frozen evaluation steps per pattern in one probe.
pub const PROBE_STEPS: usize = 6;
/// XOR applied to the session seed for the probe's independent RNG stream.
pub const PROBE_STREAM: u64 = 0xE7A1_0000;

/// What the lab presents on its four input channels for one step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Stimulus {
    Quiet = 0,
    PatternA = 1,
    PatternB = 2,
}

impl Stimulus {
    pub fn parse(value: u8) -> Result<Self, String> {
        match value {
            0 => Ok(Self::Quiet),
            1 => Ok(Self::PatternA),
            2 => Ok(Self::PatternB),
            other => Err(format!(
                "plasticity-stimulus-invalid: stimulus {other} is not 0 (quiet), 1 (A), or 2 (B)"
            )),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Quiet => "quiet",
            Self::PatternA => "A",
            Self::PatternB => "B",
        }
    }

    /// The stimulus vector at `amplitude`: zeros except the pattern's channels.
    pub fn vector(self, amplitude: f32) -> [f32; LAB_CHANNELS] {
        let mut stimuli = [0.0; LAB_CHANNELS];
        let channels = match self {
            Self::Quiet => 0..0,
            Self::PatternA => 0..2,
            Self::PatternB => 2..4,
        };
        for channel in channels {
            stimuli[channel] = amplitude;
        }
        stimuli
    }
}

/// The reward input applied with one step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum RewardEvent {
    None = 0,
    Reward = 1,
    Penalty = 2,
}

impl RewardEvent {
    pub fn parse(value: u8) -> Result<Self, String> {
        match value {
            0 => Ok(Self::None),
            1 => Ok(Self::Reward),
            2 => Ok(Self::Penalty),
            other => Err(format!(
                "plasticity-event-invalid: event {other} is not 0 (none), 1 (reward), or 2 (penalty)"
            )),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Reward => "reward",
            Self::Penalty => "penalty",
        }
    }

    /// The observation `limbic-critic` assesses for this event.
    pub fn observation(self) -> LabObservation {
        match self {
            Self::None => LabObservation {
                objective: 0.0,
                stress: 0.0,
            },
            Self::Reward => LabObservation {
                objective: 1.0,
                stress: 0.0,
            },
            Self::Penalty => LabObservation {
                objective: -1.0,
                stress: 1.0,
            },
        }
    }
}

/// The lab's `limbic-critic` environment: the reward buttons report an
/// objective (+1 reward, −1 penalty) and a penalty also reports stress.
/// Volatility and surprise keep the trait's `0.0` defaults.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LabObservation {
    pub objective: f32,
    pub stress: f32,
}

impl Environment for LabObservation {
    fn objective(&self) -> f32 {
        self.objective
    }

    fn stress(&self) -> f32 {
        self.stress
    }
}

/// One synapse whose weight changed during a step, as exact `f32` bits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WeightChange {
    pub neuron: u32,
    pub channel: u32,
    pub before_bits: u32,
    pub after_bits: u32,
}

/// Everything one training step produced, read back from the crates.
#[derive(Clone, Debug, PartialEq)]
pub struct LabStep {
    /// Lab steps completed, including this one (1-based).
    pub step: u64,
    /// Episode this step belongs to (1-based).
    pub episode: u32,
    pub stimulus: Stimulus,
    pub event: RewardEvent,
    /// The `limbic-critic` environment observation.
    pub observation: LabObservation,
    /// The `limbic-critic` output, which `plasticity-lab`'s bridge hands to
    /// `neuromod` unchanged (dopamine, serotonin, acetylcholine, norepinephrine).
    pub modulators: [f32; 4],
    /// Input channels whose `neuromod` Bernoulli trial fired on this step.
    pub input_spikes: Vec<u32>,
    /// LIF neurons that fired on this step.
    pub output_spikes: Vec<u32>,
    /// Membrane potentials after the step.
    pub membrane_potentials: Vec<f32>,
    /// Firing thresholds after the step.
    pub thresholds: Vec<f32>,
    /// Weights that changed on this step, neuron-major.
    pub weight_changes: Vec<WeightChange>,
}

/// Spike counts from one frozen probe (`PROBE_STEPS` per pattern).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LabProbe {
    pub pattern_a_spikes: Vec<u64>,
    pub pattern_b_spikes: Vec<u64>,
}

/// A seeded lab session over one `neuromod` network.
pub struct PlasticityLab {
    seed: u64,
    trainer: PlasticityTrainer,
    network: SpikingNetwork,
    rng: StdRng,
    completed_steps: u64,
    episode: u32,
    last_modulators: [f32; 4],
}

/// The lab network: two LIF neurons, four channels, R-STDP configured through
/// `neuromod`'s public API, equal-share weights, and the initial threshold.
fn build_lab_network() -> SpikingNetwork {
    let mut network = SpikingNetwork::with_dimensions(LAB_NEURONS, 0, LAB_CHANNELS);
    network.set_rm_stdp_config(RmStdpConfig {
        tau_eligibility: TAU_ELIGIBILITY,
        reward_lr: REWARD_LR,
        ..RmStdpConfig::default()
    });
    for neuron in &mut network.neurons {
        neuron.weights.fill(INITIAL_WEIGHT);
        neuron.threshold = INITIAL_THRESHOLD;
    }
    network
}

/// Field-by-field copy of a `neuromod` network (it has no `Clone`), used only
/// so the frozen probe never touches the training network.
fn copy_network(network: &SpikingNetwork) -> SpikingNetwork {
    SpikingNetwork {
        neurons: network.neurons.clone(),
        iz_neurons: network.iz_neurons.clone(),
        modulators: network.modulators,
        global_step: network.global_step,
        num_channels: network.num_channels,
        input_spike_times: network.input_spike_times.clone(),
        predictive_state: network.predictive_state.clone(),
        stdp_config: network.stdp_config,
    }
}

fn modulator_array(vector: &ModulatorVector) -> [f32; 4] {
    [
        vector.dopamine,
        vector.serotonin,
        vector.acetylcholine,
        vector.norepinephrine,
    ]
}

impl PlasticityLab {
    pub fn new(seed: u64) -> Self {
        Self {
            seed,
            // The scalar `RewardMapping` in `TrainingConfig` is not used: every
            // step passes explicit modulators from `limbic-critic`.
            trainer: PlasticityTrainer::new(TrainingConfig::default()),
            network: build_lab_network(),
            rng: StdRng::seed_from_u64(seed),
            completed_steps: 0,
            episode: 1,
            last_modulators: [0.0; 4],
        }
    }

    /// Present `stimulus` for one step with `event` as the reward input.
    ///
    /// `limbic-critic` assesses the event, `plasticity-lab`'s bridge converts
    /// its vector, and the trainer steps `neuromod` with the session RNG.
    /// Fails closed before any state changes if the critic or the step rejects
    /// the input.
    pub fn step(&mut self, stimulus: Stimulus, event: RewardEvent) -> Result<LabStep, String> {
        let observation = event.observation();
        let vector = SimpleCritic::try_assess(&observation)
            .map_err(|error| format!("plasticity-critic-rejected: {error}"))?;
        let modulators = to_neuromodulators(&vector);
        let stimuli = stimulus.vector(TRAINING_AMPLITUDE);
        let before = self.weights();

        let spikes = self
            .trainer
            .train_step_with_modulators_and_rng(
                &mut self.network,
                &stimuli,
                &modulators,
                &mut self.rng,
            )
            .map_err(|error| format!("plasticity-step-failed: {error}"))?;

        self.completed_steps += 1;
        self.last_modulators = modulator_array(&vector);
        let now = self.network.global_step;
        let input_spikes = (0..LAB_CHANNELS as u32)
            .filter(|channel| self.network.input_spike_times[*channel as usize] == now)
            .collect();
        let output_spikes = spikes
            .into_iter()
            .map(|neuron| neuron as u32)
            .collect::<Vec<_>>();
        let after = self.weights();
        let weight_changes = before
            .iter()
            .zip(&after)
            .enumerate()
            .filter(|(_, (old, new))| old.to_bits() != new.to_bits())
            .map(|(index, (old, new))| WeightChange {
                neuron: (index / LAB_CHANNELS) as u32,
                channel: (index % LAB_CHANNELS) as u32,
                before_bits: old.to_bits(),
                after_bits: new.to_bits(),
            })
            .collect();

        Ok(LabStep {
            step: self.completed_steps,
            episode: self.episode,
            stimulus,
            event,
            observation,
            modulators: self.last_modulators,
            input_spikes,
            output_spikes,
            membrane_potentials: self.network.get_membrane_potentials(),
            thresholds: self.network.get_thresholds(),
            weight_changes,
        })
    }

    /// Start a new episode with `neuromod`'s `reset`: clears the engine clock,
    /// input spike times, membranes, eligibility traces, and modulators, and
    /// keeps the learned weights and thresholds.
    pub fn new_episode(&mut self) {
        self.network.reset();
        self.episode = self.episode.saturating_add(1);
        self.last_modulators = [0.0; 4];
    }

    /// Frozen held-out probe: each pattern at `PROBE_AMPLITUDE` for
    /// `PROBE_STEPS` steps on a fresh copy of the current network, through
    /// `plasticity-lab`'s `run_eval_with_rng` with default modulators. Weights,
    /// traces, thresholds, and the session RNG are untouched.
    pub fn probe(&self) -> Result<LabProbe, String> {
        let mut rng = StdRng::seed_from_u64(self.seed ^ PROBE_STREAM);
        let mut trainer = PlasticityTrainer::new(TrainingConfig::default());
        let mut counts = [Vec::new(), Vec::new()];
        for (slot, pattern) in [Stimulus::PatternA, Stimulus::PatternB]
            .into_iter()
            .enumerate()
        {
            let mut evaluation = copy_network(&self.network);
            evaluation.reset();
            let held_out = vec![
                EvaluationExample {
                    stimuli: pattern.vector(PROBE_AMPLITUDE).to_vec(),
                };
                PROBE_STEPS
            ];
            let summary = trainer
                .run_eval_with_rng(
                    &mut evaluation,
                    &held_out,
                    &NeuroModulators::default(),
                    &mut rng,
                )
                .map_err(|error| format!("plasticity-probe-failed: {error}"))?;
            counts[slot] = summary.per_neuron_spikes;
        }
        let [pattern_a_spikes, pattern_b_spikes] = counts;
        Ok(LabProbe {
            pattern_a_spikes,
            pattern_b_spikes,
        })
    }

    pub fn seed(&self) -> u64 {
        self.seed
    }

    pub fn completed_steps(&self) -> u64 {
        self.completed_steps
    }

    pub fn episode(&self) -> u32 {
        self.episode
    }

    /// `neuromod`'s engine tick within the current episode.
    pub fn engine_step(&self) -> i64 {
        self.network.global_step
    }

    /// Weights, neuron-major (`neuron * LAB_CHANNELS + channel`).
    pub fn weights(&self) -> Vec<f32> {
        self.network
            .neurons
            .iter()
            .flat_map(|neuron| neuron.weights.iter().copied())
            .collect()
    }

    /// Eligibility trace values, neuron-major like [`Self::weights`].
    pub fn eligibility(&self) -> Vec<f32> {
        self.network
            .neurons
            .iter()
            .flat_map(|neuron| neuron.eligibility.iter().map(|trace| trace.value))
            .collect()
    }

    pub fn thresholds(&self) -> Vec<f32> {
        self.network.get_thresholds()
    }

    pub fn membrane_potentials(&self) -> Vec<f32> {
        self.network.get_membrane_potentials()
    }

    /// The `limbic-critic` vector applied on the latest step (zeros before the
    /// first step and after a new episode).
    pub fn modulators(&self) -> [f32; 4] {
        self.last_modulators
    }
}

/// One entry of the deterministic scripted session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScriptStep {
    /// Start a new episode (`neuromod` reset) before this step.
    pub new_episode: bool,
    pub stimulus: Stimulus,
    pub event: RewardEvent,
}

const fn script_step(new_episode: bool, stimulus: Stimulus, event: RewardEvent) -> ScriptStep {
    ScriptStep {
        new_episode,
        stimulus,
        event,
    }
}

/// Seed of the committed golden scripted session.
pub const SCRIPTED_SESSION_SEED: u64 = 17;

/// Four episodes: pattern A then a delayed reward, pattern B then a delayed
/// penalty, twice. Each episode is three presentation steps, two quiet steps,
/// and one quiet step carrying the reward input.
pub const SCRIPTED_SESSION: [ScriptStep; 24] = {
    use RewardEvent::{None as N, Penalty as P, Reward as R};
    use Stimulus::{PatternA as A, PatternB as B, Quiet as Q};
    [
        script_step(false, A, N),
        script_step(false, A, N),
        script_step(false, A, N),
        script_step(false, Q, N),
        script_step(false, Q, N),
        script_step(false, Q, R),
        script_step(true, B, N),
        script_step(false, B, N),
        script_step(false, B, N),
        script_step(false, Q, N),
        script_step(false, Q, N),
        script_step(false, Q, P),
        script_step(true, A, N),
        script_step(false, A, N),
        script_step(false, A, N),
        script_step(false, Q, N),
        script_step(false, Q, N),
        script_step(false, Q, R),
        script_step(true, B, N),
        script_step(false, B, N),
        script_step(false, B, N),
        script_step(false, Q, N),
        script_step(false, Q, N),
        script_step(false, Q, P),
    ]
};

/// A replayed scripted session: the probe before, every step, the probe after.
#[derive(Clone, Debug, PartialEq)]
pub struct ScriptedSessionTrace {
    pub seed: u64,
    pub probe_before: LabProbe,
    pub steps: Vec<LabStep>,
    pub final_weights: Vec<f32>,
    pub final_thresholds: Vec<f32>,
    pub probe_after: LabProbe,
}

/// Replay `script` from a fresh lab seeded with `seed`.
pub fn run_scripted_session(
    seed: u64,
    script: &[ScriptStep],
) -> Result<ScriptedSessionTrace, String> {
    let mut lab = PlasticityLab::new(seed);
    let probe_before = lab.probe()?;
    let mut steps = Vec::with_capacity(script.len());
    for entry in script {
        if entry.new_episode {
            lab.new_episode();
        }
        steps.push(lab.step(entry.stimulus, entry.event)?);
    }
    Ok(ScriptedSessionTrace {
        seed,
        probe_before,
        steps,
        final_weights: lab.weights(),
        final_thresholds: lab.thresholds(),
        probe_after: lab.probe()?,
    })
}

// ---------------------------------------------------------------------------
// wasm-bindgen boundary
// ---------------------------------------------------------------------------

/// The lab session exported to JavaScript (labs package only).
#[wasm_bindgen]
pub struct WasmPlasticityLab {
    lab: PlasticityLab,
}

/// One step's result. Numeric rows are typed arrays copied out of Rust.
#[wasm_bindgen]
pub struct WasmPlasticityStep {
    step: LabStep,
}

/// One frozen probe's per-neuron spike counts.
#[wasm_bindgen]
pub struct WasmPlasticityProbe {
    probe: LabProbe,
}

fn js_error(message: String) -> JsValue {
    JsValue::from_str(&message)
}

fn counts_to_u32(counts: &[u64]) -> Vec<u32> {
    counts
        .iter()
        .map(|count| u32::try_from(*count).unwrap_or(u32::MAX))
        .collect()
}

#[wasm_bindgen]
impl WasmPlasticityLab {
    /// A fresh session seeded with `seed` (a JavaScript `bigint`).
    #[wasm_bindgen(js_name = create)]
    pub fn create(seed: u64) -> WasmPlasticityLab {
        Self {
            lab: PlasticityLab::new(seed),
        }
    }

    /// `stimulus`: 0 quiet, 1 pattern A, 2 pattern B. `event`: 0 none,
    /// 1 reward, 2 penalty. Errors are `"<code>: <message>"` strings.
    pub fn step(&mut self, stimulus: u8, event: u8) -> Result<WasmPlasticityStep, JsValue> {
        let stimulus = Stimulus::parse(stimulus).map_err(js_error)?;
        let event = RewardEvent::parse(event).map_err(js_error)?;
        let step = self.lab.step(stimulus, event).map_err(js_error)?;
        Ok(WasmPlasticityStep { step })
    }

    #[wasm_bindgen(js_name = newEpisode)]
    pub fn new_episode(&mut self) {
        self.lab.new_episode();
    }

    pub fn probe(&self) -> Result<WasmPlasticityProbe, JsValue> {
        let probe = self.lab.probe().map_err(js_error)?;
        Ok(WasmPlasticityProbe { probe })
    }

    #[wasm_bindgen(getter)]
    pub fn lab_version(&self) -> u32 {
        PLASTICITY_LAB_VERSION
    }
    #[wasm_bindgen(getter)]
    pub fn neuron_count(&self) -> u32 {
        LAB_NEURONS as u32
    }
    #[wasm_bindgen(getter)]
    pub fn channel_count(&self) -> u32 {
        LAB_CHANNELS as u32
    }
    #[wasm_bindgen(getter)]
    pub fn seed(&self) -> u64 {
        self.lab.seed()
    }
    #[wasm_bindgen(getter)]
    pub fn completed_steps(&self) -> u64 {
        self.lab.completed_steps()
    }
    #[wasm_bindgen(getter)]
    pub fn episode(&self) -> u32 {
        self.lab.episode()
    }
    #[wasm_bindgen(getter)]
    pub fn engine_step(&self) -> i64 {
        self.lab.engine_step()
    }
    #[wasm_bindgen(getter)]
    pub fn weights(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(self.lab.weights().as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn eligibility(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(self.lab.eligibility().as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn thresholds(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(self.lab.thresholds().as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn membrane_potentials(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(self.lab.membrane_potentials().as_slice())
    }
    /// Dopamine, serotonin, acetylcholine, norepinephrine.
    #[wasm_bindgen(getter)]
    pub fn modulators(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(self.lab.modulators().as_slice())
    }
}

#[wasm_bindgen]
impl WasmPlasticityStep {
    #[wasm_bindgen(getter)]
    pub fn step(&self) -> u64 {
        self.step.step
    }
    #[wasm_bindgen(getter)]
    pub fn episode(&self) -> u32 {
        self.step.episode
    }
    #[wasm_bindgen(getter)]
    pub fn stimulus(&self) -> String {
        self.step.stimulus.name().to_owned()
    }
    #[wasm_bindgen(getter)]
    pub fn event(&self) -> String {
        self.step.event.name().to_owned()
    }
    #[wasm_bindgen(getter)]
    pub fn objective(&self) -> f32 {
        self.step.observation.objective
    }
    #[wasm_bindgen(getter)]
    pub fn stress(&self) -> f32 {
        self.step.observation.stress
    }
    /// Dopamine, serotonin, acetylcholine, norepinephrine from `limbic-critic`.
    #[wasm_bindgen(getter)]
    pub fn modulators(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(self.step.modulators.as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn input_spikes(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(self.step.input_spikes.as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn output_spikes(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(self.step.output_spikes.as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn membrane_potentials(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(self.step.membrane_potentials.as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn thresholds(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(self.step.thresholds.as_slice())
    }
    /// Flattened `[neuron, channel, before_bits, after_bits]` per changed weight.
    #[wasm_bindgen(getter)]
    pub fn weight_changes(&self) -> js_sys::Uint32Array {
        let flat: Vec<u32> = self
            .step
            .weight_changes
            .iter()
            .flat_map(|change| {
                [
                    change.neuron,
                    change.channel,
                    change.before_bits,
                    change.after_bits,
                ]
            })
            .collect();
        js_sys::Uint32Array::from(flat.as_slice())
    }
}

#[wasm_bindgen]
impl WasmPlasticityProbe {
    #[wasm_bindgen(getter)]
    pub fn steps_per_pattern(&self) -> u32 {
        PROBE_STEPS as u32
    }
    #[wasm_bindgen(getter)]
    pub fn pattern_a_spikes(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(counts_to_u32(&self.probe.pattern_a_spikes).as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn pattern_b_spikes(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(counts_to_u32(&self.probe.pattern_b_spikes).as_slice())
    }
}
