/**
 * What the crew is doing, as lines in a terminal: the plan, each step as it changes, commands and
 * their results, files written, the Chef's reply. Fed the same events the dashboard gets. It never
 * writes to stdout itself: `out(text)` is handed in by the CLI (src/ never prints - see util.js).
 * No emoji: words and text marks, as everywhere in Kadhai.
 */

const CODES = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, grey: 90 };
const OUTPUT_TAIL = 8; // lines of a failed command's output shown

export function colours(on) {
  const paint = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return Object.fromEntries(Object.entries(CODES).map(([name, code]) => [name, paint(code)]));
}

/** **bold** and `code` from the Chef's replies, as terminal styles. */
export function markdownLite(text, c) {
  return String(text ?? '')
    .replace(/\*\*([^*\n]+)\*\*/g, (_, s) => c.bold(s))
    .replace(/`([^`\n]+)`/g, (_, s) => c.cyan(s));
}

export function createRenderer({ out, color = false, verbose = false, nameOf = (id) => id, onRequest, onResolved, onAsk, onDone }) {
  const c = colours(color);
  const steps = new Map(); // runId -> [status of each step]
  const outputs = new Map(); // command id -> its output so far (kept short)
  const working = new Map(); // agent id -> the task last shown
  let thinking = null; // the agent whose thought stream is being printed (verbose)
  const line = (text = '') => out(`${text}\n`);
  const endThought = () => {
    if (thinking) out('\n');
    thinking = null;
  };

  const MARK = { done: c.green('[x]'), failed: c.red('[!]'), skipped: c.grey('[-]'), working: c.yellow(' > ') };

  return function render({ type, data }) {
    if (type !== 'agent:thought') endThought();
    switch (type) {
      case 'run:start':
        line();
        line(`${c.bold('kadhai')} ${c.dim('is on it:')} ${data.request.split('\n')[0]}`);
        break;
      case 'run:plan': {
        const before = steps.get(data.runId);
        const now = data.subtasks.map((s) => s.status);
        if (!before) {
          line(`${c.bold('plan')} ${data.objective}`);
          data.subtasks.forEach((s, i) => line(`   ${c.grey(`${i + 1}.`)} ${s.title} ${c.grey(`(${s.cook})`)}`));
        } else {
          data.subtasks.forEach((s, i) => {
            if (before[i] === s.status || s.status === 'pending') return;
            const summary = s.summary && s.status !== 'working' ? `: ${s.summary}` : '';
            line(`${MARK[s.status] ?? '   '} ${i + 1}. ${s.title} ${c.grey(`(${s.cook})`)}${summary}`);
          });
        }
        steps.set(data.runId, now);
        break;
      }
      case 'agent:update': {
        const agent = data.agent;
        if (agent.state === 'limit-reached' && agent.task) line(c.dim(`    ${agent.name}: ${agent.task}`));
        // Without --verbose only the Chef's own work shows (planning, reading attachments): the steps say the rest.
        const shown = verbose || agent.role === 'manager';
        if (shown && agent.state === 'working' && agent.task && working.get(agent.id) !== agent.task) line(c.dim(`    ${agent.name}: ${agent.task}`));
        working.set(agent.id, agent.state === 'working' ? agent.task : null);
        break;
      }
      case 'agent:thought':
        if (!verbose) break;
        if (thinking !== data.id) {
          endThought();
          out(c.grey(`    [${nameOf(data.id)} thinking] `));
          thinking = data.id;
        }
        out(c.grey(String(data.delta).replace(/\n/g, '\n    ')));
        break;
      case 'exec:request':
        onRequest?.(data);
        break;
      case 'exec:resolved':
        onResolved?.(data);
        break;
      case 'exec:start':
        outputs.set(data.id, '');
        line(`    ${c.magenta('$')} ${data.command} ${c.grey(`(${data.owner === 'user' ? 'you' : nameOf(data.owner)})`)}`);
        break;
      case 'exec:output': {
        const text = (outputs.get(data.id) ?? '') + data.chunk;
        outputs.set(data.id, text.slice(-4000));
        if (verbose) out(c.grey(data.chunk.replace(/^/gm, '      ')));
        break;
      }
      case 'exec:end': {
        const text = outputs.get(data.id) ?? '';
        outputs.delete(data.id);
        const ok = data.code === 0;
        line(`      ${ok ? c.green('exit 0') : c.red(`exit ${data.code}${data.timedOut ? ' (timed out)' : ''}`)}`);
        if (!ok && !verbose && text.trim()) {
          for (const l of text.trimEnd().split('\n').slice(-OUTPUT_TAIL)) line(c.grey(`      ${l}`));
        }
        break;
      }
      case 'fs:write':
        if (data.owner && data.owner !== 'user' && !/^system|^memory/.test(data.owner) && !/(^|\/)memory\.md$/i.test(data.path)) {
          line(`    ${c.cyan(data.deleted ? 'deleted' : 'wrote')} ${data.path} ${c.grey(`(${nameOf(data.owner)})`)}`);
        }
        break;
      case 'provider:swap':
        line(c.dim(`    model: ${data.from} -> ${data.to}`));
        break;
      case 'chat:message': {
        const m = data.message;
        if (m.role !== 'manager' || !m.runId) break;
        line();
        for (const l of markdownLite(m.text, c).split('\n')) line(`  ${l}`);
        if (m.ask?.length) onAsk?.(m);
        break;
      }
      case 'run:done':
        line(`  ${data.ok ? c.green('[x] done') : c.red('[!] not done')}${data.tokens ? c.grey(`  ${data.tokens.toLocaleString('en-US')} tokens, ${data.flame ?? 'low'} flame`) : ''}`);
        onDone?.(data);
        break;
      default:
    }
  };
}
