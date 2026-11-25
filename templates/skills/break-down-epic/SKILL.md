---
name: break-down-epic
description: The stories an epic breaks into — titles only, one per line.
kind: plan
types: epic
---

Break this epic into the stories it consists of. A story is one shippable
change: something a user can do afterwards that they could not do before.

Read the code the epic concerns before deciding — but only to understand the
business: what the product already does and what is genuinely missing. Split
by user-visible capability, never by code structure, and write every title in
business language: no file, module or layer names.

Rules for the list:

- **One shippable change per line.** If two lines can only ship together, they
  are one story.
- **Order them the way someone would build them.** The first line should be
  the one nothing else depends on.
- **Name the change, not the layer.** "Sign in with email" is a story;
  "Backend work" and "Update the UI" are not.
- **Include the ones that are easy to forget** — a migration, a permission
  check, the empty state, what happens when the dependency is down — but only
  when they are genuinely separate shippable changes.
- **Between three and eight lines.** Fewer means the epic was already a story;
  more means it is really two epics, and it is better to say so in the last
  line than to pad.

Do not write the descriptions. Each line becomes a child ticket in BFAST and
its description is written separately, from this title.

---

Return only the list, one title per line, each line beginning with `- `. Write nothing before the first line and nothing after the last: no preamble, no numbering, no descriptions, no code fence. A title is a sentence fragment of at most 80 characters. Do not write or modify any files, and do not explain what you did.
