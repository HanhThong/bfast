# BFAST Test Runs

Right-click any ticket in the **Tickets** section → **Run Tests**, or press **Run tests** on the
**Tests** tab of a ticket's board: BFAST runs one configured command per **test case** in that
ticket's subtree and files each run — the verdict, the command's output, and whatever files the
test tool left behind (a video, a trace, a screenshot) — in the **results folder**
(`tests.resultsFolder`, default `.bfast/test-results`), **outside the tracker**. A pass turns the
test case `done`, a fail turns it `blocked`, and that status change is the one thing a run writes
into the ticket, with a history comment naming the run.

Two histories, kept apart on purpose. A ticket's `history.md` is what changed about the *ticket* —
who created it, edited it, moved its status. The results folder is what happened when its *tests
ran* — every run, with its evidence, whether or not it changed anything. They used to share a
file, and a ticket's history read as a test log; now a run that changes nothing about a ticket
writes nothing into it, and the board's **Tests** tab is where the run history lives.

This folder is the feature's specification and user guide:

- [configuration.md](configuration.md) — the `tests` block in `.vscode/bfast.json`

## The shape: one command template, once per test case

A test-case ticket is prose — Preconditions, Steps, Expected result, Test data — and
deliberately contains no runnable command. What connects it to a real test is a
**naming convention**: the automated test carries the ticket's id, and the configured
command template selects by it.

```jsonc
// .vscode/bfast.json
{
  "tests": { "command": "npm test -- --grep {{id}}" }
}
```

**Scope** is the clicked ticket's subtree:

| Clicked | What runs |
|---|---|
| a test case | that one test case |
| an acceptance criterion | its test cases |
| a story | every test case below it — the ones under its ACs **and** its direct test-case children (a TC may cover the whole story) |
| an epic | every test case below it — under its stories, its sub-epics, and directly under the epic (a journey across several stories) |

Order is tree order — depth first, siblings as the sidebar draws them (type, then
ordinal). The scope is re-read from disk when the run starts, not taken from the
sidebar's cache.

## Outcomes

One row per outcome the runner can produce; the code must keep matching this table. *Recorded*
says whether a run folder is written in the results folder (see [Evidence](#evidence)); *History
entry* is the comment on the status change, written **only when the status actually moved**.

| Outcome | When | Recorded | Ticket status | History entry (only on a status change) |
|---|---|---|---|---|
| `passed` | the command exits `0` | yes | `done` | ``Test run `<runId>` passed: `<rendered command>` exited 0.`` |
| `failed` | the command exits non-zero | yes | `blocked` | ``Test run `<runId>` failed: `<rendered command>` exited <code>.`` |
| `timeout` | the command goes quiet past the idle timeout and is stopped | yes | `blocked` | ``Test run `<runId>` was stopped: `<rendered command>` produced no output for <n>s.`` |
| `cancelled` | the user cancelled while this command was running | no | unchanged | none |
| `skipped` | still queued when the run was cancelled or aborted | no | unchanged | none |
| `error` | the test case could not be run or its result not recorded — `{{folder}}` unresolvable, the shell itself would not start, or the ticket was deleted mid-run | no | unchanged | none — counted separately in the summary |

When the run's folder could not be written at all, the status is still written and the comment
says so instead of naming a run: ``Test run passed: `<rendered command>` exited 0. The run could
not be recorded: <reason>.`` The comment never lists the evidence files or the pattern — the run
folder records those, and repeating them would make `history.md` the test log again.

**A re-run with the same verdict touches the ticket not at all.** When the outcome's status
equals the ticket's current status — a second green run on a `done` test case, a red one on a
`blocked` — the run is filed in the results folder and **nothing is written into the ticket**: no
history entry, no status change, no `updatedAt` bump. `changed — status — from: done — to: done`
would be a lie in a file people read, bumping `updatedAt` would fail the next save of a board
sitting open mid-edit on that ticket, and an entry per run is exactly the merged history this
design exists to undo. The run is not lost: it is the newest row on the test case's **Tests** tab.

Statuses already written before a cancel or an abort **stay written** — nothing is
rolled back, the same posture as a cancelled generate batch. A missing user binary is a
`failed` run, not an abort: the shell starts fine and exits non-zero (127), which is the
shell telling you what a red test would. The run only **aborts** — remaining test cases
`skipped`, an error message with the reason — when the problem is the machine rather than
a test: the shell itself would not start, the configured working directory does not
exist, or the ticket vanished from the tracker before the run began.

The history comment is the status change's provenance, exactly as AI-assisted edits carry
theirs: `git log` on the tracker answers "what claimed this test case passes, and when", and the
run id it names is the folder in the results folder that shows what that looked like.

## Evidence

Every run that reaches `passed`, `failed` or `timeout` files a folder in the **results folder** —
`tests.resultsFolder`, default `.bfast/test-results`, relative to the workspace and never inside
the tracker (the settings form refuses a folder that is). One folder per test case, named by its
**id**, and one per run inside it:

```
.bfast/test-results/
  TC-2.1.1.1/                          the test case, by id — never by title, so a rename moves nothing
    2026-09-05T10-22-33.123Z/          the run id: when it started, with ':' → '-'
      TC-2.1.1.1.webm                   what tests.evidence matched — video of the page
      TC-2.1.1.1.zip                    a Playwright trace — opens inline on the Tests tab
      output.log                        the command's own output, stdout and stderr interleaved
      run.json                          the record: when, how it exited, which files, any warnings
    2026-09-05T11-04-10.007Z/          the next run, however it went
.tracker/
  EP-2-…/ST-2.1-…/AC-2.1.1-…/TC-2.1.1.1-Sign_in_returns_to_the_requested_page/
    TestCase.mdx  metadata.yaml  history.md      exactly the three files, whatever has run
```

- **Every run writes the folder, whether or not `tests.evidence` is set.** The command's own
  output is the most basic evidence there is — a failing assertion's message is what you want
  to read on the board — so `output.log` and `run.json` are always there, and the evidence files
  are added when a pattern is configured. `cancelled`, `skipped` and `error` write nothing —
  except an `error` whose *status* write failed after its folder had already landed: the folder
  stays, so nothing is lost. The tracker itself is left byte-identical by a run that changes no
  status.
- **Keyed by id, flat.** `TC-2.1.1.1` is unique across the tracker and safe in a path, a url and
  a shell line, so the board reaches a run from the id alone and a renamed ticket keeps its runs.
  (A duplicate folder's rank — `TC-1#2.1.1` — has its `#` written as `_`.) Moving a subtree
  renames ids, and that breaks the link either way — the same cost the tracker already pays.
- **`output.log`** is the tail of the command's output, ANSI colour codes stripped so it reads in
  an editor and in `git diff`, capped at 64 000 characters (`MAX_RUN_LOG_CHARS`; `run.json`
  records `outputTruncated` when the cap cut it). The full stream is still in the "BFAST Tests"
  channel while the window lives.
- **`run.json`** is written last, so a folder without one is a write that died mid-way and is
  listed as outcome `unknown` — never as a verdict it did not reach. It is read forgivingly: a
  missing or malformed file still lists the folder, with whatever files are actually in it. The
  directory listing is authoritative; `run.json` only annotates the names that exist on disk. A
  file it names that is not there (a teammate gitignored the traces) shows as *not on this
  machine*. Files are named through a rule like the one the ticket's `assets/` use
  (`evidenceFileName`, which keeps every dot, so `TC-1.page-2.webm` stays one name) — safe in a
  folder and in a URL — and a clashing name gets a numbered sibling. It is also what the board
  watches: a `git pull` that brings a teammate's runs reaches every open Tests tab through the
  `run.json` files landing, since no ticket file need change.
- **Only files written during the run count.** A match older than the run's start (two
  seconds of tolerance) is ignored and the count noted in `warnings`: a test tool that fails
  before it clears its own output folder would otherwise hand the *previous* run's video to this
  one. At most `MAX_EVIDENCE_FILES` (100) files are copied per run and a file over
  `MAX_EVIDENCE_FILE_BYTES` (50 MB) is skipped; both are named in `warnings`, never silently.
  Symbolic links are never followed or copied.
- **The copy happens inside the concurrency slot**, before the next test case's command may
  start, and through the results store's own write queue — so two runs landing at once cannot
  pick the same folder and a sequential batch can never lose a file. A test tool that **clears its output folder when a
  run starts** (Playwright reporters commonly do) still needs `tests.concurrency` at its default
  of 1 when `tests.evidence` is set: two of its runs in flight would wipe each other's files. BFAST
  prints a warning line at the start of a batch when both are set; it does not refuse.
- Filing a run **does not touch the ticket**: no `updatedAt` bump and no history entry of its
  own — only a status the verdict moved is written, and its comment names the run. A board open
  mid-edit on that test case is not invalidated by the files landing.
- **Size.** A Playwright trace is 1–7 MB; a video a few hundred KB. Every run adds its folder,
  and nothing prunes old runs — delete a folder when it has served its purpose. Because the
  results folder is separate from the tracker, whether it is committed at all is a decision the
  tracker no longer forces: gitignore `.bfast/test-results/` and the tracker's own history stays
  small and readable, or commit it (or `**/*.zip` under it to LFS) and a run's video travels with
  its verdict. The team's call, best made before the first commit.

## Placeholders

The command template may use:

| Token | Value | Notes |
|---|---|---|
| `{{id}}` | the full ticket id — `TC-1.2.1.1` | **The recommended token.** Unique across the tracker; name your automated tests after it. |
| `{{key}}` | the local segment — `TC-1` | **Not unique** — every AC's first test case is `TC-1`. Only useful in a command that already scopes by something else. |
| `{{folder}}` | the absolute path of the test case's folder on disk | May contain spaces — quote it in the template: `"{{folder}}"`. |

An unknown `{{token}}` is left in the command untouched (the same policy the AI prompt
templates follow), and the settings form warns about it without refusing to save.
`{{title}}` is deliberately not offered: a title is free prose that arrives from a
`git pull`, and interpolating it into a shell line is command injection — the same
reasoning that keeps the AI assistant's tool list hard-coded.

The evidence pattern (`tests.evidence`) takes `{{id}}` and `{{key}}` only — `{{folder}}` is
absolute, and the pattern must be relative. The evidence command (`tests.evidenceCommand`)
takes `{{file}}` only, and **`{{file}}` arrives already quoted** for the platform shell — see
[configuration.md](configuration.md#placeholders).

A template with **no** placeholder at all (`npm test`) is legal: it runs the identical
command once per test case in scope and stamps each ticket with that run's result. That
is allowed — but it is probably not what you want, since one red suite blocks every
test case in scope.

## How the command runs

The line runs under the platform shell — `cmd.exe /d /s /c` on Windows (with verbatim
arguments, so the template's own quoting reaches `cmd` byte-for-byte), `/bin/sh -c`
elsewhere. That is what makes `npm` / `npx` (which are `.cmd` shims on Windows), pipes
and `&&` work; quoting rules are the platform's own.

- **Working directory**: the workspace root, or `tests.cwd` if set (see
  [configuration.md](configuration.md)). A `cwd` that does not exist aborts the run
  before anything spawns.
- **Idle timeout**: a run is stopped by **silence, never by age** — the same doctrine as
  AI runs and environment starts. A suite that keeps printing is never stopped, however
  long it takes; one that says nothing for `tests.idleTimeout` seconds (default 300) is
  killed — the whole process tree — and recorded as `timeout`.
- **Concurrency**: `tests.concurrency` commands run at once (default **1** — parallel
  test runs sharing one database bite people; opt in knowingly). The cap is **per
  window, not per batch**: a second Run Tests while one is going is queued behind it
  rather than refused, so at the default of 1 no two test commands ever overlap,
  whatever tickets the two batches cover. Batches take slots in turn rather than
  first-come-first-served, so the second ticket starts making progress instead of
  waiting the first one out.
- **One batch per test case**: a test case belongs to at most one running batch, whichever
  surface started it. A second Run Tests on a ticket already running is refused with a
  warning, and so is one whose subtree overlaps a running batch — *`TC-2.1.1.1 is already
  running as part of ST-2.1.`* — since running the same test twice into the same evidence
  folder helps nobody. Two batches over disjoint tickets are allowed.
- **Settings are snapshotted per batch**: saving `bfast.json` mid-run does not change
  the running batch's command, pattern or timeout. The next run reads the new values.
  `concurrency` is the exception, because it is a window-wide cap: it is read as
  each slot is taken, since a cap two batches disagreed about would not be a cap.

**Trust:** the command lives in a committed `.vscode/bfast.json` and runs on a click —
the same trust class as `tasks.json`. BFAST runs exactly what the file says; review it
like any other executable config when it arrives in a pull. VS Code itself enforces the
gate: the extension declares `capabilities.untrustedWorkspaces.supported: false`, so in
Restricted Mode BFAST does not run at all — that declaration is load-bearing and must
not be loosened without gating `bfast.runTests` on `workspace.isTrusted`.

## Cancelling

The progress notification is cancellable, and so is the board's **Stop** button — both reach
the same batch. Cancel kills every command currently running, **the whole process tree**: the
shell, the test runner it started, and the browsers that runner started (a `SIGTERM` to the
shell alone would leave a Playwright run recording on), and skips everything still queued;
test cases whose status was already written keep it. A command that had already exited when
the cancel landed is recorded normally — the test ran, its result is real. Closing VS Code
mid-run behaves like a cancel with no bookkeeping — statuses written so far are on disk, the
rest never happened. Closing a board tab does **not** cancel a batch: a batch is a fact about
the tracker, not about the tab that started it.

## The Tests tab

Every ticket's board has a third tab, **Tests**, beside Description and History. It is two
columns — what to look at on the left, the run on the right — and the board's ticket type
decides what the left column lists. Below 900px the columns stack.

- **A test case** lists its **run history** on the left, newest first — the verdict, when it
  ran and for how long, the exit code — and shows the selected run on the right: the rendered
  command, then the evidence — every video playing inline, images inline, a Playwright trace
  behind a **Show** button that opens the board's own trace viewer (below), `output.log` behind
  a disclosure that is open when the run failed, and every other file as a row with **Open**
  and **Reveal**. The newest run is selected until an earlier one is clicked, and a
  run that lands while the board is open shows itself unless an earlier one was picked.
- **An acceptance criterion, a story or an epic** draws its **hierarchy** on the left — its
  stories, their criteria, the test cases under each, in tree order; every test case wears its
  latest verdict or **Not run yet**, every story and criterion says how many of its test cases
  pass — and the selected test case on the right: the status pill, the key and title (a link
  to that test case's own board), and its **latest run only**, in full; a line under it says
  how many earlier runs its own board has. The first test case in tree order is selected until
  one is clicked. A criterion with no test case yet is still a row, carrying its warning, and
  an epic with such criteria says how many.
- **Run tests** starts a batch for the board's ticket; **Stop** cancels the batch the board's
  test cases are in — its own, or one a parent ticket started from the sidebar, which the tab
  follows just the same ("started from ST-2.1"). An epic's board that two disjoint story batches
  reach follows the first until it is done. While a batch runs, each test case row in the
  hierarchy is its lane — waiting, running, then its verdict — a test case's board shows a
  running row atop its history, and the log streams above the columns; when a test case
  finishes, its new run appears at once, video included.
- **A Playwright trace opens inline.** A `.zip` in a run's files is shown as a row with
  **Show**, **Open in Playwright Trace Viewer** and **Reveal**; Show asks the extension host to
  read the archive (the host, never the webview — it has `zlib` and the webview has no Node),
  confirms it is a trace (an entry ending in `.trace`; any other zip falls back to the plain
  row) and hands the board a compact report. The viewer is three parts: a **filmstrip** of the
  page's screencast frames across the top, scrubbable by time; the **actions** down the left —
  every call in order, nested by step, with its duration, a failed one red, an unfinished one
  marked; and the selected action's **detail** on the right — the screenshot **before** and
  **after** it (the last screencast frame at or before each end of the action), its **error**
  with the stack, the **console** messages and page errors, the **network** requests and the
  **source** location, each of the last three filtered to the action's time window (from its
  start to the next action's) and showing everything when no action is selected. A source
  location is a link: it opens the file in an editor at that line, mapped into the workspace
  when the trace was recorded elsewhere (a CI machine). Screenshots are fetched one at a time
  over the message bridge as they are shown — never the whole archive — and the filmstrip is
  capped at 40 frames. What the viewer does **not** do: DOM snapshots, pick-locator,
  attachments and the network body — those are Playwright's own viewer's, one click away.
  The reader is forgiving — an unknown event type is skipped, a broken line counted, a format
  newer than it knows (`version` above 9) is read anyway with a warning under the row — so a
  Playwright upgrade degrades the viewer, never the tab. Both trace files of a merged trace
  (the library's and the test runner's) are read and joined the way Playwright joins them, so
  a test step and the calls under it appear once. **Where the screenshots are depends on the
  trace's format**: up to format 8 a frame is `resources/<sha1>`, from format 9 (Playwright
  1.63 writes it) it is the `screencast/…` file the frame names. The reader follows each
  context's own `version` — `tests.traceFrames` (`auto` by default) can hold it to one layout
  instead, see [configuration.md](configuration.md). A format 9 trace read the format 8 way
  shows every action and no screenshot at all, which is what the setting is for.
- **Open in Playwright Trace Viewer** needs no configuration: with `tests.evidenceCommand`
  unset, BFAST finds the Playwright already installed in the workspace —
  `node_modules/playwright-core/cli.js`, `node_modules/playwright/cli.js` or
  `node_modules/@playwright/test/cli.js`, under `tests.cwd` first and the workspace root
  second — and runs `show-trace --stdin` with it, once per window: the first trace opens the
  viewer, later ones are handed to the same viewer over its stdin, and closing the viewer
  window lets the next click start it again. No Playwright in the workspace → a message saying
  so, with the two ways out (install it, or set the command). A configured
  `tests.evidenceCommand` **always wins**: a line the user typed is never silently replaced by
  a guess. On a remote workspace (Remote-SSH, WSL, a container) the viewer is served on
  `127.0.0.1` on a free port instead of opening a window there, and VS Code forwards that port
  and opens it in your browser — see [configuration.md](configuration.md#placeholders). The
  channel logs which `cli.js` ran and the viewer's own output.
- **Open** on a file the board cannot show runs `tests.evidenceCommand` with the file's path
  already quoted; with no command configured it reveals the file in the file manager. Text
  files open in an editor tab. A file whose name is not one BFAST would have written itself
  (the tracker is pulled from git) can only be revealed.
- A reloaded window brings the tab back where it was, with the recorded runs and no live
  state — a run was a child process the old session owned. A `git pull` that brings a
  teammate's runs reaches an open tab through the results folder's watcher, whether or not any
  ticket changed with it.
- **When a video will not play inline**, the player says why underneath, and what to do, and
  tells two failures apart that look the same (a grey box) and call for opposite advice:
  - *The bytes never arrived.* Over some remote connections (Remote-SSH, a tunnel) the editor's
    resource loader hands the player nothing it can demux — Chromium reports it as
    `DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed`, which reads like a
    codec problem and is not. The board fixes this one itself: on any first failure but an
    abort (the wording is Chromium's and differs between builds, so it is never trusted to say
    which kind this is) it asks the extension host for the file's bytes over the message
    bridge and plays them from a blob the webview owns
    (`media-src blob:` in the board's CSP, and a size cap equal to the copy cap). The caption
    then says "loaded directly from the extension host", and the "BFAST Tests" channel gets a
    `— Serving <file> … to <TC>'s board directly` line. **Open in editor** is the other way
    out — VS Code's own media preview, a different pipeline.
  - *The bytes arrived and the editor's player still refuses the container.* VS Code on Windows
    does this with VP8 WebM that Chrome plays (microsoft/vscode#195758): its demuxer says no
    while its decoders say yes. So the board has a player of its own for WebM — the file
    demuxed in JavaScript, each frame decoded with WebCodecs, drawn on a canvas, with play,
    a scrubber and the time — and the caption says "played by BFAST's own decoder". Nothing
    is installed, converted or written for it.
  - *The editor has no decoder for the codec at all.* VS Code on Windows reports no VP9 —
    neither `<video>` nor WebCodecs — and **Playwright records VP9 from 1.65 on** (its
    recorder hard-codes `-c:v libvpx-vp9`; up to 1.64 it was VP8). So when the decoder route
    fails, or the blob route fails on a file it cannot take, the board asks the host for the
    file **converted to VP8 WebM** (`testsMedia` with `convert: true`), and the blob and
    decoder routes run again on those bytes. The host runs `ffmpeg` from the PATH of the
    machine the extension host is on — on a remote, the remote one, where the file is —
    into a temporary folder of its own, removed afterwards: nothing is written beside the
    original, since the run folder's listing is the run's evidence. Playwright's bundled
    ffmpeg cannot do it (from 1.65 it has a VP9 encoder and no VP8 one). The caption says
    "converted to VP8 with ffmpeg on the extension host", and the channel gets a
    `— Converting <file> … to VP8` line. Tried **once**: a converted file that still fails is
    final. No ffmpeg is a sentence saying where to install it, not a crash.
  - *Every route fails.* Then the file is the problem, and the advice says that which codecs
    the editor decodes depends on its build and OS, that BFAST converts to VP8 with ffmpeg
    when one is installed on the extension host's machine, gives the `ffmpeg` line that
    converts to **VP8** (never VP9 — that is the codec missing where this bites), and says
    plainly that **installing codecs on the machine cannot help** — the player is the
    editor's own Chromium build, not the system's. Under that, the board asks the player what
    it *claims* to play (`canPlayType` for WebM/VP8, VP9, AV1, MP4/H.264, Ogg/Theora, the
    WebCodecs decoders, the Chromium version and OS) and prints the answer as one line a bug
    report can quote — and a verdict: a player with no VP9 anywhere is named as such; one
    that claims WebM/VP8 and still refused a VP8 WebM is the editor's build at fault (VS Code
    on Windows does this: microsoft/vscode#195758), not the recording.
- The video scrubber follows what the recorder wrote: Playwright's `.webm` carries no duration
  until it is fully buffered, so a scrubber that only fills in as it plays is the file's doing.

## Reporting

- A cancellable progress notification per batch tracks `<done>/<total>`, whichever surface
  started it.
- The **"BFAST Tests"** output channel streams every run: a `— Run Tests: <id> — N test cases`
  line, a `— TC-x started: <command>` line per test case (carrying the ticket's warning when it
  has one — a duplicate id, say, whose synthetic `#2` suffix will match no test name), the
  command's own output, then a `— TC-x passed (exit 0)` / `— TC-x failed (exit 1)` line — with
  `— 2 evidence files` appended when files were copied, `— evidence: <reason>` when a file could
  not be, and `— evidence could not be recorded: <reason>` when the folder itself could not be
  written. At concurrency above 1 the chunks interleave; the delimiter lines are the seams.
- A summary message ends the run — `Tests: X passed, Y failed.`, plus
  `N could not be run or recorded.` when test cases hit an `error` outcome and
  `Cancelled the rest.` after a cancel — with **Show Log** opening the channel. An
  aborted run's error message carries the tallies of what finished before the stop.
  The sidebar refreshes as statuses land, so the icons turn green and red while the
  run is still going, and every open board's Tests tab follows the batch live.
