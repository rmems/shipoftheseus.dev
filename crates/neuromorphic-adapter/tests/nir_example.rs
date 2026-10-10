//! Generator and guards for the bundled NIR example (GitHub #16 / RM-1653).
//!
//! The example graph is built here with the `nir-rs` graph API and written to
//! two committed files by the ignored `regenerate_nir_example` test:
//!
//! - `public/nir/lif-readout-example.v1.json` — the versioned browser envelope
//!   that the `/labs/nir/` page hands to the WASM adapter; and
//! - `src/data/nir/lif-readout-example.v1.inspection.json` — the projection
//!   `nir-rs` produces from that envelope, used for the build-time SVG.
//!
//! Expected bytes are never hand-edited. If the graph or upstream behavior
//! legitimately changes, bump `revision` and the file names, then regenerate:
//!
//! ```text
//! cargo +1.98.1 test --manifest-path crates/neuromorphic-adapter/Cargo.toml --locked --features nir --test nir_example regenerate_nir_example -- --ignored --exact
//! ```

use neuromorphic_adapter::nir::{
    MAX_ENVELOPE_BYTES, NIR_ENVELOPE_FORMAT, NIR_RS_VERSION, NirAssetOrigin, NirAssetProvenance,
    NirEnvelope, NirInspection, WasmNirInspection, canonical_json,
};
use nir_rs::nodes::{Affine, Input, Li, Lif, Linear, Output};
use nir_rs::{NirGraph, NirNode, Tensor};
use std::path::PathBuf;

const ENVELOPE_PATH: &str = "public/nir/lif-readout-example.v1.json";
const INSPECTION_PATH: &str = "src/data/nir/lif-readout-example.v1.inspection.json";
const ENVELOPE: &str = include_str!("../../../public/nir/lif-readout-example.v1.json");
const INSPECTION: &str =
    include_str!("../../../src/data/nir/lif-readout-example.v1.inspection.json");
const LOCKFILE: &str = include_str!("../Cargo.lock");

/// A deliberately small, hand-authored network: three inputs, an affine
/// projection into four LIF neurons, and a linear readout into two leaky
/// integrators. Every value is an illustrative constant chosen by hand; none
/// is trained, tuned, fitted, or measured.
fn example_graph() -> NirGraph {
    let f32s = |shape: Vec<usize>, values: Vec<f32>| {
        Tensor::from_f32(shape, values).expect("example tensor shape matches its data")
    };
    let f64s = |shape: Vec<usize>, values: Vec<f64>| {
        Tensor::from_f64(shape, values).expect("example tensor shape matches its data")
    };

    let mut graph = NirGraph::new();
    let mut insert = |name: &str, node: NirNode| {
        graph
            .insert_node(name, node)
            .expect("example node names are unique");
    };
    insert(
        "input",
        NirNode::Input(Input {
            shape: vec![3],
            metadata: Default::default(),
        }),
    );
    insert(
        "fc1",
        NirNode::Affine(Affine {
            weight: f32s(
                vec![4, 3],
                vec![
                    0.5, -0.25, 0.0, //
                    0.0, 0.5, -0.25, //
                    -0.25, 0.0, 0.5, //
                    0.25, 0.25, 0.25,
                ],
            ),
            bias: f32s(vec![4], vec![0.0, 0.0, 0.0, 0.125]),
            metadata: Default::default(),
        }),
    );
    insert(
        "lif1",
        NirNode::Lif(Lif {
            tau: f64s(vec![4], vec![0.02; 4]),
            r: f64s(vec![4], vec![1.0; 4]),
            v_leak: f64s(vec![4], vec![0.0; 4]),
            v_threshold: f64s(vec![4], vec![1.0; 4]),
            v_reset: Some(f64s(vec![4], vec![0.0; 4])),
            metadata: Default::default(),
        }),
    );
    insert(
        "fc2",
        NirNode::Linear(Linear {
            weight: f32s(
                vec![2, 4],
                vec![
                    1.0, 0.0, 1.0, 0.0, //
                    0.0, 1.0, 0.0, 1.0,
                ],
            ),
            metadata: Default::default(),
        }),
    );
    insert(
        "li1",
        NirNode::Li(Li {
            tau: f64s(vec![2], vec![0.05; 2]),
            r: f64s(vec![2], vec![1.0; 2]),
            v_leak: f64s(vec![2], vec![0.0; 2]),
            metadata: Default::default(),
        }),
    );
    insert(
        "output",
        NirNode::Output(Output {
            shape: vec![2],
            metadata: Default::default(),
        }),
    );
    for (source, target) in [
        ("input", "fc1"),
        ("fc1", "lif1"),
        ("lif1", "fc2"),
        ("fc2", "li1"),
        ("li1", "output"),
    ] {
        graph.add_edge(source, target);
    }
    graph
}

fn example_envelope() -> NirEnvelope {
    NirEnvelope::new(
        NirAssetProvenance {
            id: "lif-readout-example".to_owned(),
            revision: 1,
            title: "LIF layer with a leaky-integrator readout".to_owned(),
            summary: "Hand-authored example: three inputs, an affine projection into four LIF neurons, and a linear readout into two leaky integrators. Parameters are illustrative constants; nothing is trained or measured.".to_owned(),
            origin: NirAssetOrigin::HandAuthoredExample,
            generator: "crates/neuromorphic-adapter/tests/nir_example.rs".to_owned(),
            regenerate: "cargo +1.98.1 test --manifest-path crates/neuromorphic-adapter/Cargo.toml --locked --features nir --test nir_example regenerate_nir_example -- --ignored --exact".to_owned(),
        },
        example_graph(),
    )
}

fn generated_envelope() -> String {
    canonical_json(&example_envelope()).expect("example envelope serializes")
}

#[test]
fn committed_envelope_matches_the_generator() {
    assert_eq!(
        ENVELOPE,
        generated_envelope(),
        "{ENVELOPE_PATH} drifted from the generator; regenerate it (see module docs)"
    );
}

#[test]
fn committed_projection_matches_the_nir_rs_parse_of_the_committed_envelope() {
    let inspection = NirInspection::parse(ENVELOPE).expect("committed envelope parses");
    assert_eq!(
        INSPECTION,
        inspection.to_canonical_json(),
        "{INSPECTION_PATH} drifted from the nir-rs projection; regenerate it (see module docs)"
    );
}

#[test]
fn the_wasm_handle_returns_the_committed_projection() {
    let handle = WasmNirInspection::parse(ENVELOPE).expect("committed envelope parses");
    assert_eq!(handle.inspection_json(), INSPECTION);
    assert_eq!(handle.node_count(), 6);
    assert_eq!(handle.edge_count(), 5);
    assert_eq!(handle.nir_rs_version(), NIR_RS_VERSION);
    let lif: serde_json::Value =
        serde_json::from_str(&handle.node_json("lif1").expect("lif1 exists")).expect("node json");
    assert_eq!(lif["operator"], "LIF");
    assert_eq!(lif["inputs"], serde_json::json!(["fc1"]));
    assert_eq!(lif["outputs"], serde_json::json!(["fc2"]));
}

#[test]
fn the_example_is_small_valid_and_labelled_as_hand_authored() {
    let envelope = example_envelope();
    envelope
        .graph
        .validate_structure()
        .expect("valid structure");
    envelope
        .graph
        .validate_parameters()
        .expect("valid parameters");
    assert_eq!(envelope.format, NIR_ENVELOPE_FORMAT);
    assert_eq!(envelope.asset.origin, NirAssetOrigin::HandAuthoredExample);
    assert!(ENVELOPE.len() < MAX_ENVELOPE_BYTES);
    assert!(ENVELOPE.contains("\"origin\": \"hand-authored-example\""));

    let inspection = NirInspection::from_envelope(envelope).expect("example projects");
    let operators: Vec<(&str, &str, u32)> = inspection
        .nodes
        .iter()
        .map(|node| (node.name.as_str(), node.operator, node.layer))
        .collect();
    assert_eq!(
        operators,
        [
            ("input", "Input", 0),
            ("fc1", "Affine", 1),
            ("lif1", "LIF", 2),
            ("fc2", "Linear", 3),
            ("li1", "LI", 4),
            ("output", "Output", 5),
        ]
    );
    assert_eq!(inspection.layer_count, 6);
    assert_eq!(inspection.max_rows, 1);

    let fc1 = inspection.node("fc1").expect("fc1 exists");
    let weight = &fc1.parameters[0];
    assert_eq!(
        (weight.name.as_str(), weight.kind, weight.dtype),
        ("weight", "tensor", Some("f32"))
    );
    assert_eq!(weight.shape, [4, 3]);
    assert_eq!(weight.value_count, 12);
    assert_eq!(weight.values[1], "-0.25");
}

#[test]
fn the_envelope_pins_the_exact_locked_nir_rs_release() {
    let pinned = format!("name = \"nir-rs\"\nversion = \"{NIR_RS_VERSION}\"");
    assert!(
        LOCKFILE.replace("\r\n", "\n").contains(&pinned),
        "NIR_RS_VERSION must match the locked nir-rs release"
    );
    assert!(ENVELOPE.contains(&format!("\"nir_rs_version\": \"{NIR_RS_VERSION}\"")));
}

fn workspace_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(relative)
}

/// Regenerate both committed files (see module docs for the command).
#[test]
#[ignore]
fn regenerate_nir_example() {
    let envelope = generated_envelope();
    let inspection = NirInspection::parse(&envelope)
        .expect("generated envelope parses")
        .to_canonical_json();
    for (relative, text) in [(ENVELOPE_PATH, envelope), (INSPECTION_PATH, inspection)] {
        let path = workspace_path(relative);
        std::fs::create_dir_all(path.parent().expect("asset directory")).expect("create dir");
        std::fs::write(&path, text).expect("write committed NIR asset");
    }
}
