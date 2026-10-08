use neuromorphic_adapter::{
    BrowserRuntime, CONTRACT_VERSION_V5,
    encoder::EncoderMode,
    kinetic::{KineticExtractor, channel},
};

fn runtime() -> BrowserRuntime {
    BrowserRuntime::with_mode(9, EncoderMode::DEFAULT, CONTRACT_VERSION_V5)
        .expect("the fixed browser topology is valid")
}

#[test]
fn out_of_range_telemetry_is_clamped_before_encoding() {
    let mut runtime = runtime();
    runtime
        .input(1, &[0.5, 0.5, 0.0])
        .expect("first packet is accepted");
    // A pointer far outside the island with an impossible pressure.
    runtime
        .input(2, &[40.0, -25.0, 9.0])
        .expect("finite out-of-range packets are accepted and clamped");
    let features = runtime.state().encoder_features;

    assert_eq!(features.len(), 16);
    assert!(features.iter().all(|value| (0.0..=1.0).contains(value)));
    assert_eq!(features[channel::X], 1.0);
    assert_eq!(features[channel::Y], 0.0);
    assert_eq!(features[channel::PRESSURE], 1.0);
    // Positions clamp before differencing: the edge jump is (+0.5, -0.5),
    // which saturates velocity rather than reflecting the raw 39.5 offset.
    assert_eq!(features[channel::VELOCITY_X_POSITIVE], 1.0);
    assert_eq!(features[channel::VELOCITY_X_NEGATIVE], 0.0);
    assert_eq!(features[channel::VELOCITY_Y_NEGATIVE], 1.0);
    assert_eq!(features[channel::VELOCITY_Y_POSITIVE], 0.0);
}

#[test]
fn motion_direction_and_magnitude_map_to_the_documented_channels() {
    let mut extractor = KineticExtractor::new();
    let rest = extractor.extract(&[0.2, 0.6, 0.0]);
    assert_eq!(
        rest[channel::SPEED],
        0.0,
        "the first packet has no velocity"
    );

    // 0.03 right and 0.04 up per tick: speed 0.05, half of full scale (0.1).
    let moving = extractor.extract(&[0.23, 0.56, 0.0]);
    let close = |actual: f32, expected: f32| (actual - expected).abs() < 1e-5;
    assert!(close(moving[channel::VELOCITY_X_POSITIVE], 0.3));
    assert_eq!(moving[channel::VELOCITY_X_NEGATIVE], 0.0);
    assert!(close(moving[channel::VELOCITY_Y_NEGATIVE], 0.4));
    assert_eq!(moving[channel::VELOCITY_Y_POSITIVE], 0.0);
    assert!(close(moving[channel::SPEED], 0.5));
    assert!(close(moving[channel::ACCELERATION], 1.0));
    // EMA(3) has alpha 0.5, so the fast average sits halfway between 0 and 0.5.
    assert!(close(moving[channel::SPEED_FAST_EMA], 0.25));
    assert!(moving[channel::SPEED_SURPRISE] > 0.0);

    // Holding still decays velocity to zero while the slow EMA retains motion.
    let held = extractor.extract(&[0.23, 0.56, 0.0]);
    assert_eq!(held[channel::SPEED], 0.0);
    assert!(held[channel::SPEED_SLOW_EMA] > 0.0);
}

#[test]
fn contract_five_rejects_packets_that_are_not_x_y_pressure() {
    let mut runtime = runtime();
    let raw_samples: Vec<f32> = (0..16).map(|index| index as f32 / 16.0).collect();
    assert!(runtime.input(1, &raw_samples).is_err());
    assert_eq!(runtime.state().error_status, "input-telemetry-shape");
    assert_eq!(
        runtime.state().last_sequence,
        0,
        "a rejected packet is not consumed"
    );

    runtime
        .input(1, &[0.1, 0.2, 0.0])
        .expect("a well-formed packet is accepted after a rejection");
    assert_eq!(runtime.state().error_status, "ok");
}

#[test]
fn telemetry_drives_axon_encoder_spikes_into_the_network() {
    let mut runtime = runtime();
    let mut encoded = 0;
    let mut fired = 0;
    for sequence in 1..=40_u64 {
        let t = sequence as f32 * 0.25;
        runtime
            .input(
                sequence,
                &[0.5 + 0.4 * t.sin(), 0.5 + 0.4 * (t * 0.7).cos(), 0.5],
            )
            .expect("telemetry is accepted");
        let state = runtime.step().expect("runtime can advance");
        encoded += state.encoded_spike_count;
        fired += state.spike_neurons.len();
    }
    let state = runtime.state();
    assert_eq!(state.contract_version, CONTRACT_VERSION_V5);
    assert_eq!(state.encoder_name, "temporal");
    assert!(
        encoded > 0,
        "telemetry features must produce encoded spikes"
    );
    assert!(fired > 0, "encoded spikes must reach neuromod");
}
