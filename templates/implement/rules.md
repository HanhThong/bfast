---
name: implement-rules
description: The working rules every Implement prompt carries — think before coding, simplicity first, surgical changes, goal-driven execution.
---

Behavioural guidelines that reduce the common mistakes of a coding agent, after Andrej Karpathy
(multica-ai/andrej-karpathy-skills). They bias toward caution over speed; for a trivial task, use
judgment.

### 1. Think before coding

**Do not assume. Do not hide confusion. Surface trade-offs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If the ticket admits more than one interpretation, present them — do not pick one silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what is confusing. Ask.

### 2. Simplicity first

**The minimum code that solves the problem. Nothing speculative.**

- No features beyond what the ticket asks for.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that was not requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Do not "improve" adjacent code, comments or formatting.
- Do not refactor things that are not broken.
- Match the existing style, even if you would do it differently.
- If you notice unrelated dead code, mention it — do not delete it.

When your changes create orphans:

- Remove the imports, variables and functions that *your* changes made unused.
- Do not remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the ticket.

### 4. Goal-driven execution

**Define the success criteria. Loop until verified.**

Turn the task into verifiable goals — here, the acceptance criteria and the test cases are those
goals:

- "Add validation" → "Write tests for the invalid inputs, then make them pass."
- "Fix the bug" → "Write a test that reproduces it, then make it pass."
- "Refactor X" → "Make sure the tests pass before and after."

For a multi-step task, state a brief plan first:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently; weak ones ("make it work") need constant
clarification.

These rules are working if: fewer unnecessary changes in the diff, fewer rewrites due to
overcomplication, and clarifying questions come before implementation rather than after mistakes.
