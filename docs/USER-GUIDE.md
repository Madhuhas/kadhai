# Kadhai user guide

Everything you need to use Kadhai, from installing it to automating work with flows. If you only want to try it, read [Getting started](#2-getting-started) and stop there; come back to the rest when you need it.

**Contents**

1. [What Kadhai is](#1-what-kadhai-is)
2. [Getting started](#2-getting-started)
3. [A tour of the screen](#3-a-tour-of-the-screen)
4. [Giving the crew work](#4-giving-the-crew-work)
5. [The crew](#5-the-crew)
6. [Models and keys](#6-models-and-keys)
7. [Low flame and high flame](#7-low-flame-and-high-flame)
8. [Files, terminal, browser and source control](#8-files-terminal-browser-and-source-control)
9. [Flows: automations on a canvas](#9-flows-automations-on-a-canvas)
10. [Connections and tasks from outside](#10-connections-and-tasks-from-outside)
11. [Kitchens: several projects at once](#11-kitchens-several-projects-at-once)
12. [Memory and lessons](#12-memory-and-lessons)
13. [Themes and appearance](#13-themes-and-appearance)
14. [Using Kadhai from other apps (MCP and ACP)](#14-using-kadhai-from-other-apps-mcp-and-acp)
15. [Safety and privacy](#15-safety-and-privacy)
16. [Settings file (.env)](#16-settings-file-env)
17. [Troubleshooting](#17-troubleshooting)
18. [Glossary](#18-glossary)

---

## 1. What Kadhai is

Kadhai is a workspace that runs on your own computer, where a small crew of AI agents builds software, checks it and automates chores for you. You describe what you want in plain words; the crew plans it, writes the files into a folder on your machine, runs checks, reviews its own work and tells you what it did. You can watch every step, step in, and undo a run.

Three ideas make the rest of this guide easy to follow:

- **The crew.** Six agents named after a kitchen brigade, each with one job: the **Chef** plans, **Prep**, **Cook** and **Senior Cook** write the code (simple, standard and complex steps), the **Taster** checks and reviews, the **Fixer** fixes what the Taster finds. You can hire more.
- **The folder.** The crew works inside one folder on your computer at a time (the *workspace*). It cannot read or write anything outside it.
- **The models.** The agents think with AI models from providers you choose: free ones (Gemini, Groq, Cerebras and more), paid ones, or a subscription you already have (Claude Code, Codex, Gemini CLI). When one provider is busy or out of quota, the next one carries on automatically.

Kadhai is free to run. With free keys only, it costs nothing.

---

## 2. Getting started

### What you need

- A computer running Windows, macOS or Linux. No graphics card is needed; an older laptop is fine.
- **Node.js 20 or newer**, from <https://nodejs.org> (the LTS version is right).
- **Git** (optional, recommended), from <https://git-scm.com>. With it, every run can be shown as a list of changes and undone.

### Install

Open a terminal in the Kadhai folder and run:

```bash
npm install
```

This installs Kadhai's single dependency. It takes a few seconds.

### Try it without an account (demo mode)

```bash
npm run demo
```

Open <http://localhost:4747> in your browser. Demo mode simulates the models, so you can see everything work without a key: type any request in the chat on the right (for example *make a small web page that says hello*), press Enter, and watch the Chef plan, the cooks write files, a command wait for your approval, and the Taster review. The demo even fakes a provider running out of quota now and then, so you can see the crew switch to the next one.

### Start it for real

```bash
npm start
```

Open <http://localhost:4747>. The first time, the **keys** dialog opens by itself. Paste a free key and press Enter; it is checked with the provider and used straight away, no restart.

Free keys, no card required:

| Provider | Get a key |
| --- | --- |
| Google Gemini | <https://aistudio.google.com/apikey> |
| Groq | <https://console.groq.com/keys> |
| Cerebras | <https://cloud.cerebras.ai> |

Add keys from at least two providers if you can. Free tiers are small, and with two or more the crew simply moves to the next provider when one says "slow down".

### Or use the desktop app (Windows, beta)

The desktop app is the same Kadhai in a window of its own, with a Start-menu entry, a taskbar icon and an installer. Run **Kadhai-Beta-Setup** and open **Kadhai Beta** from the Start menu. It needs no Node.js: everything it needs is inside.

- The installer is not signed yet, so Windows may warn about an unknown publisher the first time. Choose *More info*, then *Run anyway*.
- Your keys, settings, crew and flows are kept in `%APPDATA%\Kadhai Beta`, separate from a copy you run with `npm start`. *Help > Show the data folder* opens it (press **Alt** to show the menu).
- Links to other sites, and the preview of what the crew built, open in your normal browser.
- If a run is still going when you close the window, Kadhai asks before stopping it.

To build the installer yourself, see `desktop/README.md`.

### Your first real task

1. In the chat on the right, type what you want, for example: *Make a to-do list web page where I can add and tick off items. Keep it in one HTML file.*
2. Press **Enter**. The Chef writes a plan; you see it as an order ticket in the middle of the screen, with each step and the cook who has it.
3. If a cook wants to run a command (for example to check its code), a card appears in the chat with the exact command. Press **Run** to allow it or **Deny** to refuse. Nothing runs without your OK unless you change that.
4. When the run ends, the Chef's report appears in the chat with three buttons: **View changes** (every file that changed, line by line), **Open preview** (the page, in Kadhai's browser tab) and **Undo this run**.

That is the whole loop. Everything else in this guide is about doing more with it.

### Where your work goes

The crew works in the folder shown at the top of the files panel on the left. At first that is the `workspace` folder inside Kadhai. To work on a project of your own, click **[change]** at the top of the files panel and pick its folder.

---

## 3. A tour of the screen

```
+----------------------------------------------------------------+
| \___/ kadhai  kitchens  crew  (provider)  terminal keys flows .. |
+---------------+--------------------------------+---------------+
| files.dir     | [kitchen.exe] [agent] [file]   | chat.log      |
|  ~/FOLDER     |                                |               |
|  +- src/      |   the run's title and steps    |  you and the  |
|  |  +- app.js |   the kadhai (cooking pot)     |  Chef         |
|  +- index.html|   the crew at their stations   |               |
|               |                                |  [ type here ]|
+---------------+--------------------------------+---------------+
| tokens today, and each model's state                           |
+----------------------------------------------------------------+
```

| Area | What it is for |
| --- | --- |
| **Taskbar** (top) | **kitchens**, the **crew** list, the model in use, **terminal**, **keys**, **flows**, **connect**, the **flame** (low or high), the **lock** (the window layout, see below), and **more** (browser, about, theme, accent colour). |
| **Files** (left) | The folder the crew works in. **+** new file, **+/** new folder, hover a row to rename or delete, drag to move. `[lock]` marks a file an agent is working on right now. Below it, **Source control** for the folder's git repository. |
| **Kitchen** (middle) | The live view of a run: its title, the order ticket (each step, who has it and how it went), the kadhai on its stove, and the crew at their stations below it, with the work flying between them. All drawn in text characters; see [the kitchen](#the-kitchen). |
| **Tabs** (middle) | Next to the kitchen: one tab per agent you open, one for an open file or a diff, and the browser tab. |
| **Chat** (right) | Where you talk to the Chef, approve commands, read run reports and attach files. |
| **Usage bar** (bottom) | Tokens used today, and each model's state: in use, ready, cooling down after a rate limit (with a countdown), or off. Click a model for details. |

On a phone the taskbar keeps only **kitchens**, **crew**, the flame and **more**; terminal, keys, flows, connect, providers and the layout lock are inside **more**.

Keyboard shortcuts: `Enter` send, `Shift+Enter` new line, `Ctrl+K` jump to the chat box, `Ctrl+S` save the file being edited, `` Ctrl+` `` open the terminal, `Esc` close a dialog or menu, or bring a full-screen window back to its normal size.

### Resizing windows and full screen

The layout starts **locked**: the three windows keep their usual sizes. Click the **lock** in the taskbar to unlock it (its shackle lifts). Then:

- **Resize.** Drag the inner edge of the files window (its right edge) or the chat window (its left edge); the stage takes the rest. You can also click an edge and use the arrow keys. Double-click an edge, or press `Home` on it, for that window's usual width. The stage always keeps enough room for the kitchen.
- **Full screen.** Press `[]` in a window's title bar, or double-click the title bar, to have the files, stage, chat or flows window fill the screen. Press `][`, double-click again, or `Esc` to bring it back.

Your layout is remembered in this browser. Click the lock again to lock it: every window goes back to its usual size. On narrow screens (under 860 px wide) the windows cannot be resized, but full screen still works.

### The kitchen

The middle of the screen is the kitchen, drawn in text: the kadhai (the cooking pot) on its stove at the top, and below it the whole crew, each at a station of their own with their name and what they are doing. The row wraps, so however many agents you hire, they all fit. **+ hire a specialist** under the crew adds one.

- **The kadhai** is still while nothing is happening. While the crew cooks, it turns slowly, the oil ripples and bubbles, the fire burns and steam rises. Drag it with the mouse to spin it.
- **The cooks** are 3D too, each with its own hat, head and tool and its coat in its own colour. They look towards your mouse, wave when you point at one and jump when they are handed a step. While they work, the cooks walk up to the kadhai, stir, and walk back.
- **You can watch the work move.** When the Chef has a plan, a ticket (`[#1]`) flies from the Chef's station to each cook as its step starts. When the step is done, the dish (`(###)`) flies to the Taster. If the review sends something back to be fixed, the Taster says *Sent back!* and the ticket flies back to the cook.
- **After a run**, everyone cheers; if it failed, the cooks whose step failed slump with `[!]`. After a while with nothing to do, the crew doze off (`zZ`).
- **Click a cook** and it answers you; **click it again** while it is talking (or press Enter on it) to open its tab: what it is thinking (live), its calls and tokens, what it has learned in this folder, and controls to leave it a note, pause it, swap its provider or stop the run.
- **To remove a specialist you hired**, open it (click its station twice, or pick it in the crew list) and press **Remove** beside *Edit agent*. The house crew cannot be removed.

If your system is set to reduce motion, everything is drawn once and stays still.

---

## 4. Giving the crew work

### Asking

Type in the chat and press Enter. Write it the way you would brief a colleague: what you want, any constraints (*one file*, *no frameworks*, *use the existing style*), and how you will know it is done. The Chef either answers directly (for a question) or plans the work.

You can also ask about earlier work in plain words: *What did we do yesterday?*, *Who wrote the footer, and on which model?*, *What went wrong last week?* See [Memory and lessons](#12-memory-and-lessons).

### Attaching files

Press **+ attach**, or drop or paste files on the chat box. Up to 5 files of 2 MB each are saved into the folder under `attachments/` (never over an existing file) and shown to the Chef with your message. Text files are read; images and other binary files are only saved and named, because most free models read text only.

### While it runs

- **The queue.** A task sent while the crew is busy waits just above the chat box and starts when the crew is free, in the order you sent them. Up to ten can wait; each can be removed.
- **Commands wait for you.** When a cook wants to run a command, a card shows the exact command with **Run**, **Deny** and **Always run**. Read it before you allow it (see [Safety](#15-safety-and-privacy)). The dropdown next to the chat box switches between *Ask before commands* (the default), *Run commands freely* and *No commands*.
- **Step in.** Open an agent's tab to leave it a note it must follow on its next step, pause it, or swap it to another provider. **Stop** in the chat ends the run.

### When it finishes

The Chef's report lists each step and how it went, the files changed, the result of the check command, and the review. Then:

- **View changes** shows every changed file as a diff.
- **Open preview** opens a web page the run made, in the browser tab.
- **Undo this run** puts every file back as it was before the run (including edits you made afterwards). Undo needs git installed, and only the most recent run can be undone.

### Running a command yourself

Start a line in the chat with `!` (for example `!npm test`) to run it in the folder, or use the **terminal**. Your own commands run straight away; only the crew's wait for approval.

---

## 5. The crew

| Agent | Job |
| --- | --- |
| **Chef** | Turns your request into a plan of small, separate steps, and answers questions |
| **Prep** | Cooks the simple steps, trying lighter models first to spare your best quota |
| **Cook** | Cooks the standard steps |
| **Senior Cook** | Cooks the complex steps, and takes over any step another cook could not finish |
| **Taster** | Runs the check command and reviews every changed file |
| **Fixer** | Fixes whatever the Taster sends back |

Agents never talk to each other directly and never see chat history; plain code passes the work between them, and every step has a fixed limit on how many model calls it may make. That keeps runs predictable and cheap.

### Switching agents off

You do not always need the whole crew. Open **crew** in the taskbar and press **on** beside an agent to switch it **off**, or open the agent and press **Switch off**. Press it again to switch it back on. The crew badge then shows how many are on (for example *4/6*), and a switched-off cook stands faded in the kitchen. Your choice is kept when Kadhai restarts.

- **A cook that is off** (Prep, Cook, Senior Cook or Fixer) gets no work: its steps go to the nearest cook that is on, moving up the line first (Prep, Cook, Senior Cook, Fixer). At least one cook always stays on.
- **The Taster off** means no review: runs make fewer model calls and finish sooner. The plan's check command still runs, because it costs no model call, and the run report says the review was skipped.
- **A specialist that is off** is not offered to the Chef, so it gets no steps until you switch it on.
- **The Chef** plans every run, so it cannot be switched off.

### Hiring your own agents

Open **crew** in the taskbar and click **+ hire a specialist**. A specialist is an extra cook with your own instructions. You give it:

- a **name** (it gets its own drawn figure and colour),
- one line saying what it is **good at**. The Chef reads only this line to decide when to give it a step, so be specific (*CSS layout and visual polish for phones*, not *frontend expert*),
- optional **instructions** on how it should work (*Always use CSS variables. Mobile first.*),
- a colour, a model and skills, as for any agent.

**Not sure what to write?** Type a few words into **Generate with AI** at the top of the form (*someone who writes tests for my Node code*) and press **Generate**. The Chef fills in the name, the *good at* line and the instructions, and ticks the skills that fit. Nothing is hired until you read it and press **Hire**.

Up to eight specialists can be hired. If one cannot finish a step, the Senior Cook takes it over.

### Tuning any agent

Open an agent and click **Edit agent**. For house agents the name and job stay fixed; for every agent you can set:

- **Colour.** A slider through the hues; **Reset** goes back to its usual one.
- **Model.** Its usual order, best available first, lighter models first, or *start with* one particular model. That model is tried first on every call; if it is rate-limited or off, the normal order takes over, so the agent never gets stuck.
- **Skills.** Short packs of working advice from the skills library (clean code, testing, accessible HTML, security and more). An agent can load up to five; each one is added to every prompt it sends, so on free keys load only what it really needs.
- **Connections** (cooks only). Which connected services this agent may use. The default is all of them, including ones you add later.

### Skills

The skills library has fourteen built-in skills. To write your own, click **+ new skill** beside the skills list in any agent's edit dialog: a name, one line saying what it is for, and the advice, most important first. To borrow one, pick from the hand-checked gallery or paste a link to a `SKILL.md` (on GitHub, for example) in *Start from a link*; long ones are condensed by the Chef. Your own skills are saved in `skills.local/`.

---

## 6. Models and keys

Open **keys** in the taskbar. The providers you use come first, each with its keys (only ever shown masked) and its models.

### Free providers

Gemini, Groq and Cerebras are the main free providers. Under *More free providers* you will find Mistral, OpenRouter, NVIDIA NIM, SambaNova, Hugging Face, Cohere and Z.ai. Things to know:

- Several keys for the same provider are fine; each adds its own quota.
- Free model line-ups change often. **Browse models** on a provider's card fetches what it offers right now; click to add or remove models. If a model is retired, Kadhai switches its route off and moves on.
- Your prompts and code go to the providers you add keys for. Add only the ones you are comfortable sending your code to.
- Most of the extra providers were checked to exist and to reject a wrong key, but have not been used with a real key yet. Groq has been used end to end.

### Paid keys

Paste any key in the box at the top of **keys**. Keys that say whose they are (`sk-ant-` Claude, `sk-proj-` OpenAI, `xai-` xAI, `gsk_` Groq, `AIza` Gemini, `sk-or-` OpenRouter) go to their provider by themselves.

- **Claude** is spoken to natively. **OpenAI**, **xAI** and **DeepSeek** start with no models chosen; add the key, then **Browse models**.
- **Use paid models first** (the default) or **only when the free ones run out**.
- **Daily limit (tokens)** caps all paid models together. When it is reached they rest until tomorrow and the free ones carry on.
- Kadhai cannot see prices or your balance; the limit is in tokens, not money. Check your provider's dashboard for what was charged.
- To send only one agent to a paid model, set that agent's model under *Edit agent*.

### Subscriptions you already pay for

If you use **Claude Code**, **Codex CLI** or **Gemini CLI**, install it, sign in to it once in a terminal (`claude auth login`, `codex login`, or run `gemini`), then switch it on under **keys**. Kadhai uses your plan's limits first and falls back to your API keys when they run out. On low flame the CLI only answers questions, with its own tools off, in an empty temporary folder; it never touches your project directly.

Using a subscription this way is subject to its vendor's terms, and those change. Each card in **keys** says what the vendor's terms said when this version of Kadhai was made, with a link to read them now. Google's terms for Gemini CLI warn against using it through other tools (Kadhai asks before switching it on); for Gemini, a free Gemini API key is the safe choice.

### Your own server, or a model on this computer

Any server that speaks the OpenAI chat format (Ollama, LM Studio, a company gateway) can be added by name and address. An `http://localhost` address needs no key and is not counted as paid.

### What happens when a model is busy

Each provider, key and model together is a *route*. When a route answers "too many requests", it rests until the provider says it may try again and the same request goes to the next route; a broken key or a retired model is switched off. You see this in the usage bar. Only when every route is out does the run stop, saying when the next slot opens. The files written so far are kept.

---

## 7. Low flame and high flame

The **flame** in the taskbar sets how much the crew may use per call. Any key works on either.

| | Low flame (default) | High flame |
| --- | --- | --- |
| Made for | free keys (about 8,000 tokens a minute) | paid keys and subscriptions |
| Skills per agent | 3, first 900 characters each | 5, first 3,000 characters each |
| File context per step | 24k characters | 80k characters |
| Answer length | 4k tokens | 16k tokens |
| Review rounds | 1 | 2 |
| Steps at the same time | 1 | up to 3 (different cooks, different files) |
| Extra security review | no | yes, for changes touching sign-in, passwords, payments or personal data |
| Subscription CLIs | answer as models | can work as agents on a copy of your folder |
| Model order | as listed | paid and subscription models first |

Every number is still a hard limit on both flames.

**CLI agents (high flame).** A step can be done by a subscription CLI working with its own tools, on a temporary copy of your folder. Each changed file comes back into your folder through Kadhai, under that cook's name, so it can be reviewed and undone like any other change. By default only Claude Code acts this way, with its shell switched off. Tick **agents run commands** beside the chat box to let CLI agents run their own commands for one task; those commands do not wait for your approval and are not sandboxed, so use it only when you trust the task.

---

## 8. Files, terminal, browser and source control

### Files

Open a file to see it with syntax highlighting; **Edit** and **Save** (`Ctrl+S`) change it. `.js` and `.py` files have **Run**, `.html` files have **Preview**.

### Changing folder

Click **[change]** at the top of the files panel to open any folder on your computer: browse to it, paste a path, or create a new one. Kadhai adds a `memory.md` file and a hidden `.kadhai` folder to it; if it is a git project, add both to `.gitignore`. Chat history, undo and memory belong to the folder; your keys and hired agents stay with you.

### Terminal

**terminal** in the taskbar (or `` Ctrl+` ``) opens a terminal in the folder. Type a command and see its output; `cd` moves between sub-folders, the up arrow recalls earlier commands, Tab completes file names. Dev servers keep running: a command ending in ` &`, or a known one such as `npm run dev` or `vite`, has no time limit, and when it prints a local address the browser tab opens it. It runs one command at a time and shows its output; programs that wait for you to type (or full-screen ones like vim) do not work there.

### Browser

**more -> browser** opens a tab showing a page on this computer: the folder's preview, or a dev server (type `3000` or `localhost:5173`). Pages from the folder reload when files change. A page's errors appear above it with **Fix this**, which sends them to the Chef as a task.

### Source control

Under the files panel: the folder's own git repository. See what changed, click a file for its diff, stage and unstage, discard a change, write a message and **Commit**, switch or create branches, **Pull** and **Push**. If the folder is not a repository yet, one click creates one. This uses your installed git with your own name and sign-in, and never adds commits by itself. Discard, switching branch and pull are refused while a run is in progress.

---

## 9. Flows: automations on a canvas

A flow is an automation you draw: something that starts it, then steps joined by wires. Data travels along the wires, and any setting can use it. Open **flows** in the taskbar.

```
[ Start: every morning at 8 ]--->[ Weather: Hyderabad ]--->[ AI: write a note ]--->[ Telegram: send ]
```

### The easy way: describe it

Press **+ describe a flow** and say what should happen, for example *Every morning at 8, get the weather for Hyderabad and the dollar to rupee rate, write me a short note and send it to my Telegram.* The Chef draws it and it opens on the canvas, unsaved.

- Steps you should look at are marked **[!] check**: a credential to choose, a chat id to fill in, an address or a command. Click one to see why, and press **Done** when it is right.
- The Chef never chooses a credential for you and never writes Code steps.
- If something cannot be done with Kadhai's steps (there is no WhatsApp step, for example), it draws what it can and tells you what is missing.

### Change it, fix it

- **Change it in words**, in a flow's settings: *also send it to my phone*, *only on weekdays at 7:30*, *stop writing the file*. Only what you asked about changes; everything else keeps its place, credentials and settings. Changed steps are marked, nothing is saved until you press Save, and `Ctrl+Z` undoes it.
- **Fix it** appears when a run stops at a failed step. The Chef sees the step, its error and what it received, and changes the flow so that it works. If the fix needs something only you know, it leaves that empty and asks you.

### Try it before you trust it

- **Try once** (next to Create) runs the flow as drawn without doing anything you could regret. Steps that only read or think run for real (weather, feeds, searches, reading a file, AI steps). Steps that would send, write, change, run a command or wait are **held back**, and show what they would have done, with the real data filled in.
- **In words**, at the top of a flow's settings, describes the flow step by step and says how many model calls each run makes.

### Drawing by hand

- Drag a step in from the left, or press **Tab** on the canvas to search every step by name.
- Drag from a step's output port to another step to wire them; drag onto empty canvas to add a step already wired in.
- **Shift+drag** selects several; **Ctrl+Z / Ctrl+Shift+Z** undo and redo; **Ctrl+C / Ctrl+V** copy and paste steps; **D** switches steps off; **Delete** removes; **Ctrl+S** saves.
- Pasting a `curl` command onto the canvas makes an HTTP step of it.
- Every mouse action has a keyboard alternative, including wiring (the *wire to...* picker in a step's settings).

### Seeing the data

Double-click a step for the large view: what it received on the left, its settings in the middle, what it produced on the right. Drag a field from the left onto a setting and it becomes an expression such as `{{ input.title }}`. **Test step** runs just that step. **Pin** keeps a step's output so it is not run again while you build what comes after (only for runs you start by hand). The **runs** tab shows the last 15 runs; click one to see it on the canvas.

**Expressions.** `{{ input }}` is what arrived, `{{ input.items[0].url }}` a field of it, `{{ trigger.text }}` what started the flow, `{{ node('Fetch issues').body }}` another step's output by name, `{{ now }}` and `{{ today }}` the time. Expressions are paths, never code.

### What can start a flow

| Start | |
| --- | --- |
| By hand, every N minutes, or at a time of day | at least 5 minutes apart |
| A webhook | a program on this computer posts JSON to it |
| A GitHub, Linear or Telegram trigger | set up under **connect** |
| A new item in an RSS feed, a subreddit, a GitHub repository or a Hacker News search | checked every few minutes; each new item starts the flow once |
| An address answers something new | checked every few minutes |
| A file in the folder changes | changes made by flows themselves never count |

### The steps

| Step | What it does | Uses a model? |
| --- | --- | --- |
| Agent | A task for the crew, planned and reviewed like one typed in the chat | yes, a full run |
| AI | One answer: summarise, classify, translate, or pull out fields | yes, one call |
| If, Switch, Filter | Compare a field with a value and choose a branch, or stop | no |
| Merge | Wait for every wire into it and combine what arrived | no |
| Edit fields | Build an object from fields | no |
| Code | A few lines of JavaScript you write | no |
| Wait | A pause, up to an hour | no |
| HTTP request | Call any web API; paste a curl command or import an OpenAPI description | no |
| Services | Telegram, Discord, Slack, ntfy, email (Resend), GitHub, Notion, Todoist, Trello, RSS, Reddit, Hacker News, Wikipedia, weather, currency | no |
| App | One action of a connected service | no |
| Run a flow | Run another of your flows and use its result | no |
| File | Read, write or add to a file in the folder | no |
| Command | Run a command in the folder (waits for your OK in "ask" mode) | no |

Every step can be switched off, retried up to three times, or told to carry on after an error. A flow can name another flow to run if it fails. Flows can be tagged, searched, duplicated, exported to a file and imported.

**Credentials** (bot tokens, webhook addresses, API keys) are kept apart from flows, encrypted, never sent back to the browser, and can be tested under **more... -> Credentials**. Exported flows leave them out.

### Good to know

- A flow can branch but never loop, and holds at most eight Agent and AI steps, so the model calls it can make are fixed by its drawing.
- A flow runs only while Kadhai is open; missed schedules are not caught up.
- Some settings never take data from the flow: web addresses and headers, commands, file names, repositories and recipients. Text arriving from outside can only fill in the parts meant for data.
- App and service steps act without asking each time; choose actions that are safe to repeat.
- The Code step runs your JavaScript in a separate worker with a 5-second and 64 MB limit. That contains mistakes; it is not protection against hostile code, so only use code you wrote or trust.
- The keyless services (ntfy, RSS, Reddit, Hacker News, Wikipedia, weather, currency) were used for real; the services that need an account were checked to exist and to reject a wrong key, but have not been used with a real account yet.

---

## 10. Connections and tasks from outside

### Connections

**connect** opens a catalog of about fifty services the crew can use while it works: web search, a browser, GitHub, Notion, Linear, Slack, databases and more. Press **Connect** on a card. Some run on this computer, some need no account, some ask for a key, some open the service's sign-in page.

- The Chef tells each step which connections it may use (at most three on low flame), so a connection nobody needs costs almost nothing.
- Anything a cook reads through a connection becomes part of its prompt and is sent to the AI provider in use.
- Each connection is a program running with your permissions, and some can change things (create issues, write to a database). There is no approval step for tool calls, so connect only what you trust.
- **Manage** on a connected card lets you switch it off, disconnect it, or keep it for certain cooks only (*Who may use it*).
- Not in the catalog? **Add a custom MCP server** at the bottom: a name and the command that starts it. Its settings (tokens) are stored encrypted.

**Google.** The Google card lets the cooks search your Drive, read Docs and Sheets, search and read Gmail and list Calendar events. It is read-only and you choose which parts. It needs your own free Google sign-in keys (about ten minutes, once); the dialog walks you through it. This has been tested against a stand-in for Google, not yet with a real account.

### Starting tasks from outside

Under **connect -> Start tasks from outside**:

- **Your own webhook.** Kadhai makes an address and a token (shown once). A program on this computer posts `{"text": "what to do"}` with the token to start a task.
- **GitHub issues.** An open issue that carries your label (default `kadhai`) becomes a task, once.
- **Linear issues.** The same with a Linear label.
- **Telegram bot.** A message to your bot from a chat you allowed becomes a task, and the report is sent back.

Nothing on the internet can call Kadhai: these services are checked once a minute from your computer. A task that arrives this way is treated as untrusted text: it queues like any other, and its commands still wait for your OK.

---

## 11. Kitchens: several projects at once

Click **kitchens** in the taskbar and **+ new kitchen** to open another folder in its own window, with its own crew, chat, memory, flows and triggers, running at the same time as the first.

- Kitchens share your keys, subscriptions, skills and connections.
- A folder can be open in only one kitchen, so two crews never write over each other.
- Kitchens come back when you start Kadhai again. Each is a full copy of Kadhai (about 70 MB of memory), up to four extra.
- Two kitchens working at once use your free quota twice as fast.

---

## 12. Memory and lessons

Kadhai remembers what was done in each folder, in plain files inside its hidden `.kadhai` folder:

- **The journal** has one entry per finished run: what you asked, the plan, which agent cooked each step on which model, the files changed, the commands run and the review. Ask about it in the chat (*what did we do yesterday?*); looking it up costs one extra call, only when you ask.
- **Lessons** are short facts the crew learned in this folder (*tests run with node --test*), from reviews and from failed steps. A few are added to each agent's prompts. Each agent's tab lists what it has learned; press **x** beside a lesson that is wrong.

Agents still never see your chat history. Lessons are capped at a few short lines per prompt, which is why this stays affordable on free keys.

---

## 13. Themes and appearance

**more -> Theme** offers nine themes. Each changes more than colour: typefaces, shapes, window style, background and effects. The kitchen takes deeper colours on light themes and brighter ones on dark themes, and the kadhai is shaded with each theme's own characters.

| Theme | Character |
| --- | --- |
| Light (default) | A small retro desktop: grey windows, one monospaced font |
| Normal light | An ordinary modern app: rounded cards, standard fonts |
| Solarized light | Warm paper with serif headings |
| Dark | Like VS Code's dark theme |
| Dracula | Dark purple-grey, rounded, pill-shaped tabs |
| Nord | Soft arctic blues, frosted taskbar, pill buttons |
| Cyberpunk | A neon heads-up display: glowing grid, cut corners, capital titles, a glitch now and then |
| Amber CRT | An old amber terminal: `[ BRACKETED ]` buttons, scanlines, a power-on effect |
| High contrast | Bigger, bolder text, thick frames and focus rings |

**Accent colour** (under more) changes the main highlight colour in any theme; double-click it to reset. Fonts come from your computer, so Kadhai works offline; if a theme's font is not installed, a similar one is used. In every theme, body text, secondary text, buttons and the terminal meet the WCAG AA contrast level (4.5:1), and effects stop when your system asks to reduce motion.

---

## 14. Using Kadhai from other apps (MCP and ACP)

### As an MCP server

Other AI tools (Claude Desktop, Claude Code, Cursor) can use the crew and the folder through MCP. Tools offered: `kadhai_run_task`, `workspace_list_files`, `workspace_read_file`, `workspace_write_file`, `workspace_delete_file`, `workspace_run_command`, `memory_read`, `locks_list`, `providers_status`.

Over stdio, add to the tool's MCP settings:

```json
{
  "mcpServers": {
    "kadhai": { "command": "node", "args": ["C:/path/to/Kadhai/bin/mcp-server.js"] }
  }
}
```

With Claude Code: `claude mcp add kadhai -- node C:/path/to/Kadhai/bin/mcp-server.js`. Add `"--workspace", "C:/some/folder"` to point it at another folder.

While `npm start` is running, the same tools are also served at `http://localhost:4747/mcp`, and tasks started that way appear live in the dashboard. The stdio server has no dashboard for approvals, so commands only run there with `EXEC_MODE=auto`.

### As an ACP agent (editors)

Editors that speak ACP, such as Zed, can use the crew in their own agent panel, on the project folder they have open:

```json
{
  "agent_servers": {
    "Kadhai": { "command": "node", "args": ["C:/path/to/Kadhai/bin/acp-agent.js"] }
  }
}
```

In this mode the workspace is your real project. Kadhai adds `memory.md` and `.kadhai/` there (add both to `.gitignore`) and writes files straight to disk, so save open buffers first.

---

## 15. Safety and privacy

### What stays on your computer

- Kadhai listens only on your own computer (`localhost`), and refuses requests from any other machine and from other websites.
- Your files never leave the folder except as part of prompts: the files a step needs are sent to the AI provider handling that call. Add keys only for providers you are comfortable sending your code to.
- Keys, tokens, connection settings and flow credentials are encrypted before they are saved. On Windows the master key is tied to your Windows account; elsewhere it is a file only you can read. A program already running as you could still read them. Deleting `secret.local.key` makes every saved secret unreadable, and you would add your keys again.

### Running code

The crew can run commands it writes, such as tests. By default each one waits for your OK.

| Command mode | The crew's commands | Your own commands |
| --- | --- | --- |
| Ask (default) | wait for your OK | run straight away |
| Run freely | run straight away | run straight away |
| No commands | refused | refused |

- Commands start in the folder, are stopped after a time limit (or when you press Kill or stop the run), and never receive your API keys.
- A short blocklist refuses obviously destructive commands, but it is easy to get around. **Without the Docker option, commands are not sandboxed**: they run with your account's permissions and can reach anything you can. Read commands before you approve them.
- **Docker sandbox (optional).** Set `EXEC_SANDBOX=docker` in `.env` and every command runs in a throwaway container that sees only the folder and has no network. If Docker is not running, commands are refused rather than run on your machine. Docker Desktop itself needs a few GB of memory.

### Pages the crew makes

Generated web pages are served on a separate port (`http://localhost:4748`), so their scripts cannot reach Kadhai's controls. Files are only served from inside the folder, never through a link that leads elsewhere.

---

## 16. Settings file (.env)

Keys and models are easiest to manage in the dashboard. Everything else can go in a `.env` file in the Kadhai folder; copy `.env.example` to `.env` and uncomment what you need.

| Setting | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4747` | Dashboard port (the preview uses the next one) |
| `WORKSPACE_DIR` | `./workspace` | Folder used at first start; after that, the folder you open is remembered |
| `GEMINI_API_KEYS`, `GROQ_API_KEYS`, ... | | Keys, comma-separated, if you prefer a file |
| `PROVIDER_ORDER` | `gemini,groq,cerebras,...` | Which providers are tried first |
| `MAX_SUBTASKS` | `6` | Most steps in a plan (low flame) |
| `MAX_REVIEW_ROUNDS` | `1` | Review and fix rounds; `0` switches the review off |
| `MAX_OUTPUT_TOKENS` | `4096` | Longest answer per call (low flame) |
| `FILE_CONTEXT_CHARS` | `24000` | File content per prompt (low flame) |
| `EXEC_MODE` | `ask` | `ask`, `auto` or `off` |
| `EXEC_TIMEOUT_MS` | `60000` | Time limit per command |
| `EXEC_SANDBOX` | (none) | `docker` runs commands in a container |
| `KADHAI_MOCK` | | `1` starts in demo mode |

Numbers you raise here are kept on both flames.

---

## 17. Troubleshooting

**"Kadhai is not answering. Is it still running?"**
The server was stopped (the terminal was closed, or the computer slept). Start it again with `npm start`; the page reconnects by itself.

**Port 4747 is already in use.**
Another copy of Kadhai (or another program) is using it. Close it, or start with another port: set `PORT=4800` in `.env`.

**Every model is "cooling down" and the run stopped.**
The free quotas are used up for now. The message says when the next slot opens. Adding a key from a second provider helps most; high flame uses quota faster than low flame.

**A model shows as off with "model retired".**
The provider removed that model. Open **keys**, then **Browse models** on that provider and pick a current one.

**The crew is waiting and nothing happens.**
Look for a command card in the chat: it is waiting for your **Run** or **Deny**. An unanswered command is refused after five minutes.

**Undo this run is missing or fails.**
Undo needs git on your PATH, and only the most recent run can be undone.

**A connection keeps asking me to sign in, or opens a browser tab each start.**
If you start a sign-in and do not finish it, Kadhai stops starting that connection by itself; its card shows **Sign in** for when you are ready. Disconnect it if you do not want it.

**The kitchen looks different on another computer.**
Themes use fonts installed on your computer; where one is missing, a similar font is used.

**Something went wrong on this page.**
Reload the page. If it keeps happening, open **more -> about**, press **Copy details** and include that in your report; it contains no keys or tokens.

---

## 18. Glossary

| Word | Meaning |
| --- | --- |
| **Workspace** | The folder the crew works in |
| **Run** | One request carried out from plan to report |
| **Step** (sub-task) | One part of a plan, done by one cook |
| **Route** | A provider, key and model together; the unit the crew fails over between |
| **Flame** | How much the crew may use per call: low (free keys) or high (paid) |
| **Check command** | A command the Chef attaches to a plan (such as `npm test`), run before the review |
| **Checkpoint** | A private snapshot of the folder before and after a run, used for View changes and Undo |
| **Skill** | A short pack of working advice added to an agent's prompts |
| **Connection** | A service the crew can use (an MCP server or Google) |
| **Flow** | An automation drawn on the canvas |
| **Credential** | A secret a flow step uses (a token, a key), stored encrypted |
| **Kitchen** | Another folder open in its own window and its own copy of Kadhai |
| **MCP / ACP** | Standard protocols that let other AI tools and editors use Kadhai |
