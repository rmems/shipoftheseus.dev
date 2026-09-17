use neuromorphic_adapter::BrowserRuntime;

#[test]
fn a_seeded_runtime_preserves_topology_provenance_and_advances_deterministically() {
    let mut left = BrowserRuntime::new(9).expect("the fixed browser topology is valid");
    let mut right = BrowserRuntime::new(9).expect("the fixed browser topology is valid");

    left.input(1, &[1.0, 0.0, 0.5, 0.25])
        .expect("input is accepted");
    right
        .input(1, &[1.0, 0.0, 0.5, 0.25])
        .expect("input is accepted");
    let left_state = left.step().expect("runtime can advance one tick");
    let right_state = right.step().expect("runtime can advance one tick");

    assert_eq!(left_state.contract_version, 2);
    assert_eq!(left_state.completed_step, 1);
    assert_eq!(left_state.topology_digest, right_state.topology_digest);
    assert_eq!(left_state.topology_node_ids, right_state.topology_node_ids);
    assert_eq!(
        left_state.topology_edge_sources,
        right_state.topology_edge_sources
    );
    assert_eq!(
        left_state.topology_edge_targets,
        right_state.topology_edge_targets
    );
    assert_eq!(
        left_state.topology_edge_weights,
        right_state.topology_edge_weights
    );
    assert_eq!(
        left_state.topology_edge_delays,
        right_state.topology_edge_delays
    );
    assert_eq!(
        left_state.topology_polarities,
        right_state.topology_polarities
    );
    assert_eq!(
        left_state.topology_weight_bits,
        right_state.topology_weight_bits
    );
    assert_eq!(
        left_state.topology_outgoing_edge_offsets,
        right_state.topology_outgoing_edge_offsets
    );
    assert_eq!(left_state.spike_neurons, right_state.spike_neurons);
    assert_eq!(
        left_state.membrane_potentials,
        right_state.membrane_potentials
    );
    assert_eq!(
        left_state.topology_digest,
        "synaptic-wiring.topology.digest.v1:sha256:26875faf05121b9afda27a533760369da67ba9110599fb61533f08961ff6e971",
    );
    assert_eq!(left_state.spike_neurons, Vec::<u32>::new());
    assert_eq!(
        left_state
            .membrane_potentials
            .iter()
            .map(|potential| potential.to_bits())
            .collect::<Vec<_>>(),
        vec![0; 16],
    );
    assert!(left_state.topology_rows.len() > 1);
    assert_eq!(
        left_state.topology_targets.len(),
        left_state.topology_weights.len()
    );
    assert_eq!(
        left_state.topology_targets.len(),
        left_state.topology_delays.len()
    );
}

#[test]
fn input_sequences_are_monotonic_and_state_is_a_value_snapshot() {
    let mut runtime = BrowserRuntime::new(7).expect("the fixed browser topology is valid");
    runtime
        .input(5, &[0.1, 0.2, 0.3])
        .expect("first input is accepted");
    assert!(runtime.input(5, &[0.4]).is_err());
    assert_eq!(
        runtime.state().error_status,
        "input-sequence-not-increasing"
    );

    let before = runtime.state();
    runtime.step().expect("runtime can advance one tick");
    let after = runtime.state();

    assert_eq!(before.completed_step, 0);
    assert_eq!(after.completed_step, 1);
    assert_eq!(after.last_sequence, 5);
    assert_eq!(after.error_status, "ok");
}

#[test]
fn invalid_input_publishes_a_stable_error_status_without_mutating_the_accepted_sequence() {
    let mut runtime = BrowserRuntime::new(3).expect("the fixed browser topology is valid");

    assert!(runtime.input(0, &[f32::NAN]).is_err());
    let failed_state = runtime.state();
    assert_eq!(failed_state.error_status, "input-non-finite-samples");
    assert_eq!(failed_state.last_sequence, 0);

    runtime
        .input(0, &[0.25])
        .expect("the first valid input is accepted");
    assert_eq!(runtime.state().error_status, "ok");
}

#[test]
fn zero_is_a_valid_first_input_sequence() {
    let mut runtime = BrowserRuntime::new(7).expect("the fixed browser topology is valid");
    runtime
        .input(0, &[0.1, 0.2])
        .expect("zero is a valid first sequence");
    assert!(runtime.input(0, &[0.3]).is_err());
    assert_eq!(
        runtime.step().expect("runtime can advance").last_sequence,
        0
    );
}

#[test]
fn logical_steps_advance_delays_and_do_not_require_a_second_input() {
    let mut runtime = BrowserRuntime::new(11).expect("the fixed browser topology is valid");
    runtime.input(1, &[1.0; 16]).expect("input is accepted");

    runtime
        .step()
        .expect("first logical tick advances the mesh");
    assert_eq!(runtime.mesh_tick(), 1);
    assert!(
        runtime
            .state()
            .topology_delays
            .iter()
            .any(|delay| *delay > 0)
    );
    runtime
        .step()
        .expect("second logical tick advances queued delays without input");
    assert_eq!(runtime.mesh_tick(), 2);
    assert_eq!(runtime.state().completed_step, 2);
}

#[test]
fn runtime_seed_is_provenance_not_topology_and_state_exposes_canonical_edge_lookup() {
    let left = BrowserRuntime::new(1).expect("the fixed browser topology is valid");
    let right = BrowserRuntime::new(99).expect("the fixed browser topology is valid");

    let left = left.state();
    let right = right.state();

    assert_eq!(left.seed, 1);
    assert_eq!(right.seed, 99);
    assert_eq!(left.topology_digest, right.topology_digest);
    assert_eq!(left.topology_node_ids, right.topology_node_ids);
    assert_eq!(left.topology_edge_sources, right.topology_edge_sources);
    assert_eq!(left.topology_edge_targets, right.topology_edge_targets);
    assert_eq!(
        left.topology_edge_weights
            .iter()
            .map(|weight| weight.to_bits())
            .collect::<Vec<_>>(),
        right
            .topology_edge_weights
            .iter()
            .map(|weight| weight.to_bits())
            .collect::<Vec<_>>(),
    );
    assert_eq!(left.topology_edge_delays, right.topology_edge_delays);
    assert_eq!(left.topology_polarities, right.topology_polarities);
    assert_eq!(left.topology_weight_bits, right.topology_weight_bits);
    assert_eq!(
        left.topology_outgoing_edge_offsets,
        right.topology_outgoing_edge_offsets
    );
    assert_eq!(left.topology_node_ids, (0..16).collect::<Vec<_>>());
    assert_eq!(
        left.topology_edge_sources.len(),
        left.topology_targets.len()
    );
    assert_eq!(
        left.topology_edge_sources.len(),
        left.topology_edge_targets.len()
    );
    assert_eq!(
        left.topology_edge_sources.len(),
        left.topology_edge_weights.len()
    );
    assert_eq!(
        left.topology_edge_sources.len(),
        left.topology_edge_delays.len()
    );
    assert_eq!(
        left.topology_edge_sources.len(),
        left.topology_polarities.len()
    );
    assert_eq!(
        left.topology_edge_sources.len(),
        left.topology_weight_bits.len()
    );
    assert_eq!(
        left.topology_outgoing_edge_offsets.len(),
        left.topology_node_ids.len() + 1
    );
    assert_eq!(left.topology_outgoing_edge_offsets.first(), Some(&0));
    assert_eq!(
        left.topology_outgoing_edge_offsets.last(),
        Some(&(left.topology_edge_sources.len() as u32))
    );
    assert!(
        left.topology_outgoing_edge_offsets
            .windows(2)
            .all(|offsets| offsets[0] <= offsets[1])
    );
}
