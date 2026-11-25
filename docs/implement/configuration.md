# Configuration — the `implement` block

Implement is configured in `.vscode/bfast.json`, next to the tracker, AI, environments, tests and
scan settings. The file is **committed to git**, so the whole team hands tickets to the same agent
— nothing here is per-machine, and nothing here is ever a credential (the agent signs in on its
own).

Edit it in the BFAST settings form (gear icon → **Implement** tab) or by hand. Reading is forgiving:
a hand-edited value that names no known agent is ignored and the default applies. Writing is strict:
the form refuses to save a value outside the list.

## Fields

Every field is optional; the whole block is omitted from the file when nothing in it is set, so a
workspace that never uses Implement keeps its `bfast.json` unchanged.

| Field | Type | Default | Rules |
|---|---|---|---|
| `agent` | string | `claude-code` | Which coding agent the prompt goes to. One of `claude-code` (the Claude Code VS Code extension: a new tab, the prompt in its input), `claude-code-cli` (the `claude` CLI: a terminal, the prompt in a file and one line typed, waiting for Enter — see [README.md](README.md#how-the-handoff-works)), `codex`, `codex-cli`, `opencode`, `opencode-cli`, `cursor`, `github-copilot`. The two Claude Code entries are implemented; the others are listed so the setting can be committed ahead of the implementation, and are disabled in the form; a hand-edited file naming one saves fine, and Implement then fails with **coming soon** — the same posture as `environments.provider: k8s`. |

## Prompt templates

There is no template text in `bfast.json`. What the agent is asked is a **file per ticket type** in
`.bfast/implement/`, beside `.bfast/agents/`:

```
.bfast/
  agents/                          the AI assistant's roles and skills
  implement/
    epic.md                        Implement… on an epic
    story.md                       … on a story
    acceptance-criterion.md        … on an acceptance criterion
    test-case.md                   … on a test case
    rules.md                       the working rules every template includes as {{rules}}
    prompts/                       the last rendered prompt per ticket, whichever agent
      ST-1.2.md                    what the handoff sentence names; overwritten per click
```

- **Seeded once.** The five files are copied from the extension's own `templates/implement/` the
  first time the folder is needed — an Implement click, or a visit to the settings form's Implement
  tab — and **only when the folder has never existed**. An empty folder means someone deleted them
  on purpose, and BFAST does not argue: the shipped file is used silently for a missing one.
  Delete the folder to have all five re-seeded; **Open** on the Implement tab restores the one file
  it opens.
- **`rules.md` is the part every template shares.** A template says what *this kind* of ticket asks
  for; the rules say how to approach *any* ticket — think before coding, simplicity first, surgical
  changes, goal-driven execution, after Andrej Karpathy's guidelines — and each shipped template
  ends with `## Working rules` and `{{rules}}`, which the file's body fills. Edit the rules once and
  every prompt follows; a template that wants none drops the token. Its frontmatter is the same
  grammar (`name`, `description`), and an empty file renders `(none)`.
- **A file, not a setting**, for the reason an agent's role is: a prompt is prose, and prose belongs
  in an editor with wrapping and a diff that reads, committed and shared. `bfast.json` keeps the
  mechanical choice — which agent — and nothing else.
- **The shape** is the `SKILL.md` one: flat frontmatter, then the template.

  ```md
  ---
  name: implement-story
  description: Implement a story so every acceptance criterion holds and every test case passes.
  types: story
  ---

  Implement story {{id}} — {{title}}.
  …
  ```

  `types` is optional: the ticket type is inferred from the file name (`acceptance-criterion.md`
  covers an `ac`, `test-case.md` a `testcase`), and an explicit `types` wins — the rule a skill
  follows. `name` and `description` are what the settings form shows; the description is the one
  sentence saying what the template asks for. Everything after the frontmatter is sent, with the
  [placeholders](README.md#placeholders) substituted. Frontmatter is read forgivingly: a file with
  none is all body.
- **Agent-neutral on purpose.** The shipped templates never name Claude Code; changing `agent` later
  must not mean rewriting four prompts. Say *what to do with the ticket*, and leave *how an agent
  works* to the agent's own instructions.
- **Read at click time**, never cached: save the file, click again.
- **`prompts/` is output, not input.** Every click writes the rendered prompt there, and what the
  agent receives — in a chat input or on a terminal line — is one sentence naming that file, so
  every route hands over the same thing and a shell line never carries prose. One file per ticket
  id (a duplicate's `#` written as `_`), overwritten on every click, never pruned, ignored by the
  settings form and by the seeding rule. Gitignore it or commit it — the team's call, as with the
  test results folder.

## Example

```jsonc
// .vscode/bfast.json
{
  "trackerFolder": ".tracker",
  "userName": "Hanh Thong",
  "implement": {
    "agent": "claude-code"      // the default; shown for the shape
  }
}
```

With this block, **Implement…** on story `ST-1.2` reads `.bfast/implement/story.md`, fills it with
`ST-1.2`'s title, status and description, its epic (`EP-1`, by path), its criteria and their test
cases (by path, two levels), the ERDs and sequence diagrams on the story and on the epic,
`tests.command` as configured and the working rules from `rules.md` — writes the result to
`.bfast/implement/prompts/ST-1.2.md`, and
opens a new Claude Code tab with `Your task is in .bfast/implement/prompts/ST-1.2.md. Read that
file first, then do what it says.` in the input, waiting for you to send it. With
`"agent": "claude-code-cli"` instead, the same file is written and a terminal named
`Claude Code — ST-1.2` opens in the workspace folder with that same sentence typed as
`claude "…"`, waiting for Enter.
