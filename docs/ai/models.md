# Choosing the model

The AI assistant runs on whichever Claude model the user picks. There are three places to pick
one, and they layer:

| Where | What it sets | Lives in |
| --- | --- | --- |
| **Settings → AI assistant → Model** | The workspace default | `.vscode/bfast.json` `ai.model`, committed |
| The **model picker** on a board's AI panel (description tab and every design tab) | This tab's runs | the tab's own webview state — survives a window reload, never written to disk |
| The **model picker** on a generate tab | This tab's runs: the plan, every refine and every write | the tab's own webview state, the same way |

Precedence, highest first: **the tab's pick → `ai.model` → `ANTHROPIC_MODEL` in the environment →
Claude Code's own default**. A picker showing *Default* sends nothing, so the setting applies; an
empty setting sends nothing either, so the CLI decides. That is why there is deliberately no
`default` entry in the list: "absent" already means it, and two spellings of one thing is a trap.

## What the list offers

Neither the `claude` CLI nor the Agent SDK can list models, so the list is bundled in
[`src/settings/models.ts`](../../src/settings/models.ts) and shared by every picker and the host.
It has two groups, in this order:

1. **Aliases** — `best`, `opus`, `sonnet`, `haiku`, `fable`, `opusplan`, `opus[1m]`, `sonnet[1m]`.
   An alias is resolved by Claude Code, which re-points it at each new release; picking `opus`
   means "the current Opus" and keeps meaning that after the extension is a year old.
2. **Pinned ids** — `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`,
   `claude-fable-5-1`, `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-4-6`. A pinned id stays put, for a team
   that wants the provenance line in `history.md` to name exactly what wrote a ticket.

**Custom…** at the end takes any id the list does not know — a model that shipped after the
extension did, a Bedrock (`us.anthropic.…`) or Foundry deployment name. A value already in
`bfast.json` that the list does not know is shown as its own entry rather than dropped, so a
hand-edited file always reads back as written.

## The format rule

A model name becomes one element of the CLI's argv (`--model <name>`) or the SDK's `model`
option, so the one rule every picker, the settings validator and the host share is `isModelId`:
**one token of printable ASCII, no whitespace, at most 100 characters**. The rule is that loose
on purpose — `opus[1m]` and `us.anthropic.claude-opus-5` are both real — and it is *not* a
membership test: an unknown but well-formed id is accepted everywhere. Whether a name exists is
Claude Code's to decide, and it decides at the **first request**, not at save or at spawn, so a
mistyped id surfaces as the run's failure message.

Reading is forgiving, as with every other setting: `parseAiSettings` keeps any non-blank string
it finds in `bfast.json`, and only `validateAiSettings` — the way out — refuses one that breaks
the rule.

## On the wire

The webview sends a **name**, the host resolves — the rule `agent` (a slug) already follows.

- `aiGenerate.model?` and `generateStart.model?` carry the tab's pick; absent means the setting.
  The host runs it through `aiModel(settings, pick)` in `aiSettings.ts`, the single address for
  the precedence above: a pick that fails `isModelId` is ignored, never passed through.
- `aiAvailability.model?` and `generateContext.model?` carry the workspace setting, so a picker
  can label its first entry *Default — claude-opus-5* rather than a bare *Default*.
- Nothing new comes back for what actually ran: the provider already reports it on
  `AiResultMeta.model`, the provenance line already records it, and the board's activity log
  gains a `Started — <model>` line, the one the generate tab's lanes already show.

A resumed conversation (a design tab's *Continue the previous conversation*, a generate tab's
refine) honours a changed model: Claude Code applies `--model` to a `--resume` as well, so a
conversation is never silently continued on a model the user did not pick.
