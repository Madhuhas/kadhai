import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { ABOUT, loadConfig } from '../config.js';
import { vaultFor } from './vault.js';
import { EventBus } from './eventBus.js';
import { LockManager } from './lockManager.js';
import { Workspace } from './workspace.js';
import { MemoryEngine } from './memory.js';
import { Dispatcher } from './dispatcher.js';
import { mockCompletion } from './mockProvider.js';
import { CLI_AGENTS } from './cliProvider.js';
import { Crew } from './crew.js';
import { Orchestrator } from './orchestrator.js';
import { Runner } from './runner.js';
import { Checkpoints } from './checkpoints.js';
import { StateStore } from './stateStore.js';
import { createKeyService } from './keys.js';
import { hasPlainKeys, loadStoredKeys, saveStoredKeys } from './keyStore.js';
import { log } from './util.js';
import { Repo } from './git.js';
import { GoogleConnector, Toolbox } from './connectors/google.js';
import { describeConnection } from './connectors/catalog.js';
import { loadAgentAccess, loadAgentSettings, loadCustomAgents, saveCustomAgents } from './customAgents.js';
import { MAX_OWN_SKILLS, cleanSkill, deleteSkill, loadSkills, slug, writeSkill } from './skills.js';
import { Triggers } from './triggers.js';
import { Flows } from './flows.js';
import { Credentials } from './credentials.js';
import { Journal } from './journal.js';
import { cleanFlame, limitsFor } from './flame.js';
import { importSkill } from './skillImport.js';
import { agentDraftSystem, agentDraftUser, shapeAgentDraft, AGENT_DRAFT_INPUT_CHARS } from './agentDraft.js';
import { extractJson } from './parse.js';
import { McpHub } from '../protocols/mcpClient.js';

/**
 * Build one fully wired engine for one workspace folder. The web server, the
 * MCP server and the ACP agent are all thin shells around this object.
 */
export async function createEngine(overrides = {}) {
  const config = loadConfig({ cliAgents: CLI_AGENTS, ...overrides });
  const startedAt = Date.now();
  const bus = new EventBus();
  // The flame: low (the limits as configured) or high (bigger bounds, strong routes first).
  // Everything reads config.limits when it acts, so a change applies from the next call on.
  const baseLimits = { ...config.limits };
  let flame = 'low';
  Object.assign(config.limits, limitsFor(flame, baseLimits));

  const locks = new LockManager({
    lockDir: path.join(config.workspaceDir, '.kadhai', 'locks'),
    bus,
    ttlMs: config.limits.lockTtlMs,
  });
  const workspace = new Workspace({ root: config.workspaceDir, locks, bus });
  await workspace.init();
  await locks.sweep();

  const memory = new MemoryEngine({ workspace, locks, bus });
  await memory.init();

  // Keys saved by an older version (or typed into the file by hand) are encrypted in place, once.
  if (config.sealSecrets && hasPlainKeys(config.keysFile)) {
    await saveStoredKeys(config.keysFile, loadStoredKeys(config.keysFile)).catch((err) => log.warn(`Could not encrypt the saved keys: ${err.message}`));
  }

  const dispatcher = new Dispatcher({
    config,
    bus,
    completion: overrides.completion ?? (config.mock ? mockCompletion : undefined),
  });
  const keys = createKeyService({ config, dispatcher, bus, verify: overrides.verifyKey });
  const crew = new Crew({
    bus,
    dispatcher,
    custom: loadCustomAgents(config.agentsFile),
    settings: loadAgentSettings(config.agentsFile),
    skills: loadSkills(config.skillsDir, config.ownSkillsDir),
    access: loadAgentAccess(config.agentsFile),
  });
  // Any change to the hired specialists, or to an agent's settings, is written straight back to disk.
  const saveCrew = (result) => saveCustomAgents(config.agentsFile, crew.customDefinitions(), crew.settings(), crew.access()).then(() => result);
  const hiring = {
    hire: (input) => saveCrew(crew.hire(input)),
    retrain: (id, input) => saveCrew(crew.retrain(id, input)),
    dismiss: (id) => saveCrew(crew.dismiss(id)),
    configure: (id, input) => saveCrew(crew.configure(id, input)),
    restrict: (connection, agents) => saveCrew(crew.restrict(connection, agents)),
    /** "Generate with AI": the Chef writes a specialist's profile from a few words. Fills the form; hires nobody. */
    async generate(request) {
      const ask = String(request ?? '').trim();
      if (ask.length < 3) throw Object.assign(new Error('Say in a few words what kind of agent you want'), { status: 400 });
      if (ask.length > AGENT_DRAFT_INPUT_CHARS) throw Object.assign(new Error(`Keep it under ${AGENT_DRAFT_INPUT_CHARS} characters`), { status: 400 });
      // The Chef does it, so it shows in the kitchen like any other call - but not mid-run.
      if (orchestrator.busy) throw Object.assign(new Error('The crew is cooking - generate the agent when the run is done'), { status: 409 });
      const context = { skills: crew.skillList(), crew: [...crew.agents.values()].map((a) => ({ name: a.name })) };
      const out = await crew.call('general-manager', { system: agentDraftSystem(context), user: agentDraftUser(ask), json: true, task: 'Writing a new agent' });
      return shapeAgentDraft(extractJson(out.text), context);
    },
  };
  // Skills of the user's own: written, changed and removed from the dashboard, and in use at once.
  const reloadSkills = () => crew.setLibrary(loadSkills(config.skillsDir, config.ownSkillsDir));
  const ownSkill = (id) => {
    const skill = crew.skill(id);
    if (!skill.own) throw Object.assign(new Error(`${skill.name} is a built-in skill and cannot be changed. Write one of your own instead.`), { status: 403 });
    return skill;
  };
  const skills = {
    list: () => crew.skillList(),
    get: (id) => crew.skill(id),
    async save(input, id = null) {
      const clean = cleanSkill(input);
      const all = crew.skillList();
      let target = id;
      if (id) ownSkill(id);
      else {
        if (all.filter((s) => s.own).length >= MAX_OWN_SKILLS) throw Object.assign(new Error(`At most ${MAX_OWN_SKILLS} skills of your own`), { status: 409 });
        target = slug(clean.name);
        for (let n = 2; all.some((s) => s.id === target); n++) target = `${slug(clean.name)}-${n}`;
      }
      if (all.some((s) => s.id !== target && s.name.toLowerCase() === clean.name.toLowerCase())) throw Object.assign(new Error(`There is already a skill called "${clean.name}"`), { status: 409 });
      await writeSkill(config.ownSkillsDir, { id: target, ...clean });
      reloadSkills();
      return crew.skill(target);
    },
    /** A skill from a link, condensed if long; returned for the form, not saved. */
    import(link) {
      return importSkill(link, {
        fetch: overrides.fetch ?? globalThis.fetch,
        condense: async (system, user) => {
          // The Chef does it, so it shows in the kitchen like any other call - but not mid-run.
          if (orchestrator.busy) throw Object.assign(new Error('The crew is cooking - import the skill when the run is done'), { status: 409 });
          return (await crew.call('general-manager', { system, user, task: 'Condensing an imported skill' })).text;
        },
      });
    },
    async remove(id) {
      ownSkill(id);
      await deleteSkill(config.ownSkillsDir, id);
      reloadSkills();
      // Agents that had it loaded no longer do: save that too.
      await saveCrew();
      return { removed: id };
    },
  };
  const mcp = new McpHub({ configPath: config.mcpConfigPath, bus, version: config.version });
  const runner = new Runner({ cwd: config.workspaceDir, bus, limits: config.limits, interactive: config.interactive });
  await runner.init();
  const checkpoints = new Checkpoints({ root: config.workspaceDir });
  await checkpoints.init();
  // Connected accounts. Their tools sit beside the MCP ones in a single list for the cooks.
  const google = new GoogleConnector({
    file: config.connectorsFile,
    redirectUri: `http://localhost:${config.port}/api/connectors/google/callback`,
    bus,
    fetch: overrides.fetch,
  });
  await google.init();
  const toolbox = new Toolbox([mcp, google], describeConnection);
  // What was done in this folder before, and what was learned from it.
  const journal = new Journal({ dir: path.join(config.workspaceDir, '.kadhai'), enabled: config.journal, bus, now: overrides.now, limits: config.limits });
  await journal.init();
  const orchestrator = new Orchestrator({ config, bus, crew, workspace, memory, locks, mcp: toolbox, runner, checkpoints, journal });

  // Flows: a graph of nodes, started by hand, by the clock, by a trigger or by something they watch.
  const credentials = new Credentials({ file: config.credentialsFile, fetch: overrides.fetch });
  const flows = new Flows({
    file: config.flowsFile,
    enabled: config.flows,
    bus,
    crew,
    start: (text, options) => orchestrator.start(text, options),
    // Looked up when a node runs: whatever is connected at that moment.
    toolbox: () => orchestrator.mcp,
    workspace,
    runner,
    credentials,
    busy: () => orchestrator.busy,
    fetch: overrides.fetch,
    now: overrides.now,
  });
  await flows.init();

  // Tasks that arrive from outside the dashboard. They go through the same door as typed ones.
  const triggers = new Triggers({
    file: config.triggersFile,
    enabled: config.triggers,
    bus,
    // A trigger tied to a flow starts that flow; any other is a plain task for the Chef.
    start: (text, options) => flows.fromTrigger(options?.triggerId, text, options?.data) ?? orchestrator.start(text, options),
    bound: (id) => flows.isBound(id),
    fetch: overrides.fetch,
  });
  await triggers.init();

  // Source control on the folder's own repository (the shadow one above is only for undo).
  const git = new Repo({ root: config.workspaceDir, workspace, bus, isBusy: () => orchestrator.busy });

  // Pick up where the last session left off, and keep saving as things change.
  const store = new StateStore({ dir: path.join(config.workspaceDir, '.kadhai'), enabled: config.persist });
  const saved = await store.load();
  orchestrator.restore(saved);
  dispatcher.importUsage(saved.usage);
  const persisted = () => ({ chat: orchestrator.chat, runs: orchestrator.runs, usage: dispatcher.exportUsage() });
  const SAVE_ON = new Set(['chat:message', 'run:done', 'runs:update', 'exec:end', 'exec:resolved', 'providers:update']);
  bus.subscribe(({ type }) => SAVE_ON.has(type) && store.schedule(persisted));

  // Commands are part of the conversation: keep them in the chat history.
  bus.subscribe(({ type, data }) => {
    if (type === 'exec:end') orchestrator.remember({ role: 'exec', ...data });
    else if (type === 'exec:resolved' && !data.approved) orchestrator.remember({ role: 'exec', ...data, denied: true });
  });

  if (config.watch) workspace.watch();
  // Keys are shared between rooms, and each room is its own process: a key added in one reaches the others this way.
  const onKeysFile = () => keys.reload();
  if (config.watchKeys) fs.watchFile(config.keysFile, { interval: 3000 }, onKeysFile);
  // External MCP servers start in the background; the app never waits on them.
  if (overrides.mcp !== false) mcp.loadConfig();

  return {
    config,
    bus,
    locks,
    workspace,
    memory,
    dispatcher,
    keys,
    crew,
    hiring,
    skills,
    journal,
    triggers,
    flows,
    credentials,
    mcp,
    connectors: { google },
    runner,
    checkpoints,
    git,
    orchestrator,
    previewUrl: null,
    // Open event streams (dashboards), so they can be ended when this engine is swapped out.
    streams: new Set(),

    get flame() {
      return flame;
    },
    /** Low or high flame, for this engine from the next model call on. */
    setFlame(level) {
      const next = cleanFlame(level);
      if (!next) throw Object.assign(new Error('The flame is "low" or "high"'), { status: 400 });
      flame = next;
      Object.assign(config.limits, limitsFor(flame, baseLimits));
      bus.publish('flame:update', { flame });
      return flame;
    },

    /** For the About panel: what this is, where it runs, what is set up. Nothing secret. */
    about() {
      const routes = dispatcher.routes;
      const agents = crew.snapshot();
      const flowList = flows.list();
      return {
        name: 'Kadhai',
        version: config.version,
        ...ABOUT,
        startedAt,
        mock: config.mock,
        // Started by the desktop app (desktop/main.cjs) rather than from a terminal.
        desktop: process.env.KADHAI_DESKTOP === '1',
        node: process.version,
        system: `${os.type()} ${os.release()} (${process.arch}), ${Math.round(os.totalmem() / 2 ** 30)} GB memory`,
        workspaceDir: config.workspaceDir,
        root: config.root,
        data: config.data ?? config.root,
        dashboard: `http://localhost:${config.port}`,
        room: process.argv.includes('--room') ? process.argv[process.argv.indexOf('--room') + 1] : 'main',
        previewUrl: this.previewUrl,
        providers: [...new Set(routes.map((r) => r.label.replace(/#\d+$/, '')))],
        execMode: runner.mode,
        sandbox: runner.sandbox,
        sandboxReady: runner.sandboxReady,
        commandTimeoutMs: runner.timeoutMs,
        keepRunning: runner.keepMax,
        flame,
        checkpoints: checkpoints.available,
        // How the master key of the saved secrets is kept; "none" until a secret has been stored.
        secrets: vaultFor(config.keysFile).protection ?? 'none',
        counts: {
          agents: agents.length,
          hired: agents.filter((a) => a.custom).length,
          routes: routes.length,
          paidRoutes: routes.filter((r) => r.paid).length,
          connections: toolbox.groups().length,
          tools: toolbox.tools().length,
          flows: flowList.length,
          flowsOn: flowList.filter((f) => f.enabled).length,
          triggers: triggers.list().length,
          credentials: config.flows ? credentials.list().length : 0,
          skills: crew.skillList().length,
          journal: journal.size,
          lessons: journal.listLessons().length,
        },
      };
    },

    async snapshot() {
      return {
        app: {
          name: 'Kadhai',
          version: config.version,
          workspaceDir: config.workspaceDir,
          mock: config.mock,
          hasProviders: dispatcher.routes.length > 0,
          previewUrl: this.previewUrl,
          root: config.root,
          checkpoints: checkpoints.available,
          flame,
        },
        agents: crew.snapshot(),
        skills: crew.skillList(),
        access: crew.access(),
        providers: dispatcher.status(),
        locks: await locks.list(),
        memory: await memory.read(),
        chat: orchestrator.chat,
        run: orchestrator.runView(),
        queue: orchestrator.queueView(),
        runs: orchestrator.runsView(),
        mcp: mcp.status(),
        exec: runner.view(),
      };
    },

    async close() {
      triggers.close();
      flows.close();
      if (config.watchKeys) fs.unwatchFile(config.keysFile, onKeysFile);
      orchestrator.stop();
      runner.killAll();
      await store.flush();
      workspace.close();
      memory.close();
      mcp.close();
      await locks.releaseAll();
    },
  };
}
