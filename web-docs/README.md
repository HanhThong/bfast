# BFAST documentation site

The user documentation for BFAST, built with [Docusaurus](https://docusaurus.io/).

- `docs/` — the pages. `sidebars.ts` is the table of contents; a new page must be added there.
- `src/pages/index.tsx` — the landing page.
- The feature specifications the pages are written from live in the repository's own `docs/`
  folder. When a spec changes, the matching guide here changes with it.

```bash
npm install
npm start        # local dev server with live reload
npm run build    # static site into build/ — fails on a broken link
npm run serve    # serve the build locally
```

The site's address comes from the `DOCS_URL` and `DOCS_BASE_URL` environment variables at build time
(defaults: `http://localhost:3000` and `/`).

## Deploying and releases

The site is served by a [Cloudflare Worker](https://developers.cloudflare.com/workers/static-assets/)
with static assets only (`wrangler.jsonc`): the files `npm run build` writes, plus `static/_headers` for
caching.

The **Docs** workflow checks every change to `web-docs/` and uploads every commit on `master` as a
preview version of the Worker. Every extension release (a `v1.2.0` tag) deploys the site to production with it, and a
`docs-v1.2.1` tag deploys the documentation alone. [RELEASING.md](./RELEASING.md)
is the guide.
