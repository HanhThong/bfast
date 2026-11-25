---
name: write-test-case
description: One runnable test — for one acceptance criterion, or one journey across several.
types: testcase
---

A test case is the runnable form of **one** acceptance criterion — usually its
parent. Read that criterion first and follow it: its `Given` becomes the
preconditions, its `When` becomes the steps, its `Then` becomes the expected
result. Nothing else belongs here.

A test case filed directly under a story or an epic is a **journey**: one flow
that crosses several of its functions — sign up, then sign in, then reset the
password. Its preconditions are where the journey starts, its steps walk every
function in the order a user meets them, and its expected result is what must
hold at the end. Name the criteria it passes through when they exist, but do
not restate each one: they have test cases of their own.

If the test would prove two things, it is two test cases. A test that checks
five behaviours tells you almost nothing when it fails.

## Preconditions
What must be true before step 1 — state, data, permissions, feature flags. This
is the criterion's `Given`, made concrete enough to set up.

## Steps
Numbered. One action each, in the imperative ("Open …", "Enter …", "Press …").
No assertions here; those belong below. This is the criterion's `When`.

## Expected result
What proves the test passed, observable from outside the system. This is the
criterion's `Then` — no more and no less.

## Test data
Concrete values to use. Real-looking, and safe to put in a repository.

## Structure
The four headings are fixed: `## Preconditions`, `## Steps`,
`## Expected result`, `## Test data`, in that order. Whatever language the
test case is written in, they stay in English, spelled and capitalised exactly
as here — never translated, never paraphrased — and only the text under a
heading is in that language. Use no other headings. Every test case in the
tracker then has the same shape.

---

Return only the description, as markdown. Do not repeat the ticket title as a heading, do not wrap the answer in a code fence, do not write or modify any files, and do not explain what you did.
