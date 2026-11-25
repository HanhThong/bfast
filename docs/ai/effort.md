# Choosing the effort

A model can be asked *how hard to think* before it answers. Claude Code calls that the **effort
level**, and it is the second dial on a run after the model itself: the same Opus writing the same
story costs and takes very different amounts at `low` and at `max`.

BFAST exposes it exactly the way it exposes the model, because it is the same kind of decision —
a team default someone can override for one tab's runs — and a second grammar for the same shape
would be a trap.

| Where | What it sets | Lives in |
| --- | --- | --- |
| **Settings → AI assistant → Effort** | The workspace default | `.vscode/bfast.json` `ai.effort`, committed |
| The **effort picker** on a board's AI panel (description tab and every design tab) | This tab's runs | the tab's own webview state — survives a window reload, never written to disk |
| The **effort picker** on a generate tab | This tab's runs: the plan, every refine and every write | the tab's own webview state, the same way |

Precedence, highest first: **the tab's pick → `ai.effort` → Claude Code's own default for the
model**. A picker showing *Default* sends nothing, so the setting applies; an empty setting sends
nothing either, so Claude Code decides. There is deliberately no `default` entry in the list, for
the reason there is none in the model list: "absent" already means it.

## The five levels

`low`, `medium`, `high`, `xhigh`, `max` — the set both routes take, and the only set either takes:

- `--effort <level>` on the `claude` CLI, one argv element beside `--model`.
- `effort` on the Agent SDK's `query()` options, beside `model`.

Because the value is an argv element, it is never passed through on trust: `isEffortLevel` is a
**membership** test over those five strings — unlike `isModelId`, which is a format rule, because
model names are Claude Code's to invent and grow while this list is the protocol's and does not.
A value that fails it is ignored, never refused, so a hand-edited `bfast.json` still loads.

## Not every model takes every level

This is the part that differs per model, and the reason the picker is not simply five fixed
entries. `ModelOption.effort` in [`src/settings/models.ts`](../../src/settings/models.ts) carries
the levels each bundled model accepts:

| Model | Levels offered |
| --- | --- |
| Opus 5, Sonnet 5, Fable 5 / 5.1, Opus 4.8, and the aliases resolving to them | `low` `medium` `high` `xhigh` `max` |
| Sonnet 4.6 | `low` `medium` `high` `max` — `xhigh` arrived with Sonnet 5 |
| Haiku 4.5 | none — it takes no effort level at all |
| A model the list does not know (**Custom…**, a Bedrock or Foundry name) | all five |

Three rules follow from that table, and each is deliberate:

1. **The picker narrows the offer, it does not police the value.** A level a model does not have
   is *silently downgraded* by Claude Code — never an error — so the table's job is to stop the
   picker claiming something that will not happen, not to guard the request. An unknown model is
   offered everything, the `isModelId` posture: a model that shipped after the extension did must
   not lose a dial because the bundled list has not caught up.
2. **A model that takes no effort at all drops the value.** `aiEffort(ai, pick, model)` — the one
   address for the precedence above — answers `undefined` when the resolved model's list is
   empty, so picking Haiku does not send an `--effort` its runs cannot use. The picker says so
   rather than going blank: *Haiku 4.5 does not take an effort level*.
3. **The stored value survives a model change.** Switching a tab to Haiku and back leaves the
   effort pick where it was; only what is *sent* changes. A setting silently rewritten by an
   unrelated dropdown is worse than one that is briefly inapplicable.

## On the wire

The webview sends a **level**, the host resolves — the rule `model` (a name) and `agent` (a slug)
already follow.

- `aiGenerate.effort?` and `generateStart.effort?` carry the tab's pick; absent means the setting.
  The host runs it through `aiEffort(settings, pick, model)`, having resolved the model first, and
  a pick that is not one of the five is ignored.
- `aiAvailability.effort?` and `generateContext.effort?` carry the workspace setting, so a picker
  can label its first entry *Default — High* rather than a bare *Default*.
- `AiRequest.effort?` is what reaches a provider. Absent means the flag and the option are not
  set at all, so a workspace that never touches this produces byte-identical argv to before.

Nothing new comes back. The stream's `init` message names the model and, on builds that report it,
the effort — read forgivingly into `AiResultMeta.effort` and joined into the provenance line the
same way the model is, so `history.md` says what a ticket cost to write. A build that does not
report it writes the line it always wrote.

## `bfast.json`

```json
{
  "trackerFolder": ".tracker",
  "userName": "Alex",
  "ai": { "model": "opus", "effort": "high" }
}
```

`ai.effort` is omitted when absent, the `ai` block is omitted when it is empty, and a workspace
that never opens this dropdown keeps its file byte-identical — the rule every optional setting in
BFAST follows.

## The other knobs

Effort is the first of a family, and the others are listed in the form as **coming soon**
(disabled rows carrying the label and a sentence), the way `implement.agent` lists the coding
agents that are not written yet. A value that is only a plan is better read as a plan than as a
gap.

| Knob | State |
| --- | --- |
| **Effort** | implemented, this document |
| **Thinking budget** — a fixed token budget instead of adaptive thinking | coming soon |
| **Fast mode** — the same model, faster output, where the account allows it | coming soon |

[`src/settings/modelKnobs.ts`](../../src/settings/modelKnobs.ts) is that list, pure and shared by
the form and a test, so a knob cannot be offered in the UI without appearing here — the
`codingAgents.ts` idiom.
