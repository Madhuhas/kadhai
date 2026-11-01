import fs from 'node:fs';
import { childEnv } from './runner.js';
import { killTree, log } from './util.js';

/**
 * The real terminal: a shell in a pseudo-terminal (node-pty, an optional dependency the user chose
 * on 2026-10-31), for the operator in the dashboard only. Interactive programs work there (npm init,
 * python, vim) because the shell is really attached to a terminal. It is the operator's own shell,
 * exactly as if they had opened one on this computer - so:
 *   - nothing but the dashboard's keyboard writes to it: no model, tool, flow, trigger, MCP or ACP
 *     path can reach it (they all go through Runner, as before);
 *   - it is not sandboxed, and is refused while the Docker sandbox is on (it would bypass it) or
 *     commands are switched off;
 *   - at most MAX_OPEN at once, each killed with its whole process tree when closed, and all of
 *     them when the engine closes (another folder, or Kadhai stopping);
 *   - its environment has key-like variables taken out (childEnv), like every child of Kadhai.
 * Output reaches the browser as `pty:output` events (batched), input comes back over HTTP.
 */

const MAX_OPEN = 4;
const FLUSH_MS = 12;
const KEPT = 200 * 1024; // recent output per terminal, replayed to a dashboard that reloads
const MAX_INPUT = 64 * 1024; // one paste

let loaded; // the node-pty module, null when it is not installed, undefined before the first try
async function nodePty() {
  if (loaded === undefined) {
    try {
      const mod = await import('node-pty');
      loaded = mod.spawn ? mod : mod.default;
    } catch (err) {
      loaded = null;
      log(`real terminal unavailable: ${err.message.split('\n')[0]}`);
    }
  }
  return loaded;
}

/** PowerShell on Windows when it is there, else cmd; the user's shell elsewhere. */
function defaultShell() {
  if (process.platform === 'win32') {
    const ps = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    return fs.existsSync(ps) ? { file: ps, args: ['-NoLogo'], name: 'PowerShell' } : { file: process.env.COMSPEC ?? 'cmd.exe', args: [], name: 'cmd' };
  }
  const shell = process.env.SHELL || (fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh');
  return { file: shell, args: ['-l'], name: shell.split('/').pop() };
}

const clampSize = (n, lo, hi, fallback) => (Number.isInteger(n) ? Math.min(hi, Math.max(lo, n)) : fallback);

export class Terminals {
  #open = new Map(); // id -> { pty, title, cols, rows, kept, pending, timer }
  #next = 1;

  constructor({ bus, workspace, runner, enabled = false, spawn = null, shell = defaultShell() }) {
    this.bus = bus;
    this.workspace = workspace;
    this.runner = runner;
    this.enabled = enabled; // only an engine with a dashboard (config.interactive) offers it
    this.spawn = spawn; // tests: a stand-in for node-pty's spawn
    this.shell = shell;
  }

  /** Why the real terminal cannot be used now, or null when it can. */
  async unavailable() {
    if (!this.enabled) return 'The real terminal is only in the dashboard.';
    if (this.runner.sandbox === 'docker') return 'The real terminal runs on this computer, so it is off while commands run in the Docker sandbox. The command terminal still works.';
    if (!this.runner.enabled) return 'Commands are switched off for this folder.';
    if (!this.spawn && !(await nodePty())) return 'The real terminal needs the node-pty package, which is not installed here. Run "npm install" in the Kadhai folder (on Linux it also needs build tools), then restart Kadhai.';
    return null;
  }

  async status() {
    return { available: !(await this.unavailable()), reason: await this.unavailable(), shell: this.shell.name, open: [...this.#open.entries()].map(([id, t]) => ({ id, title: t.title, cols: t.cols, rows: t.rows })) };
  }

  /** A new shell in the workspace (or a folder inside it). -> { id, title } */
  async open({ cols, rows, dir = '' } = {}) {
    const why = await this.unavailable();
    if (why) throw Object.assign(new Error(why), { status: 409 });
    if (this.#open.size >= MAX_OPEN) throw Object.assign(new Error(`At most ${MAX_OPEN} terminals at once: close one first.`), { status: 409 });
    const cwd = dir ? this.workspace.resolve(dir).abs : this.workspace.root;
    const size = { cols: clampSize(cols, 20, 400, 100), rows: clampSize(rows, 5, 200, 30) };
    const spawn = this.spawn ?? (await nodePty()).spawn;
    const env = { ...childEnv(process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    delete env.ELECTRON_RUN_AS_NODE; // the desktop app's Node must not leak into the user's shell
    const pty = spawn(this.shell.file, this.shell.args, { name: 'xterm-256color', ...size, cwd, env, useConpty: true });
    const id = String(this.#next++);
    const term = { pty, title: `${this.shell.name} ${id}`, ...size, kept: '', pending: '', timer: null };
    this.#open.set(id, term);
    pty.onData((data) => {
      term.pending += data;
      term.kept = (term.kept + data).slice(-KEPT);
      if (!term.timer) term.timer = setTimeout(() => this.#flush(id), FLUSH_MS);
    });
    pty.onExit(({ exitCode }) => {
      this.#flush(id);
      this.#open.delete(id);
      this.bus.publish('pty:exit', { id, code: exitCode });
    });
    this.bus.publish('pty:open', { id, title: term.title });
    return { id, title: term.title };
  }

  #flush(id) {
    const term = this.#open.get(id);
    if (!term) return;
    clearTimeout(term.timer);
    term.timer = null;
    if (!term.pending) return;
    const data = term.pending;
    term.pending = '';
    this.bus.publish('pty:output', { id, data });
  }

  #get(id) {
    const term = this.#open.get(String(id));
    if (!term) throw Object.assign(new Error('That terminal is closed.'), { status: 404 });
    return term;
  }

  /** Keys from the dashboard: the only way anything is written into a shell here. */
  write(id, data) {
    if (typeof data !== 'string' || !data) return;
    this.#get(id).pty.write(data.slice(0, MAX_INPUT));
  }

  resize(id, cols, rows) {
    const term = this.#get(id);
    term.cols = clampSize(cols, 20, 400, term.cols);
    term.rows = clampSize(rows, 5, 200, term.rows);
    try {
      term.pty.resize(term.cols, term.rows);
    } catch {
      // it is exiting
    }
  }

  /** What a terminal showed lately, for a dashboard that reloaded while it was open. */
  replay(id) {
    return this.#get(id).kept;
  }

  close(id) {
    const term = this.#get(id);
    const pid = term.pty.pid;
    // node-pty's own kill first: on Windows it asks the console which processes share it, and
    // that fails noisily ("AttachConsole failed") once the tree is already gone.
    try {
      term.pty.kill();
    } catch {
      // already gone
    }
    // Then the tree, for anything that left the console: a dev server started from it goes too.
    killTree({ pid, exitCode: null, signalCode: null });
    clearTimeout(term.timer);
    this.#open.delete(String(id));
    this.bus.publish('pty:exit', { id: String(id), code: null });
  }

  closeAll() {
    for (const id of [...this.#open.keys()]) this.close(id);
  }
}
