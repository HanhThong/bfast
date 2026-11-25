# BFAST Code Quality

Right-click an environment in the **Environments** section → **Run Scan**: BFAST
analyses that environment's worktree with SonarQube, shows the quality gate, the measures
and the issues in an editor tab, and records the verdict on the environment's ticket. Run Tests answers "do the criteria still
hold"; this answers the other half — "and what did it cost the codebase".

The first tool is SonarQube, and BFAST can either **deploy one for you** — a container per
workspace, with its admin password and analysis tokens generated for you, so there is no
"log in, change the password, copy a token" ritual — or talk to the **SonarQube Server or
SonarQube Cloud you already have**.

This folder is the feature's specification and user guide:

- [configuration.md](configuration.md) — the `scan` block in `.vscode/bfast.json`
- [sonarqube.md](sonarqube.md) — the deployed stack's contract, and what an external
  instance must offer
- [provider-interface.md](provider-interface.md) — the `ScanProvider` seam, for contributors

## The shape: one server, one project, many scans

| Piece | What it is | Example |
|---|---|---|
| **Server** | One SonarQube per workspace — deployed by BFAST under a per-workspace compose project, or an existing instance you point at | `bfast-sonar-my-app`, or `https://sonarcloud.io` |
| **Project** | One SonarQube project per workspace. Every scan from every ticket lands in it. Named by the checkout's own `sonar-project.properties` when it has one, else `scan.projectKey`, else the folder name | `ice-hrm`, or `my-app` |
| **Scan** | One analysis of one directory, started from one ticket | `ST-1.2` → 41 code smells, gate OK |

**An environment is what gets scanned; its ticket is where the result is recorded.**
BFAST's tickets are prose — they own no folder — but a story or epic with an environment
owns a worktree: the checkout of the branch the work is actually on. That is the code a
scan is about, so the gesture lives on the environment's row — stopped or running, since a
scan reads source and not containers — and the verdict lands on the environment's ticket. A ticket with no
environment has nothing of its own to scan and gets no Run Scan; quietly analysing the
repo's main checkout under its name would file a verdict about code it never touched.
**Scan Workspace**, on the Code Quality section's title bar, is the whole-repo gesture. A
scan **does not fan out** the way Run Tests does: a test case *is* a test, so running one
command per test case makes sense; a code scan is one analysis of one checkout.

**Which directory is analysed:**

| Gesture | What is scanned | Recorded on |
|---|---|---|
| **Run Scan** on an environment | that environment's **worktree** | the environment's ticket |
| **Scan Workspace** | the workspace root, or `scan.cwd` if set | nothing — the tab and the sidebar only |
| a scan tab reopened for a ticket whose environment is gone | refused: the tab says the ticket has no environment | — |

## Your first scan

1. Open BFAST settings (gear icon) → **Scan** tab. The defaults deploy SonarQube for you;
   if you already have an instance, set **Mode** to *External* and fill in its URL — see
   [configuration.md](configuration.md). Nothing here is required for the default path.
2. **Deploy** from the **Code Quality** section's title bar (external mode skips this). That
   one press does everything: it allocates a port, starts the stack, waits for the API to
   answer `UP`, changes the factory `admin` password to a generated one and mints the
   tokens it needs. Nothing to copy, nothing to paste, and no second button to find.
   The first boot pulls about 1 GB of images and takes several minutes — watch the
   "BFAST Code Quality" output channel, not the spinner.
3. Right-click an **environment** in the Environments section → **Run Scan**, or
   use **Scan Workspace** from the Code Quality section's title bar. If you skipped step 2,
   this does it for you first.
4. Read the verdict in the tab that opens, and follow **Open in SonarQube** for the full
   dashboard.

The project is named for you too. A `sonar-project.properties` at the root of the
analysed directory — the file a repository that already scans in CI carries — names it
with its own `sonar.projectKey` and `sonar.projectName`; without one, `scan.projectKey`
from the settings; without that, the workspace folder's name. The results tab's setup
screen says which of the three it was.

On Linux, do step 0 first: SonarQube's Elasticsearch needs `vm.max_map_count` raised.
BFAST checks before deploying and gives you the exact command; see
[sonarqube.md](sonarqube.md).

## Lifecycle

```
              Deploy                                     Stop
(absent) ───────────────────────────▶ running ◀──────────────────▶ stopped
          allocate a port, start the    │           Start             │
          stack, wait for the API,      │     (start + provision)     │  Remove
          then provision credentials    ▼                             ▼
                                   (a scan can run)        gone — container, volumes,
                                                           analysis history AND the
                                                           provisioned credentials
```

Action availability: **Deploy** from `absent`, **Start** from `stopped` and `error`,
**Stop** from `running`, **Remove** from any settled state. An **external** server shows
none of them — it is not BFAST's to run.

- **Deploy** and **Start** are one gesture underneath — *set up*: deploy what is absent,
  start what is stopped, provision what is missing, and skip whatever is already done. A
  press on either ends in the state where **Run Scan** works, never in a stopped server
  you have to go and start next or a running one with no token. On a healthy server the
  whole thing costs one HTTP call and writes nothing, which is why pressing it twice is
  harmless. Deploy allocates a free host port and writes the generated compose file into
  BFAST's own folder outside your repo; Start brings the container up and **waits until
  the API answers `UP`** — a container that is running is not a server that is ready.
  Neither runs a scan.
- **Re-provision credentials** re-checks the stored credentials and mints new tokens when
  they are missing or dead. It is safe to run at any time: on a healthy instance it costs
  one HTTP call and writes nothing.
- **Remove** destroys the container, its networks **and its volumes**, then clears the
  stored credentials. The analysis history goes with it. It asks first, and it says so.

A cancelled or failed operation rolls nothing back: what was done stays done, the server
shows `error` with the reason, and the output channel holds the full log.

## Outcomes

One row per outcome the runner can produce; the code must keep matching this table.

**No outcome ever changes a ticket's status.** Run Tests owns `done` and `blocked`; a scan
writes a history entry and nothing else. Two features writing one field would fight, and
a `blocked` that actually meant "your Docker was off" poisons the tracker — which is the
whole product.

| Outcome | When | History entry |
|---|---|---|
| `passed` | the analysis finished and the quality gate is `OK` | ``Code scan: quality gate **OK** — 0 bugs, 2 vulnerabilities, 41 code smells, 78.2% coverage. <dashboard url>`` |
| `warn` | the gate is `WARN` (a legacy value; thresholds were removed in 7.6) | as `passed`, reading "quality gate **WARN**" |
| `no-gate` | the gate is `NONE` — no quality gate is attached to the project | ``Code scan: no quality gate is attached to `<key>`; 43 open issues. <dashboard url>`` |
| `failed` | the gate is `ERROR` | ``Code scan: quality gate **ERROR** — new_coverage 82.5 LT 85; new_blocker_violations 14 GT 0. <dashboard url>`` — failing conditions only, five at most, then `+N more` |
| `ce-failed` | the server accepted the report and then failed to process it | none — an error notification carrying the server's own message, with **Show Log** |
| `scanner-failed` | the scanner exited non-zero | none — the last stderr line, with **Show Log** |
| `timeout` | the scanner went quiet past `scan.idleTimeout`, or the server's task stopped changing | none |
| `unreachable` | the server never answered, the stack would not start, or `docker` is missing | none — on evidence of `vm.max_map_count`, the message is the exact `sysctl` line instead of the generic one |
| `unauthorized` | any call came back 401 or 403 | none — the error offers **Re-provision** (deployed) or **Set token** (external) |
| `cancelled` | you pressed Stop | none |

History entries already written stay written; nothing is rolled back — the same posture as
a cancelled generate batch and a cancelled test run. The entry is the scan's provenance,
exactly as AI-assisted edits carry theirs: `git log` on the tracker answers "what did the
code look like when this ticket was closed, and when was that measured".

**A scanner that exits non-zero is not a verdict.** BFAST deliberately does not pass
`sonar.qualitygate.wait`, which would make the scanner fail the process on a red gate:
that would collapse "the gate failed" and "your token is wrong" into one exit code, and
that distinction is the only thing this table turns on.

## The sidebar section

The BFAST activity-bar container gains a third section, **Code Quality**, under Environments.
It has one root row — the server — that expands into what you need to diagnose a failure
before you have one:

| Row | Shows | Click |
|---|---|---|
| **Server** | status and port — `Running · :9000` | nothing; the actions are on the right-click menu |
| **Endpoint** | `http://localhost:9000` | opens it in VS Code's Simple Browser (external browser as the fallback) |
| **Credentials** | `ready`, or `missing — click to add a token` | **Set SonarQube Token**; the inline copy button (or right-click → **Copy Scan Credential…**) puts the analysis token, the results token or the generated admin password on the clipboard |
| **Recent runs** | the last ten, newest first — `ST-1.2 · gate OK` | reopens that run's results tab |

The credential row earns its place: "the scan failed and nobody can tell why" is this
feature's number-one failure mode, and `Credentials · missing` in the tree is the cheapest
possible answer to it. It reads as a state rather than a mechanism — "ready" answers the
one question the row exists for, *can a scan run* — and the copy button is how the same
token reaches a CI job or a colleague without anyone opening SonarQube.

| Status | Meaning |
|---|---|
| `absent` | nothing deployed yet |
| `stopped` | the container exists and is not running |
| `running` | the container is up **and** the API answered `UP` |
| `deploying` / `starting` / `provisioning` / `stopping` / `removing` | an operation is in flight (spinner); the output channel shows its progress |
| `external` | an instance BFAST does not own — no Start, Stop or Remove |
| `error` | the last operation failed; the detail says how |
| `unknown` | Docker could not be queried |

The section's title bar has **Deploy**, **Scan Workspace** and **Refresh**. Status also
refreshes on a timer while the section is visible.

## The results tab

A scan opens an editor tab — one per ticket, revealed rather than duplicated if you ask
twice. It is a tab and not a notification for the reason the generate tab is: the flow has
moments a toast cannot hold. A first boot is minutes of log that prove it has not hung, and
a verdict is a table.

Five screens, in order: **setup** (the project key and where it came from, what will be
scanned, and whether the server is up yet — Scan sets it up if not) → **preparing** (the server's boot log) → **scanning** (the scanner's
output) → **importing** (the server is processing the report) → **report**.

The report screen shows the quality gate as a banner with each failing condition spelled
out, a row of measures (bugs, vulnerabilities, security hotspots, code smells, coverage,
duplication, lines), and the issues worst-first — severity, rule, `file:line`, message.
Clicking an issue opens that file at that line. The list is capped at 300 and says so; it
is for triage, and **Open in SonarQube** is the complete view.

A measure with no data shows `—`, never `0`: a project with no tests reporting "0%
coverage" would be a lie.

Stop is available throughout, and closing the tab is as clear a stop as pressing it. A
reloaded window brings the tab back on its **setup** screen — a run was a child process
that session owned, and a log that never advances again would be a lie too.

## Reporting

- The **"BFAST Code Quality"** output channel is the log of record: the compose boot log, the
  scanner's own output, and a `— ` prefixed line for every phase BFAST enters. The
  scanner's authentication token is **redacted** from the command line before it is
  echoed.
- The server's background-task warnings land there too — that is where "missing blame
  information" and deprecation notices live, and they are worth seeing once and fixing.
- A terminal notification carries the verdict, with **Show Log** and **Open Dashboard**.

## Trust

The `scan` block lives in a committed `.vscode/bfast.json` and, in `command` mode, runs a
shell line on a click — the same trust class as `tasks.json` and `tests.command`. Review it
like any other executable config when it arrives in a pull. VS Code itself enforces the
gate: the extension declares `capabilities.untrustedWorkspaces.supported: false`, so in
Restricted Mode BFAST does not run at all — that declaration is load-bearing and must not
be loosened.

No credential is ever stored in `bfast.json`. Tokens and the generated admin password live
in VS Code's secret storage, keyed per workspace; see
[configuration.md](configuration.md#secrets).

## Limitations and troubleshooting

- **The first boot is slow and silent.** Two to five minutes is normal, and most of it is
  an image pull plus Elasticsearch building its indices. The output channel is the only
  thing that distinguishes it from a hang, which is why the boot log is streamed rather
  than summarised.
- **`vm.max_map_count` on Linux.** `docker compose up -d` reports success while
  Elasticsearch dies of it. BFAST checks before deploying and recognises the failure
  afterwards, but it cannot fix it — the sysctl is not namespaced, so no compose file can
  set it. See [sonarqube.md](sonarqube.md).
- **SonarQube wants about 2 GB of RAM**, plus what your environments are already using.
  BFAST warns below 4 GB available and lets you continue anyway; it is a guess about your
  machine, and refusing on a guess is how you block the person whose swap is fine.
- **`.scannerwork/` does not appear in your repo** in `docker` mode — the scanner's working
  folder is mounted from BFAST's own scan home. In `command` mode your own scanner writes
  it into the analysed directory; add it to `.gitignore` then, BFAST will not edit that
  file for you.
- **Community Edition analyses the main branch only.** Every scan, from every ticket and
  every worktree, overwrites the same project — so the dashboard shows the most recent
  scan, not a per-ticket history. Branch analysis starts at Developer Edition. BFAST never
  sends `sonar.branch.name`, because on Community it fails the analysis outright.
- **Scanning an environment worktree loses SCM data.** A worktree's `.git` is a file
  pointing outside the analysed directory, so BFAST disables the SCM integration for it
  rather than let the scanner flood the log with blame failures. Without SCM data
  SonarQube's "new code" measures are meaningless; the summary says so when it happens.
- **One scan at a time per workspace.** Two analyses of one project key produce two server
  tasks, and the second one's measures overwrite the first's — you would be reading a
  verdict you cannot identify.
- **The image tag is rolling.** BFAST never passes `--pull always`, so the instance will
  not upgrade under you; when you do pull a newer image, the next Start runs the database
  migration and says so rather than dead-ending.
- **Behind a corporate proxy**, Node's own HTTP client ignores `HTTP_PROXY`, so calls to an
  external instance fail with no explanation. BFAST detects a configured `http.proxy` and
  names it in the error instead.
