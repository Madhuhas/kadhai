import fs from 'node:fs';
import crypto from 'node:crypto';
import { clip, log } from './util.js';
import { extractJson } from './parse.js';
import { fill, value, toText, parseMaybe, jsonEscape, keep, testAll, setPath, badExpressions, OPS, UNARY } from './flowData.js';
import { SERVICES, POLLERS, CREDENTIAL_TYPES, runService, request, applyCredential } from './services.js';
import { runCode } from './codeNode.js';
import { draftSystem, draftUser, shapeDraft, mergeWithBase, diffFlows, attention, badReferences, DRAFT_INPUT_CHARS } from './flowDraft.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const text = (value, max) => String(value ?? '').trim().slice(0, max);
const groupOf = (tool) => tool.split('__')[0];

export const MAX_FLOWS = 30;
export const MAX_NODES = 40;
export const MAX_NOTES = 20;
export const MAX_AGENT_NODES = 8; // agent and AI nodes call a model: the bound on model calls per flow
export const MAX_AGENT_TOOLS = 3; // what a sub-task may carry (see the orchestrator)
export const MIN_INTERVAL_MINUTES = 5; // unattended runs spend quota: no tighter loop than this
export const MAX_DEPTH = 3; // a flow may run another flow, which may run another - no deeper
export const MAX_WAIT_SECONDS = 3600;
export const RUNS_KEPT = 15;
const TICK_MS = 20000;
const OUTPUT_CHARS = 1500;
const DATA_CHARS = 3000;
const PIN_CHARS = 20000;
const POLL_BATCH = 3; // one burst from outside must not start a flood of runs
const QUEUE_MAX = 10;
const SEEN_CAP = 300;
const RETRY_WAIT_MS = 3000;
const FILE_GAP_MS = 60000; // a flow started by a file change waits this long before the next
const FILE_QUIET_MS = 10000; // changes made while a flow runs (or just after) never start one
const CANVAS = 8000;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const NODE_ID = /^[a-z0-9]{1,12}$/;
const TOOL_NAME = /^[\w.-]{1,40}__[\w.\-/]{1,80}$/;
const CONNECTION_ID = /^[\w.-]{1,40}$/;
const FIELD_KEY = /^[\w$-]{1,40}(\.[\w$-]{1,40}){0,4}$/;
const HEADER = /^[A-Za-z0-9-]{1,60}$/;
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'cookie']);

/**
 * The kinds of node a flow is built from. `out` lists a node's output ports;
 * a wire leaves from one of them and enters another node.
 *   trigger  what starts the flow (exactly one per flow)
 *   agent    a task for the crew; app nodes can be plugged into it as tools
 *   ai       one answer from a model: summarise, classify, pull out fields
 *   app      one call to a tool of a connection (an MCP server, Google): no model involved
 *   service  one action of a built-in service (Telegram, GitHub, Notion, weather...)
 *   if       sends what it received down "true" or "false"
 *   switch   sends it down the first rule that holds ("1", "2"...), or "else"
 *   filter   lets it through only if the conditions hold
 *   merge    waits for every wire into it and combines what arrived
 *   set      builds an object from fields
 *   code     a few lines of JavaScript that turn the input into the output
 *   wait     a pause
 *   http     a request to an address of the user's
 *   flow     runs another flow and hands on its result
 *   file     reads or writes a file in the folder
 *   command  runs a command in the folder (it waits for approval like the crew's)
 *   note     a sticky note on the canvas; never runs
 */
export const NODE_TYPES = {
  trigger: { out: ['out'] },
  agent: { out: ['out'] },
  ai: { out: ['out'] },
  app: { out: ['out', 'tool'] },
  service: { out: ['out'] },
  if: { out: ['true', 'false'] },
  switch: { out: [] }, // its ports follow its rules: see outPorts
  filter: { out: ['out'] },
  merge: { out: ['out'] },
  set: { out: ['out'] },
  code: { out: ['out'] },
  wait: { out: ['out'] },
  http: { out: ['out'] },
  flow: { out: ['out'] },
  file: { out: ['out'] },
  command: { out: ['out'] },
  note: { out: [] },
};
const MODEL = new Set(['agent', 'ai']);
// Retrying these would mean more model calls, a second approval, or a second run of another flow.
const NO_RETRY = new Set(['trigger', 'note', 'agent', 'ai', 'command', 'flow', 'wait']);

/** A node's output ports. */
export function outPorts(node) {
  if (node.type === 'switch') return [...(node.config?.rules ?? []).map((_, i) => String(i + 1)), 'else'];
  return NODE_TYPES[node.type]?.out ?? [];
}

/**
 * When a scheduled flow is next due, strictly after `after` (a timestamp).
 *   { kind: 'interval', minutes }           every N minutes
 *   { kind: 'daily', time: 'HH:MM', days }  at that local time, on those weekdays (0 = Sunday; none = every day)
 */
export function nextRun(schedule, after) {
  if (schedule.kind === 'interval') return after + schedule.minutes * 60000;
  const [hours, minutes] = schedule.time.split(':').map(Number);
  const days = schedule.days?.length ? schedule.days : [0, 1, 2, 3, 4, 5, 6];
  const at = new Date(after);
  at.setHours(hours, minutes, 0, 0);
  // Today if the time is still ahead and today counts; otherwise the next day that does.
  for (let i = 0; i < 8; i++) {
    if (at.getTime() > after && days.includes(at.getDay())) return at.getTime();
    at.setDate(at.getDate() + 1);
    at.setHours(hours, minutes, 0, 0);
  }
  return at.getTime();
}

/** A flow saved as a list of steps (the first version of flows) as the graph it means. */
function fromSteps(raw) {
  const nodes = [{ id: 't', type: 'trigger', x: 40, y: 80, config: raw.trigger ?? { kind: 'manual' } }];
  const edges = [];
  (raw.steps ?? []).forEach((step, i) => {
    nodes.push({ id: `s${i}`, type: 'agent', x: 300 + i * 260, y: 80, config: { text: step.text, agent: step.agent } });
    edges.push({ from: i ? `s${i - 1}` : 't', to: `s${i}`, port: 'out' });
  });
  if (raw.notify?.url) {
    nodes.push({ id: 'n', type: 'http', x: 300 + (raw.steps?.length ?? 0) * 260, y: 80, config: { method: 'POST', url: raw.notify.url, body: '{"result": "{{input}}"}' } });
    edges.push({ from: nodes.at(-2).id, to: 'n', port: 'out' });
  }
  return { ...raw, nodes, edges };
}

/** Several inputs that arrived on several wires, as one: text joins, anything else becomes a list. */
const combine = (inputs) => (inputs.length === 1 ? inputs[0] : inputs.every((v) => typeof v === 'string') ? inputs.join('\n\n') : inputs);
const items = (data) => (Array.isArray(data) ? data.length : data == null || data === '' ? 0 : 1);
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('stopped'));
    const timer = setTimeout(() => (signal?.removeEventListener('abort', onAbort), resolve()), ms);
    const onAbort = () => (clearTimeout(timer), reject(new Error('stopped')));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Flows: automations drawn as a graph. One trigger node starts it; wires carry
 * each node's output (any JSON value) to the nodes after it, and any setting
 * can quote that data with {{ expressions }} (see flowData.js).
 *
 * An **agent** node is an ordinary task for the crew: it goes through `start`
 * (the orchestrator), so it is planned, cooked and reviewed like one typed in
 * the chat, queues behind other work, and its commands wait for approval. The
 * node pins which cook does it, and the app nodes wired into its tools port
 * are the connections that work may use. An **ai** node is one model call
 * through `crew.call`, nothing more.
 *
 * App, service, if, switch, filter, merge, set, code, wait and http nodes use
 * no model. File and command nodes go through the Workspace and the Runner
 * like everything else (a command still waits for approval in "ask" mode).
 *
 * A flow may branch but never loop: the wires must form no cycle, each node
 * runs at most once per round, flows that run other flows may not come back
 * round to themselves, and there are at most MAX_AGENT_NODES nodes that call
 * a model - so the model calls a flow can make are fixed by its drawing.
 */
export class Flows {
  #list = [];
  #running = new Map(); // flow id -> AbortController
  #queues = new Map(); // flow id -> data waiting to start it (from polls and file changes)
  #history = {}; // flow id -> [records], newest first
  #historyTimer = null;
  #timer = null;
  #unsubscribe = null;
  #fileTimer = new Map();
  #lastFlowEnd = 0;
  #saving = Promise.resolve();

  constructor({ file, enabled, bus, start, crew, toolbox, workspace, runner, credentials, busy = () => false, fetch = globalThis.fetch, now = () => Date.now() }) {
    this.busy = busy; // is the crew cooking? (drawing a flow is the Chef's work, never mid-run)
    this.file = file;
    this.runsFile = String(file).replace(/\.json$/i, '') + '.runs.json';
    this.enabled = Boolean(enabled);
    this.bus = bus;
    this.start = start; // (text, { source, cook, tools }) -> run, as orchestrator.start
    this.crew = crew;
    this.toolbox = toolbox; // () -> { call(name, args) }: looked up at run time, so tests and reconnects are seen
    this.workspace = workspace;
    this.runner = runner;
    this.credentials = credentials;
    this.fetch = (...args) => fetch(...args);
    this.now = now;
  }

  async init() {
    if (!this.enabled) return;
    try {
      const saved = JSON.parse(await fs.promises.readFile(this.file, 'utf8'));
      for (const raw of Array.isArray(saved.flows) ? saved.flows : []) {
        try {
          const flow = { id: String(raw.id), ...this.#clean(Array.isArray(raw.nodes) ? raw : fromSteps(raw), { loading: true }), enabled: raw.enabled !== false, lastRun: raw.lastRun ?? null, runs: raw.runs ?? 0, cursor: raw.cursor ?? null };
          // Nothing is caught up after a restart: a schedule counts from now.
          flow.nextRunAt = this.#due(flow, this.now());
          flow.pollAt = this.now();
          this.#list.push(flow);
        } catch (err) {
          // A hand-edited entry that no longer makes sense is left out, not fatal.
          log.warn(`A saved flow was left out: ${err.message}`);
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`flows.local.json ignored: ${err.message}`);
    }
    try {
      const runs = JSON.parse(await fs.promises.readFile(this.runsFile, 'utf8'));
      if (runs && typeof runs === 'object') this.#history = runs;
    } catch {
      // No history yet.
    }
    this.#timer = setInterval(() => this.tick().catch(() => {}), TICK_MS);
    this.#timer.unref();
    this.#unsubscribe = this.bus?.subscribe((event) => event.type === 'fs:change' && this.#onFiles(event.data?.paths ?? []));
  }

  close() {
    clearInterval(this.#timer);
    this.#timer = null;
    this.#unsubscribe?.();
    for (const t of this.#fileTimer.values()) clearTimeout(t);
    for (const controller of this.#running.values()) controller.abort();
    if (this.#historyTimer) {
      clearTimeout(this.#historyTimer);
      this.#historyTimer = null;
      try {
        fs.writeFileSync(this.runsFile, JSON.stringify(this.#history));
      } catch {
        // Losing the last few run records is not worth failing a shutdown over.
      }
    }
  }

  #trigger(flow) {
    return flow.nodes.find((n) => n.type === 'trigger').config;
  }

  #due(flow, after) {
    const trigger = this.#trigger(flow);
    return flow.enabled && trigger.kind === 'schedule' ? nextRun(trigger.schedule, after) : null;
  }

  /** Saves wait their turn: two at once (a run ending while the user saves) would share the temp file. */
  #save() {
    const next = this.#saving.then(async () => {
      const flows = this.#list.map(({ nextRunAt, pollAt, pollError, fileAt, filePending, ...flow }) => flow);
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, `${JSON.stringify({ flows }, null, 2)}\n`);
      await fs.promises.rename(tmp, this.file);
    });
    this.#saving = next.catch(() => {});
    return next;
  }

  /** Run records are written a moment later, in one go: a busy flow should not rewrite a file per node. */
  #saveHistory() {
    if (this.#historyTimer) return;
    this.#historyTimer = setTimeout(async () => {
      this.#historyTimer = null;
      try {
        const tmp = `${this.runsFile}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(this.#history));
        await fs.promises.rename(tmp, this.runsFile);
      } catch (err) {
        log.warn(`Could not save flow runs: ${err.message}`);
      }
    }, 1000);
    this.#historyTimer.unref?.();
  }

  #changed() {
    this.bus?.publish('flows:update', {});
  }

  // --------------------------------------------------------------- validation

  /** A template some text may be quoted into: every {{ }} in it must be one this understands. */
  #template(raw, max, where) {
    const t = String(raw ?? '').slice(0, max);
    const bad = badExpressions(t);
    if (bad.length) throw fail(`${where}: "{{ ${bad[0]} }}" is not something a flow can read. Use input, trigger, node('Name'), now or today, e.g. {{ input.title }}`);
    return t;
  }

  #conditions(list, where) {
    const out = (Array.isArray(list) ? list : []).slice(0, 5).map((c) => {
      const op = OPS.includes(c?.op) ? c.op : 'contains';
      const left = this.#template(text(c?.left, 300) || '{{ input }}', 300, where);
      const v = this.#template(text(c?.value, 300), 300, where);
      if (!UNARY.has(op) && !v) throw fail(`${where}: say what to compare with`);
      if (op === 'matches') {
        try {
          new RegExp(v);
        } catch {
          throw fail(`${where}: that pattern is not valid`);
        }
      }
      return { left, op, value: UNARY.has(op) ? '' : v };
    });
    if (!out.length) throw fail(`${where}: add a condition`);
    return out;
  }

  #credential(id, wanted, where, loading = false) {
    const cred = text(id, 20);
    if (!cred) return '';
    // A saved flow whose credential was removed still loads; it says what is missing when it runs.
    if (loading) return cred;
    if (!this.credentials?.has(cred)) throw fail(`${where}: the credential it used was removed - choose another`);
    if (wanted && this.credentials.typeOf(cred) !== wanted && !(wanted === 'any' && ['bearer', 'header', 'query', 'basic', 'github'].includes(this.credentials.typeOf(cred)))) throw fail(`${where}: that credential is for something else`);
    return cred;
  }

  #url(raw, where) {
    let parsed;
    try {
      parsed = new URL(text(raw, 800));
    } catch {
      throw fail(`${where} needs a full address, e.g. https://example.com/hook`);
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) throw fail(`${where}: the address must start with https://`);
    return parsed.href;
  }

  /** One node's settings, checked. `where` names the node in messages. */
  #config(type, input = {}, where, { loading }) {
    if (type === 'trigger') {
      if (input.kind === 'schedule') {
        const s = input.schedule ?? {};
        if (s.kind === 'interval') {
          const minutes = Number(s.minutes);
          if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > 7 * 24 * 60) throw fail(`"Every" takes whole minutes, at least ${MIN_INTERVAL_MINUTES}`);
          return { kind: 'schedule', schedule: { kind: 'interval', minutes } };
        }
        if (s.kind === 'daily') {
          if (!TIME.test(String(s.time))) throw fail('Give the time as HH:MM, for example 09:00');
          const days = [...new Set((Array.isArray(s.days) ? s.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
          return { kind: 'schedule', schedule: { kind: 'daily', time: s.time, days } };
        }
        throw fail('Choose how often the flow runs');
      }
      if (input.kind === 'trigger') {
        const id = text(input.id, 40);
        if (!/^[0-9a-f]{16}$/.test(id)) throw fail('Choose which trigger starts the flow');
        return { kind: 'trigger', id };
      }
      if (input.kind === 'poll') {
        const every = Number(input.every ?? MIN_INTERVAL_MINUTES);
        if (!Number.isInteger(every) || every < MIN_INTERVAL_MINUTES || every > 24 * 60) throw fail(`The start checks every few minutes: whole minutes, at least ${MIN_INTERVAL_MINUTES}`);
        if (input.poller === 'app') {
          const tool = text(input.tool, 130);
          if (!TOOL_NAME.test(tool)) throw fail('The start: choose which app action to check');
          const args = text(input.args, 4000) || '{}';
          try {
            if (typeof JSON.parse(args) !== 'object') throw new Error();
          } catch {
            throw fail('The start: the settings must be a JSON object');
          }
          return { kind: 'poll', poller: 'app', tool, args, every };
        }
        const poller = POLLERS[input.poller];
        if (!poller) throw fail('The start: choose what to watch');
        const config = { kind: 'poll', poller: input.poller, every };
        for (const field of poller.fields) {
          config[field.id] = text(input[field.id], 500);
          if (!config[field.id] && !field.optional) throw fail(`The start: ${field.label.toLowerCase()} is needed`);
        }
        if (['rss', 'watch'].includes(input.poller)) config.url = this.#url(config.url, 'The start');
        if (input.poller === 'github' && !/^[\w.-]+\/[\w.-]+$/.test(config.repo)) throw fail('The start: give the repository as owner/name');
        if (input.poller === 'reddit' && !/^\w{2,21}$/.test(config.subreddit.replace(/^\/?r\//, ''))) throw fail('The start: give the subreddit name, e.g. programming');
        const credential = this.#credential(input.credential, poller.auth ?? 'any', 'The start', loading);
        return credential ? { ...config, credential } : config;
      }
      if (input.kind === 'file') return { kind: 'file', path: text(input.path, 200).replace(/\\/g, '/').replace(/^\.?\/+/, '') };
      return { kind: 'manual' };
    }
    if (type === 'note') return { text: text(input.text, 2000), color: ['', 'a', 'b', 'c'].includes(input.color) ? input.color : '' };
    if (type === 'agent') {
      const task = this.#template(text(input.text, 2000), 2000, where);
      if (!task) throw fail(`${where} has nothing to do yet - write its task`);
      // A cook that has since been let go: the Chef chooses again, rather than the flow breaking.
      return { text: task, agent: this.crew.agents.get(input.agent)?.role === 'coder' ? input.agent : '' };
    }
    if (type === 'ai') {
      const prompt = this.#template(text(input.prompt, 4000), 4000, where);
      if (!prompt) throw fail(`${where}: write what to ask the model`);
      return { prompt, system: text(input.system, 1000), json: input.json === true, agent: this.crew.agents.has(input.agent) ? input.agent : '' };
    }
    if (type === 'app') {
      const tool = text(input.tool, 130);
      if (tool && !TOOL_NAME.test(tool)) throw fail(`${where}: that is not the name of a tool`);
      const connection = tool ? groupOf(tool) : text(input.connection, 40);
      if (!CONNECTION_ID.test(connection)) throw fail(`${where}: choose which connection it is`);
      const args = this.#template(text(input.args, 4000) || '{}', 4000, where);
      try {
        // Checked with the placeholders filled in by something harmless, as they will be at run time.
        if (typeof JSON.parse(fill(args, { input: 'x', trigger: 'x', node: () => 'x' })) !== 'object') throw new Error('not an object');
      } catch {
        throw fail(`${where}: the settings must be a JSON object, e.g. {"query": "{{ input }}"}`);
      }
      return { connection, tool, args };
    }
    if (type === 'service') {
      const service = SERVICES[input.service];
      const action = service?.actions[input.action];
      if (!action) throw fail(`${where}: choose a service and what it should do`);
      const params = {};
      for (const field of action.fields) {
        const v = text(input.params?.[field.id], 8000);
        if (field.fixed && v.includes('{{')) throw fail(`${where}: "${field.label}" is fixed - it cannot take {{ }} from the flow`);
        if (!v && !field.optional && !loading) throw fail(`${where}: fill in "${field.label}"`);
        params[field.id] = field.fixed ? v : this.#template(v, 8000, where);
      }
      const credential = this.#credential(input.credential, service.auth, where, loading);
      if (service.auth && !credential && (!service.authOptional || action.needsAuth) && !loading) throw fail(`${where}: choose a ${CREDENTIAL_TYPES[service.auth].label} credential`);
      return { service: input.service, action: input.action, credential, params };
    }
    if (type === 'if' || type === 'filter') {
      // The first version had one condition on the input: { op, value }.
      const list = Array.isArray(input.conditions) ? input.conditions : [{ left: '{{ input }}', op: input.op === 'empty' ? 'empty' : (input.op ?? 'contains'), value: input.value }];
      return { conditions: this.#conditions(list, where), combine: input.combine === 'or' ? 'or' : 'and' };
    }
    if (type === 'switch') {
      const rules = this.#conditions(input.rules, where);
      return { rules };
    }
    if (type === 'merge') return { mode: ['append', 'combine', 'text'].includes(input.mode) ? input.mode : 'append', separator: String(input.separator ?? '').slice(0, 20) };
    if (type === 'set') {
      const fields = (Array.isArray(input.fields) ? input.fields : []).slice(0, 20).map((f) => {
        const key = text(f?.key, 200);
        if (!FIELD_KEY.test(key)) throw fail(`${where}: "${key || '(empty)'}" is not a field name (letters, digits, _ and - ; dots for nesting)`);
        return { key, value: this.#template(String(f?.value ?? '').slice(0, 4000), 4000, where) };
      });
      if (!fields.length) throw fail(`${where}: add a field`);
      return { fields, keep: input.keep === true };
    }
    if (type === 'code') {
      const code = String(input.code ?? '').slice(0, 10000);
      if (!code.trim()) throw fail(`${where}: write the code (it must return something)`);
      return { code };
    }
    if (type === 'wait') {
      const seconds = Number(input.seconds);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_WAIT_SECONDS) throw fail(`${where}: wait between 1 and ${MAX_WAIT_SECONDS} seconds`);
      return { seconds };
    }
    if (type === 'flow') {
      const id = text(input.flow, 20);
      if (!id) throw fail(`${where}: choose which flow to run`);
      if (!loading && !this.#list.some((f) => f.id === id)) throw fail(`${where}: that flow no longer exists`);
      return { flow: id };
    }
    if (type === 'file') {
      const op = ['read', 'write', 'append'].includes(input.op) ? input.op : 'read';
      const path = text(input.path, 300).replace(/\\/g, '/');
      if (!path) throw fail(`${where}: name the file`);
      if (path.includes('{{')) throw fail(`${where}: the file name is fixed - it cannot take {{ }} from the flow`);
      if (this.workspace) {
        try {
          this.workspace.resolve(path);
        } catch (err) {
          throw fail(`${where}: ${err.message}`);
        }
      }
      return { op, path, content: op === 'read' ? '' : this.#template(String(input.content ?? '').slice(0, 50000), 50000, where) || '{{ input }}' };
    }
    if (type === 'command') {
      const command = text(input.command, 500);
      if (!command) throw fail(`${where}: write the command`);
      if (command.includes('{{')) throw fail(`${where}: a command is fixed - text from the flow is never put into it`);
      if (/[\r\n]/.test(command)) throw fail(`${where}: one line only`);
      return { command, failOnError: input.failOnError !== false };
    }
    // http: the address is fixed by the user; the query, headers and body may carry text from the flow.
    const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(input.method) ? input.method : 'POST';
    const url = this.#url(input.url, where);
    const pairs = (list, what, check) =>
      (Array.isArray(list) ? list : [])
        .slice(0, 20)
        .filter((p) => text(p?.key, 100))
        .map((p) => {
          const key = text(p.key, 100);
          check?.(key);
          return { key, value: what === 'header' ? text(p.value, 2000) : this.#template(text(p.value, 2000), 2000, where) };
        });
    const query = pairs(input.query, 'query');
    const headers = pairs(input.headers, 'header', (key) => {
      if (!HEADER.test(key) || FORBIDDEN_HEADERS.has(key.toLowerCase())) throw fail(`${where}: "${key}" cannot be set as a header`);
    });
    if (headers.some((h) => h.value.includes('{{'))) throw fail(`${where}: headers are fixed - put text from the flow in the query or the body`);
    const hasBody = method !== 'GET' && method !== 'DELETE';
    const bodyType = !hasBody ? 'none' : ['json', 'text', 'none'].includes(input.bodyType) ? input.bodyType : 'json';
    let body = bodyType === 'none' ? '' : this.#template(String(input.body ?? '').slice(0, 8000), 8000, where);
    if (bodyType === 'json') {
      body = body.trim() || '{"text": "{{ input }}"}';
      try {
        JSON.parse(fill(body, { input: 'x', trigger: 'x', node: () => 'x' }, jsonEscape));
      } catch {
        throw fail(`${where}: the body must be JSON, e.g. {"text": "{{ input }}"}`);
      }
    }
    const credential = this.#credential(input.credential, 'any', where, loading);
    return { method, url, query, headers, bodyType, body, credential };
  }

  /** Validate a drawing. Throws a sentence the user can act on. */
  #clean(input = {}, { loading = false, id = null } = {}) {
    const name = text(input.name, 50).replace(/\s+/g, ' ');
    if (name.length < 2) throw fail('Give the flow a name');

    const raw = Array.isArray(input.nodes) ? input.nodes : [];
    if (raw.filter((n) => n?.type !== 'note').length > MAX_NODES) throw fail(`At most ${MAX_NODES} nodes in a flow`);
    if (raw.filter((n) => n?.type === 'note').length > MAX_NOTES) throw fail(`At most ${MAX_NOTES} notes in a flow`);
    const nodes = [];
    const names = new Set();
    const label = (node, index) => (node.type === 'trigger' ? 'The start' : node.name ? `"${text(node.name, 40)}"` : `The ${node.type} node ${index + 1}`);
    raw.forEach((node, index) => {
      if (!node || !NODE_TYPES[node.type] || !NODE_ID.test(String(node.id)) || nodes.some((n) => n.id === node.id)) throw fail('The drawing is damaged: a node has no proper id or kind');
      const place = (v) => Math.min(Math.max(Math.round(Number(v) || 0), 0), CANVAS);
      const clean = { id: node.id, type: node.type, x: place(node.x), y: place(node.y), config: this.#config(node.type, node.config, label(node, index), { loading }) };
      const nodeName = text(node.name, 40);
      if (nodeName) {
        if (/['"{}]/.test(nodeName)) throw fail(`${label(node, index)}: a node's name cannot have quotes or braces in it`);
        if (names.has(nodeName.toLowerCase())) throw fail(`Two nodes are called "${nodeName}" - names must differ so {{ node('${nodeName}') }} knows which`);
        names.add(nodeName.toLowerCase());
        clean.name = nodeName;
      }
      if (node.disabled === true && node.type !== 'trigger' && node.type !== 'note') clean.disabled = true;
      if (!NO_RETRY.has(node.type)) {
        const retries = Math.round(Number(node.retries) || 0);
        if (retries > 0) clean.retries = Math.min(retries, 3);
      }
      if (node.onError === 'continue' && node.type !== 'trigger' && node.type !== 'note') clean.onError = 'continue';
      if (node.pinned !== undefined && node.pinned !== null && node.type !== 'note') {
        if (toText(node.pinned).length > PIN_CHARS) throw fail(`${label(node, index)}: pinned data is limited to ${PIN_CHARS / 1000} KB`);
        clean.pinned = node.pinned;
      }
      if (node.type === 'note') {
        clean.w = Math.min(Math.max(Math.round(Number(node.w) || 220), 140), 800);
        clean.h = Math.min(Math.max(Math.round(Number(node.h) || 120), 60), 800);
      }
      nodes.push(clean);
    });
    if (nodes.filter((n) => n.type === 'trigger').length !== 1) throw fail('A flow has exactly one start');
    if (nodes.filter((n) => MODEL.has(n.type)).length > MAX_AGENT_NODES) throw fail(`At most ${MAX_AGENT_NODES} agent nodes in a flow (AI nodes count too) - each one calls a model`);

    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges = [];
    for (const edge of Array.isArray(input.edges) ? input.edges : []) {
      const from = byId.get(edge?.from);
      const to = byId.get(edge?.to);
      const port = String(edge?.port ?? 'out');
      if (!from || !to || from === to) continue; // a wire to a node that was deleted
      if (from.type === 'note' || to.type === 'note') continue;
      if (!outPorts(from).includes(port)) continue;
      if (to.type === 'trigger') throw fail('Nothing can be wired into the start');
      if (port === 'tool' && to.type !== 'agent') throw fail('An app can be plugged in as a tool only on an agent node');
      if (edges.some((e) => e.from === from.id && e.to === to.id && e.port === port)) continue;
      edges.push({ from: from.id, to: to.id, port });
    }
    const main = edges.filter((e) => e.port !== 'tool');

    // No loops: follow the wires from every node and never arrive back.
    const state = new Map();
    const visit = (nodeId) => {
      if (state.get(nodeId) === 'done') return;
      if (state.get(nodeId) === 'open') throw fail('The wires form a loop. A flow can branch, but it cannot go round in a circle.');
      state.set(nodeId, 'open');
      for (const edge of main) if (edge.from === nodeId) visit(edge.to);
      state.set(nodeId, 'done');
    };
    nodes.forEach((n) => visit(n.id));

    for (const node of nodes) {
      const wired = main.some((e) => e.from === node.id || e.to === node.id);
      if (node.type === 'app' && wired && !node.config.tool) throw fail(`The ${node.config.connection} node is on the line but has no action chosen. Pick what it should do, or plug it into an agent as a tool instead.`);
      if (node.type === 'agent') {
        const tools = new Set(edges.filter((e) => e.port === 'tool' && e.to === node.id).map((e) => byId.get(e.from).config.connection));
        if (tools.size > MAX_AGENT_TOOLS) throw fail(`An agent node can have at most ${MAX_AGENT_TOOLS} apps plugged in - each adds its tools to every prompt`);
      }
      if (node.type === 'flow' && node.config.flow === id) throw fail('A flow cannot run itself');
    }

    const tags = [...new Set((Array.isArray(input.tags) ? input.tags : []).map((t) => text(t, 20).toLowerCase()).filter((t) => /^[\w -]{1,20}$/.test(t)))].slice(0, 5);
    const onFail = text(input.onFail, 20);
    if (onFail && onFail === id) throw fail('A flow cannot be its own "if it fails" flow');
    if (onFail && !loading && !this.#list.some((f) => f.id === onFail)) throw fail('The flow to run when this one fails no longer exists');
    return { name, nodes, edges, tags, description: text(input.description, 300), onFail };
  }

  /** Flows that run flows (and "if it fails" flows) must never come back round to where they began. */
  #checkCalls(id, clean) {
    const calls = (flow) => [...flow.nodes.filter((n) => n.type === 'flow').map((n) => n.config.flow), ...(flow.onFail ? [flow.onFail] : [])];
    const graph = new Map(this.#list.map((f) => [f.id, calls(f)]));
    graph.set(id, calls(clean));
    const seen = new Set();
    const walk = (at, path) => {
      for (const next of graph.get(at) ?? []) {
        if (next === id) throw fail(`That would make "${clean.name}" run itself again through another flow`);
        if (path.length > 12 || seen.has(`${at}>${next}`)) continue;
        seen.add(`${at}>${next}`);
        walk(next, [...path, next]);
      }
    };
    walk(id, [id]);
  }

  #get(id) {
    const flow = this.#list.find((f) => f.id === id);
    if (!flow) throw fail('No such flow', 404);
    return flow;
  }

  #view(flow) {
    const { cursor, ...rest } = flow;
    return { ...JSON.parse(JSON.stringify(rest)), running: this.#running.has(flow.id), waiting: this.#queues.get(flow.id)?.length ?? 0 };
  }

  list() {
    return this.#list.map((flow) => this.#view(flow));
  }

  /** The runs of one flow, newest first. */
  runs(id) {
    this.#get(id);
    return this.#history[id] ?? [];
  }

  /** Create a flow (no id) or change one. */
  async save(input = {}, id = null) {
    if (!this.enabled) throw fail('Flows are set up in the dashboard', 409);
    const newId = id ?? crypto.randomBytes(6).toString('hex');
    const clean = this.#clean(input, { id: newId });
    this.#checkCalls(newId, clean);
    let flow;
    if (id) {
      flow = this.#get(id);
      // A start that watches something else starts afresh: what is already there is not new.
      if (!sameJson(this.#trigger(flow), clean.nodes.find((n) => n.type === 'trigger').config)) flow.cursor = null;
      Object.assign(flow, clean);
    } else {
      if (this.#list.length >= MAX_FLOWS) throw fail(`At most ${MAX_FLOWS} flows`, 409);
      flow = { id: newId, ...clean, enabled: true, lastRun: null, runs: 0, cursor: null };
      this.#list.push(flow);
    }
    flow.nextRunAt = this.#due(flow, this.now());
    flow.pollAt = this.now();
    await this.#save();
    this.#changed();
    return this.#view(flow);
  }

  async remove(id) {
    const flow = this.#get(id);
    const users = this.#list.filter((f) => f !== flow && (f.onFail === id || f.nodes.some((n) => n.type === 'flow' && n.config.flow === id)));
    if (users.length) throw fail(`"${users[0].name}" uses this flow - change that one first`, 409);
    this.#running.get(id)?.abort();
    this.#list = this.#list.filter((f) => f !== flow);
    delete this.#history[id];
    this.#queues.delete(id);
    this.#saveHistory();
    await this.#save();
    this.#changed();
    return { removed: id };
  }

  async setEnabled(id, enabled) {
    const flow = this.#get(id);
    flow.enabled = Boolean(enabled);
    flow.nextRunAt = this.#due(flow, this.now());
    flow.pollAt = this.now();
    if (flow.enabled) flow.cursor = null; // switched back on: only what happens from now
    await this.#save();
    this.#changed();
    return this.#view(flow);
  }

  /** Start a flow by hand. Answers at once; the result arrives as events. Pinned data stands in for its nodes. */
  runNow(id, { pins = true } = {}) {
    const flow = this.#get(id);
    if (this.#running.has(flow.id)) throw fail(`"${flow.name}" is still running`, 409);
    return this.#launch(flow, '', { source: 'manual', pins });
  }

  /** Stop a running flow after the node it is on (a wait or a request stops at once). */
  stop(id) {
    const controller = this.#running.get(this.#get(id).id);
    if (!controller) throw fail('It is not running', 409);
    controller.abort();
    this.#queues.delete(id);
    return { stopping: id };
  }

  /**
   * A trigger fired. If flows are tied to it they run with what it delivered as their input,
   * and the caller gets a run-like object for the first; otherwise null, and the text is a plain task.
   */
  fromTrigger(triggerId, input, data) {
    const bound = this.#list.filter((f) => f.enabled && this.#trigger(f).kind === 'trigger' && this.#trigger(f).id === triggerId && !this.#running.has(f.id));
    if (!bound.length) return null;
    return bound.map((flow) => this.#launch(flow, data ?? input, { source: 'trigger' }))[0];
  }

  /** Is any enabled flow started by this trigger? (A webhook for a flow may then carry any JSON.) */
  isBound(triggerId) {
    return this.#list.some((f) => f.enabled && this.#trigger(f).kind === 'trigger' && this.#trigger(f).id === triggerId);
  }

  /** Called on a timer (and directly by tests): start every scheduled flow that is due, and ask what polled starts watch. */
  async tick() {
    const now = this.now();
    for (const flow of this.#list) {
      if (!flow.enabled) continue;
      const trigger = this.#trigger(flow);
      if (trigger.kind === 'poll' && (flow.pollAt ?? 0) <= now) {
        flow.pollAt = now + trigger.every * 60000;
        await this.#poll(flow).catch(() => {});
        continue;
      }
      if (flow.nextRunAt == null || flow.nextRunAt > now) continue;
      // Count from now, not from when it was due: a sleeping laptop must not wake to a burst of runs.
      flow.nextRunAt = this.#due(flow, now);
      if (this.#running.has(flow.id)) continue; // the last round is still going: skip this one
      this.#launch(flow, '', { source: 'schedule' });
    }
  }

  /** What a polled start finds. The first look only notes what is there; after that, each new item starts the flow once. */
  async #fetchItems(trigger, signal) {
    if (trigger.poller === 'app') {
      const answer = String(await this.toolbox().call(trigger.tool, JSON.parse(trigger.args)));
      if (answer.startsWith('ERROR:')) throw new Error(answer.slice(6).trim() || 'the tool reported an error');
      return [{ key: crypto.createHash('sha256').update(answer).digest('hex').slice(0, 16), data: parseMaybe(answer) }];
    }
    const cred = trigger.credential ? this.credentials?.get(trigger.credential) : null;
    return POLLERS[trigger.poller].run({ c: trigger, cred, fetch: this.fetch, signal });
  }

  async #poll(flow) {
    const trigger = this.#trigger(flow);
    let found;
    try {
      found = await this.#fetchItems(trigger);
      flow.pollError = null;
    } catch (err) {
      flow.pollError = clip(String(err.message), 200);
      this.#changed();
      return;
    }
    const cursor = flow.cursor ?? { seen: [], primed: false };
    const seen = new Set(cursor.seen);
    if (!cursor.primed) {
      for (const item of found) seen.add(item.key);
    } else {
      const fresh = found.filter((item) => !seen.has(item.key)).reverse(); // oldest first
      const queue = this.#queues.get(flow.id) ?? [];
      for (const item of fresh.slice(0, POLL_BATCH)) {
        if (queue.length >= QUEUE_MAX) break;
        queue.push(item.data);
        seen.add(item.key);
      }
      this.#queues.set(flow.id, queue);
    }
    flow.cursor = { seen: [...seen].slice(-SEEN_CAP), primed: true };
    await this.#save().catch(() => {});
    this.#drain(flow);
    this.#changed();
  }

  #drain(flow) {
    const queue = this.#queues.get(flow.id);
    if (!queue?.length || this.#running.has(flow.id) || !flow.enabled || !this.#list.includes(flow)) return;
    this.#launch(flow, queue.shift(), { source: this.#trigger(flow).kind === 'file' ? 'file' : 'poll' });
  }

  /** Files in the folder changed: start the flows that watch them, but never because of a flow's own work. */
  #onFiles(paths) {
    if (this.#running.size || Date.now() - this.#lastFlowEnd < FILE_QUIET_MS) return;
    const real = paths.filter((p) => p && !p.startsWith('.kadhai/'));
    if (!real.length) return;
    for (const flow of this.#list) {
      const trigger = this.#trigger(flow);
      if (!flow.enabled || trigger.kind !== 'file') continue;
      const want = trigger.path;
      const hits = real.filter((p) => !want || p === want || p.startsWith(want.endsWith('/') ? want : `${want}/`) || (want.startsWith('*.') && p.endsWith(want.slice(1))));
      if (!hits.length) continue;
      if (Date.now() - (flow.fileAt ?? 0) < FILE_GAP_MS) continue;
      // A burst of writes is one change: wait for it to settle.
      clearTimeout(this.#fileTimer.get(flow.id));
      const pending = new Set([...(flow.filePending ?? []), ...hits]);
      flow.filePending = pending;
      this.#fileTimer.set(
        flow.id,
        setTimeout(() => {
          this.#fileTimer.delete(flow.id);
          const changed = [...(flow.filePending ?? [])];
          flow.filePending = null;
          if (this.#running.size) return;
          flow.fileAt = Date.now();
          const queue = this.#queues.get(flow.id) ?? [];
          if (queue.length < QUEUE_MAX) queue.push({ paths: changed.slice(0, 50), at: new Date(this.now()).toISOString() });
          this.#queues.set(flow.id, queue);
          this.#drain(flow);
        }, 2000),
      );
    }
  }

  // ---------------------------------------------------------------- running

  #record(flow, source, pins) {
    return { id: crypto.randomBytes(4).toString('hex'), at: this.now(), source, pins: Boolean(pins), ok: false, ms: 0, nodes: {}, result: '', failedAt: null, stopped: false };
  }

  #remember(flow, record) {
    const list = [record, ...(this.#history[flow.id] ?? []).filter((r) => r.id !== record.id)].slice(0, RUNS_KEPT);
    this.#history[flow.id] = list;
    this.#saveHistory();
  }

  #launch(flow, input, { source, pins = false } = {}) {
    const controller = new AbortController();
    this.#running.set(flow.id, controller);
    const record = this.#record(flow, source, pins);
    flow.lastRun = record;
    this.#changed();
    const started = Date.now();
    const done = this.#execute(flow, input ?? '', record, { pins, signal: controller.signal })
      .catch((err) => ({ ok: false, reply: `[!] ${err.message}` }))
      .then(async (result) => {
        this.#running.delete(flow.id);
        this.#lastFlowEnd = Date.now();
        flow.runs = (flow.runs ?? 0) + 1;
        Object.assign(record, { ok: result.ok, ms: Date.now() - started, result: clip(result.reply, OUTPUT_CHARS) });
        this.#remember(flow, record);
        await this.#save().catch((err) => log.warn(`Could not save flows: ${err.message}`));
        this.#changed();
        // A flow of its own for failures: told what failed, where and why.
        if (!result.ok && !record.stopped && flow.onFail && source !== 'error') {
          const handler = this.#list.find((f) => f.id === flow.onFail);
          const failed = flow.nodes.find((n) => n.id === record.failedAt);
          if (handler && !this.#running.has(handler.id)) this.#launch(handler, { flow: flow.name, node: failed?.name ?? failed?.type ?? '', error: record.nodes[record.failedAt]?.output ?? result.reply, at: new Date(record.at).toISOString() }, { source: 'error' });
        }
        setImmediate(() => this.#drain(flow));
        return result;
      });
    return { id: record.id, queued: false, done };
  }

  /** Data a node can quote: every node's output by name and by id. */
  #nodesView(nodes, outputs) {
    const view = {};
    for (const n of nodes) {
      if (!outputs.has(n.id)) continue;
      view[n.id] = outputs.get(n.id);
      if (n.name) view[n.name] = outputs.get(n.id);
    }
    return view;
  }

  /** What one node does with what reached it. Returns { data, port?, stop?, logs? } or throws. */
  async #runNode(flow, node, input, ctx, { edges, byId, inputs, signal, depth, stack, dry = false }) {
    const { config } = node;
    if (node.type === 'trigger') return { data: input };
    if (dry) {
      const held = this.#held(node, input, ctx);
      if (held) return held;
    }

    if (node.type === 'agent') {
      // The apps plugged into its tools port are the connections this work may use.
      const tools = [...new Set(edges.filter((e) => e.port === 'tool' && e.to === node.id).map((e) => byId.get(e.from).config.connection))];
      const run = this.start(`${fill(config.text, ctx)}\n\n(Part of the flow "${flow.name}".)`, { source: 'flow', cook: config.agent || undefined, tools: tools.length ? tools : undefined });
      const result = await run.done;
      if (!result.ok) throw new Error(result.reply || 'the crew could not finish it');
      return { data: result.reply };
    }

    if (node.type === 'ai') {
      const system = [
        'You are one step of an automation. Do exactly what is asked with the data given, and answer with the result only: no greeting, no explanation of what you did.',
        config.json ? 'Answer with one JSON object or array and nothing else.' : '',
        config.system,
      ].filter(Boolean).join('\n');
      const out = await this.crew.call(config.agent || 'commis', { system, user: clip(fill(config.prompt, ctx), 12000), json: config.json, task: `flow "${flow.name}": ${node.name ?? 'AI step'}`, signal, maxTokens: this.#limits().flowAiTokens ?? 2000 });
      if (!config.json) return { data: out.text.trim() };
      const parsed = extractJson(out.text);
      if (parsed == null) throw new Error('the model did not answer with JSON');
      return { data: parsed };
    }

    if (node.type === 'app') {
      const args = JSON.parse(fill(config.args, ctx, jsonEscape));
      const result = String(await this.toolbox().call(config.tool, args));
      if (result.startsWith('ERROR:')) throw new Error(result.slice(6).trim() || 'the tool reported an error');
      return { data: parseMaybe(result) };
    }

    if (node.type === 'service') {
      const action = SERVICES[config.service].actions[config.action];
      const params = Object.fromEntries(action.fields.map((field) => [field.id, field.fixed ? config.params[field.id] : value(config.params[field.id], ctx)]));
      const cred = config.credential ? this.credentials?.get(config.credential) : null;
      return { data: await runService(config, params, { cred, fetch: this.fetch, signal }) };
    }

    if (node.type === 'if') return { data: input, port: testAll(config.conditions, config.combine, ctx) ? 'true' : 'false' };
    if (node.type === 'filter') return testAll(config.conditions, config.combine, ctx) ? { data: input } : { data: input, stop: true };
    if (node.type === 'switch') {
      const hit = config.rules.findIndex((rule) => testAll([rule], 'and', ctx));
      return { data: input, port: hit < 0 ? 'else' : String(hit + 1) };
    }

    if (node.type === 'merge') {
      if (config.mode === 'text') return { data: inputs.map(toText).join(config.separator ? config.separator.replace(/\\n/g, '\n') : '\n\n') };
      if (config.mode === 'combine') {
        const out = {};
        inputs.forEach((v, i) => {
          const parsed = parseMaybe(v);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) Object.assign(out, parsed);
          else out[`input${i + 1}`] = parsed;
        });
        return { data: out };
      }
      return { data: inputs.flatMap((v) => (Array.isArray(v) ? v : [v])) };
    }

    if (node.type === 'set') {
      const base = parseMaybe(input);
      const out = config.keep && base && typeof base === 'object' && !Array.isArray(base) ? structuredClone(base) : {};
      for (const field of config.fields) setPath(out, field.key, value(field.value, ctx));
      return { data: out };
    }

    if (node.type === 'code') {
      const { result, logs } = await runCode(config.code, { input: parseMaybe(input), trigger: ctx.trigger, nodes: ctx.nodes() }, signal);
      return { data: result, logs };
    }

    if (node.type === 'wait') {
      await sleep(config.seconds * 1000, signal);
      return { data: input };
    }

    if (node.type === 'flow') {
      const target = this.#get(config.flow);
      if (depth + 1 > MAX_DEPTH) throw new Error(`flows may run other flows only ${MAX_DEPTH} deep`);
      if (stack.includes(target.id)) throw new Error(`"${target.name}" is already running in this chain`);
      const sub = this.#record(target, 'flow', false);
      const started = Date.now();
      const result = await this.#execute(target, input, sub, { depth: depth + 1, stack: [...stack, target.id], signal });
      Object.assign(sub, { ok: result.ok, ms: Date.now() - started, result: clip(result.reply, OUTPUT_CHARS) });
      this.#remember(target, sub);
      if (!result.ok) throw new Error(`"${target.name}" failed: ${result.reply.replace(/^\[!\]\s*/, '')}`);
      return { data: result.data };
    }

    if (node.type === 'file') {
      if (!this.workspace) throw new Error('there is no folder open');
      if (config.op === 'read') {
        const file = await this.workspace.readFile(config.path);
        if (file.binary) throw new Error(`${config.path} is not a text file`);
        return { data: parseMaybe(file.content) };
      }
      let content = toText(value(config.content, ctx));
      if (config.op === 'append') {
        const before = await this.workspace.readFile(config.path).then((f) => f.content, () => '');
        content = before && !before.endsWith('\n') ? `${before}\n${content}` : before + content;
      }
      await this.workspace.writeFile(config.path, content, { owner: `flow:${flow.id}` });
      return { data: { path: config.path, chars: content.length } };
    }

    if (node.type === 'command') {
      if (!this.runner) throw new Error('commands cannot run here');
      const out = await this.runner.run(config.command, { owner: 'flow', signal });
      const output = clip(out.output ?? '', 20000);
      if (config.failOnError && out.code !== 0) throw new Error(`exited with ${out.timedOut ? 'a time-out' : out.code}${output.trim() ? `: ${clip(output.trim().split('\n').slice(-3).join(' '), 300)}` : ''}`);
      return { data: { code: out.code, output } };
    }

    // http: the address is fixed by the user; only the query and the body carry text from the flow.
    const u = new URL(config.url);
    for (const q of config.query ?? []) u.searchParams.append(q.key, fill(q.value, ctx));
    const headers = { 'user-agent': 'kadhai/1.0', ...Object.fromEntries((config.headers ?? []).map((h) => [h.key.toLowerCase(), h.value])) };
    const cred = config.credential ? this.credentials?.get(config.credential) : null;
    const url = applyCredential(cred, u.href, headers);
    let body;
    if (config.bodyType === 'json' || (config.bodyType == null && config.method === 'POST')) {
      body = fill(config.body || '{"text": "{{ input }}"}', ctx, jsonEscape);
      headers['content-type'] ??= 'application/json';
    } else if (config.bodyType === 'text') {
      body = fill(config.body, ctx);
      headers['content-type'] ??= 'text/plain; charset=utf-8';
    }
    const data = await request(this.fetch, url, { method: config.method, headers, body, signal, name: u.host });
    return { data: typeof data === 'string' ? clip(data, 20000) : data };
  }

  /**
   * "Try once": a node that would send, write, change, run or wait is not run - it hands on
   * what it would have done, with the data filled in. Null for a node that only reads or thinks
   * (reading services, GET requests, file reads, AI, logic), which runs for real.
   */
  #held(node, input, ctx) {
    const c = node.config;
    const would = (data) => ({ data, held: true });
    const fillJson = (t) => {
      const filled = fill(t, ctx, jsonEscape);
      return parseMaybe(filled);
    };
    switch (node.type) {
      case 'service': {
        const service = SERVICES[c.service];
        const action = service.actions[c.action];
        if (action.reads) return null;
        return would({ would: `${service.label}: ${action.label}`, ...Object.fromEntries(action.fields.map((f) => [f.id, f.fixed ? c.params[f.id] : value(c.params[f.id], ctx)])) });
      }
      case 'http':
        if (c.method === 'GET') return null;
        return would({ would: `${c.method} ${c.url}`, ...(c.bodyType === 'json' ? { body: fillJson(c.body || '{"text": "{{ input }}"}') } : c.bodyType === 'text' ? { body: fill(c.body, ctx) } : {}) });
      case 'file':
        return c.op === 'read' ? null : would({ would: `${c.op} ${c.path}`, content: toText(value(c.content, ctx)) });
      case 'command': return would({ would: 'run a command (after your OK)', command: c.command });
      case 'agent': return would({ would: 'give the crew this task', task: fill(c.text, ctx) });
      case 'app': return would({ would: `call ${c.tool}`, args: fillJson(c.args) });
      case 'flow': return would({ would: `run the flow "${this.#list.find((f) => f.id === c.flow)?.name ?? c.flow}"` });
      case 'wait': return { data: input, held: true, note: `did not wait ${c.seconds} s` };
      default: return null;
    }
  }

  /**
   * Run a drawing (saved or not) once, without side effects: what reads or thinks runs, what
   * would send or change anything is held back (see #held). The start gets what it would deliver
   * now. Nothing is saved, nothing goes into the history; the record comes back for the canvas.
   */
  async tryOnce(draft) {
    if (!this.enabled) throw fail('Flows are set up in the dashboard', 409);
    const clean = this.#clean({ ...draft, name: text(draft?.name, 50).length >= 2 ? draft.name : 'Draft' }, { loading: true, id: draft?.id ?? null });
    const flow = { ...clean, id: draft?.id ?? 'draft' };
    const start = await this.#sampleStart(clean.nodes.find((n) => n.type === 'trigger').config);
    const record = this.#record(flow, 'try', false);
    if (!start.ok) {
      const id = clean.nodes.find((n) => n.type === 'trigger').id;
      record.nodes[id] = { status: 'failed', input: '', output: clip(start.error, OUTPUT_CHARS), ms: start.ms };
      return { ...record, failedAt: id, result: `[!] ${start.error}` };
    }
    const started = Date.now();
    const result = await this.#execute(flow, start.output ?? '', record, { dry: true, signal: AbortSignal.timeout(180000) });
    return { ...record, ok: result.ok, ms: Date.now() - started, result: clip(result.reply, OUTPUT_CHARS), startNote: start.note ?? '' };
  }

  /** The flame's bounds as they are now (high flame raises the drawing and AI-node ones). */
  #limits() {
    return this.crew?.dispatcher?.limits ?? {};
  }

  /** A node, tried again a few times if the user asked for that (never one that calls a model or needs an approval). */
  async #attempt(node, run, signal) {
    const tries = 1 + (NO_RETRY.has(node.type) ? 0 : node.retries ?? 0);
    for (let i = 1; ; i++) {
      try {
        return await run();
      } catch (err) {
        if (i >= tries || signal?.aborted) throw err;
        await sleep(RETRY_WAIT_MS, signal);
      }
    }
  }

  /**
   * One round. Nodes run in an order that respects the wires, each at most once; a node runs
   * when at least one wire delivered something to it. The first node that fails ends the round,
   * unless it is set to carry on.
   */
  async #execute(flow, triggerData, record, { pins = false, signal, depth = 0, stack = [flow.id], dry = false } = {}) {
    // A copy: editing the flow while it runs changes the next round, not this one.
    const { nodes, edges } = structuredClone({ nodes: flow.nodes.filter((n) => n.type !== 'note'), edges: flow.edges });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const main = edges.filter((e) => e.port !== 'tool');
    const byName = new Map(nodes.filter((n) => n.name).map((n) => [n.name.toLowerCase(), n.id]));

    // Order: a node comes after everything wired into it. Ties go top to bottom, left to right, as drawn.
    const waiting = new Map(nodes.map((n) => [n.id, main.filter((e) => e.to === n.id).length]));
    const ready = nodes.filter((n) => waiting.get(n.id) === 0);
    const order = [];
    while (ready.length) {
      ready.sort((a, b) => a.y - b.y || a.x - b.x);
      const node = ready.shift();
      order.push(node);
      for (const edge of main.filter((e) => e.from === node.id)) {
        waiting.set(edge.to, waiting.get(edge.to) - 1);
        if (waiting.get(edge.to) === 0) ready.push(byId.get(edge.to));
      }
    }

    const outputs = new Map();
    const arrived = new Map([[nodes.find((n) => n.type === 'trigger').id, [triggerData]]]);
    let last = triggerData;
    for (const node of order) {
      if (!arrived.has(node.id)) continue; // nothing reached it: not on the path taken this round
      if (signal?.aborted) {
        record.stopped = true;
        return { ok: false, reply: '[!] stopped' };
      }
      const inputs = arrived.get(node.id);
      const input = combine(inputs);
      const ctx = {
        input: parseMaybe(input),
        trigger: parseMaybe(triggerData),
        node: (name) => outputs.get(byName.get(String(name).toLowerCase()) ?? name),
        nodes: () => this.#nodesView(nodes, outputs),
        now: this.now,
      };
      const started = Date.now();
      record.nodes[node.id] = { status: 'running', input: keep(input, DATA_CHARS) };
      this.#changed();
      let out;
      try {
        if (pins && node.pinned !== undefined) out = { data: node.pinned, pinned: true, port: node.type === 'if' ? 'true' : node.type === 'switch' ? '1' : undefined };
        else if (node.disabled) out = { data: input, skipped: true, port: node.type === 'if' ? 'true' : node.type === 'switch' ? '1' : undefined };
        else out = await this.#attempt(node, () => this.#runNode(flow, node, input, ctx, { edges, byId, inputs, signal, depth, stack, dry }), signal);
      } catch (err) {
        const message = signal?.aborted ? 'stopped' : String(err.message);
        record.nodes[node.id] = { status: 'failed', input: keep(input, DATA_CHARS), output: clip(message, OUTPUT_CHARS), ms: Date.now() - started };
        if (signal?.aborted) {
          record.stopped = true;
          return { ok: false, reply: '[!] stopped' };
        }
        if (node.onError !== 'continue') {
          record.failedAt = node.id;
          return { ok: false, reply: `[!] ${message}` };
        }
        // Carry on: what failed travels on as { error }, down the node's first port.
        out = { data: { error: message }, port: outPorts(node)[0] === 'out' ? undefined : outPorts(node)[0], failed: true };
      }
      outputs.set(node.id, out.data);
      if (!out.failed) {
        record.nodes[node.id] = {
          status: 'ok',
          input: keep(input, DATA_CHARS),
          output: keep(out.data, DATA_CHARS),
          port: out.port,
          ms: Date.now() - started,
          items: out.stop ? 0 : items(out.data),
          ...(out.held ? { note: out.note ?? 'held back: this is what it would do', held: true } : out.pinned ? { note: 'pinned data' } : out.skipped ? { note: 'switched off: passed on unchanged' } : out.stop ? { note: 'stopped here: the conditions did not hold' } : {}),
          ...(out.logs?.length ? { logs: out.logs } : {}),
        };
      }
      if (out.stop) continue;
      if (node.type !== 'trigger') last = out.data;
      for (const edge of main.filter((e) => e.from === node.id && (e.port === 'out' || e.port === out.port))) {
        arrived.set(edge.to, [...(arrived.get(edge.to) ?? []), out.data]);
      }
    }
    return { ok: true, reply: toText(last), data: last };
  }

  // ------------------------------------------------------- trying things out

  /**
   * Run one node of a drawing (saved or not) on the data given (a test step).
   * Nothing is saved. Agent, AI and command nodes do their real work, so the browser asks first.
   */
  async testNode(draft, nodeId, { input = '', trigger = '', nodes: given = {} } = {}) {
    if (!this.enabled) throw fail('Flows are set up in the dashboard', 409);
    const clean = this.#clean({ ...draft, name: text(draft?.name, 50).length >= 2 ? draft.name : 'Draft' }, { id: draft?.id ?? null });
    const node = clean.nodes.find((n) => n.id === nodeId);
    if (!node) throw fail('That node is not in the drawing', 404);
    if (node.type === 'note') throw fail('A note does not run');
    const byId = new Map(clean.nodes.map((n) => [n.id, n]));
    const byName = new Map(clean.nodes.filter((n) => n.name).map((n) => [n.name.toLowerCase(), n.id]));
    const outputs = new Map(Object.entries(given ?? {}));
    if (node.type === 'trigger') return this.#sampleStart(node.config);
    const ctx = {
      input: parseMaybe(input),
      trigger: parseMaybe(trigger),
      node: (name) => outputs.get(byName.get(String(name).toLowerCase()) ?? name),
      nodes: () => this.#nodesView(clean.nodes, outputs),
      now: this.now,
    };
    const started = Date.now();
    try {
      const out = await this.#runNode({ ...clean, id: draft?.id ?? 'draft' }, node, input, ctx, { edges: clean.edges, byId, inputs: [input], depth: 0, stack: [draft?.id ?? 'draft'] });
      return { ok: true, output: keep(out.data, PIN_CHARS), port: out.port, stopped: Boolean(out.stop), logs: out.logs ?? [], ms: Date.now() - started };
    } catch (err) {
      return { ok: false, error: String(err.message), ms: Date.now() - started };
    }
  }

  /**
   * "Describe a flow": the Chef draws one from plain words. One model call, and one more only
   * if the answer does not hold together (told why). Nothing is saved: the result opens in the
   * canvas as an unsaved draft, with the nodes the user must look at marked (see flowDraft.js).
   */
  async draft(request, { base: given = null, failure = null, id = null } = {}) {
    if (!this.enabled) throw fail('Flows are set up in the dashboard', 409);
    const ask = String(request ?? '').trim();
    if (ask.length < (given ? 3 : 8)) throw fail(given ? 'Say what to change' : 'Say in a sentence or two what the flow should do');
    if (ask.length > DRAFT_INPUT_CHARS) throw fail(`Keep it under ${DRAFT_INPUT_CHARS} characters`);
    if (this.busy()) throw fail('The crew is cooking - ask again when the run is done', 409);
    const { draftCalls = 2, draftCatalogChars = 9000 } = this.#limits();
    const system = draftSystem({ apps: this.toolbox?.()?.tools?.() ?? [], flows: this.#list.map((f) => ({ id: f.id, name: f.name })), catalogChars: draftCatalogChars });
    const agents = new Set([...this.crew.agents.keys()]);
    // Changing a flow: the drawing on the canvas (saved or not), checked like any other.
    const base = given ? { ...this.#clean({ ...given, name: text(given.name, 50).length >= 2 ? given.name : 'Draft' }, { loading: true, id }), description: given.description ?? '', tags: given.tags ?? [], onFail: given.onFail ?? '' } : null;
    const flowId = id && this.#list.some((f) => f.id === id) ? id : 'draft';
    let retry = null;
    for (let attempt = 0; attempt < draftCalls; attempt++) {
      const out = await this.crew.call('general-manager', { system, user: draftUser(ask, retry, { base, failure }), json: true, task: `${base ? (failure ? 'Fixing' : 'Changing') : 'Drawing'} a flow${attempt ? ' (again)' : ''}`, maxTokens: 4000 });
      try {
        const shaped = shapeDraft(extractJson(out.text), { agents, base });
        const notes = shaped.notes;
        const clean = this.#clean(base ? mergeWithBase(shaped.flow, base) : shaped.flow, { loading: true, id: flowId === 'draft' ? null : flowId });
        const merged = base ? diffFlows(base, clean) : null;
        this.#checkCalls(flowId, clean);
        // Data quoted from a node that never runs before it: worth a retry while there is one; on the last try, marked instead.
        const refs = badReferences(clean);
        if (refs.length && attempt < draftCalls - 1) throw fail(refs.map((r) => r.text).join('. '));
        // On a change, only what the Chef touched is marked: the rest is as the user left it.
        const looked = merged ? { ...clean, nodes: clean.nodes.filter((n) => merged.touched.has(n.id)) } : clean;
        const marks = [...refs, ...(merged ? [...merged.touched].map((node) => ({ node, text: `${clean.nodes.find((n) => n.id === node)?.name || (node === clean.nodes.find((n) => n.type === 'trigger')?.id ? 'The start' : 'This node')}: ${base.nodes.some((n) => n.id === node) ? 'changed' : 'added'} by the Chef` })) : []), ...attention(looked, { credentials: this.credentials?.list?.() ?? [], request: ask })];
        for (const node of clean.nodes) {
          const mine = marks.filter((m) => m.node === node.id).map((m) => m.text);
          if (mine.length) node.check = mine.join('; ');
        }
        return { flow: clean, notes, todo: marks.map((m) => m.text).filter((t) => !/ by the Chef$/.test(t)), ...(merged ? { changes: merged.changes } : {}) };
      } catch (err) {
        if (err.status && err.status !== 400) throw err;
        retry = { error: clip(String(err.message), 300) };
      }
    }
    throw fail(`The Chef could not ${base ? 'change the flow so that it holds' : 'draw a flow that holds'} together (${retry.error}). Try saying it another way, or ${base ? 'change it' : 'draw it'} by hand.`, 422);
  }

  /** "Fetch a test event": what a polled start would deliver right now, without marking anything as seen. */
  async #sampleStart(config) {
    const started = Date.now();
    try {
      if (config.kind === 'poll') {
        const found = await this.#fetchItems(config);
        return { ok: true, output: keep(found[0]?.data ?? null, PIN_CHARS), ms: Date.now() - started, note: found.length ? `${found.length} item(s) there now; this is the newest. Only ones that appear after the flow is switched on will start it.` : 'Nothing there right now.' };
      }
      if (config.kind === 'file') return { ok: true, output: { paths: [config.path || 'some/file.txt'], at: new Date(this.now()).toISOString() }, ms: 0, note: 'An example of what a file change delivers.' };
      if (config.kind === 'trigger') return { ok: true, output: { text: 'what the trigger received' }, ms: 0, note: 'An example: a webhook delivers the JSON it was sent; GitHub, Linear and Telegram deliver their message.' };
      return { ok: true, output: '', ms: 0, note: 'A flow started by hand or on a schedule begins with nothing; use {{ now }} for the time.' };
    } catch (err) {
      return { ok: false, error: String(err.message), ms: Date.now() - started };
    }
  }
}

/**
 * The operations of an OpenAPI (JSON) description, for the HTTP node's import.
 * YAML is not read: Kadhai has no YAML parser and adds no dependency for one.
 */
export async function readOpenApi({ url, textBody }, fetch) {
  let spec;
  if (textBody) {
    try {
      spec = JSON.parse(textBody);
    } catch {
      throw fail('Paste the description as JSON (YAML is not supported)');
    }
  } else {
    let address;
    try {
      address = new URL(String(url ?? ''));
    } catch {
      throw fail('Give the full address of the OpenAPI file');
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname);
    if (address.protocol !== 'https:' && !(address.protocol === 'http:' && local)) throw fail('The address must start with https://');
    const got = await request(fetch, address.href, { headers: { accept: 'application/json' } });
    if (typeof got === 'string') throw fail('That address did not answer with JSON (YAML is not supported)');
    spec = got;
  }
  if (!spec || typeof spec !== 'object' || !spec.paths) throw fail('That is not an OpenAPI or Swagger description: it has no "paths"');
  let base = spec.servers?.[0]?.url ?? (spec.host ? `${spec.schemes?.[0] ?? 'https'}://${spec.host}${spec.basePath ?? ''}` : '');
  // A server given as a path ("/api/v3") is on the host the description came from.
  if (base && !/^https?:\/\//i.test(base) && url) {
    try {
      base = new URL(base, url).href.replace(/\/+$/, '');
    } catch {
      // Left as written; the form asks for a full address.
    }
  }
  const ref = (obj) => {
    let at = obj;
    for (let i = 0; i < 5 && at?.$ref; i++) at = at.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
    return at ?? {};
  };
  const sample = (schema, depth = 0) => {
    const s = ref(schema);
    if (s.example !== undefined) return s.example;
    if (depth > 3) return null;
    if (s.type === 'object' || s.properties) return Object.fromEntries(Object.entries(s.properties ?? {}).slice(0, 15).map(([k, v]) => [k, sample(v, depth + 1)]));
    if (s.type === 'array') return [sample(s.items ?? {}, depth + 1)];
    if (s.enum) return s.enum[0];
    return { integer: 0, number: 0, boolean: false }[s.type] ?? '';
  };
  const operations = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = item?.[method];
      if (!op) continue;
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(ref).filter((p) => p.name && ['path', 'query'].includes(p.in));
      const content = ref(op.requestBody)?.content?.['application/json'];
      const swaggerBody = params.length ? null : (op.parameters ?? []).map(ref).find((p) => p.in === 'body');
      operations.push({
        method: method.toUpperCase(),
        path,
        summary: clip(op.summary ?? op.operationId ?? op.description ?? '', 120),
        params: params.map((p) => ({ name: p.name, in: p.in, required: Boolean(p.required) })),
        body: content?.schema ? sample(content.schema) : swaggerBody?.schema ? sample(swaggerBody.schema) : null,
      });
      if (operations.length >= 400) break;
    }
  }
  return { title: clip(spec.info?.title ?? 'API', 100), base, operations };
}
