---
name: implement-test-case
description: Write the automated test for one test case, named after its id, so the team's test command finds it and it passes.
types: testcase
---

Write the automated test for test case {{id}} — {{title}} ({{status}}).

It lives in `{{folder}}` (description file `{{file}}`), inside the BFAST tracker `{{tracker}}`,
under:

{{ancestors}}

## The test case

{{description}}

## Design documents

{{designs}}

## How to work

1. Read the ticket above it — an acceptance criterion the test proves, or a story or epic whose
   functions the test walks through end to end — and the design documents, then find how this
   codebase already writes tests of this kind and follow that.
2. Write one automated test that walks the Preconditions, Steps and Expected result above, using
   the Test data. Put the id `{{id}}` in the test's name, so that the team's test command selects
   it: `{{testCommand}}`
3. Run it. If it fails because the behaviour is not implemented yet, say so — do not weaken the
   test to make it pass. If it fails because the test case itself is wrong, say that instead.
4. Do not edit anything under `{{tracker}}`: the tickets are the spec, not the deliverable.
5. Finish with the test's location, the command that runs it, and its result.

## Working rules

{{rules}}
