//! Fail-closed parsing and projection rules for NIR inspection envelopes.

use neuromorphic_adapter::nir::{
    MAX_ENVELOPE_BYTES, MAX_PREVIEW_VALUES, NirInspection, canonical_json,
};
use serde_json::{Value, json};

const ENVELOPE: &str = include_str!("../../../public/nir/lif-readout-example.v1.json");

fn envelope() -> Value {
    serde_json::from_str(ENVELOPE).expect("committed envelope is JSON")
}

fn error_code(value: &Value) -> &'static str {
    NirInspection::parse(&value.to_string())
        .expect_err("envelope must be rejected")
        .code
}

#[test]
fn rejects_unknown_formats_versions_and_nir_rs_releases() {
    let mut wrong_format = envelope();
    wrong_format["format"] = json!("nir-json");
    assert_eq!(error_code(&wrong_format), "nir-envelope-unsupported-format");

    let mut wrong_version = envelope();
    wrong_version["format_version"] = json!(2);
    assert_eq!(
        error_code(&wrong_version),
        "nir-envelope-unsupported-version"
    );

    let mut other_release = envelope();
    other_release["nir_rs_version"] = json!("0.4.4");
    assert_eq!(error_code(&other_release), "nir-rs-version-mismatch");
}

#[test]
fn rejects_unknown_envelope_fields_and_unknown_origins() {
    let mut extra = envelope();
    extra["trained"] = json!(true);
    assert_eq!(error_code(&extra), "nir-envelope-invalid");

    let mut trained = envelope();
    trained["asset"]["origin"] = json!("trained-model");
    assert_eq!(error_code(&trained), "nir-envelope-invalid");
}

#[test]
fn rejects_nodes_outside_the_closed_nir_rs_node_set() {
    let mut unknown = envelope();
    unknown["graph"]["nodes"]["lif1"]["type"] = json!("CurrLIF");
    assert_eq!(error_code(&unknown), "nir-envelope-invalid");
}

#[test]
fn rejects_tensors_whose_shape_does_not_match_their_data() {
    let mut mismatched = envelope();
    mismatched["graph"]["nodes"]["fc1"]["weight"]["shape"] = json!([3, 3]);
    assert_eq!(error_code(&mismatched), "nir-envelope-invalid");
}

#[test]
fn delegates_structure_validation_to_nir_rs() {
    let mut dangling = envelope();
    dangling["graph"]["edges"]
        .as_array_mut()
        .expect("edge list")
        .push(json!(["lif1", "ghost"]));
    let error = NirInspection::parse(&dangling.to_string()).expect_err("dangling edge");
    assert_eq!(error.code, "nir-graph-invalid-structure");
    assert!(error.message.contains("missing node: ghost"));

    let mut duplicate = envelope();
    duplicate["graph"]["edges"]
        .as_array_mut()
        .expect("edge list")
        .push(json!(["input", "fc1"]));
    assert_eq!(error_code(&duplicate), "nir-graph-invalid-structure");

    let mut empty = envelope();
    empty["graph"]["nodes"] = json!({});
    empty["graph"]["edges"] = json!([]);
    assert_eq!(error_code(&empty), "nir-graph-empty");
}

#[test]
fn rejects_oversize_input_before_parsing() {
    let oversize = " ".repeat(MAX_ENVELOPE_BYTES + 1);
    assert_eq!(
        NirInspection::parse(&oversize).expect_err("oversize").code,
        "nir-envelope-too-large"
    );
}

#[test]
fn cycles_are_laid_out_without_hiding_any_node() {
    let mut recurrent = envelope();
    recurrent["graph"]["edges"]
        .as_array_mut()
        .expect("edge list")
        .push(json!(["lif1", "fc1"]));
    let inspection = NirInspection::parse(&recurrent.to_string()).expect("NIR allows cycles");
    assert_eq!(inspection.nodes.len(), 6);
    let input = inspection.node("input").expect("input");
    assert_eq!(input.layer, 0);
    let fc1 = inspection.node("fc1").expect("fc1");
    let lif1 = inspection.node("lif1").expect("lif1");
    assert_eq!(fc1.layer, lif1.layer, "cycle members share one layer");
    assert_ne!(fc1.row, lif1.row, "cycle members get distinct rows");
    assert!(fc1.inputs.contains(&"lif1".to_owned()));

    // Operators downstream of the cycle keep their forward order.
    let layers: Vec<(&str, u32)> = inspection
        .nodes
        .iter()
        .map(|node| (node.name.as_str(), node.layer))
        .collect();
    assert_eq!(
        layers,
        [
            ("input", 0),
            ("fc1", 1),
            ("lif1", 1),
            ("fc2", 2),
            ("li1", 3),
            ("output", 4),
        ]
    );
    assert_eq!(inspection.layer_count, 5);
    assert_eq!(inspection.max_rows, 2);
}

#[test]
fn nodes_after_a_cycle_are_laid_out_after_it() {
    // input -> a -> b -> a, with b -> readout -> output after the cycle.
    let mut graph = envelope();
    graph["graph"]["edges"] = json!([
        ["input", "fc1"],
        ["fc1", "lif1"],
        ["lif1", "fc1"],
        ["lif1", "fc2"],
        ["fc2", "li1"],
        ["li1", "output"],
    ]);
    let inspection = NirInspection::parse(&graph.to_string()).expect("NIR allows cycles");
    let layer = |name: &str| inspection.node(name).expect(name).layer;
    assert_eq!(layer("fc1"), layer("lif1"));
    assert!(layer("fc2") > layer("lif1"));
    assert!(layer("li1") > layer("fc2"));
    assert!(layer("output") > layer("li1"));

    // A self-loop and a two-node cycle with no source still lay out.
    let mut loops = envelope();
    loops["graph"]["edges"] = json!([
        ["input", "input"],
        ["fc1", "lif1"],
        ["lif1", "fc1"],
        ["lif1", "fc2"],
    ]);
    let inspection = NirInspection::parse(&loops.to_string()).expect("NIR allows cycles");
    let layer = |name: &str| inspection.node(name).expect(name).layer;
    assert_eq!(layer("input"), 0);
    assert_eq!(layer("fc1"), layer("lif1"));
    assert_eq!(layer("fc2"), layer("lif1") + 1);
}

#[test]
fn metadata_is_rendered_sorted_and_large_tensors_are_previewed() {
    let mut annotated = envelope();
    annotated["graph"]["nodes"]["fc1"]["metadata"] = json!({
        "zeta": { "String": "last" },
        "alpha": { "I64": 7 },
        "flag": { "Bool": true },
    });
    let values: Vec<f32> = (0..100).map(|value| value as f32).collect();
    annotated["graph"]["nodes"]["fc2"]["weight"] = json!({
        "shape": [2, 50],
        "data": { "F32": values },
    });
    annotated["graph"]["nodes"]["output"]["shape"] = json!([2]);

    let inspection = NirInspection::parse(&annotated.to_string()).expect("annotated graph");
    let fc1 = inspection.node("fc1").expect("fc1");
    let keys: Vec<&str> = fc1
        .metadata
        .iter()
        .map(|field| field.name.as_str())
        .collect();
    assert_eq!(keys, ["alpha", "flag", "zeta"]);
    assert_eq!(fc1.metadata[0].values, ["7"]);

    let fc2 = inspection.node("fc2").expect("fc2");
    assert_eq!(fc2.parameters[0].value_count, 100);
    assert_eq!(fc2.parameters[0].values.len(), MAX_PREVIEW_VALUES);

    // Canonical output is independent of `HashMap` iteration order.
    let first = inspection.to_canonical_json();
    let second = NirInspection::parse(&annotated.to_string())
        .expect("annotated graph")
        .to_canonical_json();
    assert_eq!(first, second);
    assert_eq!(first, canonical_json(&inspection).expect("canonical"));
}
