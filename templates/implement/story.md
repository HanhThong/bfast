---
name: implement-story
description: Implement a story so that every acceptance criterion holds and every test case passes.
types: story
---

Implement story {{id}} — {{title}} ({{status}}).

It lives in `{{folder}}` (description file `{{file}}`), inside the BFAST tracker `{{tracker}}`,
under:

{{ancestors}}

## The story

{{description}}

## Acceptance criteria and test cases

{{children}}

Each acceptance criterion is one Given / When / Then; each test case is the runnable check for one
of them, or for the story as a whole.

## Design documents

{{designs}}

## How to work

1. Read every file listed above — the criteria, the test cases, the design documents, and the epic
   for context — then the parts of the codebase they touch.
2. Plan the change, then implement it so that every acceptance criterion holds. Add or update
   automated tests so that every test case above passes, and put each test case's id in its test's
   name so the team's test command finds it. Tests run with: `{{testCommand}}`
3. Do not edit anything under `{{tracker}}`: the tickets are the spec, not the deliverable. If a
   criterion is wrong or ambiguous, say so and ask before working around it.
4. Finish with a summary per acceptance criterion: what changed, and which test case proves it.

## Working rules

{{rules}}
