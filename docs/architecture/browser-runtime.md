# Browser runtime architecture (ADR-0001)

- **Status:** accepted for V1
- **Decision date:** 2026-09-16
- **Scope:** GitHub #4, #6, #7, #8, #14, #15, #16, #17, and #21

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
| Reward/modulator mapping (`/labs/plasticity/`) | `limbic-critic` |
| Training/session orchestration and frozen evaluation (`/labs/plasticity/`) | `plasticity-lab` (`critic` bridge) |
| Reward-modulated STDP, eligibility traces, weight renormalization | `neuromod` |
| NIR graph interchange and semantics (`/labs/nir/` inspection) | `nir-rs` without `hdf5` |
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
  The topology-projection adapter release accepts the single V2 configuration byte `[2]`; it
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
  completed step, neuron/spike buffers, topology identifiers, stable error
  status, and (on contract 4) the active encoder mode plus derived spike-train
  diagnostics. Large numeric fields cross the boundary in typed arrays, not per-item
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

### Selectable `axon-encoder` modes (GitHub #15 / Linear RM-1651)

The adapter orchestrates upstream `axon-encoder` surfaces; it never reimplements
an encoding algorithm. Pointer/touch/demo telemetry flows through the stable,
mode-independent input contract first — `kinetic-signals` z-score magnitudes
clamped to `[0, 1]` on 16 channels — and then through exactly one selected
upstream encoder per step: `DeltaEncoder`, `TemporalEncoder`, or `RateEncoder`
(at the pinned `axon-encoder = 0.4.0`, `a562767`). Only the streaming
`Encoder::encode_step` path is used; the batch `Encoder::encode` path on rate
encoders draws from thread-local RNG and is never called, so every v1 mode is
deterministic for identical ordered input. The per-tick order is fixed:
`input` encodes and queues source spikes, then `step` propagates them through
`synaptic-wiring` (`mesh.propagate`) before advancing `neuromod` dynamics
(`network.step_with_rng`); the resulting state snapshot feeds the renderer.

- **Init config.** `[3]` keeps the legacy delta-only contract (unchanged
  seed-9 golden trace). `[4]` selects contract 4 with the default `temporal`
  mode; `[4, mode]` selects explicitly (`0 = delta`, `1 = temporal`,
  `2 = rate`). Modes `3` (`population`) and `4` (`predictive`) are the
  reserved v1 extension path: recognized but rejected until a later contract
  version wires a browser-safe upstream for them.
- **Renderer contract stability.** Selecting a mode changes only which spikes
  the same normalized features produce. The snapshot gains `encoder_mode`,
  `encoder_name`, `encoded_spike_count`, `encoded_spike_channels`, and
  `encoded_spike_total` (cumulative since construction); every existing
  renderer-facing field is unchanged.
- **Browser compatibility.** The bridge (`initNeuromorphicAdapter`) validates
  mode/config pairs before loading WASM, keeps contract-3 callers delta-only,
  and surfaces the active mode plus diagnostics on every contract-4 snapshot
  for inspection. WASM is required; there is no JavaScript encoding fallback.
  The live demo's worker and main-thread session paths both use contract 5
  (below) with the default mode; contracts 3 and 4 remain for their goldens
  and for callers that send raw sample packets.

### Interactive telemetry through `kinetic-signals` (GitHub #8 / Linear RM-1644)

Contract 5 is the v1 interactive sensory pipeline:

```text
pointer/touch/demo telemetry → kinetic-signals → axon-encoder → neuromod → synaptic-wiring → renderer
   (site: DOM → [x, y, pressure])  (adapter: KineticExtractor)  (unchanged downstream)
```

- **Init config.** `[5]` selects the default `temporal` mode; `[5, mode]`
  accepts the same mode bytes as contract 4.
- **Input.** Each `input(sequence, samples)` carries exactly one
  `[x, y, pressure]` telemetry packet. `x`/`y` are relative to the island's
  render surface (`0..1` inside it) and `pressure` is `PointerEvent.pressure`.
  Any other length fails closed with `input-telemetry-shape` and does not
  consume the sequence.
- **Ownership split.** The site (`src/runtime/kinetic-telemetry.ts`) only
  converts DOM pointer events into packets and latches one per logical tick.
  It never computes features or spikes. The adapter
  (`crates/neuromorphic-adapter/src/kinetic.rs`) clamps the packet to
  `[0, 1]`, differences consecutive positions into velocity, and delegates
  smoothing, volatility, and surprise to `kinetic-signals` (`EMA`,
  `VolEstimator`, `compute_surprise`). It then rescales to fixed full-scale
  constants and clamps every feature to `[0, 1]` before handing exactly
  those 16 values to the selected `axon-encoder`. No second spike encoder
  exists on the site.
- **Feature layout** (indices are contract; reordering needs a version bump):
  `0 x`, `1 y`, `2 pressure`, `3/4 +vx/−vx`, `5/6 +vy/−vy`, `7 speed`,
  `8 speed EMA(3)`, `9 speed EMA(12)`, `10 |Δspeed|`, `11 speed volatility
  (VolEstimator, 16 ticks)`, `12 speed surprise`, `13 pressure EMA(8)`,
  `14/15 x/y EMA(6)`. Full scale is 0.1 island/tick for velocity, 0.05 for
  `|Δspeed|`, and z = 3 for surprise. Channel 11 follows `VolEstimator`'s
  input contract (absolute changes, not levels): it is the rolling RMS over 16
  ticks of `|Δspeed| / 0.1`, so a steady drag reads near 0 and jerky motion
  reads high.
- **Deterministic fallback.** Without pointer activity for 60 ticks (3 s), or
  after the pointer leaves the surface, the session feeds the deterministic
  scripted path (`scriptedTelemetry(sequence)` in
  `src/runtime/demo-stimulus.ts`). The demo therefore runs with interaction
  disabled, and the island's `data-demo-input-source` reports `pointer` or
  `scripted`.
- **Recording and replay.** Every session records its packets in the golden
  fixture format (`{ seed, config, operations }`, `u64`s as decimal strings).
  Replaying it from `init` reproduces the session bit-exactly. The committed
  contract-5 golden `crates/neuromorphic-adapter/tests/fixtures/kinetic-seed9-trace.json`
  also pins every step's `encoder_features` bits. The native test, the Node
  WASM smoke, and the headless-Chrome smoke all replay it.
- **Inspection.** Snapshots carry `encoder_features`. Under `astro dev`,
  `globalThis.__neuromorphicTelemetry.latest()` returns the active source,
  encoder, encoded spike count, and features, and `.trace()` returns the
  replayable recording (capped at 6000 ticks, then `null`).

### Recorded `corpus-ipc` protocol viewer (GitHub #21 / Linear RM-1657)

`/protocol/` replays checked-in `corpus-ipc` wire-v1 envelopes through the
adapter crate's `protocol` cargo feature, which only the `labs` build profile
enables (`public/wasm/neuromorphic-adapter-labs/`; see
[Browser build profiles](#browser-build-profiles)). It is a recorded, offline
view: ZeroMQ, the Axum IPC service, proxying, and streaming never run in the
browser.

- **Locked surface.** `corpus-ipc = { version = "=0.1.0", default-features =
  false }` in `crates/neuromorphic-adapter/Cargo.toml`. Source
  `Limen-Neural/corpus-ipc@d99e6544d7925dc0ccfe69fdff372352b0a9d041` (also
  recorded in the published crate's `.cargo_vcs_info.json`); crates.io archive
  SHA-256 `eec6624caf88783f1c35109fe1c27615fc85c986249d480c8efabb72d5f92081`,
  which is the `corpus-ipc` checksum in `crates/neuromorphic-adapter/Cargo.lock`.
  No `corpus-ipc` features are selected, so `zmq` and `server` are off.
  `scripts/verify-browser-dependencies.mjs` fails, in every profile, if
  `zmq`, `zeromq`, `axum`, `axum-core`, `tokio`, `tokio-macros`, `hyper`,
  `tower`, `mio`, `socket2`, a native `-sys` crate, C/C++ build tooling, or a
  package that links a native library other than `wasm_bindgen` enters the
  wasm32 graph, or if `corpus-ipc` gains `server`/`zmq`. The `protocol`
  feature adds two optional direct dependencies, `serde_json =1.0.151` and
  `sha2 =0.10.9`. Both are already in the locked graph through `corpus-ipc`
  and `synaptic-wiring`, so the policy pins the adapter itself: in the
  `default` profile it must not enable `protocol` or depend directly on
  `serde_json`/`sha2`.
- **Ingress order** (`crates/neuromorphic-adapter/src/protocol.rs`). Every
  step fails closed with a stable reason code and nothing later runs:
  declared variant and out-of-band digest are well formed; the 64 KiB
  pre-parse byte limit (`MAX_PROTOCOL_FIXTURE_BYTES`); SHA-256 over the exact
  bytes; `WireEnvelope::<IpcMessage>::decode_json(bytes)`, which accepts the
  wire version before converting the payload; `Validate::validate()` on the
  decoded message; and the declared-versus-decoded kind check. The
  legacy-tolerant `decode_ipc_message_json` is not used, so unversioned JSON
  fails as `wire-version-missing`.
- **Validation placement.** `corpus-ipc` also runs its `Validate` policy
  inside payload deserialization (`TryFrom` shadow types). Wire-level
  validation failures therefore surface during decode; the adapter classifies
  them by the crate's stable `ValidationKind` names as `validation-failed`,
  the same code the explicit post-decode `Validate::validate()` gate returns.
- **Forward compatibility.** Additive unknown fields on the envelope and on
  payloads are ignored as `corpus-ipc` documents. Unknown `IpcMessage`
  variants fail as `unknown-variant`. The adapter re-encodes every accepted
  envelope with `corpus-ipc` and reports only what a comparison establishes
  (`canonical_difference`): `identical` bytes; `formatting` (both parse to
  the same JSON value, so only whitespace, key order, or similar spelling
  differs); `dropped-fields` (input object keys missing from the re-encoding,
  listed as dotted paths, at most 32); or `differs` (for example an omitted
  optional field written back as `null`, or an `f32` with extra digits).
- **Boundary.** `inspectProtocolFixture(bytes, sha256, variant)` returns a
  `WasmProtocolInspection` whose `u64` fields (`batch_id`, `timestamp`,
  `metadata_processing_latency_ns`) are `bigint`, and whose rows are typed
  arrays. Failures throw a `ProtocolFixtureError` with a `code`.
  `protocolFixtureByteLimit()` exposes the limit so the page bounds its reads
  with the adapter's own constant. TypeScript (`src/protocol/`) moves bytes,
  reads each allocating getter once, checks the output shape, copies it into
  JS-owned values, and renders it. It never parses envelopes with JavaScript
  JSON or re-describes the schema. `test/protocol-enhance.test.mjs` drives the
  page enhancement through the real labs package on a small fake DOM
  (`test/fake-dom.mjs`).
- **Fixtures** (`public/protocol/fixtures/v1/`). One `Stimuli`, one `Spikes`,
  and one `EligibilityTraces` envelope, each from the first firing tick of a
  deterministic replay of the contract-5 golden
  `crates/neuromorphic-adapter/tests/fixtures/kinetic-seed9-trace.json`:
  the 16 `kinetic-signals` features handed to `axon-encoder`, the LIF spikes
  `neuromod` emitted, and `neuromod`'s eligibility traces for neuron 0's input
  synapses. They are derived from that replay, not captured from hardware or a
  live service. `batch_id` is the assigned value 2^53 + 1, so a lossy
  `Number` path would show 9007199254740992. `timestamp` is 0 because replay
  has no wall clock, and spike `strength` 1.0 marks a binary spike.
  `corpus-ipc` itself encodes the bytes. `manifest.json` carries each file's
  size and SHA-256 out of band. `tests/protocol_fixtures.rs` fails on any drift;
  regenerate with
  `cargo test --locked --features protocol --test protocol_fixtures regenerate_protocol_fixtures -- --ignored --exact`.
  Both protocol test files declare `required-features = ["protocol"]`.
- **Static first.** The page is rendered at build time from the manifest and
  the exact bytes. The build fails if a digest or size does not match. Without
  JavaScript or WASM, the bytes, digests, and provenance stay readable. The
  enhancement only adds the decoded view. The page carries the
  `RECORDED · corpus-ipc wire v1` origin label, which is distinct from
  `LIVE · Rust/WASM` and `RECORDED · CUDA/FPGA`.
- **Bundle cost.** The `serde_json` decode path for every `IpcMessage`
  variant would roughly triple the homepage package (189 KB to 569 KB, about
  67 KB to 169 KB with gzip -9), so it lives only in the labs package. The
  homepage keeps the lean default build; its only `corpus-ipc` use is the
  `WireCompatibility::CURRENT` constant behind `protocol_wire_version`.

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
  needed by later spike propagation and rendering work (consumed by the spike
  propagation events below).
- The runtime seed is simulation provenance for `neuromod`; it does not select
  or alter `synaptic-wiring` topology. A topology changes only when the
  adapter configuration or locked upstream topology inputs change.

### Spike propagation events (GitHub #7 / Linear RM-1643)

The live view animates real spikes, not decorative particles.
`src/runtime/spike-events.ts` is the seam. It reads only fields every snapshot
already carries, so no contract change was needed: contracts 3 to 5 and their
goldens are untouched.

```text
neuromod step ─ spike_neurons ───────────────┐
synaptic-wiring projection (same snapshot) ──┴→ mapSpikesThroughTopology
  → SpikeEventBuffer (fixed ring) → renderer frames, telemetry (#9), budgets (#10)
```

- **Mapping.** A spike at neuron `n` in a snapshot with `completed_step = N`
  becomes one event per canonical edge in
  `topology_outgoing_edge_offsets[n]..[n + 1]`. Each event carries that edge's
  source, target, delay, polarity, signed weight, canonical index, and the
  topology digest. `spike_neurons` index the `neuromod` LIF bank, which the
  adapter sizes to the topology's `NeuronId` domain (the bridge rejects
  snapshots where they differ). The mapping fails closed with a `RangeError`
  on an inconsistent projection instead of guessing, and the renderer then
  reports `renderer-error`.
- **What an event means.** Contract 5 routes *encoder* spikes through
  `mesh.propagate` before `neuromod` and does not feed `neuromod`'s output
  spikes back into the mesh. A propagation event is the `synaptic-wiring`
  routing of a `neuromod` spike, meaning the synapses and delays the topology
  defines for its source neuron. It does not claim that the target received
  that current inside the simulation. `crates/neuromorphic-adapter/tests/spike_propagation_handoff.rs`
  checks that each projected outgoing range, read with these delays, is
  exactly what upstream `SynapticMesh::propagate` delivers for a spike at that
  neuron.
- **Timing unit.** Delays are `synaptic-wiring` `DelayTicks`: a spike from `s`
  on mesh tick `t` reaches its targets on tick `t + delay`. The adapter
  advances the mesh once per `step`, so one tick is one logical step, and the
  live demo steps every `DEMO_TICK_MS` = 50 ms. An event emitted at step `N`
  on an edge with delay `d` arrives at step `N + d`, `d × 50 ms` later. The
  live topology's delays are 1 to 4 steps (50 to 200 ms). Frames interpolate
  within the current step as `(now − snapshot arrival) / 50 ms`, capped at
  one step so a stalled simulation never runs ahead. The pulse head moves
  `1/d` of the edge per step, and its 0.6-step tail lands after arrival.
- **Buffering, separate from frames.** Snapshots are ingested when the WASM
  seam publishes them, through `feedSpikeEvents(channel, buffer)`. Frames only
  read the buffer. The buffer is a fixed-capacity ring (default 512, above the
  live topology's worst case of 64 edges × 5 retained steps = 320). The oldest
  events are evicted first and counted, and events retire one step after they
  arrive. A repeated step is ignored. A lower step or a new topology digest
  (a fresh adapter, such as the main-thread retry) restarts the buffer.
  Ingestion is atomic: a snapshot that cannot be mapped changes nothing. The
  renderer clears the buffer on pause and freeze, and on dispose it also
  detaches from the channel. A disposed buffer ignores later input.
- **Provenance.** Every event and per-step batch carries `provenance`, and a
  buffer is bound to one provenance when it is created. `live-seams.ts` creates
  the island's single `live-wasm` buffer and feeds it only from that island's
  WASM channel. `fixture` buffers exist for isolated tests
  (`test/spike-events.test.mjs`). No shipped module creates one, and a test
  guards the live sources for that. There is no JavaScript spike source.
- **Consumer API** (for #9 telemetry and #10 performance budgets).
  `buffer.subscribe(batch => …)` delivers each step's `{ provenance, step,
  topologyDigest, spikeNeurons, events }` after the buffer is updated.
  Every subscriber receives batches in step order. If a subscriber ingests
  from inside its callback, that snapshot is applied at once, but its batch
  waits until every subscriber has received the current one. During delivery,
  `batch.step` is therefore authoritative and `latestStep()` may be ahead.
  Listener errors are reported, never thrown into ingestion.
  `buffer.forEach` and `buffer.events()` read in-flight events oldest first.
  `buffer.stats()` reports capacity, size, latest step, and the lifetime
  `emitted`, `retired`, `evicted`, `resets`, and `clears` counters.
  `createTopologyRendererSeam(...).inspect()` reports the last frame's
  `drawnPulses`, `bufferedEvents`, and `motionEnabled`. `mapSpikesThroughTopology`,
  `propagationSpan`, `propagationSpanInto` (writes into a caller-owned object
  for frame loops), and `delayStepsToMs` are pure helpers.
- **Rendering and reduced motion.** Each in-flight event is one tapered quad,
  3 CSS px wide at the head and fading to clear at the tail, drawn in
  `--signal` for excitatory synapses and `--ink` for inhibitory ones. Pulses
  sit above the softer edge lines and under the nodes. Depth enforces this:
  nodes are opaque at z 0, pulses are depth-tested at z −0.005, and edges sit
  at z −0.01. Explicit render orders (edges 0, pulses 1, nodes 2) back it up.
  Pulse buffers are
  preallocated to the ring capacity, and only the drawn range is uploaded.
  The site's per-frame code allocates nothing (three.js internals aside): one
  span object, one visitor, and one scratch color are reused for every event
  and node. The
  renderer's motion flag, which is off whenever `prefers-reduced-motion:
  reduce` applies, turns off pulses together with camera drift. After an
  explicit Play under reduced motion, events are still buffered for telemetry
  but nothing travels. The static topology and node state remain.
- **Inspection.** Under `astro dev`, `globalThis.__neuromorphicSpikeEvents`
  exposes `stats()`, `recent(limit)` (with `u64` steps as strings), and
  `renderer()`.

### Live telemetry panel (GitHub #9 / Linear RM-1652)

The demo island carries a collapsible, closed-by-default `<details>` panel
(`src/components/DemoTelemetry.astro`) with a spike raster, a neuron
inspector, and the active input and encoder state. It is a consumer of the
seams above, never a second source: `src/runtime/demo-telemetry.ts` holds the
DOM-free logic and `src/runtime/telemetry-view.ts` writes the DOM. Both load
when a reader first opens the panel; the always-loaded
`src/runtime/telemetry-entry.ts` only holds the per-island source registry and
that lazy binder.

```text
channel.publish(snapshot) ─→ live-wasm SpikeEventBuffer ─ subscribe(batch) ─→ raster ring (per step)
                         └─ channel.latest() (same step) ─────────────────────┘
raster ring + latest snapshot ─ throttled flush (default 4 Hz) ─→ canvas + inspector DOM
```

- **Sources.** `live-seams.ts` registers each island's `live-wasm` buffer,
  read-only channel (`latest()` only), and input source with
  `registerLiveTelemetrySources`, which rejects any other provenance. Per step,
  the panel records the batch's `neuromod` spikes and the matching snapshot's
  `encoded_spike_count` (skipping a batch whose snapshot is not the same step).
  Membrane potentials, topology, encoder mode and diagnostics, and
  `encoder_features` are read from that snapshot. The input source
  (`pointer`/`scripted`) is the one value from the site rather than the
  runtime. The live seams keep a fixed ring of the last 128 steps' sources,
  and the panel looks up the step it displays, so a pause during an in-flight
  tick still shows the right source. Nothing is computed or synthesized for
  display.
- **Only exported fields.** A selected neuron shows its upstream `NeuronId`,
  `neuromod` membrane potential, whether it spiked at the shown step, its
  sampled spike steps, and its outgoing and incoming canonical edges with real
  weights, delays, and polarity. Outgoing edges are exactly the range the
  spike-event seam maps spikes onto, so they are the edges the renderer pulses.
  Contract 5 exports no firing threshold, neuron-model tag, or other neuron
  parameters, so none are shown; contract-3 encoder fields (bridge defaults)
  and contract-4 features (not exported) are not shown either.
- **Cost and cadence.** A closed or disabled panel holds no subscription, timer,
  or observer. While open, sampling writes a few bytes per step into a fixed
  ring (`DEFAULT_RASTER_STEPS` = 120 steps × neurons); DOM work happens only in
  flushes coalesced to the requested cadence (default 4 Hz, capped at one per
  step) and only after new data or a demo-mode change. Reduced motion caps the
  cadence at 1 Hz, including when the preference changes while the panel is
  open. `getDemoTelemetry(island)` (in `telemetry-entry.ts`)
  returns the controller once the panel has been opened; its `setCadenceHz(hz)`
  and `setEnabled(false)` let a performance budget lower or stop telemetry
  without touching the simulation or the renderer.
- **Pausing.** Telemetry receives data only while the simulation ticks and the
  renderer feeds the buffer, so it stops with the demo (off-screen, background
  tab, user pause, reduced motion before Play). After a user pause the last
  sampled step stays inspectable. Closing the panel drops the sampled window.
- **Origin labels.** The panel uses the execution-origin vocabulary: it shows
  `LIVE · Rust/WASM` only while it displays values from the `live-wasm`
  buffer's runtime, and `UNAVAILABLE · Rust/WASM` otherwise, including the
  static and no-JavaScript state. Each block names its crate layer
  (`kinetic-signals`, `axon-encoder`, `neuromod`, `synaptic-wiring`), and the
  panel restates that contract 5 does not feed `neuromod` spikes back into the
  mesh.
- **Inspection.** Under `astro dev`, `globalThis.__neuromorphicTelemetryPanel`
  exposes `inspect()`, `setCadenceHz(hz)`, and `setEnabled(enabled)`. The panel
  element reports `data-telemetry-state` and `data-telemetry-step`.

### Performance budgets and adaptive quality (GitHub #10 / Linear RM-1646)

Budgets, the measured tables with their machine and browser context, the
buffer audit, and how to reproduce each measurement are in
[`performance-budgets.md`](performance-budgets.md).

- **Adaptive quality is presentation only.** `adaptive-quality.ts` steps the
  renderer's pixel-ratio cap, pulse cap, frame-rate cap, and telemetry refresh
  cadence down under sustained frame-time pressure, with hysteresis. It never
  reaches the WASM seam. The 50 ms tick, input packets, and spike-event
  buffering are identical at every level, and
  `test/performance-semantics.test.mjs` checks snapshots byte for byte.
- **Telemetry cadence for consumers.** The island carries `data-demo-quality`
  and `data-demo-telemetry-cadence-ms`. The live renderer seam exposes the
  controller's read side as `renderer.quality`, and `shouldSampleTelemetry`
  keys refreshes to simulation steps. For the live telemetry panel,
  `live-seams.ts` registers the quality cadence as a ceiling
  (`registerTelemetryCadenceCap`). The panel's controller picks it up when it
  is first opened and on every level change (`setCadenceCapHz`), and it can
  only lower the panel's own 4 Hz (1 Hz under reduced motion).
- **Snapshot transfer.** The bridge reads each wasm-bindgen getter once, frees
  the `WasmState` handle immediately instead of waiting for a GC finalizer,
  and checks the routed topology by value against the last verified copy.
  Exported values are unchanged.
- **Opt-in timing.** Under `astro dev`, or with `?neuromorphic-perf`,
  `globalThis.__neuromorphicPerf` reports per-stage timing (`perf-probe.ts`).
  Normal visits create no probe.

### `neuromod` engine integration

`neuromod` owns neuron dynamics and spike generation. `synaptic-wiring` owns
topology and delays. The adapter owns orchestration and browser-safe transfer
only: it never reimplements equations, thresholds, or integrators.

- **LIF-only V1.** The adapter constructs `SpikingNetwork` through a private
  `NeuronModel` enum; `NeuronModel::Lif` is the only constructible variant.
  `Izhikevich` is a reserved extension point: enabling it requires a browser
  performance review and a `CONTRACT_VERSION` increase that tags the state
  with the selected model.
- **Weight initialization.** `SpikingNetwork::with_dimensions` zero-initializes
  LIF synaptic weights, and `neuromod` gates all stimulus current on those
  weights, so a default network can never fire. Following upstream's own demo
  convention (`examples/rstdp_demo.rs`), the adapter seeds each neuron's
  weights uniformly to `WEIGHT_BUDGET / num_channels` (2.0 / 16). This is
  initialization through the crate's public API, not site-local dynamics.
  Because seeding changed the deterministic states a fixed seed produces,
  `CONTRACT_VERSION` was raised to 3 (from 2) — replays recorded under V2
  semantics are not valid under V3.
- **Feature gating.** `neuromod` and `axon-encoder` are linked with
  `default-features = false` plus the opt-in `wasm-js` feature. That feature
  only enables the `getrandom 0.4.3` `wasm_js` backend so the crates link on
  `wasm32-unknown-unknown`; the simulation never draws entropy.
- **RNG and replay rules.** One `StdRng::seed_from_u64(seed)` is created at
  init and passed only into `step_with_rng`. Replay requires the same seed,
  the same `rand` version from the committed lockfile, and the same ordered
  input script. Snapshots do not include RNG state, so mid-run resume is not
  supported: replay always restarts from `init`.
- **Float determinism.** Verified 2026-10-03: the committed seed-9 golden trace
  (`crates/neuromorphic-adapter/tests/fixtures/seed9-trace.json`) replays
  bit-exactly — spike indices and `f32` potential bits — on native
  `x86_64-unknown-linux-gnu`, wasm-bindgen `nodejs` bindings under Node.js, and
  `web` bindings under headless Chrome. One fixture is authoritative for all
  targets. Native and wasm32 results are identical at the pinned versions.
- **Verification coverage.** The native Rust test, the Node WASM smoke test
  (`scripts/verify-neuromorphic-wasm.mjs`, `nodejs` and `web` bindings), and
  the headless-Chrome smoke test (`scripts/verify-neuromorphic-browser.mjs`)
  all replay the fixture. The browser test replays it three times, including
  once after `dispose` plus a fresh `init`. CI covers the Chrome path only.
- **Confirmed upstream API facts** (at the pinned release
  `neuromod =0.7.0`, crates.io):
  `with_dimensions(num_lif, num_izh, num_channels)`; `step_with_rng(&[f32],
  &NeuroModulators, &mut R) -> Result<Vec<usize>, StepError>` consumes one RNG
  draw per channel whose `|stimulus| > 0.01`;
  `get_membrane_potentials()` returns the LIF bank's potentials.

#### Minimum render/inspection state

Every snapshot field exists for a concrete consumer; nothing else may be added
in V1 without a contract-version increase.

- `contract_version` — lets consumers reject a mismatched contract.
- `seed`, `completed_step`, `last_sequence` — provenance for replay and
  input ordering.
- `error_status` — the UI's structured status channel.
- `topology_digest`, `protocol_wire_version` — topology and wire-format
  provenance.
- `spike_neurons`, `membrane_potentials` — the neuron state raster and
  inspection views render.
- `encoder_features` — contract 5 only (empty on 3 and 4): the clamped
  `kinetic-signals` features handed to `axon-encoder` by the latest input,
  for telemetry inspection and feature-level replay checks.
- `encoder_mode`, `encoder_name`, `encoded_spike_count`,
  `encoded_spike_channels`, `encoded_spike_total` — contract-4/5 encoder
  inspection: the active mode and the derived spike-train diagnostics from the
  most recent `input` (count and distinct channels) plus the cumulative total
  since construction.
- `topology_node_ids`, `topology_rows/targets/weights/delays`,
  `topology_edge_*`, `topology_outgoing_edge_offsets` — the canonical and
  routed topology the renderer and spike-propagation issues consume.

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

## NIR network inspection (GitHub #16 / Linear RM-1653)

`/labs/nir/` inspects one bundled, versioned example graph. It is imported
graph **structure**: nothing on the page simulates neurons, and it is labelled
`IMPORTED · NIR structure` (`imported-nir` execution origin) so it is never
confused with the `LIVE · Rust/WASM` homepage simulation, which is a different
network owned by `synaptic-wiring` and `neuromod`.

- **Ownership.** `nir-rs = "=0.4.5"` (`default-features = false`,
  `features = ["serde"]`) owns NIR graph semantics: the closed node set and
  its wire type names (`NirNode::type_name`), field names, tensor
  shapes/dtypes, and `validate_structure` / `validate_parameters`. The adapter
  module `crates/neuromorphic-adapter/src/nir.rs` only wraps the graph in a
  versioned envelope and projects it for display (nodes in layer order, edges,
  Rust-formatted field values, and a presentation-only `layer`/`row` layout:
  strongly connected components are collapsed first, so cycle members share a
  layer and operators after a cycle still land on later layers). The module
  is compiled only with the adapter's `nir` cargo feature and is exported as
  `WasmNirInspection` (`parse(envelopeJson)`, `inspection_json()`,
  `node_json(name)`) from the **labs** package only; see
  [Browser build profiles](#browser-build-profiles). Errors are stable
  `"<code>: <message>"` strings (`nir-envelope-invalid`,
  `nir-rs-version-mismatch`, `nir-graph-invalid-structure`, …).
- **No HDF5 in the browser.** The `hdf5` feature (which links native libhdf5
  through `hdf5-metno`/`hdf5-metno-sys`) is not enabled anywhere in the
  adapter, so none of those crates enters `Cargo.lock`.
  `scripts/verify-browser-dependencies.mjs` fails either profile's graph on
  any package whose name contains `hdf5`, any package with the `hdf5` feature
  enabled, any non-JavaScript `-sys` crate, any undeclared native `links`
  key, and native C build tooling (`cc`, `cmake`, `pkg-config`, `bindgen`,
  `vcpkg`). The earlier exact-name `hdf5` check would not have caught
  `nir-rs/hdf5`, whose crates are named `hdf5-metno*`.
- **Envelope (`shipoftheseus.nir-graph`, version 1).** `{ format,
  format_version, nir_rs_version, asset, graph }`, with `graph` in the
  `nir-rs` Serde representation. Upstream documents that representation as a
  debug/test format, not a NIR interchange standard, so the parser accepts it
  only from the exact pinned `nir-rs` release (`nir-rs-version-mismatch`
  otherwise), rejects unknown envelope fields, and bounds input to 256 KiB,
  64 nodes, and 256 edges. HDF5 `.nir` remains the interchange format.
  `asset.origin` is a closed set; version 1 accepts only
  `hand-authored-example`.
- **Bundled example and provenance.** `public/nir/lif-readout-example.v1.json`
  (input → affine → LIF → linear → LI → output, six nodes) is generated by
  `crates/neuromorphic-adapter/tests/nir_example.rs` with the `nir-rs` graph
  API. Its parameters are illustrative hand-picked constants: not trained,
  tuned, fitted, or measured. The same test file writes
  `src/data/nir/lif-readout-example.v1.inspection.json`, the projection
  `nir-rs` produces from that envelope, and asserts that both committed files
  match the generator byte for byte. Regenerate both (after bumping
  `asset.revision` and the file names if the graph changes) with:

  ```text
  cargo +1.98.1 test --manifest-path crates/neuromorphic-adapter/Cargo.toml --locked --features nir --test nir_example regenerate_nir_example -- --ignored --exact
  ```

  `.gitattributes` keeps both files LF on every checkout because they are
  compared byte for byte.
- **Static first.** The page imports the committed projection at build time
  and renders the SVG diagram, a per-operator parameter table, and the
  provenance without JavaScript. Enhancement loads the labs adapter package,
  fetches the envelope, parses and validates it with `nir-rs` in Rust/WASM,
  and enables node selection only if the WASM projection is byte-identical to
  the one embedded in the page (`projection-mismatch` otherwise). The page
  embeds that projection as a build-emitted JSON string literal; the browser
  only decodes it with `JSON.parse` (which executes nothing), requires a
  string, and compares it. Node views returned by WASM pass a structural check
  before they are rendered, always through `textContent`. Any failure keeps the
  complete static page and reports `data-nir-state="unavailable"`.
  `test/nir-lab.test.mjs` replays the same equality against the committed
  labs package under Node.
- **Converting a `.nir` file (not shipped).** No HDF5 asset is bundled. A
  future `.nir` example must be converted natively, outside the browser and
  outside `npm run build`: a host-only tool reads it with
  `nir_rs::io::read_with` (with the `hdf5` feature and a system libhdf5) and
  writes this envelope. It needs a new `asset.origin` variant that records the
  source file's SHA-256, its upstream repository/revision, and its license, a
  new envelope or asset revision, and a committed generator test like
  `nir_example.rs`. That tool must not be a dependency of the adapter crate.
- **Scope.** Only bundled, versioned assets are inspected. Importing arbitrary
  user-supplied NIR files is not implemented.
- **Size.** Deserializing the `nir-rs` graph model through Serde is most of
  the labs package's extra weight, which is why NIR lives behind the `nir`
  feature and outside the homepage package (sizes below). The projection
  structs declare fields alphabetically so the WASM path serializes directly
  instead of through `serde_json::Value`, which saved about 70 KB.

## Reward-modulated learning lab (GitHub #17 / Linear RM-1654)

`/labs/plasticity/` runs a small reward-modulated SNN session live in the
labs package (`plasticity` cargo feature, labelled `LIVE · Rust/WASM` once the
package loads and `UNAVAILABLE · Rust/WASM` before that or without it). It is
a separate route with its own package: the homepage never loads it, and a
headless-Chrome check confirms the homepage requests only
`/wasm/neuromorphic-adapter/`.

```text
Reward / Penalty button → LabObservation (limbic_critic::Environment)
  → SimpleCritic::try_assess → ModulatorVector
  → plasticity_lab::bridge::to_neuromodulators → NeuroModulators
  → PlasticityTrainer::train_step_with_modulators_and_rng(network, stimulus, modulators, rng)
  → neuromod SpikingNetwork::step_with_rng (LIF, traces, R-STDP, L1 renormalization)
```

- **Ownership.** `crates/neuromorphic-adapter/src/plasticity.rs` picks the
  network shape and initial values through `neuromod`'s public API, builds
  the two stimulus vectors, implements `limbic-critic`'s `Environment` trait
  for the buttons, loops over the scripted session, and reads state back. It
  contains no learning rule, reward shaping, or modulator arithmetic. It is
  exported as `WasmPlasticityLab` (`create(seed)`, `step(stimulus, event)`,
  `newEpisode()`, `probe()`, typed-array getters) from the labs package only.
- **Network.** `SpikingNetwork::with_dimensions(2, 0, 4)`: two LIF neurons, no
  Izhikevich bank, four input channels. Pattern A drives channels 0–1 and
  pattern B channels 2–3 at amplitude 0.8. Weights start at the documented
  equal share of `neuromod`'s L1 budget (2.0 / 4 = 0.5); the threshold (0.12),
  `RmStdpConfig { tau_eligibility: 100, reward_lr: 8 }`, the probe amplitude
  (0.15), and the six probe steps follow `plasticity-lab`'s delayed-association
  test at the pinned revision. They are hand-picked for a visible demo, not
  tuned or fitted.
- **Enabled mechanisms** (exactly these):
  1. `limbic-critic` `SimpleCritic::try_assess` (stateless). A reward reports
     objective +1; a penalty reports objective −1 and stress 1. The critic maps
     a positive objective to dopamine in [0, 1] and stress to norepinephrine.
     Serotonin and acetylcholine stay 0 because the lab reports no volatility or
     surprise.
  2. `plasticity-lab` `bridge::to_neuromodulators` (a 1:1 field copy) and
     `PlasticityTrainer::train_step_with_modulators_and_rng` for every step.
  3. `neuromod` reward-modulated STDP: each step decays and accumulates one
     eligibility trace per synapse from pre/post spike timing (input spike
     times come from `neuromod`'s per-channel Bernoulli trial, which is the
     only RNG use); a dopamine-derived rate (0.5 × dopamine) converts traces
     into weight changes; each neuron's weights are then renormalized to the
     L1 budget of 2.0. A reward a few steps after a pattern still pays for it,
     and it pays every trace still alive, including traces a penalized
     pattern left earlier in the same episode.
  4. `neuromod` modulator effects on dynamics: dopamine moves the threshold
     toward its target, and norepinephrine scales the input gain down to
     `max(1 − NE, 0.1)`.
  5. Episodes: `SpikingNetwork::reset` clears spike times, membranes, traces,
     and modulators and keeps weights and thresholds.
  6. Probe: `PlasticityTrainer::run_eval_with_rng` (frozen stepping) with
     default modulators on a field-by-field copy of the network, after
     `reset` on that copy.
- **Non-goals and limits.** `limbic-critic` is a reward-shaping map, not an
  actor-critic: no policy, no learned value function, no temporal-difference
  backup. `TDCritic` is not used: its signed dopamine has no depression path
  in `neuromod`, which converts traces only when dopamine is positive, so a
  penalty withholds reinforcement and never weakens a synapse. The reward is
  user input; nothing predicts or learns it. `plasticity-lab`'s scalar
  `RewardMapping` and its `run_session*` batch APIs are not used because they
  bypass `limbic-critic` (and `run_session_with_observer` uses the thread-local
  RNG). There is no encoder, `synaptic-wiring` topology, Izhikevich bank, or
  checkpointing. Both neurons start identical and receive the same input, so
  `neuromod` keeps them identical: the lab shows credit assigned to input
  channels, not competition between neurons.
- **Renormalization rounding.** `neuromod` renormalizes after every training
  step. When the budget already holds this changes nothing, but float rounding
  can move a weight by about one unit in the last place (≈6e-8), typically on
  the step after a payout. The view reports each step's largest `|Δw|` and
  labels such steps "float rounding only"; tests treat ≤ 1e-6 as rounding and
  require every learning-sized change to fall on a dopamine step.
- **Determinism.** A session is a pure function of its explicit `u64` seed
  (`StdRng::seed_from_u64`, `rand 0.10.2` from the lockfile) and its ordered
  `(new episode?, stimulus, event)` inputs. The probe draws from a fresh
  `StdRng::seed_from_u64(seed ^ 0xE7A1_0000)` on a copy, so probing never
  changes the session. The golden
  `src/data/plasticity/scripted-session.v1.json` (seed 17, four six-step
  episodes: A then a delayed reward, B then a delayed penalty, twice) pins per
  step the reward input, the critic observation and modulator bits, the input
  and output spikes, the membrane and threshold bits, and the before/after bits
  of every changed weight, plus the final weight, threshold, and trace bits
  and the probe before and after. `tests/plasticity_session.rs` regenerates and
  compares it natively; `test/plasticity-lab.test.mjs` replays it through the
  committed labs package under Node; "Run scripted session" replays it in the
  browser and reports `data-plasticity-golden="match"` only if every value is
  identical. Traces use `f32::exp` (decay and the STDP kernel), so the native
  test also checks that the exact `exp` inputs the golden needs round
  correctly on the build target. Regenerate with:

  ```text
  cargo +1.98.1 test --manifest-path crates/neuromorphic-adapter/Cargo.toml --locked --features plasticity --test plasticity_session regenerate_plasticity_golden -- --ignored --exact
  ```

  `.gitattributes` keeps the golden LF on every checkout.
- **Static first.** Without JavaScript or WebAssembly the page shows what the
  lab does, the enabled mechanisms and limits, and the golden session rendered
  at build time (every step, final weights, probe before/after). The controls
  and live panels stay hidden; a blocked or failing package reports
  `data-plasticity-state="unavailable"` and leaves the static page intact.
- **Separate state.** Reward input and `limbic-critic` output live in their own
  panel (dashed signal frame) fed by a bounded modulator history; neuron,
  spike, weight, and trace state live in another (solid frame) fed by the
  telemetry panel's spike-raster ring (`createSpikeRaster`, rows = 4 input
  channels + 2 LIF neurons). Neither panel shows the other's values.
- **Bounds and cadence.** Rust keeps only the current network. The raster and
  modulator history keep 48 steps, the event log 8 entries. Rendering goes
  through the telemetry flush scheduler. Run steps at 4 Hz (1 Hz under
  `prefers-reduced-motion`, including when the preference changes), never
  auto-starts, and pauses while the tab is hidden or the lab is off-screen.
  `pagehide` and `astro:before-swap` free the WASM session.
- **Why a git revision.** crates.io `plasticity-lab 0.2.1` requires
  `neuromod ^0.6`, which cannot share a graph with the adapter's
  `neuromod =0.7.0`. `Limen-Neural/plasticity-lab` `main` at
  `c80fac2eb96a140df9cfd999278bce414a329a56` requires `neuromod 0.7.0`, adds
  frozen evaluation, and forwards `wasm-js`; it is unpublished (its manifest
  still says 0.2.1), so the adapter pins it by revision like `axon-encoder`.
  The labs graph resolves a single `neuromod 0.7.0`.

## Browser build profiles

The adapter is one crate and one boundary, compiled once per profile listed in
`scripts/wasm-profiles.mjs` (name → cargo features → output directory):

| Profile | Cargo features | Package | Loaded by |
| --- | --- | --- | --- |
| `default` | none | `public/wasm/neuromorphic-adapter/` | the homepage live demo (`src/runtime/wasm-session.ts`) |
| `labs` | `nir`, `protocol`, `plasticity` | `public/wasm/neuromorphic-adapter-labs/` | off-homepage interactive surfaces: `/labs/nir/` (`src/runtime/nir-inspection.ts`), `/protocol/` (`src/protocol/provenance.ts`), and `/labs/plasticity/` (`src/runtime/plasticity-lab.ts`) |

**Why the split exists.** Off-homepage surfaces need crates the landing page
never uses. Linking `nir-rs` and its Serde decoder into one shared package
made the homepage download 3.5× the WASM for a lab it does not show. The
`labs` package now carries every off-homepage feature, and the `default`
package stays byte-identical to the pre-NIR build. A later surface adds its
feature to `labs.features` and its crates to `labs.requiredCrates`, and lists
those crates in `default.excludedCrates`. When its crates already sit in the
default graph transitively (the `protocol` feature's `sha2` and `serde_json`),
it lists them in `default.excludedDirectDependencies` and
`labs.requiredDirectDependencies` instead: the policy then checks the
adapter's own enabled features and direct dependencies per profile. The
homepage package never grows with it.

Measured on 2026-10-09 (Rust 1.98.1, wasm-bindgen 0.2.126, release build;
gzip is GNU gzip 1.14 `-9` of the file, before any HTTP compression the host
applies):

| Package | `.wasm` raw | `.wasm` gzip | `.js` glue raw | `.js` glue gzip |
| --- | ---: | ---: | ---: | ---: |
| `default` (`neuromorphic-adapter/`) | 189,316 B | 67,177 B | 16,606 B | 3,152 B |
| `labs`, `nir` only (#16, before `protocol`) | 670,382 B | 190,546 B | 21,858 B | 4,106 B |
| `labs`, `nir` + `protocol` (#21, before `plasticity`) | 966,603 B | 258,008 B | 31,745 B | 5,394 B |
| `labs`, `nir` + `protocol` + `plasticity` (`neuromorphic-adapter-labs/`) | 984,118 B | 265,619 B | 41,037 B | 6,310 B |

The `default` row is unchanged by the `protocol` and `plasticity` features:
its `.js`/`.d.ts` are byte-identical to a fresh default build, and the
committed `.wasm` is kept because a rebuild differs only in embedded source
paths. The `plasticity` row was measured on a Windows 11 host with the same
toolchain (`gzip -9 -c <file> | wc -c`, GNU gzip 1.14); on that host the
`nir` + `protocol` row above is the committed #21 package (966,603 B,
258,008 B gzip), so `plasticity` adds 17,515 B (7,611 B gzip) of WASM.

- `npm run build:wasm-web` builds every profile. Each profile has its own cargo
  target directory (`target/`, `target/labs/`), so the outputs never overwrite
  each other. `npm run test:wasm-web-pkg` regenerates every profile and fails
  on drift in the deterministic `.js`/`.d.ts` files.
- `npm run validate:rust` runs clippy, `cargo test`, and the wasm32
  `cargo check` twice: for the default build and with `--all-features` (the
  labs configuration, `nir` + `protocol` + `plasticity`).
- `scripts/verify-browser-dependencies.mjs` resolves each profile's graph
  separately: the native-dependency rules apply to both; `nir-rs`,
  `plasticity-lab`, and `limbic-critic` are required in `labs` and absent from
  `default`; `plasticity-lab` may enable only its `critic` and `wasm-js`
  features; and the adapter's enabled features and direct dependencies must
  match the profile (`default` enables none and has no direct `nir-rs`,
  `serde`, `serde_json`, `sha2`, `plasticity-lab`, or `limbic-critic`).
- The `nir` integration tests (`tests/nir_example.rs`, `tests/nir_inspection.rs`)
  declare `required-features = ["nir"]`, the protocol tests
  (`tests/protocol_fixtures.rs`, `tests/protocol_ingress.rs`) declare
  `required-features = ["protocol"]`, and `tests/plasticity_session.rs`
  declares `required-features = ["plasticity"]`, so they run in the
  `--all-features` pass.

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
| `neuromod` | `Limen-Neural/neuromod` (crates.io) | =0.7.0 | `a897cc9` (v0.7.0 tag) | `--no-default-features --features wasm-js` | **Pass**. The opt-in `wasm-js` feature enables the supported `getrandom` browser backend; the default-only graph remains intentionally unsupported. |
| `synaptic-wiring` | `Limen-Neural/synaptic-wiring` | `=0.3.0` | crates.io checksum `311aed9804c027f786ed5385883bd22469f8cb87fe804b88f77162466b9137b2`; audited source/main `5f70762b4ef09346d0689a65a1a8b20531cfbdab` | `--no-default-features` | **Pass** |
| `nir-rs` | `Limen-Neural/nir-rs` | 0.4.3 | `1043cbf7bc6acbece250c769b9c2c8f7c58ce681` | `--no-default-features --features serde` (`hdf5` excluded) | **Pass** |
| `nir-rs` | `Limen-Neural/nir-rs` | `=0.4.5` | crates.io checksum `cd21419b28aac9b71ec7abc63ec9c596e578f8fa7ce87019c255b93f84d09e00`; audited source/tag `f2d61779b261661a2c8eca14d79bde1e48c39969` (`v0.4.5`) | `default-features = false, features = ["serde"]` (`hdf5` excluded) | **Pass** on 2026-10-09 inside the adapter crate with `--locked --features nir`; approved as the NIR graph model behind the adapter's `nir` feature, linked only into the labs package (see [NIR network inspection](#nir-network-inspection-github-16--linear-rm-1653)). |
| `limbic-critic` | `Limen-Neural/limbic-critic` | 0.3.0 | `9bf0c79f5a47fac9c5b921dd9011b013d1ae52bb` | `--no-default-features` | **Pass** |
| `limbic-critic` | `Limen-Neural/limbic-critic` | `=0.3.0` | crates.io checksum `0afb84406e35b755770254f4418c4b7b92b79c089f10e5c671b9ae2016a79329` (the `Cargo.lock` checksum); source `9bf0c79f5a47fac9c5b921dd9011b013d1ae52bb` per the published crate's `.cargo_vcs_info.json` (the commit audited above); no dependencies | default (it has no features) | **Pass** on 2026-10-09 inside the adapter crate with `--locked --features plasticity`; approved as the lab's reward-shaping map behind the adapter's `plasticity` feature, labs package only (see [Reward-modulated learning lab](#reward-modulated-learning-lab-github-17--linear-rm-1654)). |
| `plasticity-lab` | `Limen-Neural/plasticity-lab` | 0.1.0 | `d47ae33914b6a3044d0539b851cd83621b7f1f4b` | `--no-default-features --features critic` | **Blocked:** its `neuromod 0.6.0` git dependency reaches `getrandom 0.4.3`, which emits the missing-`wasm_js` compile error. |
| `plasticity-lab` | `Limen-Neural/plasticity-lab` | crates.io 0.2.1 | crates.io release | — | **Not usable:** requires `neuromod ^0.6.0`, which conflicts with the adapter's `neuromod =0.7.0`. |
| `plasticity-lab` | `Limen-Neural/plasticity-lab` | git (manifest says 0.2.1, unpublished) | `c80fac2eb96a140df9cfd999278bce414a329a56` (`main`); git sources carry no `Cargo.lock` checksum, the revision is the pin | `default-features = false, features = ["critic", "wasm-js"]` | **Pass** on 2026-10-09 inside the adapter crate with `--locked --features plasticity`: one `neuromod 0.7.0` in the graph, no `-sys`, C build tooling, HDF5, ZeroMQ, Tokio, or Axum crates; approved behind the adapter's `plasticity` feature, labs package only. |
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
plus RM-1650/GitHub #14 and RM-1651/GitHub #15. The former `plasticity-lab`
V2 blocker is resolved at revision `c80fac2`, which depends on `neuromod 0.7.0`
and forwards its opt-in `wasm-js` feature (GitHub #17 / RM-1654).
The site must pin the Rust toolchain, commit its dependency lockfile, and run
locked target checks in CI before enabling the live browser simulation.
