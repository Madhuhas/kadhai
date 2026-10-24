# Kadhai

[![Tests](https://github.com/Madhuhas/kadhai/actions/workflows/test.yml/badge.svg)](https://github.com/Madhuhas/kadhai/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/Madhuhas/kadhai?include_prereleases&label=release)](https://github.com/Madhuhas/kadhai/releases)
[![License](https://img.shields.io/github/license/Madhuhas/kadhai)](LICENSE)

**Website:** [kadhai.pages.dev](https://kadhai.pages.dev) · **Download:** [releases](https://github.com/Madhuhas/kadhai/releases) · **Community:** [discussions](https://github.com/Madhuhas/kadhai/discussions)

**A local-first workspace where a crew of AI agents builds, tests and automates for you. Your models, your keys, your machine.**

> **Beta.** Kadhai works and is used every day, and it is still being polished. Expect rough edges, and please report what breaks.

You describe what you want in plain words. A crew organised like a restaurant kitchen (a Chef who plans, cooks who write the code, a Taster who checks it, a Fixer who fixes what the Taster finds) does the work in a folder on your computer, runs the checks, reviews itself and reports back. You watch every step live, approve the commands it wants to run, and can undo any run.

It runs entirely on **free AI model tiers** (Gemini, Groq, Cerebras and seven more), switching to the next provider whenever one hits its limit. Paid keys and the subscriptions you already have (Claude Code, Codex, Gemini CLI) work too, when you want them.

## Highlights

- **A crew, not a chatbot.** Planning, coding, checking and fixing are separate agents with separate jobs, coordinated by plain code. Every step has a fixed budget of model calls, so runs are predictable and cheap. Hire your own specialists, or have the Chef write one for you, and switch off any agent a job does not need.
- **Free by default.** One small Node process with a single dependency, no GPU, no build step. Automatic failover across providers keeps going when a free tier says "slow down".
- **Safe by design.** Listens only on your own computer. The crew cannot leave its folder. Commands wait for your approval. Every secret is encrypted on disk. Every run can be diffed and undone.
- **Flows.** Draw automations on a canvas (schedules, feeds, webhooks, AI, logic, HTTP and fifteen built-in services), or just describe one in words and let the Chef draw it. Try any flow safely first: reads run for real, anything that would send or change something is held back and shown.
- **Connections.** About fifty services the crew can use while it works (web search, a browser, GitHub, Notion, Linear and more), plus Google Drive, Gmail and Calendar, read-only.
- **Plays well with others.** Kadhai is an MCP server and client and an ACP agent, so Claude Desktop, Claude Code, Cursor or Zed can hand it work, and it can use their tools.
- **A kitchen you can watch.** A 3D kadhai and 3D cooks drawn entirely in text characters: the Chef hands out tickets, cooks walk up to the pot, dishes go to the Taster, and the crew cheer or slump when the run ends. Nine themes with their own fonts, shapes and effects.

## Quick start

**On Windows, the easiest way** is the desktop app (beta): download `Kadhai-Beta-Setup` from the [releases page](https://github.com/Madhuhas/kadhai/releases) and run it. No Node.js needed. The installer is not code-signed yet, so Windows may warn about an unknown publisher: choose *More info*, then *Run anyway*.

**On any system**, you need [Node.js](https://nodejs.org) 20 or newer and [Git](https://git-scm.com) (Git also powers View changes and Undo):

```bash
git clone https://github.com/Madhuhas/kadhai.git
cd kadhai
npm install
npm run demo     # try it with simulated models, no account needed
```

Open <http://localhost:4747>, type a request in the chat (for example *make a small web page that says hello*) and watch the crew work.

For real work:

```bash
npm start
```

The **keys** dialog opens by itself. Paste a free key from [Google AI Studio](https://aistudio.google.com/apikey), [Groq](https://console.groq.com/keys) or [Cerebras](https://cloud.cerebras.ai); it is checked and used straight away. Keys from two or more providers give the smoothest failover.

## Documentation

| Guide | For |
| --- | --- |
| [User guide](docs/USER-GUIDE.md) | Everyone: getting started, the screen, the crew, models and keys, flows, connections, kitchens, themes, safety, troubleshooting |
| [Privacy](docs/PRIVACY.md) | Everyone: what leaves your computer, when, and to whom (no telemetry) |
| [Developer guide](docs/DEVELOPERS.md) | Contributors: architecture, the life of a run, where data lives, the rules, recipes, testing |
| [Security](SECURITY.md) | Everyone: how to report a security problem privately, and what counts as one |
| [Contributing](CONTRIBUTING.md) | Contributors: ways to help, talking first, what a change must keep, setup, testing, pull requests, the contributor agreement |
| [desktop/](desktop/README.md) | The desktop app (beta): Kadhai in its own window, and how to build the installer |

## How it works, in one picture

```
      You
       | request                                  report ^
       v                                                 |
 Chef --plan--> orchestrator (plain code) ---------------+
                    |  one cook per step (up to 3 at once on high flame)
       +------------+------------+------------------+
       v            v            v                  v
     Prep         Cook      Senior Cook     your specialists
   (simple)    (standard)    (complex)     (when the job matches)
       +--- could not finish? ---> Senior Cook (once)
                    |
                    v
          check command -> Taster --defects--> Fixer
```

- **Failover.** Each provider, key and model is a route. A rate-limited route rests until the provider says it may try again and the request goes to the next one; a broken key or retired model is switched off.
- **Small, safe edits.** Cooks change existing files with SEARCH/REPLACE blocks. An edit that does not apply cleanly writes nothing and goes back to the cook to correct.
- **Verified reviews.** A plan can carry a check command (such as `npm test`); its real output goes to the Taster, and a failing check forces a fix.
- **No chat history in prompts.** Each prompt is a small state file (`memory.md`), the files the step needs and a few lessons, which keeps it within free-tier limits.
- **Checkpoints.** Every run is snapshotted in a private git repository (separate from yours), which is what View changes and Undo use.

## Safety at a glance

- The server listens on `localhost` only and refuses other machines and other websites.
- The crew can read and write only inside its folder. Protected folders (`.git`, `.kadhai`, `node_modules`) and links leading outside are refused.
- Commands from the crew wait for your approval by default. **Commands are not sandboxed unless you turn on the optional Docker sandbox**: an approved command runs with your account's permissions.
- Keys, tokens and credentials are encrypted at rest (AES-256-GCM; on Windows the master key is tied to your account).
- Prompts, including the files a step needs, go to the AI providers you add keys for. Add only providers you are comfortable sharing your code with.

The details are in [Safety and privacy](docs/USER-GUIDE.md#15-safety-and-privacy) and [Privacy](docs/PRIVACY.md).

## Limits worth knowing

- Free models make mistakes. Kadhai catches format slips and sends them back to be corrected, and the review and check command catch many logic errors, but not all. Read what the crew wrote.
- One run at a time per folder; further tasks queue. Open another folder in a second kitchen to work on two projects at once.
- Only the most recent run can be undone, and undo needs git.
- Some integrations have only been tested against stand-ins, not real accounts: subscription CLIs as agents, paid providers, the Google connector, and the account-based flow services. The guide says which.

## Feedback

- **Found a bug?** [Open a bug report](https://github.com/Madhuhas/kadhai/issues/new?template=bug_report.yml). Paste the details from **more > about** in Kadhai; they hold no keys.
- **Have an idea?** [Post it in Feature Requests](https://github.com/Madhuhas/kadhai/discussions/new?category=feature-requests), where others can upvote it.
- **Want to help?** [Open for Contribution](https://github.com/Madhuhas/kadhai/discussions/categories/open-for-contribution) lists work anyone may pick up. News goes to [Announcements](https://github.com/Madhuhas/kadhai/discussions/categories/announcements).
- **Found a security problem?** Please do not open an issue: [report it privately](https://github.com/Madhuhas/kadhai/security/advisories/new). See [SECURITY.md](SECURITY.md).

## License

Copyright (C) 2026 Kotini Sai Madhuhas

Kadhai is free software: you can redistribute it and/or modify it under the terms of the [GNU Affero General Public License](LICENSE) as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the license for details.

In plain words: use it, change it and share it freely, on your own computer or anyone else's. If you run a changed version of Kadhai as a service other people use over a network, you must offer them the source code of your version under the same license. Contributions are welcome: contributors sign a short [agreement](CLA.md) once, keep their copyright, and are promised their work will always stay open source (see [CONTRIBUTING.md](CONTRIBUTING.md)).

## Credits

- **Logos** of the services Kadhai connects to are from [Simple Icons](https://simpleicons.org) (CC0). The names and logos are trademarks of their owners and are used only to show which service a connection or node talks to; Kadhai is not affiliated with or endorsed by any of them.
- **Theme palettes** follow [Dracula](https://draculatheme.com), [Nord](https://www.nordtheme.com), [Solarized](https://ethanschoonover.com/solarized/) and the Light and Dark Modern themes of [Visual Studio Code](https://github.com/microsoft/vscode), all MIT licensed. Kadhai uses their colours, not their files.
- **[Express](https://expressjs.com)** (MIT) is the one dependency.
- **The idea of a skills library** came from [wshobson/agents](https://github.com/wshobson/agents) (MIT). Kadhai's built-in skills are written in its own words.
