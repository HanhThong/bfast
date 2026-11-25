# BFAST Implement

Right-click any ticket in the **Tickets** section → **Implement…**: BFAST builds a prompt for that
ticket — a different template per ticket type — writes it to `.bfast/implement/prompts/<id>.md`,
opens the configured coding agent (Claude Code today: its VS Code extension, or the `claude` CLI in
a terminal) and hands it **one sentence naming that file, filled in and not sent**. That is the
whole feature. Nothing runs until you press Enter over there, and nothing is written into the
ticket: no history entry, no status change, no `updatedAt` bump. Pressing it twice opens two tabs
and changes nothing else.

The prompt is the handover, not the work. The ticket stays the specification — the agent is told
where it lives and what to read, does the implementing in its own session under its own
permissions, and [Run Tests](../tests/README.md) is what says afterwards whether the criteria hold.

This folder is the feature's specification and user guide:

- [configuration.md](configuration.md) — the `implement` block in `.vscode/bfast.json`, and the
  prompt template files in `.bfast/implement/`
- [provider-interface.md](provider-interface.md) — for contributors: the `CodingAgent` seam, the
  Claude Code route, and how to add the next agent

## The shape: one prompt template per ticket type, one handoff

| Clicked | Template | What the prompt asks |
|---|---|---|
| an epic | `.bfast/implement/epic.md` | read every story, criterion and design document under it, plan, then implement story by story |
| a story | `.bfast/implement/story.md` | implement it so that every acceptance criterion holds and every test case passes |
| an acceptance criterion | `.bfast/implement/acceptance-criterion.md` | implement this one Given / When / Then and make its test cases pass |
| a test case | `.bfast/implement/test-case.md` | write the automated test for these steps, named after the ticket id, so that `tests.command` finds it and it passes |

The four templates are files the workspace owns — see
[configuration.md](configuration.md#prompt-templates). The shipped ones are a starting point, not a
rule: edit them the way you would edit an agent's role file. Beside them sits one more file,
`rules.md`, the **working rules** every template ends with (`{{rules}}`): how to approach any
ticket — think before coding, simplicity first, surgical changes, goal-driven execution — as
opposed to what this kind of ticket asks for. The split is the role/skill one: the standard is the
same whatever is being implemented, so it lives once.

**The handoff is the same for every agent.** Whatever `implement.agent` names, the rendered prompt
goes to `.bfast/implement/prompts/<id>.md` and the agent receives exactly one sentence:

```
Your task is in .bfast/implement/prompts/ST-1.2.md. Read that file first, then do what it says.
```

— in the Claude Code extension's input as it stands, on a terminal line wrapped in `claude "…"`.
So the two routes hand over the same thing, a chat input and a shell line get a string whose every
character BFAST chose, and an agent added later (a deep link with a length cap, a chat command
taking a query) gets the same shape without a second way of building a prompt. To read or change
what will be sent, open the file; to send it, press Enter.

**What goes into the prompt, and what stays on disk.** The prompt carries the clicked ticket's own
description inline — it is the thing to implement, and the agent should not have to fetch its own
task — and everything else **by path**: the epic and story it hangs under, the criteria and test
cases below it, the design documents on it and on its ancestors, each as an id, a title and a
workspace-relative file path. A coding agent has file tools, and the tracker is provably inside the
workspace (`trackerFolder` may not be absolute or contain `..`), so a path is something it can read
— and read *fresh*, after the ticket was edited on a board or pulled from git, where a copy pasted
into the prompt would be a snapshot. It also keeps an epic's prompt a map rather than a dump.

**Children go two levels down.** An epic's prompt lists its stories, sub-epics and test cases and whatever
sits directly under them — their criteria, and a test case that covers a story as a whole; a story's, its
criteria and test cases; a criterion's, its test cases; a test case's, nothing. That is the level
the instruction works at plus one — enough to plan against — and the deeper levels are in the
folders the agent is told to read anyway.

## Outcomes

One row per outcome the command can produce; the code must keep matching this table. **No outcome
writes into the ticket** — the last column exists to say so.

| Outcome | When | What you see | Ticket |
|---|---|---|---|
| `opened` | the agent is available, the prompt was built and written to `.bfast/implement/prompts/<id>.md` | `claude-code`: a Claude Code tab opens with the sentence in its input, unsent. `claude-code-cli`: a terminal opens with `claude "<sentence>"` typed and waiting for Enter. No toast either way | unchanged |
| `not-installed` | the agent's extension is not installed, or its CLI is not on the `PATH` | an error with **Show in Marketplace** (the extension) or the install instructions (the CLI) — BFAST never installs anything itself | unchanged |
| `unsupported` | the extension is installed but no longer offers the entry point BFAST hands the prompt to | an error naming the command, with **Copy Prompt** so the handoff still happens by hand | unchanged |
| `not-implemented` | `implement.agent` names an agent that is still coming soon | an error with **Open Settings** | unchanged |
| `not-configured` | no workspace folder, no `bfast.json`, or a tracker that is not folders on disk | an error with **Open Settings** | unchanged |
| `provider-error` | the prompt file could not be written, the extension failed to activate, or the command rejected | an error with the reason and **Copy Prompt** | unchanged |

**Why nothing is written.** A handoff is not a change to the ticket — the change is the code the
agent will write, and Run Tests records whether it worked. A history line per click would be the
test-log-in-history mistake `docs/tests/` undid, a status move to `in-progress` would be a claim the
ticket cannot back yet, and an `updatedAt` bump would fail the next save of a board sitting open
mid-edit on that ticket. Implement leaves the tracker byte-identical.

## Placeholders

A template may use:

| Token | Value | Notes |
|---|---|---|
| `{{id}}` | the full ticket id — `ST-1.2` | Unique across the tracker. |
| `{{key}}` | the local segment — `ST-2` | **Not unique** — every epic's second story is `ST-2`. |
| `{{title}}` | the ticket's title | Free prose — safe here; see below. |
| `{{type}}` | the type as prose — `epic`, `story`, `acceptance criterion`, `test case` | |
| `{{status}}` | the ticket's status — `todo`, `in-progress`, `in-review`, `done`, `blocked` | |
| `{{folder}}` | the ticket's folder, **workspace-relative with forward slashes** — `.tracker/EP-1-Authentication/ST-1.2-Sign_in_with_email` | Unlike `tests.command`'s `{{folder}}`, which is absolute: this one goes into a prompt the agent resolves against the workspace it is open in, and a worktree window has the same relative path. |
| `{{file}}` | the description file — `{{folder}}/Story.mdx` | The file to read first. |
| `{{description}}` | the description, verbatim | Markdown; `(empty)` when the ticket has none. |
| `{{ancestors}}` | the chain above the ticket, epic first | One line each: ``- `EP-1` Authentication — `.tracker/EP-1-Authentication/Epic.mdx` ``. `(none)` for an epic. |
| `{{children}}` | the subtree below it, two levels deep | The same line format, indented two spaces per level, in tree order. `(none)` when there is nothing below. |
| `{{designs}}` | the design documents on the ticket **and** on its ancestors | ``- `ERD-1` Account model (Entity-Relationship Diagram, on `ST-1.2`) — `.tracker/…/ERD-1-Account_model.mdx` ``. `(none)` when there are none. |
| `{{testCommand}}` | for a test case, `tests.command` with its placeholders substituted for that test case; for any other ticket, the template as configured, `{{id}}` and all | So the agent knows how the team runs tests. `(not configured — see Settings → Tests)` when `tests.command` is unset. |
| `{{tracker}}` | the tracker folder, workspace-relative — `.tracker` | So a template can say "do not edit anything under `{{tracker}}`". |
| `{{rules}}` | the body of `.bfast/implement/rules.md` — the working rules every template shares | Think before coding, simplicity first, surgical changes, goal-driven execution (after Andrej Karpathy's guidelines). One file, so a change to how any ticket is approached is made once; the shipped one stands in when it is missing, `(none)` when it is empty. See [configuration.md](configuration.md#prompt-templates). |

An unknown `{{token}}` is left in the prompt untouched — the policy `tests.command` and the AI
assistant's templates already follow — so a template can carry a literal `{{example}}` for the
agent to fill.

`{{title}}` and `{{description}}` are offered here and deliberately **not** in `tests.command`, and
the difference is the destination: a test command is a shell line, where a title that arrived from
a `git pull` is command injection, while this prompt reaches a **file**, where it is text. What
reaches the agent — a chat input, or a terminal line — is the handoff sentence, whose every
character BFAST chose; see [How the handoff works](#how-the-handoff-works). A `… CLI` agent that
is still coming soon is waiting for that same sentence to be wired to its executable, not for a way
to quote prose.

## How the handoff works

- **The prompt is a file.** Every click renders the template and writes the result to
  `.bfast/implement/prompts/<id>.md` — one file per ticket, overwritten on the next click, a
  duplicate's `#` written as `_` — before any agent is asked. The agent then receives the
  **handoff sentence**, `Your task is in <that path>. Read that file first, then do what it
  says.`, and nothing else. The sentence is fixed, the path is fixed, and the id is letters,
  digits, dots and hyphens, so the string is the same on every surface and nothing from the
  ticket's prose is ever inside it. Press Enter and the agent reads the file and works; edit the
  file first if the prompt needs changing.
- **Claude Code** (`implement.agent: claude-code`) is asked to open a new session tab with the
  sentence as its initial input, through the command its extension registers for exactly that
  (`claude-vscode.editor.open`, a new session — never an existing one, which would show the text
  nowhere). The input is **filled, not submitted**. The tab opens where Claude Code's own **Open in
  New Tab** would; its `claudeCode.useTerminal` setting does not apply — pick `claude-code-cli` for
  a terminal.
- **Claude Code CLI** (`implement.agent: claude-code-cli`) needs no extension, only `claude` on the
  `PATH` your terminal has. BFAST opens a terminal named after the ticket in the workspace folder
  and **types, without pressing Enter**, the sentence as `claude`'s prompt:

  ```
  claude "Your task is in .bfast/implement/prompts/ST-1.2.md. Read that file first, then do what it says."
  ```

  A terminal takes a *shell line*, and the only safe shell line is one whose alphabet you control —
  which the sentence's is, so no quoting rule for any shell is involved. The line runs `claude` as
  your shell finds it; `ai.executablePath` — the AI assistant's spawn path — is not used here, since
  a path is a shell word whose quoting differs by shell, and the terminal's own `PATH` is what a CLI
  user has.
- **The templates are read when you click**, never cached, so a change saved in an editor tab is in
  the very next prompt. A missing template file falls back to the shipped one; a folder that has
  never existed is seeded with all four; an emptied folder is left alone — see
  [configuration.md](configuration.md#prompt-templates).
- **The agent sees the rendered template and nothing else**: no system prompt, no tool list, no
  BFAST setting — those are the agent's own, exactly as if you had typed the text. BFAST's AI
  assistant (`ai.*`, `.bfast/agents/`) is a different feature with a different contract: it writes
  ticket *prose* under a hard-coded read-only tool list; Implement hands a ticket to an agent that
  will write *code* under whatever permissions you gave it.

## Reporting

Nothing streams, so there is no output channel and no progress notification: the tab opening *is*
the report. A failure is one error message with the action that fixes it — **Show in Marketplace**,
**Open Settings**, **Copy Prompt** — as the outcome table says.

## Trust

The prompt is text handed to a program you installed and signed in to, and what that program then
does with the repository is governed by its own permission settings, not by BFAST. BFAST itself
runs no command — the CLI route types one fixed line into a terminal and leaves Enter to you —
installs nothing, and writes nothing for this feature except the one-time seed of
`.bfast/implement/` and the rendered prompt file under `.bfast/implement/prompts/` that every
click writes and the sentence names. The
templates are committed files that reach an agent with file tools: review a pulled change to them
as you would a change to `CLAUDE.md`. In Restricted Mode BFAST does not run at all
(`capabilities.untrustedWorkspaces.supported: false`), and that declaration stays load-bearing
here.

## Limitations and troubleshooting

- **Claude Code only, today** — as the extension (`claude-code`) or the CLI (`claude-code-cli`).
  `codex`, `codex-cli`, `opencode`, `opencode-cli`, `cursor` and `github-copilot` are accepted in
  `bfast.json` and disabled in the form; picking one by hand fails with **coming soon**. The
  [seam](provider-interface.md) is where the next one goes.
- **"The Claude Code extension is not installed."** Install `anthropic.claude-code` from the
  Marketplace — the error's button opens it there — and click again; no reload is needed.
- **"Could not run `claude`."** The CLI route checks `claude --version` through the platform shell,
  the way a terminal would find it (`.cmd` shims included). Install the Claude Code CLI so that
  `claude` is on the `PATH`, open a new window if you just changed the `PATH`, and click again — a
  failed check is repeated on the next click, a passed one is remembered for the window.
- **The CLI starts nothing by itself.** The terminal shows the line and waits; the session begins
  when you press Enter. If the terminal opened but the line is missing, the shell was still
  starting when it was typed — press Up, or type it again from the file's name.
- **`.bfast/implement/prompts/`** holds the last prompt handed over per ticket, whichever agent, and
  nothing prunes it. Gitignore it, or commit it as the record of what was asked — the team's call,
  the same one the test results folder leaves to you. It is not a template: the settings form and
  the seeding rule ignore it.
- **The Claude Code input shows one line, not the prompt.** That is the sentence; the prompt is the
  file it names, which Claude Code reads as its first action. Open the file to see or change what
  will be worked on.
- **"… no longer offers `claude-vscode.editor.open`."** Claude Code renamed or removed the command
  BFAST hands the prompt to (it has moved once already, from `claude-code.*`). Update BFAST; until
  then **Copy Prompt** puts the same text on the clipboard to paste into a session yourself.
- **Remote windows.** The tab opens in the window whose extension host runs Claude Code, and the
  CLI route's terminal is the remote's, with the remote's `PATH`. In a Remote-SSH, WSL or container
  window that is the same window; the prompt's paths are relative to its workspace, so they
  resolve there.
- **An empty `.bfast/implement/`** means you deleted the templates on purpose: the shipped ones are
  used and the files are not put back. Delete the *folder* to have all four re-seeded, or press
  **Open** on the settings form's Implement tab, which restores the one file it opens.
- **A large epic makes a long prompt.** Nothing is truncated: forty stories with their criteria are
  eighty lines of paths. If that is more than the agent should be handed at once, implement story by
  story — or shorten `epic.md`, which is yours.
