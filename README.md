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
npm test
npm run lint
npm run typecheck
npm run build
```

## Content and assets

- Site-wide identity, social URL placeholders, email placeholder, and résumé path: `src/data/site.ts`
- Project cards: `src/data/projects.ts`
- Markdown notes: `src/content/notes/`
- Publishing checklist: `CONTENT.md`
- Favicon: `public/favicon.svg`
- Social-card placeholder: `public/assets/social-card.png`

## Cloudflare Pages (when explicitly approved)

Connect the dedicated `shipoftheseus.dev` repository in Cloudflare Pages, then use:

- Build command: `npm run build`
- Build output directory: `dist`
- Node.js: 20.19+ or 22.12+

Point only `shipoftheseus.dev` and optionally `www.shipoftheseus.dev` at this Pages project. Do **not** modify `hooks.shipoftheseus.dev`: it is a separately active GitHub-webhook Cloudflare Tunnel endpoint, outside this portfolio's scope.
