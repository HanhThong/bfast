# Services — per-service test suites and merged coverage

> Status: **in progress.** Written before the code, like the rest of `docs/tests/`.
> Steps 1–2 of the [delivery order](#delivery-order) are implemented — the settings, the
> form's Services section, assigning a test case to a service, the run routing, the compose
> bring-up and the master environment's variables in every test command. Steps 3–5 (suite
> runs, the board's Services section, merged coverage, SonarQube, MCP) are not yet.

A repository often holds several services (`services/orders`, `services/billing`, `web/`).
Each has its own unit tests and, often, its own end-to-end tests that need some of the
stack running. BFAST already runs the **project's** end-to-end tests, one ticket test case
at a time (README.md). This adds three levels around that:

| Level | What runs | Tied to tickets? |
|---|---|---|
| Service unit tests | one service's unit suite, in its folder | no — a suite |
| Service e2e tests | one service's e2e suite, after its compose services are up — **or** one test case ticket assigned to that service | both |
| Project e2e tests | `tests.command`, once per test case ticket, as today | yes |

…and **one coverage figure for the whole project**, merged from every level's lcov
report, shown on the board, written to a file, and handed to SonarQube.

## Settings — `tests.services` and `tests.coverage`

Still in `.vscode/bfast.json`, still the `tests` block (no new row in `SETTINGS_BLOCKS`,
two new fields in `parseTestsSettings`), still parse-forgiving / validate-strict / omitted
when empty.

```jsonc
"tests": {
  "command": "pnpm e2e --grep {{id}}",          // project e2e, per test case — unchanged
  "coverage": "coverage/e2e/lcov.info",         // NEW — project e2e lcov, relative to `cwd`
  "services": [                                  // NEW
    {
      "id": "orders",                            // [a-z0-9-], unique — the folder results go in
      "name": "Orders",                          // shown on the board; defaults to the id
      "folder": "services/orders",               // workspace-relative; every command runs here
      "unit": {
        "command": "npm test -- --coverage",
        "coverage": "coverage/lcov.info"         // relative to `folder`
      },
      "e2e": {
        "command": "npm run e2e",                // the whole suite
        "testCommand": "npm run e2e -- --grep {{id}}",  // one test case ticket; {{id}} {{key}} {{folder}}
        "coverage": "coverage/e2e/lcov.info",
        "compose": ["orders", "postgres"]        // compose services brought up first
      }
    }
  ]
}
```

| Field | Rules |
|---|---|
| `services[].id` | required, `^[a-z0-9][a-z0-9-]*$`, ≤ 40, unique. A row without one is dropped on read and refused on save. |
| `services[].name` | optional free text. |
| `services[].folder` | required, workspace-relative, the `cwd` rules (no absolute path, no `..`). May not be or sit inside the tracker. |
| `unit` / `e2e` | each optional; a service with neither is allowed (it can still own test cases once `e2e.testCommand` is set). |
| `*.command`, `e2e.testCommand` | shell lines run like `tests.command` (`shellCommand`, idle timeout `tests.idleTimeout`). A suite `command` takes **no** placeholders; `testCommand` takes `{{id}}`/`{{key}}`/`{{folder}}`. Unknown tokens are a form hint, never an error. |
| `*.coverage`, `tests.coverage` | optional, relative to the command's working directory, may not escape the workspace. Must be **lcov** (`SF:` / `DA:` / `BRDA:` / `end_of_record`). |
| `e2e.compose` | optional list of service names from the environments compose chain (`environmentComposeFiles`). Unknown names are a form warning, not a refusal — the compose file may be edited later. |

The form's **Tests** tab gains a **Services** section (`ServicesSection.tsx`): one card per
service, **Add service…**, **Remove**, a folder picker (`pickServiceFolder` →
`serviceFolderPicked`, the `pickTrackerFolder` shape, refusing a folder outside the workspace;
a blank id and name are proposed from the folder by `suggestServiceId`), collapsible **Unit
tests** / **E2E tests** sections, and a checklist of compose services read from
`docker compose config --services` over the compose chain (`listComposeServices` →
`composeServices`). The message carries the form's **unsaved** environments block, normalised
by the host before any path reaches `docker`, so a compose file typed a moment ago is the one
read. When docker or the file is missing the checklist falls back to a comma-separated field
with the reason and a **Refresh** link; a ticked name the files no longer declare stays ticked
and is flagged. The **Project e2e coverage** field (`tests.coverage`) sits above it.
`testsConfigured` — a project command **or** one service's `e2e.testCommand` — is what the
Run button, the batch guard and the board's "not configured" notice now read.

## Assigning a test case to a service

A test case ticket may carry `service: orders` in its `metadata.yaml` — a new optional
field, the `assignee` path (`KNOWN_KEYS`, `TicketMetadata`, `TicketSummary.service?`).
Set from the sidebar (**Set Service…** on a test case, `bfast.setTestCaseService`, menu group
`2_modify@5`, hidden from the palette) or the test case board's Tests tab (a picker beside Run,
`testsSetService` → the same command with the id and the pick; a service the settings no longer
declare stays listed and marked). The store's `setService` refuses any ticket that is not a test
case, and the same service again is a non-event. Setting it writes one `changed — service` history entry and bumps `updatedAt`,
like a status change: it changes what the ticket *is*.

When a test case runs (Run Tests from any ticket, or its own board):

| The test case | Runs |
|---|---|
| has no `service` | `tests.command` in `tests.cwd` — exactly as today |
| names a service with `e2e.testCommand` | that line, in the service's `folder`, after its `e2e.compose` services are up |
| names a service with no `e2e.testCommand`, or one not in settings | outcome `error`: "ST-… is assigned to *orders*, which has no e2e testCommand." — never a silent fallback to `tests.command` |

Everything else about a test case run is unchanged: the run is filed under
`<resultsFolder>/<TC id>/<runId>/`, the verdict moves the status, the batch rules hold.

## Bringing compose services up

Before a service's e2e suite or a test case assigned to it, BFAST runs, in the **master
environment** (the workspace folder itself — the tests run there too):

```
docker compose -p <master project> --file … up -d --wait <e2e.compose…>
```

- The master environment must exist (Environments → **New Master environment**). If it
  does not, the run is refused with an action to create it — BFAST never invents a project
  name, because two names would mean two stacks fighting over the same ports.
- `--wait` makes "up" mean healthy where the compose file has health checks; the idle
  watchdog still guards the wait.
- The services are **left running** afterwards: the next run reuses them, and Stop on the
  master environment is the way down.
- Every test command — service or project — now receives the master environment's
  `stackEnvironment` (its port variables, `BFAST_PROJECT_NAME`) when the master exists,
  so a test can find `ORDERS_PORT` without hard-coding it. A command that ignores them
  is unaffected.
- One bring-up per batch, not per test case: a batch of twelve orders test cases runs
  `up` once. It happens before the fan-out, in `runTests`, and **Stop** reaches it.
- `environments/masterStack.ts` is the glue (`vscode`-free): `stackEnvironment()` and
  `composeUp(services, run)` over the environment store's `find('master')`, handed to the tests
  module as `findEnvironment` in `extension.ts`. A provider other than docker-compose refuses
  in words.

## Running and where results go

Suite runs (unit, e2e) are started from the board's Tests tab, go through the same
window-wide `tests.concurrency` limiter, the same `testBatches` guard (a service suite is
a batch keyed `service:<id>:<kind>`; two of the same cannot run at once), and the
**BFAST Tests** output channel.

```
<resultsFolder>/
  TC-1.2.1.1/<runId>/…                 test case runs — unchanged (+ coverage.lcov when written)
  services/<id>/unit/<runId>/          run.json  output.log  coverage.lcov
  services/<id>/e2e/<runId>/           run.json  output.log  coverage.lcov
  project/e2e/<runId>/                 coverage.lcov — the project batch's report
  coverage/lcov.info                   the merged report  (rewritten after every run)
  coverage/summary.json                totals and per-file, per-source figures
```

A suite's outcome is its exit code: `passed` on 0, `failed` otherwise, plus `timeout` /
`cancelled` / `error` as for a test case. A suite run changes **no ticket** — no status,
no history — the rule that keeps Scan's results out of `done`/`blocked`.

A coverage file is copied into the run folder only when it was **written during the run**
(the evidence rule): a stale report from yesterday must not count as today's.

## Merged coverage

The merged report is the union of the **latest** report from every source:

- each service's latest unit run and latest e2e suite run;
- the latest run of every test case that wrote coverage (service or project e2e);
- the latest project batch's `tests.coverage`.

Merging (`mergeLcov`, pure, Node-free, `src/shared/coverage.ts` so the board can bundle
its types):

1. Every `SF:` path is resolved against the directory the command ran in and rewritten
   **workspace-relative** with forward slashes. A path outside the workspace is dropped
   with a warning — it is a dependency, not project code.
2. Records for one file are joined: line hits (`DA`) and branch hits (`BRDA`) **summed**,
   functions (`FN`/`FNDA`) joined by name. A line counts as covered when any source hit it.
3. `LF`/`LH`/`BRF`/`BRH` are recomputed, never trusted from the inputs.
4. Reading is forgiving — an unknown record type is skipped, a broken line counted — the
   `historyFile.ts` posture.

`summary.json` carries the totals, each source's own totals (so the board can say "unit
62%, e2e 41%, merged 74%"), and per file the merged line and branch figures.

## The board's Tests tab

On an **epic** or **story** board, above the test tree, a **Services** section:

```
Services                                              Coverage  74% lines · 61% branches
┌─────────────┬──────────────────────────┬──────────────────────────┐
│ Orders      │ Unit  ● passed 2m ago 82% │ E2E  ● failed 1h ago 40% │  [Run unit] [Run e2e]
│ services/…  │                          │ compose: orders, postgres │
├─────────────┼──────────────────────────┼──────────────────────────┤
│ Billing     │ Unit  — never run         │ E2E  not configured       │  [Run unit]
└─────────────┴──────────────────────────┴──────────────────────────┘
Project e2e   (the test cases below)   41%            [Open merged report] [Lowest files ▾]
```

- A service row opens its latest run's output in the existing output viewer.
- **Lowest files** lists the ten least-covered files of the merged report; a click opens
  the file in the editor.
- **Open merged report** reveals `coverage/lcov.info` (any lcov viewer extension then
  takes it).
- A test case board shows its **Service** picker beside Run.
- New messages, keyed by the board's ticket id like the rest of the tab:
  `servicesRun { kind, serviceId }`, `servicesCancel`, `serviceAssign { serviceId? }`,
  `coverageOpen`, `coverageFile { path }` → host; `servicesReport` (services, latest runs,
  coverage summary) and `servicesProgress` → webview. `testsReport` carries nothing new.

## SonarQube

When a scan analyses the **workspace** (Scan Workspace, or the master environment) and
the merged report exists, the scanner gets

```
-Dsonar.javascript.lcov.reportPaths=<merged report, relative to the analysed directory>
```

— relative because the scanner sees the checkout at `/usr/src`, and the merged report's
paths are workspace-relative for the same reason. It is a **default** in the
`scannerProperties` sense: a key the checkout's `sonar-project.properties` or
`scan.properties` already sets wins. `tests.coverageProperty` (default
`sonar.javascript.lcov.reportPaths`) names the key, for a language whose plugin reads lcov
under another one. A scan of a **ticket's worktree** gets no coverage: the reports were
produced from the workspace's code, not that branch's, and a wrong figure is worse than
none — the scan tab says so.

## MCP

`list_services`, `run_service_tests { serviceId, kind }` (starts and answers at once, the
`run_tests` rule) and `get_coverage` (the summary) under the `tests` function; `service`
appears on `get_ticket` and is settable through a `set_test_case_service` write tool.

## What it does not do

- Parse coverage in any format but lcov. Cobertura and JaCoCo are left for later; a tool
  that only writes those can usually also write lcov.
- Start a ticket environment's stack for a service — e2e runs against the master
  environment, in the workspace, like every other test run.
- Stop the compose services it started.
- Gate anything on coverage: no threshold, no status change.

## Delivery order

1. Settings (`tests.services`, `tests.coverage`), the form's Services section, the `service`
   field on a test case and the run routing — usable on its own.
2. Compose bring-up and the master environment's variables in every test command.
3. Suite runs, their results folder, and the board's Services section.
4. lcov merge, `summary.json`, coverage on the board.
5. SonarQube property, MCP tools, web docs.
