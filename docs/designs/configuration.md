# Configuration — styles are design skills

There is no `design` block in `.vscode/bfast.json`. A design style is a **design skill** —
the same kind of file the AI assistant's roles and skills already are — and everything
about it lives in `.bfast/agents/`, committed to git like the rest:

```
.bfast/agents/solution-architect/design-c4-context/
  SKILL.md               how this role draws one; its frontmatter names the style
  resources/
    expected-output.md   the example the assistant is shown, placeholders and all
```

Edit them in the BFAST settings form (gear icon → **Design** tab), which lists every style
and, under each, the roles that can draw it with buttons for both files — or by hand.
Reading is forgiving: a skill that states no prefix, or a prefix another style already
uses, is skipped and the form says which. Writing is strict: the form refuses a style
whose id or prefix breaks a rule below.

## Three styles are built in

They are always offered, whatever skills a workspace holds:

| Style | `style` | Prefix | Skill |
|---|---|---|---|
| Entity-Relationship Diagram | `entity-relationship-diagram` | `ERD` | `design-entity-relationship-diagram` |
| Sequence Diagram | `sequence-diagram` | `SEQ` | `design-sequence-diagram` |
| Low Level Design | `low-level-design` | `LLD` | `design-low-level-design` |

The first two are **one picture each** — one `erDiagram`, one `sequenceDiagram` — and their
skills say so. **Low Level Design** is deliberately **free-form**: its skill prescribes no
sections and no number of diagrams, so the document is whatever the ticket needs — prose,
tables, signatures, a `classDiagram`, a `flowchart`, several of them or none. A style you
add decides this for itself the same way, by what its skill asks for.

What holds for every style is only what makes a document render: each diagram in its own
```mermaid fence, and no fence wrapped around the whole answer.

Every role draws them: with its own copy of the skill when it holds one, and with the
skill BFAST ships otherwise. Giving a role its own copy (**Add to a role…** on the style's
card) is how you change *how that role draws it* — the shipped skill is voice-neutral.

## The frontmatter that declares a style

```yaml
---
name: design-c4-context
description: One C4 context diagram, as one mermaid C4Context.
kind: design
style: c4-context
label: C4 Context
prefix: C4
types: epic, story
---
```

| Key | Rules |
|---|---|
| `name` | The folder's name, and it must be `design-<style>`. The folder wins when they disagree, as it does for every skill. |
| `kind` | `design`. Inferred from a `design-` folder name when the frontmatter is missing. |
| `style` | `^[a-z][a-z0-9-]*$`. What each document records in its own frontmatter, and the tail of the folder name. Inferred from the folder when absent. |
| `label` | What the board's **+** menu shows. Defaults to the style in title case (`C4 Context`). |
| `prefix` | `^[A-Z][A-Z0-9]{0,7}$`. Starts the file name of every document in the style, so it must be unique — and may **not** be `EP`, `ST`, `AC` or `TC`, the ticket prefixes a folder name is parsed by. A skill with no prefix cannot be offered; the form says so. |
| `types` | Which tickets the style may hang under. Defaults to `epic, story`, and those are the only two a design tab exists for. |

When two roles declare the same style, the first by role name decides the label and
prefix; the other is the same style, offered once. When two roles declare *different*
styles with the same prefix, the second is skipped and named in the form.

## Adding a style

Settings → **Design** → **New style…**. It asks three things — which role draws it, what
it is called, and the prefix its files take — derives the id from the name for you to
confirm, and scaffolds the folder above from BFAST's `DESIGN-TEMPLATE` with those three
facts substituted. The skill opens in an editor: what it says about the diagram is the
part only you can write, and the expected output beside it is what the assistant will
be shown as the shape to produce.

The moment the folder exists, every epic and story board offers the style on **+**, and the
role you picked is offered on the AI assistant for it. Other roles are not — a style you
invented has no shipped skill to fall back on — until you **Add to a role…** them a copy.

## A new tab starts empty

Creating a document writes an empty file and opens the tab with the **AI assistant**
already open, asking what the diagram should show. There is deliberately no stock
diagram dropped in first: it would be one more thing to delete before either asking the
assistant or pressing **Edit** to write it by hand. What the assistant produces lands in
the editor for review; nothing is written until you save.

## Removing a style

Delete the folder from every role that holds it. Documents already written in it **keep
working** — they list, open, edit and save, under a style reconstructed from the file-name
prefix — but the style leaves the **+** menu and the assistant cannot write one. A
built-in style cannot be removed this way: with no role holding it, the shipped skill
still draws it.
