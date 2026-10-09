//! Recorded `corpus-ipc` protocol replay for the portfolio's `/protocol/`
//! viewer (GitHub #21 / Linear RM-1657).
//!
//! Compiled only with the `protocol` cargo feature, which the `labs` build
//! profile enables (`public/wasm/neuromorphic-adapter-labs/`). The default
//! homepage package keeps only `WireCompatibility::CURRENT` from `corpus-ipc`.
//!
//! The adapter never re-describes the IPC schema. `corpus-ipc =0.1.0`
//! (`default-features = false`: no `zmq`, no `server`) owns the envelope,
//! wire-version window, payload types, limits, and validation. This module
//! only orders the ingress steps, classifies their failures into stable reason
//! codes, and projects an accepted message into browser-safe typed values.
//!
//! Ingress order — every step fails closed and nothing later runs:
//!
//! 1. the caller's declared variant and out-of-band SHA-256 are well formed;
//! 2. the byte length is within [`MAX_PROTOCOL_FIXTURE_BYTES`], checked before
//!    hashing or parsing;
//! 3. SHA-256 over the exact bytes equals the declared digest;
//! 4. [`WireEnvelope::<IpcMessage>::decode_json`] accepts the wire version
//!    before it converts the payload (the legacy-tolerant
//!    `decode_ipc_message_json` is deliberately not used);
//! 5. [`Validate::validate`] accepts the decoded message;
//! 6. the decoded variant equals the declared one.
//!
//! Transport is offline: bytes come from checked-in fixtures, never from
//! ZeroMQ, an HTTP service, or a live producer.

use corpus_ipc::{
    CompatibilityError, EnvelopeError, IpcMessage, TraceData, Validate, ValidationError,
    ValidationKind, WireCompatibility, WireEnvelope,
};
use serde_json::error::Category;
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;

/// Pre-parse cap on recorded fixture bytes. Checked before hashing or JSON.
pub const MAX_PROTOCOL_FIXTURE_BYTES: usize = 64 * 1024;

const SHA256_HEX_LEN: usize = 64;

/// The `IpcMessage` variants the recorded viewer replays.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProtocolVariant {
    Stimuli,
    Spikes,
    EligibilityTraces,
}

impl ProtocolVariant {
    pub const ALL: [Self; 3] = [Self::Stimuli, Self::Spikes, Self::EligibilityTraces];

    /// The `corpus-ipc` serde variant name.
    pub fn name(self) -> &'static str {
        match self {
            Self::Stimuli => "Stimuli",
            Self::Spikes => "Spikes",
            Self::EligibilityTraces => "EligibilityTraces",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|variant| variant.name() == name)
    }

    fn of(message: &IpcMessage) -> Option<Self> {
        match message {
            IpcMessage::Stimuli(_) => Some(Self::Stimuli),
            IpcMessage::Spikes(_) => Some(Self::Spikes),
            IpcMessage::EligibilityTraces(_) => Some(Self::EligibilityTraces),
            _ => None,
        }
    }
}

/// `corpus-ipc` serde name of any decoded message, for error reporting.
fn message_variant_name(message: &IpcMessage) -> &'static str {
    match message {
        IpcMessage::Spikes(_) => "Spikes",
        IpcMessage::Embeddings(_) => "Embeddings",
        IpcMessage::Stimuli(_) => "Stimuli",
        IpcMessage::Neuromodulators(_) => "Neuromodulators",
        IpcMessage::Loss(_) => "Loss",
        IpcMessage::ConfigUpdate(_) => "ConfigUpdate",
        IpcMessage::GradientUpdate(_) => "GradientUpdate",
        IpcMessage::EligibilityTraces(_) => "EligibilityTraces",
        IpcMessage::TrainingComplete => "TrainingComplete",
        IpcMessage::Shutdown => "Shutdown",
        IpcMessage::Ping => "Ping",
    }
}

/// Stable reason codes for every fail-closed outcome. The strings are part of
/// the browser contract (`ProtocolFixtureError.code`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProtocolErrorCode {
    /// The declared variant is not one the recorded viewer replays.
    ExpectedVariantUnsupported,
    /// The out-of-band digest is not 64 lowercase hexadecimal characters.
    ExpectedDigestInvalid,
    /// The bytes exceed [`MAX_PROTOCOL_FIXTURE_BYTES`].
    Oversize,
    /// SHA-256 over the exact bytes differs from the out-of-band digest.
    DigestMismatch,
    /// The bytes are not one syntactically valid JSON document.
    MalformedJson,
    /// The JSON document is not an object (for example the legacy `"Ping"`).
    EnvelopeNotObject,
    WireVersionMissing,
    WireVersionNull,
    WireVersionDuplicate,
    /// `wire_version` is not a non-negative integer fitting `u32`.
    WireVersionInvalid,
    WireVersionTooOld,
    WireVersionTooNew,
    PayloadMissing,
    PayloadNull,
    PayloadDuplicate,
    /// The payload names an `IpcMessage` variant `corpus-ipc` does not define.
    UnknownVariant,
    /// The payload does not match the typed `corpus-ipc` schema.
    InvalidTypedData,
    /// `corpus-ipc` validation rejected the payload (finite values, limits,
    /// mask lengths, unique identifiers, ...).
    ValidationFailed,
    /// The decoded variant differs from the declared one.
    KindMismatch,
    /// The envelope could not be re-encoded for display.
    CanonicalEncodingFailed,
}

impl ProtocolErrorCode {
    pub const ALL: [Self; 20] = [
        Self::ExpectedVariantUnsupported,
        Self::ExpectedDigestInvalid,
        Self::Oversize,
        Self::DigestMismatch,
        Self::MalformedJson,
        Self::EnvelopeNotObject,
        Self::WireVersionMissing,
        Self::WireVersionNull,
        Self::WireVersionDuplicate,
        Self::WireVersionInvalid,
        Self::WireVersionTooOld,
        Self::WireVersionTooNew,
        Self::PayloadMissing,
        Self::PayloadNull,
        Self::PayloadDuplicate,
        Self::UnknownVariant,
        Self::InvalidTypedData,
        Self::ValidationFailed,
        Self::KindMismatch,
        Self::CanonicalEncodingFailed,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ExpectedVariantUnsupported => "expected-variant-unsupported",
            Self::ExpectedDigestInvalid => "expected-digest-invalid",
            Self::Oversize => "oversize",
            Self::DigestMismatch => "digest-mismatch",
            Self::MalformedJson => "malformed-json",
            Self::EnvelopeNotObject => "envelope-not-object",
            Self::WireVersionMissing => "wire-version-missing",
            Self::WireVersionNull => "wire-version-null",
            Self::WireVersionDuplicate => "wire-version-duplicate",
            Self::WireVersionInvalid => "wire-version-invalid",
            Self::WireVersionTooOld => "wire-version-too-old",
            Self::WireVersionTooNew => "wire-version-too-new",
            Self::PayloadMissing => "payload-missing",
            Self::PayloadNull => "payload-null",
            Self::PayloadDuplicate => "payload-duplicate",
            Self::UnknownVariant => "unknown-variant",
            Self::InvalidTypedData => "invalid-typed-data",
            Self::ValidationFailed => "validation-failed",
            Self::KindMismatch => "kind-mismatch",
            Self::CanonicalEncodingFailed => "canonical-encoding-failed",
        }
    }
}

/// A fail-closed rejection with a stable [`ProtocolErrorCode`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtocolError {
    pub code: ProtocolErrorCode,
    pub message: String,
}

impl ProtocolError {
    fn new(code: ProtocolErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for ProtocolError {}

/// An accepted, validated recorded message plus its verified provenance.
#[derive(Clone, Debug, PartialEq)]
pub struct ProtocolInspection {
    pub variant: ProtocolVariant,
    /// The wire version `corpus-ipc` accepted for this envelope.
    pub wire_version: u32,
    /// Verified lowercase SHA-256 of the exact input bytes.
    pub sha256: String,
    pub byte_length: usize,
    pub message: IpcMessage,
    /// `corpus-ipc` re-encoding of the accepted envelope.
    pub canonical_json: String,
    /// Whether the re-encoding is byte-identical to the input. Additive
    /// unknown fields are accepted but dropped, so they make this `false`.
    pub canonical_matches_input: bool,
}

/// Metadata projection with a deterministic (key-sorted) custom map.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtocolMetadata {
    pub source: Option<String>,
    pub processing_latency_ns: Option<u64>,
    pub custom: Vec<(String, String)>,
}

impl ProtocolInspection {
    pub fn session_id(&self) -> Option<&str> {
        match &self.message {
            IpcMessage::Stimuli(batch) => batch.session_id.as_deref(),
            IpcMessage::Spikes(batch) => batch.session_id.as_deref(),
            IpcMessage::EligibilityTraces(batch) => Some(batch.session_id.as_str()),
            _ => None,
        }
    }

    pub fn batch_id(&self) -> u64 {
        match &self.message {
            IpcMessage::Stimuli(batch) => batch.batch_id,
            IpcMessage::Spikes(batch) => batch.batch_id,
            IpcMessage::EligibilityTraces(batch) => batch.batch_id,
            _ => 0,
        }
    }

    /// `TraceBatch` carries no timestamp on the wire.
    pub fn timestamp(&self) -> Option<u64> {
        match &self.message {
            IpcMessage::Stimuli(batch) => Some(batch.timestamp),
            IpcMessage::Spikes(batch) => Some(batch.timestamp),
            _ => None,
        }
    }

    pub fn metadata(&self) -> Option<ProtocolMetadata> {
        let metadata = match &self.message {
            IpcMessage::Stimuli(batch) => batch.metadata.as_ref(),
            IpcMessage::Spikes(batch) => batch.metadata.as_ref(),
            _ => None,
        }?;
        let mut custom: Vec<(String, String)> = metadata
            .custom
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        custom.sort();
        Some(ProtocolMetadata {
            source: metadata.source.clone(),
            processing_latency_ns: metadata.processing_latency_ns,
            custom,
        })
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn is_sha256_hex(digest: &str) -> bool {
    digest.len() == SHA256_HEX_LEN
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

const VALIDATION_KINDS: [ValidationKind; 6] = [
    ValidationKind::NonFinite,
    ValidationKind::OutOfRange,
    ValidationKind::LengthMismatch,
    ValidationKind::LimitExceeded,
    ValidationKind::NestedMetadata,
    ValidationKind::DuplicateIdentifier,
];

/// `corpus-ipc` runs the same `Validate` policy inside payload
/// deserialization (its `TryFrom` shadow types) and reports it through serde
/// as `"<kind> at `<path>`…"`, using the documented stable `ValidationKind`
/// names.
fn is_validation_message(message: &str) -> bool {
    VALIDATION_KINDS
        .iter()
        .any(|kind| message.starts_with(&format!("{} at `", kind.as_str())))
}

/// Diagnostic-only: tells a `null` payload apart from other typed failures.
/// Runs after `corpus-ipc` has already rejected the bytes; it never accepts.
fn payload_is_null(bytes: &[u8]) -> bool {
    matches!(
        serde_json::from_slice::<serde_json::Value>(bytes),
        Ok(serde_json::Value::Object(object))
            if object.get("payload").is_some_and(serde_json::Value::is_null)
    )
}

fn classify_envelope_error(error: EnvelopeError, bytes: &[u8]) -> ProtocolError {
    use ProtocolErrorCode as Code;
    let detail = error.to_string();
    let code = match &error {
        EnvelopeError::Compatibility(CompatibilityError::TooOld { .. }) => Code::WireVersionTooOld,
        EnvelopeError::Compatibility(CompatibilityError::TooNew { .. }) => Code::WireVersionTooNew,
        EnvelopeError::NotAnObject => Code::EnvelopeNotObject,
        EnvelopeError::MissingVersion => Code::WireVersionMissing,
        EnvelopeError::InvalidVersion(found) if found == "null" => Code::WireVersionNull,
        EnvelopeError::InvalidVersion(_) => Code::WireVersionInvalid,
        EnvelopeError::MissingPayload => Code::PayloadMissing,
        EnvelopeError::Json(json) => match json.classify() {
            Category::Data
                if json
                    .to_string()
                    .starts_with("duplicate field `wire_version`") =>
            {
                Code::WireVersionDuplicate
            }
            Category::Data if json.to_string().starts_with("duplicate field `payload`") => {
                Code::PayloadDuplicate
            }
            // Every other envelope-level failure is a JSON syntax or framing
            // error (truncation, trailing characters, invalid UTF-8, ...).
            _ => Code::MalformedJson,
        },
        EnvelopeError::Payload(json) => {
            let message = json.to_string();
            if payload_is_null(bytes) {
                Code::PayloadNull
            } else if message.starts_with("unknown variant") {
                Code::UnknownVariant
            } else if is_validation_message(&message) {
                Code::ValidationFailed
            } else {
                Code::InvalidTypedData
            }
        }
    };
    ProtocolError::new(code, format!("corpus-ipc rejected the envelope: {detail}"))
}

fn validation_failed(error: ValidationError) -> ProtocolError {
    ProtocolError::new(
        ProtocolErrorCode::ValidationFailed,
        format!("corpus-ipc validation rejected the payload: {error}"),
    )
}

/// Post-decode gate: [`Validate::validate`] on the decoded message, then the
/// declared-kind check. Returns the retained wire version and the message.
///
/// Exposed so native tests can drive the gate with directly constructed
/// messages, which bypass the validation `corpus-ipc` also runs during
/// deserialization.
pub fn accept_decoded_envelope(
    envelope: WireEnvelope<IpcMessage>,
    expected: ProtocolVariant,
) -> Result<(u32, IpcMessage), ProtocolError> {
    let wire_version = envelope.wire_version;
    let message = envelope.into_payload();
    message.validate().map_err(validation_failed)?;
    if ProtocolVariant::of(&message) != Some(expected) {
        return Err(ProtocolError::new(
            ProtocolErrorCode::KindMismatch,
            format!(
                "declared {} but the envelope decoded as {}",
                expected.name(),
                message_variant_name(&message)
            ),
        ));
    }
    Ok((wire_version, message))
}

/// Verify, decode, and validate one recorded `corpus-ipc` envelope.
pub fn inspect_protocol_fixture(
    bytes: &[u8],
    expected_sha256: &str,
    expected_variant: &str,
) -> Result<ProtocolInspection, ProtocolError> {
    let variant = ProtocolVariant::parse(expected_variant).ok_or_else(|| {
        ProtocolError::new(
            ProtocolErrorCode::ExpectedVariantUnsupported,
            format!(
                "the recorded viewer replays only Stimuli, Spikes, and EligibilityTraces, not {expected_variant:?}"
            ),
        )
    })?;
    if !is_sha256_hex(expected_sha256) {
        return Err(ProtocolError::new(
            ProtocolErrorCode::ExpectedDigestInvalid,
            "the out-of-band SHA-256 must be 64 lowercase hexadecimal characters",
        ));
    }
    if bytes.len() > MAX_PROTOCOL_FIXTURE_BYTES {
        return Err(ProtocolError::new(
            ProtocolErrorCode::Oversize,
            format!(
                "fixture is {} bytes; the pre-parse limit is {MAX_PROTOCOL_FIXTURE_BYTES}",
                bytes.len()
            ),
        ));
    }
    let sha256 = sha256_hex(bytes);
    if sha256 != expected_sha256 {
        return Err(ProtocolError::new(
            ProtocolErrorCode::DigestMismatch,
            format!("fixture SHA-256 is {sha256}, expected {expected_sha256}"),
        ));
    }

    let envelope = WireEnvelope::<IpcMessage>::decode_json(bytes)
        .map_err(|error| classify_envelope_error(error, bytes))?;
    let (wire_version, message) = accept_decoded_envelope(envelope, variant)?;

    let canonical = WireEnvelope {
        wire_version,
        payload: &message,
    }
    .encode_json()
    .map_err(|error| {
        ProtocolError::new(
            ProtocolErrorCode::CanonicalEncodingFailed,
            format!("could not re-encode the accepted envelope: {error}"),
        )
    })?;
    let canonical_matches_input = canonical == bytes;
    let canonical_json = String::from_utf8(canonical).map_err(|_| {
        ProtocolError::new(
            ProtocolErrorCode::CanonicalEncodingFailed,
            "re-encoded envelope is not UTF-8",
        )
    })?;

    Ok(ProtocolInspection {
        variant,
        wire_version,
        sha256,
        byte_length: bytes.len(),
        message,
        canonical_json,
        canonical_matches_input,
    })
}

impl crate::BrowserRuntime {
    /// `neuromod` per-synapse eligibility traces of one LIF neuron, projected
    /// onto the `corpus-ipc` wire row: `channel_id` is the input channel,
    /// `trace_value` is upstream `EligibilityTrace::value`, and
    /// `last_spike_time` is the neuron's upstream `last_spike_time` (the
    /// engine step of its most recent spike).
    ///
    /// Used to derive the recorded `EligibilityTraces` fixture from a
    /// deterministic replay. It is read-only and not part of the WASM API.
    pub fn eligibility_trace_rows(&self, neuron: usize) -> Result<Vec<TraceData>, String> {
        let lif = self
            .network
            .neurons
            .get(neuron)
            .ok_or_else(|| format!("neuron {neuron} does not exist"))?;
        let last_spike_time = u32::try_from(lif.last_spike_time)
            .map_err(|_| format!("neuron {neuron} has not spiked yet"))?;
        lif.eligibility
            .iter()
            .enumerate()
            .map(|(channel, trace)| {
                Ok(TraceData {
                    channel_id: u16::try_from(channel)
                        .map_err(|_| "channel index exceeds u16".to_owned())?,
                    trace_value: trace.value,
                    last_spike_time,
                })
            })
            .collect()
    }
}

/// Browser view of an accepted recorded envelope. Every `u64` crosses as a
/// `bigint`; numeric rows cross as JS-owned typed arrays.
#[wasm_bindgen]
pub struct WasmProtocolInspection {
    inspection: ProtocolInspection,
}

impl WasmProtocolInspection {
    /// Native-test access to the wrapped inspection. Not part of the WASM API.
    pub fn inspection(&self) -> &ProtocolInspection {
        &self.inspection
    }
}

#[wasm_bindgen]
impl WasmProtocolInspection {
    #[wasm_bindgen(getter)]
    pub fn variant(&self) -> String {
        self.inspection.variant.name().to_owned()
    }
    #[wasm_bindgen(getter)]
    pub fn wire_version(&self) -> u32 {
        self.inspection.wire_version
    }
    #[wasm_bindgen(getter)]
    pub fn wire_min_supported(&self) -> u32 {
        WireCompatibility::MIN_SUPPORTED
    }
    #[wasm_bindgen(getter)]
    pub fn wire_current(&self) -> u32 {
        WireCompatibility::CURRENT
    }
    #[wasm_bindgen(getter)]
    pub fn sha256(&self) -> String {
        self.inspection.sha256.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn byte_length(&self) -> u32 {
        u32::try_from(self.inspection.byte_length).unwrap_or(u32::MAX)
    }
    #[wasm_bindgen(getter)]
    pub fn session_id(&self) -> Option<String> {
        self.inspection.session_id().map(str::to_owned)
    }
    #[wasm_bindgen(getter)]
    pub fn batch_id(&self) -> u64 {
        self.inspection.batch_id()
    }
    #[wasm_bindgen(getter)]
    pub fn timestamp(&self) -> Option<u64> {
        self.inspection.timestamp()
    }
    #[wasm_bindgen(getter)]
    pub fn stimulus_values(&self) -> js_sys::Float32Array {
        match &self.inspection.message {
            IpcMessage::Stimuli(batch) => js_sys::Float32Array::from(batch.values.as_slice()),
            _ => js_sys::Float32Array::new_with_length(0),
        }
    }
    #[wasm_bindgen(getter)]
    pub fn stimulus_valid_mask(&self) -> Option<js_sys::Uint8Array> {
        match &self.inspection.message {
            IpcMessage::Stimuli(batch) => batch.valid_mask.as_ref().map(|mask| {
                let bytes: Vec<u8> = mask.iter().map(|valid| u8::from(*valid)).collect();
                js_sys::Uint8Array::from(bytes.as_slice())
            }),
            _ => None,
        }
    }
    #[wasm_bindgen(getter)]
    pub fn spike_channels(&self) -> js_sys::Uint16Array {
        let channels: Vec<u16> = self.spikes().map(|spike| spike.channel).collect();
        js_sys::Uint16Array::from(channels.as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn spike_times(&self) -> js_sys::Uint32Array {
        let times: Vec<u32> = self.spikes().map(|spike| spike.time).collect();
        js_sys::Uint32Array::from(times.as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn spike_strengths(&self) -> js_sys::Float32Array {
        let strengths: Vec<f32> = self.spikes().map(|spike| spike.strength).collect();
        js_sys::Float32Array::from(strengths.as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn trace_channel_ids(&self) -> js_sys::Uint16Array {
        let ids: Vec<u16> = self.traces().map(|trace| trace.channel_id).collect();
        js_sys::Uint16Array::from(ids.as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn trace_values(&self) -> js_sys::Float32Array {
        let values: Vec<f32> = self.traces().map(|trace| trace.trace_value).collect();
        js_sys::Float32Array::from(values.as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn trace_last_spike_times(&self) -> js_sys::Uint32Array {
        let times: Vec<u32> = self.traces().map(|trace| trace.last_spike_time).collect();
        js_sys::Uint32Array::from(times.as_slice())
    }
    #[wasm_bindgen(getter)]
    pub fn metadata_present(&self) -> bool {
        self.inspection.metadata().is_some()
    }
    #[wasm_bindgen(getter)]
    pub fn metadata_source(&self) -> Option<String> {
        self.inspection
            .metadata()
            .and_then(|metadata| metadata.source)
    }
    #[wasm_bindgen(getter)]
    pub fn metadata_processing_latency_ns(&self) -> Option<u64> {
        self.inspection
            .metadata()
            .and_then(|metadata| metadata.processing_latency_ns)
    }
    /// Key-sorted `[key, value]` string pairs.
    #[wasm_bindgen(getter)]
    pub fn metadata_custom(&self) -> js_sys::Array {
        let pairs = js_sys::Array::new();
        for (key, value) in self
            .inspection
            .metadata()
            .map(|metadata| metadata.custom)
            .unwrap_or_default()
        {
            let pair: JsValue =
                js_sys::Array::of2(&JsValue::from_str(&key), &JsValue::from_str(&value)).into();
            pairs.push(&pair);
        }
        pairs
    }
    #[wasm_bindgen(getter)]
    pub fn canonical_json(&self) -> String {
        self.inspection.canonical_json.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn canonical_matches_input(&self) -> bool {
        self.inspection.canonical_matches_input
    }
}

impl WasmProtocolInspection {
    fn spikes(&self) -> impl Iterator<Item = &corpus_ipc::SpikeEvent> {
        match &self.inspection.message {
            IpcMessage::Spikes(batch) => batch.spikes.as_slice(),
            _ => &[],
        }
        .iter()
    }

    fn traces(&self) -> impl Iterator<Item = &TraceData> {
        match &self.inspection.message {
            IpcMessage::EligibilityTraces(batch) => batch.traces.as_slice(),
            _ => &[],
        }
        .iter()
    }
}

/// Native entry point mirroring the WASM export, for tests.
pub fn inspect_protocol_fixture_wrapped(
    bytes: &[u8],
    expected_sha256: &str,
    expected_variant: &str,
) -> Result<WasmProtocolInspection, ProtocolError> {
    inspect_protocol_fixture(bytes, expected_sha256, expected_variant)
        .map(|inspection| WasmProtocolInspection { inspection })
}

fn protocol_error_to_js(error: &ProtocolError) -> JsValue {
    let js_error = js_sys::Error::new(&error.message);
    js_error.set_name("ProtocolFixtureError");
    // A failed property write leaves a plain Error, which the bridge treats
    // as an adapter failure; it still fails closed.
    let _ = js_sys::Reflect::set(
        &js_error,
        &JsValue::from_str("code"),
        &JsValue::from_str(error.code.as_str()),
    );
    js_error.into()
}

/// Verify, decode, and validate one recorded envelope. Throws a
/// `ProtocolFixtureError` whose `code` is a [`ProtocolErrorCode`] string.
#[wasm_bindgen(js_name = inspectProtocolFixture)]
pub fn inspect_protocol_fixture_js(
    bytes: &[u8],
    expected_sha256: &str,
    expected_variant: &str,
) -> Result<WasmProtocolInspection, JsValue> {
    inspect_protocol_fixture_wrapped(bytes, expected_sha256, expected_variant)
        .map_err(|error| protocol_error_to_js(&error))
}

/// The pre-parse byte limit, so the browser can bound fixture reads with the
/// adapter's own constant.
#[wasm_bindgen(js_name = protocolFixtureByteLimit)]
pub fn protocol_fixture_byte_limit() -> u32 {
    MAX_PROTOCOL_FIXTURE_BYTES as u32
}
