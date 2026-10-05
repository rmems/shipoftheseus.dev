import assert from 'node:assert/strict';
import test from 'node:test';

import { loadTsModule } from './load-ts-module.mjs';

const FIXED_TOPOLOGY_NODE_IDS = new Uint32Array([...Array(16).keys()]);
const FIXED_TOPOLOGY_ROWS = new Uint32Array([...Array(17).keys()].map((index) => index * 4));
const FIXED_TOPOLOGY_SOURCES = new Uint32Array([...Array(16).keys()].flatMap((source) => Array(4).fill(source)));
const FIXED_TOPOLOGY_TARGETS = new Uint32Array([
  1, 2, 12, 14, 3, 8, 12, 15, 0, 1, 3, 4, 2, 4, 5, 8,
  2, 3, 7, 14, 3, 4, 6, 7, 0, 5, 7, 8, 5, 6, 11, 15,
  6, 7, 9, 10, 8, 10, 11, 14, 4, 8, 9, 13, 9, 12, 13, 15,
  10, 11, 13, 14, 11, 12, 14, 15, 0, 9, 12, 15, 0, 5, 13, 14,
]);
const FIXED_TOPOLOGY_DELAYS = new Uint16Array([
  3, 1, 1, 4, 1, 4, 1, 1, 1, 2, 1, 2, 3, 1, 3, 3,
  2, 4, 1, 2, 3, 1, 3, 1, 3, 1, 4, 1, 1, 2, 1, 2,
  2, 3, 2, 3, 4, 2, 4, 4, 2, 3, 1, 2, 1, 1, 1, 4,
  1, 2, 1, 2, 2, 3, 2, 3, 3, 3, 3, 2, 2, 1, 3, 1,
]);
const FIXED_TOPOLOGY_POLARITIES = new Uint8Array([...Array(16).fill(1), ...Array(48).fill(0)]);
const FIXED_TOPOLOGY_WEIGHT_BITS = new Uint32Array([
  3210213374, 3209821784, 3205905881, 3205122701, 3209004865, 3207046914, 3205480553, 3204163308,
  3209754308, 3209362717, 3208579536, 3208187946, 3208545798, 3207762618, 3207371028, 3206196257,
  1060636822, 1060245232, 1058678871, 1054910871, 1059819904, 1059428314, 1058645133, 1058253543,
  1060569346, 1058611395, 1057828214, 1057436624, 1058186066, 1057794476, 1054708442, 1062658772,
  1057369148, 1056977558, 1055424146, 1054640966, 1055356670, 1053790309, 1063374476, 1062199706,
  1057301672, 1054506013, 1053722833, 1062165968, 1063307000, 1062132230, 1061740639, 1060957458,
  1062490082, 1062098491, 1061315310, 1060923720, 1061673163, 1061281572, 1060498392, 1060106802,
  1057166719, 1062031015, 1060856244, 1059681474, 1056518174, 1063172048, 1060039326, 1059647736,
]);
const FIXED_TOPOLOGY_ROUTED_TARGETS = new Uint32Array([
  1, 12, 2, 14, 8, 12, 3, 15, 3, 1, 4, 0, 4, 2, 5, 8,
  7, 3, 14, 2, 6, 4, 7, 3, 7, 5, 8, 0, 15, 6, 11, 5,
  9, 7, 10, 6, 10, 8, 11, 14, 13, 9, 4, 8, 12, 15, 13, 9,
  13, 11, 14, 10, 14, 12, 15, 11, 15, 9, 0, 12, 5, 14, 0, 13,
]);
const FIXED_TOPOLOGY_ROUTED_DELAYS = new Uint16Array([
  3, 1, 1, 4, 4, 1, 1, 1, 1, 2, 2, 1, 1, 3, 3, 3,
  1, 4, 2, 2, 3, 1, 1, 3, 4, 1, 1, 3, 2, 2, 1, 1,
  2, 3, 3, 2, 2, 4, 4, 4, 2, 1, 2, 3, 1, 4, 1, 1,
  1, 2, 2, 1, 2, 3, 3, 2, 2, 3, 3, 3, 1, 1, 2, 3,
]);

function float32FromBits(bits) {
  return new Float32Array(new Uint32Array(bits).buffer);
}

function routedWeights() {
  const bitsByTuple = new Map();
  for (let edge = 0; edge < FIXED_TOPOLOGY_SOURCES.length; edge += 1) {
    bitsByTuple.set(
      `${FIXED_TOPOLOGY_SOURCES[edge]}:${FIXED_TOPOLOGY_TARGETS[edge]}:${FIXED_TOPOLOGY_DELAYS[edge]}`,
      FIXED_TOPOLOGY_WEIGHT_BITS[edge],
    );
  }
  return float32FromBits(FIXED_TOPOLOGY_ROUTED_TARGETS.map((target, edge) => bitsByTuple.get(
    `${Math.floor(edge / 4)}:${target}:${FIXED_TOPOLOGY_ROUTED_DELAYS[edge]}`,
  )));
}

function validTopologyState(overrides = {}) {
  const state = {
    contract_version: 4,
    encoder_mode: 0,
    encoder_name: 'delta',
    encoded_spike_count: 0,
    encoded_spike_channels: 0,
    encoded_spike_total: 0n,
    seed: 2n ** 63n + 1n,
    completed_step: 7n,
    last_sequence: 2n ** 63n + 2n,
    membrane_potentials: new Float32Array([0.25, 0.5, ...Array(14).fill(0)]),
    spike_neurons: new Uint32Array([1]),
    topology_rows: new Uint32Array(FIXED_TOPOLOGY_ROWS),
    topology_targets: new Uint32Array(FIXED_TOPOLOGY_ROUTED_TARGETS),
    topology_weights: routedWeights(),
    topology_delays: new Uint16Array(FIXED_TOPOLOGY_ROUTED_DELAYS),
    topology_node_ids: new Uint32Array(FIXED_TOPOLOGY_NODE_IDS),
    topology_edge_sources: new Uint32Array(FIXED_TOPOLOGY_SOURCES),
    topology_edge_targets: new Uint32Array(FIXED_TOPOLOGY_TARGETS),
    topology_edge_weights: float32FromBits(FIXED_TOPOLOGY_WEIGHT_BITS),
    topology_edge_delays: new Uint16Array(FIXED_TOPOLOGY_DELAYS),
    topology_polarities: new Uint8Array(FIXED_TOPOLOGY_POLARITIES),
    topology_weight_bits: new Uint32Array(FIXED_TOPOLOGY_WEIGHT_BITS),
    topology_outgoing_edge_offsets: new Uint32Array(FIXED_TOPOLOGY_ROWS),
    topology_digest: 'synaptic-wiring.topology.digest.v1:sha256:26875faf05121b9afda27a533760369da67ba9110599fb61533f08961ff6e971',
    protocol_wire_version: 1,
    error_status: 'ok',
    ...overrides,
  };
  return state;
}

async function adapterForState(runtime, state) {
  return runtime.initNeuromorphicAdapter(
    async () => ({
      async default() {},
      WasmAdapter: {
        init() {
          return { input() {}, step() { return state; }, state() { return state; }, dispose() {} };
        },
      },
    }),
    1n,
  );
}

test('the browser bridge copies typed-array snapshots and preserves lossless u64 values', async () => {
  const runtime = await loadTsModule('../src/runtime/neuromorphic-adapter.ts');
  const state = validTopologyState();
  const memory = state.membrane_potentials;
  const adapter = await runtime.initNeuromorphicAdapter(
    async () => ({
      async default() {},
      WasmAdapter: {
        init(seed, config) {
          assert.equal(seed, 9n);
          assert.deepEqual([...config], [3]);
          return {
            input(sequence, samples) {
              assert.equal(sequence, 4n);
              assert.deepEqual([...samples], [...new Float32Array([0.1, 0.2])]);
            },
            step() { return state; },
            state() { return state; },
            dispose() {},
          };
        },
      },
    }),
    9n,
  );

  adapter.input(4n, new Float32Array([0.1, 0.2]));
  const first = adapter.state();
  memory[0] = 99;
  const second = adapter.step();

  assert.equal(first.seed, 2n ** 63n + 1n);
  assert.equal(first.lastSequence, 2n ** 63n + 2n);
  assert.equal(first.errorStatus, 'ok');
  assert.equal(first.membranePotentials[0], 0.25);
  assert.equal(second.membranePotentials[0], 99);
  assert.notEqual(first.membranePotentials.buffer, second.membranePotentials.buffer);
  assert.deepEqual([...first.topologyNodeIds], [...FIXED_TOPOLOGY_NODE_IDS]);
  assert.equal(first.topologyEdgeSources.length, 64);
  assert.deepEqual([...first.topologyEdgeSources], [...FIXED_TOPOLOGY_SOURCES]);
  assert.deepEqual([...first.topologyEdgeTargets], [...FIXED_TOPOLOGY_TARGETS]);
  assert.deepEqual([...first.topologyEdgeDelays], [...FIXED_TOPOLOGY_DELAYS]);
  assert.deepEqual([...first.topologyWeightBits], [...FIXED_TOPOLOGY_WEIGHT_BITS]);
  assert.deepEqual([...first.topologyPolarities], [...FIXED_TOPOLOGY_POLARITIES]);
  assert.deepEqual([...first.topologyOutgoingEdgeOffsets], [...FIXED_TOPOLOGY_ROWS]);
});

test('the browser bridge fails closed after disposal and rejects invalid u64 state', async () => {
  const runtime = await loadTsModule('../src/runtime/neuromorphic-adapter.ts');
  let disposeCalls = 0;
  const invalidState = {
    contract_version: 1,
    seed: 1,
    completed_step: 0n,
    last_sequence: 0n,
    membrane_potentials: new Float32Array(),
    spike_neurons: new Uint32Array(),
    topology_rows: new Uint32Array(),
    topology_targets: new Uint32Array(),
    topology_weights: new Float32Array(),
    topology_delays: new Uint16Array(),
    topology_digest: 'invalid',
    protocol_wire_version: 1,
    error_status: 'ok',
  };
  const adapter = await runtime.initNeuromorphicAdapter(
    async () => ({
      async default() {},
      WasmAdapter: {
        init() {
          return {
            input() {},
            step() { return invalidState; },
            state() { return invalidState; },
            dispose() { disposeCalls += 1; },
          };
        },
      },
    }),
    1n,
  );

  assert.throws(() => adapter.state(), runtime.AdapterUnavailableError);
  adapter.dispose();
  adapter.dispose();
  assert.equal(disposeCalls, 1);
  assert.throws(() => adapter.step(), runtime.AdapterUnavailableError);
});

test('the browser bridge rejects malformed typed arrays and topology shapes', async () => {
  const runtime = await loadTsModule('../src/runtime/neuromorphic-adapter.ts');
  const malformed = {
    contract_version: 1,
    seed: 1n,
    completed_step: 0n,
    last_sequence: 0n,
    membrane_potentials: [],
    spike_neurons: new Uint32Array(),
    topology_rows: new Uint32Array([0]),
    topology_targets: new Uint32Array(),
    topology_weights: new Float32Array(),
    topology_delays: new Uint16Array(),
    topology_digest: 'digest',
    protocol_wire_version: 1,
    error_status: 'ok',
  };
  const adapter = await runtime.initNeuromorphicAdapter(
    async () => ({
      async default() {},
      WasmAdapter: {
        init() {
          return {
            input() {},
            step() { return malformed; },
            state() { return malformed; },
            dispose() {},
          };
        },
      },
    }),
    1n,
  );

  assert.throws(() => adapter.state(), runtime.AdapterUnavailableError);
});

test('the browser bridge rejects canonical weights whose IEEE-754 bits disagree', async () => {
  const runtime = await loadTsModule('../src/runtime/neuromorphic-adapter.ts');
  const state = validTopologyState({
    seed: 1n,
    completed_step: 0n,
    last_sequence: 0n,
    spike_neurons: new Uint32Array(),
    topology_weight_bits: new Uint32Array([0]),
  });
  const adapter = await adapterForState(runtime, state);

  assert.throws(() => adapter.state(), runtime.AdapterUnavailableError);
});

test('the browser bridge rejects a source range with noncanonical edge order', async () => {
  const runtime = await loadTsModule('../src/runtime/neuromorphic-adapter.ts');
  const targets = new Uint32Array([
    ...Array(16).fill(1),
    1,
    0,
    ...Array(46).fill(0),
  ]);
  const state = validTopologyState({
    spike_neurons: new Uint32Array(),
    topology_targets: new Uint32Array(targets),
    topology_edge_targets: new Uint32Array(targets),
  });
  const adapter = await adapterForState(runtime, state);

  assert.throws(() => adapter.state(), runtime.AdapterUnavailableError);
});

test('the browser bridge rejects a canonical projection that disagrees with routed CSR topology', async () => {
  const runtime = await loadTsModule('../src/runtime/neuromorphic-adapter.ts');
  const state = validTopologyState({ topology_targets: new Uint32Array([0]) });
  const adapter = await adapterForState(runtime, state);

  assert.throws(() => adapter.state(), runtime.AdapterUnavailableError);
});

test('the browser bridge rejects a stale digest for the fixed exported topology', async () => {
  const runtime = await loadTsModule('../src/runtime/neuromorphic-adapter.ts');
  const state = validTopologyState({
    topology_digest: 'synaptic-wiring.topology.digest.v1:sha256:stale',
  });
  const adapter = await adapterForState(runtime, state);

  assert.throws(() => adapter.state(), runtime.AdapterUnavailableError);
});

test('the browser bridge rejects a forged fixed digest paired with a structurally valid alternate projection', async () => {
  const runtime = await loadTsModule('../src/runtime/neuromorphic-adapter.ts');
  const canonicalTargets = new Uint32Array(FIXED_TOPOLOGY_TARGETS);
  const routedTargets = new Uint32Array(FIXED_TOPOLOGY_ROUTED_TARGETS);
  canonicalTargets[1] = 3;
  routedTargets[2] = 3;
  const adapter = await adapterForState(runtime, validTopologyState({
    topology_edge_targets: canonicalTargets,
    topology_targets: routedTargets,
  }));

  assert.throws(() => adapter.state(), runtime.AdapterUnavailableError);
});

test('the browser bridge rejects a changed polarity tag for the fixed exported topology', async () => {
  const runtime = await loadTsModule('../src/runtime/neuromorphic-adapter.ts');
  const polarities = new Uint8Array(FIXED_TOPOLOGY_POLARITIES);
  polarities[0] = 0;
  const adapter = await adapterForState(runtime, validTopologyState({ topology_polarities: polarities }));

  assert.throws(() => adapter.state(), runtime.AdapterUnavailableError);
});

test('the browser bridge rejects a non-object state and out-of-range topology targets', async () => {
  const runtime = await loadTsModule('../src/runtime/neuromorphic-adapter.ts');
  const states = [null, {
    contract_version: 1,
    seed: 1n,
    completed_step: 0n,
    last_sequence: 0n,
    membrane_potentials: new Float32Array([0]),
    spike_neurons: new Uint32Array(),
    topology_rows: new Uint32Array([0, 1]),
    topology_targets: new Uint32Array([1]),
    topology_weights: new Float32Array([0.5]),
    topology_delays: new Uint16Array([0]),
    topology_digest: 'digest',
    protocol_wire_version: 1,
    error_status: 'ok',
  }];
  for (const state of states) {
    const adapter = await runtime.initNeuromorphicAdapter(
      async () => ({
        async default() {},
        WasmAdapter: {
          init() {
            return { input() {}, step() { return state; }, state() { return state; }, dispose() {} };
          },
        },
      }),
      1n,
    );
    assert.throws(() => adapter.state(), runtime.AdapterUnavailableError);
  }
});

test('the browser bridge rejects out-of-range u64 values and non-string digests', async () => {
  const runtime = await loadTsModule('../src/runtime/neuromorphic-adapter.ts');
  const base = {
    contract_version: 1, seed: 1n, completed_step: 0n, last_sequence: 0n,
    membrane_potentials: new Float32Array([0]), spike_neurons: new Uint32Array(),
    topology_rows: new Uint32Array([0, 0]), topology_targets: new Uint32Array(),
    topology_weights: new Float32Array(), topology_delays: new Uint16Array(),
    topology_digest: 'digest', protocol_wire_version: 1, error_status: 'ok',
  };
  for (const state of [
    { ...base, seed: -1n },
    { ...base, completed_step: 1n << 64n },
    { ...base, topology_digest: null },
    { ...base, error_status: 'unrecognized-status' },
    { ...base, spike_neurons: new Uint32Array([1]) },
  ]) {
    const adapter = await runtime.initNeuromorphicAdapter(async () => ({ async default() {}, WasmAdapter: { init() { return { input() {}, step() { return state; }, state() { return state; }, dispose() {} }; } } }), 1n);
    assert.throws(() => adapter.state(), runtime.AdapterUnavailableError);
  }
});

test('the browser bridge rejects out-of-range u64 inputs before invoking WASM', async () => {
  const runtime = await loadTsModule('../src/runtime/neuromorphic-adapter.ts');
  let initCalls = 0;
  let inputCalls = 0;
  const loadWasmModule = async () => ({
    async default() {},
    WasmAdapter: {
      init() {
        initCalls += 1;
        return {
          input() { inputCalls += 1; },
          step() { throw new Error('not reached'); },
          state() { throw new Error('not reached'); },
          dispose() {},
        };
      },
    },
  });

  await assert.rejects(
    () => runtime.initNeuromorphicAdapter(loadWasmModule, -1n),
    runtime.AdapterUnavailableError,
  );
  assert.equal(initCalls, 0);

  const adapter = await runtime.initNeuromorphicAdapter(loadWasmModule, 1n);
  assert.throws(() => adapter.input(1n << 64n, new Float32Array([0.25])), runtime.AdapterUnavailableError);
  assert.equal(inputCalls, 0);
});

test('the adapter snapshot exposes exactly the minimum render and inspection state', async () => {
  const runtime = await loadTsModule('../src/runtime/neuromorphic-adapter.ts');
  const state = validTopologyState();
  const adapter = await runtime.initNeuromorphicAdapter(
    async () => ({
      async default() {},
      WasmAdapter: {
        init() {
          return { input() {}, step() { return state; }, state() { return state; }, dispose() {} };
        },
      },
    }),
    9n,
  );

  assert.deepEqual(
    Object.keys(adapter.state()).sort(),
    [
      // provenance: seed, step, sequence, digest, versions, status
      'contractVersion', 'seed', 'completedStep', 'lastSequence',
      'topologyDigest', 'protocolWireVersion', 'errorStatus',
      // encoder inspection: active mode and derived spike-train diagnostics
      'encoderMode', 'encoderName', 'encodedSpikeCount', 'encodedSpikeChannels',
      'encodedSpikeTotal',
      // neuron state: spikes and potentials
      'spikeNeurons', 'membranePotentials',
      // topology: node ids, edges, offsets, weight bits
      'topologyNodeIds', 'topologyRows', 'topologyTargets', 'topologyWeights',
      'topologyDelays', 'topologyEdgeSources', 'topologyEdgeTargets',
      'topologyEdgeWeights', 'topologyEdgeDelays', 'topologyPolarities',
      'topologyWeightBits', 'topologyOutgoingEdgeOffsets',
    ].sort(),
  );
});

test('the browser bridge selects temporal and rate encoder modes without changing the renderer contract', async () => {
  const runtime = await loadTsModule('../src/runtime/neuromorphic-adapter.ts');
  const baseKeys = Object.keys(
    (await adapterForState(runtime, validTopologyState())).state(),
  ).sort();
  for (const [encoderMode, expectedConfig] of [['temporal', [4, 1]], ['rate', [4, 2]]]) {
    const state = validTopologyState({
      encoder_mode: expectedConfig[1],
      encoder_name: encoderMode,
      encoded_spike_count: 3,
      encoded_spike_channels: 2,
      encoded_spike_total: 3n,
    });
    let seenConfig;
    const adapter = await runtime.initNeuromorphicAdapter(
      async () => ({
        async default() {},
        WasmAdapter: {
          init(seed, config) {
            seenConfig = [...config];
            return { input() {}, step() { return state; }, state() { return state; }, dispose() {} };
          },
        },
      }),
      9n,
      { encoderMode },
    );
    assert.deepEqual(seenConfig, expectedConfig);
    const snapshot = adapter.state();
    assert.equal(snapshot.encoderMode, expectedConfig[1]);
    assert.equal(snapshot.encoderName, encoderMode);
    assert.equal(snapshot.encodedSpikeCount, 3);
    assert.equal(snapshot.encodedSpikeChannels, 2);
    assert.equal(snapshot.encodedSpikeTotal, 3n);
    assert.deepEqual(Object.keys(snapshot).sort(), baseKeys);
  }
});

test('the browser bridge defaults explicit contract-4 init to the temporal encoder mode', async () => {
  const runtime = await loadTsModule('../src/runtime/neuromorphic-adapter.ts');
  const state = validTopologyState({
    encoder_mode: 1,
    encoder_name: 'temporal',
    encoded_spike_count: 0,
    encoded_spike_channels: 0,
    encoded_spike_total: 0n,
  });
  let seenConfig;
  const adapter = await runtime.initNeuromorphicAdapter(
    async () => ({
      async default() {},
      WasmAdapter: {
        init(seed, config) {
          seenConfig = [...config];
          return { input() {}, step() { return state; }, state() { return state; }, dispose() {} };
        },
      },
    }),
    9n,
    { contractVersion: 4 },
  );
  assert.deepEqual(seenConfig, [4, 1]);
  assert.equal(adapter.state().encoderName, 'temporal');
});

test('the browser bridge keeps legacy contract-3 delta-only init and rejects mismatched modes', async () => {
  const runtime = await loadTsModule('../src/runtime/neuromorphic-adapter.ts');
  const legacy = validTopologyState({
    contract_version: 3,
    encoder_mode: undefined,
    encoder_name: undefined,
    encoded_spike_count: undefined,
    encoded_spike_channels: undefined,
    encoded_spike_total: undefined,
  });
  delete legacy.encoder_mode;
  delete legacy.encoder_name;
  delete legacy.encoded_spike_count;
  delete legacy.encoded_spike_channels;
  delete legacy.encoded_spike_total;
  let seenConfig;
  const adapter = await runtime.initNeuromorphicAdapter(
    async () => ({
      async default() {},
      WasmAdapter: {
        init(seed, config) {
          seenConfig = [...config];
          return { input() {}, step() { return legacy; }, state() { return legacy; }, dispose() {} };
        },
      },
    }),
    9n,
  );
  assert.deepEqual(seenConfig, [3]);
  const snapshot = adapter.state();
  assert.equal(snapshot.encoderMode, 0);
  assert.equal(snapshot.encoderName, 'delta');
  assert.equal(snapshot.encodedSpikeCount, 0);
  assert.equal(snapshot.encodedSpikeChannels, 0);
  assert.equal(snapshot.encodedSpikeTotal, 0n);

  const loadWasmModule = async () => ({
    async default() {},
    WasmAdapter: { init() { throw new Error('not reached'); } },
  });
  await assert.rejects(
    () => runtime.initNeuromorphicAdapter(loadWasmModule, 1n, { contractVersion: 3, encoderMode: 'temporal' }),
    runtime.AdapterUnavailableError,
  );
  await assert.rejects(
    () => runtime.initNeuromorphicAdapter(loadWasmModule, 1n, { contractVersion: 3, encoderMode: 'rate' }),
    runtime.AdapterUnavailableError,
  );
  await assert.rejects(
    () => runtime.initNeuromorphicAdapter(loadWasmModule, 1n, { encoderMode: 'population' }),
    runtime.AdapterUnavailableError,
  );
});
