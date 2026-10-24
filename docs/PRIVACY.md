# Privacy

Kadhai runs on your computer. It has no account, no server of its own and no telemetry: the people who make Kadhai receive nothing about you, your code or how you use it. This page lists everything that does leave your computer, and when.

## What leaves your computer

Nothing is sent until you set something up. Each item below happens only because you did the thing in its first column.

| When you... | What is sent | To whom |
| --- | --- | --- |
| Add an API key | One small request to check the key works and to list its models | That provider |
| Give the crew a task | Each step's prompt: the instructions, the short `memory.md`, the files that step needs, a few lessons from earlier runs and the agent's skills | The AI provider handling that call (the next one on your list if one is busy) |
| Switch on a subscription CLI (Claude Code, Codex CLI, Gemini CLI) | The same prompts, through that program | That program's vendor, under your own account with them |
| Connect a service (GitHub, Google, Notion and others) | Whatever the crew or a flow asks that service for, using the access you granted | That service |
| Run a flow | The requests its nodes make | The services and addresses in the flow |
| Set up a trigger | Regular checks for new items, from your computer outwards | GitHub, Linear or Telegram, as you chose |
| Import a skill from a link | One download of that page | The site in the link |
| Add a connection from the catalog that runs locally | A download of its package | The npm registry |

**Choose your providers with care.** A provider receives the code a step needs. Some free tiers may use what you send to improve their models; read each provider's terms before adding a key, and add only providers you are comfortable sharing your code with. A model on your own computer (Ollama, LM Studio) keeps everything local.

## What stays on your computer

- **Your folder.** The crew reads and writes only inside the folder you open. Nothing from it is sent anywhere except as part of a prompt, as above.
- **Keys, tokens and credentials**, encrypted before they are saved (AES-256-GCM). On Windows the master key is tied to your Windows account; elsewhere it is a file only you can read. A program already running as you could still read them.
- **History**: the chat, the run list and daily usage (`.kadhai/state.json`), the run journal and lessons (`.kadhai/journal.jsonl`, `.kadhai/lessons.json`), and snapshots for undo (`.kadhai/git`), all inside the folder.
- **Settings**: your agents, flows, triggers and connections, in files in Kadhai's own folder.

Deleting the `.kadhai` folder inside a project removes its history and undo snapshots. Deleting Kadhai's folder removes everything else.

## The dashboard

The dashboard is served from your own computer (`localhost`) and refuses requests from other machines and other websites. It loads no fonts, scripts or images from the internet. Pages the crew builds are shown on a separate port, so their scripts cannot reach Kadhai's controls.

## The website

The Kadhai website is a plain page with no analytics, no cookies and no third-party fonts or scripts.

## Questions

Kadhai's behaviour is all in its source code, which you can read. For the details of each safety setting, see [Safety and privacy](USER-GUIDE.md#15-safety-and-privacy) in the user guide.
