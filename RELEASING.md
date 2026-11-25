# Releasing the extension

Pushing a version tag on a commit of `master` releases BFAST **and its documentation site together**:
the [`release.yml`](.github/workflows/release.yml) workflow tests the tagged commit, builds
`bfast-<version>.vsix`, deploys the documentation of that same commit to its Cloudflare Worker, and creates
the GitHub Release with the VSIX attached. Nothing is published to the VS Code Marketplace.

The extension's tags are `v1.2.0`. A `docs-v1.2.1` tag releases the documentation alone — a correction
between two extension versions ([web-docs/RELEASING.md](web-docs/RELEASING.md)).

## One-time setup

The documentation deploy needs the Cloudflare Worker, the `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` secrets and the `DOCS_URL` variable described in
[web-docs/RELEASING.md §One-time setup](web-docs/RELEASING.md#one-time-setup). Without them a release
stops at its first step, before anything is built.

## Release a version

1. **Pick the version.** Major for a change that breaks a workspace's `bfast.json` or tracker, minor for
   a new feature, patch for fixes. A pre-release adds a suffix: `1.3.0-rc.1`.
2. **Bump it and say what changed**, in one commit on `master`:
   - `npm version 1.2.0 --no-git-tag-version` — `package.json` and `package-lock.json`. The tag must
     match this exactly, or the run stops.
   - Optionally, if the repository keeps a `CHANGELOG.md`: rename `## [Unreleased]` to `## [1.2.0]`
     and start a new empty `## [Unreleased]` above it. That section becomes the top of the release
     notes. Without a `CHANGELOG.md` the release still runs; its notes are the ones GitHub writes.
3. **Tag the commit and push the tag:**

   ```bash
   git checkout master
   git pull
   git tag v1.2.0
   git push origin v1.2.0
   ```

4. **Watch the run** under **Actions → Release**:
   - **Version** — the tag is `v<major>.<minor>.<patch>` with an optional suffix, matches
     `package.json`, names a commit on `master`, and has no GitHub Release yet; `DOCS_URL` and the
     Cloudflare secrets are set.
   - **Test** — the whole suite, exactly as CI runs it.
   - **VSIX** — the production build packaged as `bfast-1.2.0.vsix`, plus `bfast-1.2.0.vsix.sha256`.
     Both are also kept for 30 days as the run's `vsix` artifact.
   - **Documentation** — the site built from the tagged commit and deployed to production, then checked
     (a pre-release deploys a preview instead, and the live site stays on the last full release).
   - **GitHub Release** — titled `BFAST v1.2.0`, with the VSIX and its checksum attached. GitHub adds
     the source code (zip and tar.gz) on its own. The notes are the version's `CHANGELOG.md` section (when there is one), an
     install line, the documentation's address, then the pull requests merged since the previous `v*` tag. A tag with a suffix is
     marked as a pre-release.

## When a release fails

A run that fails before the GitHub Release leaves none behind. If it failed at **GitHub Release**, the
documentation is already live for the new version; re-running deploys the same build again. Fix the cause, then **Re-run failed
jobs** on the same run; no new tag is needed. If the fix needs a new commit, move the tag to it:

```bash
git push origin :refs/tags/v1.2.0
git tag -f v1.2.0 <new commit>
git push origin v1.2.0
```

A version that already has a GitHub Release is never released again. Release the next patch instead.

## Check a download

```bash
sha256sum -c bfast-1.2.0.vsix.sha256
code --install-extension bfast-1.2.0.vsix
```
