---
name: Planning
description: How to break work into small, independent steps (suits the Chef).
---

- Prefer the fewest steps that do the job; one step for a small task.
- Each step should touch its own files, so steps do not collide.
- Order steps so that what others depend on is built first.
- Write every detail two steps must agree on (file names, ids, function names, data shapes) into the instructions of both.
- Say exactly what each step must produce; do not leave it to guess.
- Do not add features, tests, docs or tooling the user did not ask for.
