//! Fail-closed ingress for recorded `corpus-ipc` envelopes (GitHub #21).
//!
//! Every case signs its exact bytes with SHA-256 first (unless the case is
//! about the digest) so the rejection comes from the stage under test.

use std::collections::HashSet;

use corpus_ipc::{IpcMessage, SpikeBatch, StimulusBatch, WireEnvelope};
use neuromorphic_adapter::protocol::{
    MAX_PROTOCOL_FIXTURE_BYTES, ProtocolErrorCode, ProtocolVariant, accept_decoded_envelope,
    inspect_protocol_fixture,
};
use sha2::{Digest, Sha256};

const STIMULI: &str = r#"{"wire_version":1,"payload":{"Stimuli":{"session_id":"s","batch_id":9007199254740993,"timestamp":18446744073709551615,"values":[0.5,1.0],"valid_mask":[true,false],"metadata":null}}}"#;
const SPIKES: &str = r#"{"wire_version":1,"payload":{"Spikes":{"session_id":"s","batch_id":1,"timestamp":2,"spikes":[{"channel":3,"time":4,"strength":1.0}],"metadata":null}}}"#;
const TRACES: &str = r#"{"wire_version":1,"payload":{"EligibilityTraces":{"session_id":"s","batch_id":18446744073709551615,"traces":[{"channel_id":0,"trace_value":0.25,"last_spike_time":7}]}}}"#;

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Inspect `bytes` with their own (correct) digest.
fn signed(
    bytes: &[u8],
    variant: &str,
) -> Result<neuromorphic_adapter::protocol::ProtocolInspection, ProtocolErrorCode> {
    inspect_protocol_fixture(bytes, &sha256_hex(bytes), variant).map_err(|error| error.code)
}

fn rejects(bytes: &str, variant: &str, expected: ProtocolErrorCode) {
    match signed(bytes.as_bytes(), variant) {
        Ok(_) => panic!("{bytes} must fail closed with {}", expected.as_str()),
        Err(code) => assert_eq!(code, expected, "{bytes}"),
    }
}

#[test]
fn valid_envelopes_of_every_replayed_variant_are_accepted() {
    for (bytes, variant) in [
        (STIMULI, ProtocolVariant::Stimuli),
        (SPIKES, ProtocolVariant::Spikes),
        (TRACES, ProtocolVariant::EligibilityTraces),
    ] {
        let inspection = signed(bytes.as_bytes(), variant.name()).expect("valid envelope");
        assert_eq!(inspection.variant, variant);
        assert_eq!(inspection.wire_version, 1);
        assert!(inspection.canonical_matches_input, "{bytes}");
        assert_eq!(inspection.canonical_json, bytes);
    }
}

#[test]
fn u64_values_beyond_javascript_safe_integers_survive_exactly() {
    let stimuli = signed(STIMULI.as_bytes(), "Stimuli").expect("valid");
    assert_eq!(stimuli.batch_id(), 9_007_199_254_740_993);
    assert_eq!(stimuli.timestamp(), Some(u64::MAX));
    let traces = signed(TRACES.as_bytes(), "EligibilityTraces").expect("valid");
    assert_eq!(traces.batch_id(), u64::MAX);
    assert_eq!(traces.timestamp(), None, "TraceBatch has no timestamp");
}

#[test]
fn negative_zero_keeps_its_sign_bit_and_canonical_bytes() {
    let bytes = r#"{"wire_version":1,"payload":{"Stimuli":{"session_id":null,"batch_id":1,"timestamp":0,"values":[-0.0,0.0],"valid_mask":null,"metadata":null}}}"#;
    let inspection = signed(bytes.as_bytes(), "Stimuli").expect("negative zero is finite");
    let IpcMessage::Stimuli(batch) = &inspection.message else {
        panic!("decoded as Stimuli");
    };
    assert_eq!(batch.values[0].to_bits(), (-0.0_f32).to_bits());
    assert_eq!(batch.values[1].to_bits(), 0.0_f32.to_bits());
    assert!(inspection.canonical_matches_input);
}

#[test]
fn the_pre_parse_byte_limit_runs_before_hashing_and_parsing() {
    let mut oversize = STIMULI.as_bytes().to_vec();
    oversize.resize(MAX_PROTOCOL_FIXTURE_BYTES + 1, b' ');
    assert_eq!(
        signed(&oversize, "Stimuli").err(),
        Some(ProtocolErrorCode::Oversize)
    );
    let wrong_digest = "0".repeat(64);
    let error = inspect_protocol_fixture(&oversize, &wrong_digest, "Stimuli").unwrap_err();
    assert_eq!(error.code, ProtocolErrorCode::Oversize);

    let mut at_limit = STIMULI.as_bytes().to_vec();
    at_limit.resize(MAX_PROTOCOL_FIXTURE_BYTES, b' ');
    assert!(
        signed(&at_limit, "Stimuli").is_ok(),
        "whitespace up to the limit is valid JSON"
    );
}

#[test]
fn the_out_of_band_digest_covers_the_exact_bytes() {
    let digest = sha256_hex(STIMULI.as_bytes());
    let mut tampered = STIMULI.as_bytes().to_vec();
    let position = STIMULI.find("993").expect("batch id digits");
    tampered[position] = b'8';
    let error = inspect_protocol_fixture(&tampered, &digest, "Stimuli").unwrap_err();
    assert_eq!(error.code, ProtocolErrorCode::DigestMismatch);

    let mut trailing_newline = STIMULI.as_bytes().to_vec();
    trailing_newline.push(b'\n');
    let error = inspect_protocol_fixture(&trailing_newline, &digest, "Stimuli").unwrap_err();
    assert_eq!(error.code, ProtocolErrorCode::DigestMismatch);

    // The digest gate precedes parsing: garbage with a wrong digest is a
    // digest failure, never a parse attempt.
    let error = inspect_protocol_fixture(b"{not json", &digest, "Stimuli").unwrap_err();
    assert_eq!(error.code, ProtocolErrorCode::DigestMismatch);
}

#[test]
fn malformed_caller_declarations_fail_closed() {
    let bytes = STIMULI.as_bytes();
    let digest = sha256_hex(bytes);
    for bad_digest in [
        String::new(),
        digest.to_uppercase(),
        digest[..63].to_owned(),
        format!("{digest}0"),
        format!("{}g", &digest[..63]),
    ] {
        let error = inspect_protocol_fixture(bytes, &bad_digest, "Stimuli").unwrap_err();
        assert_eq!(
            error.code,
            ProtocolErrorCode::ExpectedDigestInvalid,
            "{bad_digest}"
        );
    }
    for bad_variant in ["", "stimuli", "Ping", "Embeddings", "Unknown"] {
        let error = inspect_protocol_fixture(bytes, &digest, bad_variant).unwrap_err();
        assert_eq!(
            error.code,
            ProtocolErrorCode::ExpectedVariantUnsupported,
            "{bad_variant}"
        );
    }
}

#[test]
fn malformed_json_fails_closed() {
    for bytes in [
        "",
        "   ",
        r#"{"wire_version":1,"payload":"#,
        r#"{"wire_version":1,"payload":{"Stimuli":{}}"#,
        &format!("{STIMULI} trailing"),
        &format!("{STIMULI}{STIMULI}"),
        r#"{"wire_version":1,"payload":{"Stimuli":{"session_id":"s",}}}"#,
        "{'wire_version':1}",
    ] {
        rejects(bytes, "Stimuli", ProtocolErrorCode::MalformedJson);
    }
    let invalid_utf8 = [b'{', b'"', 0xff, b'"', b':', b'1', b'}'];
    assert_eq!(
        signed(&invalid_utf8, "Stimuli").err(),
        Some(ProtocolErrorCode::MalformedJson)
    );
}

#[test]
fn non_object_envelopes_fail_closed() {
    for bytes in [r#""Ping""#, "[1]", "1", "null", "true"] {
        rejects(bytes, "Stimuli", ProtocolErrorCode::EnvelopeNotObject);
    }
}

#[test]
fn missing_null_duplicate_old_future_and_invalid_wire_versions_fail_closed() {
    let payload =
        r#"{"Spikes":{"session_id":"s","batch_id":1,"timestamp":2,"spikes":[],"metadata":null}}"#;
    let cases = [
        (
            format!(r#"{{"payload":{payload}}}"#),
            ProtocolErrorCode::WireVersionMissing,
        ),
        // Legacy unversioned JSON is not viewer ingress.
        (payload.to_owned(), ProtocolErrorCode::WireVersionMissing),
        (
            format!(r#"{{"wire_version":null,"payload":{payload}}}"#),
            ProtocolErrorCode::WireVersionNull,
        ),
        (
            format!(r#"{{"wire_version":1,"wire_version":1,"payload":{payload}}}"#),
            ProtocolErrorCode::WireVersionDuplicate,
        ),
        (
            format!(r#"{{"wire_version":0,"payload":{payload}}}"#),
            ProtocolErrorCode::WireVersionTooOld,
        ),
        (
            format!(r#"{{"wire_version":2,"payload":{payload}}}"#),
            ProtocolErrorCode::WireVersionTooNew,
        ),
        (
            format!(r#"{{"wire_version":4294967295,"payload":{payload}}}"#),
            ProtocolErrorCode::WireVersionTooNew,
        ),
        (
            format!(r#"{{"wire_version":"1","payload":{payload}}}"#),
            ProtocolErrorCode::WireVersionInvalid,
        ),
        (
            format!(r#"{{"wire_version":-1,"payload":{payload}}}"#),
            ProtocolErrorCode::WireVersionInvalid,
        ),
        (
            format!(r#"{{"wire_version":1.5,"payload":{payload}}}"#),
            ProtocolErrorCode::WireVersionInvalid,
        ),
        (
            format!(r#"{{"wire_version":4294967296,"payload":{payload}}}"#),
            ProtocolErrorCode::WireVersionInvalid,
        ),
        (
            format!(r#"{{"wire_version":[1],"payload":{payload}}}"#),
            ProtocolErrorCode::WireVersionInvalid,
        ),
    ];
    for (bytes, expected) in cases {
        rejects(&bytes, "Spikes", expected);
    }
}

#[test]
fn too_new_versions_are_rejected_before_the_payload_is_interpreted() {
    // An undecodable payload behind a future version still reports the
    // version: corpus-ipc checks it first.
    rejects(
        r#"{"wire_version":2,"payload":{"Telemetry":{"anything":true}}}"#,
        "Spikes",
        ProtocolErrorCode::WireVersionTooNew,
    );
    rejects(
        r#"{"wire_version":0,"payload":null}"#,
        "Spikes",
        ProtocolErrorCode::WireVersionTooOld,
    );
}

#[test]
fn missing_null_and_duplicate_payloads_fail_closed() {
    rejects(
        r#"{"wire_version":1}"#,
        "Spikes",
        ProtocolErrorCode::PayloadMissing,
    );
    rejects(
        r#"{"wire_version":1,"payload":null}"#,
        "Spikes",
        ProtocolErrorCode::PayloadNull,
    );
    rejects(
        &format!(
            r#"{{"wire_version":1,"payload":"Ping","payload":{}}}"#,
            &SPIKES[28..SPIKES.len() - 1]
        ),
        "Spikes",
        ProtocolErrorCode::PayloadDuplicate,
    );
}

#[test]
fn unknown_message_variants_fail_closed() {
    rejects(
        r#"{"wire_version":1,"payload":{"Telemetry":{"session_id":"s","batch_id":1}}}"#,
        "Stimuli",
        ProtocolErrorCode::UnknownVariant,
    );
    rejects(
        r#"{"wire_version":1,"payload":"Pong"}"#,
        "Stimuli",
        ProtocolErrorCode::UnknownVariant,
    );
}

#[test]
fn invalid_typed_data_fails_closed() {
    let cases = [
        // u64 as a string, negative, fractional, and beyond u64::MAX.
        (
            STIMULI.replace("9007199254740993", r#""9007199254740993""#),
            "Stimuli",
        ),
        (STIMULI.replace("9007199254740993", "-1"), "Stimuli"),
        (STIMULI.replace("9007199254740993", "1.5"), "Stimuli"),
        (
            STIMULI.replace("9007199254740993", "18446744073709551616"),
            "Stimuli",
        ),
        (STIMULI.replace("[0.5,1.0]", r#""0.5,1.0""#), "Stimuli"),
        (STIMULI.replace(r#""session_id":"s","#, ""), "Stimuli"),
        (
            SPIKES.replace(r#""channel":3"#, r#""channel":70000"#),
            "Spikes",
        ),
        (
            TRACES.replace(r#""session_id":"s""#, r#""session_id":null"#),
            "EligibilityTraces",
        ),
        (
            r#"{"wire_version":1,"payload":{"Stimuli":[1,2]}}"#.to_owned(),
            "Stimuli",
        ),
        (r#"{"wire_version":1,"payload":7}"#.to_owned(), "Stimuli"),
    ];
    for (bytes, variant) in cases {
        rejects(&bytes, variant, ProtocolErrorCode::InvalidTypedData);
    }
}

#[test]
fn corpus_ipc_validation_failures_fail_closed() {
    let cases = [
        // valid_mask length must equal values length.
        (STIMULI.replace("[true,false]", "[true]"), "Stimuli"),
        // f32 overflow becomes non-finite.
        (STIMULI.replace("[0.5,1.0]", "[0.5,1e39]"), "Stimuli"),
        (SPIKES.replace(r#""strength":1.0"#, r#""strength":1e39"#), "Spikes"),
        // Trace channel identifiers must be unique.
        (
            TRACES.replace(
                r#"[{"channel_id":0,"trace_value":0.25,"last_spike_time":7}]"#,
                r#"[{"channel_id":0,"trace_value":0.25,"last_spike_time":7},{"channel_id":0,"trace_value":0.5,"last_spike_time":8}]"#,
            ),
            "EligibilityTraces",
        ),
        // Protocol strings are capped at 1024 bytes.
        (STIMULI.replace(r#""session_id":"s""#, &format!(r#""session_id":"{}""#, "x".repeat(1025))), "Stimuli"),
    ];
    for (bytes, variant) in cases {
        rejects(&bytes, variant, ProtocolErrorCode::ValidationFailed);
    }
}

#[test]
fn the_post_decode_validate_gate_rejects_directly_constructed_invalid_messages() {
    let mismatched_mask = WireEnvelope::new(IpcMessage::Stimuli(StimulusBatch {
        values: vec![0.5, 1.0],
        valid_mask: Some(vec![true]),
        ..StimulusBatch::default()
    }));
    let error = accept_decoded_envelope(mismatched_mask, ProtocolVariant::Stimuli).unwrap_err();
    assert_eq!(error.code, ProtocolErrorCode::ValidationFailed);

    let non_finite = WireEnvelope::new(IpcMessage::Stimuli(StimulusBatch {
        values: vec![f32::NAN],
        ..StimulusBatch::default()
    }));
    let error = accept_decoded_envelope(non_finite, ProtocolVariant::Stimuli).unwrap_err();
    assert_eq!(error.code, ProtocolErrorCode::ValidationFailed);

    let valid = WireEnvelope::new(IpcMessage::Spikes(SpikeBatch::default()));
    let (version, message) =
        accept_decoded_envelope(valid, ProtocolVariant::Spikes).expect("valid");
    assert_eq!(version, 1);
    assert!(matches!(message, IpcMessage::Spikes(_)));
}

#[test]
fn a_decoded_kind_that_differs_from_the_declared_kind_fails_closed() {
    rejects(SPIKES, "Stimuli", ProtocolErrorCode::KindMismatch);
    rejects(
        STIMULI,
        "EligibilityTraces",
        ProtocolErrorCode::KindMismatch,
    );
    rejects(
        r#"{"wire_version":1,"payload":"Ping"}"#,
        "Spikes",
        ProtocolErrorCode::KindMismatch,
    );
    rejects(
        r#"{"wire_version":1,"payload":{"Loss":0.5}}"#,
        "Spikes",
        ProtocolErrorCode::KindMismatch,
    );
}

#[test]
fn additive_unknown_fields_keep_corpus_ipc_forward_compatibility() {
    let additive = r#"{"wire_version":1,"producer":"future","payload":{"Stimuli":{"session_id":"s","batch_id":9007199254740993,"timestamp":0,"values":[0.5],"valid_mask":null,"metadata":{"processing_latency_ns":null,"source":"x","custom":{},"added_later":1},"added_later":{"nested":[1,2]}}}}"#;
    let inspection = signed(additive.as_bytes(), "Stimuli").expect("unknown fields are ignored");
    assert_eq!(inspection.batch_id(), 9_007_199_254_740_993);
    assert!(
        !inspection.canonical_matches_input,
        "corpus-ipc drops unknown fields when it re-encodes"
    );
    assert!(!inspection.canonical_json.contains("added_later"));
    assert!(!inspection.canonical_json.contains("producer"));
}

#[test]
fn reason_codes_are_unique_and_kebab_case() {
    let codes: HashSet<&str> = ProtocolErrorCode::ALL
        .iter()
        .map(|code| code.as_str())
        .collect();
    assert_eq!(codes.len(), ProtocolErrorCode::ALL.len());
    assert!(codes.iter().all(|code| {
        code.bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'-')
    }));
}

#[test]
fn metadata_is_projected_with_sorted_custom_entries() {
    let bytes = r#"{"wire_version":1,"payload":{"Spikes":{"session_id":null,"batch_id":1,"timestamp":2,"spikes":[],"metadata":{"processing_latency_ns":18446744073709551615,"source":"x","custom":{"b":"2","a":"1"}}}}}"#;
    let inspection = signed(bytes.as_bytes(), "Spikes").expect("valid");
    let metadata = inspection.metadata().expect("metadata present");
    assert_eq!(metadata.processing_latency_ns, Some(u64::MAX));
    assert_eq!(metadata.source.as_deref(), Some("x"));
    assert_eq!(
        metadata.custom,
        vec![
            ("a".to_owned(), "1".to_owned()),
            ("b".to_owned(), "2".to_owned())
        ]
    );
    assert_eq!(inspection.session_id(), None);
}
