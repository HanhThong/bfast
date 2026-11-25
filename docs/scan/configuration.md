# Configuration — the `scan` block

Code scanning is configured in `.vscode/bfast.json`, next to the tracker, AI, environments
and tests settings. The file is **committed to git**, so the whole team shares one project
key, one quality gate and one way of running the scanner — nothing here is per-machine, and
**nothing here is ever a credential**. Tokens and the generated admin password live in
VS Code's secret storage; see [Secrets](#secrets).

Edit it in the BFAST settings form (gear icon → **Scan** tab) or by hand. Reading is
forgiving: a hand-edited value that is out of range or malformed is ignored and the default
applies. Writing is strict: the form refuses to save an invalid block.

## Fields

Every field is optional; the whole block is omitted from the file when nothing in it is
set, so a workspace that never scans keeps its `bfast.json` unchanged.

| Field | Type | Default | Rules |
|---|---|---|---|
| `tool` | `"sonarqube"` | `"sonarqube"` | Which scan tool runs. One today; the field exists so the next one is a settings value rather than a code change. See [provider-interface.md](provider-interface.md). |
| `mode` | `"auto"` \| `"external"` | `"auto"` | `auto` — BFAST deploys and provisions a SonarQube for this workspace. `external` — you point at one you already have. |
| `hostUrl` | string | *(unset)* | **`external` only.** An `http`/`https` URL. May not carry userinfo (`https://user:pass@host`) — a credential in a committed file is refused, not trimmed. A trailing slash is stripped; a port and a path prefix are kept. |
| `organization` | string | *(unset)* | **SonarQube Cloud only**, where it is mandatory. Lower-case, 2–64 of `[a-z0-9-]`. Meaningless against a Server. |
| `projectKey` | string | the workspace folder name, slugified | The SonarQube project every scan in this workspace files under, **when the analysed directory has no `sonar-project.properties` naming one** — see [Where the project key comes from](#where-the-project-key-comes-from). `[A-Za-z0-9._:-]`, at most 400 characters, and not all digits (SonarQube refuses those). |
| `cwd` | string | the workspace root | Workspace-relative directory **Scan Workspace** analyses, for monorepos (`apps/web`). May not be absolute or escape the workspace with `..`. A scan of an environment analyses its whole worktree and ignores this. |
| `sources` | string | *(unset)* | Passed as `sonar.sources` when set. Unset, BFAST sends `.` **unless** the analysed directory's `sonar-project.properties` lays the sources out itself (`sonar.sources` or `sonar.tests`), in which case it sends nothing and the file's layout stands — `-D` would override it, and a `.` on top of a file that separates tests from sources makes every test file a source file too. |
| `exclusions` | string | *(unset)* | Passed as `sonar.exclusions` only when set. Comma-separated globs. |
| `properties` | `{key, value}[]` | `[]` | Extra `-D` analysis properties. Keys matching `token`, `login`, `password` or `secret` are **refused**, as are the four BFAST owns (`sonar.host.url`, `sonar.projectKey`, `sonar.organization`, `sonar.projectBaseDir`). Values may not contain a newline. Duplicate keys keep the first. |
| `scannerMode` | `"docker"` \| `"command"` | `"docker"` | `docker` runs the official scanner image — nothing to install beyond the Docker you already need. `command` runs a shell line you write, for a build-integrated scanner (Maven, Gradle, dotnet). |
| `scannerImage` | string | `"sonarsource/sonar-scanner-cli"` | **`docker` mode only.** Pin a tag here if you need to. |
| `scannerNetwork` | string | *(unset)* | **`docker` mode only.** Overrides the docker network the scanner container joins. The escape hatch for an external server bound to loopback on Linux — set it to `host`. See [sonarqube.md](sonarqube.md#networking). |
| `command` | string | *(unset — `command` mode reports the feature unconfigured)* | **`command` mode only.** The shell line, with [placeholders](#placeholders) substituted. Runs under `cmd.exe /d /s /c` (verbatim arguments) on Windows, `/bin/sh -c` elsewhere, so shims, pipes and `&&` work. |
| `composeFile` | string | *(the file BFAST ships)* | **`auto` mode only.** Path to a compose file replacing BFAST's own. Absolute, or workspace-relative. It must satisfy the contract in [sonarqube.md](sonarqube.md#the-compose-contract). |
| `composeOverrides` | string[] | `[]` | **`auto` mode only.** Additional compose files layered over `composeFile`, **in order** — each becomes one more `--file` flag, and later files override earlier ones (standard compose merging). |
| `portRangeStart` | number | `9000` | 1024–65535. The host port for the deployed server is allocated from this range. |
| `portRangeEnd` | number | `9099` | 1024–65535, ≥ `portRangeStart`. |
| `autoProvision` | boolean | `true` | **`auto` mode only.** Whether BFAST changes the factory admin password and mints its own tokens. Turn it off to manage the instance yourself; you then supply a token with **BFAST: Set SonarQube Token**. |
| `idleTimeout` | number | `600` | 60–3600, in **seconds of silence**. A scanner or a server boot producing no output for this long is stopped and recorded as `timeout`. Silence-based, never wall-clock: a first boot that keeps printing is never stopped, however long it takes. |

## Where the project key comes from

Three places, tried in this order, and the results tab's setup screen says which one won:

| Priority | Source | Example |
|---|---|---|
| 1 | `sonar.projectKey` in a **`sonar-project.properties`** at the root of the analysed directory (the worktree's own copy, when a ticket has an environment) | `ice-hrm` |
| 2 | **`scan.projectKey`** in `bfast.json` | `acme_my-app` |
| 3 | the **workspace folder's name**, slugified | `my-app` |

The file wins over the setting on purpose. Inside the scanner a `-D` flag beats the file, so
a key BFAST chose would silently rename the project a team already set up in CI, and every
dashboard link they have would point at the old one. A repository that carries that file
has answered the question; BFAST's job is to agree with it. A key the file names but
SonarQube would refuse (all digits, a forbidden character) is ignored and the next source
applies, rather than failing four minutes into the scan.

The display name follows the same idea: the file's `sonar.projectName`, else the folder
name. BFAST creates the project under that key and name **before the first scan** runs —
so the dashboard is titled `ICE HRM` rather than `ice-hrm`, and a credential that cannot
create projects fails in a second rather than at report submission. An existing project
costs one call and is left alone.

There is deliberately **no `concurrency`**. One scan runs at a time per workspace, and that
is not a dial: two analyses of one project key produce two server-side tasks whose measures
overwrite each other, so the verdict you read would belong to a run you cannot identify.

## Placeholders

`command` mode substitutes:

| Token | Value | Notes |
|---|---|---|
| `{{projectKey}}` | the resolved project key | |
| `{{hostUrl}}` | the server's **host-side** URL — `http://localhost:9000` | A shell line runs on your machine, so it gets the published port, not the container's. |
| `{{folder}}` | the absolute path of the directory being analysed | May contain spaces — quote it: `"{{folder}}"`. |
| `{{id}}` | the ticket the scan was started from — `ST-1.2` | Absent for Scan Workspace, where it renders empty. |
| `{{key}}` | that ticket's local segment — `ST-1` | **Not unique** across the tracker. |

An unknown `{{token}}` is left in the command untouched (the same policy the AI prompt
templates and `tests.command` follow), and the settings form warns about it without
refusing to save.

**`{{token}}` is deliberately not offered.** A secret interpolated into a shell line lands
in the process table, in shell history, and in the very command BFAST echoes to its output
channel. It reaches your line as the environment variable **`SONAR_TOKEN`**, which is what
every SonarQube scanner reads natively — that is the only correct way to pass it, and it is
the same reasoning that keeps `{{title}}` out of `tests.command`.

Alongside it, a `command`-mode line always receives:

| Variable | Example |
|---|---|
| `SONAR_HOST_URL` | `http://localhost:9000` |
| `SONAR_TOKEN` | the analysis token |
| `SONAR_PROJECT_KEY` | `my-app` |
| `SONAR_ORGANIZATION` | Cloud only, when set |
| `BFAST_TICKET_ID` | `ST-1.2` |

In `command` mode BFAST appends **no** `-D` properties of its own — `sources`,
`exclusions` and `properties` are ignored. The line is yours; BFAST supplies the
environment and stays out of it.

## Secrets

`ScanSettings` has no field a credential could be typed into, by design. Everything secret
lives in VS Code's secret storage, keyed per workspace so two projects on one machine
cannot overwrite each other:

| Command | Stores |
|---|---|
| **BFAST: Set SonarQube Token** | the token used against an external instance, or a deployed one you provision yourself |
| **BFAST: Show SonarQube admin password** | *(reads)* the password BFAST generated, so you can log into the UI |
| **BFAST: Copy Scan Credential…** | *(reads)* a quick pick of the analysis token, the results token and the admin password — whichever are stored — straight to the clipboard. Also the copy button on the Credentials row. |
| **BFAST: Clear scan credentials** | removes all of them for this workspace |

In `auto` mode BFAST provisions and stores **two** tokens: a *global analysis token*, which
is the only credential that ever enters the scanner container, and a *user token*, which
never leaves the extension host and is what reads the quality gate, the measures and the
issues back. Analysis tokens cannot call those read endpoints — they answer 403 — and
handing a container a token that can do everything an administrator can is the wrong blast
radius. See [sonarqube.md](sonarqube.md#provisioning).

Against an **external** instance you supply one token, and it must be a **user token**:
BFAST reads results back through the Web API, which an analysis-only token cannot do. The
settings form's **Test connection** button checks exactly that and tells you which kind you
pasted.

The allocated host port is not stored here either — it is machine-specific, and this file
is committed. BFAST remembers it per workspace and re-learns it from Docker if it forgets.

## Example — BFAST deploys SonarQube

```jsonc
// .vscode/bfast.json
{
  "trackerFolder": ".tracker",
  "userName": "Hanh Thong",
  "scan": {
    "projectKey": "my-app",              // optional — defaults to the folder name, slugified
    "exclusions": "**/node_modules/**,**/dist/**",
    "portRangeStart": 9000,              // optional — where the host port comes from
    "portRangeEnd": 9099,
    "idleTimeout": 900                   // optional — seconds of silence, defaults to 600
  }
}
```

Everything else is defaulted: `mode` is `auto`, so **Deploy** starts a SonarQube container
for this workspace on the first free port from 9000, waits for it to come up, changes its
factory `admin` password to a generated one and mints an analysis token and a results
token — one press, no second step. **Run Scan** on `ST-1.2` then creates the project
`my-app` if it is not there yet, runs the official scanner image over that ticket's
environment worktree — or the workspace root if it has none — waits for the server to
finish processing the report, and writes the gate and the counts into `ST-1.2`'s history.
Had the workspace carried a `sonar-project.properties` with `sonar.projectKey=ice-hrm`,
the project would be `ice-hrm` and the `projectKey` line above would be ignored.

## Example — an existing SonarQube Cloud

```jsonc
// .vscode/bfast.json
{
  "trackerFolder": ".tracker",
  "userName": "Hanh Thong",
  "scan": {
    "mode": "external",
    "hostUrl": "https://sonarcloud.io",
    "organization": "acme",
    "projectKey": "acme_my-app",
    "cwd": "apps/web",                   // optional — for a monorepo
    "properties": [
      { "key": "sonar.sources", "value": "src" },
      { "key": "sonar.javascript.lcov.reportPaths", "value": "coverage/lcov.info" }
    ]
  }
}
```

Here the **Code Quality** section shows a single `external` row with no Start or Stop — the
server is not BFAST's to run — and the credential row until you run **BFAST: Set SonarQube
Token** with a user token that has *Execute Analysis* and *Browse* on the project. Scans run
the same scanner image, pointed at Cloud, from `apps/web`.

What the deployed stack must satisfy, and what an external instance must offer:
[sonarqube.md](sonarqube.md).
