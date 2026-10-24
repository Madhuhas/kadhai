import { complete } from './cliProvider.js';
import { sleep } from './util.js';

export class DispatchError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'DispatchError';
    this.code = code; // NO_PROVIDERS | RATE_LIMITED | EXHAUSTED | BUDGET
    Object.assign(this, extra);
  }
}

const today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD
const freshDay = () => ({ date: today(), calls: 0, promptTokens: 0, completionTokens: 0, rateLimits: 0 });

const COOLDOWN = { rateLimitDefault: 60000, rateLimitMin: 3000, rateLimitMax: 600000, transient: 15000 };

/**
 * Universal failover dispatcher.
 *
 * Every (provider, key, model) combination is a "route". Routes are interleaved
 * by tier - each provider's best model first - so a 429 hops to the *next
 * provider* before it falls back to a weaker model. A failing route is put on
 * cooldown (or disabled) and the same request is replayed on the next one; the
 * caller never sees the failure unless every route is out.
 */
export class Dispatcher {
  #activeId = null;
  // Tokens a day that paid routes may use between them; 0 = no limit.
  paidBudget = 0;

  constructor({ config, bus, completion = complete }) {
    this.bus = bus;
    this.completion = completion;
    this.limits = config.limits;
    this.routes = Dispatcher.buildRoutes(config.providers);
  }

  static buildRoutes(providers) {
    const perProvider = providers.map((p) => {
      const combos = [];
      for (const model of p.models) {
        p.keys.forEach((key, keyIndex) => {
          const keyTag = p.keys.length > 1 ? `#${keyIndex + 1}` : '';
          combos.push({
            id: `${p.id}${keyTag}/${model}`,
            provider: p.id,
            kind: p.kind ?? 'api', // 'cli': a subscription CLI, not an HTTP endpoint
            command: p.command, // only for tests: another program standing in for the CLI
            api: p.api ?? 'openai',
            paid: Boolean(p.paid), // billed per call: counted against the daily limit
            label: `${p.label}${keyTag}`,
            baseUrl: p.baseUrl,
            key,
            model,
            cooldownUntil: 0,
            disabled: null,
            lastError: null,
            stats: { calls: 0, promptTokens: 0, completionTokens: 0, errors: 0, rateLimits: 0 },
            day: freshDay(), // free quotas are daily, so this is the number that matters
            quota: null, // what the provider itself last reported as remaining
          });
        });
      }
      return combos;
    });
    const routes = [];
    const depth = Math.max(0, ...perProvider.map((c) => c.length));
    for (let tier = 0; tier < depth; tier++) {
      for (const combos of perProvider) if (combos[tier]) routes.push(combos[tier]);
    }
    return routes;
  }

  #view(route) {
    const now = Date.now();
    const cooling = route.cooldownUntil > now;
    return {
      id: route.id,
      provider: route.provider,
      kind: route.kind,
      paid: route.paid,
      overBudget: this.#overBudget(route),
      label: route.label,
      model: route.model,
      status: route.disabled ? 'disabled' : cooling ? 'cooling' : route.id === this.#activeId ? 'active' : 'ready',
      cooldownMs: cooling ? route.cooldownUntil - now : 0,
      reason: route.disabled ?? route.lastError,
      stats: { ...route.stats },
      day: { ...this.#day(route) },
      quota: route.quota,
    };
  }

  #day(route) {
    if (route.day.date !== today()) route.day = freshDay();
    return route.day;
  }

  /** Today's usage per route, for saving across restarts. */
  exportUsage() {
    return Object.fromEntries(this.routes.map((r) => [r.id, this.#day(r)]));
  }

  importUsage(saved) {
    if (!saved || typeof saved !== 'object') return;
    for (const route of this.routes) {
      const day = saved[route.id];
      if (day?.date === today()) route.day = { ...freshDay(), ...day };
    }
  }

  /**
   * Swap in a new provider list at runtime (keys added or removed in the
   * dashboard). Routes that still exist keep their cooldowns and counters.
   */
  setProviders(providers) {
    const previous = new Map(this.routes.map((r) => [r.id, r]));
    this.routes = Dispatcher.buildRoutes(providers).map((route) => {
      const old = previous.get(route.id);
      if (!old || old.key !== route.key) return route;
      const { cooldownUntil, disabled, lastError, stats, day, quota } = old;
      return Object.assign(route, { cooldownUntil, disabled, lastError, stats, day, quota });
    });
    if (!this.routes.some((r) => r.id === this.#activeId)) this.#activeId = null;
    this.#changed();
  }

  /** Tokens paid routes have used today, all together. */
  paidUsedToday() {
    return this.routes.filter((r) => r.paid).reduce((sum, r) => sum + this.#day(r).promptTokens + this.#day(r).completionTokens, 0);
  }

  #overBudget(route) {
    return route.paid && this.paidBudget > 0 && this.paidUsedToday() >= this.paidBudget;
  }

  /** The user's daily limit for paid models, in tokens. 0 lifts it. */
  setPaidBudget(tokens) {
    this.paidBudget = Number.isInteger(tokens) && tokens > 0 ? tokens : 0;
    this.#changed();
  }

  status() {
    return { active: this.#activeId, paid: { budget: this.paidBudget, usedToday: this.paidUsedToday() }, routes: this.routes.map((r) => this.#view(r)) };
  }

  #changed() {
    this.bus?.publish('providers:update', this.status());
  }

  /**
   * tier "light" walks the table from the bottom: weakest (cheapest-to-burn) model first.
   * `prefer` ("<provider>/<model>") is tried before anything else while it is usable;
   * when it is not, the normal order takes over, so failover still works.
   */
  #pick(skipped, tier, prefer) {
    const now = Date.now();
    // A paid route that has used up today's limit sits out; the free ones carry on.
    const usable = (r) => !r.disabled && r.cooldownUntil <= now && !skipped.has(r) && !this.#overBudget(r);
    // High flame: paid keys and subscriptions first (the strong models), then the free ones;
    // light work is not sent to the weakest model there. Low flame: the table as it is.
    const strong = (r) => r.paid || r.kind === 'cli';
    const order = this.limits?.strongFirst
      ? [...this.routes.filter(strong), ...this.routes.filter((r) => !strong(r))]
      : tier === 'light'
        ? [...this.routes].reverse()
        : this.routes;
    const first = prefer ? this.routes.find((r) => `${r.provider}/${r.model}` === prefer && usable(r)) : null;
    return first ?? order.find(usable) ?? null;
  }

  #penalize(route, err, skipped) {
    route.stats.errors += 1;
    route.lastError = err.message;
    switch (err.kind) {
      case 'rate_limit': {
        route.stats.rateLimits += 1;
        this.#day(route).rateLimits += 1;
        const wait = err.retryAfterMs ?? COOLDOWN.rateLimitDefault;
        route.cooldownUntil = Date.now() + Math.min(Math.max(wait, COOLDOWN.rateLimitMin), COOLDOWN.rateLimitMax);
        break;
      }
      case 'auth':
        route.disabled = 'API key rejected';
        break;
      case 'not_found':
        route.disabled = 'Model not available';
        break;
      case 'unavailable':
        // A subscription CLI that is not installed or not signed in: off until the user fixes it.
        route.disabled = err.message;
        break;
      case 'too_large':
      case 'bad_request':
      case 'empty':
        // The route is healthy, it just cannot serve *this* request.
        skipped.add(route);
        break;
      default:
        route.cooldownUntil = Date.now() + COOLDOWN.transient;
    }
  }

  /**
   * req: { messages | build(), json, maxTokens, temperature }
   * `build` is re-run on every attempt, so an incoming provider always gets a
   * freshly read memory.md rather than a stale copy.
   */
  async chat(req, { agent, role, tier, prefer, signal, onDelta, onRoute, onWait } = {}) {
    if (!this.routes.length) {
      throw new DispatchError(
        'NO_PROVIDERS',
        'No models to call yet. Add a free API key or switch on a subscription with the keys button in the dashboard, or try the offline demo with "npm run demo".',
      );
    }

    const skipped = new Set();
    let lastError = null;
    let waits = 0;

    for (;;) {
      signal?.throwIfAborted();
      const route = this.#pick(skipped, tier, prefer);

      if (!route) {
        const live = this.routes.filter((r) => !r.disabled && !skipped.has(r));
        const waiting = live.filter((r) => !this.#overBudget(r));
        if (!waiting.length && live.length) {
          throw new DispatchError('BUDGET', `Today's limit for paid models (${this.paidBudget.toLocaleString('en-US')} tokens) is used up, and there is no free route to fall back on. Raise the limit under keys, or add a free key.`);
        }
        if (!waiting.length) {
          throw new DispatchError('EXHAUSTED', lastError?.message ?? 'Every provider route is disabled. Check your API keys.');
        }
        const wakeAt = Math.min(...waiting.map((r) => r.cooldownUntil));
        const waitMs = Math.max(0, wakeAt - Date.now());
        // How patient to be with rate limits is the flame's call: high flame's bigger prompts meet them more often.
        if (waitMs > this.limits.maxRateWaitMs || waits >= (this.limits.rateWaits ?? 3)) {
          throw new DispatchError(
            'RATE_LIMITED',
            `Every free provider is rate-limited right now. Next slot opens in about ${Math.ceil(waitMs / 1000)}s.`,
            { retryAt: wakeAt },
          );
        }
        waits += 1;
        onWait?.(waitMs);
        await sleep(waitMs + 50, signal);
        continue;
      }

      if (route.id !== this.#activeId) {
        const from = this.#activeId;
        this.#activeId = route.id;
        // Roles prefer different routes, so only a real failover counts as a hot-swap.
        if (from && lastError) this.bus?.publish('provider:swap', { from, to: route.id, agent, reason: lastError.message });
        this.#changed();
      }
      onRoute?.(this.#view(route));

      try {
        const messages = req.build ? await req.build() : req.messages;
        const out = await this.completion(
          route,
          { ...req, messages, maxTokens: req.maxTokens ?? this.limits.maxOutputTokens },
          { signal, onDelta, agent, role, timeoutMs: this.limits.requestTimeoutMs },
        );
        route.stats.calls += 1;
        route.stats.promptTokens += out.usage.promptTokens;
        route.stats.completionTokens += out.usage.completionTokens;
        const day = this.#day(route);
        day.calls += 1;
        day.promptTokens += out.usage.promptTokens;
        day.completionTokens += out.usage.completionTokens;
        if (out.quota) route.quota = out.quota;
        route.lastError = null;
        this.#changed();
        return { ...out, route: this.#view(route) };
      } catch (err) {
        if (signal?.aborted) throw err;
        if (err.name !== 'ProviderError') throw err;
        lastError = err;
        this.#penalize(route, err, skipped);
        this.#changed();
        // Whatever was streamed so far belongs to a dead attempt.
        onDelta?.({ type: 'reset', reason: err.message });
      }
    }
  }

  // ------------------------------------------------ CLI agents (high flame only)

  /**
   * The subscription CLI that should do a step as an agent, or null: the first usable CLI route
   * that can act in this mode (`canAct(provider)`), the agent's preferred model first. Not one
   * HTTP route is ever returned - those stay models.
   */
  agentRoute({ prefer, canAct }) {
    const now = Date.now();
    const usable = (r) => r.kind === 'cli' && canAct(r.provider) && !r.disabled && r.cooldownUntil <= now;
    const route = (prefer && this.routes.find((r) => `${r.provider}/${r.model}` === prefer && usable(r))) ?? this.routes.find(usable) ?? null;
    if (route && route.id !== this.#activeId) {
      this.#activeId = route.id;
      this.#changed();
    }
    return route;
  }

  /** The view of a route, for the agent's card (never the key). */
  viewOf(route) {
    return this.#view(route);
  }

  /** An agent step's usage, counted like any call. */
  charge(route, usage) {
    route.stats.calls += 1;
    route.stats.promptTokens += usage.promptTokens;
    route.stats.completionTokens += usage.completionTokens;
    const day = this.#day(route);
    day.calls += 1;
    day.promptTokens += usage.promptTokens;
    day.completionTokens += usage.completionTokens;
    route.lastError = null;
    this.#changed();
  }

  /** An agent step could not use this CLI: the same cooldown or switch-off as a failed call. */
  fault(route, err) {
    this.#penalize(route, err, new Set());
    this.#changed();
  }

  /** Manual hot-swap: bench the active route for a minute. */
  skipActive() {
    const route = this.routes.find((r) => r.id === this.#activeId) ?? this.#pick(new Set());
    if (!route) return null;
    route.cooldownUntil = Date.now() + 60000;
    route.lastError = 'Benched by operator';
    this.#changed();
    return route.id;
  }

  reset() {
    for (const route of this.routes) {
      route.cooldownUntil = 0;
      route.disabled = null;
      route.lastError = null;
    }
    this.#changed();
  }
}
