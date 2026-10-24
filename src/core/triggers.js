import fs from 'node:fs';
import crypto from 'node:crypto';
import { vaultFor } from './vault.js';
import { clip, log } from './util.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const MAX_TRIGGERS = 12;
const MAX_TASK_CHARS = 4000;
const MAX_PER_POLL = 3; // one burst from outside must not fill the queue
const SEEN_CAP = 300;
const TIMEOUT_MS = 15000;

const one = (value, max = 200) => String(value ?? '').trim().slice(0, max);

/**
 * How a task can arrive from outside the dashboard.
 *
 * The server only listens on this computer and that does not change here:
 * GitHub, Linear and Telegram are *asked* (an outbound request every minute),
 * never allowed to call in. The webhook is for programs on this machine.
 *
 *   checked  'used' = exercised against the real service from Kadhai
 *            'live' = the endpoint answers and rejects a bad token as expected,
 *                     but a full round with a real account has not been tried
 */
export const TRIGGER_TYPES = {
  webhook: {
    label: 'Your own webhook',
    about: 'A script, a scheduled job or another app on this computer sends a task with one HTTP request.',
    checked: 'used',
    fields: [],
    clean: () => ({}),
  },
  github: {
    label: 'GitHub issues',
    about: 'An open issue that carries a label of your choosing becomes a task, once.',
    checked: 'used',
    fields: [
      { id: 'repo', label: 'Repository', placeholder: 'owner/name' },
      { id: 'label', label: 'Label that wakes the crew', placeholder: 'kadhai' },
      { id: 'token', label: 'Access token (only for a private repository)', secret: true, optional: true },
    ],
    clean(input) {
      const repo = one(input.repo, 140);
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw fail('Give the repository as owner/name');
      const label = one(input.label, 50) || 'kadhai';
      if (/[,\r\n]/.test(label)) throw fail('Give one label');
      return { repo, label };
    },
  },
  linear: {
    label: 'Linear issues',
    about: 'An issue that carries a label of your choosing becomes a task, once.',
    checked: 'live',
    fields: [
      { id: 'token', label: 'Personal API key', secret: true },
      { id: 'label', label: 'Label that wakes the crew', placeholder: 'kadhai' },
    ],
    clean: (input) => ({ label: one(input.label, 50) || 'kadhai' }),
  },
  telegram: {
    label: 'Telegram bot',
    about: 'Message your own bot and the crew starts on it; the report comes back as a reply.',
    checked: 'live',
    fields: [
      { id: 'token', label: 'Bot token (from @BotFather)', secret: true },
      { id: 'chats', label: 'Chat ids allowed to give tasks', placeholder: '123456789 (leave empty, message the bot, and the id is shown here)', optional: true },
    ],
    clean(input) {
      const chats = one(input.chats, 300).split(/[\s,]+/).filter(Boolean);
      if (chats.some((id) => !/^-?\d{1,20}$/.test(id))) throw fail('Chat ids are numbers, separated by commas');
      return { chats };
    },
  },
};

/**
 * Triggers: ways to start a run without typing in the dashboard.
 *
 * Whatever arrives is an ordinary task for the Chef - it goes through
 * `start` (the orchestrator), joins the same queue, and its commands are held
 * for approval exactly like any other run's. Text from outside is untrusted:
 * every trigger has a gate (a secret token, a label only collaborators can
 * set, a list of chat ids) so that a stranger cannot hand the crew work.
 */
export class Triggers {
  #list = [];
  #timer = null;
  #polling = false;

  constructor({ file, enabled, bus, start, bound = () => false, fetch = globalThis.fetch, pollMs = 60000 }) {
    this.file = file;
    this.enabled = Boolean(enabled);
    this.bus = bus;
    this.start = start;
    this.bound = bound; // (id) -> is a flow started by this trigger? Then a webhook may carry any JSON.
    this.fetch = (...args) => fetch(...args);
    this.pollMs = pollMs;
  }

  async init() {
    if (!this.enabled) return;
    try {
      const saved = JSON.parse(await fs.promises.readFile(this.file, 'utf8'));
      const vault = vaultFor(this.file);
      this.#list = (Array.isArray(saved.triggers) ? saved.triggers : [])
        .filter((t) => t && TRIGGER_TYPES[t.type] && typeof t.id === 'string')
        .map((t) => ({ ...t, secret: vault.decrypt(t.secret ?? ''), lastError: null }));
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`triggers.local.json ignored: ${err.message}`);
    }
    this.#schedule();
  }

  close() {
    clearInterval(this.#timer);
    this.#timer = null;
  }

  async #save() {
    const vault = vaultFor(this.file);
    const triggers = this.#list.map(({ lastError, ...t }) => ({ ...t, secret: vault.encrypt(t.secret) }));
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, `${JSON.stringify({ triggers }, null, 2)}\n`, { mode: 0o600 });
    await fs.promises.rename(tmp, this.file);
  }

  #changed() {
    this.bus?.publish('triggers:update', {});
  }

  /** Poll only while there is something to ask. */
  #schedule() {
    const needed = this.#list.some((t) => t.enabled && t.type !== 'webhook');
    if (needed && !this.#timer) {
      this.#timer = setInterval(() => this.poll().catch(() => {}), this.pollMs);
      this.#timer.unref();
    } else if (!needed && this.#timer) this.close();
  }

  #get(id) {
    const trigger = this.#list.find((t) => t.id === id);
    if (!trigger) throw fail('No such trigger', 404);
    return trigger;
  }

  #view(t) {
    return {
      id: t.id,
      type: t.type,
      label: TRIGGER_TYPES[t.type].label,
      name: t.name,
      enabled: t.enabled,
      config: { ...t.config },
      hasSecret: Boolean(t.secret),
      // Where a webhook is sent. The token itself is shown once, when the trigger is made.
      path: t.type === 'webhook' ? `/api/hooks/${t.id}` : null,
      fired: t.fired ?? 0,
      lastFiredAt: t.lastFiredAt ?? null,
      lastError: t.lastError ?? null,
      // A chat that wrote to the bot but is not on its list: how the user finds their own chat id.
      stranger: t.cursor?.stranger ?? null,
    };
  }

  /** The kinds there are, for the form. No secrets involved. */
  types() {
    return Object.entries(TRIGGER_TYPES).map(([id, type]) => ({ id, label: type.label, about: type.about, checked: type.checked, fields: type.fields }));
  }

  list() {
    return this.#list.map((t) => this.#view(t));
  }

  async add(input = {}) {
    if (!this.enabled) throw fail('Triggers are set up in the dashboard', 409);
    const type = TRIGGER_TYPES[input.type];
    if (!type) throw fail('Pick what should wake the crew');
    if (this.#list.length >= MAX_TRIGGERS) throw fail(`At most ${MAX_TRIGGERS} triggers`, 409);
    const config = type.clean(input);
    const secretField = type.fields.find((f) => f.secret);
    const typed = one(input.token, 400);
    if (secretField && !secretField.optional && !typed) throw fail(`${secretField.label} is needed`);
    if (/\s/.test(typed)) throw fail('A token has no spaces in it');

    const trigger = {
      id: crypto.randomBytes(8).toString('hex'),
      type: input.type,
      name: one(input.name, 40) || type.label,
      enabled: true,
      // A webhook gets a token of its own; the others keep the one the user pasted.
      secret: input.type === 'webhook' ? crypto.randomBytes(24).toString('base64url') : typed,
      config,
      // Start from now: what already exists out there is not a backlog to work through.
      cursor: { since: new Date().toISOString(), seen: [] },
      fired: 0,
      lastFiredAt: null,
      lastError: null,
      createdAt: Date.now(),
    };
    this.#list.push(trigger);
    await this.#save();
    this.#schedule();
    this.#changed();
    return { ...this.#view(trigger), ...(trigger.type === 'webhook' ? { token: trigger.secret } : {}) };
  }

  async remove(id) {
    this.#list = this.#list.filter((t) => t !== this.#get(id));
    await this.#save();
    this.#schedule();
    this.#changed();
    return { removed: id };
  }

  async setEnabled(id, enabled) {
    const trigger = this.#get(id);
    trigger.enabled = Boolean(enabled);
    // Switched back on: again, only what happens from now.
    if (trigger.enabled) trigger.cursor = { ...trigger.cursor, since: new Date().toISOString() };
    await this.#save();
    this.#schedule();
    this.#changed();
    return this.#view(trigger);
  }

  /**
   * Hand one task to the crew (or to the flow this trigger starts, which gets `data` as well:
   * the fields of what arrived). Never throws: a full queue is something to show, not to crash on.
   */
  #wake(trigger, text, reply, data) {
    const task = clip(String(text ?? '').trim(), MAX_TASK_CHARS);
    if (!task) return null;
    try {
      const run = this.start(task, { source: trigger.type, triggerId: trigger.id, data });
      trigger.fired = (trigger.fired ?? 0) + 1;
      trigger.lastFiredAt = Date.now();
      trigger.lastError = null;
      if (reply) run.done.then((result) => reply(result.reply)).catch((err) => log.warn(`Could not send the reply for ${trigger.name}: ${err.message}`));
      return run;
    } catch (err) {
      trigger.lastError = err.message;
      return null;
    }
  }

  /** A webhook call. The token is compared in constant time; a wrong one and an unknown id look the same. */
  async fire(id, token, body) {
    const trigger = this.#list.find((t) => t.id === id && t.type === 'webhook');
    const given = Buffer.from(String(token ?? ''));
    const wanted = Buffer.from(trigger?.secret ?? '');
    if (!trigger || !wanted.length || given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) throw fail('Unknown webhook or wrong token', 401);
    if (!trigger.enabled) throw fail('This webhook is switched off', 409);
    let text = typeof body === 'string' ? body : (body?.text ?? body?.task ?? body?.message);
    // A webhook that starts a flow may carry any JSON: the flow gets all of it.
    const rich = body && typeof body === 'object' && Object.keys(body).some((k) => !['text', 'task', 'message'].includes(k));
    if ((typeof text !== 'string' || !text.trim()) && rich && this.bound(trigger.id)) text = JSON.stringify(body);
    if (typeof text !== 'string' || !text.trim()) throw fail('Send the task as JSON: { "text": "what to do" }');
    const run = this.#wake(trigger, text, null, rich ? body : undefined);
    await this.#save();
    this.#changed();
    if (!run) throw fail(trigger.lastError ?? 'The task could not be started', 409);
    return { runId: run.id, queued: run.queued };
  }

  async #json(url, options = {}) {
    const res = await this.fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const data = await res.json().catch(() => null);
    if (res.status === 401 || res.status === 403) throw new Error('the token was rejected');
    if (res.status === 404) throw new Error('not found - check the name, and that the token may see it');
    if (!res.ok) throw new Error(`the service answered ${res.status}`);
    return data;
  }

  /** Each poller returns what is new as [{ key, text, reply? }] and moves the trigger's cursor. */
  #pollers = {
    github: async (t) => {
      const query = new URLSearchParams({ labels: t.config.label, state: 'open', since: t.cursor.since, sort: 'updated', per_page: '20' });
      const headers = { accept: 'application/vnd.github+json', 'user-agent': 'kadhai' };
      if (t.secret) headers.authorization = `Bearer ${t.secret}`;
      const issues = await this.#json(`https://api.github.com/repos/${t.config.repo}/issues?${query}`, { headers });
      return (Array.isArray(issues) ? issues : [])
        .filter((issue) => !issue.pull_request) // the issues list includes pull requests
        .map((issue) => ({
          key: String(issue.number),
          text: `GitHub issue #${issue.number} in ${t.config.repo}: ${issue.title}\n\n${clip(issue.body ?? '', 3000)}\n\n(${issue.html_url})`,
          data: { repo: t.config.repo, number: issue.number, title: issue.title, body: clip(issue.body ?? '', 3000), url: issue.html_url, author: issue.user?.login, labels: (issue.labels ?? []).map((l) => l.name) },
        }));
    },

    linear: async (t) => {
      const query = 'query($label: String!, $after: DateTimeOrDuration!) { issues(first: 20, filter: { labels: { name: { eq: $label } }, updatedAt: { gt: $after } }) { nodes { id identifier title description url } } }';
      const data = await this.#json('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: t.secret },
        body: JSON.stringify({ query, variables: { label: t.config.label, after: t.cursor.since } }),
      });
      if (data?.errors?.length) throw new Error(clip(data.errors[0].message, 160));
      return (data?.data?.issues?.nodes ?? []).map((issue) => ({
        key: issue.id,
        text: `Linear ${issue.identifier}: ${issue.title}\n\n${clip(issue.description ?? '', 3000)}\n\n(${issue.url})`,
        data: { id: issue.identifier, title: issue.title, description: clip(issue.description ?? '', 3000), url: issue.url },
      }));
    },

    telegram: async (t) => {
      const api = `https://api.telegram.org/bot${t.secret}`;
      const first = t.cursor.offset == null;
      const query = new URLSearchParams({ timeout: '0', allowed_updates: '["message"]', ...(first ? {} : { offset: String(t.cursor.offset) }) });
      const data = await this.#json(`${api}/getUpdates?${query}`);
      const updates = Array.isArray(data?.result) ? data.result : [];
      if (updates.length) t.cursor.offset = updates.at(-1).update_id + 1;
      else if (first) t.cursor.offset = 0;
      // Messages sent before the trigger existed are not tasks.
      if (first) return [];
      const items = [];
      for (const update of updates) {
        const chat = update.message?.chat?.id;
        const text = update.message?.text;
        if (chat == null || !text) continue;
        if (!t.config.chats.includes(String(chat))) {
          t.cursor.stranger = String(chat);
          continue;
        }
        items.push({
          key: `m${update.update_id}`,
          text,
          data: { text, chat: String(chat), from: update.message.from?.username ?? update.message.from?.first_name ?? '' },
          reply: (answer) =>
            this.#json(`${api}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: clip(answer, 3500) }) }),
        });
      }
      return items;
    },
  };

  /** Ask every service once. Called on a timer; tests call it directly. */
  async poll() {
    if (this.#polling) return;
    this.#polling = true;
    let touched = false;
    try {
      for (const trigger of this.#list.filter((t) => t.enabled && this.#pollers[t.type])) {
        const before = JSON.stringify([trigger.cursor, trigger.lastError, trigger.fired]);
        const asked = new Date().toISOString();
        try {
          const seen = new Set(trigger.cursor.seen ?? []);
          const fresh = (await this.#pollers[trigger.type](trigger)).filter((item) => !seen.has(item.key));
          trigger.lastError = null;
          for (const item of fresh.slice(0, MAX_PER_POLL)) {
            // Marked as seen only once the crew has it: a full queue means "try again next time".
            if (this.#wake(trigger, item.text, item.reply, item.data)) seen.add(item.key);
          }
          trigger.cursor.seen = [...seen].slice(-SEEN_CAP);
          // Move on in time only when nothing was left behind.
          if (fresh.length <= MAX_PER_POLL && !trigger.lastError) trigger.cursor.since = asked;
        } catch (err) {
          // The token is part of some addresses: never let it into a message.
          const message = String(err.message);
          trigger.lastError = clip(trigger.secret ? message.replaceAll(trigger.secret, '***') : message, 200);
        }
        if (JSON.stringify([trigger.cursor, trigger.lastError, trigger.fired]) !== before) touched = true;
      }
      if (touched) {
        await this.#save().catch((err) => log.warn(`Could not save triggers: ${err.message}`));
        this.#changed();
      }
    } finally {
      this.#polling = false;
    }
  }
}
