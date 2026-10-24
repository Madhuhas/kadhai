import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStoredKeys } from './core/keyStore.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * Where the user's own files live: keys, settings, agents, flows, credentials, their skills, the
 * default workspace. Beside the code unless KADHAI_DATA names another folder - the desktop app sets
 * it, because an installed app's own folder is not writable. The code (built-in skills, the
 * dashboard, LICENSE) is always read from ROOT.
 */
export const DATA = process.env.KADHAI_DATA ? path.resolve(process.env.KADHAI_DATA) : ROOT;
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
export const VERSION = PACKAGE.version;
/**
 * What the About panel says this is. The AGPL (section 5 d) asks an interactive program to show
 * its copyright, that there is no warranty, and how to read the licence; the panel shows all three.
 */
export const ABOUT = {
  description: PACKAGE.description,
  license: PACKAGE.license,
  licenseName: 'GNU Affero General Public License, version 3 or later',
  copyright: `Copyright (C) 2026 ${PACKAGE.author}`,
};
/** The full licence text, read when asked for (the About panel's "Read the licence"). */
export const licenseText = () => fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');

/**
 * Every provider speaks the OpenAI chat-completions dialect, so one client covers them all.
 *
 *   models     defaults, best first. They go stale as free line-ups rotate; the
 *              Keys dialog lets the user pick from the provider's live list.
 *   freeTier   the published free allowance, shown as a hint only.
 *   verifyUrl  how a new key is checked: omitted = GET {baseUrl}/models (most
 *              providers), a path or URL = an endpoint that needs auth when
 *              /models is public, false = no cheap check exists.
 *   extra      listed under "More free providers" until the user adds a key.
 *   paid       every call is billed to the user's account. Listed apart, counted against the
 *              daily limit for paid models, and never given default models from memory:
 *              `models: []` means "pick from the provider's live list after adding a key".
 *   api        'anthropic' = the native Claude Messages API (core/anthropic.js); omitted =
 *              the OpenAI chat-completions dialect.
 *   prefix     how this provider's keys start, when that is unmistakable: lets a pasted key
 *              find its provider by itself.
 *
 * The first three are the core set. The rest come from the community list at
 * github.com/open-free-llm-api/awesome-freellm-apis; each endpoint was probed
 * and its default models taken from the provider's live /models in October 2026.
 */
export const PROVIDER_PRESETS = {
  gemini: {
    label: 'Gemini',
    keyUrl: 'https://aistudio.google.com/apikey',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'],
    freeTier: '15 requests/min, 1,500/day',
  },
  groq: {
    label: 'Groq',
    keyUrl: 'https://console.groq.com/keys',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'],
    freeTier: 'varies by model; for gpt-oss-120b Groq reports 1,000 requests/day and 8,000 tokens/min',
  },
  cerebras: {
    label: 'Cerebras',
    keyUrl: 'https://cloud.cerebras.ai',
    baseUrl: 'https://api.cerebras.ai/v1',
    models: ['gpt-oss-120b', 'qwen-3.8-27b'],
    freeTier: '10 requests/min, 100/day, 1M tokens/day',
  },
  mistral: {
    label: 'Mistral',
    keyUrl: 'https://console.mistral.ai/api-keys',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-small-latest', 'codestral-latest'],
    freeTier: 'about 1 request/sec, 500K tokens/min',
    extra: true,
  },
  openrouter: {
    label: 'OpenRouter',
    keyUrl: 'https://openrouter.ai/settings/keys',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['poolside/laguna-s-2.1:free', 'cohere/north-mini-code:free', 'google/gemma-4-31b-it:free'],
    freeTier: 'only models ending in ":free" cost nothing; daily request cap',
    verifyUrl: '/key',
    extra: true,
  },
  nvidia: {
    label: 'NVIDIA NIM',
    keyUrl: 'https://build.nvidia.com/settings/api-keys',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: ['z-ai/glm-5.3', 'moonshotai/kimi-k3', 'deepseek-ai/deepseek-v4.1-flash'],
    freeTier: 'up to 40 requests/min; phone verification to sign up',
    verifyUrl: false,
    extra: true,
  },
  sambanova: {
    label: 'SambaNova',
    keyUrl: 'https://cloud.sambanova.ai/apis',
    baseUrl: 'https://api.sambanova.ai/v1',
    models: ['DeepSeek-V3.2', 'gpt-oss-120b', 'Meta-Llama-3.3-70B-Instruct'],
    freeTier: '20 requests/min, 20/day, 200K tokens/day',
    verifyUrl: false,
    extra: true,
  },
  huggingface: {
    label: 'Hugging Face',
    keyUrl: 'https://huggingface.co/settings/tokens',
    baseUrl: 'https://router.huggingface.co/v1',
    models: ['Qwen/Qwen3.8-27B', 'zai-org/GLM-5.3', 'openai/gpt-oss-120b'],
    freeTier: 'a small monthly credit, then it stops',
    verifyUrl: 'https://huggingface.co/api/whoami-v2',
    extra: true,
  },
  cohere: {
    label: 'Cohere',
    keyUrl: 'https://dashboard.cohere.com/api-keys',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    models: [], // its list needs a key: picked in the dashboard after one is added
    freeTier: '20 requests/min on a trial key',
    extra: true,
  },
  zai: {
    label: 'Z.ai (Zhipu)',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.7-flash'],
    freeTier: 'flash models free, 1 request at a time',
    extra: true,
  },
  // ---- paid: you bring a key from an account with billing. Each endpoint was probed (a bogus key is rejected).
  anthropic: {
    label: 'Claude (Anthropic)',
    keyUrl: 'https://platform.claude.com/settings/keys',
    baseUrl: 'https://api.anthropic.com/v1',
    api: 'anthropic',
    // Best first: the dispatcher falls to the next one only when the one above cannot answer.
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'],
    prefix: 'sk-ant-',
    paid: true,
  },
  openai: { label: 'OpenAI', keyUrl: 'https://platform.openai.com/api-keys', baseUrl: 'https://api.openai.com/v1', models: [], prefix: 'sk-proj-', paid: true },
  xai: { label: 'xAI (Grok)', keyUrl: 'https://console.x.ai', baseUrl: 'https://api.x.ai/v1', models: [], prefix: 'xai-', paid: true },
  deepseek: { label: 'DeepSeek', keyUrl: 'https://platform.deepseek.com/api_keys', baseUrl: 'https://api.deepseek.com/v1', models: [], paid: true },
  custom: { label: 'Custom', baseUrl: '', models: [] },
};

// Key prefixes of the free providers that are unmistakable too.
const FREE_PREFIXES = { groq: 'gsk_', gemini: 'AIza', openrouter: 'sk-or-' };

/** Which provider a pasted key belongs to, when its prefix says so. Longest prefix wins (sk-or- before sk-). */
export function detectProvider(key, presets = PROVIDER_PRESETS) {
  const known = Object.entries(presets).map(([id, preset]) => [id, preset.prefix ?? FREE_PREFIXES[id]]).filter(([, prefix]) => prefix);
  return known.sort((a, b) => b[1].length - a[1].length).find(([, prefix]) => String(key).startsWith(prefix))?.[0] ?? null;
}

/** Endpoints the user added themselves (any OpenAI-compatible server), in the shape of a preset. */
const ownPresets = (stored) =>
  Object.fromEntries((stored.endpoints ?? []).map((e) => [e.id, { label: e.label, baseUrl: e.baseUrl, models: [], paid: Boolean(e.paid), keyless: Boolean(e.keyless), own: true }]));

let envLoaded = false;

// Tiny .env reader: keeps the dependency list at exactly one package.
function loadDotEnv() {
  if (envLoaded) return;
  envLoaded = true;
  let text;
  try {
    text = fs.readFileSync(path.join(DATA, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const list = (value) =>
  String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function int(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Every known provider with what is configured for it, from both sources:
 * .env (envKeys) and the dashboard's key file (uiKeys). Dashboard model lists
 * win over .env ones, which win over the built-in defaults.
 */
export function providerCatalog(keysFile) {
  loadDotEnv();
  const stored = loadStoredKeys(keysFile);
  const presets = { ...PROVIDER_PRESETS, ...ownPresets(stored) };
  const order = list(process.env.PROVIDER_ORDER);
  const ids = order.length ? order : Object.keys(presets);
  return ids
    .filter((id) => presets[id])
    .map((id) => {
      const preset = presets[id];
      const env = id.toUpperCase();
      const envKeys = list(process.env[`${env}_API_KEYS`] || process.env[`${env}_API_KEY`]);
      const envModels = list(process.env[`${env}_MODELS`]);
      const uiModels = stored.models[id] ?? [];
      return {
        id,
        label: preset.label,
        keyUrl: preset.keyUrl ?? '',
        freeTier: preset.freeTier ?? '',
        verifyUrl: preset.verifyUrl,
        extra: Boolean(preset.extra),
        paid: Boolean(preset.paid),
        api: preset.api ?? 'openai',
        own: Boolean(preset.own),
        keyless: Boolean(preset.keyless),
        baseUrl: (process.env[`${env}_BASE_URL`] || preset.baseUrl).replace(/\/+$/, ''),
        envKeys,
        uiKeys: (stored.keys[id] ?? []).filter((key) => !envKeys.includes(key)),
        models: uiModels.length ? uiModels : envModels.length ? envModels : preset.models,
        modelsCustom: uiModels.length > 0,
      };
    });
}

/**
 * Subscription CLIs the user switched on in the dashboard (see core/cliProvider.js). The ids and
 * labels are passed in so this file does not have to import that module.
 */
export function readSubscriptions(keysFile, agents) {
  const stored = loadStoredKeys(keysFile);
  return Object.entries(agents)
    .filter(([id]) => stored.cli[id])
    .map(([id, agent]) => ({ id, label: agent.label, kind: 'cli', baseUrl: `cli://${id}`, keys: [''], models: stored.models[id]?.length ? stored.models[id] : ['default'] }));
}

/** The providers that can actually be used: a base URL, at least one key, at least one model. */
export function readProviders(keysFile, agents = {}) {
  // What you already pay for goes first: its limits do the work, and the free tiers are the fallback.
  return [...readSubscriptions(keysFile, agents), ...readApiProviders(keysFile)];
}

function readApiProviders(keysFile) {
  const usable = providerCatalog(keysFile).flatMap((p) => {
    let keys = [...p.envKeys, ...p.uiKeys];
    // A keyless custom endpoint (local Ollama, LM Studio) is still a valid provider.
    if ((p.id === 'custom' || p.keyless) && p.baseUrl && !keys.length) keys = [''];
    if (!p.baseUrl || !keys.length || !p.models.length) return [];
    return [{ id: p.id, label: p.label, baseUrl: p.baseUrl, keys, models: p.models, paid: p.paid, api: p.api }];
  });
  // Paid keys go before the free ones, or after them as a fallback: the user's choice (keys dialog).
  const paidFirst = loadStoredKeys(keysFile).settings.paidOrder !== 'last';
  return [...usable.filter((p) => p.paid === paidFirst), ...usable.filter((p) => p.paid !== paidFirst)];
}

export function loadConfig(overrides = {}) {
  loadDotEnv();
  const mock = overrides.mock ?? process.env.KADHAI_MOCK === '1';
  const workspaceDir = path.resolve(
    DATA,
    overrides.workspaceDir ?? process.env.WORKSPACE_DIR ?? 'workspace',
  );
  const keysFile = overrides.keysFile ?? path.join(DATA, 'keys.local.json');
  return {
    root: ROOT,
    data: DATA,
    // Keys and model lists entered in the dashboard (see core/keyStore.js).
    keysFile,
    // Connected accounts such as Google (see core/connectors/).
    connectorsFile: overrides.connectorsFile ?? path.join(DATA, 'connectors.local.json'),
    // Custom agents the user hired in the dashboard (see core/customAgents.js).
    agentsFile: overrides.agentsFile ?? path.join(DATA, 'agents.local.json'),
    // The skills library: markdown files an agent can load (see core/skills.js).
    skillsDir: overrides.skillsDir ?? path.join(ROOT, 'skills'),
    // Skills the user wrote in the dashboard: kept apart from the built-in ones, and out of git.
    ownSkillsDir: overrides.ownSkillsDir ?? path.join(DATA, 'skills.local'),
    version: VERSION,
    host: '127.0.0.1',
    port: overrides.port ?? int('PORT', 4747),
    workspaceDir,
    mock,
    watch: overrides.watch ?? false,
    // True only where a dashboard can answer command-approval requests.
    interactive: overrides.interactive ?? false,
    // Keep chat, run list and usage across restarts (.kadhai/state.json).
    persist: overrides.persist ?? false,
    // Notice when another room (another process) changes the key file. Only the dashboard server asks for it.
    watchKeys: overrides.watchKeys ?? false,
    // The journal of past runs and the lessons drawn from them (.kadhai/journal.jsonl, lessons.json): kept wherever state is.
    journal: overrides.journal ?? overrides.persist ?? false,
    // Encrypt keys an older version saved as plain text. Only the three entry points ask for it (and a test
    // that names a key file of its own): an engine built with the default file must never rewrite it.
    sealSecrets: overrides.sealSecrets ?? Boolean(overrides.keysFile),
    // Triggers (a webhook, GitHub, Linear, Telegram) can start runs. Only the dashboard's server switches them on;
    // a test does so by naming a file of its own.
    triggers: overrides.triggers ?? Boolean(overrides.triggersFile),
    triggersFile: overrides.triggersFile ?? path.join(DATA, 'triggers.local.json'),
    // Flows (scheduled and chained tasks) start runs by themselves too: same rule as triggers.
    flows: overrides.flows ?? Boolean(overrides.flowsFile),
    flowsFile: overrides.flowsFile ?? path.join(DATA, 'flows.local.json'),
    // Keys and webhook addresses for flows' service and HTTP nodes: shared by every room, like the key file.
    credentialsFile: overrides.credentialsFile ?? path.join(DATA, 'credentials.local.json'),
    mcpConfigPath: overrides.mcpConfigPath ?? path.join(DATA, 'mcp.config.json'),
    providers:
      overrides.providers ??
      (mock
        ? [{ id: 'mock', label: 'Mock', baseUrl: 'mock://local', keys: ['demo'], models: ['alpha', 'beta'] }]
        : readProviders(keysFile, overrides.cliAgents ?? {})),
    limits: {
      maxSubtasks: int('MAX_SUBTASKS', 6),
      maxReviewRounds: int('MAX_REVIEW_ROUNDS', 1),
      maxToolRounds: int('MAX_TOOL_ROUNDS', 3),
      maxOutputTokens: int('MAX_OUTPUT_TOKENS', 4096),
      fileContextChars: int('FILE_CONTEXT_CHARS', 24000),
      requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 60000),
      maxRateWaitMs: int('MAX_RATE_WAIT_MS', 30000),
      execMode: ['ask', 'auto', 'off'].includes(process.env.EXEC_MODE) ? process.env.EXEC_MODE : 'ask',
      execTimeoutMs: int('EXEC_TIMEOUT_MS', 60000),
      keepRunning: int('KEEP_RUNNING', 3), // commands you start that run until stopped (dev servers)
      execOutputChars: int('EXEC_OUTPUT_CHARS', 6000),
      execSandbox: process.env.EXEC_SANDBOX === 'docker' ? 'docker' : 'none',
      execDockerImage: process.env.EXEC_DOCKER_IMAGE || 'node:22-alpine',
      execDockerNetwork: process.env.EXEC_DOCKER_NETWORK || 'none',
      lockTtlMs: 120000,
      lockTimeoutMs: 15000,
      ...overrides.limits,
    },
  };
}
