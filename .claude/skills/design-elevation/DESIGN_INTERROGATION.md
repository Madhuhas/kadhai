# Design interrogation

Five levels of questions to put to a design before it is delivered. Answer them honestly about the thing in front of you; "it's the default" is not an answer.

## Level 1 - First principles

- What is this for? Say it in one sentence.
- Who is looking, and what do they need to do or know within five seconds?
- What is the one thing that must be seen first? Is it?
- What would make this a failure even if it looked beautiful?
- What is the emotional register: calm, urgent, playful, authoritative? Does the design match it?

## Level 2 - Element by element

**Typography**
- Why this typeface? What does it say about the subject?
- How many sizes are in use? Do they follow a ratio (1.2, 1.25, 1.333)?
- Is hierarchy carried by size, weight and space - or by colour alone?
- Are line length and line height comfortable for the amount of text?
- Are numbers tabular where they need to align?

**Colour**
- What is each colour's job (background, surface, text, accent, status)? Any colour without a job goes.
- Is there exactly one accent, used sparingly enough to mean something?
- Do status colours mean the same thing everywhere?
- Does it pass contrast? Does it survive greyscale? Does it work in the other theme?

**Layout**
- What is the grid? What does everything align to?
- Where does the eye enter, and where does it go next?
- Is the most important content given the most space?
- Are related things close and unrelated things far (proximity doing the grouping, not boxes)?

**Spacing**
- Is there one spacing scale (4, 8, 12, 16, 24, 32, 48...)? Any value off the scale?
- Is spacing inside a group smaller than spacing between groups?
- Is there enough empty space for the piece to breathe, or is every pixel filled?

**Components and detail**
- Do similar things look the same and different things look different?
- Does every interactive element look interactive, and have hover, focus and disabled states?
- What do the empty, loading and error states look like?

## Level 3 - Reference check

- Which reference in [REFERENCE_LIBRARY.md](REFERENCE_LIBRARY.md) handles this kind of problem well? What would they do differently here?
- What would a senior designer change first if shown this?
- Is there a convention users already know for this pattern? Am I breaking it for a reason?

## Level 4 - Uniqueness

- Could this be swapped into an unrelated product without anyone noticing?
- Which single choice here is specific to this subject?
- Is anything here only because it is fashionable (gradients, glass, oversized radii)?
- Does it look like a template? What gives it away?

## Level 5 - Removal test

For each element, ask: if I delete this, what is lost?

- Borders, dividers, boxes: is spacing alone enough?
- Shadows: is the layer order already clear?
- Icons: do they speed recognition or just fill space?
- Labels and helper text: can the layout make them unnecessary?
- Colour: would it read the same with one fewer?
- Animation: does it explain a change, or just move?

What remains after this test is the design.
