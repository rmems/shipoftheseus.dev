# Publishing handoff

Before publishing, update `src/data/site.ts`:

- Set `email` from `null` to your public contact email.
- GitHub, LinkedIn, and Hugging Face profile links are now live. Review them before publishing.
- Put your real résumé PDF at `public/resume.pdf`, then set `resumePath` to `/resume.pdf`; the résumé page will expose the link.

For project cards, edit `src/data/projects.ts`. Add public links only when each repository, case study, or demo is ready to share. The included summaries intentionally avoid performance claims and invented outcomes.

`public/assets/social-card.png` is a local placeholder social image. Replace it later with a final branded card if desired.

## Domain safety

The portfolio is designed for `shipoftheseus.dev` and, if you choose, `www.shipoftheseus.dev`. `hooks.shipoftheseus.dev` is explicitly out of scope: it remains the active PR-babysit GitHub-webhook Cloudflare Tunnel endpoint and must not be redirected, deleted, or otherwise changed for this site.
