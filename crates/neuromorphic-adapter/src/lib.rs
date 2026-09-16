//! The browser boundary for the portfolio's crate-backed neuromorphic runtime.
//!
//! This crate orchestrates the selected upstream crates; it does not reimplement
//! encoding, neural dynamics, topology generation, or protocol compatibility.

use axon_encoder::prelude::{DeltaEncoder, Encoder};
use corpus_ipc::WireCompatibility;
use kinetic_signals::compute_signal_stats;
use neuromod::{NeuroModulators, SeedableRng, SpikingNetwork, StdRng};
use synaptic_wiring::{SynapticMesh, topology::generate_small_world};
use wasm_bindgen::prelude::*;

pub const CONTRACT_VERSION: u32 = 1;
const CHANNEL_COUNT: usize = 16;

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
    pub topology_digest: String,
    pub protocol_wire_version: u32,
}

/// Deterministic, browser-safe composition of the audited V1 crate surfaces.
pub struct BrowserRuntime {
    seed: u64,
    completed_step: u64,
    last_sequence: u64,
    encoder: DeltaEncoder,
    mesh: SynapticMesh,
    network: SpikingNetwork,
    rng: StdRng,
    pending_currents: Vec<f32>,
    last_spikes: Vec<u32>,
    topology_rows: Vec<u32>,
    topology_targets: Vec<u32>,
    topology_weights: Vec<f32>,
    topology_delays: Vec<u16>,
    topology_digest: String,
}

impl BrowserRuntime {
    pub fn new(seed: u64) -> Result<Self, String> {
        let graph = generate_small_world(CHANNEL_COUNT, 4, 0.2, 4, 0.25)
            .map_err(|error| format!("could not construct browser topology: {error}"))?;
        let mesh = SynapticMesh::new(graph);
        let topology_digest = mesh.topology_digest().to_string();
        let (topology_rows, topology_targets, topology_weights, topology_delays) =
            mesh.to_gpu_arrays();

        Ok(Self {
            seed,
            completed_step: 0,
            last_sequence: 0,
            encoder: DeltaEncoder::new(0.05, CHANNEL_COUNT),
            mesh,
            network: SpikingNetwork::with_dimensions(CHANNEL_COUNT, 0, CHANNEL_COUNT),
            rng: StdRng::seed_from_u64(seed),
            pending_currents: vec![0.0; CHANNEL_COUNT],
            last_spikes: Vec::new(),
            topology_rows,
            topology_targets,
            topology_weights,
            topology_delays,
            topology_digest,
        })
    }

    /// Accept a monotonically increasing browser input sequence.
    ///
    /// Raw samples are summarized by `kinetic-signals`, transformed into a
    /// bounded feature vector, encoded by `axon-encoder`, and propagated by
    /// `synaptic-wiring`. `step` then advances `neuromod` with a seeded RNG.
    pub fn input(&mut self, sequence: u64, samples: &[f32]) -> Result<(), String> {
        if sequence <= self.last_sequence {
            return Err("input sequence must be strictly increasing".into());
        }

        if samples.iter().any(|sample| !sample.is_finite()) {
            return Err("input samples must be finite".into());
        }
        let raw: Vec<f64> = samples.iter().map(|sample| f64::from(*sample)).collect();
        let stats = compute_signal_stats(&raw);
        let scale = stats.variance.sqrt().max(0.001);
        let mut features = vec![0.0_f32; CHANNEL_COUNT];
        for (index, sample) in raw.iter().take(CHANNEL_COUNT).enumerate() {
            features[index] = (((*sample - stats.mean) / scale).abs() as f32).min(1.0);
        }

        let encoded = self.encoder.encode_step(&features);
        let mut source_spikes = vec![false; CHANNEL_COUNT];
        for spike in encoded.spikes {
            source_spikes[usize::from(spike.channel)] = true;
        }
        self.pending_currents = self
            .mesh
            .propagate(&source_spikes)
            .map_err(|error| format!("could not propagate encoded spikes: {error}"))?;
        self.last_sequence = sequence;
        Ok(())
    }

    pub fn step(&mut self) -> Result<BrowserState, String> {
        let spikes = self
            .network
            .step_with_rng(&self.pending_currents, &NeuroModulators::default(), &mut self.rng)
            .map_err(|error| format!("could not advance neuromod: {error:?}"))?;
        self.last_spikes = spikes
            .into_iter()
            .map(|neuron| u32::try_from(neuron).map_err(|_| "spike index exceeds u32"))
            .collect::<Result<Vec<_>, _>>()?;
        self.completed_step += 1;
        Ok(self.state())
    }

    pub fn state(&self) -> BrowserState {
        BrowserState {
            contract_version: CONTRACT_VERSION,
            seed: self.seed,
            completed_step: self.completed_step,
            last_sequence: self.last_sequence,
            membrane_potentials: self.network.get_membrane_potentials(),
            spike_neurons: self.last_spikes.clone(),
            topology_rows: self.topology_rows.clone(),
            topology_targets: self.topology_targets.clone(),
            topology_weights: self.topology_weights.clone(),
            topology_delays: self.topology_delays.clone(),
            topology_digest: self.topology_digest.clone(),
            protocol_wire_version: WireCompatibility::CURRENT,
        }
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
    pub fn contract_version(&self) -> u32 { self.state.contract_version }
    #[wasm_bindgen(getter)]
    pub fn seed(&self) -> u64 { self.state.seed }
    #[wasm_bindgen(getter)]
    pub fn completed_step(&self) -> u64 { self.state.completed_step }
    #[wasm_bindgen(getter)]
    pub fn last_sequence(&self) -> u64 { self.state.last_sequence }
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
    pub fn topology_digest(&self) -> String { self.state.topology_digest.clone() }
    #[wasm_bindgen(getter)]
    pub fn protocol_wire_version(&self) -> u32 { self.state.protocol_wire_version }
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
        Ok(WasmState { state: runtime.state() })
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
