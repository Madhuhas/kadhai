---
name: Error handling
description: Fail clearly: useful messages, no silent catches, clean-up always runs.
---

- Never swallow an error silently. Handle it, or let it rise to code that can.
- Messages say what failed and what to do next, in plain words, without leaking secrets or stack traces to the user.
- Check input at the boundary and stop early; do not carry bad data deeper.
- Release what you took (files, locks, timers, connections) in a finally block.
- Catch the specific error you expect, not everything.
- Give network and file work a timeout, and bound every retry.
- A failed operation must not leave half-written state: write to a temp file and rename, or use a transaction.
- Log once, where the error is handled, with enough context to find it.
