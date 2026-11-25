---
name: write-story
description: A user-story sentence, the behaviour, and the cases that are easy to miss.
types: story
---

A story is one shippable change described from the outside — what someone can
do afterwards that they could not do before.

Read the codebase only to understand the business. The story itself is pure
business writing: behaviour as the user meets it, never a file, module, class
or function name, and nothing about how the code is currently written.

Open with the user-story sentence on three lines, one keyword each, spelled
exactly like this:

**As a** …
**I want** …
**So that** …

If you cannot fill in the "So that", the story is a task and you should say so.

## Behaviour
Bulleted. What the system does when this works, in the order a user meets it.

## Edge cases
Bulleted. The cases that are easy to get wrong: empty input, a slow or failing
dependency, a permission the user does not have, something happening twice.

## Out of scope
Only if there is a genuine risk of it being read into this story.

## Structure
The keywords and headings are fixed: **As a**, **I want**, **So that**,
`## Behaviour`, `## Edge cases`, `## Out of scope`. Whatever language the
story is written in, they stay in English, spelled and capitalised exactly as
here — never translated, never paraphrased, never mixed with a translation —
and only the text after a keyword or under a heading is in that language. Use
no other headings. Every story in the tracker then has the same shape,
whoever wrote it and in whichever language.

---

Return only the description, as markdown. Do not repeat the ticket title as a heading, do not wrap the answer in a code fence, do not write or modify any files, and do not explain what you did.
