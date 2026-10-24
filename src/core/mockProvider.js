import { ProviderError } from './providers.js';
import { estimateTokens, sleep } from './util.js';
import { CONDENSE_MARK } from './prompts.js';
import { DRAFT_MARK } from './flowDraft.js';
import { AGENT_DRAFT_MARK } from './agentDraft.js';

/**
 * Offline stand-in for the real providers ("npm run demo").
 * Route "alpha" throws a 429 on every third call so the failover, the
 * [Limit-Reached] badge and the hot-swap toast can all be seen without a key.
 */
const calls = new WeakMap();

function script(role, prompt) {
  if (prompt.includes(CONDENSE_MARK)) {
    const name = /^Name: (.*)$/m.exec(prompt)?.[1] ?? 'the skill';
    return `- Follow ${name} (condensed by the mock crew).
- Keep functions small and name them for what they do.
- Test the edge cases first.`;
  }
  if (prompt.includes(AGENT_DRAFT_MARK)) {
    return JSON.stringify({
      name: 'Test Writer',
      specialty: 'Unit and integration tests with node:test; test data and fixtures',
      instructions: '- Write the failing test first, then make it pass.\n- One behaviour per test, named for what it checks.\n- Never touch the network in a test.',
      skills: [],
    });
  }
  if (prompt.includes(DRAFT_MARK)) {
    // "Describe a flow": always the same small drawing, so the canvas can be tried without a key.
    return JSON.stringify({
      name: 'Morning weather note',
      description: 'Every morning: the weather, one short note, kept in a file.',
      nodes: [
        { id: 't', type: 'trigger', config: { kind: 'schedule', schedule: { kind: 'daily', time: '08:00', days: [] } } },
        { id: 'wx', type: 'service', name: 'Weather', config: { service: 'weather', action: 'forecast', params: { place: 'Chennai' } } },
        { id: 'ai', type: 'ai', name: 'Write the note', config: { prompt: 'Write two friendly lines about this weather:\n\n{{ input }}', json: false } },
        { id: 'f', type: 'file', name: 'Keep it', config: { op: 'append', path: 'notes/weather.md', content: '{{ today }}: {{ input }}' } },
      ],
      edges: [{ from: 't', to: 'wx' }, { from: 'wx', to: 'ai' }, { from: 'ai', to: 'f' }],
      notes: ['Demo mode: this is a fixed example, not your request. Add a free key for real drawings.'],
    });
  }
  const request = (/## User request\n([\s\S]*)$/.exec(prompt)?.[1] ?? '').trim();

  if (role === 'manager') {
    if (request.endsWith('?')) {
      return JSON.stringify({
        objective: '',
        reply: `Demo mode: no real model is connected, so I cannot answer "${request}". Add a free API key to .env for real answers.`,
        subtasks: [],
      });
    }
    return JSON.stringify({
      objective: `Demo build for: ${request.slice(0, 80)}`,
      reply: '',
      verify: prompt.includes('"verify"') ? 'node --check demo/app.js' : '',
      subtasks: [
        {
          title: 'Create the demo page',
          level: 'simple',
          instructions: 'Write demo/index.html that loads app.js.',
          files: ['demo/index.html'],
          // High flame asks which steps build on which: these two do not, so they cook side by side.
          ...(prompt.includes('"needs"') ? { needs: [] } : {}),
        },
        {
          title: 'Add the demo script',
          instructions: 'Write demo/app.js that greets the user.',
          files: ['demo/app.js'],
          ...(prompt.includes('"needs"') ? { needs: [] } : {}),
        },
      ],
    });
  }

  if (role === 'coder') {
    const files = (/^Files to produce: (.+)$/m.exec(prompt)?.[1] ?? 'demo/notes.txt').split(',').map((s) => s.trim());
    const blocks = files.map((file) => {
      const body = file.endsWith('.html')
        ? '<!doctype html>\n<html>\n  <body>\n    <h1 id="out">Kadhai demo</h1>\n    <script src="app.js"></script>\n  </body>\n</html>'
        : file.endsWith('.js')
          ? "document.getElementById('out').textContent = 'Cooked by the mock crew at ' + new Date().toLocaleTimeString();"
          : 'Written by the mock cook.';
      return `<<<FILE ${file}>>>\n${body}\n<<<END>>>`;
    });
    // Second round: the command output came back, so just wrap up.
    if (prompt.includes('## Data you requested')) return `SUMMARY: Wrote ${files.join(', ')} and checked it (mock output).`;
    const check = files.find((f) => f.endsWith('.js'));
    if (check && prompt.includes('<<<RUN')) blocks.push(`<<<RUN node --check ${check}>>>`);
    return `Thinking about ${files.join(', ')}...\n${blocks.join('\n')}\nSUMMARY: Wrote ${files.join(', ')} (mock output).`;
  }

  return JSON.stringify({ verdict: 'approve', issues: [], summary: 'Mock review: files are consistent.', lessons: ['The demo page and its script live in the demo/ folder.'] });
}

export async function mockCompletion(route, req, { signal, onDelta, role } = {}) {
  const count = (calls.get(route) ?? 0) + 1;
  calls.set(route, count);
  await sleep(250, signal);
  if (route.model === 'alpha' && count % 3 === 0) {
    throw new ProviderError('Mock alpha HTTP 429: simulated free-tier limit', {
      kind: 'rate_limit',
      status: 429,
      retryAfterMs: 8000,
    });
  }

  const prompt = req.messages.at(-1).content;
  const text = script(role, `${req.messages[0].content}\n${prompt}`);
  for (const piece of text.match(/[\s\S]{1,14}/g) ?? []) {
    await sleep(18, signal);
    onDelta?.({ type: 'text', text: piece });
  }
  return {
    text,
    reasoning: '',
    finishReason: 'stop',
    usage: { promptTokens: estimateTokens(prompt), completionTokens: estimateTokens(text), estimated: true },
  };
}
