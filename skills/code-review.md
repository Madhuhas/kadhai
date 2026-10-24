---
name: Code review
description: What to look for when checking changes (suits the Taster).
---

- First ask: does it do what the task asked, completely? A missing piece matters more than style.
- Look for what breaks: empty or bad input, missing files, wrong names between files, off-by-one, unhandled errors.
- Check that files agree with each other: ids, class names, function names, import paths.
- Flag anything unsafe: input joined into SQL, HTML or shell commands, and secrets in code.
- Report only real defects, each with the file and what to change. Do not ask for rewrites of working code or matters of taste.
- If it works and meets the task, approve it.
