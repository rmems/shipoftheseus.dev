//! Recorded `corpus-ipc` wire-v1 fixtures for the `/protocol/` viewer.
//!
//! The committed envelopes in `public/protocol/fixtures/v1/` are encoded by
//! `corpus-ipc` itself (`WireEnvelope::encode_json`) from a deterministic
//! adapter replay of the contract-5 golden
//! `tests/fixtures/kinetic-seed9-trace.json`. They are derived from that
//! replay; they are not captures from hardware or a live service. The out-of-
//! band SHA-256 manifest sits next to them in `manifest.json`.
//!
//! Never hand-edit the fixtures or the manifest. Regenerate them with:
//!
//! ```text
//! cargo test --locked --test protocol_fixtures regenerate_protocol_fixtures -- --ignored --exact
//! ```

use std::collections::HashMap;
use std::path::PathBuf;

use corpus_ipc::{
    BatchMetadata, IpcMessage, SpikeBatch, SpikeEvent, StimulusBatch, TraceBatch,
    WireCompatibility, WireEnvelope,
};
use neuromorphic_adapter::protocol::{
    MAX_PROTOCOL_FIXTURE_BYTES, ProtocolVariant, inspect_protocol_fixture,
};
use neuromorphic_adapter::{
    BrowserRuntime, BrowserState, CONTRACT_VERSION_V5, encoder::EncoderMode,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const SOURCE_TRACE: &str = include_str!("fixtures/kinetic-seed9-trace.json");
const SOURCE_TRACE_PATH: &str =
    "crates/neuromorphic-adapter/tests/fixtures/kinetic-seed9-trace.json";
const GENERATOR_PATH: &str = "crates/neuromorphic-adapter/tests/protocol_fixtures.rs";
const FIXTURE_DIR: &str = "../../public/protocol/fixtures/v1";

/// `2^53 + 1`: the smallest integer a JavaScript `Number` cannot represent.
/// Every fixture carries it as the correlation `batch_id`, so a lossy
/// `Number`/`JSON.parse` path would visibly print `9007199254740992`.
pub const CORRELATION_BATCH_ID: u64 = (1 << 53) + 1;
const _: () = assert!(
    CORRELATION_BATCH_ID > (1 << 53),
    "beyond Number.MAX_SAFE_INTEGER"
);
const SESSION_ID: &str = "kinetic-seed9-golden";
/// Deterministic replay has no wall clock; `0` declares "no time basis".
const TIMESTAMP_NS: u64 = 0;
/// The adapter exports binary spikes; `1.0` marks one, not a measured amplitude.
const BINARY_SPIKE_STRENGTH: f32 = 1.0;
const TRACE_NEURON: usize = 0;

struct Fixture {
    id: String,
    variant: ProtocolVariant,
    message: IpcMessage,
    derivation: String,
}

impl Fixture {
    fn file(&self) -> String {
        format!("{}.json", self.id)
    }

    fn bytes(&self) -> Vec<u8> {
        WireEnvelope::new(&self.message)
            .encode_json()
            .expect("corpus-ipc encodes the fixture")
    }
}

/// The replayed tick every fixture describes, plus its eligibility rows.
struct ReplayedTick {
    state: BrowserState,
    traces: Vec<corpus_ipc::TraceData>,
}

/// Replay the contract-5 golden until the network first fires.
fn replay_first_firing_tick() -> ReplayedTick {
    let fixture: Value = serde_json::from_str(SOURCE_TRACE).expect("golden trace parses");
    assert_eq!(fixture["config"], json!([5]), "source golden is contract 5");
    let seed: u64 = fixture["seed"]
        .as_str()
        .and_then(|seed| seed.parse().ok())
        .expect("decimal seed");
    let mut runtime = BrowserRuntime::with_mode(seed, EncoderMode::DEFAULT, CONTRACT_VERSION_V5)
        .expect("fixed topology is valid");

    for operation in fixture["operations"].as_array().expect("operation list") {
        match operation["op"].as_str().expect("operation kind") {
            "input" => {
                let sequence: u64 = operation["sequence"]
                    .as_str()
                    .and_then(|sequence| sequence.parse().ok())
                    .expect("decimal sequence");
                let samples: Vec<f32> = operation["samples"]
                    .as_array()
                    .expect("sample array")
                    .iter()
                    .map(|sample| sample.as_f64().expect("finite sample") as f32)
                    .collect();
                runtime
                    .input(sequence, &samples)
                    .expect("input is accepted");
            }
            "step" => {
                let state = runtime.step().expect("runtime can advance");
                if !state.spike_neurons.is_empty() {
                    let traces = runtime
                        .eligibility_trace_rows(TRACE_NEURON)
                        .expect("neuron 0 fired, so it has a spike time");
                    return ReplayedTick { state, traces };
                }
            }
            other => panic!("unknown operation {other}"),
        }
    }
    panic!("the contract-5 golden must make the network fire");
}

fn replay_metadata(step: u64) -> Option<BatchMetadata> {
    Some(BatchMetadata {
        // Not measured: deterministic replay records no latency.
        processing_latency_ns: None,
        source: Some(format!(
            "neuromorphic-adapter replay of {SOURCE_TRACE_PATH}"
        )),
        // A single entry keeps the encoded bytes independent of HashMap order.
        custom: HashMap::from([("completed_step".to_owned(), step.to_string())]),
    })
}

fn fixtures() -> (u64, Vec<Fixture>) {
    let tick = replay_first_firing_tick();
    let step = tick.state.completed_step;
    let prefix = format!("kinetic-seed9-step{step}");

    let stimuli = Fixture {
        id: format!("{prefix}-stimuli"),
        variant: ProtocolVariant::Stimuli,
        message: IpcMessage::Stimuli(StimulusBatch {
            session_id: Some(SESSION_ID.to_owned()),
            batch_id: CORRELATION_BATCH_ID,
            timestamp: TIMESTAMP_NS,
            values: tick.state.encoder_features.clone(),
            valid_mask: None,
            metadata: replay_metadata(step),
        }),
        derivation: format!(
            "Derived from a deterministic adapter replay, not captured from hardware or a live service. values are the 16 clamped kinetic-signals features the adapter handed to axon-encoder for completed step {step} of the committed contract-5 golden (seed 9). batch_id is assigned (2^53 + 1); timestamp is 0 because replay has no wall clock."
        ),
    };

    let spikes = Fixture {
        id: format!("{prefix}-spikes"),
        variant: ProtocolVariant::Spikes,
        message: IpcMessage::Spikes(SpikeBatch {
            session_id: Some(SESSION_ID.to_owned()),
            batch_id: CORRELATION_BATCH_ID,
            timestamp: TIMESTAMP_NS,
            spikes: tick
                .state
                .spike_neurons
                .iter()
                .map(|neuron| SpikeEvent {
                    channel: u16::try_from(*neuron).expect("neuron index fits u16"),
                    time: u32::try_from(step).expect("step fits u32"),
                    strength: BINARY_SPIKE_STRENGTH,
                })
                .collect(),
            metadata: replay_metadata(step),
        }),
        derivation: format!(
            "Derived from the same replay, not captured from hardware or a live service. Each event is a neuromod LIF spike emitted at completed step {step}: channel is the neuron index and time is the step. strength 1.0 marks a binary spike; the adapter does not export spike amplitude."
        ),
    };

    let traces = Fixture {
        id: format!("{prefix}-eligibility-traces"),
        variant: ProtocolVariant::EligibilityTraces,
        message: IpcMessage::EligibilityTraces(TraceBatch {
            session_id: SESSION_ID.to_owned(),
            batch_id: CORRELATION_BATCH_ID,
            traces: tick.traces,
        }),
        derivation: format!(
            "Derived from the same replay, not captured from hardware or a live service. Rows are neuromod's per-synapse eligibility traces for LIF neuron {TRACE_NEURON}'s 16 input channels after completed step {step}; last_spike_time is that neuron's neuromod step of its most recent spike."
        ),
    };

    (step, vec![stimuli, spikes, traces])
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn manifest(step: u64, fixtures: &[Fixture]) -> Value {
    json!({
        "schema": "shipoftheseus.protocol-fixtures",
        "schema_version": 1,
        "wire_version": WireCompatibility::CURRENT,
        "generator": GENERATOR_PATH,
        "source_trace": SOURCE_TRACE_PATH,
        "source_step": step,
        "fixtures": fixtures
            .iter()
            .map(|fixture| {
                let bytes = fixture.bytes();
                json!({
                    "id": fixture.id,
                    "file": fixture.file(),
                    "variant": fixture.variant.name(),
                    "bytes": bytes.len(),
                    "sha256": sha256_hex(&bytes),
                    "derivation": fixture.derivation,
                })
            })
            .collect::<Vec<_>>(),
    })
}

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(FIXTURE_DIR)
}

fn committed_manifest() -> Value {
    let text = std::fs::read_to_string(fixture_dir().join("manifest.json"))
        .expect("committed manifest.json is readable");
    serde_json::from_str(&text).expect("committed manifest.json parses")
}

#[test]
fn committed_fixtures_are_reproducible_corpus_ipc_encodings() {
    let (_, fixtures) = fixtures();
    for fixture in &fixtures {
        let committed = std::fs::read(fixture_dir().join(fixture.file()))
            .unwrap_or_else(|error| panic!("{} is readable: {error}", fixture.file()));
        assert_eq!(
            committed,
            fixture.bytes(),
            "{} drifted from its corpus-ipc encoding; regenerate it",
            fixture.file()
        );
    }
}

#[test]
fn committed_manifest_records_the_exact_fixture_digests() {
    let (step, fixtures) = fixtures();
    assert_eq!(committed_manifest(), manifest(step, &fixtures));
}

#[test]
fn every_committed_fixture_is_accepted_by_the_real_ingress() {
    let manifest = committed_manifest();
    let entries = manifest["fixtures"].as_array().expect("fixture list");
    let variants: Vec<&str> = entries
        .iter()
        .map(|entry| entry["variant"].as_str().expect("variant"))
        .collect();
    assert_eq!(variants, ["Stimuli", "Spikes", "EligibilityTraces"]);

    for entry in entries {
        let file = entry["file"].as_str().expect("file");
        let bytes = std::fs::read(fixture_dir().join(file)).expect("fixture is readable");
        assert!(bytes.len() <= MAX_PROTOCOL_FIXTURE_BYTES);
        let inspection = inspect_protocol_fixture(
            &bytes,
            entry["sha256"].as_str().expect("sha256"),
            entry["variant"].as_str().expect("variant"),
        )
        .unwrap_or_else(|error| panic!("{file} must be accepted: {error}"));
        assert_eq!(inspection.wire_version, WireCompatibility::CURRENT);
        assert_eq!(inspection.batch_id(), CORRELATION_BATCH_ID);
        assert_eq!(inspection.session_id(), Some(SESSION_ID));
        assert!(
            inspection.canonical_matches_input,
            "{file} must be the canonical corpus-ipc encoding"
        );
        assert_eq!(
            inspection.byte_length,
            entry["bytes"].as_u64().expect("bytes") as usize
        );
    }
}

#[test]
fn fixtures_describe_one_real_replayed_tick() {
    let tick = replay_first_firing_tick();
    assert_eq!(tick.state.encoder_features.len(), 16);
    assert!(
        tick.state
            .encoder_features
            .iter()
            .all(|feature| (0.0..=1.0).contains(feature))
    );
    assert!(!tick.state.spike_neurons.is_empty());
    assert_eq!(tick.traces.len(), 16, "one row per input channel");
    assert!(
        tick.traces.iter().any(|row| row.trace_value != 0.0),
        "the replayed tick must carry non-zero upstream eligibility"
    );
}

#[test]
#[ignore = "regenerates the committed protocol fixtures"]
fn regenerate_protocol_fixtures() {
    let (step, fixtures) = fixtures();
    let directory = fixture_dir();
    std::fs::create_dir_all(&directory).expect("fixture directory");
    for fixture in &fixtures {
        std::fs::write(directory.join(fixture.file()), fixture.bytes()).expect("write fixture");
    }
    let mut text =
        serde_json::to_string_pretty(&manifest(step, &fixtures)).expect("manifest encodes");
    text.push('\n');
    std::fs::write(directory.join("manifest.json"), text).expect("write manifest");
}
