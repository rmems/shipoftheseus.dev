//! NIR network inspection for the `/labs/nir/` page (GitHub #16 / Linear
//! RM-1653).
//!
//! `nir-rs` is the source of truth for NIR graph semantics: the node set and
//! its wire type names ([`NirNode::type_name`]), field names, tensor shapes and
//! dtypes, and structural/parameter validation. The adapter owns only:
//!
//! - a versioned browser transport **envelope** ([`NirEnvelope`]) that wraps
//!   the Serde representation of [`NirGraph`] at the exact pinned `nir-rs`
//!   release ([`NIR_RS_VERSION`]) together with the asset's provenance; and
//! - a read-only **inspection projection** ([`NirInspection`]): nodes, edges,
//!   and the presentation-only layer layout the page draws.
//!
//! The browser never links native HDF5. `nir-rs` is built with
//! `default-features = false, features = ["serde"]`; HDF5 `.nir` files remain
//! the interchange format and are converted outside the browser (see
//! `docs/architecture/browser-runtime.md`). Upstream documents its Serde form
//! as a debug/test representation rather than a NIR interchange standard, so
//! the envelope accepts it only for the exact `nir-rs` release it was written
//! with and a byte-for-byte generator test guards the committed asset.

use std::collections::{HashMap, VecDeque};

use nir_rs::io::wire::padding_as_wire_str;
use nir_rs::nodes::Padding;
use nir_rs::{MetadataValue, NirGraph, NirNode, Tensor, TensorData};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use wasm_bindgen::prelude::*;

/// Envelope format identifier for bundled NIR graph assets.
pub const NIR_ENVELOPE_FORMAT: &str = "shipoftheseus.nir-graph";
/// Envelope schema version. Changing the envelope shape requires a new version.
pub const NIR_ENVELOPE_VERSION: u32 = 1;
/// Inspection projection identifier.
pub const NIR_INSPECTION_FORMAT: &str = "shipoftheseus.nir-inspection";
/// Inspection projection schema version.
pub const NIR_INSPECTION_VERSION: u32 = 1;
/// Exact `nir-rs` release whose Serde graph representation the envelope
/// carries. Must match the `=x.y.z` pin in `Cargo.toml`.
pub const NIR_RS_VERSION: &str = "0.4.5";
/// Fail-closed bound on envelope text accepted by [`NirInspection::parse`].
pub const MAX_ENVELOPE_BYTES: usize = 256 * 1024;
/// Fail-closed bound on top-level nodes the inspector lays out.
pub const MAX_NODES: usize = 64;
/// Fail-closed bound on top-level edges the inspector lays out.
pub const MAX_EDGES: usize = 256;
/// Tensor elements rendered per parameter; `value_count` keeps the total.
pub const MAX_PREVIEW_VALUES: usize = 64;

/// How a bundled asset came to exist. Version 1 accepts only hand-authored
/// examples; a converted `.nir` import would need a new, explicit variant with
/// its own source provenance.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NirAssetOrigin {
    /// Built by hand with the `nir-rs` graph API. Not trained, tuned, or
    /// measured; parameters are illustrative constants.
    HandAuthoredExample,
}

// Every struct serialized into the inspection projection declares its fields
// in alphabetical order, so direct `serde_json` output is already canonical
// (sorted keys). `canonical_json` would produce the same bytes — a test
// asserts it — but its `serde_json::Value` round trip costs ~70 KB of WASM.

/// Provenance carried next to the graph in every bundled asset.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NirAssetProvenance {
    /// Repository path of the code that generated the asset.
    pub generator: String,
    /// Stable asset identifier (also the file-name stem).
    pub id: String,
    pub origin: NirAssetOrigin,
    /// Command that regenerates the committed asset bytes.
    pub regenerate: String,
    /// Content revision of this asset; bump it (and the file name) when the
    /// graph changes.
    pub revision: u32,
    pub summary: String,
    pub title: String,
}

/// Versioned browser transport for a NIR graph.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NirEnvelope {
    pub format: String,
    pub format_version: u32,
    pub nir_rs_version: String,
    pub asset: NirAssetProvenance,
    /// `nir-rs` owns this representation.
    pub graph: NirGraph,
}

impl NirEnvelope {
    /// Wrap a graph in the current envelope version.
    pub fn new(asset: NirAssetProvenance, graph: NirGraph) -> Self {
        Self {
            format: NIR_ENVELOPE_FORMAT.to_owned(),
            format_version: NIR_ENVELOPE_VERSION,
            nir_rs_version: NIR_RS_VERSION.to_owned(),
            asset,
            graph,
        }
    }
}

/// Stable, fail-closed inspection errors. `code` is the UI status channel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NirInspectionError {
    pub code: &'static str,
    pub message: String,
}

impl NirInspectionError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for NirInspectionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for NirInspectionError {}

/// One named field of a node (a NIR parameter or a metadata entry), described
/// from the typed `nir-rs` value. Values are formatted in Rust so the browser
/// never reinterprets numbers.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NirFieldView {
    /// Element type: `f32`, `f64`, `i64`, `bool`, `usize`, or `string`.
    pub dtype: Option<&'static str>,
    /// `tensor`, `extents`, `integer`, `padding`, `float`, `boolean`,
    /// `string`, `strings`, `subgraph`, `absent`, or `unrecognized`.
    pub kind: &'static str,
    pub name: String,
    pub shape: Vec<usize>,
    pub value_count: usize,
    /// At most [`MAX_PREVIEW_VALUES`] Rust-formatted values in C order.
    pub values: Vec<String>,
}

/// One top-level node of the inspected graph.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NirNodeView {
    pub inputs: Vec<String>,
    /// Presentation-only column: longest path from a source node.
    pub layer: u32,
    /// Free-form NIR metadata, sorted by key.
    pub metadata: Vec<NirFieldView>,
    pub name: String,
    /// Exact NIR wire type string from [`NirNode::type_name`].
    pub operator: &'static str,
    pub outputs: Vec<String>,
    pub parameters: Vec<NirFieldView>,
    /// Presentation-only row within the layer, in graph insertion order.
    pub row: u32,
}

/// One directed NIR edge, in graph order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NirEdgeView {
    pub source: String,
    pub target: String,
}

/// Read-only projection of a validated NIR graph for static rendering and
/// interactive inspection.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NirInspection {
    pub asset: NirAssetProvenance,
    pub edges: Vec<NirEdgeView>,
    pub format: &'static str,
    pub format_version: u32,
    pub graph_metadata: Vec<NirFieldView>,
    pub layer_count: u32,
    pub max_rows: u32,
    pub nir_rs_version: &'static str,
    /// NIR version string stored in the graph, if any.
    pub nir_version: Option<String>,
    pub nodes: Vec<NirNodeView>,
}

impl NirInspection {
    /// Parse and validate an envelope, then project it. Fails closed on
    /// oversize input, malformed JSON, unknown envelope fields or versions, a
    /// different `nir-rs` release, and any `nir-rs` validation error.
    pub fn parse(envelope_json: &str) -> Result<Self, NirInspectionError> {
        if envelope_json.len() > MAX_ENVELOPE_BYTES {
            return Err(NirInspectionError::new(
                "nir-envelope-too-large",
                format!("envelope exceeds {MAX_ENVELOPE_BYTES} bytes"),
            ));
        }
        let envelope: NirEnvelope = serde_json::from_str(envelope_json)
            .map_err(|error| NirInspectionError::new("nir-envelope-invalid", format!("{error}")))?;
        Self::from_envelope(envelope)
    }

    /// Validate an already-decoded envelope and project it.
    pub fn from_envelope(envelope: NirEnvelope) -> Result<Self, NirInspectionError> {
        if envelope.format != NIR_ENVELOPE_FORMAT {
            return Err(NirInspectionError::new(
                "nir-envelope-unsupported-format",
                format!("expected format {NIR_ENVELOPE_FORMAT}"),
            ));
        }
        if envelope.format_version != NIR_ENVELOPE_VERSION {
            return Err(NirInspectionError::new(
                "nir-envelope-unsupported-version",
                format!("expected format_version {NIR_ENVELOPE_VERSION}"),
            ));
        }
        if envelope.nir_rs_version != NIR_RS_VERSION {
            return Err(NirInspectionError::new(
                "nir-rs-version-mismatch",
                format!(
                    "asset was written with nir-rs {}, this adapter links nir-rs {NIR_RS_VERSION}",
                    envelope.nir_rs_version
                ),
            ));
        }
        let graph = envelope.graph;
        if graph.nodes.is_empty() {
            return Err(NirInspectionError::new(
                "nir-graph-empty",
                "graph has no nodes",
            ));
        }
        if graph.nodes.len() > MAX_NODES || graph.edges.len() > MAX_EDGES {
            return Err(NirInspectionError::new(
                "nir-graph-too-large",
                format!("graph exceeds {MAX_NODES} nodes or {MAX_EDGES} edges"),
            ));
        }
        graph.validate_structure().map_err(|error| {
            NirInspectionError::new("nir-graph-invalid-structure", error.to_string())
        })?;
        graph.validate_parameters().map_err(|error| {
            NirInspectionError::new("nir-graph-invalid-parameters", error.to_string())
        })?;
        Ok(Self::project(envelope.asset, &graph))
    }

    fn project(asset: NirAssetProvenance, graph: &NirGraph) -> Self {
        let layers = layer_layout(graph);
        let layer_count = layers.iter().map(|(layer, _)| layer + 1).max().unwrap_or(0);
        let max_rows = layers.iter().map(|(_, row)| row + 1).max().unwrap_or(0);

        let mut nodes: Vec<(usize, NirNodeView)> = graph
            .nodes
            .iter()
            .enumerate()
            .map(|(index, (name, node))| {
                let (layer, row) = layers[index];
                let inputs = graph
                    .edges
                    .iter()
                    .filter(|(_, target)| target == name)
                    .map(|(source, _)| source.clone())
                    .collect();
                let outputs = graph
                    .edges
                    .iter()
                    .filter(|(source, _)| source == name)
                    .map(|(_, target)| target.clone())
                    .collect();
                let view = NirNodeView {
                    name: name.clone(),
                    operator: node.type_name(),
                    layer,
                    row,
                    inputs,
                    outputs,
                    parameters: node_parameters(node),
                    metadata: metadata_fields(node_metadata(node)),
                };
                (index, view)
            })
            .collect();
        nodes.sort_by_key(|(index, view)| (view.layer, view.row, *index));

        Self {
            format: NIR_INSPECTION_FORMAT,
            format_version: NIR_INSPECTION_VERSION,
            nir_rs_version: NIR_RS_VERSION,
            asset,
            nir_version: graph.version.clone(),
            layer_count,
            max_rows,
            nodes: nodes.into_iter().map(|(_, view)| view).collect(),
            edges: graph
                .edges
                .iter()
                .map(|(source, target)| NirEdgeView {
                    source: source.clone(),
                    target: target.clone(),
                })
                .collect(),
            graph_metadata: metadata_fields(&graph.metadata),
        }
    }

    /// Look up a node by its NIR name.
    pub fn node(&self, name: &str) -> Option<&NirNodeView> {
        self.nodes.iter().find(|node| node.name == name)
    }

    /// Canonical JSON for the committed static projection and the browser.
    pub fn to_canonical_json(&self) -> String {
        sorted_struct_json(self)
    }
}

/// Pretty JSON plus a trailing newline for values whose structs already
/// declare fields alphabetically and contain no maps (see the note above
/// [`NirAssetProvenance`]).
fn sorted_struct_json<T: Serialize>(value: &T) -> String {
    let mut text =
        serde_json::to_string_pretty(value).expect("projection values are representable as JSON");
    text.push('\n');
    text
}

/// Serialize with recursively sorted object keys, two-space indentation, and a
/// trailing newline, so committed assets are byte-stable regardless of
/// `HashMap` iteration order inside `nir-rs` metadata maps. Used by the asset
/// generator; the browser path relies on [`NirInspection::to_canonical_json`].
pub fn canonical_json<T: Serialize>(value: &T) -> Result<String, serde_json::Error> {
    let mut text = serde_json::to_string_pretty(&sort_keys(serde_json::to_value(value)?))?;
    text.push('\n');
    Ok(text)
}

fn sort_keys(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> = map.into_iter().collect();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key, sort_keys(value)))
                    .collect(),
            )
        }
        Value::Array(values) => Value::Array(values.into_iter().map(sort_keys).collect()),
        other => other,
    }
}

/// `(layer, row)` per node in insertion order. NIR allows cycles, so each
/// strongly connected component is collapsed first; a component's layer is
/// its longest-path depth in the resulting DAG, and every member shares it.
/// Operators downstream of a cycle therefore still land on later layers.
/// Presentation only — not NIR semantics.
fn layer_layout(graph: &NirGraph) -> Vec<(u32, u32)> {
    let count = graph.nodes.len();
    let index_of = |name: &str| graph.nodes.get_index_of(name);
    let mut successors: Vec<Vec<usize>> = vec![Vec::new(); count];
    for (source, target) in &graph.edges {
        // Endpoints are guaranteed by `validate_structure`.
        if let (Some(source), Some(target)) = (index_of(source), index_of(target)) {
            successors[source].push(target);
        }
    }

    let component = strongly_connected_components(&successors);
    let component_count = component.iter().max().map_or(0, |max| max + 1);
    let mut condensed: Vec<Vec<usize>> = vec![Vec::new(); component_count];
    let mut indegree = vec![0_usize; component_count];
    for (source, targets) in successors.iter().enumerate() {
        for &target in targets {
            let (from, to) = (component[source], component[target]);
            if from != to {
                condensed[from].push(to);
                indegree[to] += 1;
            }
        }
    }
    let mut depth = vec![0_u32; component_count];
    let mut queue: VecDeque<usize> = (0..component_count)
        .filter(|component| indegree[*component] == 0)
        .collect();
    while let Some(current) = queue.pop_front() {
        for &next in &condensed[current] {
            depth[next] = depth[next].max(depth[current] + 1);
            indegree[next] -= 1;
            if indegree[next] == 0 {
                queue.push_back(next);
            }
        }
    }

    let mut rows: HashMap<u32, u32> = HashMap::new();
    component
        .into_iter()
        .map(|component| depth[component])
        .map(|layer| {
            let row = rows.entry(layer).or_insert(0);
            let assigned = (layer, *row);
            *row += 1;
            assigned
        })
        .collect()
}

/// Tarjan's algorithm: a component id per node. Recursion depth is bounded by
/// [`MAX_NODES`], which `from_envelope` enforces before layout.
fn strongly_connected_components(successors: &[Vec<usize>]) -> Vec<usize> {
    struct Tarjan<'a> {
        successors: &'a [Vec<usize>],
        index: Vec<Option<usize>>,
        low: Vec<usize>,
        on_stack: Vec<bool>,
        stack: Vec<usize>,
        next_index: usize,
        component: Vec<usize>,
        components: usize,
    }

    impl Tarjan<'_> {
        fn visit(&mut self, node: usize) {
            self.index[node] = Some(self.next_index);
            self.low[node] = self.next_index;
            self.next_index += 1;
            self.stack.push(node);
            self.on_stack[node] = true;
            for &next in &self.successors[node] {
                match self.index[next] {
                    None => {
                        self.visit(next);
                        self.low[node] = self.low[node].min(self.low[next]);
                    }
                    Some(index) if self.on_stack[next] => {
                        self.low[node] = self.low[node].min(index);
                    }
                    Some(_) => {}
                }
            }
            if Some(self.low[node]) == self.index[node] {
                while let Some(member) = self.stack.pop() {
                    self.on_stack[member] = false;
                    self.component[member] = self.components;
                    if member == node {
                        break;
                    }
                }
                self.components += 1;
            }
        }
    }

    let count = successors.len();
    let mut tarjan = Tarjan {
        successors,
        index: vec![None; count],
        low: vec![0; count],
        on_stack: vec![false; count],
        stack: Vec::with_capacity(count),
        next_index: 0,
        component: vec![0; count],
        components: 0,
    };
    for node in 0..count {
        if tarjan.index[node].is_none() {
            tarjan.visit(node);
        }
    }
    tarjan.component
}

fn node_metadata(node: &NirNode) -> &nir_rs::MetadataMap {
    match node {
        NirNode::Input(node) => &node.metadata,
        NirNode::Output(node) => &node.metadata,
        NirNode::Affine(node) => &node.metadata,
        NirNode::Linear(node) => &node.metadata,
        NirNode::Scale(node) => &node.metadata,
        NirNode::Conv1d(node) => &node.metadata,
        NirNode::Conv2d(node) => &node.metadata,
        NirNode::CubaLi(node) => &node.metadata,
        NirNode::CubaLif(node) => &node.metadata,
        NirNode::Delay(node) => &node.metadata,
        NirNode::Flatten(node) => &node.metadata,
        NirNode::I(node) => &node.metadata,
        NirNode::If(node) => &node.metadata,
        NirNode::Li(node) => &node.metadata,
        NirNode::Lif(node) => &node.metadata,
        NirNode::SumPool2d(node) => &node.metadata,
        NirNode::AvgPool2d(node) => &node.metadata,
        NirNode::Threshold(node) => &node.metadata,
        NirNode::Graph(graph) => &graph.metadata,
    }
}

/// Every NIR field of the node, by wire field name. The match is exhaustive
/// (`NirNode` is a closed enum), so a new upstream node type fails to compile
/// here instead of rendering silently incomplete metadata.
fn node_parameters(node: &NirNode) -> Vec<NirFieldView> {
    match node {
        NirNode::Input(node) => vec![extents("shape", &node.shape)],
        NirNode::Output(node) => vec![extents("shape", &node.shape)],
        NirNode::Affine(node) => vec![tensor("weight", &node.weight), tensor("bias", &node.bias)],
        NirNode::Linear(node) => vec![tensor("weight", &node.weight)],
        NirNode::Scale(node) => vec![tensor("scale", &node.scale)],
        NirNode::Conv1d(node) => vec![
            tensor("weight", &node.weight),
            integers("stride", &node.stride),
            padding("padding", &node.padding),
            integers("dilation", &node.dilation),
            integer("groups", node.groups),
            tensor("bias", &node.bias),
            match node.input_shape {
                Some(length) => extents("input_shape", &[length]),
                None => absent("input_shape"),
            },
        ],
        NirNode::Conv2d(node) => vec![
            tensor("weight", &node.weight),
            integers("stride", &node.stride),
            padding("padding", &node.padding),
            integers("dilation", &node.dilation),
            integer("groups", node.groups),
            tensor("bias", &node.bias),
            optional_extents("input_shape", node.input_shape.as_deref()),
        ],
        NirNode::CubaLi(node) => vec![
            tensor("tau_syn", &node.tau_syn),
            tensor("tau_mem", &node.tau_mem),
            tensor("r", &node.r),
            tensor("v_leak", &node.v_leak),
            optional_tensor("w_in", node.w_in.as_ref()),
        ],
        NirNode::CubaLif(node) => vec![
            tensor("tau_syn", &node.tau_syn),
            tensor("tau_mem", &node.tau_mem),
            tensor("r", &node.r),
            tensor("v_leak", &node.v_leak),
            tensor("v_threshold", &node.v_threshold),
            optional_tensor("v_reset", node.v_reset.as_ref()),
            optional_tensor("w_in", node.w_in.as_ref()),
        ],
        NirNode::Delay(node) => vec![tensor("delay", &node.delay)],
        NirNode::Flatten(node) => vec![
            integer("start_dim", node.start_dim),
            integer("end_dim", node.end_dim),
            optional_extents("input_type", node.input_type.as_deref()),
        ],
        NirNode::I(node) => vec![tensor("r", &node.r)],
        NirNode::If(node) => vec![
            tensor("r", &node.r),
            tensor("v_threshold", &node.v_threshold),
            optional_tensor("v_reset", node.v_reset.as_ref()),
        ],
        NirNode::Li(node) => vec![
            tensor("tau", &node.tau),
            tensor("r", &node.r),
            tensor("v_leak", &node.v_leak),
        ],
        NirNode::Lif(node) => vec![
            tensor("tau", &node.tau),
            tensor("r", &node.r),
            tensor("v_leak", &node.v_leak),
            tensor("v_threshold", &node.v_threshold),
            optional_tensor("v_reset", node.v_reset.as_ref()),
        ],
        NirNode::SumPool2d(node) => vec![
            tensor("kernel_size", &node.kernel_size),
            tensor("stride", &node.stride),
            tensor("padding", &node.padding),
        ],
        NirNode::AvgPool2d(node) => vec![
            tensor("kernel_size", &node.kernel_size),
            tensor("stride", &node.stride),
            tensor("padding", &node.padding),
        ],
        NirNode::Threshold(node) => vec![tensor("threshold", &node.threshold)],
        NirNode::Graph(graph) => vec![NirFieldView {
            name: "nodes".to_owned(),
            kind: "subgraph",
            dtype: Some("string"),
            shape: vec![graph.nodes.len()],
            value_count: graph.nodes.len(),
            values: preview(graph.nodes.keys().cloned()),
        }],
    }
}

fn metadata_fields(metadata: &nir_rs::MetadataMap) -> Vec<NirFieldView> {
    let mut keys: Vec<&String> = metadata.keys().collect();
    keys.sort();
    keys.into_iter()
        .map(|key| metadata_field(key, &metadata[key]))
        .collect()
}

fn metadata_field(name: &str, value: &MetadataValue) -> NirFieldView {
    match value {
        MetadataValue::String(text) => scalar(name, "string", "string", text.clone()),
        MetadataValue::StringList(items) => NirFieldView {
            name: name.to_owned(),
            kind: "strings",
            dtype: Some("string"),
            shape: vec![items.len()],
            value_count: items.len(),
            values: preview(items.iter().cloned()),
        },
        MetadataValue::F64(number) => scalar(name, "float", "f64", number.to_string()),
        MetadataValue::I64(number) => scalar(name, "integer", "i64", number.to_string()),
        MetadataValue::Bool(flag) => scalar(name, "boolean", "bool", flag.to_string()),
        MetadataValue::Tensor(value) => tensor(name, value),
        // `MetadataValue` is `#[non_exhaustive]`; render unknown variants as
        // present-but-unrecognized rather than guessing their meaning.
        _ => NirFieldView {
            name: name.to_owned(),
            kind: "unrecognized",
            dtype: None,
            shape: Vec::new(),
            value_count: 0,
            values: Vec::new(),
        },
    }
}

fn preview(values: impl Iterator<Item = String>) -> Vec<String> {
    values.take(MAX_PREVIEW_VALUES).collect()
}

fn tensor(name: &str, tensor: &Tensor) -> NirFieldView {
    let (dtype, values) = match tensor.data() {
        TensorData::F32(values) => ("f32", preview(values.iter().map(f32::to_string))),
        TensorData::F64(values) => ("f64", preview(values.iter().map(f64::to_string))),
        TensorData::I64(values) => ("i64", preview(values.iter().map(i64::to_string))),
        TensorData::Bool(values) => ("bool", preview(values.iter().map(bool::to_string))),
    };
    NirFieldView {
        name: name.to_owned(),
        kind: "tensor",
        dtype: Some(dtype),
        shape: tensor.shape().to_vec(),
        value_count: tensor.data().len(),
        values,
    }
}

fn optional_tensor(name: &str, value: Option<&Tensor>) -> NirFieldView {
    value.map_or_else(|| absent(name), |value| tensor(name, value))
}

fn extents(name: &str, values: &[usize]) -> NirFieldView {
    NirFieldView {
        name: name.to_owned(),
        kind: "extents",
        dtype: Some("usize"),
        shape: vec![values.len()],
        value_count: values.len(),
        values: preview(values.iter().map(usize::to_string)),
    }
}

fn optional_extents(name: &str, values: Option<&[usize]>) -> NirFieldView {
    values.map_or_else(|| absent(name), |values| extents(name, values))
}

fn integers(name: &str, values: &[i64]) -> NirFieldView {
    NirFieldView {
        name: name.to_owned(),
        kind: "integer",
        dtype: Some("i64"),
        shape: vec![values.len()],
        value_count: values.len(),
        values: preview(values.iter().map(i64::to_string)),
    }
}

fn integer(name: &str, value: i64) -> NirFieldView {
    scalar(name, "integer", "i64", value.to_string())
}

fn padding(name: &str, value: &Padding) -> NirFieldView {
    match (padding_as_wire_str(value), value) {
        (Some(mode), _) => scalar(name, "padding", "string", mode.to_owned()),
        (None, Padding::Explicit(values)) => NirFieldView {
            kind: "padding",
            ..integers(name, values)
        },
        // `Padding` is `#[non_exhaustive]`.
        (None, _) => NirFieldView {
            name: name.to_owned(),
            kind: "unrecognized",
            dtype: None,
            shape: Vec::new(),
            value_count: 0,
            values: Vec::new(),
        },
    }
}

fn scalar(name: &str, kind: &'static str, dtype: &'static str, value: String) -> NirFieldView {
    NirFieldView {
        name: name.to_owned(),
        kind,
        dtype: Some(dtype),
        shape: Vec::new(),
        value_count: 1,
        values: vec![value],
    }
}

fn absent(name: &str) -> NirFieldView {
    NirFieldView {
        name: name.to_owned(),
        kind: "absent",
        dtype: None,
        shape: Vec::new(),
        value_count: 0,
        values: Vec::new(),
    }
}

/// Browser handle for one parsed NIR graph. Construction parses and validates
/// the envelope with `nir-rs` inside Rust/WASM; JavaScript only reads the
/// projection back as canonical JSON whose numbers are small layout integers
/// and whose parameter values are Rust-formatted strings.
#[wasm_bindgen]
pub struct WasmNirInspection {
    inspection: NirInspection,
}

impl WasmNirInspection {
    /// Native-test access to the wrapped projection. Not part of the WASM
    /// contract.
    pub fn inspection(&self) -> &NirInspection {
        &self.inspection
    }
}

#[wasm_bindgen]
impl WasmNirInspection {
    /// Parse a `shipoftheseus.nir-graph` v1 envelope. Errors are
    /// `"<code>: <message>"` strings.
    #[wasm_bindgen(js_name = parse)]
    pub fn parse(envelope_json: &str) -> Result<WasmNirInspection, JsValue> {
        NirInspection::parse(envelope_json)
            .map(|inspection| Self { inspection })
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    #[wasm_bindgen(getter)]
    pub fn nir_rs_version(&self) -> String {
        NIR_RS_VERSION.to_owned()
    }

    #[wasm_bindgen(getter)]
    pub fn node_count(&self) -> u32 {
        self.inspection.nodes.len() as u32
    }

    #[wasm_bindgen(getter)]
    pub fn edge_count(&self) -> u32 {
        self.inspection.edges.len() as u32
    }

    /// The full projection; byte-identical to the committed static projection
    /// generated from the same envelope.
    pub fn inspection_json(&self) -> String {
        self.inspection.to_canonical_json()
    }

    /// One node's projection as canonical JSON.
    pub fn node_json(&self, name: &str) -> Result<String, JsValue> {
        let node = self.inspection.node(name).ok_or_else(|| {
            JsValue::from_str(&format!("nir-node-not-found: no node named {name:?}"))
        })?;
        Ok(sorted_struct_json(node))
    }
}
