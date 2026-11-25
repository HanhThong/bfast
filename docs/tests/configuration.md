# Configuration — the `tests` block

Test runs are configured in `.vscode/bfast.json`, next to the tracker, AI and
environments settings. The file is **committed to git**, so the whole team shares one
way of running the tests — nothing here is per-machine, and nothing here is ever a
credential (anything secret belongs in the environment the command itself reads).

Edit it in the BFAST settings form (gear icon → **Tests** tab) or by hand. Reading is
forgiving: a hand-edited value that is out of range or malformed is ignored and the
default applies. Writing is strict: the form refuses to save an invalid block.

## Fields

Every field is optional; the whole block is omitted from the file when nothing in it is
set, so a workspace that never runs tests keeps its `bfast.json` unchanged.

| Field | Type | Default | Rules |
|---|---|---|---|
| `command` | string | *(unset — Run Tests reports the feature unconfigured)* | The shell line run **once per test case** in scope, with [placeholders](#placeholders) substituted. Runs under `cmd.exe /d /s /c` (verbatim arguments) on Windows, `/bin/sh -c` elsewhere, so shims, pipes and `&&` work. |
| `cwd` | string | the workspace root | Workspace-relative working directory for every run — for monorepos (`apps/web`). May not be absolute or escape the workspace with `..`. A folder that does not exist aborts the run. |
| `resultsFolder` | string | `.bfast/test-results` | Workspace-relative folder every run is filed under: `<resultsFolder>/<test case id>/<runId>/` with `output.log`, `run.json` and the evidence files — see [README.md](README.md#evidence). May not be absolute, escape the workspace, or be (or sit inside) the tracker folder: a run is not a change to a ticket, and the tracker's history stays the ticket's. A hand-edited value inside the tracker is ignored and the default applies. Commit it or gitignore it as the team prefers. |
| `evidence` | string | *(unset — only the command's output is recorded)* | A glob, relative to `cwd`, for the files the test tool leaves behind for one test case: `e2e/evidence/**/{{id}}.*`. `**` spans folders, `*` and `?` match within a name; every other character is literal, so `{{id}}.*` cannot match `TC-1.10.webm` when the id is `TC-1.1`. May not be absolute or escape the workspace. After each test case exits, every match written during the run is copied into the test case's run folder under `resultsFolder` — see [README.md](README.md#evidence). |
| `evidenceCommand` | string | *(unset — a Playwright trace opens with the Playwright installed in the workspace; any other file Open cannot show is revealed in the file manager)* | The shell line the board's **Open** / **Open in Playwright Trace Viewer** runs for an evidence file it cannot show inline: `pnpm --dir e2e exec playwright show-trace {{file}}`. Runs like `command` (same shell, same working directory), with no idle timeout, since a viewer blocks until its window closes. When set it **always wins** over the built-in launcher — see [README.md](README.md#the-tests-tab). Traces themselves are shown inline on the Tests tab whether or not this is set. |
| `traceFrames` | `"auto"` \| `"resources"` \| `"screencast"` | `"auto"` *(omitted from the file)* | Where the board's trace viewer takes a Playwright trace's screenshots from. Playwright moved them in trace format 9: up to format 8 a `screencast-frame` names its image by `sha1` and the image is `resources/<sha1>`; from format 9 it gives the image's own path as `file` (`screencast/page@…-<time>.jpeg`). `auto` reads each context by its own `context-options.version`, and takes the other field when the expected one is missing. `resources` or `screencast` reads that one layout only — for a trace whose format number is wrong about where its frames are. Anything else is refused by the form and ignored when read. Changing it applies to the next trace shown; nothing is cached across a change. |
| `concurrency` | number | `1` | 1–8. How many test commands run at once **across the whole window**, not per batch — two Run Tests batches share this one cap rather than each getting their own. The default is sequential on purpose: parallel runs sharing one database corrupt each other — raise it only when the tests are isolated, and **keep it at 1 when `evidence` is set and the test tool clears its output folder at the start of a run**. |
| `coverage` | string | *(unset)* | An lcov file the project command writes, relative to `cwd` — one source of the merged coverage. See [services.md](services.md). |
| `services` | list | *(unset)* | The repository's services — a folder, an optional unit suite, an optional e2e suite with the compose services it needs. A test case assigned to a service runs with that service's `e2e.testCommand`. See [services.md](services.md). |
| `idleTimeout` | number | `300` | 30–3600, in **seconds of silence**. A run producing no output for this long is stopped and recorded as `timeout`. Silence-based, never wall-clock: a suite that keeps printing is never stopped. |

## Placeholders

`command`:

| Token | Value |
|---|---|
| `{{id}}` | the full ticket id (`TC-1.2.1.1`) — unique, the recommended token |
| `{{key}}` | the local segment (`TC-1`) — **not unique** across the tracker |
| `{{folder}}` | the absolute path of the test case's folder — quote it: `"{{folder}}"` |

`evidence`: `{{id}}` and `{{key}}` only. `{{folder}}` is an absolute path and the pattern must
stay relative, so the form warns about it.

`evidenceCommand`: `{{file}}` only — the absolute path of the file to open, **already quoted
for the platform shell** (single quotes on POSIX with any embedded quote escaped, double quotes
on Windows). Do not add quotes of your own. A ticket's folder name keeps the apostrophes and
dollar signs of its title, and the file's name arrived from a `git pull`; BFAST quoting the
value itself, and refusing a name it would not have written, is what keeps that from being a
shell injection — the same reason `{{title}}` is not a token anywhere.

On a **remote** workspace (Remote-SSH, WSL, a container) the command runs on the remote, where
`playwright show-trace` has no display to open a window in. The built-in launcher (no
`evidenceCommand`) handles this itself: it serves the viewer with `--host 127.0.0.1 --port 0`,
reads the port it prints ("Listening on http://127.0.0.1:NNNNN", echoed in the "BFAST Tests"
channel), forwards it and opens it in your browser. It binds `127.0.0.1` on purpose — every
interface on a shared remote would expose the viewer to the machine's other users. With a
command of your own, serve the same way —
`pnpm --dir e2e exec playwright show-trace --host 127.0.0.1 --port 0 {{file}}` — and VS Code
forwards the port it prints to your machine.

Unknown tokens are left in the line untouched; the form warns but does not refuse.
See [README.md](README.md#placeholders) for why `{{title}}` is not offered.

## Example

```jsonc
// .vscode/bfast.json
{
  "trackerFolder": ".tracker",
  "userName": "Hanh Thong",
  "tests": {
    "command": "make e2e ARGS=\"--grep '{{id}} '\" E2E_VIDEO=on E2E_TRACE=on",
    "resultsFolder": ".bfast/test-results",   // the default; shown for the shape
    "evidence": "e2e/evidence/**/{{id}}.*",
    "evidenceCommand": "pnpm --dir e2e exec playwright show-trace {{file}}",
    "concurrency": 1,         // the reporter clears e2e/evidence/ when a run starts
    "idleTimeout": 600        // seconds of silence; a browser suite can be quiet for a while
  }
}
```

With this block, Run Tests on acceptance criterion `AC-2.1.1` (two test cases) runs
`make e2e ARGS="--grep 'TC-2.1.1.1 '" E2E_VIDEO=on E2E_TRACE=on` and then the same for
`TC-2.1.1.2` from the workspace root, one at a time, stopping either that stays silent for ten
minutes — and after each one copies `e2e/evidence/EP-2/ST-2.1/AC-2.1.1/TC-2.1.1.1.webm` and
`….zip` into `.bfast/test-results/TC-2.1.1.1/<runId>/`, writes `output.log` and `run.json` beside
them, and — when the verdict differs from the ticket's current status — sets it `done` or `blocked`
with a history comment naming the run. The trailing space
in `'{{id}} '` keeps `TC-2.1.1.10` out of a run for `TC-2.1.1.1`; the `.` in `{{id}}.*` does the
same for the evidence.
