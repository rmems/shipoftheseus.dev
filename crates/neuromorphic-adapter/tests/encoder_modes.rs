use neuromorphic_adapter::{
    BrowserRuntime,
    encoder::{CONTRACT_VERSION_V4, EncoderMode, normalize_to_encoder_input},
};

/// Two seeded runtimes in the same mode replay an identical spike encoding.
fn trace_for(mode: EncoderMode) -> Vec<(u32, u32, u64)> {
    let mut trace = Vec::new();
    for runtime in [
        BrowserRuntime::with_mode(9, mode, u32::from(CONTRACT_VERSION_V4)),
        BrowserRuntime::with_mode(9, mode, u32::from(CONTRACT_VERSION_V4)),
    ] {
        let mut runtime = runtime.expect("the fixed browser topology is valid");
        runtime
            .input(1, &[1.0, 0.0, 0.5, 0.25])
            .expect("input is accepted");
        runtime.step().expect("runtime can advance one tick");
        let state = runtime.state();
        trace.push((
            state.encoded_spike_count,
            state.encoded_spike_channels,
            state.encoded_spike_total,
        ));
    }
    trace
}

#[test]
fn temporal_encoding_is_deterministic_for_identical_input() {
    let trace = trace_for(EncoderMode::Temporal);
    assert_eq!(trace[0], trace[1]);
    assert_eq!(trace[0].2, u64::from(trace[0].0));
}

#[test]
fn rate_encoding_is_deterministic_for_identical_input() {
    let trace = trace_for(EncoderMode::Rate);
    assert_eq!(trace[0], trace[1]);
    assert_eq!(trace[0].2, u64::from(trace[0].0));
}

#[test]
fn temporal_and_rate_modes_both_reach_the_neuromod_path() {
    for mode in [EncoderMode::Temporal, EncoderMode::Rate] {
        let mut runtime = BrowserRuntime::with_mode(9, mode, u32::from(CONTRACT_VERSION_V4))
            .expect("the fixed browser topology is valid");
        runtime
            .input(1, &[1.0, 0.0, 0.5, 0.25])
            .expect("input is accepted");
        let state = runtime.step().expect("runtime can advance one tick");
        assert_eq!(state.error_status, "ok");
        assert_eq!(state.contract_version, u32::from(CONTRACT_VERSION_V4));
        assert_eq!(state.encoder_name, mode.name());
        assert_eq!(state.encoder_mode, mode as u8);
    }
}

#[test]
fn legacy_contract_stays_delta_only_and_v4_defaults_to_temporal() {
    let legacy = BrowserRuntime::new(9).expect("the fixed browser topology is valid");
    assert_eq!(legacy.state().contract_version, 3);
    assert_eq!(legacy.state().encoder_name, "delta");

    // The WASM `init` config surface (`[3]`, `[4]`, `[4, mode]`) is covered by
    // the browser contract checks; native tests exercise the same paths
    // through `BrowserRuntime` because `JsValue` errors abort off wasm32.
    let defaulted =
        BrowserRuntime::with_mode(9, EncoderMode::DEFAULT, u32::from(CONTRACT_VERSION_V4))
            .expect("contract 4 defaults to the temporal mode");
    assert_eq!(defaulted.state().encoder_name, "temporal");

    assert!(BrowserRuntime::with_mode(9, EncoderMode::Delta, 9).is_err());
    assert!(EncoderMode::parse(3).is_err());
    assert!(EncoderMode::parse(4).is_err());
    assert!(EncoderMode::parse(9).is_err());
    assert!(EncoderMode::parse(0).is_ok());
    assert!(EncoderMode::parse(1).is_ok());
    assert!(EncoderMode::parse(2).is_ok());
}

#[test]
fn normalization_contract_is_stable_and_mode_independent() {
    let features = normalize_to_encoder_input(&[1.0, 0.0, 0.5, 0.25]);
    assert_eq!(features.len(), 16);
    assert!(features.iter().all(|feature| (0.0..=1.0).contains(feature)));
}

#[test]
fn contract_3_rejects_non_delta_modes() {
    assert!(BrowserRuntime::with_mode(9, EncoderMode::Delta, 3).is_ok());
    for mode in [EncoderMode::Temporal, EncoderMode::Rate] {
        match BrowserRuntime::with_mode(9, mode, 3) {
            Err(error) => assert_eq!(error, "contract 3 supports only delta encoding"),
            Ok(_) => panic!("contract 3 must stay delta-only"),
        }
    }
}

#[test]
fn normalization_ignores_samples_beyond_first_sixteen() {
    let first_sixteen: Vec<f32> = (0..16).map(|index| index as f32 * 0.25).collect();
    let mut with_trailing = first_sixteen.clone();
    with_trailing.extend([100.0, -100.0, 50.0, 25.0]);
    assert_eq!(
        normalize_to_encoder_input(&first_sixteen),
        normalize_to_encoder_input(&with_trailing)
    );
}
