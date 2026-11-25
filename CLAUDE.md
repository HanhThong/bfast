# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

BFAST is a VS Code extension that adds a "B" icon to the activity bar. Its sidebar is a native TreeView of
tickets (epic → story → acceptance criterion → test case) with a filter; clicking a ticket opens
the **BFAST board**, a webview editor tab showing and editing that ticket's description, plus its history.
Tickets are folders on disk under a configured tracker directory — see **On-disk format** below.

Two build outputs, two toolchains:
- **Extension host** — `src/**` (minus `src/webview`) compiled by `tsc` to `out/`, entry `out/extension.js`.
- **Webview UI** — `src/webview/**` (React + TSX) bundled by esbuild to `out/webview/`, one entry point per
  webview document: `main.js` + `main.css` (the board) and `settings.js` + `settings.css` (the settings form).

## Commands

- `npm run compile` — both halves (`compile:tsc` then `compile:web`)
- `npm run typecheck:web` — type-check the webview only (esbuild does not type-check)
- `npm run watch:tsc` / `npm run watch:web` — the two watchers; the default VS Code build task `watch`
  runs them in parallel, and F5 ("Run Extension") depends on it
- `npm run lint` — ESLint over `src/`
- `npm run verify:webview` — refuses a webview bundle still carrying a dynamic `import()`
  (in `pretest`); see **Rendering a description** below for why grep cannot do that job
- `npm test` — `pretest` compiles + type-checks + lints, then `vscode-test` runs Mocha in a real VS Code
- `npm test -- --grep "<pattern>"` — run a single test by name
- `npm run test:unit` — the suites that need no VS Code, in plain Node (seconds, not a window launch).
  Which suites those are is computed, not named: a compiled test is a unit test exactly when nothing
  it requires reaches `vscode` ([scripts/run-unit-tests.js](scripts/run-unit-tests.js) `--list` says)
- `npm run package` — production build (minified webview, no sourcemaps)

## Keeping the web docs current

**A change to a feature is not finished until the user-facing docs in [web-docs/](web-docs/) say it.**
`docs/` is the spec for whoever changes the code; `web-docs/docs/` (Docusaurus) is the manual for whoever
*uses* BFAST, and it drifts the moment a change lands without it. So whenever a change adds, removes or
alters something a user can see or do — a command or menu entry, a setting, a board or settings-form
control, an MCP tool or function, a sidebar behaviour, an error message they would search for — update
the matching page in the same piece of work:

- `guides/<feature>.mdx` — how to use it (environments, run-tests, mcp-server, board, …)
- `reference/settings.mdx` — every `bfast.json` field; `reference/commands.mdx` — every command;
  `reference/on-disk-format.mdx` — the tracker's files; `reference/troubleshooting.mdx` — new failure modes
- `getting-started/` — only when the first-run path changes

Write for a user, not a maintainer: what it does, how to reach it, an example, what can go wrong — not
the internals `docs/` and this file already hold. Then check it builds:
`cd web-docs && npm run build` (a broken link fails the build). A purely internal refactor, a test or a
fix that changes nothing a user sees needs no web-docs change — say so in the summary rather than
skipping silently.

## Source layout

Feature-first: a feature's store, commands, tree and panel live in its own folder, and three folders
hold what is shared. [docs/architecture.md](docs/architecture.md) is the map and
[docs/extending.md](docs/extending.md) the "to add an X, touch these files" list.

```
src/
  extension.ts      the composition root — which modules exist and what each is handed (~130 lines)
  modules/          one `activate<Feature>(core, deps)` per feature: builds its stores, views, commands
                    and serializers; `onSettingsApplied` is its reaction to a settings read
  platform/         `vscode`-free and shared by every feature: runProcess, shellCommand, idleWatchdog,
                    semaphore, providerRegistry, errors, exhaustive, workspaceSlug
  host/             `vscode` glue with no feature of its own: workspaceContext, pollWhileVisible,
                    outputProgress, revivable, webviewHtml
  shared/           the host ↔ webview seam, Node-free; `shared/protocol/` is one module per concern
  ai/ board/ commit/ data/ design/ environments/ implement/ mcp/ scan/ settings/ testing/   the features
  webview/          React, its own tsconfig and bundler
```

Four rules hold that shape, and each is mechanical rather than a convention:

- **A feature never imports a module**; `modules/` hands it what it needs. One feature's
  **live objects** — a store, a provider, a running batch — therefore reach another only as an
  argument in [extension.ts](src/extension.ts) (`resolveDirectory`, `hasEnvironment`, `startScan`).
  That is narrower than "features do not import each other": a feature folder still imports
  another's types and pure helpers directly (`mcp/mcpContext.ts` takes `EnvironmentStore` as a type,
  `scan/scanServerStore.ts` uses `environments/portAllocator`, `environments/environmentMcp.ts`
  uses `mcp/mcpClients`), and nothing lints that. ESLint (`no-restricted-imports` in
  [eslint.config.mjs](eslint.config.mjs)) refuses the import, and refuses `vscode` in `platform/`,
  `shared/` and `webview/`, and Node built-ins in the last two.
- **An optional block of `bfast.json` is one row of `SETTINGS_BLOCKS`**
  ([bfastSettings.ts](src/settings/bfastSettings.ts)): `parseSettings`, `normalizeSettings`, `isValid`
  and `validateSettings` all walk the table, and its mapped type makes a key added to `BfastSettings`
  without a row a compile error — the "silently dropped on the next write" trap, closed.
- **A seam's implementations are one table** handed to `configuredProvider`
  ([providerRegistry.ts](src/platform/providerRegistry.ts)); the forwarding is a `Proxy`, so an
  optional member reaches through exactly when the selected implementation has it.
- **A webview document has its own pair of message unions** (`BoardToHost` / `HostToBoard`,
  `SettingsToHost` / `HostToSettings`, …) and its panel's `switch` ends in `unhandled(message)`
  ([exhaustive.ts](src/platform/exhaustive.ts)), so a message added to a protocol and to no handler
  does not compile.

Where the notes below say `activate()` or `applyConfigured()`, read "the feature's module" and its
`onSettingsApplied`: the behaviour they describe is unchanged, and lives in `src/modules/`.

## Architecture

Navigation lives in the sidebar, content lives in the editor tab:

```
activity bar icon (media/bfast.svg) → view container "bfast" → view "bfast.sidebar"
  TicketTreeProvider (native TreeView)   title bar: new epic / filter / clear / refresh / board / settings
    │                                    title bar "…": shorten long folder names (docs/tracker/)
    │                                    item context menu: new child / generate children / status /
    │                                                       rename / reveal / run tests / implement /
    │                                                       commit ticket / delete
    ├─ right-click any ticket → bfast.runTests ──┐
    │    a board's Tests tab → [Run tests] ───────┴─ testBatches.start() → runTests() runs tests.command
    │         once per descendant test case (docs/tests/ is the spec) → each run filed in
    │         <tests.resultsFolder>/<TC id>/<runId>/ (TestResultsStore, outside the tracker),
    │         a status change only when the verdict moved it, log in "BFAST Tests",
    │         marks + video + Playwright trace on every board's Tests tab the batch reaches
    │           trace.zip → traceReader (zipFile + shared/playwrightTrace) → TraceReport →
    │           the tab's own viewer; "Open in Playwright Trace Viewer" → TraceViewerLauncher
    ├─ right-click any ticket → bfast.implement → implementTicket() (implement/implementCommand.ts)
    │    agent.availability() → buildImplementPrompt() (implement/implementContext.ts): the ticket's
    │    description inline; its ancestors (by parentId), its subtree two levels down, its design
    │    documents and tests.command by path → renderImplementPrompt() ← ImplementPromptStore ←
    │    .bfast/implement/<type>.md ← templates/implement/ → writeHandoff() →
    │    .bfast/implement/prompts/<id>.md → handoffSentence(path): the ONE string every agent gets
    │    → configuredCodingAgent() ← implement.agent
    │         ├─ ClaudeCodeAgent      executeCommand('claude-vscode.editor.open', undefined, sentence)
    │         ├─ ClaudeCodeCliAgent   a terminal with claude "<sentence>" typed, Enter left to the user
    │         └─ comingSoonAgent(id)  codex, codex-cli, opencode, opencode-cli, cursor, github-copilot
    │    nothing written into the ticket, no output channel: the tab or terminal is the report
    ├─ right-click an epic → bfast.generateStories   (a story → bfast.generateAcceptanceCriteria,
    │                                                  an AC → bfast.generateTestCases)
    │    └─ GeneratePanel — its own webview tab, "Generate stories — EP-1"
    │         form → planning → review → writing → done, all in the one tab
    │         └─ generateChildren() ← GeneratePrompts ← the panel
    │              pass 1: plan skill → parseTitleList → the tick list
    │              pass 2: write skill, once per kept title → store.createTicket
    ├─ click a ticket → vscode.open(bfast-ticket:/<id>) → custom editor "bfast.board" (docs/board/)
    │    single click = preview tab (italic, reused by the next click), double-click = pinned;
    │    bfast.openTicket(id) is the programmatic route and opens pinned → BfastPanel.register()
    │                                                   ├─ onDidShowTicket → provider.reveal(id): the
    │                                                   │    tree follows the board (open, or tab switch)
    │                                                   └─ one editor per ticket (VS Code's rule), titled
    │                                                      "<id> <title>": description + history +
    │                                                      tests + a tab per design document
    │                                                        └─ [AI Assistant] → agent + skill
    │                                                             .bfast/agents/ ← AgentStore
    │                                                             AiProvider ← configuredAiProvider()
    │                                                               ├─ ClaudeCliProvider  (default)
    │                                                               └─ ClaudeAgentSdkProvider
    │                                                             result → the draft, never disk;
    │                                                             over existing text → diff review
    │                                                               (approve / rewrite / cancel;
    │                                                                a rewrite re-reads the original)
    │                                                             other tickets → Edit + adoption
    └─ FileTicketStore ← TrackerContext ← SettingsService.current.trackerFolder
         └─ TrackerWatcher on **/* under that folder → refresh tree + reload board

view "bfast.scan" (third section — see docs/scan/ and **Code Quality** below)
  ScanTreeProvider ← ScanServerStore ← configuredScanProvider() (sonarqube)
    server row + endpoint + credential + recent runs; Deploy/Start → store.setup(): deploy →
    start → provision as one gesture, each step skipped when done
    right-click an environment → bfast.runScan → ScanPanel (webview tab) → scanRunner
      (scans that environment's worktree; Scan Workspace on the title bar scans the repo)
      → store.recordNote(id, 'scanned', …)   — a history entry, never a status change

view "bfast.environments" (second section — see docs/environments/ and **Environments** below)
  EnvironmentTreeProvider ← EnvironmentStore ← configuredEnvironmentProvider() (docker-compose | k8s stub)
    right-click a story/epic → bfast.createEnvironment: ports + git worktree + marker (create ≠ start)
    right-click an environment → Open in New Window → marker auto-opens the ticket's board

no view of its own — see docs/mcp/ and **The MCP server** below
  McpServer (node:http, Streamable HTTP on POST /mcp) ← applyConfigured() on every settings read
    off until mcp.enabled; saving starts it, restarts it, or stops it — there is no other gesture
    mcpProtocol (JSON-RPC + initialize/tools/list/tools/call) → mcpTools (the table, pure dispatch)
      → bfastMcpContext ← store | DesignStore | testBatches | EnvironmentStore | ScanPanel.requestStart()
    mcp.functions gates tools/list *and* every tools/call; a restart drops every session

activate() → SettingsService.read() → context key bfast.configured + provider.setConfigured()
  no .vscode/bfast.json → empty tree → viewsWelcome "[Init settings]" → bfast.openSettings
                                                              └─ SettingsPanel: webview tab with the form
                                                                   └─ Save → onDidChange → tree appears
                                                                          (the tab stays open — the MCP
                                                                           tab has a result to show)
```

## On-disk format

One folder per ticket, nested. Inside each: the description file named after the type, a `metadata.yaml`
and a `history.md`. Child tickets are subfolders.

```
.tracker/
  EP-1-Authentication/                        id: EP-1   Epic.mdx  metadata.yaml  history.md
    ST-1.2-Sign_in_with_email/                           Story.mdx …
      AC-1.2.1-Wrong_password_error/                     AC.mdx …
        TC-1.2.1.1-Unknown_email_same_error/             TestCase.mdx …
      TC-1.2.3-Smoke_login/                              (covers the story, not one AC)
    TC-1.3-Sign_up_then_sign_in/                         (a journey across the epic's stories)
```

A test case may sit under **any ticket but a test case** — under a criterion it proves that
criterion, under a story or an epic it walks several functions end to end (`write-test-case` and
`templates/implement/test-case.md` say so). The sidebar's eye button (`bfast.hideTestCases` /
`bfast.showTestCases`, context key `bfast.testCasesHidden`, kept in `workspaceState`) drops test
case rows in both tree modes — `TicketTreeProvider.setTestCasesHidden`, with an AC losing its
expander — and changes nothing else. docs/tracker/ §Where a test case can sit is the spec.

- **Folder name** is `<id>-<Slug>`: the ticket's full id, so a folder identifies itself without its
  ancestors having to be walked. The cost is path length — the id repeats every ancestor's ordinal at
  every level — so `folderName` holds the **whole name to `MAX_FOLDER_NAME` (40)**, the slug getting
  what the id leaves (never under `MIN_FOLDER_SLUG`). The number is a path budget, not taste: four
  levels of 40 plus `.tracker/` and `/metadata.yaml` is 186 characters from the repo root, leaving room
  under Windows' 260 for an environment's worktree under `%TEMP%` — the old 60-character slug cap had
  put a real tracker at 245, which git could not check out there. `slugifyTitle`'s cut keeps a word
  that ends exactly at the cap and drops a dangling `,`/`;`. A folder named under the old rule keeps
  its name (a slug is only ever read back as a title fallback); **Shorten Long Ticket Folder Names**
  (`bfast.shortenTicketFolders` → `longFolderNames` / `shortenFolderNames`, both optional on the store
  seam for the `folderUri?` reason) renames every folder past the cap to `folderName(resolvedId,
  title)` inside one `write()`, **deepest first** so no rename moves a path still to be used, skipping
  — never overwriting — a taken name, and with no `touch()`: a folder's name is not a change to the
  ticket, the `addAttachment` rule. docs/tracker/ is the spec.
- **Id** is `<PREFIX>-<every ancestor's ordinal>.<its own>`, so `AC-1.2.1` is the first AC of the second
  story of the first epic. Ordinals are counted **per type within a parent**, which is why `AC-1.2.1` and
  `TC-1.2.1` can both exist under one story — except that the types which can have children
  (`isContainerType`) share **one** sequence: an epic may hold **sub-epics** beside its stories
  (`allowedChildTypes('epic')` is `['epic', 'story', 'testcase']`, menu **New Sub-epic** → `bfast.newSubEpic`),
  and `EP-1.1` beside `ST-1.1` would give both a `TC-1.1.1.1`, since a tree id records only the leaf's
  type and `resolve` finds each ancestor by ordinal among the containers. So under an epic it is
  `EP-1.1`, `ST-1.2`; duplicate ranks key on `ordinalKey`, not the id, and on a clash the story keeps its plain id and the epic takes the rank, so a stray epic folder an older BFAST skipped can never rename an existing story. A tracker with no sub-epic is
  unchanged. docs/tracker/ §Sub-epics is the spec. **An epic and a story can trade types**
  (`changeType` / `planTypeChange`, menu **Change Type to Story / Epic**): the shared sequence is what
  lets the ordinal stay (`EP-1.2` → `ST-1.2`); the description file, metadata `id` and folder are
  renamed with one `changed — type` entry and an `updatedAt` bump; `typeChangeRefusal` refuses a
  top-level epic and any ticket still holding children the new type cannot, and the command refuses
  while the ticket has an environment. docs/tracker/ §Changing a ticket's type is the spec. `TicketSummary.key` stays the local segment (`AC-1`), so the
  sidebar label does not repeat the ancestry the tree indentation already shows. Two folders that
  resolve to the same id — a bad merge — both survive: the one the file system listed second takes a
  **rank** on that segment (`EP-1#2`, and its first story is `ST-1#2.1`), so a duplicate's descendants
  stay apart from the original's whatever order the levels are read in; `buildTreeId` / `parseTreeId`
  in `trackerPaths.ts` are that grammar, folder names and `metadata.yaml` never carry a rank (`parseId`
  stays strict, so one there is `id-drift`), and `key` shows a ticket's own rank but never an ancestor's.
- **`parentId` always comes from the nesting, never from parsing the id** — `TC-1.2.1.1` alone does not say
  whether its parent is an AC or a story. The id in a folder name and in `metadata.yaml` is therefore only
  a claim: only the ticket's **own** (last) ordinal is read back from it, the rest is the nesting's to
  decide. That is what makes a hand-renamed or hand-moved folder harmless — it gets an `id-drift` warning,
  not an orphan.
- **Renaming a ticket rewrites only the slug**, so no descendant folder has to move. **Moving a subtree
  does** require renaming every folder inside it, since each carries its full id; nothing in the extension
  offers that today.
- `metadata.yaml` is the authority for the local ordinal and every structured field (`id`, `title`,
  `status`, `assignee`, `createdBy`, `createdAt`, `updatedAt`); unknown keys a person adds survive a
  rewrite. The `.mdx` holds only prose. When the file's `id` disagrees with the one the nesting implies,
  structure wins, the ticket gets an `id-drift` warning and the next write heals the file. The same applies
  when the folder name's id disagrees.
- **Links between tickets** (blocks / is blocked by, relates to, duplicates / is duplicated by,
  clones / is cloned by) are stored on **both** tickets, each side in its own `metadata.yaml`
  under its own relation's flat key (`blocks: ST-1.2, ST-1.3` ↔ `blockedBy: ST-1.1`) —
  [ticketLinks.ts](src/data/ticketLinks.ts) is the Node-free table the store, the board and the
  MCP tools share. Both sides so a board draws its links without a tracker scan. `linkTickets` /
  `unlinkTickets` write one `linked`/`unlinked` entry per side and **no `updatedAt` bump** (the
  `addAttachment` reason); `changeType` re-points the other sides and `deleteTicket` takes them off
  the tickets that remain. A link whose ticket is gone is listed without a `target`. The board's
  Description tab ends in *Linked tickets*; **Link ticket** / sidebar **Link to Ticket…**
  (`bfast.linkTicket`) asks relation then ticket in two quick picks. docs/tracker/ §Links is the spec.
- `history.md` is append-only: `## <ISO timestamp> — <author> — <action>`, optional `- field:` / `- from:`
  / `- to:` bullets, then a blockquoted comment. `HistoryEntry.id` is positional (`${ticketId}#${index}`)
  and is not stored. A `from`/`to` that is multi-line or over 120 characters — a description — is written
  as a fenced block labelled `from`/`to` instead of a bullet, so an edit records the text on both sides
  and not merely that it moved. The one entry that may carry `to` alone is an **adopted** edit — an AI
  run's `Edit` of another ticket's file whose `from` the host could not vouch for (see **The AI
  assistant** below); better no claim than a wrong one, and `formatHistoryEntry` already omits an
  undefined side. Two details there are load-bearing: the block is **indented two spaces**
  (`parseHistory` ends an entry at the next `## ` in column zero, so an unindented description containing
  a heading would split its own entry), and the fence is one backtick longer than the longest run in the
  value (a description with a code block would otherwise close it early). Short values keep the bullet, so
  a status change looks exactly as it always did and existing files still read.
- **Technical design documents are files in the ticket folder**, beside `Story.mdx`:
  `ERD-1-Account_model.mdx`, `SEQ-2-Password_reset.mdx` — `<PREFIX>-<ordinal>-<Slug>.mdx`, the same
  grammar `folderName` gives a folder, with the ordinal counted **per style within the ticket**. Files
  rather than a `designs/` subfolder, and all three reasons are mechanical: `loadLevel` iterates only
  **directories**, so a `.mdx` is never a candidate ticket and costs the scanner nothing; `hasChildren`
  counts subdirectories, so a folder would put an expander on every epic and story that opened to
  nothing; and a ticket rename touches only its folder's slug while a delete is recursive, so design
  documents move and die with their ticket without a line of code. A style's prefix is therefore
  load-bearing and may not be `EP|ST|AC|TC` — a test pins that, since `parseFolderName` is anchored on
  exactly those. Structured fields live in the file's **own** flat frontmatter (`yaml.ts` again, as
  `SKILL.md` does), which is what gives each document its **own** `updatedAt`: sharing the ticket's
  would make saving a diagram fail the next save of a description someone had open mid-edit — the trap
  `addAttachment` documents below. `history.md` gets one `designed` entry per write via `recordNote`,
  never a status change and never an `updatedAt` bump. See **Technical design** below and docs/designs/.
- **`assets/` inside a ticket folder** holds the images its `.mdx` references as `assets/<name>`, written
  by `addAttachment`. It is created on first use, never by `createUnder` (a test pins that a fresh ticket
  is exactly three files), and the scanner skips it for free because it carries no content file and no
  `metadata.yaml`. `addAttachment` deliberately does **not** `touch()` the ticket: the board is mid-edit
  holding the `updatedAt` it read when Edit was pressed, so bumping it would make the user's own image
  insert fail their next save as a conflict — which is also why it writes no history entry.
- **Test runs are not in the tracker.** They live under `tests.resultsFolder` (default
  `.bfast/test-results`, workspace-relative, refused when it is or sits inside the tracker) as
  `<folder>/<TC id>/<runId>/` — `run.json`, `output.log` and whatever the `tests.evidence` glob
  matched, the run id being the start time (`2026-09-05T10-22-33.123Z`, `:` → `-`) — written by
  `TestResultsStore.addRun` in [testResultsStore.ts](src/testing/testResultsStore.ts) and never by the
  ticket store; see **Run Tests** below and docs/tests/README.md §Evidence. Keyed by **id**, flat, so a
  rename moves nothing and the board reaches a run from the id alone (`testCaseResultsFolder` writes a
  rank's `#` as `_`). A run is not a change to a ticket: it writes no history entry and no `updatedAt`
  bump, and only a verdict that *moves* the status reaches `history.md`, with a comment naming the run
  — the two histories are independent on purpose. `run.json` is written last, so a folder without one is
  a write that died and lists as outcome `unknown`; it is read forgivingly
  ([testRunFile.ts](src/testing/testRunFile.ts), the `historyFile.ts` posture), and **the directory
  listing is authoritative** — a name the file lists that is not on disk is only ever `missing`, never a
  url, because the folder may be pulled from git. `isSidecarPath` in `trackerPaths.ts` names `assets/`
  alone for the tracker watcher (below); the results folder has a watcher of its own on `run.json`
  ([testsModule.ts](src/modules/testsModule.ts)), which reloads open boards and never repaints the tree.
- **Reading is forgiving, writing is strict.** A folder with no `metadata.yaml`, junk YAML or a missing
  description file still loads with a warning shown in the sidebar's `TreeItem.description`; a folder that
  carries no ticket evidence at all (`assets/`, `node_modules/`) is skipped silently. An AC with no test
  case is flagged, never blocked — judged from its own folder listing (no subfolder at all), the same
  listing that sets `hasChildren`, so it costs no extra read. Writes re-read from disk immediately
  beforehand, run through an internal promise queue, and refuse a stale `updatedAt`.
- **Reading is by level.** `FileTicketStore` never scans the tracker unless asked to: `level(parent)`
  reads one folder (a `readDirectory` per child plus its `metadata.yaml`) and is memoised per parent in
  a *generation* — `invalidate()` swaps in a fresh generation rather than clearing the maps, because
  `write()` invalidates in its `finally` while a read's level load may still be in flight, and that
  load must land in the generation it started in. `listChildren(parentId)` is what the sidebar expands
  on; `getSummary` / `getDetail` **walk down** to a ticket (`resolve`, the inverse of `buildTreeId`: the
  id supplies only what to look for at each level, every level's contents come from the listing, so
  ancestry is still the nesting's); `listSummaries()` is the full walk, for the commands that need a
  subtree (Run Tests, batches, the Tests-tab report, the new-environment pick) and for the filter.
  `TicketSummary.hasChildren` comes from the listing already in hand and is deliberately
  over-inclusive — a stray folder makes an expander that opens to nothing, where the opposite mistake
  would hide a ticket. The environments section's titles and the scan tab's key go through
  `getSummary`, because both run on every poll and would otherwise force the very scan the lazy tree
  avoids.

## Agents and skills

`.bfast/agents/` in the workspace root — beside `.vscode`, not inside the tracker, because an agent
describes *how to write*, not a ticket. The extension ships the two halves separately and joins them
when it seeds:

```
templates/                              in the extension — the source of truth
  agents/AGENT-TEMPLATE.md              the role a new agent starts from;
                                        {{name}} and {{types}} are substituted
                                        as the file is written
  agents/business-analyst.md            a shipped role — epic, story, ac
  agents/product-owner.md               epic, story
  agents/solution-architect.md          epic, ac
  agents/qa-lead.md                     ac
  agents/test-engineer.md               testcase
  skills/write-epic/SKILL.md            problem / goals / non-goals / scope
  skills/write-epic/resources/expected-output.md
  skills/write-story/…                  "As a … I want … So that …", edge cases
  skills/write-acceptance-criterion/…   exactly one Given / When / Then
  skills/write-test-case/…              one runnable test for one criterion
  skills/break-down-epic/…               kind: plan — the story titles under an epic
  skills/break-down-story/…              kind: plan — the criterion titles under a story
  skills/break-down-acceptance-criterion/…  kind: plan — the test case titles under a criterion
  implement/epic.md                      Implement… — one prompt template per ticket type, the
  implement/story.md                     SKILL.md frontmatter grammar; seeded into
  implement/acceptance-criterion.md      .bfast/implement/ by ImplementPromptStore under the
  implement/test-case.md                 AgentStore rule (only when the folder never existed)
  implement/rules.md                     the working rules every template ends with ({{rules}}):
                                         the role/skill split — the standard lives once

.bfast/agents/                          in the workspace — a copy the user owns
  business-analyst.md                   the role
  business-analyst/write-epic/SKILL.md  its own copy of the skill
  business-analyst/write-epic/resources/expected-output.md
```

`templates/skills/write-acceptance-criterion/SKILL.md`, in full at the top:

```md
---
name: write-acceptance-criterion
description: One Given / When / Then. A negative case is its own criterion.
types: ac
---

An acceptance criterion is a test someone could run without asking you a question…
```

**Two levels, because they answer different questions and change at different rates.** The role is the
same whatever it is writing; the shape of an epic, a story and an acceptance criterion genuinely
differ. One file per agent would make every ticket type re-state the voice, and a change of voice touch
four files. `composeInstruction(agent, skill)` joins them — role, then `## <skill name>`, then the
skill — and is the single address for "what actually gets sent".

- **A file rather than a string in `bfast.json`**, which is where these started. They are long prose:
  they belong in an editor with wrapping and spell-check, in a git diff that reads, and shared with the
  team by being committed. `bfast.json` keeps only the mechanical settings (provider, model, turns).
- **Frontmatter is `yaml.ts`**, the same flat `key: value` reader `metadata.yaml` uses — no new
  dependency, and `types` is a comma- or space-separated list filtered through `TICKET_TYPES`, so a typo
  cannot invent a type. The body after the fence is the instruction, verbatim.
- **The skills decide what an agent can write**, not the role's own `types`: `AgentDefinition.types` is
  the union of its **write** skills'. The role's frontmatter is the fallback for a hand-written agent
  with no skills folder, which still runs on its role alone — so the single-file shape never stops
  working.
- **A skill has a `kind`: `write`, `plan` or `design`** ([agent.ts](src/ai/agent.ts), read through
  `skillKind`).
  A write skill shapes one ticket's prose and is what the board runs; a **plan** skill proposes the
  *titles of a ticket's children* and is what the sidebar's Generate commands run. They are a different
  contract — a plan skill's answer is parsed into a list by `parseTitleList`, never saved as a
  description — and telling them apart is not optional: a plan skill declares the type it **reads** (an
  epic), not the one it produces, and every lookup in `agent.ts` and `AgentStore` takes the *first*
  skill matching a type in directory order. Without the marker `break-down-epic` sorts ahead of
  `write-epic` and silently becomes the board's epic skill — and `templateSkill` seeds it into every
  role in place of the real one. So the invariant is **one skill per (kind, type)**, not per type:
  `resolveSkill` filters to `write`, `resolvePlanSkill` to `plan`, and `AgentStore.librarySkillFor`
  takes the kind as part of the lookup rather than filtering afterwards.
  The field is **optional and omitted when it is `write`**, so every skill file written before it
  existed keeps its meaning and does not gain a line on its next save — the same posture as
  `parseAiSettings` returning `undefined` when nothing survived. `kindFromSlug` infers it from a
  `break-down-…` folder name, so a `SKILL.md` stripped of its frontmatter still works, exactly as
  `typesFromSlug` does for the type.
  A **design** skill shapes one *technical design document* — an ERD, a sequence diagram — and is what
  a board's design tab runs. It moves the key one axis further: two design skills cover the same ticket
  types (an epic and a story both take either), so the type separates nothing and they are keyed by
  **`style`** alone. `AgentSkill.style` is a free string, because a style is configuration a workspace
  can invent. `resolveDesignSkill(agent, style)` and `AgentStore.designSkill` take no type at all, and
  `librarySkillFor(kind, type)` genuinely could not express this — hence `libraryDesignSkill(style)`
  beside it rather than a third parameter. `types` on a design skill is only the **seeding gate**, which
  is why `readTemplates` walks the *styles* once per role rather than the role's types: walking the
  types matched each design skill on the epic pass and again on the story pass, seeding the folder
  twice. Two more consequences are load-bearing and each has a test: `serializeSkill` omits `kind` only
  when it is `write` (it used to write the key only for `plan`, so a design skill was silently written
  back as a write one and would have shadowed the real one), and `parseSkill` defaults a design skill's
  types to `DESIGN_TYPES` — `typesFromSlug('design-sequence-diagram')` finds nothing, so without it a
  frontmatter-stripped design skill would cover nothing at all. `parseAgent` still counts only **write**
  skills toward `agent.types`, so seeding a design skill never makes a role claim it writes stories.
  A design skill also carries `label` and `prefix` — the style's menu name and the start of its
  documents' file names — because the skill *is* the style (see **Technical design** below); `label`
  falls back to the style id in title case, and a missing prefix is left for `stylesFromAgents` to
  refuse. `serializeSkill` writes `style` / `label` / `prefix` only when present, so no other kind of
  skill gains a line.
- **The prose lives in `templates/`, not in a `.ts`.** A role, four skills and four worked examples
  are long prose, and prose is unreadable and unreviewable once it is a `string[]` in source. As
  files they are edited in an editor and diff like anything else.
  [bundledAgents.test.ts](src/test/bundledAgents.test.ts) reads those same files, so a bad edit to
  one fails the suite rather than the first Generate.
- **Five roles ship, and they overlap on purpose.** Three write an epic, three write a criterion; the
  board’s picker is what chooses between them, and `resolveAgent` falls back to the first by name —
  which lands on Business Analyst for epic, story and AC, and Test Engineer for a test case. The point
  of a role is its voice and its standard of evidence, so a test asserts no two shipped roles share an
  instruction and each names its own job: five files that read alike would be padding.
- **A workspace therefore gets its own copy of a skill per role that uses it**, and editing
  `write-epic/SKILL.md` under Product Owner does not touch the analyst’s. That is deliberate — a PO’s
  epic and an architect’s epic genuinely want different shaping — but it does mean seeding writes ~23
  files, and a change everyone should share has to be made in each.
- **Roles and skills are separate folders in `templates/`, and joined only when seeding**, because a
  skill belongs to no particular role: how an epic is shaped is the same whoever writes it, and the
  shipped skills are written voice-neutral for exactly that reason — a test asserts none of them says
  "You are a…". One library beats a copy of `epic/` under every agent that writes one. In a
  *workspace* they are joined, so one agent’s skill can be edited without touching another’s.
  `readTemplates` is the one place a role’s frontmatter `types` is authoritative rather than a
  fallback: in the library there are no skills beside it to derive them from, so it is how a shipped
  role says what it should be seeded with.
- **A skill’s `name` is its folder, and starts with a verb** — `write-acceptance-criterion`,
  `break-down-epic`. The verb tracks the kind, so the folder name says which of the two contracts the
  file carries before anyone opens it, and a test in
  [bundledAgents.test.ts](src/test/bundledAgents.test.ts) holds the two prefixes to that. The format
  requires the two to match and a validator elsewhere complains when they do not, so `parseSkill`
  *overwrites* whatever the frontmatter said: structure wins, exactly as it does when a ticket’s id
  disagrees with its nesting. `skillLabel` derives the label from that slug ("Write acceptance
  criterion" — verb first, sentence case, since a skill is an action not a job title), so what the
  settings list, the board’s picker and the prompt heading all show is the folder the user would go and
  edit. The sentence a person wants to read goes in `description`.
- **`typeFromName` matches by word, not substring.** A folder named `write-epic` still has to say it
  writes epics — that inference is what keeps a `SKILL.md` stripped of its frontmatter working — but
  `write-fact` contains the letters of `ac` and must not become an acceptance criterion. It splits on
  non-letters and tries the whole name, then adjacent pairs (`test case`, `acceptance criterion`), then
  single words.
- **Resources are inlined into the prompt, not left for the agent to `Read`.** A run is one-shot; an
  example the model only sometimes fetches makes the output inconsistent for no benefit, and costs a turn
  when it does. `renderResources` fences each one with a fence longer than any run of backticks inside it
  — the rule `historyFile.ts` follows — so an example containing code cannot close its own block and
  spill back into the instructions. Past `MAX_RESOURCE_CHARS` a resource is named by path instead, which
  the agent can still read for itself.
- **A skill named after a ticket type infers it** (`epic.md` covers epics; `TYPE_ALIASES` also takes
  `acceptance-criterion`, `tc`, `stories`…), which is what makes such a file complete with no
  frontmatter at all. Explicit `types` still wins, so one skill can cover several.
- **Creating one asks for the ticket type; it never guesses from a name.** `createSkill(agent, type)`
  takes a `TicketType`, and the settings form and command both put a quick pick in front of it, offering
  only the types that agent has no **write** skill for — a second write skill for the same type would
  never run, since `resolveSkill` takes the first match. (A plan skill for that type does not count, or
  the form would refuse to add `write-epic` to an agent that only breaks epics down.) The earlier design
  took a free-text name, guessed, and fell back to `epic`, so every skill anyone made wrote epics
  whatever it was called. Creating a *plan* or *design* skill is deliberately not offered: the bundled
  fallback in `AgentStore.planSkill` / `designSkill` already covers every agent, and a bespoke one is a
  folder copy. A style a workspace invented has no bundled skill at all, and `undefined` is the honest
  answer there — the tab still edits by hand, and the AI button says which file to create.
- **Everything is scaffolded from the library, never from a stub.** `AgentStore.librarySkillFor(kind,
  type)` finds the shipped skill and `copyTree` copies the whole folder — `SKILL.md` and its
  `resources/` — verbatim, and a new role starts from `AGENT-TEMPLATE.md` with `{{name}}` and
  `{{types}}` substituted as the file is written (verbatim otherwise — lower-casing would turn
  `QA Engineer` into `qa engineer`). The point of creating a file here rather than by hand is that the
  user edits something that already reads correctly. The shipped skills are deliberately
  **voice-neutral**, which is what lets any role take the whole set.
- **Reading is forgiving here too**: no frontmatter, an unclosed fence or an unusable `types` all still
  load. An *agent* that names no valid type falls back to every type rather than none — one that
  silently appears nowhere reads as having vanished — while a *skill* with no inferable type covers
  nothing, because a skill that quietly applied everywhere would override the ones that were deliberate.
- **The output contract lives on the skill, not the role**, since the skill is the half that ends the
  prompt; a test asserts every built-in skill carries it. Without it a filesystem agent periodically
  decides the helpful thing is to edit the `.mdx` itself. The line still says "do not write or modify
  any files" — deliberately, since seeded copies in older workspaces say it too and generate runs stay
  read-only; a board run that *may* edit other tickets gets the exception stated in its `WRITE_POLICY`
  prompt block, which ends by overriding that line for other tickets only.
- **The built-ins are seeded, not hidden.** `AgentStore.list()` writes both role files and their skill
  folders when `.bfast/agents` has **never existed**, so the first visit to the settings form makes them
  real files the user can read and change. It keys on the folder being *absent*, not empty: an empty
  folder means someone deleted them on purpose, and putting them back would be the extension arguing
  with the user.
- **Which skill runs is not a choice** — a type decides it — so the board names it under the
  agent picker, using the same pure `resolveSkill` the host calls. That is the only way to tell what
  will happen before pressing Generate, and it names the file to go and edit when the shape is wrong.
  From the sidebar it takes **two** types: the **parent's** picks the plan skill (`resolvePlanSkill`,
  falling back to the bundled one), and the **child's** picks the write skill for pass 2.
- `slugifyAgentName` is lower-case and hyphenated — deliberately not `slugifyTitle`, which is built for
  ticket folder names and keeps case and underscores.

- [src/data/ticketTree.ts](src/data/ticketTree.ts) holds the pure tree logic: `buildTree` (flat list →
  roots via `parentId`) and `filterTree`. **Filter semantics:** a match keeps its whole related tree —
  every ancestor up to its epic *and* everything below it; unrelated siblings drop out. These functions
  have no `vscode` import, which is what makes them directly unit-testable.
- [ticketIcon.ts](src/ticketIcon.ts) owns the one icon rule — type picks the codicon, status picks the
  colour — and both the tree and the board tabs read from it, so a ticket cannot wear one icon in the
  sidebar and another on its own tab. They reach it by different routes, and that is forced: a `TreeItem`
  tints a `ThemeIcon` with its `ThemeColor`, but a **webview tab draws its icon as a picture and ignores
  the colour**, so `WebviewPanel.iconPath` has to be a `Uri` (a custom editor's tab inherits that
  `iconPath` unchanged). Hence `media/ticket/<type>-<status>.svg`,
  20 files generated from the same codicons with the fill baked in, and with fixed mid-tone hexes rather
  than theme colours — the extension host cannot read a theme's palette, and one file has to sit legibly
  on both a light and a dark tab bar. A new status needs its five icons, and a test in
  [extension.test.ts](src/test/extension.test.ts) fails if they are missing.
- [src/data/ticketTreeProvider.ts](src/data/ticketTreeProvider.ts) renders those nodes as
  `TreeItem`s, **a level at a time**: the root call is `listChildren()` — the epics, `Collapsed` — and a
  level is read only when its parent is expanded, so opening a large tracker costs one folder listing
  and a write's refresh re-reads only what is open. Never `Expanded` there: VS Code fetches every
  Expanded subtree at paint, which would be the full scan by another route. In that mode it **sets
  `TreeItem.id`**, so VS Code keeps the expansion and the selection across the refresh every write
  fires, and across a rename (without an id the handle is derived from the label). A **filter is the
  exception**: a search has to see everything, so it reads `listSummaries()`, runs `filterTree`, shows
  matches `Expanded` and sets **no id** — switching modes changes every handle, so entering a filter
  makes every node new and its `Expanded` applies, which is what puts a match on screen rather than
  behind a parent the user had collapsed. (The older note that an id makes VS Code "ignore
  `collapsibleState`" was not the mechanism: state is kept by handle either way.) It implements
  `getParent` and **`reveal(id)`**, which the board reaches through `BoardServices.onDidShowTicket` when
  a ticket opens or its tab becomes active, so the tree follows the board. `reveal` builds a node from
  `getSummary` when the ancestors were never expanded (matching is by the item's id, not identity),
  never takes focus, and **never shows a hidden sidebar** — `TreeView.reveal` would — so while the view
  is hidden, or the tree unconfigured, the id is parked and applied on the visibility event or the
  first root fetch. It also waits until the root has been served after the last refresh
  (`rootFetched`), plus one macrotask: `ticketCommands.create` refreshes and opens in the same tick,
  and a reveal racing that reload fails silently on the main thread. The latest ask wins, an already
  selected row is left alone, and clearing a filter reveals the ticket that was selected (or the last
  one a board showed) rather than dropping the user on a bare list of epics. `refresh()` drops the node
  index and, under a filter, the cached summaries.
- A native TreeView cannot host a text field, so the filter is a quick input box
  ([ticketFilter.ts](src/data/ticketFilter.ts)) whose `onDidChangeValue` re-filters on each keystroke.
  The `bfast.hasFilter` context key (set via `setContext`) drives the clear button's `when` clause.
- [src/board/](src/board/) is the board, split by concern: [bfastPanel.ts](src/board/bfastPanel.ts) is the
  tab — lifecycle, title and icon, which ticket, the description — and routes every message to a
  controller handed the narrow `BoardHost`: [attachmentController.ts](src/board/attachmentController.ts)
  (images), [testsController.ts](src/board/testsController.ts) (the Tests tab and the batches a board
  follows), [designController.ts](src/board/designController.ts) (design tabs) and
  [aiController.ts](src/board/aiController.ts) (the one AI run; where the notes below say `runAi`, it
  is there). `BoardServices` is grouped the same way — `ai?`, `designs?`, `tests` — so "no assistant"
  is one absent object rather than seven optional fields.
- [src/board/bfastPanel.ts](src/board/bfastPanel.ts) owns the boards, and **a board is a custom
  editor** (`CustomReadonlyEditorProvider`, view type `bfast.board`, `BfastPanel.register`) on the
  virtual resource `bfast-ticket:/<id>` ([ticketUri.ts](src/data/ticketUri.ts)). **docs/board/ is the
  spec.** The reason is that a `WebviewPanel` cannot be a preview tab (`WebviewPanelOptions` has no
  `preview` flag, `Tab.isPreview` is read-only) and an editor input can, so VS Code owns the tab: the
  tree item's command is **`vscode.open`** on that resource — the tree hands its open event
  (`preview` on a single click, `pinned` on a double-click) to `vscode.open` and `vscode.diff` and to
  **no other command**, which is why `bfast.openTicket` could not carry it — so a single click opens a
  preview tab the next click reuses, a double-click pins it, `workbench.editor.enablePreview` and
  `workbench.list.openMode` apply with no BFAST setting, `supportsMultipleEditorsPerDocument: false`
  gives **one editor per ticket** (open to the side *moves* the tab), and VS Code restores every board
  after a reload, title included — there is no serializer and no `revive`. `bfast.openTicket(id)` is
  the **programmatic** route (a create, a worktree marker, a board's link, MCP) and opens **pinned**
  (`BfastPanel.open`), since nobody clicked. The resource carries the **id alone**: a custom editor's
  label is the webview title when set (`CustomEditorInput.getName()`), so `panel.title =
  "<id> <title>"` (`EP-1 Authentication`, the bare id when the ticket does not resolve) and
  `panel.iconPath` keep working exactly as on a plain webview, and a rename changes nothing but the
  title; a title in the path was measured and is wrong (`/EP-3 Sign in/out` → `out`). Build it with
  `Uri.from`, never `Uri.parse`, or a rank's `#` becomes a fragment. **Working in a preview board
  pins it** (`pin()`: on `editStarted`, `saveDescription`, `aiGenerate`, `testsRun`, when the tab
  `isPreview`, reveal then `workbench.action.keepEditor`), the way a dirtied file is. There is **no
  blank board**: Open Board reveals the board last used (`revealLast`) or opens the tree's selected
  ticket, pinned. Panels live in an insertion-ordered `Set`, re-inserted whenever a tab becomes
  active, so the last entry is the board the user was last on. Titles come from ticket data, so
  `refresh()` in [trackerModule.ts](src/modules/trackerModule.ts) calls `reloadAll()` — a rename from the sidebar
  would otherwise never reach the tab, since the watcher stays quiet while the store is the one writing.
  `localResourceRoots` are `out/webview` **plus the workspace folders**, set in `resolveCustomEditor`.
  The workspace folders are there so a ticket's `assets/` images load, and they are the right granularity
  rather than the tracker folder itself: `validateTrackerFolder` refuses absolute paths and `..`, so the
  tracker is provably inside one, and a restore resolves *before* settings are read
  (`onDidChange` fires only from `write()`), so a root that followed `trackerFolder` would come back empty
  and 404 every image until the next save.
  `BoardServices.onDidShowTicket(id)` fires from `BfastPanel.open` — never from the instance
  `showTicket`, which `reloadAll()` calls for every open board on every watcher event — from
  `onDidChangeViewState` when a tab becomes active, and from `resolveCustomEditor` when the panel is
  active (a tab opened by a click, or the one VS Code restored as active); [boardModule.ts](src/modules/boardModule.ts) points it
  at `provider.reveal`.
  [src/settings/settingsPanel.ts](src/settings/settingsPanel.ts) is the same shape for the settings form, and
  [src/ai/generatePanel.ts](src/ai/generatePanel.ts) for the generate tab — that one keyed on
  (parent, child type), which unlike a board's ticket genuinely cannot change, so asking twice reveals
  the open tab and a second right-click can never start a second run on the same ticket. Those two are
  plain webview panels with serializers; the board is the one custom editor. All three get
  their CSP + nonce document from [webviewHtml.ts](src/host/webviewHtml.ts), which takes the bundle name
  (`main` / `settings` / `generate`) — a new webview document means a new esbuild entry point plus a
  `WebviewEntry` value.
- Extension ↔ webview messages are typed in [src/shared/protocol/index.ts](src/shared/protocol/index.ts) and are
  deliberately tiny: the board sends `ready` (its `selectedId` is React state only — the resource says
  which ticket a board is), `editStarted` (work began: the host pins a preview tab), `saveDescription`
  and the three image requests below, and the host replies with
  `ticketDetail` / `ticketSaved` / `ticketError` / `imageInserted` / `imageFailed`; the settings form
  sends `settingsReady` / `pickTrackerFolder` / `saveSettings` /
  `cancelSettings` / `openImplementPrompt` / `openImplementRules` and gets `settings` /
  `trackerFolderPicked` / `settingsSaved` / `settingsError`; the
  generate tab sends `generateReady` / `generateStart` / `generateChoose` / `generateCancel` /
  `generateReset` and gets `generateContext` / `generatePhase` / `generateLog` / `generateLane` /
  `generateProposed` / `generateCreated` / `generateDone` / `generateError`. The board's **Tests** tab
  sends `testsReport` / `testsRuns` / `testsOutput` / `testsRun` / `testsCancel` / `testsMedia` /
  `testsTrace` / `testsTraceFrame` / `openTraceViewer` / `openTraceSource` / `openEvidence` /
  `openTicket` / `openSettings` and gets `testsReport` / `testsRuns` / `testsOutput` / `testsProgress` /
  `testsError` / `testsMedia` / `testsTrace` / `testsTraceFrame` — the report, runs, output, run, cancel,
  trace and evidence messages keyed by the board's
  ticket id (the `requestId` idiom), `testsProgress` by the batch's root, the report tiered so
  an epic's first paint carries only each test case's latest run, and `testsProgress` wrapping the
  runner's own event union rather than re-stating it. The board's **design** tabs send `designOpen` /
  `designSave` / `designCreate` / `designRename` / `designDelete` and get `designDocument` /
  `designSaved` / `designError` / `aiSession`, keyed by the board's ticket id the same way — and
  deliberately **no**
  `designList`: the list of documents and the styles the **+** menu offers ride on `ticketDetail` and
  `ticketSaved` beside `assetBase`, so the tab bar is right on the board's first paint and a create in
  another window repaints this one for free. Both
  directions are a pair of unions **per webview document**, one module per concern under
  [shared/protocol/](src/shared/protocol/index.ts) (the board's is the join of `ticket`, `ai`, `tests` and `design`);
  each document takes its own typed `channel<ToHost, FromHost>()` from [vscodeApi.ts](src/webview/vscodeApi.ts). They still share
  one `setState` store, which is why `BoardState` and `GenerateState` are separate types intersected into
  one `PanelState` rather than one grab-bag interface. `BoardState` also carries the board's `tab`, so a
  reload lands back on Tests; it is written in the same whole-object `setState` as `selectedId` — and so
  is `aiModel`, the tab's model pick (`GenerateState.model` on a generate tab), which is why `app.tsx`
  reads it through a ref at every one of those writes: a whole-object replace that forgot it would
  silently reset the picker on the next tab switch. The
  report carries the board's subtree as `tree` — **structure only**: run data rides on the flat
  `testCases`, which a batch's `scope`, the panel's `reportedTestCases` and the `result` patch all
  read, and a tree leaf is looked up there by id. Which row is selected (`selectedTestCase` /
  `selectedRun`) is `TestsState` in the webview — not host state, and not `BoardState`, since a run
  folder may not survive a `git pull` and the default (first test case / latest run) is what a
  reload wants. A batch's `scope` is still the runner's flat list, not the tree.
- **Editing on the board:** `saveDescription` carries the `updatedAt` the webview last saw, and the store
  refuses the write when it no longer matches disk — otherwise a save would silently discard an edit made
  in an editor tab or pulled in from git. When the watcher re-sends a `ticketDetail` for the ticket being
  edited, the webview keeps the draft and shows a notice rather than replacing the textarea; see the
  `modeRef` in [app.tsx](src/webview/app.tsx), which exists because the message handler subscribes once and
  would otherwise close over a stale `mode`. The notice compares `updatedAt` rather than firing on any
  reload, because writing an asset leaves `updatedAt` alone on purpose and its watcher event can land
  after the write. That late event is also why [trackerWatcher.ts](src/data/trackerWatcher.ts) takes an
  `ignore` predicate (`isSidecarPath`, matched on the path **relative to the tracker root**): `assets/`
  never changes the tree, and its events land after `isWriting` has cleared — without the filter every
  image would cost a rescan and a reload of every open board.
- **Formatting and images.** The description is markdown in the `.mdx`. The toolbar has two kinds of
  control, both backed by the pure string maths in [markdownFormat.ts](src/shared/markdownFormat.ts):
  inline ones that wrap the selection (`**`, `*`, `<u>`), and block ones that rewrite whole lines — a
  text-level picker (Normal, Heading 1–6) and a bullet toggle. The block pair is mutually exclusive by
  design: a heading drops any bullet and vice versa, since `# - thing` renders as a heading beginning
  with a dash. `blockStateAt` drives what the picker and the bullet button show, recomputed on every
  caret move but returning the previous object when nothing changed, so arrow keys do not re-render the
  pane. A block edit on a *caret* leaves a caret (selecting the line would make the next keystroke
  overwrite what was just styled); on a selection it re-selects. Toolbar icons are inline SVG in
  [icons.tsx](src/webview/components/icons.tsx) using `currentColor` — the codicon font is not on a
  webview's classpath and would cost a dependency, a font file in `out/webview` and a wider `font-src`.
  Edits are applied through `document.execCommand('insertText')`
  so a toolbar click stays one native undo step and React still sees an `input` event —
  `setRangeText` is only the fallback, since it fires neither. Images reach `assets/` three ways:
  `pickImage` (host-side dialog, no bytes cross the bridge), `insertImage` (paste or a drop carrying a
  `File`, base64 because a webview may only post json-serializable values) and `insertImageFromUri`
  (a drag out of the VS Code explorer, which puts `text/uri-list` on the transfer and no `File`). All
  three carry a `requestId`, because the reply lands after a modal dialog or a disk write; `app.tsx`
  remembers the selection and the draft per request and appends rather than splices when the draft moved
  on. `assetBase` rides on `ticketDetail` / `ticketSaved` rather than on `TicketDetail`, which is the
  `vscode`-free domain model and must not learn about webview uris.
- **Rendering a description** goes through `marked`, one of the two devDependencies the webview bundles
  besides React (`src/webview/markdown.ts` is the only file allowed to import it — it stays out of
  `src/shared` because the root tsconfig is `module: Node16` with no DOM lib, and out of the host
  entirely — the **webview bundle** has no runtime dependency beyond React, `marked` and `mermaid`, and
  the *extension host* still has none but the Agent SDK, since `vsix` packages with
  `--no-dependencies`).
  [markdown.tsx](src/webview/components/markdown.tsx)
  maps marked's **tokens** to React elements and never touches `dangerouslySetInnerHTML`: a `<script>` in
  a description falls through to the `default` branch and is rendered as characters. `<u>` is the only
  html tag that renders, via a custom inline tokenizer, and link hrefs go through `safeLinkHref` in
  [markdownSafety.ts](src/shared/markdownSafety.ts) — an allow-list, because a description arrives from a
  git pull. Remote image srcs are named, not fetched, so opening a ticket cannot phone home; the CSP is
  unchanged (`asWebviewUri` maps workspace files into `webview.cspSource` too). `breaks: true` is set so
  a single newline still shows as one, the way `white-space: pre-wrap` used to make it.
  A ```` ```mermaid ```` fence is the one exception to "a code block is characters": it renders as a
  drawn diagram through [mermaidDiagram.tsx](src/webview/components/mermaidDiagram.tsx), **the only file
  allowed to import `mermaid`** (the `markdown.ts`/`marked` rule restated) **and the only file that
  writes `innerHTML`** — mermaid returns an SVG as a string, so something has to inject it, and
  `markdown.tsx`'s no-`dangerouslySetInnerHTML` invariant survives by confinement rather than by
  exception. `securityLevel: 'strict'` (mermaid's bundled DOMPurify) is what makes that safe for a
  description that arrived in a `git pull`, and `htmlLabels: false` is set now rather than when it
  first matters: ER and sequence diagrams use `<text>`, so it changes nothing until someone adds a
  flowchart style and `<foreignObject>` quietly starts carrying real HTML. `token.lang` is read as
  `'lang' in token` because marked's union ends in an open `Tokens.Generic` and a `switch` never fully
  narrows. Two mechanics are not free: `mermaid.parse` runs before `render` (which throws on bad syntax
  and can leave a measuring node on `document.body`), and the theme is re-read through a
  `MutationObserver` on `document.body` — VS Code sends a webview no message when the theme changes, and
  mermaid caches its palette at `initialize`. `mermaid` is pinned to an **exact** version because this is
  a bundling contract, not an API one: esbuild inlines a dynamic `import()` whose specifier it can
  resolve, but one it cannot is left verbatim and fails asynchronously against `default-src 'none'` —
  a blank tab with nothing in the Problems panel. `verify:webview` is that guard, and it uses
  TypeScript's **scanner** rather than a grep, because React ships the literal text `import(` inside an
  error-message string and a regex cannot tell code from a string. It costs the board's bundle: `main.js`
  goes from ~0.3MB to ~3.6MB minified, and the other three entry points are untouched, since
  `markdown.tsx` is reached only from `ticketDetail.tsx`.
- **Technical design** — an epic or story board grows a tab per design document: **+** on the tab bar,
  pick a style, name it. Three styles ship (Entity-Relationship Diagram, Sequence Diagram, Low Level
  Design), and **a style
  is a design skill**: there is no `design` block in `bfast.json`, a workspace adds a style by adding
  the skill that knows how to draw it, and `stylesFromAgents` in [agent.ts](src/ai/agent.ts) is the one
  rule the board's **+** menu, the store and the settings form all read — `BUILT_IN_STYLES` first, then
  every `kind: design` skill's `style` / `label` / `prefix`, agents in name order, first declaration
  wins, a prefix that collides or is a ticket prefix dropped with a warning the settings form shows.
  The first two styles are one diagram each; **Low Level Design is free-form on purpose** — no
  prescribed sections and any number of ```mermaid fences, or none — so the shape of a document is
  the *style's* business and not the kind's. What every design skill is held to is only what makes a
  document render: each diagram in its own fence, and no fence around the whole answer (a wrapped
  answer that carries no mermaid is the one shape `ensureMermaidFence` cannot rescue). Hence the
  "exactly one fence" assertion in [bundledAgents.test.ts](src/test/bundledAgents.test.ts) names the
  two picture styles instead of iterating `BUILT_IN_STYLES`. A
  design skill's folder is an ordinary skill folder — `SKILL.md` and `resources/expected-output.md` —
  and nothing more: **a new document is created empty**, and the board opens its tab with the AI
  assistant already open asking what to draw (`designSaved` for a document not yet in the list →
  `changeTab` + `setAiOpen`). A `template.mdx` starter existed briefly and was removed on purpose: a
  stock diagram was one more thing to delete before either asking the assistant or pressing Edit, and
  "template output resource" in the brief meant the expected-output resource every skill already has.
  `templates/skills/DESIGN-TEMPLATE/` is the folder a new style is scaffolded from, `{{label}}` /
  `{{style}}` / `{{prefix}}` substituted as it is written — the `AGENT-TEMPLATE.md` rule — upper-cased
  so it can never read as a slug, and skipped by `library()`.
  The settings form's **Design** tab is the AI tab's agents-and-skills list turned on its side: per
  style, the roles holding its skill with **Skill / Expected output** buttons (`openSkillResource` — a
  name, never a path from the webview), **Add to a role…**
  (`addDesignStyle`, copying the shipped folder or another role's) and **New style…**
  (`newDesignStyle`, three host dialogs then `createDesignStyle`). On a design tab the AI picker offers
  every role for a built-in style (the host falls back to the shipped skill, and the hint says so —
  "no skill" must never read as "no AI") and only the holding roles for a workspace style.
  **docs/designs/ is the spec.** Split the house way:
  [designDocument.ts](src/design/designDocument.ts) is the Node-free half — the style table, the file
  name grammar, the frontmatter, and `ensureMermaidFence` — imported by the webview *and* by
  `shared/protocol/`, the `testReport.ts` precedent; [designStore.ts](src/design/designStore.ts) is the
  `vscode` half, with a write queue of its own. `recordNote` runs **inside** that queue: split across two
  stores' queues there is a window in which neither reports busy and the tracker watcher rescans
  mid-write. `TicketStore.folderUri` is optional, so the store refuses explicitly rather than assuming a
  folder-backed tracker. The list rides on `ticketDetail` / `ticketSaved` beside `assetBase` — a separate
  `designList` round trip would leave the tab bar stale after every watcher event, and the tab bar is the
  first thing painted. `DetailTab` gains `` `design:${string}` ``, and the restore guard lives in the
  `ticketDetail` handler: a reloaded window comes back on the tab it left, and that document may be gone.
  The **+** menu is pinned beside `.detail-actions` and only the tab buttons scroll (`.tabs-scroll`) —
  overflow on `.tabs` itself would scroll the Edit and AI buttons away. The AI button is the same one:
  one run at a time whatever tab is up, `aiGenerate.design` says which, and only the skill resolved
  (`resolveDesignSkill`, by style) and the draft it lands in differ. `sanitizeAiDescription` runs against
  the **document's** title, then `ensureMermaidFence` — which exists because `unwrapFence` deliberately
  keeps an outer ```` ```markdown ```` wrapper when a fence appears inside it, and a design answer always
  contains one, so the saved document would be a code block holding a diagram and nothing would render.
  `package.json` `contributes` needed **nothing**: no command, no menu, no `when`.
- **The AI assistant** sits behind [aiProvider.ts](src/ai/aiProvider.ts) — an interface plus its
  request/result types and error classes, structured exactly like `ticketStore.ts` and with no `vscode`
  import. Two implementations satisfy it: [claudeCliProvider.ts](src/ai/claudeCliProvider.ts) (spawns the
  `claude` the user already has, **the default**, and costs no dependency) and
  [claudeAgentSdkProvider.ts](src/ai/claudeAgentSdkProvider.ts) (`@anthropic-ai/claude-agent-sdk`). Both
  map the *same* message stream through [messageStream.ts](src/ai/messageStream.ts), so they cannot drift.
  [providerRegistry.ts](src/ai/providerRegistry.ts) is itself an `AiProvider` that forwards to whichever
  the `ai.provider` setting names, read **at call time**, so the panel never learns there is a choice.
  Several details are load-bearing:
  - **`availability()` earns its place as a method**, not a boolean: the board paints the button before
    anyone presses it, a disabled button needs a reason for its tooltip, and — critically — the Agent SDK
    ships its binary through per-platform `optionalDependencies`, so a VSIX built on one OS carries none
    for the others. That failure has to degrade to a greyed-out button, never to a broken board.
  - **`ALLOWED_TOOLS` is `['Read','Glob','Grep']`, hard-coded, never a setting**, and a test asserts the
    exact array. It is the **default** every run starts from, and a generate run never leaves it; add
    `Bash` or `Write` and the AI button becomes arbitrary code execution driven by a description that may
    have arrived in a `git pull`. Both providers run in `permissionMode: 'dontAsk'` — deny whatever the
    allow-list does not cover, never prompt (a headless child has nowhere to answer) — **not**
    `bypassPermissions`, which approves everything regardless of the list and demanded a flag the SDK
    provider never set. The CLI adds `--restricted` on top.
    **A board run may also edit *other* tickets' description files** — the user's explicit decision,
    taken after the warning, and bounded mechanically rather than by prompt. `AiRequest.edits` (absent =
    read-only) carries `tools: ['Read','Glob','Grep','Edit']` and a per-run **settings file**
    ([trackerAdoption.ts](src/ai/trackerAdoption.ts) writes it to the temp folder, `--settings` /
    SDK `settings`) holding one `Edit(<path>)` allow rule **per content file that exists when the run
    starts** and a deny list: `Write`, `NotebookEdit`, `MultiEdit`, and the run's own ticket's file.
    Three facts from the permission spike shape that, and [trackerEdits.ts](src/ai/trackerEdits.ts)
    (pure) is where they live: `Edit` on a path that does not exist **creates** it, and an `Edit(...)`
    rule is a write-path rule that admits it — so the allow list names existing files one by one, never a
    glob, and `--tools` plus the deny list keep the other writing tools out entirely; a rule survives a
    comma or parenthesis in a folder name inside a settings file and not on the command line, which is
    why the rules travel in a file; and `--restricted` keeps `Edit` (it confines file tools to the
    working directory). `agentArguments` throws on any tool outside that closed set, and tests pin the
    default argv, the editable argv and the exact rule arrays.
    Whatever the run edited is then **adopted**: `messageStream` surfaces every `tool_use` with its id,
    `file_path` and `old_string`/`new_string`, the `user` message's `tool_result` (an `Edit` that was
    denied or missed its `old_string` looks identical in the request stream — only the result says it
    happened), and `permission_denied`; `TrackerEditLog` snapshots a file on the **first** event naming
    it (a `Read` is certainly pre-edit; an `Edit` may not be, and is marked `unsafe`, in which case the
    edits are reversed with `previousText` and an ambiguous reversal claims no `from`) and settles to
    the files an `Edit` succeeded on; `FileTicketStore.adoptDescription` then bumps `updatedAt` and
    writes the `changed / description` entry with `editProvenance` — or stands down (`superseded`)
    when the store wrote the ticket since the snapshot, because a board's Save already recorded that
    under its own author. Adoption runs on **every** exit of `runAi` — success, failure, Stop, a closed
    tab — before any `stale()` check, and `aiResult`/`aiFailed` carry `edited` so the board can say what
    happened. Without adoption a board open mid-edit on the edited ticket would see no drift and its
    next Save would clobber the agent's text silently. The run's own ticket is a deny rule and is never
    adopted: its answer is the draft. `TicketStore.ticketAt?` (the inverse of `folderUri`, walked by
    nesting, never by parsing a folder name) maps a reported path back to a ticket.
  - **`settingSources: []` / `--restricted`**: the user's own `CLAUDE.md`, settings and *hooks* are not
    loaded. A personal hook firing because someone pressed a button in a ticket tracker is both
    surprising and a hazard.
  - **The result lands in the draft, never on disk.** The host does not call `updateDescription` for a
    run — for the ticket being written. (An edit the agent made to *another* ticket's file is on disk
    already, and adoption above is what makes the store aware of it.) Capturing a `baseUpdatedAt` before a run that takes minutes would guarantee a
    `TicketConflictError` for every ticket touched meanwhile — turning a rare clobber into a routine
    failure that discards the generated text; passing none would silently clobber a `git pull`. Into the
    draft, the existing machinery handles it: the watcher fires, `app.tsx` keeps the draft and sets
    `staleOnDisk`, and the user's Save does the check with a value read at that moment.
    The sidebar's Generate commands **do** write, and that is not an exception to this rule but the
    same reasoning reaching the opposite end: the rule is about a `baseUpdatedAt` going stale across a
    long run, and a ticket that does not exist before the run has no `updatedAt` to go stale and no
    edit to overwrite. **A create cannot conflict.** What the user reviews there is the *list* of
    titles, before anything is written; each description then lands with the run's provenance in the
    `created` history entry, via `CreateTicketRequest.comment`.
  - **An answer over text that already exists is reviewed before it replaces it.** A run against an
    empty description (or an empty design document) lands in the draft exactly as it always did;
    anything else stops at a **diff** of the text on disk against the answer, with **Approve** (into
    the draft, then the user's own Save), **Cancel** and **Rewrite**. **docs/ai/review.md is the
    spec.** Nothing crosses the bridge for it — no protocol message, no host change: the answer
    already arrives on `aiResult`, and where it waits is the webview's. That is also what makes the
    feature's one rule free — **a rewrite is compared with the original, never with the answer before
    it** — because the host re-reads the file at the start of every run and nothing is written until
    Save, so keeping the answer *out of the draft* is what keeps the on-disk text both the diff's base
    and the text the next run is handed. [aiReview.ts](src/shared/aiReview.ts) states it a second time
    in `openReview`, which keeps the base of the review already open: it would be right today either
    way, but the invariant is what a test can hold. [textDiff.ts](src/shared/textDiff.ts) is the diff —
    hand-rolled for the reason `yaml.ts` and `zipFile.ts` are, lines by LCS over a `Uint32Array` with
    the common ends trimmed first and a whole-replacement fallback past `MAX_CELLS`, then words inside
    a removed/added pair alike enough to be one sentence rewritten (`SIMILARITY_FLOOR`; a short line
    that shares too little is shown whole, which a test pins). Both are `vscode`-free and Node-free,
    so the webview bundles them and the tests hold them without a DOM — the `aiPanel.ts` precedent. A
    review is **not persisted**: a reloaded window comes back without it, the way a reloaded generate
    tab comes back to its form and never to a run. The file moving underneath does **not** move the
    base — the answer really was written against what the diff shows — it is said, and carried into
    the editor's own `staleOnDisk` warning on Approve. The **Edit** button hides while a review is up,
    since the review's three buttons are the way out and an Edit there would discard the answer
    silently.
  - **The model is picked per tab, and the pick is a name the host checks.** `aiGenerate.model?` and
    `generateStart.model?` carry an alias or id from [models.ts](src/settings/models.ts) — or one
    typed into the picker's **Custom…** box — and absent means the workspace's `ai.model`.
    `aiModel(settings, pick)` in `aiSettings.ts` is the one address for that precedence, and it runs
    the pick through `isModelId` first: the value becomes an argv element (`--model`) or an SDK
    option, so it is sanitised the way an agent slug is resolved, never passed through on trust.
    `aiAvailability.model?` / `generateContext.model?` carry the setting the other way, so a picker's
    "Default" names what it is. Nothing new reports what ran: `AiResultMeta.model` and the
    provenance line already do, and the board's activity log gains the `Started — <model>` line the
    generate lanes always had. `pickModel?` on `GeneratePrompts` is optional the `continueSession?`
    way, so the scripted prompts in the tests needed nothing. docs/ai/models.md is the spec.
  - **A design run can continue the conversation the last one left**, and a description run cannot.
    The board's `aiGenerate` carries `continueSession`, a **boolean** — never an id, the
    `generateStart` rule — and the host resolves which conversation that is from its own store, sets
    `AiRequest.resumeSessionId` and records `result.meta.sessionId` when the run lands.
    [aiSessions.ts](src/ai/aiSessions.ts) is that store: the memento-backed half of
    `ai/generateSessions.ts` lifted out when a second flow wanted it, keyed by an opaque string
    so a generate tab can key on (parent, child type) and a board on (ticket, **document**) —
    `designSessionKey`, because two diagrams on one story are two conversations and resuming the
    ERD's to draw the sequence diagram hands the model the wrong document and the wrong contract.
    Its own `DESIGN_SESSIONS_KEY`, so the two flows never share a namespace with two grammars in it.
    Three details are load-bearing. `usableSession` is the **one** rule for whether a remembered
    conversation can be used — it exists, and the provider that ran it is the one about to run —
    asked by both the offer the board paints (`aiSession`, carrying only `at`) and the resume the run
    performs; split, a ticked checkbox could offer a session the run then silently ignored. The
    document still goes into the prompt on a resumed run, because a session remembers what it was
    told and not what the file says now — it may have been edited by hand, or by another window,
    since the last run spoke. And the session is recorded **before** the `stale` check that guards
    the reply, since the conversation happened whether or not the tab is still listening. There is
    deliberately no fallback to a fresh conversation when a resume fails: guessing whether a session
    file still exists is a second place for that answer to be wrong, so the run reports and the user
    unticks — the generate tab's rule, reaching the same conclusion. The description tab is offered
    nothing, because it has no second press to refine: its whole text goes into every prompt already.
  - **Credentials only ever live in `vscode.SecretStorage`** (`bfast.setAiApiKey` /
    `bfast.setAiOauthToken`), falling back to ambient `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`.
    `BfastSettings` deliberately has *no* field one could be typed into — `bfast.json` is committed to
    git. They reach a child only via `options.env` / `spawn`'s `env`; never assign to `process.env`, which
    is shared with every other extension in the window.
  - **`claudeSdkModule.ts` isolates one hazard.** The SDK is ESM-only and the host is CommonJS, so it can
    only be reached by a dynamic `import()`, which `module: Node16` emits verbatim into CJS output. The
    type query needs `with: { 'resolution-mode': 'import' }` or it is a TS1542 error, and
    `npm run verify:esm` (in `pretest`) greps the built file for `import(` — a tsconfig change that turned
    it into `require()` would otherwise break the feature at runtime only.
  - **An agent is a file, not a setting**, and its *skills* are the folder beside it.
    [agent.ts](src/ai/agent.ts) is the pure half — parse, serialize, `resolveAgent` / `resolveSkill` /
    `composeInstruction`, and the two built-in roles with their skills — and
    [agentStore.ts](src/ai/agentStore.ts) the `vscode` half that reads `.bfast/agents/`; see
    **Agents and skills** below. Nothing is cached: a run
    re-reads the folder, so a file saved in an editor tab takes effect on the very next Generate, and a
    `FileSystemWatcher` on `**/.bfast/agents/*.md` re-posts `aiAvailability` so every open board's
    picker follows. The board sends the agent's **slug**, never its text — the host resolves it, so the
    prompt it sends is never one the webview handed it.
  - The rest of prompt policy is pure and lives outside the providers: rendering in
    [promptTemplate.ts](src/ai/promptTemplate.ts) (an unknown `{{token}}` is left alone, because a
    description is markdown a person wrote), cleanup in [aiResult.ts](src/ai/aiResult.ts), and the
    system prompt in [systemPrompt.ts](src/ai/systemPrompt.ts) — BFAST's own string rather than the SDK's
    `claude_code` preset, which is tuned for changing a repo and reporting back.
  - **Progress is what says a run has not hung.** A generation takes minutes and is silent by default,
    so `messageStream.ts` surfaces two things it would otherwise drop: `system`/`thinking_tokens`, a
    counter that starts within a second and is the real heartbeat, and completed `thinking` blocks,
    which say what the agent is actually doing. A `tool_use` carries its `file_path` or `pattern`, so
    the log reads "Read src/auth.ts" rather than "Read". None of it reaches the answer.
  - **A run is stopped by silence, never by age** — [idleWatchdog.ts](src/platform/idleWatchdog.ts), which
    both providers arm and reset on every sign of life. The heartbeat above is therefore not only
    the *evidence* a run is alive but what *keeps* it alive. The wall-clock ceiling this replaced
    made “how long may a generation take” and “how long may it say nothing” one number, and they
    are not the same question: a breakdown of a large epic legitimately runs past any total anyone
    would pick, so the old three-minute cap killed runs that were streaming at the time. What each
    provider resets on is deliberately the **widest** signal it has — raw stdout/stderr chunks for
    the CLI, every yielded message for the SDK, including the ones `AgentStream.accept` ignores —
    because the question is only “is anything happening at all”, and a narrower signal would be a
    second place for that answer to be wrong. The watchdog is armed **at construction**, not by the
    first sign of life: a child that spawns and then says nothing is the exact case it exists for.
    It lives in `platform/` rather than in `ai/` because `platform/runProcess.ts` uses
    the same one — an agent's stdout and `docker compose build`'s raise the identical question —
    and out of `src/shared/`, which is the host↔webview seam. `ai.idleTimeout` (seconds) is the
    window; `DEFAULT_IDLE_SECONDS` is declared in `aiSettings.ts` rather than imported from the
    watchdog, so the settings **webview bundle** does not drag a Node-only module across, and a
    test pins the two numbers together instead.
  - **Stopping has to actually stop.** `kill()` reaches only the direct child, and `claude` spawns
    children of its own — on Windows those keep the inherited pipes open and `close` never fires,
    so the promise would never settle and Stop would do nothing visible. `CliRun.stop` therefore
    tree-kills (`taskkill /T /F`) and arms a `KILL_SETTLE_MS` fallback that settles from the output
    already collected — the same trap, and the same fix, `runProcess.ts` documents; the copy is
    deliberate, for the reason that module's comment gives. The SDK provider's equivalent is a race
    between the run and its abort signal: `execute` only notices `aborted` between two yields, so a
    wedged `query()` would park the loop for ever.
  - History records the change under **the human's** name — they pressed the button and pressed Save.
    The `comment` field, which `NewHistoryEntry` always accepted and nothing used, carries the provenance
    (provider, model, turns, cost), so spend is auditable in git. An adopted edit of another ticket is
    the one entry nobody pressed Save for: its author is still the human who ran the assistant, and its
    comment says so — "Edited by the BFAST “…” agent, while writing ST-1.2 (…)".
  - [fakeAiProvider.ts](src/test/fakeAiProvider.ts) is the seam's proof: if satisfying `AiProvider` ever
    needs a cast, a `vscode` import or knowledge of templates, the interface is in the wrong place. No
    test may call a real API or spawn a real `claude`. `answers[]` and `hangFrom` exist because a
    breakdown makes several runs: one fixed answer cannot exercise two passes, and holding pass 2 open
    while pass 1 resolved is the shape a mid-batch cancel needs.
- **Breaking a ticket down** — "Generate stories" on an epic, "Generate acceptance criteria" on a story,
  "Generate test cases" on an acceptance criterion — is split the same way everything else is:
  [generateChildren.ts](src/ai/generateChildren.ts) is the pure half (`planChildren`, `writeChild`,
  `RunHooks`) and [generateChildrenCommand.ts](src/ai/generateChildrenCommand.ts) the `vscode` one.
  It is a file of its own rather than more of `ticketCommands.ts`, whose deps are `{store, refresh}` and
  whose every command is a plain store write.
  - **Two passes, not one structured answer.** Pass 1 asks a plan skill for titles; pass 2 asks the
    shipped `write-story` / `write-acceptance-criterion` / `write-test-case` skill for one description,
    once per title the user kept. The shape of a story is the same however it was proposed, so a bespoke "return N
    descriptions" contract would be a second place for that shape to drift — and the unwanted titles
    then cost nothing.
  - **Pass 2 fans out, but the creates do not.** The runs are independent — each writes one
    description from a title and the parent, and nothing about one informs another — so up to
    `ai.concurrency` go at once, bounded by a hand-rolled `sharedLimiter` rather than a dependency —
    shared with every other generate tab, since the cap is the window's.
    The **creates stay strictly in the proposed order**, because `nextOrdinal` hands out ids in the
    order it is asked: letting them race would make `ST-1` whichever agent happened to finish first,
    throwing away the order the agent said to build them in. So every write is started, the consumer
    awaits them **by index**, and awaiting index `i` holds nobody up — the rest are already running.
    Two details are load-bearing: each write **settles to a tagged outcome rather than rejecting**
    (they are awaited in order, so a later rejection would go unhandled while an earlier one is still
    being waited on), and cancellation is read off that tag rather than a shared flag, which the
    consumer would otherwise see set by a *different* child that finished first.
  - **It all happens in [GeneratePanel](src/ai/generatePanel.ts), a webview tab — no quick pick and
    no notification.** The flow has three moments a modal cannot hold at once: a form, the minutes of
    log that say the run has not hung, and a list to tick through. A notification cannot be live while
    a quick pick has focus, so the two fought; and neither survives a click on the editor behind, which
    is a harsh way to lose a two-minute run. The tab is five screens in one document — `setup`,
    `planning`, `review`, `writing`, `done` — and **the host owns which one is up**: `phase` arrives on
    `generatePhase`, because it is the flow and not the view that knows whether a run is still going.
    It is **two columns** above 1000px, one below: controls on the left, activity on the right, with
    the right column `sticky`. With several agents at once the activity is a standing view, not
    something to scroll past to reach the controls.
  - **A row per agent, beside the log, not instead of it.** They answer different questions: `Agents`
    is "what is each one doing right now", which a chronological stream of a dozen interleaved
    heartbeats cannot show, and the log is "what has happened", each line prefixed with the child it
    came from. `waiting` is a real lane status and worth rendering — with a concurrency of three and
    eight titles, five have not started, and a row that is simply absent reads as one that was
    dropped. A lane turns `done` when its **ticket** is created rather than when its run finished, so
    it is not a measure of concurrency; `FakeAiProvider.running` is what a test asserts on.
  - **The panel is a `GeneratePrompts` and nothing more.** Every decision still lives in
    `generateChildrenCommand.ts`; the panel turns each ask into a message and each reply back into a
    promise. `pickAgent` and `askInstruction` never wait — the form asks for both in one submit, so the
    answers are already in hand — and the agent is matched back **by slug**, so the host still resolves
    what actually runs. `withProgress` takes a `GenerateStep` rather than only a title, because the tab
    has to know which screen it is on and parsing that out of a display string is a rule nobody would
    remember to keep. `created()` fires per ticket, so the list fills in with the run.
  - **Nothing is written until the user has seen the list.** Everything arrives ticked — the agent
    proposed them, and unticking is the cheaper gesture — and `generateChoose` sends them back in the
    **proposed** order rather than tick order, since that is the order the agent said to build them in
    and it becomes the ids.
  - **The review screen is a conversation, not a form.** A follow-up typed under the list ("split the
    third one, drop billing") goes back to the *same* Claude session — `AiRequest.resumeSessionId`,
    which the CLI provider turns into `--resume <id>` and the SDK provider into `resume`; both already
    reported the id on `AiResultMeta.sessionId`, and this is the first thing that reads it — and the
    list is **replaced, never diffed**: `buildResumedPrompt` restates the skill's output contract
    (`TITLE_LIST_FORMAT`) and asks for the complete updated list, because a model answering a
    follow-up otherwise returns only what changed. It deliberately does not call `buildPrompt`: the
    skill, the parent and the first instruction are already in the session. So `pickChildren` answers a
    `ChildrenChoice` — `create`, `refine` or back out — and `generateChildren` loops on it under a new
    `refining` step; Stop during a refine cancels that run only, and a failed or empty one reports and
    returns to the list the user had. That exposed a latent trap in `stopRequested`: it was cleared only
    on `generateStart`, so a Stop that ended a refine would have cancelled the writing the user then
    started — `withProgress` now spends it once. The transcript is the **host's** (`generateProposed`
    carries the `followUps` the list reflects), so the webview never appends optimistically and a
    stopped follow-up stays in the box to retry. Pass 2 stays fresh and parallel; `combineInstruction`
    — the form's instruction plus every follow-up, in order — is what carries the refined direction into
    each description and into `provenance`, and is byte-identical to the instruction when there were
    none. The session is remembered per (parent, child type) in **`workspaceState`**
    ([generateSessions.ts](src/ai/generateSessions.ts)), never in `metadata.yaml`: a Claude
    session is a file under `~/.claude/projects/<cwd>` on this machine, and committing its id would
    hand a teammate one that resolves to nothing. It is offered — ticked by default, via
    `generateSession` after the context and after every run — only when the current provider is the one
    that ran it, and the webview asks with a **boolean** (`continueSession`), never an id, the way it
    sends an agent's slug. A resume that fails says to untick and start fresh; there is no automatic
    fallback, because guessing whether a session file still exists is a second place for that answer to
    be wrong. A continued batch tells the agent which titles are now tickets and asks for the missing
    ones only, and `dropExisting` filters any sibling a run repeats anyway — on every plan result, with a
    log line, since a silently shorter list reads as a model that miscounted. `agentArguments` is
    exported so `--resume` and the policy flags are assertable without the spawner seam ever taking an
    argv.
  - **Cancel is a message, not a token.** The panel owns a `CancellationTokenSource` per step and fires
    it on `generateCancel` or on the tab closing — closing is as clear a stop as pressing the button,
    and the log it was reporting into is gone either way. `RunHooks.onCancel` is handed the run's
    `cancel` the instant `ai.run` returns, and checks `isCancellationRequested` as well as subscribing:
    the button can be pressed before the child process has even spawned.
  - **Stop is red, and it is up before the host has spoken.** A live run is a child process costing
    money and rate limit, and the grey `button secondary` it used to wear read as “dismiss this”.
    `.button.danger` borrows the status bar's error pair — no theme defines a danger *button*, and
    those two are registered by every one. The board needs nothing else, since `app.tsx` sets
    `status: 'running'` synchronously on click; the generate tab does, because `phase` is the host's
    and does not arrive until after a `getDetail`, an agents read and an availability probe. So the
    tab flips the button itself (`starting`) and hands authority back on the first `generatePhase`
    or `generateError`. That gap used to be uncancellable as well as unlabelled, hence
    `stopRequested`: a press with no token source yet is remembered and spent on the first one
    `withProgress` makes. And `run()` posts its terminal `done` from a **`finally`** — with an
    optimistic Stop on screen, a rejection escaping there would leave the tab showing a Stop button
    for a run that is not happening, with no way back to the form.
  - **`retainContextWhenHidden` is load-bearing here**, unlike on most webviews: the log is the only
    proof a long run is alive, and rebuilding the view on every tab switch would throw it away. The
    serializer brings a reloaded tab back to its **form**, never to a run — a run was a child process
    that session owned, and a log that never advances again would be a lie.
  - **Three failure rules, each deliberate.** A cancel mid-batch **keeps** what was already created:
    `nextOrdinal` never reuses a retired id so a rollback leaves a gap anyway, it would race the
    `TrackerWatcher`, and the user cancelled because they had enough. A failed pass-2 run still creates
    its ticket, empty, and the batch continues — the title was the user's choice, and one flaky run must
    not discard four good ones. And `running` is a `Set` keyed on **(parent, child type)** — the pair a
    generate tab is keyed on — not the module-wide boolean it started as: two batches under *different*
    parents draw ordinals from disjoint sibling sets and the store's queue serialises the writes either
    way, so refusing ST-1.2 while ST-1.1 was going was never protecting anything. What it does hold is
    the one case that would interleave a single id sequence into an order nobody can read.
  - **`GeneratePrompts` is why any of this is testable.** Every ask and every report goes through it,
    so [generateChildren.test.ts](src/test/generateChildren.test.ts) drives the whole flow against a
    real `FileTicketStore` and a scripted `FakeAiProvider`, asserting the step order, the log lines and
    each ticket as it lands. A test that had to click through a webview would test none of the parts
    that matter. Nothing in the flow may open a dialog: the tab is the only surface, and the one
    surviving `showWarningMessage` guards a command invoked with no tree node, which the menu's `when`
    clause makes unreachable.
  - **`parseTitleList`** is in [aiResult.ts](src/ai/aiResult.ts), beside `sanitizeAiDescription` and
    tolerant for the same reason: the skill asks for `- one per line` and a model periodically numbers,
    bolds or fences them. A line that is not a list item is **dropped, never appended to the one
    before** — that is what makes a preamble and a trailing "Let me know if…" free, and a stray sentence
    turned into a ticket is worse than a missing one. A fence *marker* is dropped but its contents are
    still read, unlike in a description: a title list has no code block to protect. The last resort is
    "every non-empty line, when they all still read like titles", which rescues an unmarked list without
    turning a paragraph into tickets — a paragraph is one long line.
  - **An acceptance criterion is created with `createTicket`, not `createAcceptanceCriterion`**, so it
    arrives with no test case and the ordinary `No test case yet` warning. The alternative would be
    inventing a test-case title per criterion in the same breath, which is the shape `write-test-case`
    exists to get right one at a time — and "Generate test cases" on the criterion is that route.
  - **A criterion is the one parent with rules of its own**, both keyed on `parent.type === 'ac'`.
    It is **refused before any run** unless its description says Given, When *and* Then
    (`hasGivenWhenThen`: by word, any case, bold or not): a test case's preconditions, steps and
    expected result *are* those three, and without them the agent would invent the test. And its
    **story reaches both passes** as `grandparent` — pass 1 as the plan prompt's parent block, pass 2
    inside the criterion's (`PromptContext.grandparent`, rendered by `parentBlock`, so `{{parent}}`
    carries both) — because a criterion names neither the screen nor the user and its story does. A
    story or an epic carries its own context, so a story's breakdown still never sees its epic. How
    many test cases is `break-down-acceptance-criterion`'s to say, and it says "one per requirement
    the criterion states" rather than a range: there is no quota to pad to. It is seeded by the
    ordinary rule — into the roles that write an `ac` — so Test Engineer, the one shipped role that
    writes test cases, runs the library's copy through `planSkill`'s fallback, exactly as Solution
    Architect and QA Lead already do for `break-down-story`.
- **Environments** — the sidebar's second section (`bfast.environments`): one disposable dev
  environment per story or epic — a `git worktree` on branch `story/<id>` / `epic/<id>` (the prefix
  comes from the ticket id's own `ST-`/`EP-`; anything else falls back to `bfast/`) under
  `<worktrees home>/<workspace-slug>/` — `environments.worktreesFolder` or, absent, `<os temp>/bfast-worktrees` — running the repo's stack under a per-story project
  name (`bfast-st-1-2`). **`docs/environments/` is the spec** — written before the code, and the code
  must keep matching it; the stack contract (exact CLI, port variables, isolation rules) lives there,
  not here. The shape repeats the AI assistant's, on purpose:
  - [environmentProvider.ts](src/environments/environmentProvider.ts) is the `vscode`-free seam
    (descriptor, statuses, operations, error codes) with two implementations —
    [dockerComposeProvider.ts](src/environments/dockerComposeProvider.ts) (the default) and the
    [k8sProvider.ts](src/environments/k8sProvider.ts) stub — behind
    [environmentRegistry.ts](src/environments/environmentRegistry.ts), which reads
    `environments.provider` **at call time**. `stackEnvironment()` is the one address for every
    variable a stack receives (allocated ports + `BFAST_TICKET_ID` + `BFAST_PROJECT_NAME`); a provider
    is handed the descriptor per operation and reads its own settings via
    [environmentContext.ts](src/environments/environmentContext.ts) — never git, the marker, or port
    allocation, which belong to the store.
  - [environmentStore.ts](src/environments/environmentStore.ts) is the heart, `vscode`-free with
    everything injected (`ProcessRunner` for git, the provider, the port probe), which is what lets
    [environmentStore.test.ts](src/test/environmentStore.test.ts) drive the whole lifecycle against
    fakes and a scratch folder. Its inventory is **derived from disk** — `list()` scans the markers
    (`.bfast/environment.json` inside each worktree) and asks the provider for live status; the only
    in-memory overlays are the in-flight operation and the last failure, both UI rather than
    inventory. Writes go through a **per-environment queue** (the `FileTicketStore.write` shape), so
    Start can never race Stop on one environment; the `active` counter, decremented in a `finally`,
    is the busy truth — the queue map lingers after settling and must not be used for that.
  - **Create is not Start**, a create-failure cleanup removes the half-made worktree only because the
    marker never landed (nothing user-visible existed), and Delete destroys the stack **with its
    volumes** then the worktree but **keeps the branch**. A cancelled or failed operation rolls
    nothing back and leaves `error` with the reason until a later operation succeeds.
    `removeWorktree` never takes git's word for the folder being gone — it verifies and falls back
    to `rm` with retries (container-created files defeat `git worktree remove` silently). The
    provider seam has an optional **`reclaim`** — make the worktree deletable by the invoking user —
    which the docker provider implements as a `chown` via a throwaway `alpine` container (Linux
    only); the store runs it right before *every* folder removal. It is deliberately **not** part of
    `destroy`: a half-deleted worktree may have lost its compose file, and the chown must still
    work then. A **markerless** leftover folder is cleared by the next create rather than
    dead-ending the ticket (best-effort destroy with a synthetic descriptor, then reclaim, then
    `removeWorktree`); only a folder carrying another workspace's marker is refused.
  - **Long paths on Windows.** Every git command in
    [gitWorktree.ts](src/environments/gitWorktree.ts) goes through `git()`, which prepends
    `gitArgs`' `-c core.longpaths=true`: Git for Windows refuses a path of 260 or more (a folder's
    248) without it, whatever `LongPathsEnabled` says, and a worktree sits deeper than its repo, so a
    tracker that fits the repo failed the worktree's checkout. Other gits ignore the key, so the argv is
    the same everywhere. That fixes BFAST's own git but not the user's — the worktree window's Source
    Control reads config — so on `win32` (`EnvironmentStoreDeps.platform`, pinned to `'linux'` by the
    store tests' `makeStore` so every machine runs one git sequence) `create()` then runs
    `enableLongPathsIfNeeded`: `ls-files -z` inside the worktree (no `onOutput` — a big repo's listing
    would bury the log), `windowsPathOverflow` against the two limits, and only when something
    overflows and the effective value is not already `true`, `git config core.longpaths true` in the
    repo (`.git/config`, shared by every worktree), said in a phase line. The read of the current value
    is the one call made **without** the flag (`run`, not `git`): `--get` reads the command line's
    `-c` too, and would only ever find BFAST's own. Best-effort — a failed check is a phase line and
    the create goes on; a cancel still cancels. docs/environments/README.md §Long paths on Windows is
    the spec.
  - **The master environment** is the same stack run in the **workspace folder itself** —
    no ticket, no worktree, no git. `EnvironmentDescriptor` is keyed by **`id`** (the ticket
    id, or `MASTER_ENVIRONMENT_ID = 'master'`), carries `scope: 'ticket' | 'master'`, an
    optional `ticketId`, and **`projectName`** — `environmentProjectName(ticketId)` for a
    ticket, derived in `markerToDescriptor` and never stored; `bfast-master-<workspace-slug>`
    (`masterProjectName`: the worktrees root's basename re-slugged) for master, **recorded
    in its marker** so Start and Delete cannot disagree after a folder rename. The slug is
    not decoration: two repos sharing `bfast-master` would share one stack, and Delete on
    either would `down --volumes` the other's. Its marker is `<worktrees root>/master.json`
    (`MASTER_MARKER_FILE`) — a *file* beside the worktrees, never in the repo, so it cannot
    be committed, `resolveWorktreeHome` never sees it, and a worktree window finds it by the
    same parent-folder rule as its siblings. `EnvironmentMarker` is a discriminated union
    (`scope` is never written for a ticket, so old files stay byte-identical), and a
    master-shaped marker *inside* a worktree folder is skipped by both `scanMarkers` and
    `resolveWorktreeHome` — which is what keeps `WorktreeHome.marker` a ticket's and
    `maybeOpenEnvironmentBoard` type-safe. `createMaster()` reads that file **raw** rather
    than through `scanMarkers`, which filters another repo's marker out, so a same-named
    workspace's master is refused with `'exists'`, never overwritten. `remove('master')` is
    destroy + `rm` the marker and nothing more, and `reclaimWorktree` returns early on
    `scope === 'master'` *structurally*: a recursive chown of the workspace is not this
    feature's to run. `branch` is the live checked-out branch, read from `.git/HEAD` by
    [gitHead.ts](src/environments/gitHead.ts) at list time (no spawn — `list()` polls every
    10s; walks up, since the workspace need not be the git toplevel), `''` when unknown.
    `stackEnvironment` sets `BFAST_TICKET_ID` to `''` — set, never missing — and
    `BFAST_PROJECT_NAME` from `projectName`; providers read only `worktreePath` and
    `projectName` and never branch on scope. The tree row is `Master`, first in the list,
    with `contextValue = environment:<status>:master` — a suffix, so every prefix-matching
    `when` keeps applying and the two that must not (`openEnvironmentWindow`,
    `revealEnvironment`) opt out with a `$` anchor. `bfast.runScan` on it calls
    `openScan()` — Scan Workspace — spelled out rather than left to `ticketId` being
    `undefined`.
  - **A worktree gets its own MCP port at create** ([environmentMcp.ts](src/environments/environmentMcp.ts),
    `vscode`-free, called by `create()` after the long-path step and before the marker): the
    checkout carries the committed `bfast.json`, so its window would ask for the workspace's
    port and its `.mcp.json` would aim Claude Code at the workspace's server. Only when the
    checkout's `mcp.enabled` is true: the first port **above** the configured one that is not
    reserved and binds (the store's `portProbe`) — never the configured port itself, which is
    the workspace's whether or not its window is open. It is recorded as the ticket marker's
    `mcpPort`, and `reservedPorts` counts every marker's, because a closed window listens on
    nothing and the probe alone would hand it out twice. The settings file is rewritten
    **raw** (spread, not `normalizeSettings`, which would drop unknown keys), then each
    `MCP_CLIENTS` project file through `retargetMcpClientConfig` — the `bfast` entry only,
    and only when its url names the old port. Then `skipWorktree` in
    [gitWorktree.ts](src/environments/gitWorktree.ts) marks the tracked ones
    `--skip-worktree` — a bit in the **linked worktree's own index**, so the workspace and
    every other worktree are untouched, and `git add -A` can never carry the port back with
    the branch. Best-effort, the `enableLongPaths` posture: a failure before the settings
    write is a phase line and no `mcpPort`; one after it is collected in `problems` and the
    port is still returned, since the file already names it. The master environment has no
    worktree, so nothing here applies to it.
  - The worktrees live **outside the workspace**, where a `RelativePattern` watcher does not fire —
    so [environmentsModule.ts](src/modules/environmentsModule.ts) polls (`pollWhileVisible`: 10s, only while the view is visible) instead of
    watching, and every command refreshes explicitly. The marker is also what makes a worktree
    window self-describing: `resolveWorktreeHome` (in
    [environmentContext.ts](src/environments/environmentContext.ts)) recognises a workspace folder
    that *is* a worktree — under a worktrees home **and** carrying a readable marker, so a marker
    accidentally committed to a repo never counts — and then the context answers with the marker's
    `sourceRoot` as the repo and the folder's **parent** as the worktrees root, which is what makes
    the worktree window's Environments section list **every** environment of the original
    workspace. Activation uses the same resolver to open the story's board once per workspace
    (`workspaceState` guard).
  - **Which home that is, is `environments.worktreesFolder`** — absolute or `~`-relative, the
    exact inverse of the `composeFile` rule and refused for the mirror reason (a worktree inside
    the repo would turn up in every search, watcher and `git status`), and read through
    `worktreesHome` in `environmentContext.ts` rather than defaulted in `environmentSettings.ts`:
    naming `<os temp>` there would drag `os` into a module the settings webview bundles, and `~`
    is expanded in the same one place for the same reason. Three things are load-bearing. The
    `<workspace-slug>` segment is appended **whatever** the home — `masterProjectName` reads the
    slug back off that last segment, and two repos sharing a folder would share a master stack that
    either one's Delete would `down --volumes`. `worktreeHomes` answers the configured home **and
    the default**, because changing the setting moves nothing on disk and a window already open on a
    worktree under the temp folder must go on recognising itself; the guard is unweakened, since it
    only ever asks whether the folder is under *a* BFAST worktrees home. And `bfastEnvironmentContext`
    keys its `WorktreeHome` cache on the folder **plus those homes**: they come from settings, so the
    first call can land before `settings.read()` resolves, and a folder-keyed cache would pin that
    answer for the window's life.
    The settings form picks it with a dialog (`pickWorktreesFolder` → `worktreesFolderPicked`, the
    `pickTrackerFolder` shape) and `collapseTilde` stores a folder under the home folder as `~/…` —
    the committed-file argument acted on rather than only documented, and reversible, since the field
    shows what was stored. Two things could not live in `environmentSettings.ts`: the **placeholder**,
    which is `defaultWorktreesHome()` riding on the `settings` message beside `implementPrompts`
    (a literal `<os temp>` tells a user nothing about where their worktrees land, and a webview has
    no `os`), and the **outside-the-workspace** refusal — the pure validator knows the path but not
    where the workspace is, so `SettingsPanel.worktreesFolderRefusal` is that one rule, asked of the
    picked folder *and* of the candidate at save so a hand-edited absolute path cannot slip past the
    dialog. It is the exact mirror of `pickTrackerFolder`, which refuses a folder outside.
  - [runProcess.ts](src/platform/runProcess.ts) is the shared spawn helper (`shell: false`,
    `windowsHide: true`, ENOENT → `'not-installed'`, stderr kept for diagnostics only) and
    `ProcessRunner` its injection seam; `claudeCliProvider` deliberately keeps its own copy — its
    stream-json handling does not generalise. Note `shell: false` on Windows launches only real
    `.exe`s, which `git.exe` and `docker.exe` are.
  - Sidebar: [environmentTreeProvider.ts](src/environments/environmentTreeProvider.ts) renders
    `contextValue = 'environment:<status>'` — the seam the Start/Stop/Delete `when` clauses gate on
    (Start from `stopped|error`, Stop from `running`, Delete from `stopped|running|error`; keep
    package.json in sync) — and a child row per port, main port first. The environment row has
    deliberately **no `item.command`** (a window opens only via right-click → "Open in New Window",
    so browsing the list cannot spawn windows), while a **port row answers the click** with
    `bfast.openEnvironmentPort` → `http://localhost:<port>` in the editor's Simple Browser — a tab
    is cheap and closable where a window is not. Right-click names the **two** routes instead of
    leaving the destination to be discovered by clicking: that same command as **Open Port in
    VS Code**, and `bfast.openEnvironmentPortInBrowser` → **Open Port in Browser**, which is
    `env.openExternal`. It is deliberately **not** an inline button — one globe stays one globe —
    and the VS Code route deliberately **no longer falls back** to the external browser when
    Simple Browser is disabled: silently becoming the other entry is what would make the pair
    meaningless, so it reports and *offers* it. `openExternal` resolves a `localhost` uri itself
    on a remote (the API forbids `asExternalUri` on a uri passed to it), so the browser route
    needs no forwarding of its own. In a remote window, Start auto-forwards every allocated
    port via `asExternalUri` (idempotent — an existing forward is reused), and
    `bfast.forwardEnvironmentPorts` / per-port `bfast.forwardEnvironmentPort` (right-click) do it
    on demand — shown in every window on purpose: a hidden menu entry reads as the feature
    missing, so a local window gets an explanatory message instead. [environmentCommands.ts](src/environments/environmentCommands.ts) holds the
    command half: `withProgress` notifications whose cancel reaches `store.cancel()`, errors offered
    with "Show Log" into the **"BFAST Environments" output channel** — no webview, deliberately.
  - The `environments` settings block ([environmentSettings.ts](src/settings/environmentSettings.ts))
    follows the `ai` block exactly — parse forgiving / validate strict / omitted when empty, a row in
    `SETTINGS_BLOCKS`. `portVariables` is **semantics-free** (user-named,
    one allocated port per name, `BFAST_` prefix reserved); `mainPort` defaults to the first entry;
    `composeOverrides` layers extra compose files over `composeFile` as ordered `--file` flags —
    `environmentComposeFiles` is the one chain the provider consumes, never the fields separately.
- **Run Tests** — right-click any ticket → `bfast.runTests` (menu group `5_tests`, gated on
  `viewItem =~ /^ticket:/`), or **Run tests** on a board's **Tests** tab: runs the `tests.command`
  template once per **test case** in the ticket's subtree. Every run that reaches a verdict is **filed**
  first, in the results store: `TestResultsStore.addRun` ([testResultsStore.ts](src/testing/testResultsStore.ts))
  writes `<tests.resultsFolder>/<TC id>/<runId>/` — default `.bfast/test-results`, **outside the
  tracker** and refused inside it — with the command's ANSI-stripped output tail (`outputTail.ts`, the
  runner's own buffer — a `timeout` or a cancel carries no result object), `run.json` last, and whatever
  the `tests.evidence` glob matched; then pass → status `done`, fail → `blocked` **only when the verdict
  moves the status**, with a history comment naming the run (`updateStatus`'s `StatusChangeNote`, the
  `DescriptionChangeNote` shape), and the same verdict again writes nothing into the ticket. The two
  histories are independent on purpose — `history.md` is what changed about the ticket, the results
  folder is what happened when its tests ran, and the `tested` entry that used to join them is gone
  (`changed status from: done to: done` was a lie in a file people read, and the `updatedAt` bump failed
  a board open mid-edit). The evidence files are
  found by the hand-rolled walker in [evidenceGlob.ts](src/testing/evidenceGlob.ts) (anchored at the
  pattern's literal prefix, never following a symlink, every character but `**` `*` `?` literal so
  `TC-1.1.*` cannot claim `TC-1.10.webm`) and kept only when written **during** the run — a tool that
  fails before clearing its own folder would otherwise hand the previous run's video to this one. All of
  that happens **inside the concurrency slot**, before the next command may start. `evidence` takes
  `{{id}}`/`{{key}}` only (`{{folder}}` is absolute and the walker refuses absolute patterns), and a
  folder-clearing reporter makes `concurrency: 1` mandatory — a warning line at batch start, not a
  refusal. Two surfaces start, stop and watch batches, so "a test case belongs to at most one running
  batch" lives in the pure factory [testBatches.ts](src/testing/testBatches.ts) (a Map and a listener Set,
  the `sharedLimiter` shape), which refuses a root already running **and** one whose collected test cases
  overlap a running batch — comparing collected ids is the only legal way, since ancestry is never inferred
  from an id. Its `onDidProgress` feeds the channel, one `withProgress` notification per batch and the
  toast in `testCommands.ts`, and every open board's lanes; a board that opens mid-batch takes
  `snapshot`. Stop must reach the browsers a test runner started, not only the shell, so the runner
  spawns with `runProcess`'s opt-in `killTree` (POSIX process group + `SIGTERM`, then `SIGKILL`; Windows
  already tree-kills). The board plays a run's video through `media-src` in the shared CSP and the
  workspace roots the board already lists — and, when the webview's loader hands the `<video>` nothing it
  can demux (`DEMUXER_ERROR_COULD_NOT_OPEN`, which some remote connections produce and which reads like a
  codec problem), falls back to `testsMedia`: `readEvidenceVideo` posts the bytes as base64 (the `insertImage`
  convention), logs a `— Serving …` line to the channel, and the webview plays them from a `blob:` it owns,
  hence `media-src … blob:`. The fallback runs on **any** first failure but an abort — the wording is
  Chromium's and differs between builds, so it is never trusted to say which kind a failure is. A third
  route sits behind that: VS Code on Windows refuses VP8 WebM at the *demuxer* while its decoders and
  WebCodecs take it (microsoft/vscode#195758), so [webmDemux.ts](src/shared/webmDemux.ts) (pure, forgiving,
  throws only `WebmError`) hands the frames to a `VideoDecoder` in
  [videoPlayer.tsx](src/webview/components/videoPlayer.tsx), which draws them on a canvas — the two WebCodecs
  rules its `Engine` is built around are in its comment (output is asynchronous, so a seek drops what
  precedes its target; a flush demands a keyframe next, so play after a flush restarts from one).
  A fourth route catches an editor with **no decoder for the codec at all** — VS Code on Windows has
  no VP9 anywhere, and Playwright records VP9 from 1.65 (`-c:v libvpx-vp9`, hard-coded): the board
  asks `testsMedia` with `convert: true`, and [videoConvert.ts](src/testing/videoConvert.ts) runs the
  host machine's `ffmpeg` (PATH; Playwright's bundled one has no VP8 encoder any more) into a temp
  folder it removes — never beside the original, whose run folder listing *is* the evidence — and
  the blob and decoder routes run again on the VP8 bytes, keyed `…#vp8` in the board's media map.
  Tried once; a missing ffmpeg is a sentence naming where to install it.
  [mediaError.ts](src/shared/mediaError.ts) is the Node-free reader of a `MediaError` that tells that transport
  failure from a format one — the two look identical on screen and want opposite advice, and the format advice
  says outright that installing codecs cannot help, since the player is the editor's own build; a file it cannot show goes to `tests.evidenceCommand`, run
  like `tests.command` (never typed into a terminal) with `{{file}}` **already quoted** by
  `quoteShellArgument` — a folder slug keeps a title's apostrophes and `$(`, and the file name came from
  git — after `openEvidence` has checked both segments against the allow-list `evidenceFileName` writes to
  and `realpath`-resolved the target under the test case's folder in the results store.
  **A Playwright trace opens inline on the same tab**, and the split is the video's: a `.zip` is
  `evidenceKind` `archive` — *probably* a trace, since the name cannot say — and the host looks inside
  when the row is opened. [zipFile.ts](src/testing/zipFile.ts) is a hand-rolled central-directory
  reader (yazl streams the archive, so local headers carry zeroed sizes and the directory at the end
  is the only truth; zip64 and encryption are refused in a sentence, `zlib` does the inflating, a CRC
  mismatch is a warning); [playwrightTrace.ts](src/shared/playwrightTrace.ts) is the **Node-free**
  NDJSON reader and the `TraceReport` model the webview bundles for its types and pure helpers
  (`windowFor`, `frameBefore`/`frameAfter`, `filmstripFrames`, `actionAt`) — forgiving like
  `historyFile.ts`: unknown event types skipped, broken lines counted, a `version` past
  `KNOWN_TRACE_VERSION` (9) read anyway with a warning, `frame-snapshot` lines dropped before the parse;
  **a frame's image moved in format 9** — `resources/<sha1>` up to 8, the `screencast/…` path the
  event names as `file` from 9 — so `frameLocation` resolves a `TraceFrame` to a bare `name` (what
  the webview echoes back, kept path-free for `readTraceFrame`'s guard) plus its archive `entry`,
  by the context's own `version` under `tests.traceFrames: auto`, or one layout when forced;
  and [traceReader.ts](src/testing/traceReader.ts) is the host glue: every `<prefix>.trace` entry is
  a context (a merged `@playwright/test` trace has `0-trace.trace` for the browser library and
  `test.trace` for the runner, on two clocks), its `.network` and `.stacks` sidecars are read into
  the same context, and `buildTraceReport` joins them the way Playwright's viewer does — a runner
  step whose `callId` a library call carries as `stepId` folds into that call and aligns the clocks —
  with a 3-entry LRU keyed on realpath+size+mtime+frame source (the setting is read through a
  getter at every open, so a saved change applies to the next trace). **Frames travel one at a time as base64**
  (`testsTraceFrame`, the `testsMedia` route; `img-src data:` was already in the CSP) and **only by a
  name the report listed**, which is the allow-list that stops the webview naming an arbitrary
  entry; the archive itself never crosses the bridge and no cache touches disk. **"Open in Playwright
  Trace Viewer"** is [traceViewerLauncher.ts](src/testing/traceViewerLauncher.ts): `tests.evidenceCommand`
  wins when set (a line the user typed is never replaced by a guess); otherwise the workspace's own
  `node_modules/{playwright-core,playwright,@playwright/test}/cli.js` (under `tests.cwd` first) runs
  `show-trace --stdin`, one process per window, later traces written to its stdin one path per write
  with a gap (the viewer `statSync`s each chunk as one path and crashes on a bad one — so only
  `resolveEvidenceTarget`-verified paths ever reach it), `--host 127.0.0.1 --port 0` on a remote with
  the printed url through `asExternalUri` (never `0.0.0.0`: a shared remote's other users), and
  `process.execPath` + `ELECTRON_RUN_AS_NODE` when no `node` is on the PATH. That needed one seam
  change: `runProcess` gained an opt-in `interactive` that keeps stdin open and hands it back, since
  the default `stdin.end()` is right for every other caller. Playwright no longer ships an
  embeddable viewer (`embedded.html` is gone and the CSP has no `frame-src`), so there is no iframe
  route and none should be added. `testReport.ts` is the Node-free
  module the webview and the protocol import (the `scanReport.ts` rule; the runner imports `fs`, and even
  an `import type` from it fails `typecheck:web`); `testReportBuilder.ts` is the host-side builder.
  **`docs/tests/` is the spec** — written before the code, and the code must keep matching it: outcome
  table, placeholder grammar (`{{id}}`/`{{key}}`/`{{folder}}`; `{{title}}` deliberately not offered —
  free prose in a shell line is injection — and an unknown token is left in the line untouched),
  cancel/abort semantics. Split the house way:
  [testRunner.ts](src/testing/testRunner.ts) is the pure half (collect via `findNode` +
  `collectTestCases` in `ticketTree.ts`, fan-out under `tests.concurrency` through the window-wide
  `sharedLimiter`, tagged outcomes,
  never a rejection) and [testCommands.ts](src/testing/testCommands.ts) the `vscode` half
  (`environmentCommands.operate` shape: cancellable `withProgress`, the **"BFAST Tests"** output
  channel, "Show Log"; one batch **per ticket**). The command is inherently a **shell line**, and
  `runProcess` is `shell: false` — so [shellCommand.ts](src/platform/shellCommand.ts) wraps it (`cmd.exe /d /s /c` +
  `windowsVerbatimArguments` on Windows, or the template's own quotes are re-escaped into garbage;
  `/bin/sh -c` elsewhere), which is also what makes `npm`/`npx` (`.cmd` shims) work. It sits in
  `platform/` rather than beside the runner for the reason `idleWatchdog.ts` does: the scan feature's
  `scan.command` mode needs the identical wrap, and a second copy is exactly the drift that would let
  a Windows quoting fix reach only one of them. A run is stopped
  by silence only (`tests.idleTimeout`, default 300s), and the `tests` settings block
  ([testsSettings.ts](src/settings/testsSettings.ts)) follows the `ai` block exactly — parse forgiving /
  validate strict / omitted when empty, a row in `SETTINGS_BLOCKS`; unknown
  `{{token}}`s are a form hint, never a validation error, so a pulled file cannot open the form
  pre-invalid.
  **Services** (`tests.services`, [testServices.ts](src/settings/testServices.ts), pure and
  bundled by the settings webview): a folder, an optional unit suite, an optional e2e suite with
  `testCommand` and the `compose` services it needs. A test case's `metadata.yaml` may carry
  `service:` (`FileTicketStore.setService`, sidebar **Set Service…** /
  `bfast.setTestCaseService`, the board's picker → `testsSetService`); `runTests` routes it to
  that service's `testCommand` in the service's folder — never silently to `tests.command` —
  after `composeUp` brought the compose services up once per batch in the **master**
  environment ([masterStack.ts](src/environments/masterStack.ts), `composeUpServicesArgs`:
  `up -d --wait <services>`), and every test command gets the master's `stackEnvironment`.
  `testsConfigured` (a project command or one service `testCommand`) is the gate. Stop reaches a
  bring-up through `stackCancel` inside `stop`, never a second `onCancel` registration — a caller
  keeps only the last cancel it was handed.
  docs/tests/services.md is the spec; suite runs, merged coverage and Sonar are still to come.
- **Code Quality** — the sidebar's third section (`bfast.scan`): SonarQube, either **deployed by
  BFAST** (`scan.mode: auto` — one compose stack per workspace under
  `bfast-sonar-<workspace-slug>`, with its admin password and tokens **provisioned automatically**)
  or an **external** Server/Cloud the user already has. Right-click an **environment** →
  `bfast.runScan` (menu group `3_scan@1` on the environments view) opens a results tab;
  `bfast.scanWorkspace` does the same with no ticket.
  **`docs/scan/` is the spec** — written before the code, and the code must keep matching it:
  outcome table, the compose contract, the provisioning order, the placeholder grammar.
  The shape repeats Environments', on purpose, with the seam moved one axis over:
  - **The seam is the *tool*, not the deployment.** [scanProvider.ts](src/scan/scanProvider.ts) is
    the `vscode`-free seam keyed by `ScanToolId`; `auto` vs `external` is SonarQube's own question,
    answered inside its provider by two `ScanServerLifecycle` strategies picked at call time — the
    same relationship `composeFile` has to `EnvironmentsSettings`. Three reasons, all in the
    module comment: a deployment-shaped provider could start containers and answer nothing else
    (the compose file, the readiness probe and the provisioning are all SonarQube facts); the axes
    are not symmetric, since every tool has a scanner and not every tool has a server — so
    `ScanProvider.server?` is **optional**, the `EnvironmentProvider.reclaim?` idiom; and the tool
    axis is the one that grows. There is deliberately **no stub second tool** —
    `k8sProvider` exists because `EnvironmentProviderId` always had two members, and
    [fakeScanProvider.ts](src/test/fakeScanProvider.ts) is this seam's proof instead.
  - **An environment is what gets scanned; its ticket is where the result is recorded.** The
    `bfast.runScan` menu entry sits on an **environment row** in every settled state
    (`viewItem =~ /^environment:(stopped|running|error|unknown)/` — the worktree is there whether
    the stack runs or not, and a scan reads source, not containers), never on a ticket: a ticket
    owns no folder, an environment owns the worktree of the branch the work is on. `resolveDirectory` in [extension.ts](src/extension.ts)
    is the **one** line coupling Scan to Environments and there is deliberately **no fallback** to
    the workspace under a ticket's name — `resolveScope` in `scanRunner.ts` yields an empty
    directory and an `unreachable` outcome instead, and the tab disables Scan and says why. Scan
    Workspace (title bar, `scan.cwd`) is the whole-repo gesture. A scan **does not fan out**: a
    test case *is* a test, but a scan is one analysis of one checkout.
  - **No outcome changes a ticket's status.** Run Tests owns `done`/`blocked`, and two features
    writing one field would fight. So `TicketWriter` gained **`recordNote`**: one history entry,
    no status change, and **no `updatedAt` bump** — `updateStatus(id, itsCurrentStatus, …)` would
    write `changed — status — from: todo — to: todo`, a lie in a file people read, and bumping
    `updatedAt` would fail the next save of a board open mid-edit, the trap `addAttachment`
    already documents. A test reads the metadata before and after to keep it closed.
  - **Deploy and Start are one gesture — `ScanServerStore.setup()`**: deploy if absent, start
    if not running, provision always (idempotent, one call when healthy). `ready()` is
    `setup()` plus the endpoint and credentials handed back to the runner. The three steps
    were never separately useful — a stopped server cannot scan and a running one with no
    token cannot either — and the button a user presses must end in the state where Scan
    works. `deploy()` and `start()` remain as the steps, for the queue's transitional
    statuses and the tests that pin each. `autoProvision: false` reaches the lifecycle, not
    the store: `AutoServerLifecycle.provision` then runs the external lifecycle's
    verify-only path (`verifyResultsToken`) and never touches the admin password.
  - **The project key is the checkout's to name** ([sonarProjectProperties.ts](src/scan/sonarqube/sonarProjectProperties.ts)):
    `resolveTarget` asks the provider's optional `readProjectIdentity(directory)` — the
    `server?` idiom, because the file's name and grammar are the tool's — and takes
    `sonar.projectKey` from a `sonar-project.properties` at the analysed root first, then
    `scan.projectKey`, then the folder name, recording which on
    `ScanTargetRef.projectKeySource` so the tab can say. The file wins because `-D` beats it
    inside the scanner: a key BFAST chose would rename the project a team set up in CI.
    The same read feeds `scannerProperties` a `fileProperties` list so BFAST's **defaults**
    (`sonar.sources=.`, `sonar.scm.provider=git`) yield to a file that already has a layout
    — `.` on top of ice-hrm's `sonar.sources`/`sonar.tests` split makes every test file a
    source and the scanner refuses the double index — while a value typed into settings is
    a `-D` the user asked for and still overrides. The parser is hand-rolled Java
    `.properties` (continuations, `=`/`:`/space, escapes), the `yaml.ts` posture.
    **Project creation therefore moved out of provisioning into `scan()`** (`ensureProject`,
    best-effort with a warning on refusal): provisioning runs before any scan has said what
    it analyses, and a project created from a guessed key sat empty beside the real one.
  - **Two tokens, not one** ([sonarProvisioning.ts](src/scan/sonarqube/sonarProvisioning.ts)).
    An analysis token answers **403** to `api/issues/search` and `api/projects/create`, and BFAST
    must read those — so `auto` mode mints a `GLOBAL_ANALYSIS_TOKEN` (the only credential that
    enters the scanner container, where a leak buys a bogus analysis and little else) *and* a
    `USER_TOKEN` (host-only, reads the verdict back). Secret-storage keys carry the **workspace
    slug**: `SecretStorage` is global to the extension, so two workspaces would otherwise
    overwrite each other's token and both silently stop working.
  - **Provisioning is ordered cheapest-first and least-destructive-first**, which is what makes
    "Re-provision" safe to press at any time: a healthy instance costs one HTTP call and writes
    nothing, and a user who changed the admin password by hand still scans (SonarQube does not
    revoke tokens on a password change, and the token probe runs before the password probe). The
    generated password is written to storage **before** it is sent — a crash between "the server
    accepted it" and "the extension recorded it" would lock the user out of their own instance.
    An instance nobody has the password for **stops** and offers two ways out; it never guesses.
  - **The readiness wait is two things at once** ([sonarQubeProvider.ts](src/scan/sonarqube/sonarQubeProvider.ts)):
    a followed `compose logs` gives the idle watchdog real bytes to reset on — and puts a
    four-minute first boot on screen — while an HTTP poll of `api/system/status` decides when to
    stop. [scanPoll.ts](src/scan/scanPoll.ts) restates the doctrine rather than reusing it,
    because a poll **manufactures its own traffic**: it resets on a *changed payload*, so a CE task
    frozen at `PENDING` is still a hang. `vm.max_map_count` is checked before deploying **and**
    grepped out of that log afterwards — the net for a remote docker context, colima or WSL, where
    the host's `/proc` is not the kernel the container ran on.
  - **`.scannerwork` is mounted, not left in the repo** (`SCANNER_WORKDIR_MOUNT`): the scanner
    image writes it to `/tmp/.scannerwork` inside the container — its own `SCANNER_WORKDIR_PATH`,
    which the entrypoint turns into `-Dsonar.working.directory` — so reading
    `<directory>/.scannerwork/report-task.txt` found nothing. BFAST mounts `<scan home>/scannerwork`
    there, restates the variable for a pinned image (not the `-D` too — the entrypoint emits one
    from the variable and a duplicate makes the scanner warn "overridden"), removes the previous
    `report-task.txt` before each run (that is the freshness check), and reads the task id from
    its own folder; `command` mode keeps the repository's `.scannerwork/`, since the user's
    scanner runs on the host. The session note that `sonar.working.directory` must be relative
    was wrong for this image.
  - **The token travels in the environment and never in an argument**, and `redactArgs` blanks it
    before the output channel echoes a command line; `sonarCompose.test.ts` asserts both. It
    reaches the container by bare `-e SONAR_HOST_URL -e SONAR_TOKEN` (`SCANNER_INHERITED_ENV`):
    the docker client's env is not the container's, and a scanner with no host url defaults to
    SonarCloud and demands `sonar.organization`. `configuredScanProvider()` forwards every
    seam member through `platform/providerRegistry.ts`'s `delegateTo` — a hand-written registry that
    forgot an optional one (`readProjectIdentity`) silently read as a tool without it. There is
    no `{{token}}` placeholder for `scan.command`, the same reasoning that keeps `{{title}}` out of
    `tests.command`. `sonar.branch.name` is never sent (Community has no branch analysis) and
    `sonar.qualitygate.wait` never either — it would collapse "the gate failed" and "your token is
    wrong" into one exit code, which is the only distinction the outcome table turns on.
  - **`scanReport.ts` is bundled into the webview**, so it carries no `vscode`, no `node:` and no
    import of the seam — the results types live there precisely so `shared/protocol/` never has
    to import `scanProvider.ts` for anything but a string union.
  - The `scan` settings block ([scanSettings.ts](src/settings/scanSettings.ts)) follows the `ai`
    block exactly — parse forgiving / validate strict / omitted when empty, a row in
    `SETTINGS_BLOCKS` — and enforces two rules rather than
    documenting them: a `hostUrl` carrying userinfo is refused, and an analysis property whose key
    matches `token|login|password|secret` (or one of the four BFAST owns) is dropped. `autoProvision`
    only ever stores `false`, so a default-valued flag never creates a block in an untouched file.
  - [shellCommand.ts](src/platform/shellCommand.ts) moved out to `platform/` when this landed: `tests.command`
    and `scan.command` both need the identical `cmd.exe /d /s /c` + `windowsVerbatimArguments` wrap,
    and a second copy is exactly the drift that would let a Windows quoting fix reach only one.
    [commandTemplate.ts](src/settings/commandTemplate.ts) is the same move for the `{{token}}`
    grammar — one reader for the form's warning and the runner's substitution.
- **Implement** — right-click any ticket → `bfast.implement` (menu group `6_implement@1`, gated on
  `viewItem =~ /^ticket:/`, hidden from the palette): BFAST builds a prompt for the ticket — a
  different template per ticket type — writes it to `.bfast/implement/prompts/<id>.md`, and hands
  the configured coding agent **one sentence naming that file, filled in and not sent**
  (`handoffSentence`; the same string on the extension's input and on the CLI's terminal line, so
  the two routes provably hand over the same thing). That is the whole feature: nothing runs, and
  **nothing is written into the ticket** (no
  history entry, no status change, no `updatedAt` bump — a handoff is not a change, and a bump would
  fail a board open mid-edit). **`docs/implement/` is the spec** — written before the code, and the
  code must keep matching it: the outcome table, the placeholder table (a test holds
  `IMPLEMENT_TOKENS` to it), the two routes. Split the house way:
  - [codingAgent.ts](src/implement/codingAgent.ts) is the `vscode`-free seam — `CodingAgent`
    (`availability()` / `open(request)`, an optional `extensionId` the command layer offers the
    Marketplace for), `ImplementError` with a code the command switches on, `CodingAgentContext`
    read at call time. **An agent is a destination, not a runner**: no progress, no cancel, no
    result, no `dispose`. [codingAgentRegistry.ts](src/implement/codingAgentRegistry.ts) is
    `configuredCodingAgent()`, the `providerRegistry.ts` shape, every agent built once and
    `implement.agent` read at call time; [comingSoonAgent.ts](src/implement/comingSoonAgent.ts) is
    the `k8sProvider` posture for the six stubs, so a value committed ahead of its implementation
    is a sentence, never a crash. [fakeCodingAgent.ts](src/test/fakeCodingAgent.ts) is the seam's
    proof. `implement.agent` is **one flat list** (`claude-code`, `claude-code-cli`, `codex`,
    `codex-cli`, `opencode`, `opencode-cli`, `cursor`, `github-copilot`), not an agent plus a
    surface axis: a CLI entry is its own destination with its own handoff, and the two Claude Code
    agents share no handoff code. [codingAgents.ts](src/settings/codingAgents.ts) is the offer list
    (`models.ts` shape); `available` is what the form's `disabled` reads, and a test holds it to the
    settings' id list.
  - [claudeCodeAgent.ts](src/implement/claudeCodeAgent.ts) reaches the **extension**
    (`anthropic.claude-code`) through `claude-vscode.editor.open(sessionId, initialPrompt, …)`,
    the command it registers for "a new tab with this text in the input". Three facts read from
    the extension shape it, each pinned by a test: the text **fills the input and is not
    submitted**; the session id is **always `undefined`** (naming an open session drops the
    text with a toast); and the id is undocumented and has moved once (`claude-code.*` →
    `claude-vscode.*`), so `availability()` activates the extension and checks
    `getCommands(true)`, answering `unsupported` when it is gone. The documented URI handler
    (`vscode://anthropic.claude-code/open?prompt=`) was rejected: a 5,000-char cap, a first-use
    confirmation dialog, and `Uri`/`openExternal` re-encoding that ends the query at a `#`.
  - [claudeCodeCliAgent.ts](src/implement/claudeCodeCliAgent.ts) reaches the **CLI** with no
    extension at all: a terminal named after the ticket opens in the workspace folder, and
    **one line is typed with `sendText(line, false)` — Enter is left to the user**:
    `claude "Your task is in .bfast/implement/prompts/ST-1.2.md. Read that file first, then do
    what it says."` — the request's `message`, verbatim, as `claude`'s positional prompt. The
    sentence and the path are constants and the id's alphabet is `[A-Za-z0-9._/-]` (`#` → `_`, the
    `testCaseResultsFolder` rule restated rather than imported), so the line is the same string on
    every shell and **nothing from the ticket's prose ever touches it** — the `{{title}}` rule of
    `tests.command`, kept rather than quoted around (`handoffSentence` refuses a path outside the
    alphabet and `claudeCliHandoffLine` checks again; neither quotes). The prompt file is written by
    the **command layer** for every agent, never by this one.
    The probe is `claude --version` through `shellCommand` + `runProcess`, **not** a bare `spawn`,
    because that is how the terminal resolves `claude` too, `.cmd` shims included; a pass is
    remembered for the window, a failure re-asked. `ai.executablePath` is deliberately not used (a
    spawn path is not a shell word). Rejected, and why, in docs/implement/provider-interface.md:
    quoting the prompt onto the line, typing it into the running TUI, the extension's own
    `claude-vscode.terminal.open`.
  - [implementPrompt.ts](src/implement/implementPrompt.ts) is the pure, Node-free half the settings
    webview bundles: the file names, the `SKILL.md` frontmatter grammar (`splitFrontmatter` and
    `parseTypes` exported from `agent.ts` for it — one reader, the type inferred from the file name
    by `typeFromName`, explicit `types` winning), the fourteen tokens, the line formats, and
    `renderImplementPrompt` = `substituteCommand` from `commandTemplate.ts`, so an unknown
    `{{token}}` is left untouched here for the reason it is in `tests.command`. **`{{rules}}` is
    the shared `rules.md`** — how to approach any ticket (think before coding, simplicity first,
    surgical changes, goal-driven execution, after Andrej Karpathy's guidelines), which every
    shipped template ends with under `## Working rules`; the role/skill split restated, so the
    standard lives in one file and a template says only what its kind of ticket asks for. **The
    prompt carries the ticket's own description inline and everything else by workspace-relative
    path**:
    a coding agent has file tools and the tracker is provably inside the workspace, so a path is
    read fresh where a pasted copy would be a snapshot. `{{children}}` goes **two levels down**
    (`CHILDREN_DEPTH`): the level the instruction works at plus one. `{{folder}}`/`{{file}}` are
    workspace-relative with forward slashes — unlike `tests.command`'s absolute `{{folder}}` —
    because the agent resolves them in the window it is open in. `{{testCommand}}` is
    `tests.command` substituted for a test case and raw for anything else. `{{title}}` and
    `{{description}}` are offered here and not in `tests.command` because this prompt reaches a
    chat input or a file, never a shell.
  - [implementContext.ts](src/implement/implementContext.ts) gathers the values: ancestors by
    walking `getSummary(parentId)` upward (there is no ancestors helper, and an id is never parsed
    for ancestry), the subtree via `listSummaries` + `buildTree` + `findNode` (the Run Tests
    triple; skipped for a test case), design documents on the ticket **and** its ancestors via
    `DesignStore.list`. [implementPromptStore.ts](src/implement/implementPromptStore.ts) owns
    `.bfast/implement/`: the four templates and `rules.md` seeded from `templates/implement/`
    **only when the folder has never existed** (an empty folder means the user deleted them on
    purpose; the shipped file stands in silently for a missing one), read at click time and never
    cached (`read(type)` / `readRules()`), `openTemplate` / `openRules` restoring the one file they
    open so the form's **Open** never opens nothing, and `writeHandoff` seeding first so `prompts/`
    can never be what makes the folder "exist" without its templates.
    [bundledImplementPrompts.test.ts](src/test/bundledImplementPrompts.test.ts) reads the shipped
    templates as files: one per type, frontmatter, `{{id}}`/`{{folder}}`/`{{tracker}}` present,
    every token a known one, and **no coding agent named** — the templates are agent-neutral so
    changing `implement.agent` never means rewriting four prompts.
  - [implementCommand.ts](src/implement/implementCommand.ts): availability first (a missing program
    costs no tracker read), then the prompt, then `writeHandoff` (the store's, for **every** agent —
    which is what makes the two routes hand over the same thing without an agent knowing why),
    then `open` with `{ ticketId, handoffPath, message: handoffSentence(handoffPath) }`; nothing
    on success. `ImplementRequest` deliberately carries the sentence and **not the prompt's text**:
    the seam cannot be where the routes diverge, and the fixed alphabet is what spares the CLI a
    quoting rule. The error's code
    picks the action — **Show in Marketplace** on `not-installed` when the agent has an
    `extensionId`, **Open Settings** on `not-implemented`/`not-configured`, **Copy Prompt** on
    `unsupported`/`provider-error` (the prompt exists and only the delivery failed). The dialogs
    go through an injectable `ImplementUi`, so
    [implementContext.test.ts](src/test/implementContext.test.ts) drives the command against a
    real `FileTicketStore` and `FakeCodingAgent` and asserts the ticket's three files are
    byte-identical afterwards. The settings form's **Implement** tab lists the agent (coming-soon
    entries `disabled` with the suffix, the k8s idiom) and the four templates with **Open**
    (`openImplementPrompt`, a ticket type — never a path — the `openSkillResource` rule);
    `implementPrompts` ride on the `settings` message beside `agents`, and listing them seeds the
    folder the way listing agents does.
- **Commit Ticket** — right-click any ticket → `bfast.commitTicket` (menu group `6_implement@2`,
  gated on `viewItem =~ /^ticket:/`, hidden from the palette): once a ticket has been reviewed, commit
  **its files in the tracker** and nothing else. **`docs/commit/` is the spec.**
  [ticketCommit.ts](src/commit/ticketCommit.ts) is the `vscode`-free half: `git status -z` on the
  ticket's **parent** folder, `classifyChanges` sorting paths into the ticket's own (description,
  metadata, history, design documents, `assets/`) and its children's (a first segment that
  `parseFolderName` reads as a ticket), plus a **deleted** path under a sibling claiming the same id —
  the folder's old name, since BFAST renames a slug with a plain rename and committing only the new
  folder would put both in the tree. Then `git add -A` and `git commit --only`, paths on stdin
  (`--pathspec-from-file=- --pathspec-file-nul`, `GIT_LITERAL_PATHSPECS=1`: a subtree can pass the
  Windows command-line limit and a slug may hold `[`), so whatever else is staged stays staged.
  [commitCommand.ts](src/commit/commitCommand.ts) is the `vscode` half behind an injectable `CommitUi`:
  a scope pick only when child tickets changed too, an input box pre-filled from `git.commitMessage`
  ([gitSettings.ts](src/settings/gitSettings.ts), default `{{id}}: {{title}}`, the field on the
  General tab), then the commit. Nothing is written into the ticket and nothing is pushed.
  **Uncommitted changes are marked in the sidebar** ([ticketChangeDecorations.ts](src/commit/ticketChangeDecorations.ts)):
  a `FileDecorationProvider` on `bfast-ticket:` — the tree sets `resourceUri = ticketUri(id)` for it,
  and the board's tab gets the mark too — `M` for a ticket whose own files changed, `U` for one never
  committed, `•` on every ancestor. [changeMarks.ts](src/commit/changeMarks.ts) is the pure half
  (deepest ticket-named folder around a path; a rename's new folder is `M`), `ticketAt` turns a
  folder into a ticket by nesting. It re-looks on a tracker refresh (`onDidRefresh`), after a commit,
  and on the git extension's `state.onDidChange`; `status` runs with `--no-optional-locks`, or its
  index refresh would be the git extension's next change — a loop. docs/commit/ §Uncommitted changes.
- **The MCP server** — BFAST listens on an HTTP port and speaks the Model Context Protocol over the
  **Streamable HTTP** transport, so a coding agent or any other MCP client outside this window can
  read and change the workspace's tickets and trigger BFAST's own actions. **`docs/mcp/` is the
  spec** — written before the code, and the code must keep matching it: the lifecycle table, the
  function/tool table, the protocol details. It has **no view and no command**: `package.json`
  `contributes` needed nothing, the Design precedent.
  - **Hand-rolled on `node:http`**, for the reason `yaml.ts`, `zipFile.ts` and
    `sonarProjectProperties.ts` are hand-rolled readers: the host has exactly one dependency (the
    optional Agent SDK) and `vsix` packages with `--no-dependencies`, so an MCP SDK would not reach
    a user's machine even if it were added.
  - **Split three ways, the house way.** [mcpTools.ts](src/mcp/mcpTools.ts) is the table and the pure
    dispatch, [mcpProtocol.ts](src/mcp/mcpProtocol.ts) the JSON-RPC and the four MCP methods, both
    Node-free — so the settings webview bundles the first for its function list and
    [mcpTools.test.ts](src/test/mcpTools.test.ts) drives every tool, and the switch that gates it,
    without a port or a tracker.
    [mcpServer.ts](src/mcp/mcpServer.ts) is the transport (still `vscode`-free, status published
    through a listener set the `EnvironmentStore` way, so the tests talk to it over real HTTP), and
    [mcpContext.ts](src/mcp/mcpContext.ts) is the `vscode` half —
    `bfastAiContext`/`bfastScanContext`'s idiom, so [mcpModule.ts](src/modules/mcpModule.ts) gains one object rather than ten
    closures. [mcpStatus.ts](src/mcp/mcpStatus.ts) exists only because `mcpServer.ts` imports
    `http`: `shared/protocol/` carries the status to the settings tab and even an `import type`
    from a `node:` module fails `typecheck:web` — the `testReport.ts` rule.
    [fakeMcpContext.ts](src/test/fakeMcpContext.ts) is the seam's proof.
  - **Saving is the whole lifecycle** — start, restart, or stop; there is deliberately no Start
    button, so the settings a client is served under are always the settings on disk. `apply()` runs
    from the module's `onSettingsApplied`, which is also what the initial read and `bfast.refreshTickets` go
    through. It **always stops first**, even when only the function list moved, and `stop()`
    `closeAllConnections()` and drops every session: a client that had already called `tools/list`
    would otherwise go on believing a switched-off function is there. Its next call answers 404 and
    every conforming client re-initializes. That is the behaviour, not a tidy-up. It runs only when
    the **`mcp` block moved** (or the server is not running): `mcpModule` keeps the JSON it last
    applied, because the `settings` tools save the file themselves and a restart would drop the
    very session that asked, mid-answer.
  - **The `settings` function writes `bfast.json`** (`get_settings`, `list_compose_services`,
    `update_environment_settings`, `update_test_settings`, `set_test_service`,
    `remove_test_service`), in the Node-free [mcpSettingsContext.ts](src/mcp/mcpSettingsContext.ts)
    behind an injected `McpSettingsAccess`. Three rules: a change is merged, parsed and checked by
    `settingsRefusal` ([settingsChecks.ts](src/settings/settingsChecks.ts) — the form's Save
    calls the same function, worktrees rule included, and the compose listing moved there too);
    a sent field the forgiving parse drops, or a list that comes back shorter, **refuses the whole
    change** rather than reading as saved; and every write is **refused under `reach: network`** —
    a command written there is a shell line Run Tests runs, and the server has no accounts. Key
    lists are `satisfies Record<keyof …Settings, true>`, so a new field without a row is a compile
    error. `set_test_case_service` sits in `tests` and refuses a service the settings do not
    declare. docs/mcp/README.md §Settings is the spec.
  - **The switches are re-read at call time**, not captured when the session opened
    (`functions()` is a getter through to `mcpFunctions(settings)`), because "a function that is
    switched off cannot be called, even by a client that knew about it a moment ago" is the rule
    that makes them mean anything. `enabledTools` filters `tools/list`; `callMcpTool` checks the
    same set again, then runs the tool's own `run` — a tool is **one object** in `mcpTools.ts`
    (definition and behaviour together), so it cannot be listed without being callable.
  - **A write over MCP announces itself.** The tracker watcher drops events that land while the
    store is writing and the sidebar's own commands refresh the tree themselves, so a write nobody
    in the window asked for would leave the tree behind: `McpContextDeps.onDidWrite` is
    `tracker.refresh` (handed over in `extension.ts`), called after every create, rename and status move.
    `MCP_PROVENANCE` is the comment every such entry carries ("Set over the BFAST MCP server."),
    and `renameTicket` gained a `TitleChangeNote` to carry it. Two asks are **non-events** and
    write nothing — a rename to the current title (the store's rule, so the sidebar shares it) and
    a move to the current status (`mcpContext.setStatus`, matching the sidebar's Set status pick) —
    because a chatty agent would otherwise bury a ticket's real history. `McpEnvironments` is a
    `Pick` of the environment store, so [mcpContext.test.ts](src/test/mcpContext.test.ts) drives
    the `vscode` half against a real `FileTicketStore` and literal fakes for the rest.
  - **Design documents are a function of their own** (`designs`: `list_designs` / `get_design` /
    `create_design` / `update_design`), so switching on `write` never lets a client redraw the
    architecture, and it works switched on alone. `McpContextDeps.designs` is a `Pick` of
    `DesignStore` (the `McpEnvironments` idiom); `designTicket` refuses a missing ticket or an
    AC/test case in words, since `DesignStore.list` answers `[]` for both. A body goes through
    `ensureMermaidFence` (a client is the AI path), `optionalBody` keeps it untrimmed at dispatch,
    the same body is a non-event, and `baseUpdatedAt` is the document's own conflict token. A
    design write never bumps the ticket's `updatedAt`, so the board's `designOpen` effect also
    depends on the open document's `updatedAt` from the list — without it an outside rewrite
    left the open tab on the old body.
  - **Nothing waits for long work.** `run_tests`, `run_scan`, `start_environment` and
    `stop_environment` start and answer at once — an HTTP request held for minutes is one the client
    times out and then *retries*, so each leans on the guard the sidebar already has:
    `testBatches.start()` (a running root, or an overlapping test case), `ScanPanel.requestStart()`
    (per-target, so two calls cannot produce two analyses of one project key whose measures
    overwrite each other), and the environment store's per-environment queue. A refusal is reported
    as `{ started: false }`, never as an error: it is the right answer for a client that retried.
    `requestStart` waits for the webview's `scanReady` when the tab is new, or the run would post
    its phases into a webview that is not listening.
  - **Connect a tool** ([mcpClients.ts](src/mcp/mcpClients.ts), Node-free, bundled by the settings
    webview): the table of AI coding tools BFAST knows a connection shape for — Claude Code (the
    `claude mcp add` line to copy, `.mcp.json` to save; first, and `DEFAULT_MCP_CLIENT`, the pick
    the tab opens on, since it is Implement's default agent too), VS Code (`.vscode/mcp.json`,
    `servers`), Codex (a `~/.codex/config.toml` block, **copy only** — `projectFile` absent is what hides
    Save for the team). `mcpClientSnippet` and `mergeMcpClientConfig` are called by the webview for
    the preview and by the host with the **live** address, so preview, clipboard and file can never
    be three strings; the webview sends only a client id (`copyMcpClientSnippet` /
    `saveMcpClientConfig`), the `copyMcpAddress` rule. The merge replaces only the `bfast` entry and
    **refuses** anything it cannot read as a JSON object — a comment, an array, a `servers` that is
    not a map — so [mcpClientFiles.ts](src/mcp/mcpClientFiles.ts) writes nothing and the tab says
    which file and why. Nothing here touches `bfast.json`, and nothing refreshes a saved file when
    the port or reach later moves: the file keeps the address of the moment it was saved — with
    one exception, a new environment's worktree, whose copies `retargetMcpClientConfig` moves to
    the worktree's own port (see **Environments**).
  - **No accounts, no tokens, no per-client permissions** — deliberately, and out of scope by the
    story's own words. `reach: 'network'` binds `0.0.0.0` and is warned in a **modal host dialog**
    before it takes effect (`confirmMcpReach`, asked only when the reach is actually moving), not a
    banner in a webview, which is something a person clicks past. The one thing the server does
    refuse is a non-loopback `Origin`, which is the DNS-rebinding defence the transport
    specification requires and not an authentication scheme: a real MCP client sends no `Origin`.
  - The `mcp` settings block ([mcpSettings.ts](src/settings/mcpSettings.ts)) follows the `implement`
    block exactly — parse forgiving / validate strict / omitted when empty, a row in `SETTINGS_BLOCKS`,
    and re-validated in `SettingsPanel.save` (`validateSettings`). Only a
    non-default value is ever written (`enabled: true`, `reach: 'network'`, a port other than
    `DEFAULT_MCP_PORT`), so a workspace that never switches it on keeps `bfast.json` byte-identical.
    `functions` is a **list**, not a flag per function, because an **empty** one is meaningful and
    has to be tellable apart from an absent one: everything switched off is a server a client
    connects to and finds nothing to do. And `validateMcpPortText` is the `validatePortVariableText`
    precedent — the parse turns an unusable port into "use the default", so an erased field would
    save fine and only surface as a server on a port nobody asked for.
- Per-workspace settings live in `.vscode/bfast.json` (`trackerFolder`, default `.tracker`, and `userName`,
  the author stamped on ticket history). Split the same way as the tree logic:
  [bfastSettings.ts](src/settings/bfastSettings.ts) is pure — parse (tolerant: a bad field falls back to a
  default rather than throwing), normalize and validate — and is imported by **both** the host and the
  webview so the form and the writer cannot disagree; [settingsService.ts](src/settings/settingsService.ts)
  is the `vscode` half (`workspace.fs` read/write, creates `.vscode` and the tracker folder, caches
  `current` and fires `onDidChange`). The host re-validates every `saveSettings` message rather than
  trusting the webview with a path.
  The form is a frame ([settingsForm.tsx](src/webview/components/settingsForm.tsx)) over
  [settings/](src/webview/components/settings/): `useSettingsForm` holds the one `BfastSettings` object and
  its validation, each tab is a component given that state, and `SETTINGS_TABS` is the tab bar.
  The settings form is eight tabs — **General** (tracker folder, name), **AI assistant** (provider,
  default model, agents, language, turns, idle timeout, agents-at-once — the model sits right under
  the provider, above the long agents list, because it is the one field every run reads), **Design** (design styles as the skills
  that draw them — nothing here is written to `bfast.json`), **Environments**, **Tests**
  (command template, working directory, tests-at-once, idle timeout), **Scan**, **Implement**
  (the coding agent, and the four prompt templates as files with an **Open** button) and
  **MCP server** (on/off, port, reach, the functions on offer, and the live status). All panels stay mounted with one `hidden`, rather than only the selected one
  being rendered: the form edits a single `BfastSettings` object and Save writes all of it, so switching
  tabs must not look like it discarded what was typed on the other.
  **Save no longer closes the tab.** It used to `dispose()`, which was fine while every tab was
  write-only; the MCP tab is the first with a *result* to read — whether the server started, at what
  address, or that the port is taken and the number you typed is still there to change — and closing
  the one surface that can say so would make it unreadable. So `settingsSaved` is what the form shows
  ("Settings saved.", cleared by the next edit), and Cancel is still what closes the tab.
  The optional `ai` block ([aiSettings.ts](src/settings/aiSettings.ts)) follows the same split, with one
  extra rule: **`parseAiSettings` returns `undefined` when nothing survived, and `normalizeSettings` omits
  `ai` entirely then**, so a workspace that never touches the assistant keeps `bfast.json` byte-identical.
  That is also what keeps the two older settings tests, which `deepStrictEqual` against a two-key literal,
  honest. `normalizeSettings` returns a **fresh literal**; the top-level fields are named there and every
  optional block comes from `SETTINGS_BLOCKS`, which the compiler holds complete — so the old trap of a
  block silently dropped on every write is closed at the outer level. It is still open one level down:
  `parseAiSettings` and its siblings rebuild from a literal too, so a new *field inside a block* has to
  be named in that block's parse and normalize.
  **`ai.language`** is the one field in that block that is about *what is written* rather than how the
  provider is run, and it earns its place there because a team picks it once instead of editing the same
  sentence into every agent file. It stores an **ISO 639-1 code** — [languages.ts](src/settings/languages.ts)
  is the whitelist the form's dropdown and the write validator share — and `aiLanguageName` is the single
  address that turns it into the English name a model actually needs. That name is appended by
  `buildPrompt`, **not** by `SYSTEM_PROMPT`: only the SDK provider sends a system prompt, while both
  providers send `AiRequest.prompt` verbatim, so the prompt is the only seam that covers the default CLI
  path. It goes in last, nearest the answer, and carries a second line telling the agent to leave code,
  identifiers, file paths and ticket ids alone — without it a model translates the function names too —
  and a third, `STRUCTURE_STAYS_ENGLISH`, saying that every heading and bold keyword a skill prescribes
  (`**As a** / **I want** / **So that**`, `**Given** / **When** / **Then**`, `## Behaviour`…) stays in
  English and only the prose is translated: left to itself a model opened one translated story with
  one rendering of "As a", the next with another and a third with "As a", so no two tickets shared a shape. Each write
  skill states the same rule under its own `## Structure`, and a test holds both — but the prompt line
  is the one that reaches a workspace whose seeded skill copies predate it or were trimmed. A
  skill that wants the language somewhere specific writes `{{language}}` and the append is skipped, the
  same policy `{{description}}` and `{{instruction}}` already follow. Absent means no instruction at all,
  so a workspace that never picks one gets byte-identical prompts to before the setting existed.
  **`{{parent}}`** joins that set for the sidebar's generate commands, whose pass 2 writes a ticket that
  **does not exist yet**: the title is all it has, so the epic or story it will hang under is the only
  context there is. Its own block, because folding it into `instruction` would file an epic's body under
  "Additional instruction from the user" and mix it with what the user actually typed, and folding it
  into `ticket.description` would have the model read it as a draft to rewrite. **`{{design}}`** joins them for a design run,
  carrying the document as it currently stands so a second press refines rather than restarts; its
  heading says "rewritten in full" outright, or the model reads it as a draft of the *ticket*. The
  optional tail is a `PromptContext` object rather than more positional parameters — `buildPrompt` was
  already at five. The block order is
  ticket → parent → design → instruction → language: the first three are context, the last two are directives, and the
  language stays nearest the answer.
  **`ai.model`** stores an alias (`opus`) or an id (`claude-opus-5`) and is the workspace **default**,
  not the only choice: every board's AI panel and every generate tab has a picker that overrides it
  for that tab's runs (kept in the tab's `setState`, never written back — the setting is the team's,
  the pick is one person's). [models.ts](src/settings/models.ts) is the bundled offer, aliases first
  because Claude Code re-points them at each release and neither the CLI nor the SDK can list models;
  `isModelId` is the one **format** rule — one token of printable ASCII, no whitespace, ≤ 100
  characters — shared by `validateAiSettings`, every picker's Custom box and `aiModel`. It is
  deliberately not a membership test: an id the list does not know is a model that shipped after the
  extension did, and Claude Code refuses a bad one at the **first request**, not at save. Reading stays
  `optionalText` — any non-blank string a hand-edited file holds loads — and there is no `default`
  entry, since absent already means the provider's default.
  **`ai.concurrency`** follows `maxTurns` exactly — forgiving on the way in, refused on the way out,
  omitted when absent. It is the one setting that means nothing to the board: a board has a single
  description to write, so it applies only to the generate tab's fan-out, where each unit is a whole
  provider run and therefore a spend and rate-limit dial as much as a speed one. That is why it is a
  **window-wide** cap rather than a per-batch one — a dial that multiplied by the number of open tabs
  would not be a dial. `sharedLimiter` in [semaphore.ts](src/platform/semaphore.ts) is the one that enforces it,
  built once in [aiModule.ts](src/modules/aiModule.ts) and handed to every generate tab through `GenerateServices.slots`; the
  limit is a getter read as each slot is taken, because a cap two batches disagreed about would not be
  a cap. It takes turns between batches rather than serving waiters first-come, or a second ticket's
  whole batch would queue behind the first's and its tab would sit at `waiting` for a round — the very
  complaint the shared cap exists to avoid reintroducing.
  **`ai.idleTimeout`** follows it in turn, and is stored in **seconds** — a form field asking for
  `180000` is hostile, so `aiIdleTimeoutMs` is the single address for the conversion. Its floor
  (`MIN_IDLE_SECONDS`) earns its place more than the others do: a window short enough to fire
  between two heartbeats would reintroduce exactly the bug the idle watchdog replaced.
  The `implement` block ([implementSettings.ts](src/settings/implementSettings.ts)) follows the
  `tests`/`scan` blocks exactly — parse forgiving / validate strict / omitted when empty, a row in
  `SETTINGS_BLOCKS`, and re-validated in `SettingsPanel.save` (`validateSettings`).
  One field, `agent`, an enum parsed the `environments.provider` way: an unknown value is dropped
  so the default applies, and a **coming-soon value is valid** — the form disables it, but a
  hand-edited file naming one must still save, and Implement says "coming soon" at the click.
- **Setup gate:** until `.vscode/bfast.json` exists the sidebar shows no tickets, only the `viewsWelcome`
  "Init settings" button. It takes both halves to work: `activate()` sets the `bfast.configured` context key
  (the `when` clause on the welcome entries and on every title bar button but the gear) *and* calls
  `provider.setConfigured(false)`, because VS Code only renders a welcome view while the provider yields no
  children. Saving the form fires `onDidChange`, which flips both and the tree appears; `bfast.refreshTickets`
  re-reads the file, so deleting `bfast.json` by hand puts the button back.
  `activationEvents: ["onStartupFinished"]` exists so the context key is set before the view first paints,
  otherwise a configured workspace flashes the welcome button.
- Ticket data sits behind [TicketStore](src/data/ticketStore.ts) (read) and `TicketWriter` (write), joined
  as `WritableTicketStore`. [FileTicketStore](src/data/fileTicketStore.ts) implements both;
  [MockTicketStore](src/test/mockTicketStore.ts) is read-only and lives under `src/test/` because only the
  tree tests use it. A store backed by a remote tracker's API would replace either half without touching the sidebar or webview.
  The read half is two shapes on purpose: `listChildren` / `getSummary` for the tree and the board (one
  folder, or one walk down), `listSummaries` for the commands that need a subtree — see **Reading is by
  level** under **On-disk format**.
- The store depends on [TrackerContext](src/data/trackerContext.ts) — `rootUri()` and `author()`, both read
  **at call time** — rather than on `SettingsService` directly. That is what makes construction order in
  `activate()` irrelevant (settings are read asynchronously, and `onDidChange` fires only from `write()`,
  never from `read()`), and it is what lets the integration tests point a store at a scratch folder without
  writing a real `bfast.json` and flipping `bfast.configured` for every other suite.
- The tracker module's `onSettingsApplied` ([trackerModule.ts](src/modules/trackerModule.ts)) calls `refresh()` **unconditionally**.
  `setConfigured` early-returns when the flag has not moved, so without that line, pointing `trackerFolder`
  at a different directory would leave the old folder's tickets on screen.
- [trackerWatcher.ts](src/data/trackerWatcher.ts) watches the tracker so a `git pull`, a branch switch or a
  save in a normal editor tab reaches the tree. It must be `retarget`ed when `trackerFolder` changes (a
  watcher is bound to its pattern), and it ignores events while `store.isWriting` so BFAST's own writes do
  not cause a second redundant scan. An AI run that edits another ticket's file fires it **mid-run**, by
  design: that is how the sidebar and every other board learn of the edit, and `reloadAll` → `showTicket`
  on the running board's own ticket leaves `activeRun` alone.
- The pure, `vscode`-free half of the tracker is directly unit-testable and is where the rules live:
  [trackerPaths.ts](src/data/trackerPaths.ts) (`allowedChildTypes` is the hierarchy, and the `when` clauses
  in `package.json` mirror it — keep them in sync; the rule is that a `when` must never permit what the
  hierarchy forbids, not that it must be exhaustive, which is why there is deliberately no "Generate test
  cases" on a `story` even though `allowedChildTypes('story')` allows one), [yaml.ts](src/data/yaml.ts) (a flat `key: value`
  reader/writer, hand-rolled rather than adding a YAML library for one flat file — the AI assistant's
  optional SDK is the *only* host dependency, and it stays that way),
  [ticketMetadata.ts](src/data/ticketMetadata.ts) and [historyFile.ts](src/data/historyFile.ts). All of
  them follow `parseSettings`' rule: **never throw** — a bad field falls back to a default.
- The webview is plain React (no UI toolkit) plus `marked`. All colours come from `--vscode-*` theme
  variables in [style.css](src/webview/style.css); the only hard-coded colours are the type badge and
  status pill.
- Command IDs in code must match `contributes.commands` in [package.json](package.json) exactly
  (prefix `bfast.`). Anything a module registers must be returned in its `disposables`, which `activate()` pushes onto
  `context.subscriptions`.
- Tests in [src/test/](src/test/) run inside a real VS Code instance via `@vscode/test-cli` and can import
  the `vscode` API. A suite must activate the extension (or run a contributed command) before asserting on
  registrations, and an editor tab appears a tick after the command resolves. `.vscode-test.mjs` opens
  [src/test/fixtures/workspace/](src/test/fixtures/workspace/) so settings code has a workspace folder.
  That fixture is git-tracked, so a suite that writes into it must both clean up in `suiteTeardown` **and**
  be covered by `.gitignore` — teardown alone leaks on a crashed run, the ignore alone leaves the tree
  dirty mid-run. A suite that writes a real `.vscode/bfast.json` must restore what was there before, or it
  flips `bfast.configured` and makes the other suites depend on run order.
- The root [tsconfig.json](tsconfig.json) excludes `src/webview`, which has its own tsconfig
  (JSX, DOM lib, `noEmit`). TypeScript is `strict` throughout; the host is module `Node16` / target `ES2022`.
