# Performance budgets for the live neuromorphic demo

- **Scope:** GitHub #10 / Linear RM-1646. Builds on #6 (renderer), #7 (spike
  propagation), #8 (`kinetic-signals` input), #14 (`neuromod`), and #15
  (`axon-encoder`).
- **Recorded:** 2026-10-09, on one machine (see [Measurement
  context](#measurement-context)).
- **Related:** [`browser-runtime.md`](browser-runtime.md) (contracts and
  lifecycle). The harnesses are in `scripts/perf/` and
  `crates/neuromorphic-adapter/examples/stage_bench.rs`.

This document keeps two kinds of numbers apart:

- **Targets** are design decisions. They say what the demo must stay within,
  and they hold whether or not anything has been measured.
- **Measurements** come from runs that were actually performed, with the
  machine, OS, browser, GPU renderer string, and headless or headed mode
  recorded next to them. A number with no recorded run is listed under
  [Not measured](#not-measured) instead.

## Summary

- On the reference desktop, the shipped pipeline (16 neurons, 64 synapses,
  contract 5) runs far inside every target. One full WASM step (`input` plus
  `step`) takes 1.95 to 4.4 µs in Chrome. Drawing a frame takes 0.08 to 0.12 ms
  on the main thread. No tick overran its 50 ms slot in any measured window.
- The biggest per-step cost was the TypeScript bridge, not Rust. It read
  wasm-bindgen getters dozens of times per snapshot (each read copies the array
  out of WASM again), rebuilt a string multiset to check the routed topology on
  every step, and never freed the WASM state handle. In Chrome that took 39.7 to
  41.1 µs per snapshot, and it grew without bound in tight loops: in Node it
  reached 435 µs while WASM linear memory reached 477 MB. Reading each getter
  once, freeing the handle, and caching the routed-topology check by value
  brought it to 11.9 to 12.9 µs, with flat WASM memory. Outputs are unchanged,
  and the goldens and the new equivalence test still pass.
- At synthetic scale, simulation is the first bottleneck. The `neuromod` LIF
  bank grows as neurons × channels: one step at 1024 neurons takes 7.6 ms
  native and 12.4 to 13.2 ms as WASM. Rendering 1024 nodes, 32,768 edges, and
  about 15,500 pulses takes 1.07 to 1.09 ms per frame and leaves Chrome's frame
  cadence unchanged. These sizes are not what ships.
- Adaptive quality now caps the pixel ratio, pulse count, frame rate, and
  telemetry refresh. It steps down under sustained frame-time pressure, with
  hysteresis. With a 20× CPU throttle on the largest synthetic topology, it
  stepped from full to balanced at 2.4 s. It tried full again at 9.4 s, fell
  back at 11.5 s, and the flap guard then doubled the next recovery wait. The
  exact path varied between runs (section 6).
- Offscreen and hidden pages do no simulation or render work: 0 ticks and 0
  frames over 3 s, in both headless and headed Chrome, measured live.

## Targets

These are design decisions. The measurement column points to the evidence
below. "Low-end" targets have no measurement yet; see [Not
measured](#not-measured).

### Simulation (fixed 50 ms logical tick)

| # | Budget | Target | Reference-desktop measurement |
| --- | --- | --- | --- |
| S1 | Simulation cadence | Fixed 20 Hz (`DEMO_TICK_MS` = 50 ms), never adapted | Fixed. The equivalence test pins it |
| S2 | WASM work per step (`input` + `step`, including the Rust snapshot clone) | ≤ 0.25 ms p95 desktop; ≤ 1 ms p95 low-end | 1.95–4.4 µs median (Chrome); p95 1.2–3.2 µs native, 1.9–5.1 µs WASI |
| S3 | WASM → JS snapshot transfer (getters, bridge validation, JS-owned copies) | ≤ 0.05 ms per step | 11.9–12.9 µs `bridge state()` (Chrome) |
| S4 | Worker tick round trip (input + step messages, transfer) | ≤ 1 ms p95 | 66.5–72.2 µs median (microbench); live `tick` p95 0.4–0.6 ms |
| S5 | Tick overruns (a tick still running when the next is due) | 0 per minute | 0 in every live window (no `tick-overrun` count) |
| S6 | Main-thread work per published step (renderer latch, spike ingestion, listeners, telemetry hook) | ≤ 0.25 ms p95 | `publish` p95 ≤ 0.1 ms (timer floor) |
| S7 | Spike-event throughput | ≤ 64 events per step (every neuron × 4 synapses) = 1,280 per second, within the 512-event ring | ≤ 63.97 events per step; 0 evictions in every run |
| S8 | Memory | WASM linear memory flat per step; every JS buffer fixed-size (see [audit](#buffer-audit)) | Flat (5000 steps: +0 bytes with the fix) |
| S9 | Topology size | 16 / 64 ships. A new contract that grows it must keep S2 within budget on low-end devices: ≤ 256 neurons | 256 neurons: 0.48 ms native, 0.80–0.90 ms WASI per SNN step |

### Rendering

| # | Budget | Target | Reference-desktop measurement |
| --- | --- | --- | --- |
| R1 | Frame pacing at full quality | p95 frame interval ≤ 18.2 ms (55 fps) | 6.1–6.2 ms p95 |
| R2 | Main-thread draw time per frame, shipped topology, full quality | ≤ 2 ms p95 desktop; ≤ 8 ms mean low-end (the adaptive budget) | 0.2 ms p95 (0.1 ms timer); 0.08–0.12 ms mean |
| R3 | Degradation trigger | Step down after 2 consecutive 1 s windows with p90 interval > 22.2 ms (below 45 fps) or mean draw > 8 ms. Step up after 5 consecutive windows with p90 < 18.2 ms and draw < 4 ms; flapping doubles the wait, up to 40 | Exercised under a 20× CPU throttle (below) |
| R4 | Pixel-ratio cap per level | 2 / 1.5 / 1 / 1 | Applied: DPR 3 display rendered at 2 / 1.5 / 1 / 1 |
| R5 | Pulses drawn per frame per level | all buffered / 256 / 96 / 0 | 15,515 / 256 / 96 / 0 (1024-node stress, headed) |
| R6 | Frame-rate cap per level | none / none / 30 fps / 20 fps | ~17% and ~11% of animation frames drawn at reduced / minimal |
| R7 | Telemetry/DOM refresh cadence per level | every step (50 ms) / 100 / 200 / 500 ms | Reflected as `data-demo-telemetry-cadence-ms` |
| R8 | Offscreen or hidden | 0 simulation ticks and 0 frames | 0 / 0 |
| R9 | Live-demo payload (island entry plus lazily loaded three.js, WASM, glue, worker) | ≤ 250 KB brotli | 233,755 bytes brotli |
| R10 | First live frame after the island becomes eligible | ≤ 500 ms on desktop | 218.2 ms headless and 378.7 ms headed after navigation start, from localhost |

## Measurement context

Every measurement below comes from this machine and these runs unless a row
says otherwise.

| Item | Value |
| --- | --- |
| Machine | Desktop, ASUS motherboard, AMD Ryzen 9 9950X (16 cores, 32 threads), 64 GB RAM |
| GPU / display | NVIDIA GeForce RTX 5080 (driver 32.0.16.1714) driving a 3840×2160 display that Windows reports at 239 Hz; integrated AMD Radeon also present |
| OS | Windows 11 Home 10.0.26200, "Balanced" power plan |
| Browser | Chrome 155.0.8059.40 (V8 15.5.35.20), fresh profile per run |
| WebGL renderer (`WEBGL_debug_renderer_info`) | `ANGLE (NVIDIA, NVIDIA GeForce RTX 5080 (0x00002C02) Direct3D11 vs_5_0 ps_5_0, D3D11)` in **both** headless and headed runs. Hardware rendering, not SwiftShader |
| Headless run | `--headless=new`, DPR 1, viewport 1244×795, 2026-10-09 09:06 UTC |
| Headed run | Visible window, DPR 3 (Windows display scaling 300%), viewport 1268×641, 2026-10-09 09:09 UTC |
| Throttled run | Headless as above with `Emulation.setCPUThrottlingRate` 20 on the page |
| Chrome flags (both) | `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`. Visibility is driven explicitly instead (see [Offscreen](#offscreen-and-background)) |
| `performance.now()` resolution | 0.1 ms (page is not cross-origin isolated). Live-page samples below 0.1 ms are quantized; their means are approximate. Exact per-stage costs come from the batched microbenchmarks |
| Node (boundary and WASI runs) | Node 22.12.0, V8 12.4.254.21 |
| Rust | 1.98.1, `--release` (opt-level 3) for the native and `wasm32-wasip1` harness builds. The Node and Chrome boundary runs use the committed `public/wasm/neuromorphic-adapter` package |
| Site build | `npm run build` (production), served by the harness's static server on `127.0.0.1` with `cache-control: no-store` and no compression |
| Revision | Chrome and Node runs: this branch on top of the #45 head `f944b2a`. Sections 1 and 2 ran on the same Rust crate sources, which that base does not change |

Chrome delivered animation frames about every 5.5 to 5.9 ms (about 170 to 180
Hz) in both modes, even though the display reports 239 Hz. Frame-interval
numbers are therefore Chrome's frame cadence on this machine. They are not a
GPU limit.

## Measurements

### 1. Rust pipeline, per stage

`stage_bench` records each stage's real inputs from one pipeline run, then
times each stage separately with a fresh instance. Cells are the median of 15
runs × 2000 ticks, in µs per tick. The "input+step" columns go through the
real `BrowserRuntime`; its p95, p99, and max are per-tick samples at the
100 ns resolution of Windows `QueryPerformanceCounter`. "Materialize" is the
`state()` clone the contract makes every step.

**Native x86_64 (Windows):**

| input | mode | encoded spikes/tick | LIF spikes/tick | extract | encode | propagate | SNN step | materialize | input+step | p95 | p99 | max |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| scripted | delta | 2.88 | 15.99 | 0.027 | 0.063 | 0.070 | 2.136 | 0.359 | 2.940 | 3.100 | 3.100 | 18.600 |
| scripted | temporal | 0.05 | 1.32 | 0.027 | 0.071 | 0.039 | 0.664 | 0.341 | 1.295 | 1.800 | 1.900 | 3.600 |
| scripted | rate | 3.82 | 15.98 | 0.027 | 0.157 | 0.081 | 2.156 | 0.362 | 3.061 | 3.200 | 3.300 | 4.500 |
| pointer-active | delta | 6.83 | 15.99 | 0.030 | 0.098 | 0.104 | 2.133 | 0.359 | 2.987 | 3.100 | 3.100 | 5.700 |
| pointer-active | temporal | 4.39 | 15.95 | 0.030 | 0.144 | 0.083 | 2.133 | 0.360 | 3.023 | 3.200 | 3.200 | 5.300 |
| pointer-active | rate | 8.98 | 15.98 | 0.030 | 0.222 | 0.130 | 2.115 | 0.373 | 3.124 | 3.200 | 3.300 | 5.600 |
| pointer-idle | delta | 0.00 | 0.04 | 0.019 | 0.011 | 0.037 | 0.763 | 0.344 | 1.274 | 1.400 | 1.700 | 3.100 |
| pointer-idle | temporal | 0.00 | 0.00 | 0.019 | 0.069 | 0.038 | 0.491 | 0.350 | 1.114 | 1.200 | 1.300 | 4.000 |
| pointer-idle | rate | 2.00 | 15.98 | 0.019 | 0.081 | 0.055 | 1.604 | 0.360 | 2.361 | 2.500 | 2.500 | 4.700 |

**Same harness compiled to `wasm32-wasip1`, run by Node 22.12.0 (V8 12.4):**

| input | mode | encoded spikes/tick | LIF spikes/tick | extract | encode | propagate | SNN step | materialize | input+step | p95 | p99 | max |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| scripted | delta | 2.88 | 15.99 | 0.049 | 0.077 | 0.095 | 3.696 | 0.286 | 4.479 | 4.800 | 4.900 | 6.800 |
| scripted | temporal | 0.05 | 1.32 | 0.032 | 0.102 | 0.040 | 1.219 | 0.272 | 1.923 | 2.600 | 2.700 | 4.600 |
| scripted | rate | 3.82 | 15.98 | 0.032 | 0.161 | 0.094 | 3.743 | 0.280 | 4.666 | 4.900 | 5.200 | 390.700 |
| pointer-active | delta | 6.83 | 15.99 | 0.033 | 0.070 | 0.122 | 3.759 | 0.282 | 4.637 | 4.900 | 5.000 | 7.100 |
| pointer-active | temporal | 4.39 | 15.95 | 0.033 | 0.156 | 0.097 | 3.679 | 0.280 | 4.621 | 4.900 | 5.000 | 9.600 |
| pointer-active | rate | 8.98 | 15.98 | 0.033 | 0.194 | 0.152 | 3.750 | 0.281 | 4.799 | 5.100 | 5.200 | 7.300 |
| pointer-idle | delta | 0.00 | 0.04 | 0.026 | 0.018 | 0.037 | 1.484 | 0.266 | 2.085 | 2.400 | 3.000 | 6.400 |
| pointer-idle | temporal | 0.00 | 0.00 | 0.026 | 0.099 | 0.037 | 1.049 | 0.264 | 1.712 | 1.900 | 1.900 | 4.700 |
| pointer-idle | rate | 2.00 | 15.98 | 0.027 | 0.085 | 0.063 | 2.768 | 0.280 | 3.561 | 3.800 | 3.900 | 6.200 |

The input sources are the shipped scripted Lissajous path, a deterministic
fast jittered drag with pressure ("pointer-active"), and a pointer held still
("pointer-idle"). The `neuromod` step is the largest stage in every workload,
and its cost rises with the number of LIF neurons that fire: natively 0.49 to
0.76 µs when almost none fire, and 2.1 µs when all 16 do. Extraction,
encoding, and propagation are each under 0.25 µs. The 390.7 µs WASI maximum is
an outlier; that row's p99 is 5.2 µs.

### 2. Synthetic topologies (not shipped)

These are larger `synaptic-wiring` small-world graphs and `neuromod` LIF banks,
built through the same crates. Source spikes come from a deterministic hash at
10% or 50% of neurons per tick. The shipped adapter is fixed at 16 / 64. Cells
are in µs per tick: the median of 7 runs × 400 ticks, or × 100 ticks for ≥ 1024
neurons. "Snapshot bytes" is what the contract-5 state would carry per step at
that size.

| neurons | fan-out | synapses | firing | events/tick | snapshot bytes | propagate (native) | SNN step (native) | materialize (native) | propagate (WASI) | SNN step (WASI) | materialize (WASI) |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 16 | 4 | 64 | 10% | 6.4 | 2,192 | 0.054 | 2.080 | 0.283 | 0.061 | 3.569 | 0.259 |
| 16 | 4 | 64 | 50% | 32.1 | 2,216 | 0.112 | 2.099 | 0.274 | 0.130 | 3.667 | 0.230 |
| 64 | 8 | 512 | 10% | 51.3 | 15,968 | 0.165 | 30.269 | 0.393 | 0.214 | 55.782 | 0.330 |
| 64 | 8 | 512 | 50% | 256.3 | 16,072 | 0.632 | 30.115 | 0.391 | 0.771 | 52.771 | 0.334 |
| 256 | 16 | 4,096 | 10% | 409.7 | 123,056 | 1.071 | 478.121 | 1.426 | 1.249 | 897.851 | 1.244 |
| 256 | 16 | 4,096 | 50% | 2,048.5 | 123,464 | 4.788 | 478.445 | 1.420 | 5.567 | 804.160 | 1.295 |
| 1024 | 32 | 32,768 | 10% | 3,277.4 | 967,136 | 8.532 | 7,584.274 | 171.827 | 9.588 | 13,211.792 | 12.395 |
| 1024 | 32 | 32,768 | 50% | 16,384.0 | 968,776 | 37.802 | 7,607.166 | 48.995 | 43.399 | 12,440.503 | 12.456 |
| 2048 | 32 | 65,536 | 10% | 6,554.9 | 1,934,204 | 15.737 | 30,608.795 | 37.725 | 18.618 | 53,386.000 | 26.349 |
| 2048 | 32 | 65,536 | 50% | 32,769.9 | 1,937,480 | 75.919 | 30,833.705 | 34.369 | 87.901 | 50,822.204 | 26.640 |

The SNN step grows 14.5 to 16× each time the neuron count quadruples; it is
O(neurons × channels). At 2048 neurons the WASM SNN step alone (50.8 to
53.4 ms) is longer than the 50 ms tick, so S5 would fail. Native
materialization of ~1 MB snapshots varied between the two 1024-neuron rows
(49.0 vs 171.8 µs); the cause was not investigated. Propagation stays linear
in events.

### 3. WASM ↔ JS transfer for the contract-5 snapshot

`scripts/perf/boundary-bench.mjs` runs against the committed `web` package
and the shipped bridge. Cells are the median of 7 runs × 2000 ticks, in µs per
tick. A contract-5 snapshot carries 2,184 to 2,248 bytes of typed arrays, of
which 2,056 bytes (91%) is the static topology projection, re-sent every step.

| stage | what it times |
| --- | --- |
| raw input | `WasmAdapter.input` only: packet copy-in, `kinetic-signals`, `axon-encoder` |
| raw input+step | adds `synaptic-wiring`, `neuromod`, and the Rust `state()` clone; the handle is freed at once |
| raw state() | Rust clone plus wrapper allocation |
| getters | every field read once out of WASM into JS-owned arrays |
| bridge state() | the shipped bridge: Rust clone, getters, validation, JS-owned copies |
| bridge tick | the full main-thread fallback path, `input` + `step` |
| worker tick | the shipped worker module: input and step messages, with snapshot buffers transferred back |
| spike ingest | `SpikeEventBuffer.ingest` of those real snapshots |

**Chrome 155 (bridge before and after this change, headless and headed):**

| run | bridge | input | mode | raw input | raw input+step | raw state() | getters | bridge state() | bridge tick | worker tick | spike ingest | LIF spikes/tick | events/tick |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| headless | before | scripted | delta | 0.3 | 4.35 | 0.35 | 3.75 | 41.05 | 50.8 | 68.35 | 3.15 | 15.99 | 63.97 |
| headless | before | scripted | temporal | 0.25 | 2 | 0.35 | 4 | 40.7 | 45.7 | 73.15 | 0.5 | 1.32 | 5.28 |
| headless | before | scripted | rate | 0.3 | 4.3 | 0.4 | 4.45 | 39.7 | 47.5 | 69.05 | 3 | 15.98 | 63.94 |
| headless | before | pointer-active | delta | 0.25 | 4.2 | 0.35 | 4.2 | 39.85 | 48.35 | 73.2 | 3.1 | 15.99 | 63.97 |
| headless | before | pointer-active | temporal | 0.3 | 4.4 | 0.35 | 4.7 | 40.9 | 50.6 | 93.6 | 3.4 | 15.95 | 63.81 |
| headless | before | pointer-active | rate | 0.35 | 4.4 | 0.35 | 4.45 | 40.25 | 48.05 | 69.15 | 3.15 | 15.98 | 63.94 |
| headless | after | scripted | delta | 0.35 | 4.2 | 0.35 | 3.65 | 12.05 | 17.95 | 70.25 | 3.8 | 15.99 | 63.97 |
| headless | after | scripted | temporal | 0.25 | 1.95 | 0.35 | 3.95 | 12.1 | 13.95 | 67.95 | 0.55 | 1.32 | 5.28 |
| headless | after | scripted | rate | 0.35 | 4.35 | 0.35 | 4.15 | 12.3 | 16.55 | 71.25 | 3.1 | 15.98 | 63.94 |
| headless | after | pointer-active | delta | 0.25 | 4.2 | 0.35 | 3.9 | 12.05 | 16.3 | 69.2 | 3.2 | 15.99 | 63.97 |
| headless | after | pointer-active | temporal | 0.3 | 4.3 | 0.35 | 4.15 | 12.35 | 16.55 | 69.35 | 3 | 15.95 | 63.81 |
| headless | after | pointer-active | rate | 0.35 | 4.35 | 0.35 | 3.85 | 12 | 16.35 | 68.7 | 3.15 | 15.98 | 63.94 |
| headed | after | scripted | delta | 0.3 | 4.25 | 0.35 | 3.6 | 12.35 | 16.85 | 70.45 | 3.15 | 15.99 | 63.97 |
| headed | after | scripted | temporal | 0.25 | 1.95 | 0.35 | 3.95 | 12.7 | 14.15 | 66.5 | 0.5 | 1.32 | 5.28 |
| headed | after | scripted | rate | 0.35 | 4.3 | 0.4 | 4 | 12.7 | 16.95 | 68.25 | 2.95 | 15.98 | 63.94 |
| headed | after | pointer-active | delta | 0.25 | 4.15 | 0.35 | 3.95 | 11.9 | 16.65 | 72.2 | 3.1 | 15.99 | 63.97 |
| headed | after | pointer-active | temporal | 0.3 | 4.35 | 0.35 | 4.3 | 12.9 | 17.6 | 69.05 | 2.95 | 15.95 | 63.81 |
| headed | after | pointer-active | rate | 0.35 | 4.4 | 0.35 | 4.1 | 12.1 | 16.3 | 69.45 | 3.1 | 15.98 | 63.94 |

**Node 22.12.0 (same benchmark, no worker):**

| bridge | input | mode | raw input | raw input+step | raw state() | getters | bridge state() (min–max of 7) | bridge tick | spike ingest |
|---|---|---|---:|---:|---:|---:|---|---:|---:|
| before | scripted | delta | 0.365 | 5.71 | 0.566 | 3.678 | 47.171 (45.051–50.787) | 69.347 | 4.428 |
| before | scripted | temporal | 0.307 | 2.401 | 0.506 | 3.113 | 192.703 (186.418–199.622) | 268.897 | 0.897 |
| before | scripted | rate | 0.381 | 5.753 | 0.498 | 2.946 | 240.7 (231.174–253.871) | 304.77 | 4.274 |
| before | pointer-active | delta | 0.317 | 5.606 | 0.484 | 2.717 | 297.3 (276.16–320.772) | 370.11 | 4.32 |
| before | pointer-active | temporal | 0.369 | 5.649 | 0.499 | 2.78 | 371.836 (356.802–389.413) | 436.928 | 4.246 |
| before | pointer-active | rate | 0.409 | 5.718 | 0.508 | 2.722 | 434.788 (420.828–459.222) | 508.293 | 4.315 |
| after | scripted | delta | 0.365 | 5.76 | 0.51 | 3.42 | 11.365 (10.945–13.429) | 17.645 | 4.796 |
| after | scripted | temporal | 0.321 | 2.536 | 0.499 | 3.284 | 10.638 (10.292–12.552) | 13.801 | 0.717 |
| after | scripted | rate | 0.345 | 5.628 | 0.472 | 2.853 | 10.517 (10.472–10.657) | 17.829 | 4.258 |
| after | pointer-active | delta | 0.264 | 5.629 | 0.484 | 2.774 | 10.585 (10.414–10.897) | 17.471 | 4.221 |
| after | pointer-active | temporal | 0.336 | 5.525 | 0.484 | 2.864 | 10.325 (10.223–10.388) | 17.05 | 4.249 |
| after | pointer-active | rate | 0.417 | 5.679 | 0.468 | 2.809 | 10.415 (10.254–10.829) | 17.777 | 4.278 |

**WASM linear memory.** The benchmark runs 5000 synchronous steps with and
without freeing each step's state handle:

| run | before the steps | without `free()` | with `free()` |
| --- | ---: | ---: | ---: |
| Node, bridge after | 1,245,184 B | 14,876,672 B (+13.6 MB, ≈2.7 KB/step) | +0 B |
| Chrome headless, bridge after | 1,179,648 B | 14,811,136 B (+13.6 MB) | +0 B |
| Node, bridge before | 477,626,368 B (already grown by the earlier rows) | 491,257,856 B | +0 B |
| Chrome headless, bridge before | 80,936,960 B (already grown) | no further growth | +0 B |

The old bridge relied on wasm-bindgen's `FinalizationRegistry` to free each
`WasmState`. Finalizers are scheduled as tasks, so in tight loops they never
ran: linear memory grew, and in Node the per-snapshot cost rose with it
across the run (47.2 → 434.8 µs in the "before" rows). The bridge now
reads each getter exactly once and frees the handle immediately. It also checks
the routed topology against its canonical projection by value against the
last verified copy, instead of rebuilding a string multiset every step; any
difference still triggers the full check. In a one-off Node profile of the
read-once bridge (not committed), that rebuild took 23.0 of 31.3 µs per
snapshot.

### 4. Live page in Chrome (real worker, real renderer)

This is `/?neuromorphic-perf` on the production build. Each window lasts 8 s
after a 0.4 s settle. Levels 0 to 3 are pinned through `forceQuality`;
"adaptive" is left unpinned. Pointer runs drive CDP mouse events across the
render surface at about 32 events per second, pressed 3 s out of every 4 s;
every input-source sample during those windows reported `pointer`. Times are
mean / p95 / max in ms, quantized at 0.1 ms.

| run | scenario | level | DPR applied | ticks | tick | tick-step | publish | spike ingest | frames drawn / skipped | frame work | frame interval | pulses per drawn frame |
|---|---|---|---:|---:|---|---|---|---|---|---|---|---:|
| headless | scripted, adaptive | full | 1 | 161 | 0.35 / 0.50 / 0.70 | 0.20 / 0.30 / 0.40 | 0.01 / 0.10 / 0.20 | 0.01 / 0.10 / 0.10 | 1459 / 0 | 0.08 / 0.20 / 0.40 | 5.54 / 6.10 / 6.90 | 14.5 |
| headless | scripted | full | 1 | 162 | 0.35 / 0.50 / 0.70 | 0.19 / 0.30 / 0.40 | 0.02 / 0.10 / 0.20 | 0.01 / 0.10 / 0.10 | 1447 / 0 | 0.08 / 0.20 / 0.20 | 5.58 / 6.10 / 7.10 | 10.7 |
| headless | scripted | balanced | 1 | 162 | 0.37 / 0.50 / 1.10 | 0.20 / 0.30 / 0.90 | 0.01 / 0.10 / 0.10 | 0.00 / 0.00 / 0.10 | 1439 / 0 | 0.10 / 0.20 / 0.40 | 5.61 / 6.20 / 6.80 | 17.6 |
| headless | scripted | reduced | 1 | 161 | 0.25 / 0.40 / 0.60 | 0.13 / 0.20 / 0.30 | 0.01 / 0.10 / 0.10 | 0.01 / 0.10 / 0.10 | 230 / 1152 | 0.09 / 0.20 / 0.30 | 5.83 / 6.10 / 6.90 | 8.6 |
| headless | scripted | minimal | 1 | 161 | 0.26 / 0.40 / 0.90 | 0.14 / 0.30 / 0.60 | 0.01 / 0.10 / 0.10 | 0.01 / 0.10 / 0.10 | 155 / 1229 | 0.10 / 0.20 / 0.40 | 5.83 / 6.10 / 6.70 | 0.0 |
| headless | pointer-active | full | 1 | 162 | 0.39 / 0.60 / 0.90 | 0.20 / 0.30 / 0.60 | 0.03 / 0.10 / 0.10 | 0.02 / 0.10 / 0.10 | 1418 / 0 | 0.12 / 0.20 / 0.30 | 5.69 / 6.20 / 6.70 | 173.6 |
| headless | pointer-active | minimal | 1 | 161 | 0.30 / 0.40 / 1.70 | 0.15 / 0.30 / 0.30 | 0.02 / 0.10 / 0.10 | 0.01 / 0.10 / 0.10 | 157 / 1248 | 0.12 / 0.20 / 0.30 | 5.73 / 6.10 / 7.10 | 0.0 |
| headed | scripted, adaptive | full | 2 | 162 | 0.34 / 0.50 / 0.80 | 0.19 / 0.30 / 0.50 | 0.01 / 0.10 / 0.10 | 0.01 / 0.10 / 0.10 | 1447 / 0 | 0.09 / 0.20 / 0.40 | 5.57 / 6.10 / 7.90 | 15.0 |
| headed | scripted | full | 2 | 161 | 0.31 / 0.50 / 0.70 | 0.18 / 0.30 / 0.40 | 0.01 / 0.10 / 0.10 | 0.01 / 0.10 / 0.10 | 1452 / 0 | 0.08 / 0.20 / 0.20 | 5.56 / 6.10 / 6.70 | 10.7 |
| headed | scripted | balanced | 1.5 | 162 | 0.29 / 0.50 / 0.70 | 0.17 / 0.30 / 0.50 | 0.01 / 0.10 / 0.20 | 0.01 / 0.10 / 0.10 | 1438 / 0 | 0.09 / 0.20 / 0.30 | 5.62 / 6.10 / 6.70 | 17.8 |
| headed | scripted | reduced | 1 | 161 | 0.24 / 0.40 / 0.70 | 0.13 / 0.20 / 0.30 | 0.01 / 0.10 / 0.10 | 0.01 / 0.10 / 0.10 | 231 / 1154 | 0.09 / 0.20 / 0.20 | 5.81 / 6.10 / 7.10 | 8.5 |
| headed | scripted | minimal | 1 | 161 | 0.23 / 0.40 / 0.60 | 0.12 / 0.20 / 0.30 | 0.01 / 0.10 / 0.10 | 0.01 / 0.10 / 0.10 | 154 / 1230 | 0.08 / 0.20 / 0.20 | 5.82 / 6.10 / 6.80 | 0.0 |
| headed | pointer-active | full | 2 | 162 | 0.31 / 0.50 / 0.90 | 0.18 / 0.30 / 0.40 | 0.02 / 0.10 / 0.10 | 0.02 / 0.10 / 0.10 | 1437 / 0 | 0.10 / 0.20 / 0.30 | 5.62 / 6.10 / 7.90 | 173.4 |
| headed | pointer-active | minimal | 1 | 161 | 0.26 / 0.40 / 0.60 | 0.14 / 0.20 / 0.30 | 0.02 / 0.10 / 0.10 | 0.01 / 0.10 / 0.10 | 156 / 1234 | 0.09 / 0.20 / 0.20 | 5.80 / 6.10 / 7.10 | 0.0 |

- `tick` is the main thread's view of one worker tick: a telemetry sample, two
  request/response round trips, and publish. It includes event-loop
  scheduling delay behind rendering.
- `tick-overrun` never appeared. Each window held 161 to 162 ticks in 8 s,
  which is the full 20 Hz.
- Pulse counts follow what the network did in each window. During the
  headless pointer window the buffer took 10,752 events over 176 steps (about
  61 per step); the scripted path is quieter. The level only caps drawing.
- Every window ended with at most 201 buffered events and `evicted: 0`. The
  ring holds 512.
- `usedJSHeapSize` at the end of each window ranged from 4.7 to 10.0 MB, with no
  upward trend across windows.

### 5. Render stress: synthetic topologies through the shipped renderer

This is the real `createTopologyRendererSeam` on a 960×540 CSS px surface. It
is fed fixture snapshots (`provenance: 'fixture'`, a ring lattice with delays
1 to 4) at 50 ms, with 25% of neurons spiking per step, and a 16,384-event
fixture ring. Each case is 4 s after a 0.5 s settle. Times are in ms. Neither
the topologies nor the spikes come from the live adapter.

| run | nodes | edges | events/step | level | DPR | pulses per drawn frame | drawn / skipped | frame work (mean / p95 / max) | frame interval (mean / p95) | spike ingest (mean / p95) |
|---|---:|---:|---:|---|---:|---:|---|---|---|---|
| headless | 16 | 64 | 16 | full | 1 | 47 | 693 / 0 | 0.11 / 0.20 / 0.30 | 5.78 / 6.10 | 0.013 / 0.10 |
| headless | 16 | 64 | 16 | balanced | 1 | 47 | 687 / 0 | 0.10 / 0.20 / 0.40 | 5.83 / 6.10 | 0.013 / 0.10 |
| headless | 16 | 64 | 16 | reduced | 1 | 47 | 115 / 575 | 0.11 / 0.20 / 0.30 | 5.81 / 6.10 | 0.004 / 0.00 |
| headless | 16 | 64 | 16 | minimal | 1 | 0 | 78 / 605 | 0.08 / 0.20 / 0.20 | 5.87 / 6.20 | 0.015 / 0.10 |
| headless | 64 | 512 | 128 | full | 1 | 390 | 692 / 0 | 0.14 / 0.20 / 0.30 | 5.79 / 6.20 | 0.019 / 0.10 |
| headless | 64 | 512 | 128 | balanced | 1 | 256 | 690 / 0 | 0.12 / 0.20 / 0.30 | 5.80 / 6.10 | 0.025 / 0.10 |
| headless | 64 | 512 | 128 | reduced | 1 | 96 | 114 / 570 | 0.11 / 0.20 / 0.30 | 5.85 / 6.10 | 0.018 / 0.10 |
| headless | 64 | 512 | 128 | minimal | 1 | 0 | 77 / 609 | 0.10 / 0.20 / 0.20 | 5.83 / 6.10 | 0.025 / 0.10 |
| headless | 256 | 4,096 | 1,024 | full | 1 | 3,153 | 696 / 0 | 0.37 / 0.50 / 0.90 | 5.75 / 6.10 | 0.094 / 0.20 |
| headless | 256 | 4,096 | 1,024 | balanced | 1 | 256 | 692 / 0 | 0.13 / 0.20 / 0.30 | 5.78 / 6.10 | 0.095 / 0.20 |
| headless | 256 | 4,096 | 1,024 | reduced | 1 | 96 | 114 / 574 | 0.11 / 0.20 / 0.30 | 5.82 / 6.10 | 0.086 / 0.20 |
| headless | 256 | 4,096 | 1,024 | minimal | 1 | 0 | 77 / 605 | 0.09 / 0.20 / 0.20 | 5.87 / 6.10 | 0.089 / 0.20 |
| headless | 1,024 | 32,768 | 8,192 | full | 1 | 15,541 | 698 / 0 | 1.09 / 1.40 / 1.90 | 5.73 / 6.10 | 0.441 / 0.70 |
| headless | 1,024 | 32,768 | 8,192 | balanced | 1 | 256 | 690 / 0 | 0.20 / 0.30 / 0.50 | 5.80 / 6.10 | 0.491 / 0.70 |
| headless | 1,024 | 32,768 | 8,192 | reduced | 1 | 96 | 114 / 572 | 0.16 / 0.30 / 0.40 | 5.83 / 6.10 | 0.441 / 0.70 |
| headless | 1,024 | 32,768 | 8,192 | minimal | 1 | 0 | 77 / 606 | 0.11 / 0.20 / 0.30 | 5.86 / 6.10 | 0.444 / 0.70 |
| headed | 16 | 64 | 16 | full | 2 | 47 | 702 / 0 | 0.11 / 0.20 / 0.30 | 5.70 / 6.10 | 0.019 / 0.10 |
| headed | 16 | 64 | 16 | balanced | 1.5 | 47 | 701 / 0 | 0.11 / 0.20 / 0.30 | 5.70 / 6.10 | 0.008 / 0.10 |
| headed | 16 | 64 | 16 | reduced | 1 | 48 | 115 / 575 | 0.13 / 0.20 / 0.30 | 5.80 / 6.10 | 0.010 / 0.10 |
| headed | 16 | 64 | 16 | minimal | 1 | 0 | 77 / 611 | 0.13 / 0.20 / 0.30 | 5.81 / 6.10 | 0.014 / 0.10 |
| headed | 64 | 512 | 128 | full | 2 | 390 | 699 / 0 | 0.14 / 0.20 / 0.30 | 5.73 / 6.10 | 0.028 / 0.10 |
| headed | 64 | 512 | 128 | balanced | 1.5 | 256 | 701 / 0 | 0.13 / 0.20 / 0.30 | 5.71 / 6.10 | 0.034 / 0.10 |
| headed | 64 | 512 | 128 | reduced | 1 | 96 | 115 / 575 | 0.11 / 0.20 / 0.30 | 5.80 / 6.10 | 0.010 / 0.10 |
| headed | 64 | 512 | 128 | minimal | 1 | 0 | 77 / 615 | 0.12 / 0.20 / 0.30 | 5.79 / 6.10 | 0.021 / 0.10 |
| headed | 256 | 4,096 | 1,024 | full | 2 | 3,154 | 698 / 0 | 0.37 / 0.50 / 0.70 | 5.72 / 6.10 | 0.101 / 0.20 |
| headed | 256 | 4,096 | 1,024 | balanced | 1.5 | 256 | 700 / 0 | 0.14 / 0.20 / 0.30 | 5.73 / 6.10 | 0.096 / 0.20 |
| headed | 256 | 4,096 | 1,024 | reduced | 1 | 96 | 115 / 574 | 0.13 / 0.20 / 0.30 | 5.81 / 6.10 | 0.084 / 0.20 |
| headed | 256 | 4,096 | 1,024 | minimal | 1 | 0 | 77 / 607 | 0.08 / 0.20 / 0.20 | 5.85 / 6.10 | 0.104 / 0.20 |
| headed | 1,024 | 32,768 | 8,192 | full | 2 | 15,515 | 703 / 0 | 1.07 / 1.40 / 2.00 | 5.70 / 6.10 | 0.438 / 0.60 |
| headed | 1,024 | 32,768 | 8,192 | balanced | 1.5 | 256 | 698 / 0 | 0.21 / 0.30 / 0.40 | 5.73 / 6.10 | 0.515 / 0.70 |
| headed | 1,024 | 32,768 | 8,192 | reduced | 1 | 96 | 114 / 571 | 0.17 / 0.30 / 0.40 | 5.84 / 6.10 | 0.495 / 0.70 |
| headed | 1,024 | 32,768 | 8,192 | minimal | 1 | 0 | 78 / 610 | 0.13 / 0.20 / 0.30 | 5.83 / 6.10 | 0.468 / 0.70 |

The frame interval did not move at any size or DPR, so on this machine the
measured cost is main-thread draw time, and it tracks the pulses drawn: at
1024 nodes (headless), 1.09 ms with 15,541 pulses versus 0.20 ms with 256.
Spike ingestion is main-thread work that quality cannot reduce. It scales with
events per step and reaches 0.44 to 0.52 ms at 8,192 events.

### 6. Adaptive quality under load

This run used the 1024-node / 32,768-edge stress, with the controller left
unpinned and Chrome's main thread throttled 20× (headless, same machine), for
20 s.

| Measured | Value |
| --- | --- |
| Level changes | full → balanced at 2,379 ms; balanced → full (upshift) at 9,377 ms; full → balanced at 11,499 ms; no further change |
| Windows judged | 20 (2 downshifts, 1 upshift). Falling back right after the upshift doubled the required relief streak from 5 to 10 windows |
| Last window | p90 interval 12.1 ms, mean draw 3.03 ms per drawn frame: "relief" (stepping up again needs ten in a row) |
| Frame work over the run | p50 3.1, p95 6.6, p99 32.9, max 44.6 ms (2,092 drawn, 0 skipped) |
| Frame interval over the run | p50 6.0, p95 22.3, p99 47.2, max 70.0 ms |
| Spike ingest per step | mean 9.2, p50 8.5, p95 12.4, max 25.5 ms (375 steps) |

The controller stepped down 2.4 s into sustained pressure. It recovered to
full after five relieved windows, fell back about 2 s later, and from then on
needs ten relieved windows before trying again. That is the flap guard
working as designed. Balanced was enough to relieve this run.

The same scenario took different paths in two earlier runs on this machine
the same day, both on earlier revisions of #45's renderer: full → balanced
(2.3 s) → reduced (9.3 s); and full → balanced (2.5 s) → reduced (4.4 s) →
balanced (17.5 s) → reduced (19.5 s). Under 20× throttling this load sits
near the pressure threshold, so the exact path varies from run to run. In
every run, quality changed at most four times in 20 s. Spike ingestion
averaged 9.2 ms per step (median 8.5 ms) at this scale under throttling, and
no quality level touches it. That is why S9 caps topology growth.

### 7. Offscreen and background

These were measured live on the production page. Counters were reset after
each transition and read 3 s later (2 s for the second resume check).

| run | island scrolled out of view | window minimized (`document.visibilityState === 'hidden'`) | after returning |
| --- | --- | --- | --- |
| headless | 0 ticks, 0 frames | 0 ticks, 0 frames | 55 ticks / 495 frames (3 s), 40 ticks / 352 frames (2 s) |
| headed | 0 ticks, 0 frames | 0 ticks, 0 frames | 54 ticks / 484 frames (3 s), 40 ticks / 354 frames (2 s) |

"Hidden" is a real minimize through CDP `Browser.setWindowBounds`, not a
simulated event. `test/offscreen-pause.test.mjs` covers the same wiring in
`npm test`: the `IntersectionObserver` threshold, `visibilitychange`, resume,
and dispose. It uses the real fixed-cadence WASM seam.

### 8. Startup and payload

The payload is the production build that the live runs above used,
compressed by Node's zlib in the harness (gzip level 9, brotli quality 11).
The harness serves files uncompressed; production hosting is not configured.

| file | bytes | gzip | brotli | loaded |
| --- | ---: | ---: | ---: | --- |
| `three.module.*.js` | 746,881 | 191,104 | 155,725 | lazily, when the island goes live |
| `neuromorphic_adapter_bg.wasm` | 189,316 | 67,935 | 56,459 | lazily, in the worker |
| `NeuromorphicDemo…js` (island entry) | 55,865 | 17,418 | 15,482 | with the page |
| `neuromorphic_adapter.js` (glue) | 17,150 | 3,161 | 2,798 | lazily, in the worker |
| `neuromorphic-worker-*.js` | 12,105 | 3,740 | 3,291 | lazily |
| **total** | 1,021,317 | 283,358 | 233,755 | |

Marks are in ms since navigation start, on localhost with a fresh profile:

| run | island script ran | renderer ready | first frame | first snapshot |
| --- | ---: | ---: | ---: | ---: |
| headless | 67.6 | 205.4 | 218.2 | 275.7 |
| headed | 32.5 | 366.3 | 378.7 | 436.7 |

"First snapshot" includes the first 50 ms tick interval.

## Simulation versus rendering

- **At the shipped size (16 / 64), neither is a bottleneck.** The largest
  per-step cost is messaging: the worker round trip takes 66.5 to 72.2 µs, and
  the bridge 12 to 13 µs, both of which happen off the render path. Inside WASM,
  when at least 15 LIF neurons fire per tick, the `neuromod` step is 68 to 73% of
  `input` + `step` natively and 78 to 83% under WASI. Rendering takes 0.1 ms of
  CPU per frame.
- **Growth hits the simulation first.** The LIF bank is quadratic: 0.8 to
  0.9 ms per WASM step at 256 neurons, 12 to 13 ms at 1024, and over 50 ms at
  2048. Rendering the same synthetic sizes stays under 2 ms p95 per frame at
  full quality. Two costs grow with the simulation and are not adaptive:
  main-thread spike ingestion (0.44 to 0.52 ms per step at 8,192 events), and the
  contract-5 snapshot re-sending the full topology every step (~0.97 MB at
  1024 neurons).
- **Quality controls only help rendering**, which is the intent. They never
  change what is simulated.

## Adaptive quality

`src/runtime/adaptive-quality.ts` keeps one controller per island, created in
`live-seams.ts` and passed only to the renderer seam.

| level | name | DPR cap | pulses drawn | frame cap | telemetry refresh |
| ---: | --- | ---: | --- | --- | --- |
| 0 | full | 2 | all buffered (ring capacity) | every animation frame | every step (50 ms) |
| 1 | balanced | 1.5 | 256 | every animation frame | every 2 steps (100 ms) |
| 2 | reduced | 1 | 96 | 30 fps | every 4 steps (200 ms) |
| 3 | minimal | 1 | 0 (off) | 20 fps (one per step) | every 10 steps (500 ms) |

- **Signal.** The renderer reports every animation-frame callback: the interval
  since the previous one, and its own draw time (0 when the frame cap skipped
  drawing). Windows of at least 1 s and 10 frames are judged on their p90
  interval and mean draw time, against the thresholds in R3. Intervals over
  1 s, such as a resume or a stall, reset the window instead of counting.
- **What never adapts.** The 50 ms tick, the input packets (pointer or scripted),
  the WASM session, and the spike-event buffer (every event is still buffered and
  delivered to subscribers) are outside the controller.
  `test/performance-semantics.test.mjs` runs the shipped WASM seam on the real
  WASM package for 200 ticks, in every encoder mode, with scripted and pointer
  input. It runs once plainly and once with the controller under synthetic frame
  pressure and pinned level changes, plus a pulse-cap reader, a cadence sampler,
  and the perf probe. Snapshots, spike batches, and the recorded trace must be
  byte-identical. For the shipped temporal mode, the trace must also replay from
  `init` to the same snapshots. The same file statically checks that no
  simulation-path module imports `adaptive-quality`.
- **Not adapted:** node count, which belongs to the simulation contract, and
  simulation frequency. Changing the tick period would change which pointer
  positions are latched, and with them the outputs, and it would break the
  `d × 50 ms` delay mapping.
- **Telemetry cadence API (for #9 and #13).** The island carries
  `data-demo-quality` (`full`, `balanced`, `reduced`, or `minimal`) and
  `data-demo-telemetry-cadence-ms`. In code, `renderer.quality` on the live
  seams is the controller's read side (`current()`, `subscribe()`, `stats()`),
  and `shouldSampleTelemetry(step, cadenceSteps)` picks the same simulation
  steps for every consumer. `telemetryCadenceMs(settings)` converts the cadence
  to milliseconds. Cadence is keyed to steps, never to frames.
- **Inspection.** Under `astro dev`, or on any build with `?neuromorphic-perf`,
  `globalThis.__neuromorphicPerf` exposes `summary()`, `reset()`, `quality()`,
  `forceQuality(level | null)`, `renderer()`, and `spikeEvents()`. Without the
  flag no probe exists, and each instrumented site is a single null check. The
  only always-on cost is two `performance.now()` calls per animation frame,
  which feed the controller.

## Buffer audit

Every buffer on the simulation, transfer, telemetry, and renderer paths, and
its bound:

| Path | Buffer | Bound | Status |
| --- | --- | --- | --- |
| Rust adapter | `pending_source_spikes`, `last_spikes`, `encoder_features` | 16 entries each, replaced every step | bounded |
| Rust adapter | topology arrays and `TopologyProjection` | fixed at construction (17 offsets, 64 edges) | bounded |
| `kinetic-signals` | `KineticExtractor` EMAs and `VolEstimator` | scalars, plus one 16-slot ring | bounded |
| `axon-encoder` | delta `last_values`, temporal `history`, rate `phases` and `pending_spikes` | 16 per channel; temporal pops at depth 6; the rate backlog is a saturating counter with capped emission per step | bounded |
| `synaptic-wiring` | `SpikeDelayBuffer` | ring of neurons × (max delay + 1) = 16 × 5 | bounded |
| `neuromod` | weights, eligibility, `predictive_state`, `input_spike_times` | 16 × 16 and 16; no history kept | bounded |
| WASM ↔ JS | `WasmState` handle per step | was freed only by `FinalizationRegistry`, growing until a GC ran: 13.6 MB per 5000 steps, 477 MB in a long benchmark | **fixed:** freed right after reading (+0 B per 5000 steps) |
| Bridge | routed-topology verification cache | one entry (8 small arrays) | bounded |
| Worker engine | `pending` request map | at most one tick in flight (the driver's `inFlight` guard); cleared on failure | bounded |
| Simulation channel | latest snapshot plus listener set | one snapshot | bounded |
| Telemetry | `createTelemetryRecorder` | 6000 ticks (5 min), then it stops and `trace()` returns `null` | bounded |
| Telemetry | pointer telemetry, `latestFrame`, dev inspectors | latest packet or frame only; `recent(limit)` slices | bounded |
| Probe (opt-in) | per-stage samples, counters, marks | `Float64Array(2048)` ring per stage; fixed names | bounded |
| Adaptive quality | window samples, listeners | `Float64Array(512)`; one listener per subscriber | bounded |
| Spike events | `SpikeEventBuffer` ring | 512 events, retired one step after arrival, cleared on pause and dispose | bounded |
| Renderer | pulse vertex attributes | preallocated: 512 × 6 vertices × 7 floats ≈ 86 KB | bounded |
| Renderer | node and edge geometry | were appended to `disposables` on every topology rebuild | **fixed:** only the current pair is held |
| Renderer | `spikeFlash` map | keyed by neuron id; now cleared on rebuild | **fixed** (was bounded only by the largest topology seen) |
| Renderer | device-pixel-ratio media-query listener | the old inline version added a listener on each DPR change without removing the previous one | **fixed:** `watchDevicePixelRatio` keeps exactly one (tested) |
| Renderer | `ResizeObserver`, three.js resources | one per session, released on dispose | bounded |
| Runtime and binding | snapshot listeners, DOM listeners, `IntersectionObserver` | removed on dispose (tested) | bounded |

## Reproducing

```bash
npm ci

# 1. Rust per-stage and synthetic scaling (native)
npm run perf:stages            # add `-- --json` for JSON, `-- --quick` for a smoke run

# 2. The same harness as WASM, executed by Node's V8
rustup target add wasm32-wasip1 --toolchain 1.98.1
cargo +1.98.1 build --release --locked --target wasm32-wasip1 \
  --manifest-path crates/neuromorphic-adapter/Cargo.toml --example stage_bench
node scripts/perf/run-wasi-stage-bench.mjs \
  crates/neuromorphic-adapter/target/wasm32-wasip1/release/examples/stage_bench.wasm

# 3. WASM ↔ JS boundary in Node (committed package, shipped bridge)
npm run perf:boundary          # `-- --json`, `-- --ticks N --repeats N`, `-- --bridge <file.ts>`

# 4. Chrome: live page, boundary (with the real worker), render stress
npm run build
npm run perf:browser -- --browser "<path to chrome>" --seconds 8 --out headless.json
npm run perf:browser -- --browser "<path to chrome>" --headed --seconds 8 --out headed.json
npm run perf:browser -- --browser "<path to chrome>" --skip-live --skip-bench --skip-stress --cpu-throttle 20
#    Compare a bridge revision (the "before" rows):
git show <rev>:src/runtime/neuromorphic-adapter.ts > /tmp/bridge-before.ts
npm run perf:browser -- --browser "<path to chrome>" --skip-live --skip-stress --bridge /tmp/bridge-before.ts

# 5. By hand: open http://localhost:4321/?neuromorphic-perf after `npm run preview`
#    and call __neuromorphicPerf.summary() / .forceQuality(2) in the console.
```

All of these depend on the machine and run for minutes. None runs in `npm test`
or CI. `npm test` covers the deterministic parts instead: the quality state
machine and probe (`test/adaptive-quality.test.mjs`), output equivalence and
the bridge transfer path (`test/performance-semantics.test.mjs`), offscreen
pausing (`test/offscreen-pause.test.mjs`), and a smoke run of the boundary
harness (`test/perf-harness.test.mjs`). Coverage excludes `scripts/perf/**` and
`crates/**/examples/**`.

## Not measured

- **Mobile and low-end hardware.** No phone, tablet, or integrated-GPU laptop
  was available. The low-end targets in S2 and R2 are design decisions only. The
  20× CPU throttle throttles Chrome's page main thread on a desktop. It is not
  a mobile device, and it is not established here whether it slows workers.
- **Other browsers.** Firefox, Safari, and Edge were not run.
- **GPU time.** `EXT_disjoint_timer_query_webgl2` is present. In an earlier
  headless run on this machine (before rebasing onto the current #45 head),
  per-frame values from a wrapped animation frame did not track the workload:
  0.003 ms per drawn frame with 15,523 pulses at 1024 nodes, but 0.85 ms with
  pulses off. So no GPU time is published. The harness keeps the
  wrapper behind `--gpu-timer` for future validation. GPU pressure is visible
  only through the frame interval, which never moved here.
- **Display-locked pacing.** Chrome's frame cadence was about 170 to 180 Hz in
  both modes on a 239 Hz display. Frame budgets at 60 Hz and 120 Hz were not
  measured on real panels.
- **Telemetry panel DOM cost (#9).** The panel is not built yet. Today the only
  per-tick telemetry work is the `onFrame` hook (`telemetry` stage, mean 0.0012
  to 0.0062 ms, from samples quantized at 0.1 ms). #9 should measure its panel
  with the probe at each cadence.
- **Network.** Assets were served from localhost without compression or CDN
  latency. Hosting is not configured (`README.md`).
- **Power and thermals.** Battery, thermal throttling, and long sessions over
  10 minutes were not measured.
- **Worker-side breakdown in the live page.** The live probe sees worker ticks
  as round trips. The in-worker split comes from the microbenchmarks
  (sections 1 and 3).

## Follow-ups this data suggests

- A future contract version could send the static topology projection once,
  not in every snapshot. It is 91% of each snapshot's bytes today, and that
  share grows with topology size. This would change the contract, so it needs a
  new contract version (see `browser-runtime.md`).
- Before shipping more than ~256 neurons, the spike-event ring capacity
  (sized for 64 edges × 5 steps) and main-thread ingestion need their own
  budget; quality cannot reduce either.
