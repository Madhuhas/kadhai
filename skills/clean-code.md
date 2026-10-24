---
name: Clean code
description: Small functions, clear names, no dead code or speculative extras.
---

- Name things for what they mean, not how they are built. No abbreviations a newcomer would have to guess.
- One job per function. If it needs "and" to describe, split it.
- Prefer early returns to nested ifs. Keep the happy path at the left margin.
- Delete dead code and unused parameters instead of commenting them out.
- Do not add options, layers or abstractions the task did not ask for.
- Comment the why (a constraint, a trap), never the what.
- Match the style of the file you are in: its naming, quotes, indentation and idiom.
