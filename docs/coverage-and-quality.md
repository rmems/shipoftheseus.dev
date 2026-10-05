# Coverage and quality services (RM-2009)

This repository uses **Codecov** for test coverage reporting and **Qlty** for
GitHub Actions workflow linting, maintainability analysis, and a secondary
coverage mirror. The existing **Quality** workflow (`quality.yml`) still runs
`npm run validate` (tests, lint, typecheck, build, Rust/WASM checks).

## What runs where

| Service | Role | CI job |
| --- | --- | --- |
| **Codecov** | Primary coverage dashboard: default-branch baseline, PR diffs, optional comments | `coverage-report` job in `.github/workflows/quality.yml` (after `validate` passes) |
| **Qlty Cloud (coverage)** | Same LCOV uploads as Codecov for teams using Qlty’s coverage UI; not a second source of truth | `coverage-report` job (token or OIDC upload) |
| **Qlty CLI** | `actionlint` on workflows; duplication/complexity smells (comment mode) | end of `coverage-report` job |
| **Qlty `qlty check`** (GitHub App) | Static analysis on the PR diff; **not** coverage | Qlty GitHub integration (separate from this workflow) |
| **ESLint / Clippy / fmt** | Authoritative linters for JS/TS and Rust | `quality.yml` |

Qlty does **not** replace ESLint, `astro check`, or Rust fmt/clippy.

## Coverage inputs

CI generates two LCOV files:

1. **Rust** — `cargo llvm-cov --all-targets --locked` on
   `crates/neuromorphic-adapter` (library, integration tests, WASM target code
   paths exercised on the host).
2. **Node** — `c8` over `node --test test/**/*.test.mjs`, attributing coverage
   to `scripts/**/*.mjs` (verification harnesses).

TypeScript under `src/` is exercised by tests via on-the-fly transpilation
(`test/load-ts-module.mjs` data URLs). V8 coverage does not attribute those
lines to `src/**` today; Rust and the Node scripts are the measurable baseline.
Expanding TS coverage would require a different test loader or build step.

### Local baseline (2026-10-05)

After `npm run coverage` on Linux with Rust **1.98.1** and `cargo-llvm-cov`:

- **neuromorphic-adapter** — about **72%** line coverage (all targets, locked).
- **scripts/** (c8) — about **52%** statement coverage.

Hosted Codecov percentages may differ until the default branch has uploaded at
least once.

## Exclusions

Explicit ignores are listed in:

- `.github/codecov.yml` (`ignore`)
- `.qlty/qlty.toml` (`[coverage].ignores` and `exclude_patterns`)
- `.c8rc.json` (Node report scope)

Generated WASM under `public/wasm/`, build output (`dist/`, `.astro/`), tests,
fixtures, and dependencies are excluded.

## Local commands

```bash
npm ci
# Install once: cargo install cargo-llvm-cov --locked
npm run coverage
```

Reports land in `coverage/rust.lcov` and `coverage/lcov.info` (gitignored).

## CI secrets and fork pull requests

| Secret | Required? | Purpose |
| --- | --- | --- |
| `CODECOV_TOKEN` | Recommended | Upload from Actions; name must be exactly `CODECOV_TOKEN` |
| `QLTY_COVERAGE_TOKEN` | Optional | Qlty coverage upload when OIDC is not configured; otherwise OIDC is used |

- **Same-repository PRs / `main` pushes** — If `CODECOV_TOKEN` is unset, Codecov
  upload uses OIDC when the action supports it. Upload failures fail the job.
- **Fork PRs without `CODECOV_TOKEN`** — Upload is skipped with a warning; LCOV
  artifacts are still retained for 14 days. Do not add tokens to fork workflows.
- **Qlty coverage upload** — Skipped for fork PRs and Dependabot (no OIDC path
  for untrusted forks). Qlty CLI checks still run on every PR.

Repository admins must connect the repo in [Codecov](https://codecov.io) and
[Qlty Cloud](https://qlty.sh) and enable GitHub integration so checks appear on
pull requests.

### Why Codecov / Qlty coverage checks may be missing on a PR

GitHub **secrets do not create checks by themselves**. Codecov and Qlty coverage
statuses appear only after a workflow **successfully uploads** LCOV for that
commit.

1. **`validate` must pass** — the `coverage-report` job is skipped if `validate`
   fails or never starts (for example hosted-runner queue timeouts).
2. **Look for the Actions job** `coverage report and uploads` — if it is absent,
   skipped, or red, uploads did not complete; Codecov/Qlty will not post checks.
3. **`qlty check` is not coverage** — the passing Qlty check on many PRs comes
   from the Qlty GitHub App analyzing the diff, not from the coverage upload step.
4. **Codecov GitHub App** — the app must be installed **and** CI must upload LCOV for
   the commit. The app does not scan the repo by itself; it reacts to uploads from
   the `coverage report and uploads` job. `CODECOV_TOKEN` (or OIDC) performs the
   upload; the app posts PR checks and comments. If the app is already installed but
   checks are missing, open [Codecov → shipoftheseus.dev → Commits](https://app.codecov.io/gh/rmems/shipoftheseus.dev)
   and confirm the PR head SHA appears after a green upload job.
5. **First `main` upload** — patch/project checks need a baseline on the default
   branch; merge or push a green `coverage-report` run on `main` once.

## Codecov status gates

`.github/codecov.yml` sets project and patch statuses to **informational**
with `target: auto` until a stable hosted baseline exists. They are not merge
blockers unless branch protection is changed explicitly.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Missing Codecov check | `CODECOV_TOKEN` or OIDC; fork PR may skip upload |
| `cargo llvm-cov` not found | `cargo install cargo-llvm-cov --locked` with Rust 1.98.1 |
| Empty `coverage/lcov.info` | Run `npm run test:coverage` after `npm ci` |
| Qlty workflow lint fails | Run `qlty check --all --no-formatters` locally after `qlty install` |
| Quality workflow red | Fix `npm run validate` first; coverage is a separate workflow |
