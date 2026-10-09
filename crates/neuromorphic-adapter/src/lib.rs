//! The browser boundary for the portfolio's crate-backed neuromorphic runtime.
//!
//! This crate orchestrates the selected upstream crates; it does not reimplement
//! encoding, neural dynamics, topology generation, or protocol compatibility.

use corpus_ipc::WireCompatibility;
use neuromod::{NeuroModulators, SeedableRng, SpikingNetwork, StdRng};
use synaptic_wiring::{SynapticMesh, topology::generate_small_world};
use wasm_bindgen::prelude::*;

pub mod encoder;
pub mod kinetic;
/// NIR graph inspection (`nir-rs`, no HDF5); exported through this same
/// WASM package as `WasmNirInspection`.
pub mod nir;

use encoder::{
    CONTRACT_VERSION_V4, ENCODER_CHANNELS, EncoderMode, V1Encoder,
    normalize_to_encoder_input_for_contract,
};
use kinetic::{KineticExtractor, TELEMETRY_PACKET_LEN};

pub const CONTRACT_VERSION: u32 = 3;
/// Contract version that adds selectable encoder modes and spike-train
/// diagnostics. Version 3 stays accepted as the legacy delta-only alias.
pub const CONTRACT_VERSION_V4_U32: u32 = CONTRACT_VERSION_V4 as u32;
/// Contract version whose `input` samples are `[x, y, pressure]` telemetry
/// packets routed through `kinetic-signals` feature extraction (see
/// [`kinetic`]) before `axon-encoder`. Adds `encoder_features` to the state.
pub const CONTRACT_VERSION_V5: u32 = 5;
const CHANNEL_COUNT: usize = 16;
const STATUS_OK: &str = "ok";

/// Neuron model the adapter selects inside `neuromod::SpikingNetwork`.
///
/// v1 runs the LIF bank only. `Izhikevich` is a reserved extension point:
/// enabling it requires a browser performance review and a `CONTRACT_VERSION`
/// increase that tags the state with the selected model. See
/// `docs/architecture/browser-runtime.md`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NeuronModel {
    Lif,
    #[allow(dead_code)]
    Izhikevich,
}

const V1_NEURON_MODEL: NeuronModel = NeuronModel::Lif;

impl NeuronModel {
    fn network_dimensions(self) -> (usize, usize, usize) {
        match self {
            NeuronModel::Lif => (CHANNEL_COUNT, 0, CHANNEL_COUNT),
            // Reserved for a future contract version; unreachable in v1.
            NeuronModel::Izhikevich => unreachable!("Izhikevich is not enabled in contract v1"),
        }
    }
}

/// Adapter-owned, canonical transport projection of an upstream topology.
///
/// `synaptic-wiring` remains the authority for topology and routing. The
/// adapter only gives every member of its complete edge multiset a stable
/// position within the upstream topology digest so browser consumers can
/// reference an edge without claiming an upstream `EdgeId` exists.
#[derive(Clone, Debug, PartialEq)]
pub struct TopologyProjection {
    pub topology_digest: String,
    pub node_ids: Vec<u32>,
    pub edge_sources: Vec<u32>,
    pub edge_targets: Vec<u32>,
    pub edge_weights: Vec<f32>,
    pub edge_weight_bits: Vec<u32>,
    pub edge_delays: Vec<u16>,
    /// `0` is excitatory and `1` is inhibitory, matching the stable sort key.
    pub edge_polarities: Vec<u8>,
    /// CSR-style ranges into canonical edge arrays, keyed by upstream `NeuronId`.
    pub outgoing_edge_offsets: Vec<u32>,
}

impl TopologyProjection {
    pub fn from_graph(graph: &synaptic_wiring::SynapticGraph) -> Self {
        let mut edges = Vec::with_capacity(graph.synapse_count());
        for source in 0..graph.neuron_count() {
            for (target, weight, delay, polarity) in graph.outgoing(source) {
                let polarity_tag = match polarity {
                    synaptic_wiring::Polarity::Excitatory => 0,
                    synaptic_wiring::Polarity::Inhibitory => 1,
                };
                edges.push((source as u32, target, weight, delay, polarity_tag));
            }
        }
        edges.sort_by_key(|(source, target, weight, delay, polarity)| {
            (*source, *target, *delay, *polarity, weight.to_bits())
        });

        let mut outgoing_edge_offsets = vec![0_u32; graph.neuron_count() + 1];
        for (source, _, _, _, _) in &edges {
            outgoing_edge_offsets[*source as usize + 1] += 1;
        }
        for index in 1..outgoing_edge_offsets.len() {
            outgoing_edge_offsets[index] += outgoing_edge_offsets[index - 1];
        }

        Self {
            topology_digest: graph.topology_digest().to_string(),
            node_ids: (0..graph.neuron_count()).map(|id| id as u32).collect(),
            edge_sources: edges.iter().map(|(source, _, _, _, _)| *source).collect(),
            edge_targets: edges.iter().map(|(_, target, _, _, _)| *target).collect(),
            edge_weights: edges.iter().map(|(_, _, weight, _, _)| *weight).collect(),
            edge_weight_bits: edges
                .iter()
                .map(|(_, _, weight, _, _)| weight.to_bits())
                .collect(),
            edge_delays: edges.iter().map(|(_, _, _, delay, _)| *delay).collect(),
            edge_polarities: edges
                .iter()
                .map(|(_, _, _, _, polarity)| *polarity)
                .collect(),
            outgoing_edge_offsets,
        }
    }

    pub fn canonical_edge_indices(&self) -> Vec<u32> {
        (0..self.edge_sources.len() as u32).collect()
    }

    pub fn outgoing_edge_range(&self, source: u32) -> std::ops::Range<u32> {
        let index = source as usize;
        self.outgoing_edge_offsets[index]..self.outgoing_edge_offsets[index + 1]
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct BrowserState {
    pub contract_version: u32,
    pub seed: u64,
    pub completed_step: u64,
    pub last_sequence: u64,
    pub membrane_potentials: Vec<f32>,
    pub spike_neurons: Vec<u32>,
    pub topology_rows: Vec<u32>,
    pub topology_targets: Vec<u32>,
    pub topology_weights: Vec<f32>,
    pub topology_delays: Vec<u16>,
    pub topology_node_ids: Vec<u32>,
    pub topology_edge_sources: Vec<u32>,
    pub topology_edge_targets: Vec<u32>,
    pub topology_edge_weights: Vec<f32>,
    pub topology_edge_delays: Vec<u16>,
    pub topology_polarities: Vec<u8>,
    pub topology_weight_bits: Vec<u32>,
    pub topology_outgoing_edge_offsets: Vec<u32>,
    pub topology_digest: String,
    pub protocol_wire_version: u32,
    pub error_status: String,
    /// Active encoder mode discriminant (see [`EncoderMode`]).
    pub encoder_mode: u8,
    /// Active encoder name (`"delta"`, `"temporal"`, or `"rate"`).
    pub encoder_name: String,
    /// Encoded spike count from the most recent `input` call.
    pub encoded_spike_count: u32,
    /// Distinct channels that spiked in the most recent `input` call.
    pub encoded_spike_channels: u32,
    /// Cumulative encoded spikes since construction.
    pub encoded_spike_total: u64,
    /// Contract 5: the clamped `[0, 1]` feature vector handed to
    /// `axon-encoder` by the most recent `input` (all zeros before the first
    /// input). Empty on contracts 3 and 4.
    pub encoder_features: Vec<f32>,
}

/// Construct the `neuromod` network for the selected model. All dynamics and
/// spike generation live inside `neuromod`; the adapter only picks dimensions
/// and initial synaptic weights.
fn build_network(model: NeuronModel) -> SpikingNetwork {
    let (num_lif, num_izh, num_channels) = model.network_dimensions();
    let mut network = SpikingNetwork::with_dimensions(num_lif, num_izh, num_channels);
    // `with_dimensions` zero-initializes LIF weights, and `neuromod` gates all
    // stimulus current on those weights, so a default network can never fire.
    // Upstream's own demos (e.g. `examples/rstdp_demo.rs`) seed each neuron's
    // weights uniformly to `WEIGHT_BUDGET / num_channels` (= 2.0 / N); the
    // engine's L1 renormalization pass then keeps that budget as an exact
    // no-op. Follow the same convention here — this is initialization, not
    // site-local dynamics.
    let seed = 2.0 / num_channels as f32;
    for neuron in &mut network.neurons {
        neuron.weights = vec![seed; num_channels];
    }
    network
}

/// Deterministic, browser-safe composition of the audited V1 crate surfaces.
pub struct BrowserRuntime {
    seed: u64,
    contract_version: u32,
    completed_step: u64,
    last_sequence: Option<u64>,
    encoder: V1Encoder,
    /// Present only on contract 5, where input is telemetry rather than raw
    /// samples.
    kinetic: Option<KineticExtractor>,
    encoder_features: [f32; ENCODER_CHANNELS],
    encoded_spike_count: u32,
    encoded_spike_channels: u32,
    encoded_spike_total: u64,
    mesh: SynapticMesh,
    network: SpikingNetwork,
    rng: StdRng,
    pending_source_spikes: Vec<bool>,
    last_spikes: Vec<u32>,
    topology_rows: Vec<u32>,
    topology_targets: Vec<u32>,
    topology_weights: Vec<f32>,
    topology_delays: Vec<u16>,
    topology_projection: TopologyProjection,
    topology_digest: String,
    last_error_status: String,
}

impl BrowserRuntime {
    /// Legacy contract-3 constructor: delta-only encoding, unchanged
    /// deterministic behavior for the seed-9 golden trace.
    pub fn new(seed: u64) -> Result<Self, String> {
        Self::with_mode(seed, EncoderMode::Delta, CONTRACT_VERSION)
    }

    /// Contract-4 constructor with an explicitly selected encoder mode.
    pub fn with_mode(seed: u64, mode: EncoderMode, contract: u32) -> Result<Self, String> {
        if ![
            CONTRACT_VERSION,
            CONTRACT_VERSION_V4_U32,
            CONTRACT_VERSION_V5,
        ]
        .contains(&contract)
        {
            return Err(format!("unsupported contract version {contract}"));
        }
        if contract == CONTRACT_VERSION && mode != EncoderMode::Delta {
            return Err("contract 3 supports only delta encoding".to_owned());
        }
        if ENCODER_CHANNELS != CHANNEL_COUNT {
            return Err("encoder channel contract breached".to_owned());
        }
        let graph = generate_small_world(CHANNEL_COUNT, 4, 0.2, 4, 0.25)
            .map_err(|error| format!("could not construct browser topology: {error}"))?;
        let mesh = SynapticMesh::new(graph);
        let topology_projection = TopologyProjection::from_graph(mesh.graph());
        let topology_digest = topology_projection.topology_digest.clone();
        let (topology_rows, topology_targets, topology_weights, topology_delays) =
            mesh.to_gpu_arrays();

        Ok(Self {
            seed,
            contract_version: contract,
            completed_step: 0,
            last_sequence: None,
            encoder: V1Encoder::for_mode(mode),
            kinetic: (contract == CONTRACT_VERSION_V5).then(KineticExtractor::new),
            encoder_features: [0.0; ENCODER_CHANNELS],
            encoded_spike_count: 0,
            encoded_spike_channels: 0,
            encoded_spike_total: 0,
            mesh,
            network: build_network(V1_NEURON_MODEL),
            rng: StdRng::seed_from_u64(seed),
            pending_source_spikes: vec![false; CHANNEL_COUNT],
            last_spikes: Vec::new(),
            topology_rows,
            topology_targets,
            topology_weights,
            topology_delays,
            topology_projection,
            topology_digest,
            last_error_status: STATUS_OK.to_owned(),
        })
    }

    /// Accept a monotonically increasing browser input sequence.
    ///
    /// On contracts 3 and 4, raw samples are summarized by `kinetic-signals`
    /// statistics into a bounded feature vector. On contract 5, samples are
    /// one `[x, y, pressure]` telemetry packet that the stateful
    /// [`KineticExtractor`] turns into clamped motion features. Either way the
    /// features are encoded by `axon-encoder`. The resulting
    /// spikes are queued, so each logical `step` advances `synaptic-wiring`
    /// exactly once before it advances `neuromod` with a seeded RNG.
    pub fn input(&mut self, sequence: u64, samples: &[f32]) -> Result<(), String> {
        if self
            .last_sequence
            .is_some_and(|previous| sequence <= previous)
        {
            return self.fail(
                "input-sequence-not-increasing",
                "input sequence must be strictly increasing after the first input",
            );
        }

        if samples.iter().any(|sample| !sample.is_finite()) {
            return self.fail("input-non-finite-samples", "input samples must be finite");
        }
        let features = match self.kinetic.as_mut() {
            Some(kinetic) => {
                let Ok(packet) = <&[f32; TELEMETRY_PACKET_LEN]>::try_from(samples) else {
                    return self.fail(
                        "input-telemetry-shape",
                        format!("contract 5 input must be one [x, y, pressure] packet of {TELEMETRY_PACKET_LEN} samples"),
                    );
                };
                kinetic.extract(packet)
            }
            // Contract 3 keeps the legacy all-samples statistics so existing
            // replays reproduce; contract 4 uses first-16 statistics.
            None => normalize_to_encoder_input_for_contract(samples, self.contract_version),
        };
        self.encoder_features = features;

        let channels = self.encoder.encode_step(&features);
        let mut source_spikes = vec![false; CHANNEL_COUNT];
        for channel in &channels {
            source_spikes[usize::from(*channel)] = true;
        }
        let distinct = source_spikes.iter().filter(|spiked| **spiked).count();
        self.encoded_spike_count = channels.len().try_into().unwrap_or(u32::MAX);
        self.encoded_spike_channels = distinct.try_into().unwrap_or(u32::MAX);
        self.encoded_spike_total = self
            .encoded_spike_total
            .saturating_add(channels.len() as u64);
        for (pending, spike) in self.pending_source_spikes.iter_mut().zip(source_spikes) {
            *pending |= spike;
        }
        self.last_sequence = Some(sequence);
        self.last_error_status = STATUS_OK.to_owned();
        Ok(())
    }

    pub fn step(&mut self) -> Result<BrowserState, String> {
        let source_spikes =
            std::mem::replace(&mut self.pending_source_spikes, vec![false; CHANNEL_COUNT]);
        let currents = match self.mesh.propagate(&source_spikes) {
            Ok(currents) => currents,
            Err(error) => {
                return self.fail(
                    "step-propagation-failed",
                    format!("could not propagate encoded spikes: {error}"),
                );
            }
        };
        // The simulation path uses only the caller-seeded `StdRng`; it never
        // touches entropy (`getrandom`), which exists solely for `wasm-js`
        // linking on wasm32.
        let spikes =
            match self
                .network
                .step_with_rng(&currents, &NeuroModulators::default(), &mut self.rng)
            {
                Ok(spikes) => spikes,
                Err(error) => {
                    return self.fail(
                        "step-neuromod-failed",
                        format!("could not advance neuromod: {error:?}"),
                    );
                }
            };
        self.last_spikes = match spikes
            .into_iter()
            .map(|neuron| u32::try_from(neuron).map_err(|_| "spike index exceeds u32"))
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(spikes) => spikes,
            Err(error) => return self.fail("step-spike-index-out-of-range", error),
        };
        self.completed_step += 1;
        self.last_error_status = STATUS_OK.to_owned();
        Ok(self.state())
    }

    pub fn state(&self) -> BrowserState {
        BrowserState {
            contract_version: self.contract_version,
            seed: self.seed,
            completed_step: self.completed_step,
            last_sequence: self.last_sequence.unwrap_or(0),
            membrane_potentials: self.network.get_membrane_potentials(),
            spike_neurons: self.last_spikes.clone(),
            topology_rows: self.topology_rows.clone(),
            topology_targets: self.topology_targets.clone(),
            topology_weights: self.topology_weights.clone(),
            topology_delays: self.topology_delays.clone(),
            topology_node_ids: self.topology_projection.node_ids.clone(),
            topology_edge_sources: self.topology_projection.edge_sources.clone(),
            topology_edge_targets: self.topology_projection.edge_targets.clone(),
            topology_edge_weights: self.topology_projection.edge_weights.clone(),
            topology_edge_delays: self.topology_projection.edge_delays.clone(),
            topology_polarities: self.topology_projection.edge_polarities.clone(),
            topology_weight_bits: self.topology_projection.edge_weight_bits.clone(),
            topology_outgoing_edge_offsets: self.topology_projection.outgoing_edge_offsets.clone(),
            topology_digest: self.topology_digest.clone(),
            protocol_wire_version: WireCompatibility::CURRENT,
            error_status: self.last_error_status.clone(),
            encoder_mode: self.encoder.mode() as u8,
            encoder_name: self.encoder.mode().name().to_owned(),
            encoded_spike_count: self.encoded_spike_count,
            encoded_spike_channels: self.encoded_spike_channels,
            encoded_spike_total: self.encoded_spike_total,
            // Contracts 3 and 4 keep their frozen state shape: no features.
            encoder_features: if self.contract_version == CONTRACT_VERSION_V5 {
                self.encoder_features.to_vec()
            } else {
                Vec::new()
            },
        }
    }

    pub fn mesh_tick(&self) -> u64 {
        self.mesh.tick()
    }

    fn fail<T>(&mut self, status: &str, message: impl Into<String>) -> Result<T, String> {
        self.last_error_status = status.to_owned();
        Err(message.into())
    }
}

#[wasm_bindgen]
pub struct WasmAdapter {
    runtime: Option<BrowserRuntime>,
}

#[wasm_bindgen]
pub struct WasmState {
    state: BrowserState,
}

impl WasmState {
    /// Native-test access to the wrapped state. Not part of the WASM contract.
    pub fn browser_state(&self) -> &BrowserState {
        &self.state
    }
}

#[wasm_bindgen]
impl WasmState {
    #[wasm_bindgen(getter)]
    pub fn contract_version(&self) -> u32 {
        self.state.contract_version
    }
    #[wasm_bindgen(getter)]
    pub fn seed(&self) -> u64 {
        self.state.seed
    }
    #[wasm_bindgen(getter)]
    pub fn completed_step(&self) -> u64 {
        self.state.completed_step
    }
    #[wasm_bindgen(getter)]
    pub fn last_sequence(&self) -> u64 {
        self.state.last_sequence
    }
    #[wasm_bindgen(getter)]
    pub fn membrane_potentials(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(self.state.membrane_potentials.as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn spike_neurons(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(self.state.spike_neurons.as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn topology_rows(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(self.state.topology_rows.as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn topology_targets(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(self.state.topology_targets.as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn topology_weights(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(self.state.topology_weights.as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn topology_delays(&self) -> js_sys::Uint16Array {
        js_sys::Uint16Array::from(self.state.topology_delays.as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn topology_node_ids(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(self.state.topology_node_ids.as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn topology_edge_sources(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(self.state.topology_edge_sources.as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn topology_edge_targets(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(self.state.topology_edge_targets.as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn topology_edge_weights(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(self.state.topology_edge_weights.as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn topology_edge_delays(&self) -> js_sys::Uint16Array {
        js_sys::Uint16Array::from(self.state.topology_edge_delays.as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn topology_polarities(&self) -> js_sys::Uint8Array {
        js_sys::Uint8Array::from(self.state.topology_polarities.as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn topology_weight_bits(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(self.state.topology_weight_bits.as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn topology_outgoing_edge_offsets(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(self.state.topology_outgoing_edge_offsets.as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn topology_digest(&self) -> String {
        self.state.topology_digest.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn protocol_wire_version(&self) -> u32 {
        self.state.protocol_wire_version
    }
    #[wasm_bindgen(getter)]
    pub fn error_status(&self) -> String {
        self.state.error_status.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn encoder_mode(&self) -> u32 {
        u32::from(self.state.encoder_mode)
    }
    #[wasm_bindgen(getter)]
    pub fn encoder_name(&self) -> String {
        self.state.encoder_name.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn encoded_spike_count(&self) -> u32 {
        self.state.encoded_spike_count
    }
    #[wasm_bindgen(getter)]
    pub fn encoded_spike_channels(&self) -> u32 {
        self.state.encoded_spike_channels
    }
    #[wasm_bindgen(getter)]
    pub fn encoded_spike_total(&self) -> u64 {
        self.state.encoded_spike_total
    }
    #[wasm_bindgen(getter)]
    pub fn encoder_features(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(self.state.encoder_features.as_slice())
    }
}

#[wasm_bindgen]
impl WasmAdapter {
    /// `config` is `[3]` for the legacy delta-only contract, `[4]` for the
    /// default v1 encoder mode, or `[4, mode]` to select it explicitly
    /// (`0 = delta`, `1 = temporal`, `2 = rate`). `[5]` and `[5, mode]` select
    /// the same encoder modes behind `kinetic-signals` telemetry extraction.
    #[wasm_bindgen(js_name = init)]
    pub fn init(seed: u64, config: &[u8]) -> Result<WasmAdapter, JsValue> {
        let invalid =
            || JsValue::from_str("adapter config must be [3], [4], [4, mode], [5], or [5, mode]");
        let runtime = match config {
            [3] => BrowserRuntime::new(seed),
            [4] => BrowserRuntime::with_mode(seed, EncoderMode::DEFAULT, CONTRACT_VERSION_V4_U32),
            [4, mode] => {
                let selected =
                    EncoderMode::parse(*mode).map_err(|error| JsValue::from_str(&error))?;
                BrowserRuntime::with_mode(seed, selected, CONTRACT_VERSION_V4_U32)
            }
            [5] => BrowserRuntime::with_mode(seed, EncoderMode::DEFAULT, CONTRACT_VERSION_V5),
            [5, mode] => {
                let selected =
                    EncoderMode::parse(*mode).map_err(|error| JsValue::from_str(&error))?;
                BrowserRuntime::with_mode(seed, selected, CONTRACT_VERSION_V5)
            }
            _ => return Err(invalid()),
        }
        .map_err(|error| JsValue::from_str(&error))?;
        Ok(Self {
            runtime: Some(runtime),
        })
    }

    pub fn input(&mut self, sequence: u64, samples: &[f32]) -> Result<(), JsValue> {
        self.runtime_mut()?
            .input(sequence, samples)
            .map_err(|error| JsValue::from_str(&error))
    }

    pub fn step(&mut self) -> Result<WasmState, JsValue> {
        let state = self
            .runtime_mut()?
            .step()
            .map_err(|error| JsValue::from_str(&error))?;
        Ok(WasmState { state })
    }

    pub fn state(&self) -> Result<WasmState, JsValue> {
        let runtime = self
            .runtime
            .as_ref()
            .ok_or_else(|| JsValue::from_str("the Rust/WASM runtime has been disposed"))?;
        Ok(WasmState {
            state: runtime.state(),
        })
    }

    pub fn dispose(&mut self) {
        self.runtime = None;
    }

    fn runtime_mut(&mut self) -> Result<&mut BrowserRuntime, JsValue> {
        self.runtime
            .as_mut()
            .ok_or_else(|| JsValue::from_str("the Rust/WASM runtime has been disposed"))
    }
}
