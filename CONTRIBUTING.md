# Contributing to Kadhai

Thank you for thinking about helping. Kadhai is a small project with a few firm ideas: it is free to run, it stays on your own computer, and it never asks you to trust it more than you can check. This guide explains how to take part, from a one-line bug report to a new feature, and what a change needs before it can be merged.

**Contents**

1. [Ways to help](#ways-to-help)
2. [How we treat each other](#how-we-treat-each-other)
3. [Reporting bugs](#reporting-bugs)
4. [Reporting a security problem](#reporting-a-security-problem)
5. [Before you start: talk first](#before-you-start-talk-first)
6. [Finding something to work on](#finding-something-to-work-on)
7. [What a change must keep](#what-a-change-must-keep)
8. [Setting up](#setting-up)
9. [Writing code](#writing-code)
10. [Testing your change](#testing-your-change)
11. [Commits](#commits)
12. [Opening a pull request](#opening-a-pull-request)
13. [Review, merging and releases](#review-merging-and-releases)
14. [The contributor agreement](#the-contributor-agreement)
15. [Do not copy](#do-not-copy)
16. [Getting help](#getting-help)

---

## Ways to help

You do not need to write code to make Kadhai better.

- **Use it and say what breaks.** A clear bug report with steps is one of the most useful things you can send.
- **Suggest features** in [Feature Requests](https://github.com/Madhuhas/kadhai/discussions/categories/feature-requests), and upvote the ideas you want most. The most wanted ones rise to the top.
- **Answer questions** from other people in Discussions.
- **Improve the docs.** The [user guide](docs/USER-GUIDE.md) and the [developer guide](docs/DEVELOPERS.md) are plain Markdown. A sentence that confused you probably confuses others.
- **Try it with real models.** Kadhai is tested with a simulated model, which never makes mistakes. Real models do. If a model of yours trips the crew up, the exact answer it gave is gold (see [Testing your change](#testing-your-change)).
- **Write code**: fix a bug, pick up a task from [Open for Contribution](https://github.com/Madhuhas/kadhai/discussions/categories/open-for-contribution), or build a feature that was agreed on first.

## How we treat each other

Be kind, be patient, and assume good intent. People here have different skills, languages and amounts of time. Criticise ideas and code, never people. Harassment, insults and personal attacks are not tolerated, in issues, discussions, pull requests or anywhere else connected with the project. The maintainer may edit, hide or remove anything that breaks this, and block people who keep doing it.

## Reporting bugs

1. **Search first.** Look through [open and closed issues](https://github.com/Madhuhas/kadhai/issues?q=is%3Aissue). If someone has reported it, add what you know there (a thumbs-up helps too) instead of opening a new one.
2. **Open a [bug report](https://github.com/Madhuhas/kadhai/issues/new?template=bug_report.yml).** The form asks for what happened, the steps to reproduce it, and how you run Kadhai.
3. **Paste the About details.** In Kadhai open **more > about** and press **Copy details**. It lists the version, your system, the flame, the safety settings and what is set up, and it never includes keys, tokens or emails.
4. **Add errors and logs** if you have them: the terminal output, the browser console (F12), or an agent's *what it is thinking* panel. Remove anything private first, such as file contents you would not want public.

A good report says what you expected, what happened instead, and how to make it happen again. "The Taster approved a file with a syntax error after I asked for X with Groq on low flame" is far more useful than "review is broken".

## Reporting a security problem

**Do not open an issue for a security problem.** Report it privately through [Report a vulnerability](https://github.com/Madhuhas/kadhai/security/advisories/new) on the Security tab, so it can be fixed before it is known. [SECURITY.md](SECURITY.md) explains what counts as a vulnerability and what to expect.

## Before you start: talk first

So that nobody spends a weekend on a change that cannot be merged, most changes start with a conversation.

**Go straight to a pull request for:**

- a fix for a bug that is clearly a bug (with steps to show it),
- typos, broken links, clearer wording in the docs or the interface,
- a failing test made to pass, or a missing test added.

**Start a conversation first for:**

- **a new feature or behaviour**: post it in [Feature Requests](https://github.com/Madhuhas/kadhai/discussions/categories/feature-requests) (or comment on the existing one) and wait for the maintainer to say yes,
- **anything that changes how the crew works**: prompts, the plan, the parser, the review, the flame's limits,
- **a new dependency, provider, service, connector or theme**,
- **a large refactor**, or anything touching more than a handful of files.

Pull requests for features that were not agreed on may be closed, however good the code is. That is not a judgement of your work; it keeps the project small enough to keep its promises.

## Finding something to work on

- [**Open for Contribution**](https://github.com/Madhuhas/kadhai/discussions/categories/open-for-contribution) lists tasks the maintainer would welcome. Each says what needs doing, where to start, how big it is and when it counts as done. Tasks marked **Small** are good first contributions.
- **Claim a task before you start.** Reply on it saying you are taking it. If you stop, say so, so someone else can pick it up.
- **Bugs** in [Issues](https://github.com/Madhuhas/kadhai/issues) are fair game too; say on the issue that you are working on it.

## What a change must keep

These are product requirements, not preferences. A change that breaks one will not be merged, so check yours against them early. The [developer guide](docs/DEVELOPERS.md) explains each one and the reasons behind it.

- **Free to run, light to run.** Kadhai must work fully with free API keys only, on an ordinary laptop with no graphics card. Paid keys and subscriptions are optional extras, labelled as paid. No model runs inside Kadhai itself.
- **One dependency.** `express` is the only package the app needs. A new dependency needs a very strong reason and the maintainer's agreement first. (The desktop app in `desktop/` keeps its own, separate packages.)
- **No build step and no framework.** The dashboard in `public/` is hand-written JavaScript modules, served as they are. Nothing is loaded from another site: no web fonts, no CDNs.
- **Local only.** The server listens only on this computer and refuses other machines and other websites. Nothing calls in from outside.
- **Safety rules hold.** Every file the crew touches goes through `Workspace`, every command through `Runner`, every write holds its file's lock, a failed edit writes nothing, keys never leave the server, and secrets are encrypted before they reach the disk.
- **Every model call is bounded.** No loop may call a model without a hard limit, and adding an agent must not add model calls to a run.
- **No emoji, images, SVG drawings or icon fonts in the interface.** Use words, plain symbols (`×`, `->`, `[x]`) or ASCII art. The few exceptions (the flow canvas's wires, brand logos in two dialogs, the desktop app's icon) are listed in the developer guide.
- **Plain, honest wording.** Interface text says exactly what happens. Never describe something as safer than it is.

## Setting up

### What you need

- **Node.js 20 or newer** ([nodejs.org](https://nodejs.org), the LTS version).
- **Git** ([git-scm.com](https://git-scm.com)). Kadhai's own undo uses it too.
- Any editor. Windows is the main platform, and macOS and Linux work as well; the tests run on Windows and Linux for every pull request.

### Get the code running

```bash
# 1. Fork the repository on GitHub, then clone your fork
git clone https://github.com/<your-name>/kadhai.git
cd kadhai

# 2. Install the one dependency
npm install

# 3. Try it with simulated models: no key, no account
npm run demo          # then open http://localhost:4747

# 4. Run the tests (offline, about two minutes)
npm test
```

To use real models, run `npm start` instead and add a free key in the **keys** dialog that opens.

### Useful commands

| Command | What it does |
| --- | --- |
| `npm run demo` | The dashboard with simulated models. Use this for interface work. |
| `npm start` | The dashboard with your real keys. |
| `npm run dev` | Like `npm start`, restarting when you change a server file. |
| `npm test` | Every test, offline. |
| `node --test --test-name-pattern="flows" test/flows.test.js` | Only the tests whose name matches. |
| `npm run mcp` / `npm run acp` | Kadhai as an MCP server or an ACP agent, on stdin/stdout. |
| `node --check <file>` | A quick syntax check. There is no linter or build. |

### Keep your real setup separate

Kadhai keeps your keys, crew, flows and settings in files next to the code (`keys.local.json`, `agents.local.json`, `settings.local.json` and others, all git-ignored). A test copy started from the same folder shares them. When you experiment, start a separate copy that cannot touch them:

```bash
KADHAI_MCP=off PORT=4799 WORKSPACE_DIR=/tmp/kadhai-try KADHAI_ROOMS_DIR=/tmp/kadhai-rooms KADHAI_DATA=/tmp/kadhai-data node server.js --mock
```

`KADHAI_DATA` moves every file of yours into that folder, `KADHAI_MCP=off` starts none of your saved connections, and `KADHAI_ROOMS_DIR` keeps your other kitchens closed. Leave out `--mock` to use real models (you will need to add a key to that copy).

### The desktop app

The desktop app lives in `desktop/` with its own `package.json`, so the main app never downloads Electron. To work on it:

```bash
cd desktop
npm install           # downloads Electron, about 150 MB
npm start             # Kadhai in its own window
npm run build:dir     # the unpacked app, for testing
```

**Windows and VS Code:** VS Code sets `ELECTRON_RUN_AS_NODE=1` in its terminals, which makes any Electron app start as plain Node.js. `npm start` in `desktop/` clears it for you; if you run the built app by hand from that terminal, clear it first. See [desktop/README.md](desktop/README.md) for more.

## Writing code

Read the [developer guide](docs/DEVELOPERS.md) before your first change: it shows how a run flows through the code and where each kind of change belongs. In short:

- **Behaviour belongs in `src/core/`.** The web server, the MCP server, the ACP agent and the desktop app are thin shells around the same engine.
- **JavaScript modules only** (`import`, never `require` in `src/` and `public/`), Node 20 or newer, built-in modules imported as `node:fs`, `node:path` and so on.
- **Never `console.log` in `src/`.** In MCP and ACP mode, standard output is the protocol. Use `log` from `src/core/util.js`.
- **Files through `Workspace`, commands through `Runner.run`.** Never call `fs` on the user's folder or `spawn` a command anywhere else.
- **In the browser,** build elements with `h()` from `public/js/util.js` and set text with `textContent`. Do not add `innerHTML`: file contents and model answers are untrusted. Colours, spacing and fonts come only from the CSS variables in `public/css/themes.css`.
- **Every form field needs a name**: a `<label>`, or an `aria-label`.
- **Match the code around you**: its naming, its comment style (comments say why, not what) and its plain wording.

The developer guide has recipes for the common changes: adding a provider, a flow service, a trigger, a connector, an MCP tool, an event or a theme.

## Testing your change

- **Run `npm test`.** It is offline: the tests use a simulated model and temporary folders, never the network or your files.
- **Add a test for new behaviour,** and a test that fails without your fix for a bug. Tests live in `test/` by area: `core`, `features`, `hardening` (security and robustness), `flame`, `runs`, `agents` and `flows`. A new test file must also be added to the `test` script in `package.json`.
- **Interface changes:** run `npm run demo`, send a task, and look at what you changed. Check it at a phone's width (390 px) for sideways scrolling, and in at least one light and one dark theme.
- **Changes to prompts, the parser or the orchestrator:** the simulated model never makes mistakes, so also try your change against a real model, using a separate copy as shown in [Setting up](#keep-your-real-setup-separate). When a real model's answer trips the crew up, add that exact answer to `test/hardening.test.js` before changing the parser.
- **Protocol changes:** pipe JSON-RPC lines into `node bin/mcp-server.js --mock` or `node bin/acp-agent.js --mock`.

## Commits

- **One change per pull request,** split into commits that each make sense on their own.
- **Write messages that say what changed and why.** A short first line in plain words ("Taster sees the check command's output"), then, if needed, a paragraph explaining the reason. Mention the issue or discussion it belongs to (`Fixes #12`).
- **Never commit keys, tokens or the files that hold them**: `.env`, `*.local.json`, `secret.local.key`. GitHub's push protection refuses known key formats, but do not rely on it.

## Opening a pull request

Before you open it:

- [ ] It does one thing, and that thing was agreed on (or is a bug fix, typo or test).
- [ ] It keeps every rule in [What a change must keep](#what-a-change-must-keep).
- [ ] `npm test` passes, and new behaviour has a test.
- [ ] Interface changes are checked in the browser, at phone width, in a light and a dark theme.
- [ ] Your branch is up to date with `main` (rebase rather than merge).
- [ ] No leftover debugging code, commented-out blocks or unrelated changes.
- [ ] The docs say how it works now: the user guide if users will notice, the developer guide if contributors need to know.

In the description, explain:

- **what changed and why**, with a link to the issue or discussion,
- **how you tested it**, including the model and flame if you tried real models,
- **anything that changes for existing users** (a setting, a saved file, a behaviour),
- **screenshots** for any change to the interface.

When you open it, two checks run: the tests on Windows and Linux, and the contributor agreement (see below). Both must pass before it can be merged.

## Review, merging and releases

- The maintainer reviews every pull request, usually within a week. Expect questions and requests for changes; they are part of the process, not a rejection.
- Reply to review comments and push follow-up commits to the same branch. Do not open a new pull request for the same change.
- Pull requests are squashed or merged by the maintainer once they pass review and the checks.
- Kadhai is in beta. The maintainer decides version numbers, writes the release notes and publishes releases; you do not need to change the version or a changelog.
- Dependency updates arrive from Dependabot as pull requests and are reviewed like any other.

## The contributor agreement

Before your first pull request can be merged, please sign the [Contributor License Agreement](CLA.md). It is short and in plain English:

- **you keep the copyright** in your work,
- you give the project a licence to use it,
- and the project **promises your contribution will always stay available under an open-source licence** (today the GNU AGPL-3.0).

To sign, post this comment on your first pull request:

> I have read the CLA Document and I hereby sign the CLA

A bot records it, and it covers everything you contribute afterwards.

## Do not copy

Write your change yourself. Do not paste code, icons, images or text from other projects, products or websites, even with changes, unless its licence clearly allows it and you say in the pull request where it came from. Code written with an AI assistant is welcome if you have read it, understand it, have tested it and can stand behind it as your own.

## Getting help

- **A question about using Kadhai or about the code?** Ask in [Discussions](https://github.com/Madhuhas/kadhai/discussions).
- **Stuck on a pull request?** Ask in the pull request itself; that keeps the context in one place.
- **News and releases** are posted in [Announcements](https://github.com/Madhuhas/kadhai/discussions/categories/announcements).

Thank you for helping Kadhai cook.
