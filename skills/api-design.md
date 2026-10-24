---
name: API design
description: Consistent, predictable HTTP and JSON interfaces.
---

- Nouns for resources, HTTP verbs for actions: GET reads, POST creates, PUT/PATCH changes, DELETE removes.
- Use the right status: 200/201/204 for success, 400 bad input, 401/403 auth, 404 missing, 409 conflict, 500 our fault.
- One error shape everywhere, e.g. { "error": "plain sentence" }.
- Keep names consistent (pick camelCase or snake_case and stay with it).
- Validate the body at the door and say which field is wrong.
- GET must never change anything. PUT and DELETE must be safe to repeat.
- Page long lists (limit and cursor) rather than returning everything.
- Do not leak internals: no stack traces, keys or database ids that are not needed.
