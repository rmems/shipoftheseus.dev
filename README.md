# shipoftheseus.dev

A static Astro + TypeScript portfolio for AI/ML systems engineering. It is local-only until explicitly approved for deployment.

## Local development

```bash
npm install
npm run dev
```

Then open the local URL Astro prints (normally `http://localhost:4321`).

## Checks

```bash
npm run validate
```

The validation command runs content/route contracts, linting, Astro type checks, a production build, and the locked Rust/WASM adapter checks. Before running it locally, install Rust 1.98.1 with the `wasm32-unknown-unknown` target, `wasm-bindgen-cli 0.2.126`, and a local Chrome or Chromium executable. Supply absolute executable paths for the browser smoke check:

```bash
WASM_BINDGEN_BIN="$(command -v wasm-bindgen)" BROWSER_BIN="$(command -v google-chrome)" npm run validate
```

Pull requests provision these dependencies and run the same command in CI; no deployment workflow is included.

## Content and assets

- Site-wide identity, social URL placeholders, email placeholder, and résumé path: `src/data/site.ts`
- Project cards and work-page briefs: `src/data/projects.ts`
- Markdown notes: `src/content/notes/`
- Publishing checklist: `CONTENT.md`
- Browser renderer, Rust/WASM boundary, compatibility policy, and crate audit: `docs/architecture/browser-runtime.md`
- Native CUDA/FPGA evidence schema and ingest: `docs/architecture/native-evidence.md`
- Favicon: `public/favicon.svg`
- Social-card placeholder: `public/assets/social-card.png`

## Cloudflare Pages (when explicitly approved)

Connect the dedicated `shipoftheseus.dev` repository in Cloudflare Pages, then use:

- Build command: `npm run build`
- Build output directory: `dist`
- Node.js: 20.19+ or 22.12+

Point only `shipoftheseus.dev` and optionally `www.shipoftheseus.dev` at this Pages project. Do **not** modify `hooks.shipoftheseus.dev`: it is a separately active GitHub-webhook Cloudflare Tunnel endpoint, outside this portfolio's scope.

No custom-domain attachment, redirect, or deployment configuration is committed. Those remain explicit release actions after the site and domain plan are approved.
