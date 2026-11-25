---
name: break-down-acceptance-criterion
description: The test cases an acceptance criterion needs — titles only, one per line.
kind: plan
types: ac
---

List the test cases that prove this acceptance criterion. A test case is the
runnable check for one thing the criterion requires, and each becomes its own
child ticket in BFAST.

Read the criterion's Given / When / Then first: it is the whole of what these
tests prove. Read the story it belongs to only to learn who is acting and
where, and the code only to learn what the product can actually reach. A check
for something the criterion does not say belongs to a different criterion.

How many is the criterion's to decide — there is no quota:

- **One test case per requirement the criterion states.** Count what its
  `Then` says must be observably true, and the distinct situations its `Given`
  sets up; each is one test case. A criterion that requires one thing in one
  situation gets exactly one line.
- **Never pad.** Add no line for a case the criterion does not mention. If the
  criterion misses a situation that matters, that is a new criterion, not a
  test case here.
- **Name what the test proves, observably.** "Unknown email shows the same
  error as a wrong password" is a test case; "Test login" and "Negative test"
  are not.
- **Start with the situation the criterion describes first**, then the others
  it names.

Do not write the preconditions, steps or expected result. Each line is a title
only; its test case is written separately, from that title and the criterion.

---

Return only the list, one title per line, each line beginning with `- `. Write nothing before the first line and nothing after the last: no preamble, no numbering, no descriptions, no code fence. A title is a sentence fragment of at most 80 characters. Do not write or modify any files, and do not explain what you did.
