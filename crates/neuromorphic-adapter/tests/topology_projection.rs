use neuromorphic_adapter::TopologyProjection;
use synaptic_wiring::{Polarity, SynapseDescriptor, SynapticGraph};

fn descriptor(
    source: u32,
    target: u32,
    weight: f32,
    delay: u16,
    polarity: Polarity,
) -> SynapseDescriptor {
    SynapseDescriptor {
        source,
        target,
        weight,
        delay,
        polarity,
    }
}

#[test]
fn canonical_projection_is_order_independent_and_preserves_parallel_signed_zero_edges() {
    let left = SynapticGraph::from_descriptors(
        3,
        &[
            descriptor(2, 0, 0.4, 1, Polarity::Inhibitory),
            descriptor(1, 0, -0.0, 3, Polarity::Excitatory),
            descriptor(1, 0, 0.0, 3, Polarity::Excitatory),
            descriptor(1, 0, 0.0, 3, Polarity::Excitatory),
        ],
    )
    .expect("descriptors are valid");
    let right = SynapticGraph::from_descriptors(
        3,
        &[
            descriptor(1, 0, 0.0, 3, Polarity::Excitatory),
            descriptor(2, 0, 0.4, 1, Polarity::Inhibitory),
            descriptor(1, 0, 0.0, 3, Polarity::Excitatory),
            descriptor(1, 0, -0.0, 3, Polarity::Excitatory),
        ],
    )
    .expect("descriptors are valid");

    let left = TopologyProjection::from_graph(&left);
    let right = TopologyProjection::from_graph(&right);

    assert_eq!(left, right);
    assert_eq!(left.node_ids, vec![0, 1, 2]);
    assert_eq!(left.edge_sources, vec![1, 1, 1, 2]);
    assert_eq!(left.edge_targets, vec![0, 0, 0, 0]);
    assert_eq!(left.edge_delays, vec![3, 3, 3, 1]);
    assert_eq!(left.edge_polarities, vec![0, 0, 0, 1]);
    assert_eq!(
        left.edge_weight_bits,
        vec![0, 0, (-0.0_f32).to_bits(), (-0.4_f32).to_bits()]
    );
    assert_eq!(left.outgoing_edge_offsets, vec![0, 0, 3, 4]);
}

#[test]
fn projection_identity_is_scoped_to_the_upstream_topology_digest() {
    let graph =
        SynapticGraph::from_descriptors(2, &[descriptor(0, 1, 0.5, 2, Polarity::Excitatory)])
            .expect("descriptor is valid");

    let projection = TopologyProjection::from_graph(&graph);

    assert_eq!(
        projection.topology_digest,
        graph.topology_digest().to_string()
    );
    assert_eq!(projection.canonical_edge_indices(), vec![0]);
    assert_eq!(projection.outgoing_edge_range(0), 0..1);
    assert_eq!(projection.outgoing_edge_range(1), 1..1);
}
