# Reviewing what the assistant wrote

A ticket that already has a description is the normal case, and until now a run simply replaced
it: the answer landed in the editor's draft and whatever was there before was gone from the
screen. The only way to compare was to press Cancel, read the old text, and run again.

So a run against **text that already exists** now stops at a **review**: the answer is held
beside the text on disk, shown as a diff, and reaches the editor only when the user approves it.

| The text it is replacing | What a finished run does |
| --- | --- |
| Empty (or whitespace only) | Straight into the editor's draft, exactly as before — there is nothing to compare |
| Anything else | The **review** below; nothing reaches the draft until **Approve** |

It applies to both things the board's one AI button writes: a ticket's **description** and a
**design document**. They are the same machinery with a different draft, and they get the same
review.

## The three ways out

```
              ┌──────────────────────────────────────────┐
  Generate ──►│  Review: diff of on-disk text vs answer   │
      ▲       └──────┬──────────────┬──────────────┬──────┘
      │           Approve        Rewrite        Discard
      │              │              │              │
      │              ▼              │              ▼
      │     editor (draft = answer) │      back to the text on
      │              │              │      disk, nothing written
      │           [ Save ] ─► disk  │
      └─────────────────────────────┘
```

- **Approve** puts the answer in the editor's draft and opens it — where every previous run's
  answer landed. Nothing is written yet: the user's own **Save** does that, with an `updatedAt`
  read at that moment. That is unchanged and deliberate (see `CLAUDE.md`, *The result lands in
  the draft, never on disk*): approving is a judgement about the text, not a write, and the last
  edit before saving is still the user's.
- **Discard** drops the answer and leaves the ticket exactly as it was. Nothing was written at
  any point, so there is nothing to undo.
- **Rewrite** reopens the assistant with an empty instruction box, the answer still on screen to
  say what was wrong with it. The run that follows is an **ordinary run**, and that is the whole
  point of the next section.

## A rewrite is compared with the original

**The base of the diff is the text on disk when the review opened, and a rewrite never moves
it.** The second answer is compared with the same original the first was, not with the first
answer.

Two halves make that true, and both are load-bearing:

- **The prompt.** The host reads the ticket (or the design document) from disk at the start of
  every run, and a proposal is never written to disk, so the second run is handed the same
  original the first was. There is nothing to reset: the rule holds *because* the answer stays
  out of the draft until Approve, which is the reason the review keeps it there rather than
  parking it in the editor and diffing from that.
- **The diff.** `openReview` keeps the `base` of the review already open and only replaces its
  `proposal` ([`src/shared/aiReview.ts`](../../src/shared/aiReview.ts)). Had it re-read the base
  each time it would still be right today — nothing writes — but it would be one edit away from
  being wrong, and the invariant is what the test holds.

A design run may additionally **continue its previous conversation** (the Continue checkbox),
so the model remembers what it last answered. That is a fact about the *prompt*, not about the
diff: the document in the prompt and the base of the diff are both the file on disk either way.

## What is compared, and how it is shown

[`src/shared/textDiff.ts`](../../src/shared/textDiff.ts) is a hand-rolled line diff — no
dependency, for the reason `yaml.ts` and `zipFile.ts` are hand-rolled: the host ships one
optional dependency and the webview bundles React, `marked` and `mermaid` and nothing else.

- **Lines**, with the common prefix and suffix trimmed first and an LCS over what is left. Past
  `MAX_CELLS` the two texts are reported as one whole replacement rather than diffed — a
  guard, not a feature: a diff nobody can read is not worth an unbounded table.
- **Words inside a line**, when a removed line and the added line facing it are similar enough
  to be the same sentence rewritten (`SIMILARITY_FLOOR`). Otherwise the pair reads as two
  unrelated lines, and highlighting every word of both is noise.
- **Unified, one column** — `-` then `+`, the shape every reviewer already knows, and the one
  that survives a board opened on half a screen. Runs of unchanged lines collapse to a
  `⋯ N unchanged lines` row with `CONTEXT_LINES` either side.
- A **New text** toggle beside the diff renders the answer as it will read once saved, because a
  diff of markdown is not what the ticket will look like.

Two answers the diff has to give honestly, and does:

- The answer is **identical** to what is on disk — the assistant decided nothing needed changing.
  The review says so instead of showing an empty diff, and Approve still works (it opens the
  editor on identical text and saves nothing new).
- The text **changed on disk** while the review was open — a `git pull`, another window, the
  assistant's own edit of another ticket. The base is not moved: the answer really was written
  against what the diff shows. The review says the file has moved on, and an Approve carries
  that through to the editor's existing *changed on disk* warning, so Save does the
  `updatedAt` check with its eyes open.

## What it is not

- **Not persisted.** A window reload drops a pending review, the way a reloaded generate tab
  comes back to its form and never to a run: the answer belonged to a child process this
  session owned, and offering it after a reload would be offering something that can no longer
  be explained.
- **Not a host-side state.** Nothing new crosses the bridge — no protocol message was added and
  the host is unchanged. The answer already arrives on `aiResult`; where it waits is the
  webview's business.
- **Not a merge.** The user approves the answer or does not. Editing half of it is what the
  editor is for, one press later.
