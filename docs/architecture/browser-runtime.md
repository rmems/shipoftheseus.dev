# Browser runtime architecture (ADR-0001)

- **Status:** accepted for V1
- **Decision date:** 2026-09-16
- **Scope:** GitHub #4, #6, #14, #15, and #21

## Decision

V1 uses **Three.js with WebGL**. WebGPU/WGSL is neither a primary renderer nor a
V1 fallback: it may be evaluated later behind an explicit capability flag, but
must not fork the simulation contract or become required to view the site.
Three.js is the only code that translates simulation state into draw calls.

The visualization is a lightweight Astro progressive-enhancement island. Astro
renders useful static content and a representative still/diagram first. A small
client entry point may then:

1. check the motion preference, WebGL availability, and WebAssembly support;
2. create the renderer and worker only after the island enters the viewport;
3. pause its animation clock and simulation work while off-screen or while the
   document is hidden; and
4. on `astro:before-swap` and component disposal, cancel animation frames,
   remove listeners and observers, terminate the worker, and dispose Three.js
   geometries, materials, textures, and renderer/context resources.

There is no hydration dependency for the surrounding page. Initialization is
idempotent, and teardown followed by initialization creates a fresh runtime.
The static content is the product; graphics are an optional enhancement.

## Ownership and dependency direction

The site-specific Rust crate is an adapter, not another simulation library. It
owns JavaScript/browser interop, typed-array transfer, lifecycle messages, error
translation, and composition of upstream crates. It must not copy or reimplement
algorithms owned elsewhere:

| Concern | Owner |
| --- | --- |
| Feature extraction | `kinetic-signals` |
| Sensory-to-spike encoding | `axon-encoder` |
| Neuron dynamics and spike generation | `neuromod` |
| Topology, routing, and delays | `synaptic-wiring` |
| Reward/modulator mapping (when needed) | `limbic-critic` |
| Training/session orchestration (when needed) | `plasticity-lab` |
| NIR graph interchange (later/selective) | `nir-rs` without `hdf5` |
| Canonical protocol/provenance models, envelopes, wire compatibility, fail-closed decode, protocol limits, and validation for the V1 recorded viewer | `corpus-ipc` default schema/validation surface |

Dependencies point from the adapter to these crates. Upstream crates must remain
browser-agnostic; Three.js, DOM types, workers, and `wasm-bindgen` do not leak
into their APIs. A failing dependency is an upstream compatibility blocker, not
permission to add a site-local substitute.

The adapter/recorded viewer may link `corpus-ipc` with no features for its
canonical schema and validation responsibilities. It must exclude
`corpus-ipc/zmq`, `corpus-ipc/server`, every native transport, and every native
service. `myelin-accelerator` CUDA and FPGA execution remain artifact/native
evidence only and are not linked into the browser bundle; see
`docs/architecture/native-evidence.md`. Browser builds also
exclude `nir-rs/hdf5` and the `myelin-accelerator/cuda` feature.

## Deterministic Rust/WASM contract

The adapter exposes one versioned, instance-based boundary. Names below describe
the required semantic API; the implementation may use `wasm-bindgen` classes or
opaque integer handles as long as JavaScript cannot mutate Rust-owned state.

```text
init({ contract_version, seed_u64, config_bytes }) -> instance
input(instance, { sequence_u64, samples_f32 }) -> Result
step(instance) -> Result<StateView>
state(instance) -> StateView
```

- `init` requires an explicit 64-bit seed and validated, versioned configuration.
  The first adapter release accepts the single V1 configuration byte `[1]`; it
  rejects other payloads rather than pretending to support custom topologies.
  No entropy, wall clock, locale, device capability, or frame timing may affect
  simulation results.
- `input` accepts canonical `Float32Array` data plus a monotonic sequence.
  Rust copies or consumes the data before returning; it
  does not retain a view into resizable JavaScript memory.
- `step` advances exactly one fixed logical timestep. `requestAnimationFrame`
  controls presentation only. A capped accumulator may choose how many calls to
  request, but dropped visual frames never change step mathematics.
- `state` is a read-only snapshot containing its contract version, seed,
  completed step, neuron/spike buffers, topology identifiers, and stable error
  status. Large numeric fields cross the boundary in typed arrays, not per-item
  JavaScript objects. Every exported snapshot is materialized into independent,
  JS-owned `ArrayBuffer`s; it is never a writable or live view of WASM linear
  memory. A worker transfers each snapshot buffer to the main thread exactly
  once, which detaches it in the worker. The renderer may reuse that JS-owned
  buffer until the next snapshot replaces it, then releases all references so
  garbage collection can reclaim it; buffers are not returned to or reused by
  the worker in V1.
- Every `u64` in the contract, including seed, sequence, and logical-step values,
  crosses the JavaScript boundary as lossless `bigint`, never as JavaScript
  `number`. Canonical `corpus-ipc` JSON envelopes are encoded and decoded
  entirely inside Rust via `corpus-ipc`; `u64` values are exposed to JavaScript
  only as `bigint`, never through JavaScript `Number` or JavaScript JSON parsing.
- Same adapter/upstream revisions, contract version, configuration, ordered
  inputs, seed, and step count must produce byte-equivalent exported state.
  Tests use fixed golden seeds. Any intentional determinism break requires a
  contract-version change.

### Topology projection handoff

`synaptic-wiring = "=0.3.0"` remains the sole owner of graph construction,
synapse multiplicity, routing relationships, delays, polarity, and the
versioned topology digest. The adapter reads its `SynapticGraph` and produces a
browser transport projection; it does not generate a replacement graph.

- `topology_node_ids` contains the exact upstream `NeuronId` domain.
- Each edge carries the upstream source/target IDs, signed upstream weight,
  exact `f32` weight bits, delay, and polarity tag. Signed-zero bits are
  intentionally retained.
- The adapter sorts the complete edge multiset by `(source, target, delay,
  polarity_tag, signed_weight_bits)`. Its index is the canonical edge index,
  scoped by `topology_digest`; it is explicitly not represented as an upstream
  `EdgeId`.
- `topology_outgoing_edge_offsets` is a canonical CSR lookup from source
  `NeuronId` to its canonical outgoing-edge range. This is the sole handoff
  needed by later spike propagation and rendering work.
- The runtime seed is simulation provenance for `neuromod`; it does not select
  or alter `synaptic-wiring` topology. A topology changes only when the
  adapter configuration or locked upstream topology inputs change.

V1 runs simulation in a dedicated module worker when workers and transferable
buffers are available. Messages mirror `init/input/step/state`, are tagged with
instance and sequence IDs, and transfer snapshot buffers to the main thread.
The main thread owns Astro lifecycle and Three.js only. A main-thread simulation
path may be used for small workloads when workers are unavailable, with a strict
per-frame budget and the identical contract; it is not a second implementation.
Shared memory and threads are out of scope because they would require
cross-origin isolation.

## Browser and fallback policy

V1 supports the current and previous major releases of Chrome, Edge, Firefox,
and Safari on desktop, plus current and previous Chrome on Android and Safari
on iOS. This is a release-test matrix, not user-agent sniffing. Capability tests
are authoritative.

| Condition | Behavior |
| --- | --- |
| Supported browser, WebGL and WASM initialize | Start the progressive enhancement; prefer the worker path. |
| `prefers-reduced-motion: reduce` | Do not auto-start animation or simulation. Show the static representation and an explicit, user-initiated “Play animation” control; keep nonessential camera motion disabled. |
| No WebGL, context creation/loss, or renderer error | Dispose partial graphics state and retain the static representation and explanatory text. Never try WebGPU implicitly. |
| WASM unsupported, fetch/compile fails, or adapter returns an error | Retain the static representation; disable live controls and show a short non-blocking status. Do not run a JavaScript simulation substitute. |
| Worker unavailable or fails before initialization | Retry once on the bounded main-thread adapter path. A later worker failure freezes the last valid frame and falls back rather than replaying ambiguous inputs. |
| Both graphics and WASM unavailable | Serve the complete static Astro content; navigation and project evidence remain usable. |

Graphics and WASM initialize independently and report structured reason codes.
One failure must not cause an exception during page hydration. Feature flags are
build-time/off by default for experimental WebGPU and NIR import; flags cannot
weaken capability checks or fallback behavior.

## Read-only `wasm32-unknown-unknown` audit

The audit used clean clones at the exact commits below and made no upstream
changes. On 2026-09-16, the isolated environment installed Rust **1.98.1** and
its `wasm32-unknown-unknown` standard library, then ran the command shown for
each crate. “Pass” means `cargo check` completed for only that selected surface;
it does not approve the crate for the V1 dependency graph when the ownership
decision above places it outside the browser.

| Package | Canonical repository | Version | Exact commit | Selected features and command suffix | Result / exact blocker |
| --- | --- | ---: | --- | --- | --- |
| `kinetic-signals` | `rmems/kinetic-signals` | 0.5.0 | `e829a0d5826c0d1175b8878b024a69ce4e1d538b` | `--no-default-features` | **Pass** |
| `axon-encoder` | `Limen-Neural/axon-encoder` | 0.4.0 | `a56276746569e5ecaa78e50882064858835b2438` | `--no-default-features --features serde,wasm-js` | **Pass**. The opt-in `wasm-js` feature enables the supported `getrandom` browser backend; the default-only graph remains intentionally unsupported. |
| `neuromod` | `Limen-Neural/neuromod` | 0.6.0 | `3fe526116683d7392e309760c017afe8a934619c` | `--no-default-features --features wasm-js` | **Pass**. The opt-in `wasm-js` feature enables the supported `getrandom` browser backend; the default-only graph remains intentionally unsupported. |
| `synaptic-wiring` | `Limen-Neural/synaptic-wiring` | `=0.3.0` | crates.io checksum `311aed9804c027f786ed5385883bd22469f8cb87fe804b88f77162466b9137b2`; audited source/main `5f70762b4ef09346d0689a65a1a8b20531cfbdab` | `--no-default-features` | **Pass** |
| `nir-rs` | `Limen-Neural/nir-rs` | 0.4.3 | `1043cbf7bc6acbece250c769b9c2c8f7c58ce681` | `--no-default-features --features serde` (`hdf5` excluded) | **Pass** |
| `limbic-critic` | `Limen-Neural/limbic-critic` | 0.3.0 | `9bf0c79f5a47fac9c5b921dd9011b013d1ae52bb` | `--no-default-features` | **Pass** |
| `plasticity-lab` | `Limen-Neural/plasticity-lab` | 0.1.0 | `d47ae33914b6a3044d0539b851cd83621b7f1f4b` | `--no-default-features --features critic` | **Blocked:** its `neuromod 0.6.0` git dependency reaches `getrandom 0.4.3`, which emits the missing-`wasm_js` compile error. |
| `myelin-accelerator` | `Limen-Neural/myelin-accelerator` | 0.2.0 | `26651ca0edf96b080cd5ef89045543c453bd786c` | `--no-default-features` (`cuda` excluded) | **Pass**, using the crate's non-CUDA stub PTX build path; still excluded from the browser dependency graph. |
| `corpus-ipc` | `Limen-Neural/corpus-ipc` | `=0.1.0` | crates.io checksum `eec6624caf88783f1c35109fe1c27615fc85c986249d480c8efabb72d5f92081`; audited source/tag `d99e6544d7925dc0ccfe69fdff372352b0a9d041` | `--no-default-features` (`zmq` and `server` excluded) | **Pass**; approved for the V1 browser adapter/recorded viewer as the canonical protocol/provenance schema and validation layer. |

Every row used:

```text
cargo +1.98.1 check --target wasm32-unknown-unknown <selected feature suffix>
```

This completed audit did **not** use `--locked`. All future CI checks and
re-audits must use `--locked` so their dependency resolutions are reproducible.

Merging this ADR and RM-1639 closes only the architecture decision. The exact
upstream browser-entropy fixes above unblock full RM-1640/GitHub #4 dispatch,
plus RM-1650/GitHub #14 and RM-1651/GitHub #15. `plasticity-lab` remains a
separate V2-only blocker until it forwards `neuromod`'s opt-in `wasm-js` feature.
The site must pin the Rust toolchain, commit its dependency lockfile, and run
locked target checks in CI before enabling the live browser simulation.
