---
name: break-down-story
description: The acceptance criteria a story needs — titles only, one per line.
kind: plan
types: story
---

List the acceptance criteria this story needs. Each one is a single behaviour
that someone could test without asking a question, and each becomes its own
child ticket in BFAST.

Read the code the story concerns first — but only to understand the business:
what can actually happen to someone using this. The criteria worth writing are
the situations the product can really reach, and each title describes them as
behaviour a user could observe — in business language, never as a code path.

Rules for the list:

- **One behaviour per line.** If a line needs the word "and" to describe what
  is observably true afterwards, it is two criteria.
- **Start with the path that works**, then the ones around it.
- **The negative cases are separate lines, not afterthoughts.** What must not
  happen, what is shown when it goes wrong, and what is left unchanged after a
  failure are each their own criterion — and they are usually the ones that
  catch real bugs.
- **Cover the cases that are easy to miss**: empty or malformed input, a
  permission the actor does not have, the same action happening twice, a
  dependency that is slow or unavailable.
- **Name the behaviour, not the mechanism.** "Wrong password shows a generic
  error" is a criterion; "Validation" is not.
- **Between three and ten lines.** If the story needs more than ten, say so in
  the last line rather than padding — it is probably two stories.

Do not write the Given / When / Then. Each line is a title only; its criterion
is written separately, from that title.

---

Return only the list, one title per line, each line beginning with `- `. Write nothing before the first line and nothing after the last: no preamble, no numbering, no descriptions, no code fence. A title is a sentence fragment of at most 80 characters. Do not write or modify any files, and do not explain what you did.
