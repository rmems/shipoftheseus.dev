# Native CUDA and FPGA evidence (ADR-0002)

- **Status:** accepted as a V2 isolated recorded-evidence surface outside the V1 critical path
- **Decision date:** 2026-09-16
- **Scope:** GitHub #18 / Linear RM-1655 · `/evidence/` catalog only; not on the V1 homepage

## Decision

Native-only `myelin-accelerator` CUDA execution and FPGA/SNN hardware paths are represented as **versioned, machine-readable artifacts**. They are ingested at build time, labeled `RECORDED · CUDA/FPGA`, and never compiled, imported, or executed in the browser bundle.

The neuromorphic island may show `LIVE · Rust/WASM` only after a verified adapter-backed runtime is actually running. Static HTML, missing adapters, failed WASM, and reduced-motion/awaiting-play states use `STATIC · diagram` or `UNAVAILABLE · Rust/WASM`. Recorded CUDA and FPGA captures live on `/evidence/` as `RECORDED · CUDA/FPGA`. The homepage demo and primary navigation may link there; they must not ingest or render the catalog, and the UI must not imply that CUDA, FPGA tooling, native IPC, ZeroMQ, HDF5, or hardware runtimes run in WebAssembly.

## Artifact envelope

Published files live in `src/content/native-evidence/` and must parse as `shipoftheseus.native-evidence` schema version 1. The ingest is fail-closed:

| Input | Behavior |
| --- | --- |
| Missing or empty catalog directory | Build succeeds. UI shows the empty recorded-evidence state. |
| Valid measured artifacts | Render provenance, workload, hardware, units, capture method, and results/traces. |
| Invalid JSON, unknown fields, missing provenance, missing capture method on measured artifacts, or filename/id mismatch | Build fails. No partial catalog is shown. |
| Catalog discovery exceeds directory depth, JSON file count, or aggregate byte limits | Fail as `catalog-limit-exceeded`. |
| Filesystem errors while listing, stating, or reading the catalog | Fail as `catalog-io-error`. No partial catalog is shown. |
| Catalog root is a symlink, or a catalog JSON path is a symlink or non-regular file | Fail as `catalog-io-error`. Discovery never follows links out of the catalog. |
| `schemaVersion` other than `1` | Fail as `unsupported-version`. |
| `recordStatus: "synthetic"` in the published catalog | Fail as `synthetic-not-publishable`. |

Synthetic fixtures may exist under `test/fixtures/native-evidence/` to cover the parser. They are not site content and must not be copied into the published catalog.

A raw `myelin-accelerator` `benchmark_results.json` document is not an evidence artifact by itself. It must be wrapped in this envelope with source repository, exact revision, capture command, hardware identity, and explicit units before publication.

## Browser boundary

The evidence page is static Astro. It reads JSON through Node during the site build. It must not depend on:

- `myelin-accelerator` or `myelin-accelerator/cuda`
- `cust`, NVCC, or CUDA runtimes
- FPGA/HDL toolchains
- `corpus-ipc/zmq`, `corpus-ipc/server`, or other native IPC
- `nir-rs/hdf5`

Those names belong in provenance strings and documentation, not in `package.json` or client modules.

## Honesty

Empty evidence is a valid, preferred state until a measured capture exists. Invented numbers, example latencies, or marketing claims must not be checked in as recorded hardware results. The UI renders workload names, descriptions, and parameters, and a bounded display-safe capture method. Raw `captureCommand` text stays in the versioned artifact and is never copied into public HTML.
