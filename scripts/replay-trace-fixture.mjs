// Replay a generated seed-9 trace fixture through generated WASM bindings and
// compare every step bit-exactly. The function body must stay self-contained
// (no imports, no Node APIs): verify-neuromorphic-browser.mjs injects it into
// a headless-browser page via function-source serialization.
//
// `u64` values travel as decimal strings and are converted with `BigInt`.
// Never parse them into a JavaScript `Number`.

export async function replayTraceFixture(fixture, initAdapter) {
  const adapter = await initAdapter(BigInt(fixture.seed));
  for (const operation of fixture.operations) {
    if (operation.op === 'input') {
      adapter.input(BigInt(operation.sequence), new Float32Array(operation.samples));
      continue;
    }
    if (operation.op !== 'step') {
      throw new Error(`unknown fixture operation ${operation.op}`);
    }
    const state = adapter.step();
    const expected = operation.expected;
    const actual = {
      completed_step: state.completed_step.toString(),
      last_sequence: state.last_sequence.toString(),
      status: state.error_status,
      spikes: Array.from(state.spike_neurons).join(','),
      potential_bits: Array.from(
        new Uint32Array(
          state.membrane_potentials.buffer,
          state.membrane_potentials.byteOffset,
          state.membrane_potentials.length,
        ),
      )
        .map((bits) => bits.toString(16).padStart(8, '0'))
        .join(','),
    };
    const wanted = {
      completed_step: expected.completed_step,
      last_sequence: expected.last_sequence,
      status: expected.status,
      spikes: expected.spikes.join(','),
      potential_bits: expected.potential_bits.join(','),
    };
    for (const key of Object.keys(wanted)) {
      if (actual[key] !== wanted[key]) {
        throw new Error(
          `trace diverged at step ${expected.completed_step} field ${key}: ` +
            `expected ${wanted[key]} but replay produced ${actual[key]}`,
        );
      }
    }
  }
  return adapter;
}

export function traceFixtureSource() {
  return replayTraceFixture.toString();
}
