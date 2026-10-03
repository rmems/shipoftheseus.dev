# neuromorphic-adapter

The Rust/WASM boundary for the portfolio's V1 interactive runtime. It composes
the exact pinned upstream crate surfaces rather than reimplementing their
signal processing, encoding, SNN dynamics, topology, or protocol rules.

## Reproducible validation

The committed lockfile and `rust-toolchain.toml` are part of the contract.

```text
cargo test --locked
cargo check --target wasm32-unknown-unknown --locked
cargo build --target wasm32-unknown-unknown --release --locked
wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/neuromorphic_adapter.wasm
```

Use `wasm-bindgen-cli 0.2.126`, matching the pinned Rust dependency. `pkg/`
and `target/` are generated locally and intentionally not committed.

## Boundary guarantees

- `WasmAdapter.init(seed, config)` accepts only the versioned V2 config byte
  `[2]`; it rejects unknown configuration rather than ignoring it.
- `input(sequence, Float32Array)` requires finite samples and a strictly
  increasing `bigint` sequence.
- `step()` uses a caller-seeded `neuromod::StdRng` and returns copied typed
  arrays plus topology and `corpus-ipc` wire-version provenance.
- `dispose()` makes all later runtime operations fail closed.

## Engine

V1 runs `neuromod`'s LIF bank only (`NeuronModel::Lif`; Izhikevich is a
reserved extension point gated on a contract-version increase). Upstream
`with_dimensions` zero-initializes weights, so the adapter seeds each neuron's
weights uniformly to `WEIGHT_BUDGET / num_channels`, matching
`neuromod`'s `examples/rstdp_demo.rs` convention. See the `neuromod` engine
integration section of `docs/architecture/browser-runtime.md` (ADR-0001).

## Golden trace fixture

`tests/fixtures/seed9-trace.json` is the generated seed-9 replay golden shared
by the native test, `scripts/verify-neuromorphic-wasm.mjs`, and
`scripts/verify-neuromorphic-browser.mjs`. Never hand-edit expected values;
regenerate it with:

```text
cargo test --locked regenerate_seed9_trace -- --ignored --exact
```

Custom topology payloads are deliberately not accepted here. The later
`synaptic-wiring` integration owns that separate versioned topology contract.
