import assert from 'node:assert/strict';
import test from 'node:test';

import { loadTsModule } from './load-ts-module.mjs';

test('the browser bridge copies typed-array snapshots and preserves lossless u64 values', async () => {
  const runtime = await loadTsModule('../src/runtime/neuromorphic-adapter.ts');
  const memory = new Float32Array([0.25, 0.5]);
  const state = {
    contract_version: 1,
    seed: 2n ** 63n + 1n,
    completed_step: 7n,
    last_sequence: 2n ** 63n + 2n,
    membrane_potentials: memory,
    spike_neurons: new Uint32Array([1]),
    topology_rows: new Uint32Array([0, 1, 1]),
    topology_targets: new Uint32Array([1]),
    topology_weights: new Float32Array([0.5]),
    topology_delays: new Uint16Array([0]),
    topology_digest: 'test-digest',
    protocol_wire_version: 1,
  };
  const adapter = await runtime.initNeuromorphicAdapter(
    async () => ({
      async default() {},
      WasmAdapter: {
        init(seed, config) {
          assert.equal(seed, 9n);
          assert.deepEqual([...config], [1]);
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
  assert.equal(first.membranePotentials[0], 0.25);
  assert.equal(second.membranePotentials[0], 99);
  assert.notEqual(first.membranePotentials.buffer, second.membranePotentials.buffer);
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
