import fs from 'node:fs';
import path from 'node:path';
import { createEngine } from '../core/engine.js';
import { saveAttachment } from '../core/attachments.js';
import { claimRoom, releaseRoom, roomHolder } from '../http/rooms.js';
import { DATA } from '../config.js';

/**
 * The CLI talks to a crew in one of two ways, behind one interface:
 *   remote - a Kadhai already has this folder open (the dashboard, or a kitchen of it): the CLI
 *            joins it over its HTTP API and live event stream. One crew, one history, both views.
 *   local  - nothing has it open: the CLI starts an engine of its own for the folder, claims the
 *            folder the way a kitchen does (one folder, one room), and closes it on the way out.
 * Either way: on(fn), task, attach, approve, state, undo, diff, stop, setFlame, close.
 */

const same = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
const fail = (message, status) => Object.assign(new Error(message), { status });

export class RemoteClient {
  #listeners = new Set();
  #stream = null;

  constructor(base, about) {
    this.base = base;
    this.about = about;
    this.mode = 'remote';
  }

  /** The Kadhai that has `dir` open, if it answers and really is working in that folder; else null. */
  static async find(dir) {
    const holder = roomHolder(dir);
    if (!holder?.port) return null;
    // 127.0.0.1, not "localhost": Node tries ::1 first, and a server on 127.0.0.1 alone (a kitchen, a test) is not there.
    const base = `http://127.0.0.1:${holder.port}`;
    try {
      const about = await (await fetch(`${base}/api/about`, { signal: AbortSignal.timeout(3000) })).json();
      return same(about.workspaceDir, dir) ? new RemoteClient(base, about) : null;
    } catch {
      return null;
    }
  }

  async #call(method, url, body) {
    const res = await fetch(`${this.base}/api${url}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw fail(data.error || res.statusText, res.status);
    return data;
  }

  /** Follow the live event stream (the same one the dashboard reads). */
  async start() {
    const ctrl = new AbortController();
    this.#stream = ctrl;
    const res = await fetch(`${this.base}/api/events`, { signal: ctrl.signal });
    (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
            if (!data) continue;
            try {
              const event = JSON.parse(data);
              for (const fn of this.#listeners) fn(event);
            } catch {
              // a line that is not an event
            }
          }
        }
      } catch {
        // closed
      }
      if (!ctrl.signal.aborted) for (const fn of this.#listeners) fn({ type: 'cli:disconnected', data: {} });
    })();
    return this;
  }

  on(fn) {
    this.#listeners.add(fn);
  }

  task(text, attachments = [], { answered = false } = {}) {
    return this.#call('POST', '/task', { text, attachments, ...(answered ? { answered } : {}) });
  }

  async attach(file) {
    const saved = await this.#call('POST', '/attach', { name: path.basename(file), data: fs.readFileSync(file).toString('base64') });
    return saved.path;
  }

  approve(id, yes) {
    return this.#call('POST', `/exec/${encodeURIComponent(id)}/${yes ? 'approve' : 'deny'}`);
  }

  state() {
    return this.#call('GET', '/state');
  }

  undo(runId) {
    return this.#call('POST', `/runs/${encodeURIComponent(runId)}/undo`);
  }

  diff(runId) {
    return this.#call('GET', `/runs/${encodeURIComponent(runId)}/diff`);
  }

  stop() {
    return this.#call('POST', '/run/stop');
  }

  async setFlame(level) {
    // The flame belongs to the dashboard here: changing it changes it there too.
    return this.#call('PUT', '/workspace/flame', { flame: level });
  }

  async close() {
    this.#stream?.abort();
  }
}

export class LocalClient {
  constructor(engine, dir) {
    this.engine = engine;
    this.dir = dir;
    this.mode = 'local';
    this.about = engine.about();
  }

  static async open(dir, { mock = false, flame = null } = {}) {
    const holder = roomHolder(dir);
    if (holder) throw fail(`${dir} is open in another Kadhai (process ${holder.pid}) that the CLI cannot join. Close it there, or run kadhai in that window.`, 409);
    const engine = await createEngine({ workspaceDir: dir, persist: true, interactive: true, sealSecrets: true, watchKeys: true, ...(mock ? { mock: true } : {}), ...(process.env.KADHAI_MCP === 'off' ? { mcp: false } : {}) });
    // The flame chosen in the dashboard, unless this run says otherwise (it is not saved from here).
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.local.json'), 'utf8')).flame;
    } catch {
      // no settings yet
    }
    const level = flame ?? saved;
    if (level === 'low' || level === 'high') engine.setFlame(level);
    // One folder, one room: the dashboard will not open this folder while the CLI has it.
    claimRoom(engine.config.workspaceDir, null);
    return new LocalClient(engine, engine.config.workspaceDir);
  }

  async start() {
    return this;
  }

  on(fn) {
    this.engine.bus.subscribe(fn);
  }

  async task(text, attachments = [], { answered = false } = {}) {
    // Typed by the operator, who is right here: the same as a task typed in the dashboard.
    const run = this.engine.orchestrator.start(text, { source: 'ui', attachments, answered });
    return { runId: run.id, queued: run.queued };
  }

  async attach(file) {
    const saved = await saveAttachment(this.engine.workspace, path.basename(file), fs.readFileSync(file));
    return saved.path;
  }

  async approve(id, yes) {
    return { ok: yes ? this.engine.runner.approve(id) : this.engine.runner.deny(id) };
  }

  state() {
    return this.engine.snapshot();
  }

  undo(runId) {
    return this.engine.orchestrator.undo(runId);
  }

  diff(runId) {
    return this.engine.orchestrator.diff(runId);
  }

  async stop() {
    return { stopped: this.engine.orchestrator.stop() };
  }

  async setFlame(level) {
    return { flame: this.engine.setFlame(level) };
  }

  async close() {
    await this.engine.close();
    releaseRoom(this.dir);
  }
}

/** Join the Kadhai that has this folder open, or start one for it. */
export async function connect(dir, opts = {}) {
  const remote = opts.local ? null : await RemoteClient.find(dir);
  return (remote ?? (await LocalClient.open(dir, opts))).start();
}
