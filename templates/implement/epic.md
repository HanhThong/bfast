---
name: implement-epic
description: Plan an epic from its stories, criteria and designs, then implement it story by story.
types: epic
---

Implement epic {{id}} — {{title}} ({{status}}).

It lives in `{{folder}}` (description file `{{file}}`), inside the BFAST tracker `{{tracker}}`.
Every subfolder there is a ticket: a story, and under it acceptance criteria and test cases. The
tickets are the specification; the code you write is the deliverable.

## The epic

{{description}}

## Stories and their acceptance criteria

{{children}}

## Design documents

{{designs}}

## How to work

1. Read every file listed above, in order — the stories, their criteria, the test cases inside each
   criterion's folder, and the design documents — then the parts of the codebase they touch. Do not
   start writing code until you have the whole picture.
2. Write a short plan: which story first, what each one changes, what is shared between them, and
   where the design documents constrain the shape.
3. Implement one story at a time. A story is done when every one of its acceptance criteria holds
   and its test cases pass. Tests run with: `{{testCommand}}`
4. Do not edit anything under `{{tracker}}`: the tickets are the spec, not the deliverable. If a
   ticket is wrong or ambiguous, say so and ask before working around it.
5. Finish with a summary per story: what changed, which criteria hold, which test cases pass, and
   what you left open.

## Working rules

{{rules}}
