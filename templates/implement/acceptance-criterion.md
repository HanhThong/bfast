---
name: implement-acceptance-criterion
description: Implement one acceptance criterion — its Given / When / Then — and make its test cases pass.
types: ac
---

Implement acceptance criterion {{id}} — {{title}} ({{status}}).

It lives in `{{folder}}` (description file `{{file}}`), inside the BFAST tracker `{{tracker}}`,
under:

{{ancestors}}

## The criterion

{{description}}

## Test cases

{{children}}

## Design documents

{{designs}}

## How to work

1. Read the story and the epic above for context, the criterion's test cases, and the design
   documents, then the parts of the codebase they touch.
2. Implement the smallest change that makes the Given / When / Then hold without breaking the
   story's other criteria. Add or update automated tests so that every test case above passes, each
   named with its test case's id so the team's test command finds it. Tests run with:
   `{{testCommand}}`
3. Do not edit anything under `{{tracker}}`: the tickets are the spec, not the deliverable. If the
   criterion is wrong or ambiguous, say so and ask before working around it.
4. Finish with a summary: what changed, and which test case proves the criterion holds.

## Working rules

{{rules}}
