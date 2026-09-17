import assert from 'node:assert/strict';
import test from 'node:test';

import { loadTsModule } from './load-ts-module.mjs';

const FIXED_TOPOLOGY_POLARITIES = new Uint8Array([
  ...Array(16).fill(1),
  ...Array(48).fill(0),
]);

function validTopologyState(overrides = {}) {
  return {
    contract_version: 2,
    seed: 2n ** 63n + 1n,
    completed_step: 7n,
    last_sequence: 2n ** 63n + 2n,
    membrane_potentials: new Float32Array([0.25, 0.5]),
    spike_neurons: new Uint32Array([1]),
    topology_rows: new Uint32Array([0, 16, 64]),
    topology_targets: new Uint32Array([...Array(16).fill(1), ...Array(48).fill(0)]),
    topology_weights: new Float32Array(Array(64).fill(0.5)),
    topology_delays: new Uint16Array(64),
    topology_node_ids: new Uint32Array([0, 1]),
    topology_edge_sources: new Uint32Array([...Array(16).fill(0), ...Array(48).fill(1)]),
    topology_edge_targets: new Uint32Array([...Array(16).fill(1), ...Array(48).fill(0)]),
    topology_edge_weights: new Float32Array(Array(64).fill(0.5)),
    topology_edge_delays: new Uint16Array(64),
    topology_polarities: new Uint8Array(FIXED_TOPOLOGY_POLARITIES),
    topology_weight_bits: new Uint32Array(Array(64).fill(0x3f000000)),
    topology_outgoing_edge_offsets: new Uint32Array([0, 16, 64]),
    topology_digest: 'synaptic-wiring.topology.digest.v1:sha256:26875faf05121b9afda27a533760369da67ba9110599fb61533f08961ff6e971',
    protocol_wire_version: 1,
    error_status: 'ok',
    ...overrides,
  };
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
          assert.deepEqual([...config], [2]);
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
  assert.deepEqual([...first.topologyNodeIds], [0, 1]);
  assert.equal(first.topologyEdgeSources.length, 64);
  assert.deepEqual([...first.topologyEdgeSources.slice(0, 17)], [...Array(16).fill(0), 1]);
  assert.deepEqual([...first.topologyEdgeTargets.slice(0, 17)], [...Array(16).fill(1), 0]);
  assert.ok(first.topologyEdgeWeights.every((weight) => weight === 0.5));
  assert.ok(first.topologyEdgeDelays.every((delay) => delay === 0));
  assert.deepEqual([...first.topologyPolarities], [...FIXED_TOPOLOGY_POLARITIES]);
  assert.deepEqual([...first.topologyOutgoingEdgeOffsets], [0, 16, 64]);
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
