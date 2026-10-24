---
name: Performance
description: Do less work: find the real bottleneck, then fix that.
---

- Do not optimise on a guess; find the slow part first, and keep the simple version if it is fast enough.
- Fix the algorithm before the details: avoid loops inside loops over the same data; use a Map or Set for lookups.
- Do not do work twice: cache what is expensive and stable, and say when the cache is cleared.
- Read and write in batches; never query or fetch inside a loop when one call can do it.
- Stream large files instead of loading them whole.
- In the browser: change the DOM in one pass, debounce handlers for scroll, resize and typing, and load only what the page needs.
- Keep memory bounded: cap lists, logs and buffers.
