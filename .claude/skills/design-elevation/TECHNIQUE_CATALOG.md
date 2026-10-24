# Technique catalog

A vocabulary of specific techniques, grouped by what they achieve. Use it to replace a vague intention ("make it nicer") with a named move ("tighten heading tracking and open up the section spacing"). Pick few; see the limits in [ELEVATION_PROTOCOL.md](ELEVATION_PROTOCOL.md) phase 3.

## Typography as form

**Establishing hierarchy**
- Modular scale: derive every size from one ratio (1.2 minor third, 1.25 major third, 1.333 perfect fourth).
- Weight contrast: pair a heavy heading (600-700) with regular body; skip the in-between weights.
- Size jump: make the primary heading clearly larger (2x body or more), not slightly larger.
- Small caps or uppercase labels with added letter-spacing (0.04-0.1em) for metadata and section labels.
- Colour step: primary text, secondary text (about 60-70% contrast), tertiary - three levels, no more.

**Refining texture**
- Tighten tracking on large headings (-0.01 to -0.03em); loosen it on tiny uppercase text.
- Line height by size: 1.5-1.7 for body, 1.1-1.25 for headings.
- Measure: hold prose to 45-75 characters per line.
- Tabular numerals (`font-variant-numeric: tabular-nums`) for tables, timers, counters, prices.
- Proper characters: real quotes, en/em dashes, ellipsis, multiplication sign.
- Balance headings (`text-wrap: balance`) and avoid single-word last lines.

**Type as the visual**
- Oversized numerals as the hero of a metric card.
- A monospace face for data, code and identifiers against a sans for prose.
- One display moment per page: a very large, tightly set headline with generous space around it.
- System font stacks chosen deliberately (they are fast, native, and free).

## Colour

**Building a palette**
- Neutral ramp first: 8-10 steps of one slightly tinted grey (warm or cool, never pure).
- One accent hue; derive its tints and shades rather than adding a second hue.
- Semantic set: success, warning, danger, info - consistent meaning everywhere.
- 60-30-10: dominant neutral, secondary surface, accent for the few things that matter.
- Define roles, not colours (`--surface`, `--text-muted`, `--accent`) so themes can swap values.

**Using colour to mean something**
- Accent only on the primary action and the current state.
- Status by more than colour: add an icon, label or shape for colour-blind users.
- Tinted surfaces: mix a little accent into a background (`color-mix`) to group or highlight softly.
- Desaturate what is inactive; saturate what is live.

**Colour phenomena**
- Dark themes: raise surfaces by lightening, not by shadow; avoid pure black and pure white.
- Simultaneous contrast: the same grey looks different on different backgrounds - check in place.
- Subtle gradients: two close steps of the same hue for depth; avoid rainbow blends.
- Check in greyscale: if hierarchy collapses, it was relying on hue.

## Layout and spatial composition

**Structure**
- A real grid: 12 columns for pages, 4 or 8 px baseline for components.
- Asymmetry: a 2:1 or golden-ratio split is more dynamic than halves.
- Alignment lines: every edge lines up with another edge somewhere.
- Consistent gutters; let the gutter, not a border, separate columns.

**Space as a tool**
- Spacing scale: 4, 8, 12, 16, 24, 32, 48, 64. Nothing else.
- Proximity grouping: inner gap smaller than outer gap, always.
- Generous margins around the most important element to isolate it.
- Density by purpose: tight for tools used all day, airy for things read once.

**Guiding the eye**
- F and Z patterns: put the key item top-left, the action bottom-right or end of line.
- Progressive disclosure: show the summary, reveal the detail on demand.
- Visual weight: balance one heavy element with several light ones across the layout.
- Bleed and overlap: let one element break the grid on purpose, once.

## Depth and surface

- Elevation scale: three shadow levels at most, each tied to a meaning (resting, raised, floating).
- Layered shadows: a tight dark one plus a wide soft one reads as real.
- Hairlines: 1 px borders at low contrast instead of boxes with fills.
- Inner highlight: a faint top border on dark surfaces suggests an edge.
- Nested radius: inner radius = outer radius minus padding.
- Backdrop dimming for modals; blur only where it aids focus and performance allows.

## Texture and quality

- Subtle noise or grain to stop large flat areas looking synthetic.
- Fine patterns (dots, grid lines) at very low contrast as background structure.
- Consistent icon family: one stroke width, one corner style, one optical size.
- Purposeful imagery: crop tight, keep one treatment (all duotone, all rounded, all full-bleed).
- Crisp edges: whole-pixel positions, no blurry half-pixel borders.

## Motion

- Duration by distance: 120-200 ms for small changes, 250-350 ms for large ones.
- Ease-out for things entering, ease-in for things leaving.
- Animate one property where possible (opacity or transform) for smoothness on slow machines.
- Motion that explains: a panel slides from where it was triggered; a deleted row collapses.
- Stagger lists slightly (20-40 ms) so they read as a group arriving.
- Status motion: a slow pulse for "working", nothing for idle.
- Always honour `prefers-reduced-motion`.

## Data and dashboards

- Data-ink: remove gridlines, borders and backgrounds that carry no data.
- One number per card as the hero; context (delta, period) small and muted beside it.
- Sparklines for trend without axes.
- Direct labelling instead of legends.
- Right-align numbers, left-align text, align decimals.
- Use colour for the exception, not for every series.
- Consistent units and precision; do not show false precision.

## Interaction detail

- Visible focus ring that matches the accent.
- Hover that changes one thing (border or background), not three.
- Disabled states that look unavailable but stay legible.
- Empty states that say what goes here and how to add it.
- Loading states shaped like the content (skeletons) rather than a lone spinner.
- Feedback near the cause: errors beside the field, confirmations where the action happened.
