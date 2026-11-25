# Releasing the documentation site

The documentation site is served by a **Cloudflare Worker with static assets only**
([`wrangler.jsonc`](./wrangler.jsonc)): no code runs, the files Docusaurus builds are uploaded by the
workflows with Wrangler and served as they are. Cloudflare builds nothing itself. Two kinds of upload:

- **Preview version** (`wrangler versions upload --preview-alias <branch>`): stored beside the live one,
  reachable only at its own preview address — `https://master-bfast.<subdomain>.workers.dev` for the
  latest `master` — and never served at the site's address.
- **Deployment** (`wrangler deploy`): becomes what the site serves, at `DOCS_URL`. Only a release does it.

Three workflows upload:

| Workflow | Runs on | Does |
|---|---|---|
| [`docs.yml`](../.github/workflows/docs.yml) | A pull request or a push to `master` touching `web-docs/`, or by hand | Checks and builds the site. On `master` and by hand it uploads the build as a **preview version** named after the branch (`https://master-bfast.<subdomain>.workers.dev`) and checks it answers. A pull request deploys nothing. |
| [`release.yml`](../.github/workflows/release.yml) | A pushed tag `v*` — an **extension** release | Tests and packages the extension, runs `docs.yml` on the tagged commit and deploys it to **production**, then creates the extension's GitHub Release. See [RELEASING.md](../RELEASING.md). |
| [`docs-release.yml`](../.github/workflows/docs-release.yml) | A pushed tag `docs-v*` | Runs `docs.yml` again on the tagged commit, deploys it to **production**, then creates the GitHub Release. |

**Every extension release deploys the documentation with it**, so the live site always matches the
latest extension and there is nothing to do here for an ordinary release. A `docs-v1.2.1` tag is for
the documentation alone — a correction or a new guide between two extension versions.

## One-time setup

Done once per repository by whoever administers it.

1. **The Worker.** The site deploys to the Worker named in `wrangler.jsonc` (`bfast`). It may already
   exist — created in the dashboard — or not: the first deploy creates it, and a deploy replaces whatever
   it served before with the site. A Worker named otherwise goes into the repository variable
   `CLOUDFLARE_WORKER_NAME` below. For preview versions, its **workers.dev** address and **Preview URLs**
   must be on (**Workers & Pages → bfast → Settings → Domains & Routes**); they are by default.
2. **A Cloudflare API token** with the **Account → Workers Scripts → Edit** permission, on the account
   the Worker is in (**My Profile → API Tokens → Create Token → Create Custom Token**, or the *Edit
   Cloudflare Workers* template). Add it, and the account id (on the dashboard's **Workers & Pages**
   overview), as repository secrets (**Settings → Secrets and variables → Actions → Secrets**):

   | Secret | Holds |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | The API token. |
   | `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account id. |

3. **Where the site is published**, as repository variables (**Settings → Secrets and variables →
   Actions → Variables**):

   | Variable | Example | Required |
   |---|---|---|
   | `DOCS_URL` | `https://bfast.hanhthong.me` | Yes for a release. Without it, other builds warn and name localhost. |
   | `DOCS_BASE_URL` | `/` | Only when the site is served under a path, such as `/bfast/`. Starts and ends with `/`. |
   | `CLOUDFLARE_WORKER_NAME` | `bfast` | Only when the Worker is not named `bfast`. |

   `DOCS_URL` and `DOCS_BASE_URL` go into every page's canonical link and into `sitemap.xml`, so they
   are baked into the build: changing them takes a new deployment. A release checks the site at
   `DOCS_URL` once deployed.
4. **The custom domain**: on the Worker, **Settings → Domains & Routes → Add → Custom domain**, the same
   address as `DOCS_URL`. It is set once in the dashboard and a deploy leaves it alone, since
   `wrangler.jsonc` declares no route.

## Day to day

Nothing to do. Open a pull request that changes `web-docs/`: the **Docs** check builds the site and
fails on a broken link or anchor or a type error. Merge it, and `master` is uploaded as a preview version, ready
to try before releasing: the run's summary names its address
(`https://master-bfast.<subdomain>.workers.dev`).

Changes outside `web-docs/` do not run the docs workflow, and changes inside it do not run the
extension's test suite.

## Release a docs-only version

1. **Make sure `master` holds what you want to publish** and that its last **Docs** run passed.
2. **Pick the version.** Bump the major for a reorganisation that moves pages (old links break), the
   minor for new pages or a newly documented feature, the patch for corrections. A pre-release adds a
   suffix: `docs-v1.3.0-rc.1`.
3. **Tag the commit and push the tag:**

   ```bash
   git checkout master
   git pull
   git tag docs-v1.2.0
   git push origin docs-v1.2.0
   ```

4. **Watch the run** under **Actions → Docs release**. It checks, in this order, before deploying anything:
   - the tag is `docs-v<major>.<minor>.<patch>` with an optional suffix,
   - the tagged commit is on `master`,
   - no GitHub Release exists for the tag yet,
   - `DOCS_URL` is set,
   - `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set.

   Then the site is built on the tagged commit and deployed, and checked at `DOCS_URL`: the landing
   page, a guide and a screenshot answer, and a missing page answers 404. A pre-release is uploaded as
   a preview version instead and never reaches the live site.
5. **The GitHub Release appears last**, titled `Docs docs-v1.2.0`, naming the site and the deployment,
   with notes generated from the pull requests merged since the previous `docs-v*` tag.

### When a release fails

A run that fails before the GitHub Release leaves none behind. Fix the cause, then **Re-run failed
jobs** on the same run; no new tag is needed. If the fix needs a new commit, delete the tag and tag the
new commit:

```bash
git push origin :refs/tags/docs-v1.2.0
git tag -f docs-v1.2.0 <new commit>
git push origin docs-v1.2.0
```

A version that already has a GitHub Release is never released again. Release the next patch instead.

### Roll back

Every version stays on the Worker. To put a previous one back live without a new tag:
**Workers & Pages → bfast → Deployments**, pick the version, and **Deploy version** — or from
`web-docs/`, `npx wrangler rollback`.

## Deploy by hand

From `web-docs/`, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment (or after
`npx wrangler login`):

```bash
DOCS_URL=https://bfast.hanhthong.me npm run build
npx wrangler@4 versions upload --preview-alias my-preview
```

That makes a preview at `https://my-preview-bfast.<subdomain>.workers.dev`. `npx wrangler@4 deploy`
instead replaces the live site outside a release.

## Caching

[`static/_headers`](./static/_headers) is copied to the root of the build, where the Worker reads it:
content-hashed files under `/assets/` are cached for a year and screenshots under `/img/` for a day.
Pages themselves are revalidated on every visit, so a new deployment shows at once. Docusaurus's own
`404.html` is served, with a 404, for a page that does not exist (`not_found_handling` in
`wrangler.jsonc`).

## Screenshots

The screenshots under `static/img/screens/` are taken from a real VS Code running BFAST, not generated
at build time. Retake the affected ones when a release changes the UI they show, before tagging.
