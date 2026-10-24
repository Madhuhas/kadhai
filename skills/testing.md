---
name: Testing
description: Focused tests for behaviour, edge cases and regressions.
---

- Test behaviour through the public interface, not private details.
- One reason to fail per test; name it as a sentence saying what should happen.
- Cover the edges: empty input, one item, the boundary value, bad input, the error path.
- A bug fix comes with a test that fails without the fix.
- Keep tests fast and offline: no network, no clock, no shared state between tests. Use temp folders and fakes.
- Use the test runner the project already has; do not add a framework.
- Assert on exact values, not just "truthy".
