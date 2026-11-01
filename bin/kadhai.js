#!/usr/bin/env node
// Kadhai in the terminal.
//   kadhai                      a prompt in this folder: type what to build, /help for the rest
//   kadhai "add a dark mode"    one task, then exit (0 done, 1 not done, 2 could not run)
// It joins a Kadhai that already has the folder open (the dashboard), or runs a crew of its own.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { connect } from '../src/cli/client.js';
import { colours, createRenderer, markdownLite } from '../src/cli/render.js';
import { renderDiffText } from '../src/cli/diff.js';

delete process.env.ELECTRON_RUN_AS_NODE;

const HELP = `kadhai - a crew of AI agents for the folder you are in

  kadhai                      start a prompt here (type what to build; /help inside)
  kadhai "task"               do one task and exit
  kadhai "task" -a file.pdf   attach files (PDF, Word, images...; -a again for more)

options
  -C, --dir <folder>   work in another folder (default: this one)
  --flame low|high     low saves tokens (default), high gives better results
  -y, --yes            run the crew's commands without asking (only in a folder you trust)
  -v, --verbose        show the agents' thinking and every command's output
  --demo               simulated models, no keys needed
  --local              never join a running Kadhai: run a crew of this command's own
  --no-color           plain text
  -h, --help           this help
  --version            the version

If the dashboard already has this folder open, kadhai joins it: you see the same crew,
and the dashboard sees what you ask here.`;

const COMMANDS = `/help              this list
/status            models, flame, what is running
/crew              the agents and what each is doing
/flame low|high    change the flame
/attach <file>     attach a file to your next message
/diff              what the last run changed
/undo              undo the last run
/stop              stop the run in progress
/quit              leave (Ctrl+D too)`;

// ------------------------------------------------------------ arguments

function parse(argv) {
  const opts = { attach: [], text: [], dir: process.cwd(), color: process.stdout.isTTY && !process.env.NO_COLOR };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--version') opts.version = true;
    else if (a === '-a' || a === '--attach') opts.attach.push(next());
    else if (a === '-C' || a === '--dir') opts.dir = path.resolve(next());
    else if (a === '--flame') opts.flame = next();
    else if (a === '-y' || a === '--yes') opts.yes = true;
    else if (a === '-v' || a === '--verbose') opts.verbose = true;
    else if (a === '--demo') opts.demo = true;
    else if (a === '--local') opts.local = true;
    else if (a === '--no-color') opts.color = false;
    else if (a.startsWith('-') && a.length > 1) throw new Error(`unknown option ${a} (kadhai --help)`);
    else opts.text.push(a);
  }
  if (opts.flame && !['low', 'high'].includes(opts.flame)) throw new Error('--flame is low or high');
  return opts;
}

// ------------------------------------------------------------ the session

async function main() {
  let opts;
  try {
    opts = parse(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`kadhai: ${err.message}\n`);
    return 2;
  }
  const c = colours(opts.color);
  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (opts.version) {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  if (!fs.existsSync(opts.dir) || !fs.statSync(opts.dir).isDirectory()) {
    process.stderr.write(`kadhai: ${opts.dir} is not a folder\n`);
    return 2;
  }

  let client;
  try {
    client = await connect(opts.dir, { mock: opts.demo, flame: opts.flame, local: opts.local });
  } catch (err) {
    process.stderr.write(`kadhai: ${err.message}\n`);
    return 2;
  }
  if (client.mode === 'remote' && opts.flame) await client.setFlame(opts.flame).catch(() => {});

  const interactive = opts.text.length === 0;
  const tty = Boolean(process.stdin.isTTY);
  let rl = null;
  let pending = null; // a question waiting for the next line: { resolve }
  const approvals = new Map(); // exec request id -> its prompt (cancelled when answered elsewhere)
  let mine = null; // the one-shot task's run id
  let finished = null;
  const done = new Promise((resolve) => (finished = resolve));
  let lastRun = null;

  /** Print without tearing the prompt line in two. */
  const out = (text) => {
    if (rl && tty) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    }
    process.stdout.write(text);
    if (rl && tty && text.endsWith('\n')) rl.prompt(true);
  };
  const say = (text) => out(`${text}\n`);

  /** A question answered by the next line typed (the prompt keeps working for everything else). */
  const ask = (question) =>
    new Promise((resolve) => {
      if (!tty && !rl) return resolve(null);
      if (!rl) {
        const once = readline.createInterface({ input: process.stdin, output: process.stdout });
        once.question(question, (answer) => {
          once.close();
          resolve(answer);
        });
        return;
      }
      pending = { resolve };
      rl.setPrompt(question);
      rl.prompt();
    });

  // The snapshot lists the agents; here they are kept by id, as the dashboard keeps them.
  const snapshot = async () => {
    const s = await client.state();
    return { ...s, agents: Array.isArray(s.agents) ? Object.fromEntries(s.agents.map(({ thought, ...a }) => [a.id, a])) : (s.agents ?? {}) };
  };
  let state = await snapshot().catch(() => ({ agents: {} }));
  const nameOf = (id) => state.agents?.[id]?.name ?? id;

  async function answerApproval(request) {
    const who = request.owner === 'user' ? 'you' : nameOf(request.owner);
    if (opts.yes) {
      say(c.dim(`    allowed (--yes): ${request.command}`));
      return client.approve(request.id, true).catch(() => {});
    }
    if (!tty) {
      say(c.yellow(`    [!] ${who} wants to run: ${request.command}`));
      // Joined to the dashboard, it can be approved there; a crew of our own has nobody else to ask.
      if (client.mode === 'remote') return say(c.yellow('        waiting for approval in the dashboard (or use --yes)'));
      say(c.yellow('        not run: nobody here to approve it (use --yes to allow commands)'));
      return client.approve(request.id, false).catch(() => {});
    }
    approvals.set(request.id, true);
    const answer = await ask(`${c.yellow('?')} ${who} wants to run ${c.bold(request.command)}  run it? [y/N] `);
    if (!approvals.has(request.id)) return; // answered in the dashboard meanwhile
    approvals.delete(request.id);
    if (rl) rl.setPrompt(promptText());
    await client.approve(request.id, /^y(es)?$/i.test(String(answer ?? '').trim())).catch((err) => say(c.red(`    ${err.message}`)));
  }

  async function answerQuestions(message) {
    // The Chef asked before building: pick an option (or type your own) for each question.
    if (!tty || message.runId !== mine && !interactive) {
      if (!interactive) say(c.dim('  (run it again with your answers in the task, or start "kadhai" to answer here)'));
      return;
    }
    const lines = [];
    for (const q of message.ask) {
      say(`  ${c.bold(q.question)}`);
      q.options.forEach((o, i) => say(`    ${c.cyan(String(i + 1))}. ${o}`));
      const answer = String((await ask(`  ${c.dim('number, your own answer, or Enter to let the crew choose')} `)) ?? '').trim();
      const picked = /^\d+$/.test(answer) ? q.options[Number(answer) - 1] : answer;
      lines.push(`- ${q.question} ${picked || '(you choose)'}`);
    }
    if (rl) rl.setPrompt(promptText());
    const text = lines.every((l) => l.endsWith('(you choose)')) ? `${message.request}\n\nNo preferences: choose sensible defaults.` : `${message.request}\n\nMy answers:\n${lines.join('\n')}`;
    const started = await client.task(text, message.attachments ?? [], { answered: true });
    if (!interactive) mine = started.runId;
  }

  const render = createRenderer({
    out,
    color: opts.color,
    verbose: opts.verbose,
    nameOf,
    onRequest: (request) => answerApproval(request),
    onResolved: (r) => {
      if (approvals.has(r.id)) {
        approvals.delete(r.id);
        say(c.dim(`    ${r.approved ? 'allowed' : 'refused'} in the dashboard`));
        if (pending) {
          const p = pending;
          pending = null;
          p.resolve(null);
        }
      }
    },
    onAsk: (message) => answerQuestions(message),
    onDone: (result) => {
      lastRun = result.runId;
      if (!interactive && result.runId === mine) {
        // A run that only asked questions is not the end, if they are being answered.
        if (!(result.ask && tty)) finished(result.ok ? 0 : 1);
      }
    },
  });

  client.on((event) => {
    if (event.type === 'crew:update' || event.type === 'agent:update') {
      if (event.type === 'agent:update') state.agents = { ...state.agents, [event.data.agent.id]: event.data.agent };
    }
    if (event.type === 'cli:disconnected') {
      say(c.red('  [!] lost the connection to Kadhai (was it closed?)'));
      finished(2);
      rl?.close();
    }
    render(event);
  });

  const where = client.mode === 'remote' ? `joined the Kadhai at ${client.base}` : `own crew${opts.demo ? ', demo models' : ''}`;
  // Piped input gets no prompt: it would be printed between the output lines.
  const promptText = () => (tty ? `${c.bold('kadhai')} ${c.grey('>')} ` : '');

  // Attachments on the command line.
  const attachments = [];
  for (const file of opts.attach) {
    try {
      attachments.push(await client.attach(path.resolve(file)));
    } catch (err) {
      process.stderr.write(`kadhai: cannot attach ${file}: ${err.message}\n`);
      await client.close();
      return 2;
    }
  }

  // ---------------------------------------------------------------- one task
  if (!interactive) {
    say(c.dim(`kadhai ${client.about.version} in ${client.about.workspaceDir} (${where})`));
    const started = await client.task(opts.text.join(' '), attachments);
    mine = started.runId;
    if (started.queued) say(c.dim('  waiting: the crew is busy with another task'));
    const code = await done;
    await client.close();
    return code;
  }

  // ---------------------------------------------------------------- the prompt
  say(`${c.bold('\\___/ kadhai')} ${c.dim(client.about.version)}  ${c.dim(client.about.workspaceDir)}`);
  say(c.dim(`  ${where}. Type what you want built; /help for commands, Ctrl+D to leave.`));
  let staged = [...attachments];
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: promptText(), terminal: tty });
  rl.prompt();
  rl.on('SIGINT', async () => {
    // Ctrl+C: stop a run in progress; on an empty prompt with nothing running, leave.
    const s = await client.state().catch(() => null);
    if (s?.run) {
      await client.stop().catch(() => {});
      say(c.yellow('  stopping the run...'));
    } else if (rl.line) {
      readline.clearLine(process.stdout, 0);
      rl.write(null, { ctrl: true, name: 'u' });
      rl.prompt();
    } else rl.close();
  });

  // Lines are handled one after another, and the last one finishes before leaving: piped input
  // ("/status" then end of input) would otherwise quit before its answer came back.
  let work = Promise.resolve();
  rl.on('line', (input) => {
    if (pending) {
      const p = pending;
      pending = null;
      return p.resolve(input);
    }
    work = work.then(() => handleLine(input));
  });

  async function handleLine(input) {
    const text = input.trim();
    if (!text) return rl?.prompt();
    try {
      if (text.startsWith('/')) await command(text);
      else {
        const started = await client.task(text, staged);
        staged = [];
        if (started.queued) say(c.dim('  queued: it starts when the current task finishes'));
      }
    } catch (err) {
      say(c.red(`  [!] ${err.message}`));
    }
    rl?.prompt(); // gone after /quit
  }

  async function command(text) {
    const [name, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    state = await snapshot().catch(() => state);
    switch (name) {
      case 'help':
      case '?':
        return say(COMMANDS.replace(/^/gm, '  '));
      case 'quit':
      case 'exit':
        return rl.close();
      case 'status': {
        const routes = state.providers?.routes ?? [];
        const ready = routes.filter((r) => r.status !== 'disabled');
        say(`  models   ${ready.length} of ${routes.length} ready${state.providers?.active ? `, in use: ${state.providers.active}` : ''}`);
        say(`  flame    ${client.about.flame ?? 'low'}`);
        say(`  commands ${state.exec?.mode ?? 'ask'}${opts.yes ? ' (--yes: allowed here)' : ''}`);
        say(`  now      ${state.run ? `working on: ${state.run.request?.split('\n')[0]}` : 'nothing running'}${state.queue?.length ? `, ${state.queue.length} waiting` : ''}`);
        return;
      }
      case 'crew':
        for (const a of Object.values(state.agents ?? {})) say(`  ${a.name.padEnd(16)} ${c.grey(a.state)}${a.task ? `  ${a.task}` : ''}`);
        return;
      case 'flame': {
        if (!['low', 'high'].includes(arg)) return say('  /flame low  or  /flame high');
        await client.setFlame(arg);
        client.about.flame = arg;
        return say(`  ${arg} flame`);
      }
      case 'attach': {
        if (!arg) return say('  /attach <file>');
        staged.push(await client.attach(path.resolve(opts.dir, arg)));
        return say(c.dim(`  attached ${arg}: it goes with your next message`));
      }
      case 'diff':
      case 'undo': {
        const runs = state.runs ?? [];
        const run = runs.filter((r) => !r.undone).at(-1);
        if (!run) return say('  no run that changed files yet');
        if (name === 'diff') {
          const d = await client.diff(run.id);
          return say(renderDiffText(d.patch || '(no changes)', c));
        }
        if (!run.canUndo) return say('  that run cannot be undone (another run changed files after it, or one is running)');
        await client.undo(run.id);
        return say(`  undid: ${run.objective}`);
      }
      case 'stop':
        await client.stop();
        return say(c.yellow('  stopping the run...'));
      default:
        return say(`  unknown command /${name} (/help)`);
    }
  }

  await new Promise((resolve) => rl.on('close', resolve));
  await work;
  rl = null;
  process.stdout.write('\n');
  await client.close();
  return 0;
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    process.stderr.write(`kadhai: ${err.stack ?? err}\n`);
    process.exit(2);
  },
);
