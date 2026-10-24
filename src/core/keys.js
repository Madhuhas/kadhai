import { MOCK_PROVIDERS, detectProvider, providerCatalog, readProviders } from '../config.js';
import { mockCompletion } from './mockProvider.js';
import { loadStoredKeys, saveStoredKeys, keyId, maskKey, verifyKey } from './keyStore.js';
import { CLI_AGENTS, complete, onPath } from './cliProvider.js';

const MAX_MODELS = 8;
const MAX_LISTED_MODELS = 150;
const MAX_ENDPOINTS = 10;
const fail = (message, status) => Object.assign(new Error(message), { status });

// Models that cost nothing are the ones worth seeing first.
const freeFirst = (models) => [...models].sort((a, b) => b.endsWith(':free') - a.endsWith(':free'));

/**
 * Managing provider keys and model lists from the dashboard, live: every
 * change rebuilds the dispatcher's route table, so no restart is needed.
 * Nothing here ever returns a key - only its mask and an opaque id.
 */
export function createKeyService({ config, dispatcher, bus, verify = verifyKey }) {
  const file = config.keysFile;
  // Providers without a base URL (an unconfigured "custom") cannot take a key.
  const catalog = () => providerCatalog(file).filter((p) => p.baseUrl);

  const find = (id) => {
    const provider = catalog().find((p) => p.id === id);
    if (!provider) throw fail('Unknown provider', 404);
    return provider;
  };

  // The saved daily limit applies from the first call.
  dispatcher.setPaidBudget(loadStoredKeys(file).settings.paidDailyTokens);

  const apply = () => {
    dispatcher.setPaidBudget(loadStoredKeys(file).settings.paidDailyTokens);
    if (!config.mock) {
      config.providers = readProviders(file, CLI_AGENTS);
      dispatcher.setProviders(config.providers);
    }
    bus.publish('keys:update', {});
  };

  return {
    /**
     * "Try the demo": demo mode for someone who has no key yet, so the desktop app can be looked around
     * like `npm run demo`. Only while nothing is set up, so pretend answers never mix with real ones.
     * Adding a key (or switching on a subscription) leaves it, exactly as it leaves demo mode.
     */
    practice() {
      if (config.mock) return { demo: true };
      if (config.providers.length) throw fail('The demo is for before you add a key: real models are already set up.', 409);
      config.mock = true;
      config.providers = MOCK_PROVIDERS;
      dispatcher.completion = mockCompletion;
      dispatcher.setProviders(config.providers);
      bus.publish('keys:update', {});
      return { demo: true };
    },

    /** The key file was changed by another room: take up what it holds now. A no-op when nothing differs. */
    reload() {
      if (config.mock) return;
      if (JSON.stringify(readProviders(file, CLI_AGENTS)) === JSON.stringify(config.providers) && loadStoredKeys(file).settings.paidDailyTokens === dispatcher.paidBudget) return;
      apply();
    },

    /** Subscription CLIs: which exist, which are installed here, which are switched on. */
    subscriptions() {
      const stored = loadStoredKeys(file);
      return Object.entries(CLI_AGENTS).map(([id, agent]) => ({
        id,
        label: agent.label,
        plan: agent.plan,
        docs: agent.docs,
        signIn: agent.signIn,
        terms: agent.terms ?? null,
        command: agent.command[0],
        installed: onPath(agent.command[0]),
        enabled: Boolean(stored.cli[id]),
        models: stored.models[id] ?? [],
      }));
    },

    /** Switch a subscription CLI on or off as a source of models. */
    async setSubscription(id, enabled) {
      const agent = CLI_AGENTS[id];
      if (!agent) throw fail('Unknown subscription', 404);
      if (enabled && !onPath(agent.command[0])) {
        throw fail(`${agent.label} is not installed on this computer: the "${agent.command[0]}" command was not found. Install it, sign in with "${agent.signIn}", then switch it on.`, 409);
      }
      const stored = loadStoredKeys(file);
      if (enabled) stored.cli[id] = true;
      else delete stored.cli[id];
      await saveStoredKeys(file, stored);
      // Like adding a key: this is how the operator leaves demo mode.
      if (enabled && config.mock) {
        config.mock = false;
        dispatcher.completion = complete;
      }
      apply();
      return { id, enabled: Boolean(enabled) };
    },

    /** Which of the CLI's models to use, best first. An empty list means whatever the CLI is set to. */
    async setSubscriptionModels(id, models) {
      if (!CLI_AGENTS[id]) throw fail('Unknown subscription', 404);
      if (!Array.isArray(models)) throw fail('"models" must be a list of model names', 400);
      const list = [...new Set(models.map((m) => String(m).trim()).filter(Boolean))];
      if (list.length > MAX_MODELS) throw fail(`At most ${MAX_MODELS} models`, 400);
      if (list.some((m) => !/^[\w.:/@-]{1,80}$/.test(m))) throw fail('A model name can hold letters, digits and . : / @ - only', 400);
      const stored = loadStoredKeys(file);
      if (list.length) stored.models[id] = list;
      else delete stored.models[id];
      await saveStoredKeys(file, stored);
      apply();
      return { models: list };
    },

    list() {
      return catalog().map((p) => {
        const keys = [
          ...p.envKeys.filter(Boolean).map((key) => ({ id: keyId(key), masked: maskKey(key), source: 'env' })),
          ...p.uiKeys.map((key) => ({ id: keyId(key), masked: maskKey(key), source: 'ui' })),
        ];
        return {
          id: p.id,
          label: p.label,
          keyUrl: p.keyUrl,
          freeTier: p.freeTier,
          extra: p.extra,
          paid: p.paid,
          own: p.own,
          keyless: p.keyless,
          baseUrl: p.own ? p.baseUrl : undefined,
          models: p.models,
          modelsCustom: p.modelsCustom,
          // A key with no model to use it on does nothing yet.
          needsModels: (keys.length > 0 || p.keyless) && p.models.length === 0,
          keys,
        };
      });
    },

    /** How paid keys are used: before or after the free ones, and how many tokens a day at most. */
    settings() {
      return { ...loadStoredKeys(file).settings, paidUsedToday: dispatcher.paidUsedToday() };
    },

    async setSettings(input = {}) {
      const stored = loadStoredKeys(file);
      if ('paidOrder' in input) {
        if (!['first', 'last'].includes(input.paidOrder)) throw fail('paidOrder is "first" or "last"', 400);
        stored.settings.paidOrder = input.paidOrder;
      }
      if ('paidDailyTokens' in input) {
        const tokens = Number(input.paidDailyTokens);
        if (!Number.isInteger(tokens) || tokens < 0 || tokens > 1e10) throw fail('The daily limit is a whole number of tokens (0 for no limit)', 400);
        stored.settings.paidDailyTokens = tokens;
      }
      await saveStoredKeys(file, stored);
      apply();
      return this.settings();
    },

    /** Any server that speaks the OpenAI dialect: another vendor, a gateway, a model on this machine. */
    async addEndpoint({ name, baseUrl, paid = true } = {}) {
      const label = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      if (label.length < 2) throw fail('Give the endpoint a name', 400);
      let url;
      try {
        url = new URL(String(baseUrl ?? '').trim());
      } catch {
        throw fail('Give the full base address, e.g. https://api.example.com/v1', 400);
      }
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      // A key sent over plain http can be read on the way; only this machine is exempt.
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw fail('The address must start with https:// (http:// is accepted for this computer only)', 400);
      const stored = loadStoredKeys(file);
      if (stored.endpoints.length >= MAX_ENDPOINTS) throw fail(`At most ${MAX_ENDPOINTS} endpoints of your own`, 409);
      const taken = new Set(catalog().map((p) => p.id));
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'endpoint';
      let id = `own-${slug}`;
      for (let n = 2; taken.has(id); n++) id = `own-${slug}-${n}`;
      // A model on this machine needs no key and costs nothing.
      stored.endpoints.push({ id, label, baseUrl: url.href.replace(/\/+$/, ''), paid: local ? false : Boolean(paid), keyless: local });
      await saveStoredKeys(file, stored);
      apply();
      return { id, label, keyless: local };
    },

    async removeEndpoint(id) {
      const stored = loadStoredKeys(file);
      if (!stored.endpoints.some((e) => e.id === id)) throw fail('No such endpoint', 404);
      stored.endpoints = stored.endpoints.filter((e) => e.id !== id);
      delete stored.keys[id];
      delete stored.models[id];
      await saveStoredKeys(file, stored);
      apply();
      return { removed: id };
    },

    /** A key pasted without saying whose it is: its prefix often tells. */
    async addAny(rawKey) {
      const key = String(rawKey ?? '').trim();
      const id = detectProvider(key);
      if (!id) throw fail('This key does not say which provider it is from. Pick the provider below and paste it there.', 422);
      return { provider: id, label: find(id).label, ...(await this.add(id, key)) };
    },

    async add(providerId, rawKey) {
      const provider = find(providerId);
      const key = String(rawKey ?? '').trim();
      if (key.length < 8 || key.length > 400 || /\s/.test(key)) throw fail('That does not look like an API key', 400);
      if ([...provider.envKeys, ...provider.uiKeys].includes(key)) throw fail('This key is already saved', 409);

      const check = await verify(provider, key);
      if (check.rejected) throw fail(`${provider.label} rejected this key. Check that you copied all of it.`, 400);

      const stored = loadStoredKeys(file);
      stored.keys[provider.id] = [...(stored.keys[provider.id] ?? []), key];
      await saveStoredKeys(file, stored);

      // Adding a real key is how the operator leaves demo mode.
      if (config.mock) {
        config.mock = false;
        dispatcher.completion = complete;
      }
      apply();
      return {
        added: true,
        paid: provider.paid,
        verified: check.verified,
        // Some providers have no cheap way to test a key; it is then proven on first use.
        checkable: provider.verifyUrl !== false,
        needsModels: provider.models.length === 0,
        // Configured models this provider does not list: those routes would just fail.
        missingModels: check.models.length ? provider.models.filter((m) => !check.models.includes(m)) : [],
        availableModels: freeFirst(check.models).slice(0, MAX_LISTED_MODELS),
      };
    },

    /** What the provider offers right now, for picking models in the dashboard. */
    async available(providerId) {
      const provider = find(providerId);
      const key = [...provider.envKeys, ...provider.uiKeys].find(Boolean) ?? '';
      const check = await verify(provider, key);
      return { models: freeFirst(check.models).slice(0, MAX_LISTED_MODELS) };
    },

    async remove(providerId, id) {
      const provider = find(providerId);
      if (provider.envKeys.some((key) => keyId(key) === id)) {
        throw fail('This key comes from the .env file. Remove it there and restart.', 409);
      }
      const stored = loadStoredKeys(file);
      const kept = (stored.keys[provider.id] ?? []).filter((key) => keyId(key) !== id);
      if (kept.length === (stored.keys[provider.id] ?? []).length) throw fail('Key not found', 404);
      stored.keys[provider.id] = kept;
      await saveStoredKeys(file, stored);
      apply();
      return { removed: true };
    },

    /** An empty list goes back to the defaults. */
    async setModels(providerId, models) {
      const provider = find(providerId);
      if (!Array.isArray(models)) throw fail('"models" must be a list of model names', 400);
      const list = [...new Set(models.map((m) => String(m).trim()).filter(Boolean))];
      if (list.length > MAX_MODELS) throw fail(`At most ${MAX_MODELS} models per provider`, 400);
      if (list.some((m) => m.length > 120 || /\s/.test(m))) throw fail('Model names cannot contain spaces', 400);
      const stored = loadStoredKeys(file);
      if (list.length) stored.models[provider.id] = list;
      else delete stored.models[provider.id];
      await saveStoredKeys(file, stored);
      apply();
      return { models: find(providerId).models };
    },
  };
}
