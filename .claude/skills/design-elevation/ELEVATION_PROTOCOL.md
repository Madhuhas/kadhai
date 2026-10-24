# Elevation protocol

Eight phases, in order. The early ones are about decisions; the later ones are about removing and refining. Do not skip to polish: polish on a weak structure makes a shiny first draft.

## 1. Foundation assessment

Build or read the functional version and establish the facts.

- What is it for, and who looks at it, for how long, on what screen?
- What is the single most important thing on it?
- What already exists: brand, design tokens, components, constraints?
- Is the content right? Design cannot rescue wrong or missing content.

Output of this phase: one sentence stating the job of the piece ("lets a developer see at a glance which agent is working").

## 2. Initial interrogation

Run [DESIGN_INTERROGATION.md](DESIGN_INTERROGATION.md) against the functional version. Write down the weaknesses you find. Typical ones: no clear first read, five font sizes with no ratio between them, equal spacing everywhere, colour used as decoration, every element in a box.

## 3. Technique selection

Choose from [TECHNIQUE_CATALOG.md](TECHNIQUE_CATALOG.md) what addresses the weaknesses from phase 2. Limit yourself:

- **one** idea for typography,
- **one** for colour,
- **one** for layout and space,
- at most **one** signature detail (a texture, a motion, an unusual treatment).

More than that and the piece has no point of view.

## 4. Reference checking

Pick one or two references from [REFERENCE_LIBRARY.md](REFERENCE_LIBRARY.md) that suit the job and ask what they would do here. You are borrowing principles (how Linear handles density, how Swiss design builds a grid), not copying a look.

## 5. Disciplined application

Implement the choices as a system:

- Define the scales first: type, spacing, radius, colour roles.
- Apply them everywhere. An exception is a decision; make it once and make it obvious.
- Align everything to something. Stray offsets of a few pixels read as carelessness.
- Build states too: hover, focus, active, disabled, empty, loading, error.

## 6. Restraint verification

Go through the piece and try to delete things.

- Remove each border, shadow, background, icon and divider in turn. If nothing is lost, leave it out.
- Count the colours, sizes and weights. Reduce.
- Is there more than one thing shouting? Quiet all but one.
- Is the signature detail still serving the content, or performing?

## 7. Final polish

The details that separate finished from nearly finished.

- Optical alignment (icons next to text, numerals in columns).
- Tabular figures for numbers that change or line up.
- Line length (45-75 characters for prose), line height, no orphaned words in headings.
- Consistent corner radii, nested radii that match their padding.
- Transitions short and purposeful (120-200 ms); respect `prefers-reduced-motion`.
- Focus rings visible. Touch targets at least 40 px.
- Check narrow widths, long content, empty content, and every theme.

## 8. Uniqueness confirmation

Final test: cover the logo. Could this be any product, or does it clearly belong to this one? If it is interchangeable, return to phase 3 and make one choice more specific to the subject - not more decorated.

Then stop. Elevation is finished when removing anything else would hurt.
