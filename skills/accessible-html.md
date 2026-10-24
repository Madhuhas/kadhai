---
name: Accessible HTML
description: Semantic markup, labels, keyboard use and contrast.
---

- Use the real element: button for actions, a for navigation, label for every input, one h1 and headings in order.
- Every image needs alt text; decorative ones get alt="".
- Everything that works with a mouse must work with the keyboard, with a visible focus outline. Never remove outlines without a replacement.
- Do not signal state with colour alone; add text or a symbol.
- Text contrast of at least 4.5:1 against its background.
- Set lang on html, and a meaningful title.
- Use ARIA only when no native element does the job; a wrong role is worse than none.
