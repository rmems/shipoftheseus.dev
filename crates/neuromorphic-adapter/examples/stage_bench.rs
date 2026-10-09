//! Native per-stage timing harness for the contract-5 pipeline
//! (GitHub #10 / Linear RM-1646).
//!
//! ```text
//! cargo +1.98.1 run --release --locked \
//!   --manifest-path crates/neuromorphic-adapter/Cargo.toml --example stage_bench
//! ```
//!
//! Pass `-- --json` for machine-readable output and `-- --quick` for a short
//! smoke run. This is a measurement tool, not a test: it is machine-dependent,
//! is never run by `npm test`, and is not linked into the browser package.
//!
//! **What it times.** The shipped pipeline runs every logical tick as
//! `kinetic-signals` extraction → `axon-encoder` encoding → `synaptic-wiring`
//! propagation → `neuromod` LIF step → state materialization. The harness runs
//! that pipeline once per workload to record each stage's real inputs, then
//! times every stage separately over its recorded input sequence with a fresh
//! instance, so each stage sees exactly the state evolution it sees in the
//! pipeline. End-to-end timing goes through the real [`BrowserRuntime`].
//!
//! **Determinism.** Nothing here changes contract outputs: the harness only
//! calls public APIs, and it checks that its own topology digest equals the
//! runtime's before it reports anything.
//!
//! **Synthetic topologies.** The shipped adapter is fixed at 16 neurons and 64
//! synapses. The `scale` section builds larger `synaptic-wiring` small-world
//! graphs and `neuromod` LIF banks through the same crates to show how cost
//! grows. Those sizes are *not* what ships.

use std::hint::black_box;
use std::time::{Duration, Instant};

use neuromod::{NeuroModulators, SeedableRng, SpikingNetwork, StdRng};
use neuromorphic_adapter::encoder::{ENCODER_CHANNELS, EncoderMode, V1Encoder};
use neuromorphic_adapter::kinetic::{KineticExtractor, TELEMETRY_PACKET_LEN};
use neuromorphic_adapter::{BrowserRuntime, CONTRACT_VERSION_V5, TopologyProjection};
use synaptic_wiring::SynapticMesh;
use synaptic_wiring::topology::generate_small_world;

/// The adapter's fixed browser topology parameters (`BrowserRuntime::with_mode`).
const LIVE_NEURONS: usize = 16;
const LIVE_FAN_OUT: usize = 4;
const LIVE_REWIRE: f32 = 0.2;
const LIVE_MAX_DELAY: u16 = 4;
const LIVE_INHIBITORY: f32 = 0.25;
/// Same seed as `DEMO_SEED` in `src/runtime/demo-stimulus.ts`.
const DEMO_SEED: u64 = 20_260_916;

type Packet = [f32; TELEMETRY_PACKET_LEN];

#[derive(Clone, Copy)]
enum InputSource {
    /// Port of `scriptedTelemetry` (the idle-fallback Lissajous path).
    Scripted,
    /// A fast, jittered drag with pressure: the busiest realistic pointer case.
    PointerActive,
    /// A pointer held still over the island.
    PointerIdle,
}

impl InputSource {
    const ALL: [Self; 3] = [Self::Scripted, Self::PointerActive, Self::PointerIdle];

    fn name(self) -> &'static str {
        match self {
            Self::Scripted => "scripted",
            Self::PointerActive => "pointer-active",
            Self::PointerIdle => "pointer-idle",
        }
    }

    fn packet(self, sequence: u64) -> Packet {
        let step = sequence as f64;
        match self {
            Self::Scripted => {
                let x = 0.5 + 0.38 * (step * 0.09).sin();
                let y = 0.5 + 0.3 * (step * 0.13 + 0.8).sin();
                let pressure = if sequence % 120 < 24 { 0.5 } else { 0.0 };
                [x as f32, y as f32, pressure]
            }
            Self::PointerActive => {
                // Triangle-wave sweeps of ~0.08 island/tick with LCG jitter,
                // pressed most of the time: high speed, acceleration, and
                // surprise on most channels.
                let jitter = lcg(sequence) * 0.03;
                let sweep = |period: f64| {
                    let phase = (step / period).fract();
                    if phase < 0.5 {
                        phase * 2.0
                    } else {
                        2.0 - phase * 2.0
                    }
                };
                let x = sweep(12.5) + jitter;
                let y = sweep(17.0) - jitter;
                let pressure = if sequence % 40 < 30 {
                    0.6 + jitter * 5.0
                } else {
                    0.0
                };
                [x as f32, y as f32, pressure as f32]
            }
            Self::PointerIdle => [0.42, 0.58, 0.0],
        }
    }
}

/// Deterministic jitter in `[-1, 1)`.
fn lcg(sequence: u64) -> f64 {
    let mixed = sequence
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1_442_695_040_888_963_407);
    ((mixed >> 11) as f64 / (1_u64 << 53) as f64) * 2.0 - 1.0
}

/// Mirror of the adapter's private `build_network` for the LIF-only v1 model.
fn lif_network(neurons: usize, channels: usize) -> SpikingNetwork {
    let mut network = SpikingNetwork::with_dimensions(neurons, 0, channels);
    let seed = 2.0 / channels as f32;
    for neuron in &mut network.neurons {
        neuron.weights = vec![seed; channels];
    }
    network
}

fn live_mesh() -> SynapticMesh {
    let graph = generate_small_world(
        LIVE_NEURONS,
        LIVE_FAN_OUT,
        LIVE_REWIRE,
        LIVE_MAX_DELAY,
        LIVE_INHIBITORY,
    )
    .expect("the live topology parameters are valid");
    SynapticMesh::new(graph)
}

/// Every stage's input, recorded from one real pipeline run.
struct Recording {
    packets: Vec<Packet>,
    features: Vec<[f32; ENCODER_CHANNELS]>,
    source_spikes: Vec<Vec<bool>>,
    currents: Vec<Vec<f32>>,
    encoded_spikes: u64,
    lif_spikes: u64,
}

fn record(source: InputSource, mode: EncoderMode, ticks: u64) -> Recording {
    let mut extractor = KineticExtractor::new();
    let mut encoder = V1Encoder::for_mode(mode);
    let mut mesh = live_mesh();
    let mut network = lif_network(LIVE_NEURONS, ENCODER_CHANNELS);
    let mut rng = StdRng::seed_from_u64(DEMO_SEED);
    let modulators = NeuroModulators::default();
    let mut recording = Recording {
        packets: Vec::new(),
        features: Vec::new(),
        source_spikes: Vec::new(),
        currents: Vec::new(),
        encoded_spikes: 0,
        lif_spikes: 0,
    };
    for sequence in 1..=ticks {
        let packet = source.packet(sequence);
        let features = extractor.extract(&packet);
        let channels = encoder.encode_step(&features);
        let mut spikes = vec![false; LIVE_NEURONS];
        for channel in &channels {
            spikes[usize::from(*channel)] = true;
        }
        let currents = mesh.propagate(&spikes).expect("live propagation succeeds");
        let fired = network
            .step_with_rng(&currents, &modulators, &mut rng)
            .expect("live neuromod step succeeds");
        recording.encoded_spikes += channels.len() as u64;
        recording.lif_spikes += fired.len() as u64;
        recording.packets.push(packet);
        recording.features.push(features);
        recording.source_spikes.push(spikes);
        recording.currents.push(currents);
    }
    recording
}

/// Batch timing: the median, min, and max of `runs` per-operation means.
#[derive(Clone, Copy)]
struct BatchStats {
    median_ns: f64,
    min_ns: f64,
    max_ns: f64,
}

fn batch<F: FnMut() -> u64>(runs: usize, ops: u64, mut run: F) -> BatchStats {
    // One untimed warm-up run.
    black_box(run());
    let mut means: Vec<f64> = (0..runs)
        .map(|_| {
            let start = Instant::now();
            black_box(run());
            start.elapsed().as_nanos() as f64 / ops as f64
        })
        .collect();
    means.sort_by(f64::total_cmp);
    BatchStats {
        median_ns: means[means.len() / 2],
        min_ns: means[0],
        max_ns: means[means.len() - 1],
    }
}

/// Per-tick distribution of individually timed operations.
#[derive(Clone, Copy)]
struct TickStats {
    p50_ns: f64,
    p95_ns: f64,
    p99_ns: f64,
    max_ns: f64,
}

fn tick_stats(mut samples: Vec<Duration>) -> TickStats {
    samples.sort();
    let at = |q: f64| {
        let index = ((samples.len() - 1) as f64 * q).round() as usize;
        samples[index].as_nanos() as f64
    };
    TickStats {
        p50_ns: at(0.5),
        p95_ns: at(0.95),
        p99_ns: at(0.99),
        max_ns: at(1.0),
    }
}

struct WorkloadResult {
    source: &'static str,
    mode: &'static str,
    ticks: u64,
    encoded_spikes_per_tick: f64,
    lif_spikes_per_tick: f64,
    extract: BatchStats,
    encode: BatchStats,
    propagate: BatchStats,
    snn_step: BatchStats,
    materialize: BatchStats,
    end_to_end: BatchStats,
    end_to_end_ticks: TickStats,
}

fn bench_workload(
    source: InputSource,
    mode: EncoderMode,
    ticks: u64,
    runs: usize,
) -> WorkloadResult {
    let recording = record(source, mode, ticks);
    let modulators = NeuroModulators::default();

    let extract = batch(runs, ticks, || {
        let mut extractor = KineticExtractor::new();
        let mut checksum = 0_u64;
        for packet in &recording.packets {
            checksum += black_box(extractor.extract(packet))[0].to_bits() as u64;
        }
        checksum
    });
    let encode = batch(runs, ticks, || {
        let mut encoder = V1Encoder::for_mode(mode);
        let mut checksum = 0_u64;
        for features in &recording.features {
            checksum += black_box(encoder.encode_step(features)).len() as u64;
        }
        checksum
    });
    let propagate = batch(runs, ticks, || {
        let mut mesh = live_mesh();
        let mut checksum = 0_u64;
        for spikes in &recording.source_spikes {
            let currents = mesh.propagate(spikes).expect("live propagation succeeds");
            checksum += black_box(currents)[0].to_bits() as u64;
        }
        checksum
    });
    let snn_step = batch(runs, ticks, || {
        let mut network = lif_network(LIVE_NEURONS, ENCODER_CHANNELS);
        let mut rng = StdRng::seed_from_u64(DEMO_SEED);
        let mut checksum = 0_u64;
        for currents in &recording.currents {
            let fired = network
                .step_with_rng(currents, &modulators, &mut rng)
                .expect("live neuromod step succeeds");
            checksum += black_box(fired).len() as u64;
        }
        checksum
    });

    // `state()` is what `step()` returns and what the WASM getters copy from:
    // it clones the potentials, spikes, features, and the full topology
    // projection every tick.
    let mut runtime = BrowserRuntime::with_mode(DEMO_SEED, mode, CONTRACT_VERSION_V5)
        .expect("the live runtime constructs");
    for (index, packet) in recording.packets.iter().take(64).enumerate() {
        runtime
            .input(index as u64 + 1, packet)
            .expect("recorded packets are valid");
        runtime.step().expect("live runtime steps");
    }
    let materialize = batch(runs, ticks, || {
        let mut checksum = 0_u64;
        for _ in 0..ticks {
            checksum += black_box(runtime.state()).topology_edge_sources.len() as u64;
        }
        checksum
    });

    let end_to_end = batch(runs, ticks, || {
        let mut runtime = BrowserRuntime::with_mode(DEMO_SEED, mode, CONTRACT_VERSION_V5)
            .expect("the live runtime constructs");
        let mut checksum = 0_u64;
        for (index, packet) in recording.packets.iter().enumerate() {
            runtime
                .input(index as u64 + 1, packet)
                .expect("recorded packets are valid");
            checksum += black_box(runtime.step().expect("live runtime steps")).completed_step;
        }
        checksum
    });

    let mut runtime = BrowserRuntime::with_mode(DEMO_SEED, mode, CONTRACT_VERSION_V5)
        .expect("the live runtime constructs");
    let mut samples = Vec::with_capacity(recording.packets.len());
    for (index, packet) in recording.packets.iter().enumerate() {
        let start = Instant::now();
        runtime
            .input(index as u64 + 1, packet)
            .expect("recorded packets are valid");
        black_box(runtime.step().expect("live runtime steps"));
        samples.push(start.elapsed());
    }

    WorkloadResult {
        source: source.name(),
        mode: mode.name(),
        ticks,
        encoded_spikes_per_tick: recording.encoded_spikes as f64 / ticks as f64,
        lif_spikes_per_tick: recording.lif_spikes as f64 / ticks as f64,
        extract,
        encode,
        propagate,
        snn_step,
        materialize,
        end_to_end,
        end_to_end_ticks: tick_stats(samples),
    }
}

struct ScaleResult {
    neurons: usize,
    fan_out: usize,
    synapses: usize,
    firing_fraction: f64,
    events_per_tick: f64,
    snapshot_bytes: usize,
    propagate: BatchStats,
    snn_step: BatchStats,
    materialize: BatchStats,
}

/// Deterministic source spikes at roughly `fraction` of neurons per tick.
fn synthetic_spikes(neurons: usize, ticks: u64, fraction: f64) -> Vec<Vec<bool>> {
    (0..ticks)
        .map(|tick| {
            (0..neurons)
                .map(|neuron| (lcg(tick * 1_000_003 + neuron as u64) + 1.0) / 2.0 < fraction)
                .collect()
        })
        .collect()
}

/// Bytes the contract's per-step snapshot carries for a topology this size:
/// potentials and spikes per neuron, the routed CSR plus canonical edge arrays
/// per synapse, and the two offset arrays. Strings and scalars are excluded.
fn snapshot_bytes(neurons: usize, synapses: usize, spikes: usize) -> usize {
    let per_neuron = 4 /* potential */ + 4 /* node id */ + 4 + 4 /* row + offset */;
    let per_synapse = (4 + 4 + 2) /* routed target, weight, delay */
        + (4 + 4 + 4 + 2 + 1 + 4) /* canonical source, target, weight, delay, polarity, bits */;
    neurons * per_neuron + 8 + synapses * per_synapse + spikes * 4 + ENCODER_CHANNELS * 4
}

fn bench_scale(
    neurons: usize,
    fan_out: usize,
    fraction: f64,
    ticks: u64,
    runs: usize,
) -> ScaleResult {
    let graph = generate_small_world(
        neurons,
        fan_out,
        LIVE_REWIRE,
        LIVE_MAX_DELAY,
        LIVE_INHIBITORY,
    )
    .expect("synthetic small-world parameters are valid");
    let synapses = graph.synapse_count();
    let projection = TopologyProjection::from_graph(&graph);
    let spikes = synthetic_spikes(neurons, ticks, fraction);
    let fired: usize = spikes
        .iter()
        .map(|tick| tick.iter().filter(|s| **s).count())
        .sum();
    let mean_fired = fired as f64 / ticks as f64;

    let mut currents_log = Vec::with_capacity(spikes.len());
    {
        let mut mesh = SynapticMesh::new(graph.clone());
        for tick in &spikes {
            currents_log.push(
                mesh.propagate(tick)
                    .expect("synthetic propagation succeeds"),
            );
        }
    }

    let propagate = batch(runs, ticks, || {
        let mut mesh = SynapticMesh::new(graph.clone());
        let mut checksum = 0_u64;
        for tick in &spikes {
            let currents = mesh
                .propagate(tick)
                .expect("synthetic propagation succeeds");
            checksum += black_box(currents)[0].to_bits() as u64;
        }
        checksum
    });
    let modulators = NeuroModulators::default();
    let snn_step = batch(runs, ticks, || {
        let mut network = lif_network(neurons, neurons);
        let mut rng = StdRng::seed_from_u64(DEMO_SEED);
        let mut checksum = 0_u64;
        for currents in &currents_log {
            let fired = network
                .step_with_rng(currents, &modulators, &mut rng)
                .expect("synthetic neuromod step succeeds");
            checksum += black_box(fired).len() as u64;
        }
        checksum
    });
    // The per-step clone the contract performs: the whole projection plus the
    // routed CSR arrays and per-neuron state.
    let potentials = vec![0.0_f32; neurons];
    let routed = SynapticMesh::new(graph.clone()).to_gpu_arrays();
    let materialize = batch(runs, ticks, || {
        let mut checksum = 0_u64;
        for _ in 0..ticks {
            let copy = black_box((projection.clone(), routed.clone(), potentials.clone()));
            checksum += copy.0.edge_sources.len() as u64;
        }
        checksum
    });

    ScaleResult {
        neurons,
        fan_out,
        synapses,
        firing_fraction: fraction,
        events_per_tick: mean_fired * fan_out as f64,
        snapshot_bytes: snapshot_bytes(neurons, synapses, mean_fired.round() as usize),
        propagate,
        snn_step,
        materialize,
    }
}

fn us(ns: f64) -> String {
    format!("{:.3}", ns / 1000.0)
}

fn json_batch(stats: BatchStats) -> String {
    format!(
        "{{\"median_ns\":{:.1},\"min_ns\":{:.1},\"max_ns\":{:.1}}}",
        stats.median_ns, stats.min_ns, stats.max_ns
    )
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let json = args.iter().any(|arg| arg == "--json");
    let quick = args.iter().any(|arg| arg == "--quick");
    let (ticks, runs, scale_ticks, scale_runs) = if quick {
        (200, 3, 50, 3)
    } else {
        (2_000, 15, 400, 7)
    };

    // Guard: the harness must time the topology the adapter actually ships.
    let shipped = BrowserRuntime::with_mode(DEMO_SEED, EncoderMode::DEFAULT, CONTRACT_VERSION_V5)
        .expect("the live runtime constructs")
        .state()
        .topology_digest;
    let harness = TopologyProjection::from_graph(live_mesh().graph()).topology_digest;
    assert_eq!(
        shipped, harness,
        "harness topology differs from the shipped adapter topology"
    );

    let modes = [EncoderMode::Delta, EncoderMode::Temporal, EncoderMode::Rate];
    let mut workloads = Vec::new();
    for source in InputSource::ALL {
        for mode in modes {
            workloads.push(bench_workload(source, mode, ticks, runs));
        }
    }

    let mut scales = Vec::new();
    for (neurons, fan_out) in [(16, 4), (64, 8), (256, 16), (1024, 32), (2048, 32)] {
        // The LIF bank costs O(neurons x channels) per step; keep large sizes
        // to a bounded wall-clock budget.
        let ticks = if neurons >= 1024 {
            scale_ticks / 4
        } else {
            scale_ticks
        };
        for fraction in [0.1, 0.5] {
            scales.push(bench_scale(neurons, fan_out, fraction, ticks, scale_runs));
        }
    }

    if json {
        let workload_json: Vec<String> = workloads
            .iter()
            .map(|w| {
                format!(
                    "{{\"source\":\"{}\",\"mode\":\"{}\",\"ticks\":{},\"encoded_spikes_per_tick\":{:.3},\"lif_spikes_per_tick\":{:.3},\"extract\":{},\"encode\":{},\"propagate\":{},\"snn_step\":{},\"materialize\":{},\"end_to_end\":{},\"end_to_end_ticks\":{{\"p50_ns\":{:.0},\"p95_ns\":{:.0},\"p99_ns\":{:.0},\"max_ns\":{:.0}}}}}",
                    w.source,
                    w.mode,
                    w.ticks,
                    w.encoded_spikes_per_tick,
                    w.lif_spikes_per_tick,
                    json_batch(w.extract),
                    json_batch(w.encode),
                    json_batch(w.propagate),
                    json_batch(w.snn_step),
                    json_batch(w.materialize),
                    json_batch(w.end_to_end),
                    w.end_to_end_ticks.p50_ns,
                    w.end_to_end_ticks.p95_ns,
                    w.end_to_end_ticks.p99_ns,
                    w.end_to_end_ticks.max_ns,
                )
            })
            .collect();
        let scale_json: Vec<String> = scales
            .iter()
            .map(|s| {
                format!(
                    "{{\"neurons\":{},\"fan_out\":{},\"synapses\":{},\"firing_fraction\":{},\"events_per_tick\":{:.1},\"snapshot_bytes\":{},\"propagate\":{},\"snn_step\":{},\"materialize\":{}}}",
                    s.neurons,
                    s.fan_out,
                    s.synapses,
                    s.firing_fraction,
                    s.events_per_tick,
                    s.snapshot_bytes,
                    json_batch(s.propagate),
                    json_batch(s.snn_step),
                    json_batch(s.materialize),
                )
            })
            .collect();
        println!(
            "{{\"target\":\"{}-{}\",\"ticks\":{ticks},\"runs\":{runs},\"workloads\":[{}],\"scale\":[{}]}}",
            std::env::consts::ARCH,
            std::env::consts::OS,
            workload_json.join(","),
            scale_json.join(",")
        );
        return;
    }

    let target = if cfg!(target_family = "wasm") {
        "wasm32-wasip1 under a WASI host".to_owned()
    } else {
        format!("native {}-{}", std::env::consts::ARCH, std::env::consts::OS)
    };
    println!(
        "# Contract-5 stage timing ({target}, release; median of {runs} runs x {ticks} ticks)"
    );
    println!(
        "| input | mode | enc spikes/tick | LIF spikes/tick | extract us | encode us | propagate us | SNN step us | materialize us | input+step us | input+step p95 us | p99 us | max us |"
    );
    println!("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for w in &workloads {
        println!(
            "| {} | {} | {:.2} | {:.2} | {} | {} | {} | {} | {} | {} | {} | {} | {} |",
            w.source,
            w.mode,
            w.encoded_spikes_per_tick,
            w.lif_spikes_per_tick,
            us(w.extract.median_ns),
            us(w.encode.median_ns),
            us(w.propagate.median_ns),
            us(w.snn_step.median_ns),
            us(w.materialize.median_ns),
            us(w.end_to_end.median_ns),
            us(w.end_to_end_ticks.p95_ns),
            us(w.end_to_end_ticks.p99_ns),
            us(w.end_to_end_ticks.max_ns),
        );
    }
    println!();
    println!(
        "# Synthetic topologies (NOT shipped; median of {scale_runs} runs x {scale_ticks} ticks, {} for >= 1024 neurons)",
        scale_ticks / 4
    );
    println!(
        "| neurons | fan-out | synapses | firing | events/tick | snapshot bytes | propagate us | SNN step us | materialize us |"
    );
    println!("|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for s in &scales {
        println!(
            "| {} | {} | {} | {:.0}% | {:.1} | {} | {} | {} | {} |",
            s.neurons,
            s.fan_out,
            s.synapses,
            s.firing_fraction * 100.0,
            s.events_per_tick,
            s.snapshot_bytes,
            us(s.propagate.median_ns),
            us(s.snn_step.median_ns),
            us(s.materialize.median_ns),
        );
    }
}
