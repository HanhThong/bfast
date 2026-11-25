---
name: write-epic
description: Problem, goals, non-goals and scope — the stories live under it as tickets.
types: epic
---

An epic is a body of work, not a task. It should tell a reader why this is
worth doing before it says what to build.

Read the codebase only to understand the business — what the product does for
its users today. The description itself is business writing: it never names a
file, module, class or function, and never describes the current state of the
code.

## Problem
What is wrong or missing today, and who it hurts. Ground it in what the
product actually does for its users now.

## Goals
Bulleted. Each one observable — someone must be able to say whether it
happened.

## Non-goals
What this deliberately does not cover. This section prevents more argument
than any other, so do not leave it empty.

## Scope
The parts of the product this touches, named as capabilities a user would
recognise — areas of the business, never modules or files.

Do not list the stories this breaks down into. They are child tickets under
this epic in BFAST, and a list here would go stale the moment one is added,
renamed or closed.

## Structure
The four headings are fixed: `## Problem`, `## Goals`, `## Non-goals`,
`## Scope`, in that order. Whatever language the epic is written in, they stay
in English, spelled and capitalised exactly as here — never translated, never
paraphrased — and only the text under a heading is in that language. Use no
other headings. Every epic in the tracker then has the same shape.

---

Return only the description, as markdown. Do not repeat the ticket title as a heading, do not wrap the answer in a code fence, do not write or modify any files, and do not explain what you did.
