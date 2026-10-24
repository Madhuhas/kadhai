---
name: design-elevation
description: Applies professional design thinking to any visual output so it looks hand-crafted rather than generic. Use whenever creating or restyling something visual - HTML pages, dashboards, UI components, CSS, presentations, reports, PDFs, charts, spreadsheets - or when asked to make something look better, more polished or more professional.
---

# Design elevation

Visual work produced in one pass looks like a first draft: default fonts, even spacing, a safe palette, everything the same weight. This skill adds the rounds of refinement a designer would do before showing the work to anyone.

The method is always the same: **build a functional version, then elevate it** by questioning every choice, borrowing from proven references, applying specific techniques instead of defaults, and then removing whatever did not earn its place.

## When to use

Any time the output will be looked at, not just read: pages, dashboards, components, slides, documents, charts. Also when editing existing visual work.

Skip the full process for throwaway output (a debug table, a quick sketch the user called rough). Even then, apply the non-negotiables below.

## The process

Follow [ELEVATION_PROTOCOL.md](ELEVATION_PROTOCOL.md). In short:

1. **Foundation** - make it work first: correct content, structure, behaviour.
2. **Interrogate** - run [DESIGN_INTERROGATION.md](DESIGN_INTERROGATION.md) over the functional version.
3. **Select techniques** - pick a few, deliberately, from [TECHNIQUE_CATALOG.md](TECHNIQUE_CATALOG.md).
4. **Check references** - compare against [REFERENCE_LIBRARY.md](REFERENCE_LIBRARY.md).
5. **Apply with discipline** - one system, used consistently.
6. **Verify restraint** - remove what is decoration without purpose.
7. **Polish** - the details that signal care.
8. **Confirm it is specific** - could this only belong to this project?

[DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md) explains the judgement behind these steps: when to be bold, when to hold back. Read it when a choice feels arbitrary.

Read the reference files you need for the task at hand; you do not have to load all of them every time. The protocol and the interrogation checklist are the two that matter most.

## Non-negotiables

These apply to every visual output, however small:

- **One type scale, one spacing scale, one palette.** Define them once (as CSS variables or the tool's equivalent) and use nothing outside them.
- **Hierarchy is visible at arm's length.** Squint: one thing reads first, then a second, then the rest.
- **Contrast is real.** Body text meets WCAG AA (4.5:1). Never light grey on white.
- **Nothing is centred, boxed, shadowed or coloured by default.** Each needs a reason.
- **Respect the existing system.** In a project with its own design tokens, themes or component styles, work inside them. Elevate within the system; do not replace it.
- **Respect the constraints.** No new dependencies, fonts or CDN assets unless the project allows them.

## How to report

Unless the user asks to see the process, deliver the elevated result and say in two or three sentences what you changed and why - the decisions, not a tour of the checklist. If the user asks for a before/after, keep the functional version and show both.

## Working in the Kadhai repo

Kadhai's dashboard has hard constraints (see `CLAUDE.md`): no build step, no framework, no web fonts or CDN assets, and all colour comes from the theme variables in `public/css/themes.css`. Elevation there means better use of spacing, type scale, hierarchy and the existing variables across all four themes - never literal colours or new assets. Check changes in at least one dark theme, the light theme (Masala Chai) and Retro Terminal.
