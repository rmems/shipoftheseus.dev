use neuromorphic_adapter::BrowserRuntime;

#[test]
fn a_seeded_runtime_preserves_topology_provenance_and_advances_deterministically() {
    let mut left = BrowserRuntime::new(9).expect("the fixed browser topology is valid");
    let mut right = BrowserRuntime::new(9).expect("the fixed browser topology is valid");

    left.input(1, &[1.0, 0.0, 0.5, 0.25]).expect("input is accepted");
    right.input(1, &[1.0, 0.0, 0.5, 0.25]).expect("input is accepted");
    let left_state = left.step().expect("runtime can advance one tick");
    let right_state = right.step().expect("runtime can advance one tick");

    assert_eq!(left_state.contract_version, 1);
    assert_eq!(left_state.completed_step, 1);
    assert_eq!(left_state.topology_digest, right_state.topology_digest);
    assert_eq!(left_state.spike_neurons, right_state.spike_neurons);
    assert_eq!(left_state.membrane_potentials, right_state.membrane_potentials);
    assert!(left_state.topology_rows.len() > 1);
    assert_eq!(left_state.topology_targets.len(), left_state.topology_weights.len());
    assert_eq!(left_state.topology_targets.len(), left_state.topology_delays.len());
}

#[test]
fn input_sequences_are_monotonic_and_state_is_a_value_snapshot() {
    let mut runtime = BrowserRuntime::new(7).expect("the fixed browser topology is valid");
    runtime.input(5, &[0.1, 0.2, 0.3]).expect("first input is accepted");
    assert!(runtime.input(5, &[0.4]).is_err());

    let before = runtime.state();
    runtime.step().expect("runtime can advance one tick");
    let after = runtime.state();

    assert_eq!(before.completed_step, 0);
    assert_eq!(after.completed_step, 1);
    assert_eq!(after.last_sequence, 5);
}

#[test]
fn zero_is_a_valid_first_input_sequence() {
    let mut runtime = BrowserRuntime::new(7).expect("the fixed browser topology is valid");
    runtime.input(0, &[0.1, 0.2]).expect("zero is a valid first sequence");
    assert!(runtime.input(0, &[0.3]).is_err());
    assert_eq!(runtime.step().expect("runtime can advance").last_sequence, 0);
}

#[test]
fn logical_steps_advance_delays_and_do_not_require_a_second_input() {
    let mut runtime = BrowserRuntime::new(11).expect("the fixed browser topology is valid");
    runtime.input(1, &[1.0; 16]).expect("input is accepted");

    runtime.step().expect("first logical tick advances the mesh");
    assert_eq!(runtime.mesh_tick(), 1);
    assert!(runtime.state().topology_delays.iter().any(|delay| *delay > 0));
    runtime.step().expect("second logical tick advances queued delays without input");
    assert_eq!(runtime.mesh_tick(), 2);
    assert_eq!(runtime.state().completed_step, 2);
}
