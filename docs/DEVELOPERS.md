# Kadhai developer guide

How Kadhai is built, how to work on it, and the rules that keep it safe. Read this before your first change.

**Contents**

1. [Principles](#1-principles)
2. [Setting up](#2-setting-up)
3. [Project layout](#3-project-layout)
4. [Architecture](#4-architecture)
5. [Life of a run](#5-life-of-a-run)
6. [The browser side](#6-the-browser-side)
7. [Where data lives](#7-where-data-lives)
8. [Rules that must not be broken](#8-rules-that-must-not-be-broken)
9. [Recipes](#9-recipes)
10. [Testing](#10-testing)
11. [Checking against real models](#11-checking-against-real-models)
12. [Conventions](#12-conventions)
13. [Before you commit](#13-before-you-commit)

---

## 1. Principles

These are product requirements, not preferences.

- **Free to run, small footprint.** It must stay fully usable on free API keys on an ordinary laptop with no GPU. Paid keys and subscriptions are optional extras, labelled as paid and capped by a daily token limit. Kadhai never runs models itself.
- **One dependency.** `express` is the only npm dependency. Adding another needs a very strong reason; the platform (Node's `node:` modules, the browser's DOM) is usually enough. The Claude API is spoken with raw `fetch` for this reason.
- **No build step, no framework.** The dashboard is hand-written ES modules in `public/`, served as they are. No TypeScript compilation, no bundler, no CSS preprocessor, no web fonts or CDN assets: the UI works offline.
- **ESM only**, Node 20 or newer, built-ins imported with the `node:` prefix.
- **Local only.** The server binds to loopback, and `localOnly` rejects any non-loopback `Host` and any foreign `Origin`.
- **Bounded by construction.** Every loop that calls a model has a hard limit, and control flow is code, never model output.

## 2. Setting up

```bash
npm install
npm run demo     # dashboard on http://localhost:4747 with simulated models (no key)
npm test         # the whole suite, offline, about a minute
```

| Command | What it does |
| --- | --- |
| `npm start` | The dashboard with real providers (keys from the dashboard or `.env`) |
| `npm run demo` | The same with the mock provider: use this for UI work |
| `npm run dev` | `npm start` under `node --watch` |
| `npm test` | All test files (listed in the `test` script) |
| `npm run mcp` | The MCP server on stdio |
| `npm run acp` | The ACP agent on stdio |
| `node --check <file>` | Quick syntax check. There is no linter or build step |

Run one test by name:

```bash
node --test --test-timeout=60000 --test-name-pattern="dispatcher" test/core.test.js
```

Git must be on the PATH for the checkpoint tests.

## 3. Project layout

```
server.js                    entry point: one engine behind the HTTP server (and rooms)
bin/mcp-server.js            MCP server over stdio
bin/acp-agent.js             ACP agent over stdio
src/config.js                .env loading, provider presets, limits
src/core/
  engine.js                  builds one fully wired engine for one workspace folder
  eventBus.js                every state change is published here
  workspace.js               the only code that touches workspace files (sandbox, links, locks, atomic writes)
  lockManager.js             cross-process file mutex (lock files under .kadhai/locks)
  memory.js                  owns memory.md (three sections, nothing else)
  orchestrator.js            the hub: plan -> steps -> verify -> review -> fix
  crew.js                    the agents: roster, state, metrics, thought streams; crew.call() is the one path to a model
  customAgents.js            hired agents and per-agent settings (agents.local.json)
  agentDraft.js              "Generate with AI" for the hire form
  dispatcher.js              route table, failover, cooldowns, paid budget
  providers.js               OpenAI-compatible client and the error classifier
  anthropic.js               the Claude Messages API
  cliProvider.js / cliAgent.js   subscription CLIs as models, and as agents on high flame
  mockProvider.js            simulated models for demo mode and tests
  prompts.js / parse.js      prompt builders / tolerant parsers for model output
  runner.js                  shell commands: approval, blocklist, timeout, process-tree kill, Docker sandbox
  checkpoints.js             private shadow git repo for View changes and Undo
  git.js                     source control on the folder's own repository
  journal.js                 run journal and capped lessons
  flame.js                   low and high flame limits
  flows.js                   flow validation, scheduling and execution
  flowData.js                {{ expressions }} and conditions
  flowDraft.js               "describe / change / fix a flow" with the Chef
  services.js                built-in flow services, polled starts, credential types
  credentials.js             flow credentials (encrypted)
  codeNode.js                the Code step: a worker thread with a fresh vm context
  triggers.js                webhook, GitHub, Linear, Telegram
  keys.js / keyStore.js      key management and storage
  vault.js                   AES-256-GCM for every secret on disk
  skills.js / skillImport.js / skillGallery.js   the skills library
  stateStore.js              chat, runs and usage saved across restarts
  connectors/catalog.js      the connection catalog
  connectors/google.js       Google sign-in and tools; the Toolbox that merges all tools
  util.js                    log (stderr), sleep, clip, killTree, escapeHtml
src/protocols/               JSON-RPC peer, MCP server and client, ACP agent
src/http/
  app.js                     REST API, SSE, /mcp, security headers, preview app
  host.js                    holds the engine in use and swaps it on a folder change
  rooms.js                   extra rooms as child processes
public/
  index.html                 the one page
  css/themes.css             each theme's variables
  css/app.css                layout and components
  css/looks.css              each theme's personality (fonts, shapes, effects)
  js/app.js                  boot, SSE handling, global error reporting
  js/store.js                state and a tiny on/emit bus
  js/api.js                  every server call
  js/util.js                 h(), escapeHtml, mdLite, toast, prefs
  js/kitchen.js             the kitchen: the kadhai and the crew's stations
  js/ascii.js / ascii3d.js   faces, spinner, banner, the About pot; the 3D text renderer
  js/<panel>.js              one module per part of the screen
skills/                      built-in skills (markdown)
test/                        node:test suites and fixtures
docs/                        this guide and the user guide
desktop/                     the desktop app (Electron, its own package.json): main.cjs starts server.js in a window
```

## 4. Architecture

### One engine per folder

`createEngine()` builds everything for one workspace folder, for life. The HTTP server, the MCP server and the ACP agent are thin shells around an engine: **behaviour belongs in `src/core`, never in a shell**.

```
EventBus ......... every state change; SSE, ACP and memory.md subscribe
Workspace ........ the only door to the folder's files
LockManager ...... cross-process locks
MemoryEngine ..... memory.md
Dispatcher ....... routes and failover; calls the providers
Crew ............. agents; crew.call() is the single path to a model
Orchestrator ..... runs: plan, steps, check, review, fix
Runner ........... commands
Checkpoints ...... shadow git for diff and undo
Journal .......... past runs and lessons
Flows, Triggers .. automations and outside starts
Toolbox .......... MCP servers and Google, as one list of tools
```

### Host and rooms

The web server holds a `Host`, not an engine. Opening another folder builds a new engine and swaps it in: the host rebuilds the API router, MCP endpoint and preview, ends the old event streams (the page reconnects and re-syncs) and closes the old engine. **Never capture `engine` at app level in `src/http`; always go through `host`.**

Several folders at once are separate **processes** (rooms), each on its own pair of ports, not several engines in one process. Each room has its own settings, crew, flows and triggers files; keys, skills and MCP settings are shared files. One folder can only be open in one room (`.kadhai/room.lock`).

### Events

Every state change is published on the bus and forwarded as-is over Server-Sent Events (`GET /api/events`): `agent:update`, `agent:thought`, `run:start`, `run:plan`, `run:done`, `exec:*`, `fs:*`, `lock:*`, `flows:update` and more (the full list is in CLAUDE.md). The browser applies them in `handlers` in `public/js/app.js`. On every (re)connect it pulls a full snapshot, so it can never drift.

## 5. Life of a run

1. `POST /api/task` calls `orchestrator.start(text, { source: 'ui' })`. A busy crew queues it.
2. **Plan.** The Chef (`crew.call('general-manager', ...)`) gets `memory.md`, the request and a short list of connections, and answers with JSON: an objective, steps (each with a level, files, instructions, optional tools and cook) and an optional check command. `#sanitizePlan` clamps it to the limits and assigns cooks by code (`COOK_FOR_LEVEL`).
3. **Steps.** `#schedule` starts steps when the steps they need are done (one at a time on low flame, up to three on high). Each step locks its declared files for its whole duration. The cook answers in plain-text blocks (`<<<FILE>>>`, `<<<EDIT>>>`, `<<<RUN>>>`, `<<<TOOL>>>`, `SUMMARY:`), parsed by `parseWorkerOutput`. Edits are all-or-nothing per file; commands go through `Runner.run` (waiting for approval in "ask" mode); tool calls go through the Toolbox and are checked against the agent's allowed connections. Rounds are bounded, and a circuit breaker narrows or stops a step that keeps going wrong. A failed step is retried once by the Senior Cook.
4. **Check.** The plan's check command runs; its real output goes to the review.
5. **Review and fix.** The Taster reviews the changed files; reported defects become one fix step for the Fixer. High flame adds one security-only review for sensitive changes.
6. **Wrap up.** Checkpoints are committed before and after, the journal gets an entry and lessons, `memory.md` is updated, and `run:done` is published. `run.done` always resolves, never rejects, so the queue cannot jam.

Agents are stateless: no chat history is ever sent. A prompt is `memory.md`, the files the step needs and a small, fixed number of lessons. Prompts are rebuilt on every provider attempt, so a model that takes over after a failover sees the current state.

## 6. The browser side

- **No framework.** DOM is built with `h(tag, attrs, ...children)` from `util.js`; text is always set with `textContent`. The only `innerHTML` uses are `mdLite`, `highlight` and `renderDiff`, and each escapes its input first (with the shared `escapeHtml`). Keep it that way: file contents and diffs are model-written.
- **State.** `store.js` holds `state` and a tiny `on/emit` bus. `app.js` turns server events into state changes and topics (`agents`, `run`, `fs`, `flows`...); each panel module renders on the topics it cares about.
- **Errors.** Every part of the page starts on its own (one that fails is reported, the others still work), and a global handler shows errors nothing else caught, rate-limited, in place of a framework's error boundary. `api.js` turns network failures into a plain "Kadhai is not answering" message and encodes every path segment.
- **The look** is a small retro desktop: a dotted canvas, grey window chrome, one monospaced face, almost no colour (theme Light; the other themes vary fonts, corners and effects). Colours come only from variables in `themes.css`; each theme's fonts, corners and effects live in `looks.css`. No emoji, images, SVG drawings or icon fonts (the flow canvas's wires and the brand logos in two dialogs are the only exceptions). Everything drawn is ASCII art from `ascii.js`.
- **Animation** goes through the one shared timer in `ascii.js`, which rests while the tab is hidden and draws a single still frame under `prefers-reduced-motion`. The kitchen (`kitchen.js`: the 3D kadhai and the crew's stations) redraws only when what it shows changes.
- **Agents' colours.** Anything that stands for an agent gets the class `tinted` and `style: tintOf(id)`, and is coloured in CSS through `--agent`.
- **Accessibility.** Every form field needs a name (a `<label>`, `aria-label` or `ariaLabel` in `h()`); a placeholder is not a name. Every mouse action has a keyboard equivalent. New themes must keep text, muted text, buttons and the terminal at 4.5:1 contrast or better.
- **Layout breakpoints.** Three columns; under 860px the files column goes; under 620px the stage sits above the chat. Check new panels at 390px wide for sideways scroll.

## 7. Where data lives

### In the Kadhai folder (user-owned, git-ignored, never commit or overwrite)

| File | Holds |
| --- | --- |
| `.env` | Optional settings and keys |
| `keys.local.json` | Provider keys (encrypted), endpoints, subscription settings |
| `secret.local.key` | The vault's master key (DPAPI-wrapped on Windows). Deleting it makes every saved secret unreadable |
| `settings.local.json` | The folder last opened, the flame |
| `agents.local.json` | Hired agents, per-agent settings, connection access |
| `mcp.config.json` | MCP servers (settings encrypted) |
| `connectors.local.json` | Google connector |
| `credentials.local.json` | Flow credentials (encrypted) |
| `flows.local.json`, `flows.local.runs.json` | Flows and their run history |
| `triggers.local.json` | Triggers (tokens encrypted) |
| `skills.local/` | The user's own skills |
| `rooms.local/` | Extra rooms and their files |

### In each workspace folder

| Path | Holds |
| --- | --- |
| `memory.md` | The three-section state file (written only by `MemoryEngine`) |
| `.kadhai/state.json` | Chat, run list, daily usage |
| `.kadhai/journal.jsonl`, `.kadhai/lessons.json` | Memory |
| `.kadhai/git/` | The shadow repository for checkpoints |
| `.kadhai/locks/`, `.kadhai/tmp/` | Lock files, atomic-write temp files |

Every secret is encrypted with `vaultFor(file).encrypt` before it is written; `decrypt` passes plain text through, so hand-edited files keep working.

## 8. Rules that must not be broken


1. **All file access goes through `Workspace`.** It enforces the sandbox, protected names (`.git`, `.kadhai`, `node_modules`, in any spelling the disk accepts), link checks, locks and atomic writes. Never call `fs` on workspace paths elsewhere. The preview server checks `staysInside` before serving a file.
2. **Every write holds the file's lock**, released in a `finally`.
3. **Every command goes through `Runner.run`.** Never `spawn` or `exec` a model- or client-supplied command anywhere else. Stop children with `killTree`, never `child.kill()`.
4. **Hub and spoke.** Agents never call or prompt each other; the orchestrator passes the work. Adding an agent must not add model calls to a run.
5. **Every model loop is bounded** by a number in `config.limits`, with a low-flame and a high-flame value (`flame.js`).
6. **`memory.md` has exactly three sections** and is written only by `MemoryEngine`.
7. **Agents are stateless.** No chat history in prompts; lessons and journal look-ups are capped.
8. **API keys never leave the server.** Responses carry masks and ids only; keys are never logged; child processes get no key-like environment variables.
9. **Provider errors are classified in one place** per API (`classify`, `classifyAnthropic`, `classifyCli`) and mapped to cooldowns in `Dispatcher.#penalize`.
10. **A failed edit writes nothing.** Never apply the well-formed part of a malformed edit.
11. **stdout is a protocol channel** for the MCP and ACP entry points. Never `console.log` in `src/`; use `log` from `util.js` (stderr).
12. **Nothing calls in.** Triggers poll outward; the webhook route stays behind `localOnly`. No tunnels.
13. **A flow may branch but never loop**, and text from outside can only fill data fields, never addresses, commands, file names or recipients.
14. **Generated pages are untrusted.** They are served on another port (another origin); the dashboard sends a strict Content-Security-Policy (no inline scripts, nothing from other hosts).

## 9. Recipes

**Add an HTTP route.** In `apiRouter` in `src/http/app.js`. Wrap async handlers in `wrap()` so errors reach the error middleware (which maps `ELOCKED` to 423 and `err.status` otherwise, and logs any 500). Validate the body; throw errors with a `status` and a sentence the user can act on. Add the call to `public/js/api.js`, encoding path segments with `seg()`.

**Add an event.** Publish it on the bus in core code; handle it in `handlers` in `public/js/app.js`; if editors should see it, in `src/protocols/acpAgent.js`; and list it under *Events* in this guide.

**Add a free provider.** A preset in `PROVIDER_PRESETS` in `src/config.js`. Probe `GET {baseUrl}/models` with a wrong key first: a 401 means the default key check works; a 200 means the list is public, so set `verifyUrl` to an endpoint that does need a key. Take default model ids from the provider's live list, never from memory.

**Add a built-in flow service.** In `SERVICES` in `src/core/services.js`: label, credential type, `checked` (how far it was verified) and actions with fields (mark addresses, recipients and ids `fixed`) and a `run` built on `request()`. If an action only reads, add it to `READS` so **Try once** runs it; everything else is held back by default. Add what it hands on to `GIVES` in `flowDraft.js` (a test checks every action has an entry).

**Add a flow step type.** `NODE_TYPES`, `#config` and `#runNode` in `src/core/flows.js`; `KINDS` (and `outPorts` if its ports differ) in `public/js/flowKit.js`; `nodeForm` and `summary` in `public/js/flows.js`; and whether **Try once** holds it back (`#held`). Keep the keyboard equivalent for every mouse action.

**Add a theme.** A variable set in `themes.css` (colours, `--font-ui`, `--font-head`, `--font-prose`, `--r-*`, `--ascii-ramp`), add it to the *flat* and/or *dark-toned* selector lists in `app.css` and `looks.css` where it belongs, give it its personality in `looks.css`, and register it in `THEMES` in `settings.js`. Use system fonts with generic fallbacks only. Check contrast (4.5:1) and look at the kitchen, chat, a dialog and the flows window in the browser.

**Add an MCP tool (Kadhai as a server).** Append to `buildTools` in `src/protocols/mcpServer.js`; it is then offered over stdio and `/mcp`.

**Add a catalog connection.** In `src/core/connectors/catalog.js`, only after checking the package or address is real and starting it through `McpHub`; record how far you got in `checked`.

**Change the model output format.** Change the prompt, the parser, `mockProvider.js` and the parser tests together. When a real model trips the parser in a new way, add its exact text to `test/hardening.test.js` before loosening anything.

## 10. Testing

| File | Covers |
| --- | --- |
| `test/core.test.js` | Dispatcher, crew, orchestrator, parser, workspace, locks, checkpoints, runner |
| `test/features.test.js` | Keys, connectors, MCP, git, folders, custom agents, triggers, skills, generate an agent |
| `test/hardening.test.js` | Security and robustness: protected names, links, environments, the preview, local-only access |
| `test/flame.test.js` | Low and high flame, rooms sharing it, skill import |
| `test/runs.test.js` | Around a run: tokens, lessons, circuit breaker, security pass |
| `test/agents.test.js` | High flame: CLI agents against a stand-in, parallel steps, file recall |
| `test/flows.test.js` | Flow data and expressions, every step type, credentials, history, polled starts, describe / change / fix, Try once |

Rules for tests:

- **Never touch the network or the user's files.** Pass `completion` (a fake model), `fetch` (a stand-in), and override every file path (`keysFile`, `agentsFile`, `flowsFile`, `triggersFile`, `credentialsFile`, `skillsDir`, `ownSkillsDir`) to a temporary folder. An engine built with the default files must never rewrite them.
- Use the mock provider or a `completion` function that answers by `role`.
- Drive time with `overrides.now` and call `flows.tick()` or `triggers.poll()` directly; never sleep for real time.
- When waiting for the crew, wait until it has been idle for several checks in a row, not for a fixed short delay (that made one test flaky on a busy machine).
- A new test file must be added to the `test` script in `package.json`.

## 11. Checking against real models

The mock never makes a mistake; real models do. After touching prompts, the parser or the orchestrator, try a few real runs on a throwaway copy:

```bash
KADHAI_MCP=off PORT=4799 WORKSPACE_DIR=<scratch folder> KADHAI_ROOMS_DIR=<scratch folder> node server.js
```

- `KADHAI_MCP=off` keeps it from starting the saved MCP servers (a sign-in server would open a browser tab).
- `KADHAI_ROOMS_DIR` keeps it from starting or closing the real rooms.
- It uses the real keys and shares the Kadhai folder's local files: back up `settings.local.json` and `mcp.config.json` first, and remove what the copy created afterwards.
- Send tasks to `POST /api/task`, approve commands from `GET /api/state` (`exec.pending`), and read the agents' `thought` when something goes wrong.

For UI changes, use `npm run demo` and look at the result in both a light and a dark theme and at 390px wide.

## 12. Conventions

- **Naming.** Files are camelCase modules; classes PascalCase; constants in UPPER_CASE when they are bounds or tables (`MAX_NODES`, `SERVICES`). Private class members use `#`.
- **Comments** explain why, not what, in plain sentences. Match the density of the code around you.
- **Errors** carry a `status` and a message a user can act on (*Give the flow a name*, not *invalid input*). Validation errors are 400; conflicts 409; locks 423.
- **User-facing text** is plain English, without emoji. Name things as the user sees them (the Chef, a step, a flow), not by internal ids.
- **Logging** goes to stderr through `log`. Never log a key, a token or an email.
- **No new dependencies, no build step.** Reach for Node's built-ins and the browser's DOM first.

## 13. Before you commit

- `node --check` on every changed file, then `npm test`.
- For UI changes: look at it in the browser (light and dark theme, 390px wide, no errors in the console).
- For prompt, parser or orchestrator changes: a few real-model runs.
- If you added a rule, a file or an event, update this guide; if users will notice, update [the user guide](USER-GUIDE.md).
- Do not commit the user-owned files listed in [Where data lives](#7-where-data-lives).
