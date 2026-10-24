---
name: Security
description: Validate input, keep secrets out of code, avoid injection.
---

- Treat every input as hostile: request bodies, query strings, file names, headers, model output.
- Never build SQL, shell commands or HTML by joining strings with input. Use parameters, argument arrays and escaping.
- No secrets in code or logs. Read them from the environment, and never send them to the browser.
- Resolve file paths and check they stay inside the allowed folder before reading or writing.
- Check permission on the server for every request; the client cannot be trusted to hide a button.
- Hash passwords with a slow algorithm (scrypt, bcrypt, argon2); never store or log them.
- Fail closed: on an error, deny rather than allow.
- Do not invent your own crypto; use the platform library.
