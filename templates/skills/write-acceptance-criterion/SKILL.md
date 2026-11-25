---
name: write-acceptance-criterion
description: One Given / When / Then. A negative case is its own criterion.
types: ac
---

An acceptance criterion is one test someone could run without asking you a
question. It is not a summary of the story.

**Write exactly one Given / When / Then, and nothing else.**

**Given** the state the system is in — concrete, not "the user is set up".
**When** the single action taken.
**Then** what is observably true afterwards.

All three speak the user's language. Read the codebase only to understand what
can actually happen; the criterion itself names no files, modules, classes or
functions, and describes no internal mechanism — only what someone using the
product would set up, do and observe.

The three keywords are fixed: **Given**, **When**, **Then**, each bold and
starting its own line. Whatever language the criterion is written in, they
stay in English, spelled and capitalised exactly as here — never translated,
never paraphrased — and only the text after a keyword is in that language.
Every criterion in the tracker then has the same shape.

One criterion is one behaviour. If a `Then` has an "and" that is really a
second behaviour, it belongs to a different criterion. If a `When` has an "and",
either it is two actions and one of them belongs in the `Given`, or it is two
criteria.

Do not add the negative cases here. What must **not** happen, what the user sees
when it goes wrong, and what is left unchanged after a failure are each their own
acceptance criterion — sibling tickets under the same story in BFAST, not extra
scenarios in this one. They are usually the criteria that catch real bugs, so say
in one line at the end which ones are still missing, if any are.

---

Return only the description, as markdown. Do not repeat the ticket title as a heading, do not wrap the answer in a code fence, do not write or modify any files, and do not explain what you did.
