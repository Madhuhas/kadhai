---
name: Responsive CSS
description: Mobile-first layouts with flex, grid and CSS variables.
---

- Write the narrow layout first, then widen with min-width media queries.
- Lay out with flexbox and grid; avoid floats and fixed pixel widths. Use max-width, minmax(), clamp() and gap.
- Put colours, spacing and type sizes in CSS variables on :root and reuse them.
- Include <meta name="viewport" content="width=device-width, initial-scale=1">.
- Use rem for type, and never let the page scroll sideways: images get max-width: 100%.
- Tap targets at least 44px high on touch screens.
- Keep selectors flat (one class); no !important unless overriding third-party CSS.
