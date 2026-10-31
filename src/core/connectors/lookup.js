import { SERVICES, runService } from '../services.js';

/**
 * Built-in look-ups for the cooks: the keyless, read-only flow services (weather, Wikipedia,
 * exchange rates, Hacker News) as one connection, so a question about today's weather gets a
 * real answer without an MCP server or a key. Nothing here writes or sends anything.
 */
const LOOKUPS = [
  ['weather', 'weather', 'forecast'],
  ['wikipedia', 'wikipedia', 'summary'],
  ['wikipedia_search', 'wikipedia', 'search'],
  ['currency', 'currency', 'convert'],
  ['hackernews', 'hackernews', 'search'],
];

export const LOOKUP_ABOUT = 'built in, free: current weather and a 3-day forecast for a place, Wikipedia articles, currency conversion, Hacker News stories';
const RESULT_CHARS = 6000;

export class LookupConnector {
  constructor({ fetch = globalThis.fetch } = {}) {
    this.fetch = fetch;
    this.list = LOOKUPS.map(([tool, service, action]) => {
      const s = SERVICES[service];
      const a = s.actions[action];
      return { name: `lookup__${tool}`, service, action, params: a.fields.map((f) => f.id), description: `${s.label}: ${a.label}. ${s.about ?? ''}`.trim() };
    });
  }

  tools() {
    return this.list.map(({ name, params, description }) => ({ name, params, description }));
  }

  async call(name, args = {}) {
    const tool = this.list.find((t) => t.name === name);
    if (!tool) throw new Error(`unknown tool "${name}"`);
    const out = await runService({ service: tool.service, action: tool.action }, args ?? {}, { fetch: this.fetch, signal: AbortSignal.timeout(20_000) });
    const text = typeof out === 'string' ? out : JSON.stringify(out);
    return text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}\n[cut]` : text;
  }
}
