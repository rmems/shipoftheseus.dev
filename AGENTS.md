# AGENTS.md

Guidance for coding agents (Amp, Codex, Cursor, Claude Code, and others) working in this repository.

## Purpose

`shipoftheseus.dev` is a static Astro + TypeScript portfolio for AI/ML systems engineering (see
`README.md`). It includes live WASM demos backed by a small Rust crate
(`crates/neuromorphic-adapter`). It is local-only until explicitly approved for deployment, and the
repo has no deployment workflow.

## Layout

| Path | Contents |
|------|----------|
| `src/pages/`, `src/components/`, `src/layouts/`, `src/styles/` | Astro site |
| `src/data/site.ts`, `src/data/projects.ts` | Site identity (profile links, contact, résumé path); project cards and briefs |
| `src/content/notes/` | Markdown notes (`src/content.config.ts`) |
| `src/content/native-evidence/` | Recorded CUDA/FPGA evidence as versioned JSON artifacts (`CONTENT.md`) |
| `src/runtime/`, `src/native-evidence/` | Browser runtime for WASM demos; native-evidence parser, loader, catalog and view code |
| `crates/neuromorphic-adapter/` | Rust → `wasm32-unknown-unknown` adapter (own `Cargo.lock`, `rust-toolchain.toml`) |
| `scripts/verify-*.mjs` | WASM adapter, browser and browser-dependency verification |
| `test/*.test.mjs` (+ `test/fixtures/`) | `node --test` suite |
| `docs/coverage-and-quality.md` | Codecov/Qlty coverage, CI secrets, local `npm run coverage` |
| `docs/architecture/` | Browser runtime and native-evidence architecture |
| `CONTENT.md` | Publishing checklist |

## Toolchain

- Node: `engines` `^20.19.0 || >=22.12.0`; CI uses **22.12.0**. Install with `npm ci` (lockfile committed).
- Rust **1.98.1** with target `wasm32-unknown-unknown` (crate `rust-toolchain.toml`, quality.yml),
  plus rustfmt and clippy.
- `wasm-bindgen-cli` **0.2.126** (`cargo install wasm-bindgen-cli --version 0.2.126 --locked`).
- A Chrome/Chromium binary for the browser check. CI sets `BROWSER_BIN` from `setup-chrome`.

## Commands (from `.github/workflows/quality.yml` and `package.json`)

```bash
npm ci
npm run dev                 # local dev server (http://localhost:4321)

# Full gate, as in CI: test, lint, typecheck, build, Rust checks, WASM adapter + browser checks, layout check
WASM_BINDGEN_BIN="$(command -v wasm-bindgen)" BROWSER_BIN="<path to chrome>" npm run validate

# Pieces
npm test                    # node --test test/**/*.test.mjs
npm run coverage            # c8 (scripts) + cargo llvm-cov (neuromorphic-adapter) → coverage/
npm run lint                # eslint .
npm run typecheck           # astro check
npm run build               # astro build
npm run validate:rust       # cargo +1.98.1 fmt/clippy/test/check (wasm32) on crates/neuromorphic-adapter
npm run test:layout         # built pages at 320–1024 px, 100%/200% text: no horizontal scroll (needs dist/, BROWSER_BIN)
```

## Conventions visible in the repo

- Don't add deployment/hosting configuration. The README says the site is local-only until
  deployment is explicitly approved, and out-of-scope hosting config was removed (#28).
- Use `CONTENT.md` as the checklist before publishing content changes. In `src/data/site.ts` the
  GitHub, LinkedIn and Hugging Face links are live; `email` is still `null` until a public address is
  chosen. Don't invent benchmark numbers for native evidence; leave the catalog empty without a
  measured capture.
- Rust checks pin `cargo +1.98.1`. clippy, test and check also pass `--locked`; `cargo fmt` doesn't
  take that flag.
- Commit subjects mostly follow Conventional Commits with scopes (`feat(wasm):`, `ci(web):`) and
  the PR number.
