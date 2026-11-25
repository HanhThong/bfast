# The `CodingAgent` seam

For contributors: how Implement is split, what an agent owns, and how to add the next one. It
follows the pattern `AiProvider`, `EnvironmentProvider` and `ScanProvider` already set — a
`vscode`-free interface module with no implementation, one registry reading the settings at call
time, and a fake proving the seam needs no cast and no real extension to test against.

## The seam is the agent, and an agent is a destination

`CodingAgent` is keyed by **agent** — `claude-code` and `claude-code-cli` today; `codex`,
`opencode`, `cursor`, `github-copilot` and each one's `-cli` variant are registered as stubs. A
"CLI" entry is its own agent rather than a mode on another, because the two are different
destinations — a chat input, a terminal — and the two Claude Code agents share nothing but the
sentence they hand over: one passes it to a command, the other types it wrapped in `claude "…"`
(see [The Claude Code CLI route](#the-claude-code-cli-route)). One flat list keeps
`implement.agent` a single value and the form a single select; a per-agent second axis would have
been a table whose columns mean different things in every row.

An agent is a **destination, not a runner**. The AI assistant's `AiProvider` runs a model and
streams its answer back; a `CodingAgent` hands text to another program and is done. That is why the
interface below has no progress listener, no cancel, no result and no `dispose`: nothing streams and
nothing outlives the call.

## The split: prompt vs handoff

- **`implementPrompt.ts`** — pure, Node-free, the settings webview imports it — owns the template
  grammar: the file names, the frontmatter, the placeholder set, the line formats for ancestors,
  children and designs, and the rendering (`substituteCommand`, the `{{token}}` reader
  `tests.command` uses, so the two grammars cannot drift).
- **`implementContext.ts`** — the `vscode` half — gathers the values: the ticket, its ancestors by
  walking `parentId` upward (never by parsing the id), its subtree through `listSummaries` +
  `buildTree`, the design documents, the workspace-relative paths, the test command — and renders.
- **`implementPromptStore.ts`** owns the files in `.bfast/implement/`: seeding the four templates
  and the shared `rules.md`, reading each with the bundled fallback (`read(type)` / `readRules()`),
  opening one for the settings form, and `writeHandoff(id, prompt)` — the rendered-prompt file
  under `prompts/` every handoff sentence names.
- **`implementCommand.ts`** is the sequence: availability, the prompt, `writeHandoff`, then
  `handoffSentence(path)` and `open`. The file is written **here, for every agent**, which is what
  makes the extension route and the CLI route hand over the same thing without an agent having to
  know why.
- A **`CodingAgent`** owns one thing: getting the sentence into its program. It is handed the
  sentence (`ImplementRequest.message`), the file's path and the ticket id — never the prompt's
  text, which is on disk by then — reads the workspace folder from its context
  (`CodingAgentContext`, the `AiContext` shape: functions, read at call time), and must need
  nothing else — not the tracker, not the template, not any setting beyond its own id.

## The interface

```ts
export type ImplementErrorCode =
  | 'not-installed'    // the agent's extension is not installed
  | 'unsupported'      // installed, but no longer offers the entry point BFAST uses
  | 'not-implemented'  // a coming-soon stub
  | 'not-configured'   // no workspace, no tracker folder, no bfast.json
  | 'provider-error';  // activation failed, or the handoff rejected

export interface ImplementRequest {
  /** Which ticket this is about — for a terminal's name. */
  ticketId: string;
  /** Where the rendered prompt already is: `.bfast/implement/prompts/ST-1.2.md`. */
  handoffPath: string;
  /** `handoffSentence(handoffPath)` — the one string every agent hands over, verbatim. */
  message: string;
}

export interface CodingAgentAvailability {
  ok: boolean;
  reason?: ImplementErrorCode;
  /** The error's text. Must never contain the prompt. */
  message?: string;
}

export interface CodingAgent {
  /** Stable machine id; doubles as the settings value. */
  readonly id: ImplementAgentId;
  /** User-visible name, e.g. `'Claude Code'`. */
  readonly label: string;

  /** Cheap. Asked before the prompt is built, so a missing extension costs
   *  no tracker read and the error can name the fix. */
  availability(): Promise<CodingAgentAvailability>;

  /** Hands the prompt over. Resolves when the agent's surface has it — the
   *  input filled, the tab open — and never when the agent has *done*
   *  anything with it. Rejects with `ImplementError`. */
  open(request: ImplementRequest): Promise<void>;
}

export class ImplementError extends Error {
  constructor(readonly code: ImplementErrorCode, message: string, readonly cause?: unknown);
}
```

**Why `open` returns `void`.** There is no result to return: the agent's answer is the code it
writes into the repository, on its own time, under its own permissions, and BFAST learns about
that the way it learns about any edit — through the tracker watcher and Run Tests. A promise that
resolved "when the agent is done" would have to poll another extension's session, and would be
wrong the moment the user closed the tab.

**Why the request carries a sentence and not the prompt.** Every route gets the same string, so
the seam cannot be where the two diverge; and the string's alphabet is fixed, so the one agent that
puts it on a shell line needs no quoting rule for any shell. The prompt's text is on disk by the
time an agent is asked, and an agent that wanted it would be reading the very file it is about to
hand over — a second copy of what the sentence already says.

**Why errors carry a code.** The command layer switches on it for the action button — the
Marketplace for `not-installed`, Settings for `not-implemented` and `not-configured`, **Copy
Prompt** for `unsupported` and `provider-error`, where the prompt exists and only the file or the
delivery failed (what is copied is the prompt, not the sentence). A stub's `not-implemented` is
what turns a settings value committed ahead of its implementation into a sentence in a toast
rather than a crash — the `k8sProvider` posture.

**Why `availability` is asked first, and again inside `open`.** First, so a missing extension costs
no tracker read and the error names the fix before anything else happens. Again, because
`configuredCodingAgent` resolves `implement.agent` at call time and the settings may have been
saved between the two calls; an agent that trusts an earlier answer would hand the prompt to the
wrong program.

## The Claude Code route

`ClaudeCodeAgent` (`src/implement/claudeCodeAgent.ts`) is the one implementation. It reaches the
Claude Code extension (`anthropic.claude-code`) through the command that extension registers for
"open a new session tab with this text in the input":

```ts
vscode.commands.executeCommand('claude-vscode.editor.open', undefined, request.message);
//                                                          ^ session id — always undefined
```

Three facts about that command shape the code, all read from the extension rather than from a
document, and each pinned by a test:

- **The text fills the input and is not submitted.** That is the behaviour Implement wants — the
  user reads, adds a file, then sends — and it is the extension's, not something BFAST can choose.
  Should a release start submitting, the feature's contract moves with it and this paragraph is
  what to update.
- **The first argument is a session id, and it must be `undefined`.** Naming a session that is
  already open reveals that tab and *drops the prompt* with a toast ("Your prompt was not
  applied"). A test pins the exact argument tuple.
- **The id is undocumented and has moved once** (`claude-code.*` → `claude-vscode.*`). So
  `availability()` does not stop at "the extension is installed": it activates the extension when
  it is not yet active and checks `vscode.commands.getCommands(true)` for the id, answering
  `unsupported` when it is gone — an error that names the command and offers the prompt for
  pasting, rather than a click that does nothing. The command id and the extension id are two
  constants in that one file.

`availability()` in order: no extension → `not-installed`, the message naming the Marketplace id;
not active → `activate()`, a failure → `provider-error`; the command absent from the list →
`unsupported`. `open()` asks availability again and then executes the command; a rejection is
`provider-error` carrying the extension's message and never the prompt. Every `vscode` call goes
through an injectable `ClaudeCodeDeps` (`getExtension`, `getCommands`, `executeCommand`) defaulting
to the real API — the `runner: ProcessRunner = runProcess` idiom — so the suite drives it with
fakes and never a real extension.

**Rejected: the documented URI handler.** `vscode://anthropic.claude-code/open?prompt=…` exists for
shell aliases and bookmarklets. Three costs: a documented cap of 5,000 characters on the prompt (a
story with its criteria and test cases listed is over it), VS Code's confirmation dialog the first
time an extension is allowed to handle a URI, and the re-encoding `Uri` and `openExternal` do on
the way — a `#`, which every markdown heading starts with, ends the query. The command route has
none of them; its one cost, drift, is what the `getCommands` check and **Copy Prompt** are for.

## The Claude Code CLI route

`ClaudeCodeCliAgent` (`src/implement/claudeCodeCliAgent.ts`) is the second implementation, and it
depends on no extension — only on `claude` being on the `PATH` a terminal gets. By the time it is
asked, the command layer has written the prompt to `<workspace>/.bfast/implement/prompts/<id>.md`
(the id with a duplicate's `#` written as `_` — the `testCaseResultsFolder` rule: `#` breaks a
shell line and no other id carries an underscore) and built the sentence. The agent does two
things:

1. **A terminal opens** — `vscode.window.createTerminal({ name: 'Claude Code — <id>', cwd })`, the
   workspace folder as its cwd, so the sentence's relative path resolves.
2. **One line is typed, and Enter is not pressed** — `terminal.sendText(line, false)`:

   ```
   claude "Your task is in .bfast/implement/prompts/ST-1.2.md. Read that file first, then do what it says."
   ```

   That is `claude`'s positional prompt: the very sentence the extension route puts in its input.
   Its alphabet is `A-Z 0-9 . , - _ /` and a space, every one literal inside double quotes on
   every shell — so the line is the same string on every shell
   BFAST could be typing into, and **nothing from the ticket's prose ever touches it**. Leaving
   Enter to the user keeps the contract the extension route has: filled, not sent. The line builder
   checks the alphabet again and throws rather than quotes — defence in depth for the one place a
   string meets a shell.

`availability()`: no workspace folder → `not-configured`; then `claude --version` run through
`shellCommand` + `runProcess` — the platform shell, **not** a bare `spawn`, because that is how the
terminal will resolve `claude` too, `.cmd` shims included — with a non-zero exit or a missing binary
as `not-installed`, the message saying to put `claude` on the `PATH`. A pass is remembered for the
window; a failure is asked again on the next click, so installing the CLI needs no reload.
`open()`: availability again, the terminal, the line. The `vscode` calls and the runner go through
an injectable `ClaudeCodeCliDeps` (`runner`, `openTerminal`), so the suite asserts the exact line
against fakes.

**Rejected: the prompt on the line.** `claude '<prompt>'` needs a quoting rule per shell — `'\''`
for `sh`, `''` for PowerShell, none that works for `cmd.exe`, which cannot hold a newline inside
quotes at all — and the default terminal is any of those. It also echoes two screens of markdown as
a command line before `claude` starts. That is the injection `tests.command` refuses `{{title}}`
for, now with prose several thousand characters long; the file is the route that has no quoting.

**Rejected: typing the prompt into the running TUI.** It would be the most faithful "filled, not
sent" — but there is no stable signal that `claude` has started reading keys, and text that
arrives at a shell prompt instead is executed line by line. A race whose losing side runs a
description as shell commands is not a route.

**Rejected: `ai.executablePath`.** It is the AI assistant's *spawn* path (`shell: false`, an
argument list). On a terminal line a path is a shell word — PowerShell needs `& "…"`, `cmd.exe`
refuses a `%` — so the CLI route runs bare `claude` and lets the terminal's `PATH` say where it
is, which is what a CLI user has anyway.

**Rejected: Claude Code's `claude-vscode.terminal.open(prompt)`.** It quotes the prompt onto the
line for you and runs it at once: both the things above, and an extension dependency the CLI
route exists not to have.

## Conventions an agent must follow

- **Errors** are `ImplementError` with a code from `ImplementErrorCode`. Never let a raw `Error`
  escape, and **never interpolate the prompt** into a message — it reaches a notification.
- **No dialogs, and no `vscode` in the seam module.** An implementation may import `vscode` (Claude
  Code's does, through its deps object); `codingAgent.ts` may not. An agent that needs to ask the
  user something surfaces an error and lets the command layer decide.
- **Never install, never press Enter, never hand over anything but the sentence.** A missing
  program is `not-installed`, and the command layer offers the Marketplace or the install note. An
  agent passes `request.message` on verbatim — a CLI agent as **one** typed line, whose alphabet
  the sentence guarantees — and must leave executing it to the user. An agent that read the prompt
  file and put its text somewhere itself would be the very divergence this seam exists to prevent,
  and on a shell line the injection the AI assistant's hard-coded tool list exists to prevent.
- **Availability is cheap and honest.** It is asked on every click; cache what is expensive, but
  never answer `ok` for an entry point you have not seen listed.
- **A stub is a real member.** `comingSoonAgent(id)` answers `not-implemented` from both methods,
  so a settings value committed ahead of its implementation is a sentence, never a crash.

## Adding an agent

1. Add its id to `IMPLEMENT_AGENT_IDS` in `src/settings/implementSettings.ts` and its row to
   `CODING_AGENTS` in `src/settings/codingAgents.ts` with `available: false`. Parsing accepts it
   from that moment and the form lists it, disabled.
2. Find its entry point: a command that takes text (Copilot Chat's `workbench.action.chat.open`
   with `{ query }`), a deep link (Cursor's `cursor://anysphere.cursor-deeplink/prompt?text=`), or
   an exported API. It must take the sentence **as text** (every route gets the same one — the
   prompt itself is on disk), fill without sending where it can, and be checkable before the
   click. For a **CLI**, the entry point is the terminal, and the shape is `ClaudeCodeCliAgent`'s:
   one typed line wrapping the sentence, Enter left to the user — only the executable's name and
   its probe differ.
3. Implement `CodingAgent` in `src/implement/<name>Agent.ts`, with a constructor taking the
   `CodingAgentContext` and its `vscode` calls as an injectable deps object defaulting to the real
   API.
4. Replace its `comingSoonAgent(id)` line in `configuredCodingAgent`
   (`src/implement/codingAgentRegistry.ts`) and flip `available` to `true` — every agent is
   constructed once, `implement.agent` read **at call time**.
5. Test it against fake deps — the availability ladder and the exact arguments of the handoff —
   never a real extension. The command suite drives `FakeCodingAgent` and must not change.
6. Add a row to the outcome table in [README.md](README.md) only if the agent can produce an
   outcome that table does not have. **The folder is the spec; the code keeps matching it, not the
   other way round.**
