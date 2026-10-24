---
name: Modern JavaScript
description: Current JS and Node idioms: ES modules, async/await, built-ins before packages.
---

- ES modules (import/export), const by default, let when reassigned, never var.
- async/await with try/catch; never leave a promise unhandled. Use Promise.all for independent work.
- Prefer built-ins to packages: fetch, URL, structuredClone, Intl, node:fs/promises, node:test.
- In Node, import built-ins with the node: prefix.
- Use ===, optional chaining (?.) and ?? rather than ||, when 0 or "" are valid values.
- In the browser, set text with textContent, not innerHTML, for anything a user or a model wrote.
- Keep functions pure where you can; pass dependencies in rather than reaching for globals.
