import { skillsBlock } from './prompts.js';
import { MAX_SKILLS_CHOSEN } from './flame.js';
import { canAct, runCliAgent } from './cliAgent.js';

/**
 * The kitchen crew. Plain kitchen names that say the job:
 *
 *   Chef          plans the order into sub-tasks        (role: manager)
 *   Prep          cooks the simple sub-tasks            (role: coder, lighter models first)
 *   Cook          cooks the standard sub-tasks          (role: coder)
 *   Senior Cook   cooks the complex ones, and rescues   (role: coder)
 *   Fixer         fixes what the review sends back      (role: coder)
 *   Taster        verifies and reviews at the pass      (role: reviewer)
 *
 * `role` is the job, `id` is who holds it. Users can also hire their own
 * specialists (custom agents): extra cooks with their own instructions that
 * the Chef may hand a sub-task to when it matches their speciality.
 */
// In the order the work goes: planned, cooked (easy to hard), tasted, fixed. The list and the stations follow it.
const ROSTER = [
  { id: 'general-manager', role: 'manager', name: 'Chef', blurb: 'Turns your order into a plan of small, isolated sub-tasks.' },
  { id: 'commis', role: 'coder', tier: 'light', name: 'Prep', blurb: 'Junior cook: simple sub-tasks, on the lighter models to spare the best ones.' },
  { id: 'chef-de-partie', role: 'coder', name: 'Cook', blurb: 'Station cook: handles the standard sub-tasks.' },
  { id: 'executive-chef', role: 'coder', name: 'Senior Cook', blurb: 'Cooks the complex sub-tasks, and takes over any dish another cook could not finish.' },
  // The Taster comes with the security skill: every review also looks for leaked secrets, injection and unsafe input.
  { id: 'head-chef', role: 'reviewer', name: 'Taster', blurb: 'Stands at the pass: runs the verification and inspects every changed file.', skills: ['security'] },
  { id: 'sous-chef', role: 'coder', name: 'Fixer', blurb: 'Fixes whatever the Taster sends back.' },
];

/** Which cook takes a sub-task of each difficulty. */
export const COOK_FOR_LEVEL = { simple: 'commis', standard: 'chef-de-partie', complex: 'executive-chef' };
export const ESCALATION_COOK = 'executive-chef';
export const FIX_COOK = 'sous-chef';
/** The house cooks from easiest to hardest work: a cook that is switched off hands its work up this line (then down). */
const COOK_LINE = ['commis', 'chef-de-partie', 'executive-chef', 'sous-chef'];

export const MAX_CUSTOM_AGENTS = 8;
const MAX_CONNECTIONS = 40;
const CONNECTION_ID = /^[\w.-]{1,40}$/;
const THOUGHT_CAP = 20000;
const THOUGHT_FLUSH_MS = 80;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const text = (value, max) => String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);

/** Validate what the user typed for a custom agent. Throws a readable error. */
function cleanCustom(input = {}) {
  const name = text(input.name, 30).replace(/\s+/g, ' ');
  const specialty = text(input.specialty, 160).replace(/\s+/g, ' ');
  if (name.length < 2) throw fail('Give the agent a name (at least 2 characters)');
  if (specialty.length < 5) throw fail('Say what this agent is good at - the Chef uses that line to decide when to call it');
  return {
    name,
    specialty,
    instructions: text(input.instructions, 1500),
    tier: input.tier === 'light' ? 'light' : 'best',
  };
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';

/**
 * Live state of the crew: status, current task, thought stream, token metrics
 * and the operator controls (notes, pause/resume). Agents hold no conversation
 * state of their own - every call is a fresh, self-contained prompt.
 */
export class Crew {
  constructor({ bus, dispatcher, custom = [], settings = {}, skills = [], access = {} }) {
    this.bus = bus;
    this.dispatcher = dispatcher;
    this.agents = new Map();
    this.library = new Map(skills.map((skill) => [skill.id, skill]));
    for (const def of ROSTER) this.#seat(def);
    for (const def of custom) {
      try {
        this.#seat(this.#customEntry(def.id || slug(def.name ?? ''), cleanCustom(def)));
      } catch {
        // A hand-edited file with a bad entry should not stop the app.
      }
    }
    // Connections kept for certain cooks only: connection id -> the agent ids that may use it.
    this.reserved = new Map();
    for (const [connection, ids] of Object.entries(access)) {
      if (!CONNECTION_ID.test(connection) || !Array.isArray(ids)) continue;
      // An agent that no longer exists is dropped; the connection stays reserved (for nobody, if need be).
      this.reserved.set(connection, ids.map(String).filter((id) => this.agents.get(id)?.role === 'coder'));
    }
    for (const [id, saved] of Object.entries(settings)) {
      try {
        if (this.agents.has(id)) Object.assign(this.agents.get(id), this.#cleanSettings(saved ?? {}));
      } catch {
        // Same for a bad setting: that agent keeps its defaults.
      }
    }
  }

  #seat(def) {
    this.agents.set(def.id, {
      ...def,
      hue: null, // the user's own colour for it, or null for the usual one
      model: '', // '' (its usual order) | 'best' | 'light' | '<provider>/<model>' to try first
      // Ids from the skills library: the agent's own defaults (only those the library has) until the user changes them.
      skills: (def.skills ?? []).filter((id) => this.library.has(id)),
      defaultSkills: (def.skills ?? []).filter((id) => this.library.has(id)),
      connections: null, // null = every connection; a list = only those (ids as in Toolbox.groups())
      off: false, // switched off by the user: given no work (the Chef never is)
      state: 'standby', // standby | working | limit-reached
      task: '',
      route: null,
      paused: false,
      notes: [],
      thought: '',
      metrics: { calls: 0, promptTokens: 0, completionTokens: 0, swaps: 0, lastLatencyMs: 0 },
      buffer: '',
      timer: null,
      resumers: [],
    });
  }

  #customEntry(id, clean) {
    return {
      id,
      role: 'coder',
      custom: true,
      name: clean.name,
      blurb: clean.specialty,
      instructions: clean.instructions,
      tier: clean.tier === 'light' ? 'light' : undefined,
    };
  }

  get(id) {
    const agent = this.agents.get(id);
    if (!agent) throw fail(`Unknown agent "${id}"`, 404);
    return agent;
  }

  #view(agent, withThought = false) {
    const view = {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      blurb: agent.blurb,
      custom: Boolean(agent.custom),
      state: agent.state,
      task: agent.task,
      paused: agent.paused,
      pendingNotes: agent.notes.length,
      route: agent.route && { id: agent.route.id, label: agent.route.label, model: agent.route.model },
      metrics: { ...agent.metrics },
      hue: agent.hue,
      model: agent.model,
      skills: [...agent.skills],
      connections: agent.connections && [...agent.connections],
      off: agent.off,
    };
    if (agent.custom) Object.assign(view, { instructions: agent.instructions, tier: agent.tier ?? 'best' });
    if (withThought) view.thought = agent.thought;
    return view;
  }

  /** Every token the crew has used since start, prompt and answer together (a run's cost is the difference). */
  tokensUsed() {
    let sum = 0;
    for (const agent of this.agents.values()) sum += agent.metrics.promptTokens + agent.metrics.completionTokens;
    return sum;
  }

  snapshot() {
    return [...this.agents.values()].map((a) => this.#view(a, true));
  }

  // ------------------------------------------------------------ custom agents

  #customAgents() {
    return [...this.agents.values()].filter((a) => a.custom);
  }

  /** What the Chef is told about the hired specialists. */
  specialists() {
    return this.#customAgents().filter((a) => !a.off).map((a) => ({ id: a.id, name: a.name, specialty: a.blurb }));
  }

  /** The definitions, in the shape that is saved to disk. */
  customDefinitions() {
    return this.#customAgents().map((a) => ({
      id: a.id,
      name: a.name,
      specialty: a.blurb,
      instructions: a.instructions,
      tier: a.tier ?? 'best',
    }));
  }

  #custom(id) {
    const agent = this.get(id);
    if (!agent.custom) throw fail(`${agent.name} is part of the house crew and cannot be changed`, 403);
    if (agent.state === 'working') throw fail(`${agent.name} is in the middle of a task - try again when it is done`, 409);
    return agent;
  }

  hire(input) {
    const clean = cleanCustom(input);
    if (this.#customAgents().length >= MAX_CUSTOM_AGENTS) throw fail(`You can hire at most ${MAX_CUSTOM_AGENTS} custom agents`, 409);
    if ([...this.agents.values()].some((a) => a.name.toLowerCase() === clean.name.toLowerCase())) {
      throw fail(`There is already an agent called "${clean.name}"`, 409);
    }
    let id = slug(clean.name);
    for (let n = 2; this.agents.has(id); n++) id = `${slug(clean.name)}-${n}`;
    this.#seat(this.#customEntry(id, clean));
    this.bus.publish('crew:update', {});
    return this.#view(this.get(id));
  }

  retrain(id, input) {
    const agent = this.#custom(id);
    const clean = cleanCustom(input);
    if ([...this.agents.values()].some((a) => a !== agent && a.name.toLowerCase() === clean.name.toLowerCase())) {
      throw fail(`There is already an agent called "${clean.name}"`, 409);
    }
    Object.assign(agent, this.#customEntry(id, clean));
    this.bus.publish('crew:update', {});
    return this.#view(agent);
  }

  dismiss(id) {
    this.#custom(id);
    this.agents.delete(id);
    // What was reserved for it stays reserved - it does not quietly open up to everyone.
    for (const [connection, ids] of this.reserved) this.reserved.set(connection, ids.filter((agent) => agent !== id));
    this.bus.publish('crew:update', {});
    return { dismissed: id };
  }

  // ------------------------------------------- settings (any agent) and skills

  /** The skills library, without the bodies. */
  skillList() {
    return [...this.library.values()].map(({ id, name, description, own }) => ({ id, name, description, own: Boolean(own) }));
  }

  /** A skill in full, text included (for editing one of the user's own). */
  skill(id) {
    const skill = this.library.get(id);
    if (!skill) throw fail('No such skill', 404);
    return { ...skill, own: Boolean(skill.own) };
  }

  /** The library changed (a skill was written, edited or removed): agents let go of skills that are gone. */
  setLibrary(skills) {
    this.library = new Map(skills.map((skill) => [skill.id, skill]));
    for (const agent of this.agents.values()) agent.skills = agent.skills.filter((id) => this.library.has(id));
    this.bus.publish('crew:update', {});
  }

  /** Validate the fields that were sent; fields left out are not touched. */
  #cleanSettings(input) {
    const clean = {};
    if ('hue' in input) {
      const hue = input.hue === null || input.hue === '' ? null : Number(input.hue);
      if (hue !== null && !(Number.isInteger(hue) && hue >= 0 && hue < 360)) throw fail('The colour must be a hue from 0 to 359');
      clean.hue = hue;
    }
    if ('model' in input) clean.model = text(input.model, 200);
    if ('skills' in input) {
      const ids = [...new Set(Array.isArray(input.skills) ? input.skills.map(String) : [])].filter((id) => this.library.has(id));
      if (ids.length > MAX_SKILLS_CHOSEN) {
        throw fail(`An agent can load at most ${MAX_SKILLS_CHOSEN} skills - each one is added to every prompt it sends (low flame uses the first 3)`);
      }
      clean.skills = ids;
    }
    if ('connections' in input) {
      // null: everything. A list: only those - kept even if one is not connected right now.
      if (input.connections !== null && !Array.isArray(input.connections)) throw fail('"connections" must be a list of connection names, or null for all of them');
      clean.connections = input.connections && [...new Set(input.connections.map(String).filter((id) => CONNECTION_ID.test(id)))].slice(0, MAX_CONNECTIONS);
    }
    if ('off' in input) clean.off = Boolean(input.off);
    return clean;
  }

  /** Change an agent's colour, model preference, loaded skills or allowed connections. Works for the house crew too. */
  configure(id, input = {}) {
    const agent = this.get(id);
    const clean = this.#cleanSettings(input);
    if (clean.off) {
      if (agent.role === 'manager') throw fail(`${agent.name} plans every run and cannot be switched off`);
      if (agent.role === 'coder' && !this.#coders().some((a) => a !== agent && !a.off)) throw fail('At least one cook has to stay on to do the work');
    }
    Object.assign(agent, clean);
    this.bus.publish('crew:update', {});
    return this.#view(agent);
  }

  #coders() {
    return [...this.agents.values()].filter((a) => a.role === 'coder');
  }

  /** Is this agent on (not switched off by the user)? */
  isOn(id) {
    return !this.agents.get(id)?.off;
  }

  /**
   * Who does work meant for this cook: the cook itself when it is on, otherwise the nearest house
   * cook that is on, up the line first (harder work is never handed to a junior when a senior is free),
   * then any hired cook that is on. One cook always stays on, so there is always someone.
   */
  cookFor(id) {
    if (this.agents.has(id) && this.isOn(id)) return id;
    const at = COOK_LINE.indexOf(id);
    const order = at < 0 ? COOK_LINE : [...COOK_LINE.slice(at + 1), ...COOK_LINE.slice(0, at).reverse()];
    return order.find((cook) => this.agents.has(cook) && this.isOn(cook)) ?? this.#coders().find((a) => !a.off)?.id ?? id;
  }

  /** May this agent use the tools of this connection (an MCP server, or a connector such as Google)? */
  mayUse(id, connection) {
    const { connections } = this.get(id);
    // Two questions: is the connection kept for other cooks, and has this agent been limited to a few?
    const only = this.reserved.get(connection);
    return (!only || only.includes(id)) && (connections === null || connections.includes(connection));
  }

  /** Keep a connection for certain cooks only (`agents`: a list of ids), or open it to everyone again (null). */
  restrict(connection, agents) {
    const id = String(connection ?? '');
    if (!CONNECTION_ID.test(id)) throw fail('That is not the name of a connection');
    if (agents == null) this.reserved.delete(id);
    else {
      if (!Array.isArray(agents)) throw fail('"agents" must be a list of agent ids, or null for everyone');
      const ids = [...new Set(agents.map(String))];
      for (const agent of ids.map((a) => this.get(a))) {
        if (agent.role !== 'coder') throw fail(`${agent.name} never uses connections - pick a cook`);
      }
      this.reserved.set(id, ids);
    }
    this.bus.publish('crew:update', {});
    return { connection: id, agents: this.reserved.get(id) ?? null };
  }

  /** Which connections are reserved, and for whom: `{ connection: [agent ids] }`. */
  access() {
    return Object.fromEntries([...this.reserved].map(([connection, ids]) => [connection, [...ids]]));
  }

  /** Only what differs from the defaults, in the shape that is saved to disk. */
  settings() {
    const out = {};
    for (const agent of this.agents.values()) {
      const own = {};
      if (agent.hue !== null) own.hue = agent.hue;
      if (agent.model) own.model = agent.model;
      // Saved when it differs from the agent's defaults - so taking a default skill off is remembered too.
      if (agent.skills.join() !== (agent.defaultSkills ?? []).join()) own.skills = [...agent.skills];
      if (agent.connections) own.connections = [...agent.connections];
      if (agent.off) own.off = true;
      if (Object.keys(own).length) out[agent.id] = own;
    }
    return out;
  }

  // ------------------------------------------------------------- live state

  #changed(agent) {
    this.bus.publish('agent:update', { agent: this.#view(agent) });
  }

  setState(id, state, task) {
    const agent = this.get(id);
    agent.state = state;
    if (task !== undefined) agent.task = task;
    this.#changed(agent);
  }

  /** Append to the live thought stream. Deltas are batched to spare the browser. */
  think(id, delta) {
    const agent = this.get(id);
    agent.thought = (agent.thought + delta).slice(-THOUGHT_CAP);
    agent.buffer += delta;
    agent.timer ??= setTimeout(() => {
      this.bus.publish('agent:thought', { id, delta: agent.buffer });
      agent.buffer = '';
      agent.timer = null;
    }, THOUGHT_FLUSH_MS);
  }

  note(id, note) {
    const agent = this.get(id);
    agent.notes.push(String(note).trim().slice(0, 1000));
    this.think(id, `\n[note] operator note queued: ${agent.notes.at(-1)}\n`);
    this.#changed(agent);
  }

  pause(id) {
    const agent = this.get(id);
    agent.paused = true;
    this.#changed(agent);
  }

  resume(id) {
    const agent = this.get(id);
    agent.paused = false;
    for (const wake of agent.resumers.splice(0)) wake();
    this.#changed(agent);
  }

  resumeAll() {
    for (const agent of this.agents.values()) if (agent.paused) this.resume(agent.id);
  }

  /** End of a run: nobody is left spinning. Limit-reached stays visible on purpose. */
  settle() {
    for (const agent of this.agents.values()) {
      if (agent.state === 'working') this.setState(agent.id, 'standby', '');
    }
  }

  async #waitWhilePaused(agent, signal) {
    while (agent.paused) {
      signal?.throwIfAborted();
      this.think(agent.id, '\n[paused] by the operator, waiting to resume\n');
      await new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal?.addEventListener('abort', onAbort, { once: true });
        agent.resumers.push(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        });
      });
    }
  }

  /**
   * High flame: one step done by a subscription CLI working as an agent in `dir` (a private copy
   * of the folder). Returns null when no CLI can act in this mode, or when the chosen one could not
   * be used - the caller then falls back to an ordinary call, so failover still holds.
   */
  async act(id, { system, user, dir, shell = false, task = '', signal }) {
    const agent = this.get(id);
    await this.#waitWhilePaused(agent, signal);
    const prefer = agent.model && agent.model !== 'light' && agent.model !== 'best' ? agent.model : undefined;
    // A preference for an HTTP model is respected: that agent stays a model.
    if (prefer && !this.dispatcher.routes.some((r) => r.kind === 'cli' && `${r.provider}/${r.model}` === prefer)) return null;
    const route = this.dispatcher.agentRoute({ prefer, canAct: (provider) => canAct(provider, shell) });
    if (!route) return null;

    const limits = this.dispatcher.limits ?? {};
    const notes = agent.notes.splice(0);
    const noteBlock = notes.length ? `\n\n## Operator notes (these override everything else)\n${notes.map((n) => `- ${n}`).join('\n')}` : '';
    const skills = skillsBlock(agent.skills.map((skill) => this.library.get(skill)).filter(Boolean).slice(0, limits.skillsPerAgent ?? 3), limits.skillChars ?? 900);

    agent.route = this.dispatcher.viewOf(route);
    this.setState(id, 'working', task);
    this.think(id, `\n> ${task}\n[agent] ${route.label} works on a copy of the folder${shell ? ', commands allowed' : ', edits only'}\n`);
    const started = Date.now();
    try {
      const out = await runCliAgent(route, {
        system: system + skills,
        user: user + noteBlock,
        dir,
        shell,
        signal,
        timeoutMs: limits.agentTimeoutMs ?? 15 * 60000,
        maxTurns: limits.agentTurns ?? 30,
        onEvent: (event) => this.think(id, event.kind === 'tool' ? `\n[${event.name}] ${event.detail}\n` : `${event.text}\n`),
      });
      this.dispatcher.charge(route, out.usage);
      agent.metrics.calls += 1;
      agent.metrics.promptTokens += out.usage.promptTokens;
      agent.metrics.completionTokens += out.usage.completionTokens;
      agent.metrics.lastLatencyMs = Date.now() - started;
      this.setState(id, 'standby', '');
      return { ...out, route: agent.route };
    } catch (err) {
      this.setState(id, 'standby', '');
      if (err.name !== 'ProviderError' || signal?.aborted) throw err;
      // The CLI could not be used: it cools down (or is switched off), the notes go back, a model takes over.
      this.dispatcher.fault(route, err);
      agent.notes.unshift(...notes);
      this.think(id, `\n[!] ${err.message} - an ordinary model takes this step\n`);
      return null;
    }
  }

  /**
   * One LLM call on behalf of an agent.
   * `user` may be an async function; it is re-evaluated on every provider
   * attempt so a hot-swapped model starts from the current memory.md.
   */
  async call(id, { system, user, json = false, task = '', signal, maxTokens }) {
    const agent = this.get(id);
    await this.#waitWhilePaused(agent, signal);

    const notes = agent.notes.splice(0);
    const noteBlock = notes.length
      ? `\n\n## Operator notes (these override everything else)\n${notes.map((n) => `- ${n}`).join('\n')}`
      : '';

    // Loaded skills go last in the system prompt, so they cannot redefine the output format.
    // How many, and how much of each, is the flame's call: low flame keeps prompts small.
    const { skillsPerAgent = 3, skillChars = 900 } = this.dispatcher.limits ?? {};
    const skills = skillsBlock(agent.skills.map((skill) => this.library.get(skill)).filter(Boolean).slice(0, skillsPerAgent), skillChars);
    // The user's choice for this agent: an order to walk the routes in, or one model to try first.
    const tier = agent.model === 'light' ? 'light' : agent.model === 'best' ? undefined : agent.tier;
    const prefer = agent.model && agent.model !== 'light' && agent.model !== 'best' ? agent.model : undefined;

    this.setState(id, 'working', task);
    this.think(id, `\n> ${task}\n`);
    const started = Date.now();
    let attemptRoute = null;

    try {
      const out = await this.dispatcher.chat(
        {
          json,
          maxTokens,
          build: async () => [
            { role: 'system', content: system + skills },
            { role: 'user', content: (typeof user === 'function' ? await user() : user) + noteBlock },
          ],
        },
        {
          agent: id,
          role: agent.role,
          tier,
          prefer,
          signal,
          onDelta: (delta) => {
            if (delta.type === 'reset') this.think(id, '\n[swap] new provider, starting again from memory.md\n');
            else if (delta.text) this.think(id, delta.text);
          },
          onRoute: (route) => {
            if (attemptRoute && attemptRoute !== route.id) agent.metrics.swaps += 1;
            attemptRoute = route.id;
            agent.route = route;
            this.setState(id, 'working');
          },
          onWait: (ms) => this.setState(id, 'limit-reached', `Rate-limited, retrying in ${Math.ceil(ms / 1000)}s`),
        },
      );
      agent.metrics.calls += 1;
      agent.metrics.promptTokens += out.usage.promptTokens;
      agent.metrics.completionTokens += out.usage.completionTokens;
      agent.metrics.lastLatencyMs = Date.now() - started;
      this.think(id, '\n');
      this.setState(id, 'standby', '');
      return out;
    } catch (err) {
      if (err.name === 'DispatchError') this.setState(id, 'limit-reached', err.message);
      else this.setState(id, 'standby');
      throw err;
    }
  }
}
