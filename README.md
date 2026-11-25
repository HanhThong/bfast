# BFAST

A ticket tracker that lives in your repository. BFAST adds a **B** icon to the VS Code
activity bar; its sidebar is a tree of tickets — epic → story → acceptance criterion → test case —
and clicking one opens the **BFAST board**, an editor tab for that ticket's description and history.

Tickets are plain folders and files on disk, so they review in a pull request and travel with a
branch.

**Documentation:** [bfast.hanhthong.me](https://bfast.hanhthong.me/) — installation, a quick start,
a guide per feature and the settings reference.

## Features

- **Native ticket tree** with a live filter, per-type icons and status colours, loaded a level at a
  time — the epics first, each level as you expand it — and following the board: opening a ticket, or
  switching to its tab, selects it in the tree. A filter match keeps its whole related tree — every
  ancestor up to its epic and everything below it.
- **The board** — one editor tab per ticket, titled `<id> <title>`. Markdown description with a
  formatting toolbar (headings, bold, italic, underline, bullets), image paste / drop / file-pick
  into the ticket's own `assets/` folder, and an append-only history.
- **AI assistant** — write a ticket's description from an agent + skill you own as files under
  `.bfast/agents/`. Runs through the `claude` CLI you already have (default) or the Claude Agent
  SDK. The result lands in the draft, never straight on disk — and when you ask it to change
  *another* ticket too, it may edit that ticket's description file, which BFAST then records in
  that ticket's history.
- **Break a ticket down** — "Generate stories" on an epic, "Generate acceptance criteria" on a
  story. A dedicated tab shows the plan, lets you untick what you do not want, then writes each
  description in parallel. Nothing is created until you have seen the list — and you can ask for
  changes first ("split the third one", "drop anything about billing"): the agent updates the list
  in the same conversation. Reopen the tab later and it offers to continue where you left off.
- **Environments** — one disposable dev environment per story or epic: a `git worktree` on
  `story/<id>` / `epic/<id>` with allocated ports and the repo's stack under a per-ticket
  project name, started and stopped from the sidebar — plus a **master environment** that
  runs the same stack in the workspace folder itself, no ticket needed.
- **Code Quality** — SonarQube, either deployed for you (BFAST runs the container and generates its
  admin password and analysis tokens itself, so there is nothing to copy or paste) or an instance
  you already have. Right-click an environment → **Run Scan**: the quality gate, the measures and the
  issues open in a tab, and the verdict is recorded in the ticket's history. A ticket with an
  environment is scanned in its worktree.
- **Implement** — right-click any ticket → **Implement…** builds a prompt for it (a template per
  ticket type, the description inline, everything else by path), writes it to
  `.bfast/implement/prompts/<id>.md`, and hands Claude Code one sentence naming that file, unsent:
  in a new tab's input, or — with the CLI — typed on a terminal line, waiting for Enter. Nothing is
  written into the ticket; the templates are files in `.bfast/implement/` you can edit. See
  `docs/implement/`.

## On-disk format

One folder per ticket, nested. Inside each: the description `.mdx` named after the type, a
`metadata.yaml` and a `history.md`. Child tickets are subfolders.

```
.tracker/
  EP-1-Authentication/                    Epic.mdx  metadata.yaml  history.md
    ST-1.2-Sign_in_with_email/            Story.mdx …
      AC-1.2.1-Wrong_password_error/      AC.mdx …
        TC-1.2.1.1-Unknown_email/         TestCase.mdx …
```

A folder is named after the ticket's id and its title, **40 characters at most**, so the deepest
path stays under Windows' 260-character limit even in an environment's worktree. **Shorten Long
Ticket Folder Names** (the Tickets section's `…` menu) brings folders named under the older, longer
rule into line. See `docs/tracker/`.

Reading is forgiving: a hand-renamed or hand-moved folder gets a warning in the sidebar, never an
orphan. Writes re-read from disk first and refuse a stale edit, so a save can never silently
discard a change made in another tab or pulled in from git.

## Requirements

- VS Code 1.134 or newer.
- For the AI assistant: either the [`claude` CLI](https://claude.com/claude-code) on your `PATH`
  (the default provider), or an `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` — set through the
  **BFAST: Set AI API key** command, which stores it in VS Code's secret storage.
- For Implement: the [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code)
  VS Code extension (`implement.agent: claude-code`), or the `claude` CLI on your terminal's
  `PATH` (`claude-code-cli`) — the prompt is handed over, never run by BFAST.
- For environments: `git` and `docker` (Compose v2).
- For code scanning: `docker` (Compose v2). On Linux, SonarQube's Elasticsearch also needs
  `vm.max_map_count` raised — BFAST checks before deploying and gives you the command. An
  external SonarQube needs neither.

## Settings

Settings are per workspace and live in `.vscode/bfast.json`, not in user settings — they are meant
to be committed. Open the form with **BFAST: Open Settings** (the gear in the sidebar title bar), or
with the **Init settings** button the sidebar shows until the file exists.

| Key | Meaning |
| --- | --- |
| `trackerFolder` | Where tickets live, relative to the workspace. Default `.tracker`. |
| `userName` | The author stamped on ticket history. |
| `ai.provider` | `claude-cli` (default) or `claude-agent-sdk`. |
| `ai.model` | The default model — an alias such as `opus` or `sonnet`, or an id such as `claude-opus-5`. Every board's AI panel and every generate tab can pick a different one for its own runs; see `docs/ai/models.md`. |
| `ai.maxTurns` | Passed to the provider. |
| `ai.language` | ISO 639-1 code the descriptions are written in. |
| `ai.concurrency` | How many descriptions a breakdown writes at once. |
| `environments.*` | Provider, stack command and the port variables your stack reads. |
| `tests.command` | Shell line run once per test case by **Run Tests**, `{{id}}` substituted. Each run is filed in the results folder and shown on the ticket's board's **Tests** tab; only a verdict that moves the status touches the ticket. |
| `tests.cwd` | Working directory for test runs, relative to the workspace. |
| `tests.resultsFolder` | Where runs are filed, relative to the workspace and outside the tracker: `<folder>/<test case id>/<runId>/`. Default `.bfast/test-results`. |
| `tests.evidence` | Glob for what the test tool left behind for one test case (`e2e/evidence/**/{{id}}.*`), copied into that test case's run folder — a video plays inline on the board. |
| `tests.evidenceCommand` | Shell line the board's **Open** runs for an evidence file it cannot show, such as a Playwright trace; `{{file}}` arrives quoted. |
| `tests.concurrency` | How many test commands run at once. Default 1. |
| `tests.idleTimeout` | Seconds of silence before a run is stopped. Default 300. |
| `scan.mode` | `auto` (BFAST deploys SonarQube) or `external` (one you already have). |
| `scan.hostUrl`, `scan.organization` | The external instance, and its organization on SonarQube Cloud. |
| `scan.projectKey` | The one SonarQube project this workspace files every scan under, when the checkout's own `sonar-project.properties` does not name one. Defaults to the folder name. |
| `scan.scannerMode` | `docker` (the official scanner image) or `command` (a shell line you write). |
| `scan.idleTimeout` | Seconds of silence before a scan or a server boot is stopped. Default 600. |
| `implement.agent` | Which coding agent **Implement…** hands the prompt to. `claude-code` (default, the extension) and `claude-code-cli` (a terminal) are implemented; the other entries are coming soon. The prompt templates themselves are files in `.bfast/implement/`; see `docs/implement/`. |

No API key or token is ever stored here. Tokens live in VS Code's secret storage —
**BFAST: Set AI API key** and **BFAST: Set SonarQube Token** put them there.

## Known issues

- Moving a ticket subtree is not offered: every folder carries its full id, so a move would have to
  rename all of them.
- The Kubernetes environment provider is a stub; `docker-compose` is the working one.
- Implement hands prompts to Claude Code only (extension or CLI); `codex`, `codex-cli`, `opencode`,
  `opencode-cli`, `cursor` and `github-copilot` are accepted in `bfast.json` but fail with
  "coming soon".
- SonarQube Community Edition analyses the main branch only, so every scan — from every ticket and
  every worktree — overwrites the same project. A scan never changes a ticket's status either; it
  writes a history entry, and Run Tests keeps `done` and `blocked` to itself.

## License

Licensed under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). The full text
is in the `LICENSE` file beside this one.
