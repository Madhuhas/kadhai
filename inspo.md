# Inspo

Where Kadhai's ideas came from, what was taken from each, and what was deliberately left behind. Read this before adding a feature "like X": it says what Kadhai already borrowed from X and why the rest was turned down.

## The one-line pitch

A kitchen brigade of AI agents that cooks software in a folder on your laptop, for free. Your models, your keys, your machine.

*Kadhai* (kadai) is the deep, round Indian cooking pan. The whole product is that metaphor taken seriously: a Chef takes the order, cooks work their stations, a Taster checks the plate, a Fixer sends it back right.

## Influences

### 1. The kitchen brigade

The classic restaurant hierarchy (chef, sous-chef, chef de partie, commis) is the model for the crew.

- **Taken:** clear ranks that map to difficulty. The Chef plans; Prep, Cook and Senior Cook take easy, normal and hard steps; the Taster reviews; the Fixer fixes. Cook selection is code (`COOK_FOR_LEVEL`), not a model's choice.
- **Taken:** the order ticket, stations, a pot on the stove - the whole kitchen floor in the UI.
- **Left behind:** the full brigade. A first version had 18 restaurant roles; it was cluttered and most did no distinct work. Rule since then: every agent must do distinct work, no decorative roles.
- **Left behind:** the French titles in the UI. Plain names that say the job won (Chef, Prep, Cook, Senior Cook, Taster, Fixer). The old ids stay in code.

### 2. Sai (the user's own portfolio)

`C:\Users\dell\Desktop\M\Pro\Sai`, a Next.js "Portfolio OS". The whole look is copied from it and written down in [theme.md](theme.md).

- **Taken:** a small retro desktop - dotted grey canvas, thin taskbar, windows with title bars and hard offset shadows, one monospaced face, file-like names (`kitchen.exe`, `chat.log`, `files.dir`), headings written as `// comments`, grey first and colour only for meaning.
- **Added on top:** no emoji, no pictures, no icon fonts. Everything that is not text is ASCII art; anything that moves is an ASCII animation.

### 3. VS Code (Dark Modern)

- **Taken:** the dark theme must *feel* like VS Code Dark Modern: flat `#181818` / `#1f1f1f` panels, 1px frames, one blue accent `#0078d4`. A neutral-grey attempt was rejected for not feeling like it.
- **Taken:** the familiar workbench layout - files left, editor in the middle with tabs, a panel on the right, a terminal docked at the bottom of the stage, a status bar (the usage bar) along the bottom, source control under the files.
- **Taken:** a plain dark terminal (`#0c0c0c`), with shell-coloured commands. Not green, no scanlines, no glow.

### 4. Workflow canvases

Node-and-wire automation editors in general.

- **Taken:** a real canvas, not a simplified idea of one. Flows are draggable nodes (trigger, app, agent, if, http) joined by wires, apps carry their logos, and an agent node has a tools port you plug apps into. A first "list of steps" version was rejected: when the user asks for a kind of interaction, build that interaction.
- **Left behind:** loops, code nodes and anything that runs with nobody watching without a bound. A flow may branch but never loop, and every agent node is an ordinary, bounded run.

### 5. Agent harnesses

Desktop apps that run several coding agents at once and show them at work.

- **Taken:** use the subscriptions you already pay for. Claude Code, Codex CLI and Gemini CLI can be routes; their plan's limits are used first, free keys take over after.
- **Taken:** agents visualised at work on a shared floor (our kitchen floor), each agent in its own tab, a live view of what each is thinking.
- **Taken:** anything can wake the crew (issues, a chat bot, a webhook), and several projects at once (rooms, shown as kitchens: one folder per process).
- **Taken, on high flame only:** the CLI as a real agent, and several agents at once. Low flame keeps the CLI a *model* (one answer, tools off, in an empty temp folder). High flame lets it work with its own tools - but on a temporary copy of the folder, never the folder itself; its changes come back through the workspace (locks, review, diff, undo), merged three ways if the file changed meanwhile. Edits only unless the operator ticks *agents run commands* for one task. Up to three steps cook side by side; on the floor, tickets fly to the cooks and each busy cook has a steaming pan.
- **Left behind:** Electron, a PTY, sprite engines and the rest of the heavy stack (headless streaming JSON instead of a PTY; ASCII instead of sprites). Agent mailboxes and a boss agent routing messages: Kadhai's hand-offs stay code, not model output.

### 6. wshobson/agents

A large library of agent definitions and skills.

- **Taken:** skills. A small built-in library in `skills/` (clean code, security, testing, accessible HTML, ...), your own in `skills.local/`, import from a link, a gallery, up to five per agent. The flame decides how much of each reaches a prompt.
- **Left behind:** a gallery of dozens of agents. That is the 18-role problem again. Hire a specialist when you need one.

### 7. Free LLM tiers

[awesome-freellm-apis](https://github.com/open-free-llm-api/awesome-freellm-apis) and the free tiers of Gemini, Groq and Cerebras.

- **Taken:** the founding constraint. Kadhai must be fully usable with free keys on a 7th-gen i7 with 12 GB RAM and no GPU. When one provider rate-limits, the call is replayed on the next and the work carries on.
- **Consequence:** almost every design choice is a token-saving one - stateless agents, a three-section `memory.md`, tools scoped per sub-task, fixed caps on lessons and skills, low flame by default. Free tiers allow about 8k tokens a minute; everything is shaped around that.

### 8. Claude Code and the coding-agent CLIs

- **Taken:** the plain-text edit protocol (`<<<FILE>>>`, SEARCH/REPLACE hunks) instead of JSON, because weaker models break when escaping code inside JSON.
- **Taken:** command approval (`ask` mode by default), checkpoints you can undo, a diff per run, MCP both ways and ACP so editors can drive the crew.

## Principles that came out of all this

- **Keep it simple** means no clutter - not a smaller version of a feature someone asked for by name.
- **Zero cost, low footprint.** One dependency (Express). No build step, no framework, no web fonts, works offline.
- **Local only.** Listens on loopback; nothing calls in from the internet; triggers poll outward.
- **Control flow is code, not model output.** Every loop that calls a model has a hard bound.
- **The pot moves only while work is happening.** At rest, everything is still.
- **One live place over extra lines.** Usage is a bar along the bottom, not a "Used N tokens" line in every reply.
- **Honest about limits.** What was tested with a real key, and what was not, is written down.

## Offered and declined

- Starter templates ("dont want 6").
- A full agent gallery built from wshobson's agent files (only the skills were taken).
- Per-run token lines in the chat (replaced by the usage bar).
- A 3D ASCII pan (replaced by the hand-drawn pot).
