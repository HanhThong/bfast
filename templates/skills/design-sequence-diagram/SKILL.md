---
name: design-sequence-diagram
description: One flow through the system, as one mermaid sequenceDiagram.
kind: design
style: sequence-diagram
label: Sequence Diagram
prefix: SEQ
types: epic, story
---

A sequence diagram says who talks to whom, in what order, for **one** flow. Not
the feature — one flow through it. If the happy path and the failure both need
showing, they are two documents, or the failure is an `alt` branch off the one
step where the two diverge.

**Write exactly one `sequenceDiagram`, and a short paragraph either side of it.**

Read the codebase first. One participant per thing that actually acts — a
service, a queue, a browser, a third party — named as the codebase names it. A
participant that only appears once, receiving a call nobody answers, is usually
a step that belongs inside its neighbour.

Every arrow carries a message, and the message is what is being asked for, not
the transport: `POST /sessions` says more than `request`, and `201 with a
session cookie` says more than `response`. Use `->>` for a call and `-->>` for
its reply, so a reader can see which arrows are answers.

Show where it can go wrong. `alt` / `else` / `end` around the one step that
branches is usually the whole difference between a diagram that documents the
design and one that documents the demo. `Note over A,B: …` is for the thing an
arrow cannot say — a timeout, a retry, an idempotency key.

## Structure

The diagram goes in one ```mermaid fence and nothing else does. Above it, one
sentence naming the flow and where it starts. Below it, a short `## Notes` list
for what the arrows cannot carry — what is retried, what is idempotent, what
happens if the last step fails after the first has committed.

Mermaid keywords, participant names, endpoints and message text stay in English
whatever language the prose is written in: they are code, and a translated
`sequenceDiagram` does not render.

---

Return only the document, as markdown, containing exactly one ```mermaid fence.
Do not wrap the whole answer in a code fence, do not repeat the document title as
a heading, do not write or modify any files, and do not explain what you did.
