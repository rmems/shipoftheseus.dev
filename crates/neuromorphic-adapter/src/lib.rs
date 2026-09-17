//! The browser boundary for the portfolio's crate-backed neuromorphic runtime.
//!
//! This crate orchestrates the selected upstream crates; it does not reimplement
//! encoding, neural dynamics, topology generation, or protocol compatibility.

use axon_encoder::prelude::{DeltaEncoder, Encoder};
use corpus_ipc::WireCompatibility;
use kinetic_signals::{ZScore, compute_signal_stats};
use neuromod::{NeuroModulators, SeedableRng, SpikingNetwork, StdRng};
use synaptic_wiring::{SynapticMesh, topology::generate_small_world};
use wasm_bindgen::prelude::*;

pub const CONTRACT_VERSION: u32 = 2;
const CHANNEL_COUNT: usize = 16;
const STATUS_OK: &str = "ok";

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
}

/// Deterministic, browser-safe composition of the audited V1 crate surfaces.
pub struct BrowserRuntime {
    seed: u64,
    completed_step: u64,
    last_sequence: Option<u64>,
    encoder: DeltaEncoder,
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
    pub fn new(seed: u64) -> Result<Self, String> {
        let graph = generate_small_world(CHANNEL_COUNT, 4, 0.2, 4, 0.25)
            .map_err(|error| format!("could not construct browser topology: {error}"))?;
        let mesh = SynapticMesh::new(graph);
        let topology_projection = TopologyProjection::from_graph(mesh.graph());
        let topology_digest = topology_projection.topology_digest.clone();
        let (topology_rows, topology_targets, topology_weights, topology_delays) =
            mesh.to_gpu_arrays();

        Ok(Self {
            seed,
            completed_step: 0,
            last_sequence: None,
            encoder: DeltaEncoder::new(0.05, CHANNEL_COUNT),
            mesh,
            network: SpikingNetwork::with_dimensions(CHANNEL_COUNT, 0, CHANNEL_COUNT),
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
    /// Raw samples are summarized by `kinetic-signals`, transformed into a
    /// bounded feature vector, and encoded by `axon-encoder`. The resulting
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
        let raw: Vec<f64> = samples.iter().map(|sample| f64::from(*sample)).collect();
        let stats = compute_signal_stats(&raw);
        let scale = stats.variance.sqrt().max(0.001);
        let mut features = vec![0.0_f32; CHANNEL_COUNT];
        for (index, sample) in raw.iter().take(CHANNEL_COUNT).enumerate() {
            features[index] = (ZScore::compute(*sample, stats.mean, scale).abs() as f32).min(1.0);
        }

        let encoded = self.encoder.encode_step(&features);
        let mut source_spikes = vec![false; CHANNEL_COUNT];
        for spike in encoded.spikes {
            source_spikes[usize::from(spike.channel)] = true;
        }
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
            contract_version: CONTRACT_VERSION,
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
}

#[wasm_bindgen]
impl WasmAdapter {
    #[wasm_bindgen(js_name = init)]
    pub fn init(seed: u64, config: &[u8]) -> Result<WasmAdapter, JsValue> {
        if config != [CONTRACT_VERSION as u8] {
            return Err(JsValue::from_str(
                "adapter config must contain exactly the supported contract version",
            ));
        }
        Ok(Self {
            runtime: Some(BrowserRuntime::new(seed).map_err(|error| JsValue::from_str(&error))?),
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
