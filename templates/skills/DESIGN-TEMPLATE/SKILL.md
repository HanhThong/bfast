---
name: design-{{style}}
description: One {{label}}, as one mermaid diagram.
kind: design
style: {{style}}
label: {{label}}
prefix: {{prefix}}
types: epic, story
---

A {{label}} says one thing about the design of this ticket. Say here what that
one thing is, and what it is not — the boundary is what keeps two documents on
the same ticket from repeating each other.

**Write exactly one mermaid diagram, and a short paragraph either side of it.**

Read the codebase first. Names in the diagram are the names the code uses, not
better ones: a diagram that renames something a reader will then go looking for
is worse than no diagram.

Say what every element and every arrow must carry — a label, a type, a
direction — and what a reader should be able to answer from the picture alone.
Say what does *not* belong, so the diagram stays one page.

## Structure

The diagram goes in one ```mermaid fence and nothing else does. Above it, one or
two sentences saying what it shows. Below it, a short `## Notes` list for what
the diagram cannot carry.

Mermaid keywords and the names inside the diagram stay in English whatever
language the prose is written in: they are code, and a translated diagram does
not render.

---

Return only the document, as markdown, containing exactly one ```mermaid fence.
Do not wrap the whole answer in a code fence, do not repeat the document title as
a heading, do not write or modify any files, and do not explain what you did.
