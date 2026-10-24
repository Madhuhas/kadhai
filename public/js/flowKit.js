import { h } from './util.js';

/**
 * The pieces of the flows window that are not the canvas itself: what each
 * kind of node is called and offers, the data viewer (tree, table, text) whose
 * fields can be dragged into a setting as {{ expressions }}, the curl parser
 * behind "paste a curl command", and the example flows.
 */

// ------------------------------------------------------------ node kinds

const conditions = () => ({ conditions: [{ left: '{{ input }}', op: 'contains', value: '' }], combine: 'and' });

/** Kinds of node the browser draws. `group` is where it sits in the palette and the node search. */
export const KINDS = {
  trigger: { title: 'Start', tag: '>' },
  agent: { title: 'Agent', tag: '{o}', group: 'AI', hint: 'A task for the crew: planned, cooked and reviewed. Plug apps into it as its tools.', defaults: () => ({ text: '', agent: '' }) },
  ai: { title: 'AI', tag: 'AI', group: 'AI', hint: 'One answer from a model: summarise, classify, translate, pull out fields as JSON.', defaults: () => ({ prompt: 'Summarise this in three short lines:\n\n{{ input }}', system: '', json: false, agent: '' }) },
  if: { title: 'If', tag: '?', group: 'Logic', hint: 'Send what arrives down "true" or "false".', defaults: conditions },
  switch: { title: 'Switch', tag: '<>', group: 'Logic', hint: 'Several branches: the first rule that holds wins, or "else".', defaults: () => ({ rules: [{ left: '{{ input }}', op: 'contains', value: '' }, { left: '{{ input }}', op: 'contains', value: '' }] }) },
  filter: { title: 'Filter', tag: '|', group: 'Logic', hint: 'Go on only if the conditions hold; otherwise stop quietly.', defaults: conditions },
  merge: { title: 'Merge', tag: '><', group: 'Logic', hint: 'Wait for every wire into it, then combine what arrived.', defaults: () => ({ mode: 'append', separator: '' }) },
  wait: { title: 'Wait', tag: '..', group: 'Logic', hint: 'Pause for a while (up to an hour).', defaults: () => ({ seconds: 60 }) },
  set: { title: 'Edit fields', tag: '=', group: 'Data', hint: 'Build an object from fields; values can quote the data.', defaults: () => ({ fields: [{ key: 'text', value: '{{ input }}' }], keep: false }) },
  code: { title: 'Code', tag: 'js', group: 'Data', hint: 'A few lines of JavaScript that return the output.', defaults: () => ({ code: "// input is what arrived, trigger what started the flow,\n// node('Name') the output of another node.\nreturn input;" }) },
  http: { title: 'HTTP request', tag: '->', group: 'Data', hint: 'Call any API. Paste a curl command or import an OpenAPI description.', defaults: () => ({ method: 'GET', url: '', query: [], headers: [], bodyType: 'json', body: '', credential: '' }) },
  flow: { title: 'Run a flow', tag: '[]', group: 'Data', hint: 'Run another of your flows and carry on with its result.', defaults: () => ({ flow: '' }) },
  file: { title: 'File', tag: 'txt', group: 'This computer', hint: 'Read, write or add to a file in the folder.', defaults: () => ({ op: 'append', path: 'notes/flow-log.txt', content: '{{ input }}' }) },
  command: { title: 'Command', tag: '$', group: 'This computer', hint: 'Run a command in the folder. It waits for your OK in "ask" mode.', defaults: () => ({ command: '', failOnError: true }) },
  note: { title: 'Note', tag: '#', group: 'Canvas', hint: 'A sticky note. It never runs.', defaults: () => ({ text: 'A note about this part of the flow.', color: '' }) },
  app: { title: 'App', tag: 'MCP' },
  service: { title: 'Service', tag: 'API' },
};
export const GROUPS = ['AI', 'Logic', 'Data', 'This computer', 'Canvas'];
export const MODEL_KINDS = new Set(['agent', 'ai']);
export const NO_RETRY = new Set(['trigger', 'note', 'agent', 'ai', 'command', 'flow', 'wait']);

export function outPorts(node) {
  if (node.type === 'switch') return [...(node.config.rules ?? []).map((_, i) => String(i + 1)), 'else'];
  if (node.type === 'if') return ['true', 'false'];
  if (node.type === 'note') return [];
  if (node.type === 'app') return ['out', 'tool'];
  return ['out'];
}

export const OPS = [
  ['contains', 'contains'],
  ['not_contains', 'does not contain'],
  ['equals', 'is'],
  ['not_equals', 'is not'],
  ['starts', 'starts with'],
  ['ends', 'ends with'],
  ['matches', 'matches the pattern'],
  ['gt', 'is more than'],
  ['lt', 'is less than'],
  ['empty', 'is empty'],
  ['not_empty', 'is not empty'],
];
export const UNARY = new Set(['empty', 'not_empty']);
const opText = (op) => OPS.find(([id]) => id === op)?.[1] ?? op;
export const conditionText = (c) => `${shortExpr(c.left)} ${opText(c.op)}${UNARY.has(c.op) ? '' : ` "${c.value ?? ''}"`}`;
const shortExpr = (e) => String(e || '{{ input }}').replace(/\{\{\s*|\s*\}\}/g, '');

// ------------------------------------------------------- expressions

const IDENT = /^[A-Za-z_$][\w$-]*$/;
/** An expression for a path inside a root ("input", "trigger" or "node('Name')"). */
export function exprFor(root, path) {
  return `{{ ${root}${path.map((k) => (typeof k === 'number' ? `[${k}]` : IDENT.test(k) ? `.${k}` : `['${String(k).replace(/'/g, '')}']`)).join('')} }}`;
}

/** Text that is JSON, as the value it spells. */
export const parseMaybe = (v) => {
  if (typeof v !== 'string' || !/^\s*[[{]/.test(v)) return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

const preview = (v) => {
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v.length > 120 ? `${v.slice(0, 120)}…` : v);
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === 'object') return `{${Object.keys(v).length}}`;
  return String(v);
};

/** A field you can click (to put it in the setting you were in) or drag (onto any setting). */
function pickable(label, expr, onPick, cls = 'dv-key') {
  const el = h('span', { class: cls, draggable: true, title: `${expr}\nClick to put it in the last setting you were in, or drag it onto one`, onclick: (e) => (e.stopPropagation(), onPick?.(expr)) }, label);
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', expr);
    e.dataTransfer.effectAllowed = 'copy';
  });
  return el;
}

function tree(value, root, path, onPick, depth = 0) {
  const v = parseMaybe(value);
  if (v === null || typeof v !== 'object') return h('span', { class: `dv-val dv-${v === null ? 'null' : typeof v}` }, preview(v));
  const entries = Array.isArray(v) ? v.slice(0, 100).map((x, i) => [i, x]) : Object.entries(v).slice(0, 200);
  const list = h(
    'ul',
    { class: 'dv-tree' },
    ...entries.map(([k, x]) => {
      const inner = parseMaybe(x);
      const nested = inner !== null && typeof inner === 'object';
      const key = pickable(typeof k === 'number' ? `[${k}]` : k, exprFor(root, [...path, k]), onPick);
      if (!nested) return h('li', null, key, h('span', { class: 'dv-colon' }, ': '), tree(inner, root, [...path, k], onPick, depth + 1));
      const body = depth < 6 ? tree(inner, root, [...path, k], onPick, depth + 1) : h('span', { class: 'dv-val' }, preview(inner));
      const open = depth < 1;
      const toggle = h('button', { class: 'dv-toggle', type: 'button', ariaExpanded: String(open), ariaLabel: `Show or hide ${k}`, onclick: () => {
        body.hidden = !body.hidden;
        toggle.textContent = body.hidden ? '+' : '-';
        toggle.ariaExpanded = String(!body.hidden);
      } }, open ? '-' : '+');
      body.hidden = !open;
      return h('li', null, toggle, key, h('span', { class: 'dv-colon' }, ' '), h('span', { class: 'dv-val' }, preview(inner)), body);
    }),
  );
  const more = (Array.isArray(v) ? v.length : Object.keys(v).length) - entries.length;
  if (more > 0) list.append(h('li', { class: 'muted' }, `… ${more} more`));
  return list;
}

function table(value, root, onPick) {
  const v = parseMaybe(value);
  const rows = Array.isArray(v) ? v.slice(0, 50) : v && typeof v === 'object' ? [v] : null;
  if (!rows || !rows.every((r) => r && typeof r === 'object' && !Array.isArray(r))) return h('p', { class: 'muted' }, 'A table shows a list of objects (or one object). Use the tree or the text view for this.');
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, 12);
  const base = Array.isArray(v) ? (i) => [i] : () => [];
  return h(
    'div',
    { class: 'dv-table-wrap' },
    h(
      'table',
      { class: 'dv-table' },
      h('thead', null, h('tr', null, ...(Array.isArray(v) ? [h('th', null, '#')] : []), ...cols.map((c) => h('th', null, pickable(c, exprFor(root, [...base(0), c]), onPick))))),
      h('tbody', null, ...rows.map((r, i) => h('tr', null, ...(Array.isArray(v) ? [h('td', { class: 'muted' }, String(i))] : []), ...cols.map((c) => h('td', null, pickable(preview(parseMaybe(r[c])).replace(/^"|"$/g, ''), exprFor(root, [...base(i), c]), onPick, 'dv-cell')))))),
    ),
  );
}

/**
 * The data viewer: one value, shown as a tree, a table or text. `root` is the expression a
 * picked field starts from ("input", "trigger", "node('Name')").
 */
export function dataView(value, { root = 'input', mode = 'tree', onPick } = {}) {
  if (value === undefined) return h('p', { class: 'muted dv-empty' }, 'No data yet.');
  if (mode === 'text') return h('pre', { class: 'dv-text' }, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  if (mode === 'table') return table(value, root, onPick);
  const v = parseMaybe(value);
  return h('div', { class: 'dv' }, pickable(root === 'input' ? 'input' : root, `{{ ${root} }}`, onPick, 'dv-key dv-root'), h('span', { class: 'dv-colon' }, ' '), v !== null && typeof v === 'object' ? h('span', { class: 'dv-val' }, preview(v)) : null, tree(v, root, [], onPick));
}

// ------------------------------------------------------------- curl

/** Split a shell command line the way curl examples are written (quotes, backslash line breaks). */
function words(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  let any = false;
  const s = cmd.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && /["\\$`]/.test(s[i + 1])) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      any = true;
      if (c === "'" && s[i - 1] === '$') cur = cur.slice(0, -1);
    } else if (/\s/.test(c)) {
      if (cur || any) out.push(cur);
      cur = '';
      any = false;
    } else if (c === '\\' && i + 1 < s.length) cur += s[++i];
    else cur += c;
  }
  if (cur || any) out.push(cur);
  return out;
}

/**
 * A curl command as an HTTP node's settings. An Authorization header, a key-like
 * header or -u comes back separately as `auth`, so it can become a credential
 * instead of sitting in the flow in plain text.
 */
export function parseCurl(cmd) {
  const w = words(String(cmd).trim());
  if (!/^curl(\.exe)?$/i.test(w[0] ?? '')) throw new Error('That does not start with "curl"');
  let method = '';
  let url = '';
  const headers = [];
  const data = [];
  let user = '';
  let get = false;
  for (let i = 1; i < w.length; i++) {
    const a = w[i];
    const next = () => w[++i] ?? '';
    if (a === '-X' || a === '--request') method = next().toUpperCase();
    else if (a === '-H' || a === '--header') {
      const line = next();
      const at = line.indexOf(':');
      if (at > 0) headers.push({ key: line.slice(0, at).trim(), value: line.slice(at + 1).trim() });
    } else if (['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode'].includes(a)) data.push(next());
    else if (a === '--json') {
      data.push(next());
      headers.push({ key: 'Content-Type', value: 'application/json' });
    } else if (a === '-u' || a === '--user') user = next();
    else if (a === '-G' || a === '--get') get = true;
    else if (a === '--url') url = next();
    else if (/^-[A-Za-z]$|^--[\w-]+$/.test(a)) {
      // Options that take a value we do not use; flags without one are skipped as they are.
      if (['-o', '--output', '-A', '--user-agent', '-e', '--referer', '-b', '--cookie', '-m', '--max-time', '--connect-timeout', '-x', '--proxy', '-w', '--write-out'].includes(a)) next();
    } else if (!url) url = a;
  }
  if (!url) throw new Error('No address found in that command');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const u = new URL(url);
  const query = [...u.searchParams].map(([key, value]) => ({ key, value }));
  if (get && data.length) for (const d of data) for (const [key, value] of new URLSearchParams(d)) query.push({ key, value });
  u.search = '';
  let auth = null;
  const keep = [];
  for (const hd of headers) {
    const k = hd.key.toLowerCase();
    if (k === 'authorization' && /^bearer\s+/i.test(hd.value)) auth = { type: 'bearer', token: hd.value.replace(/^bearer\s+/i, '') };
    else if (k === 'authorization' && /^basic\s+/i.test(hd.value)) {
      try {
        const [u1, ...p] = atob(hd.value.replace(/^basic\s+/i, '')).split(':');
        auth = { type: 'basic', user: u1, password: p.join(':') };
      } catch {
        keep.push(hd);
      }
    } else if (/^(x-)?api[-_]?key$|^x-auth-token$|^x-access-token$/.test(k)) auth = { type: 'header', name: hd.key, value: hd.value };
    else if (!['content-length', 'host', 'cookie', 'connection'].includes(k)) keep.push(hd);
  }
  if (user && !auth) {
    const [u1, ...p] = user.split(':');
    auth = { type: 'basic', user: u1, password: p.join(':') };
  }
  const body = get ? '' : data.join('&');
  const isJson = /^\s*[[{]/.test(body) || keep.some((hd) => hd.key.toLowerCase() === 'content-type' && /json/.test(hd.value));
  const finalMethod = method || (body ? 'POST' : 'GET');
  return {
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(finalMethod) ? finalMethod : 'POST',
    url: u.href,
    query,
    headers: keep.filter((hd) => hd.key.toLowerCase() !== 'content-type' || !isJson),
    bodyType: body ? (isJson ? 'json' : 'text') : 'none',
    body,
    auth,
  };
}

// ----------------------------------------------------------- examples

const n = (id, type, x, y, config, extra = {}) => ({ id, type, x, y, config, ...extra });
const w = (from, to, port = 'out') => ({ from, to, port });

/** Ready-made drawings to start from. They open unsaved; topics and credentials are yours to fill in. */
export const EXAMPLES = [
  {
    id: 'hn-digest',
    label: 'Hacker News digest to your phone, every morning',
    flow: () => ({
      name: 'Morning HN digest',
      nodes: [
        n('t', 'trigger', 40, 120, { kind: 'schedule', schedule: { kind: 'daily', time: '08:30', days: [] } }),
        n('hn', 'service', 300, 120, { service: 'hackernews', action: 'front_page', credential: '', params: { limit: '15' } }, { name: 'Front page' }),
        n('ai', 'ai', 560, 120, { prompt: 'From these Hacker News stories, pick the 3 a software developer would most want to read. One line each: the title, then why, then the link.\n\n{{ input }}', system: '', json: false, agent: '' }, { name: 'Pick three' }),
        n('push', 'service', 820, 120, { service: 'ntfy', action: 'send', credential: '', params: { topic: '', title: 'HN for {{ today }}', message: '{{ input }}', priority: '', click: '' } }, { name: 'To my phone' }),
        n('note', 'note', 300, 300, { text: 'Install the ntfy app, subscribe to a hard-to-guess topic, and type the same topic in "To my phone".', color: '' }, { w: 300, h: 90 }),
      ],
      edges: [w('t', 'hn'), w('hn', 'ai'), w('ai', 'push')],
    }),
  },
  {
    id: 'feed-summary',
    label: 'Summarise each new item of a feed',
    flow: () => ({
      name: 'Feed summaries',
      nodes: [
        n('t', 'trigger', 40, 120, { kind: 'poll', poller: 'rss', url: 'https://github.com/nodejs/node/releases.atom', every: 30 }),
        n('ai', 'ai', 300, 120, { prompt: 'Summarise this release for a busy developer in at most four bullet points:\n\n{{ input.title }}\n{{ input.summary }}', system: '', json: false, agent: '' }, { name: 'Summarise' }),
        n('f', 'file', 560, 120, { op: 'append', path: 'notes/releases.md', content: '## {{ trigger.title }} ({{ today }})\n{{ input }}\n{{ trigger.link }}\n' }, { name: 'Keep a log' }),
      ],
      edges: [w('t', 'ai'), w('ai', 'f')],
    }),
  },
  {
    id: 'weather-log',
    label: 'Log the weather every day',
    flow: () => ({
      name: 'Weather log',
      nodes: [
        n('t', 'trigger', 40, 120, { kind: 'schedule', schedule: { kind: 'daily', time: '07:00', days: [] } }),
        n('wx', 'service', 300, 120, { service: 'weather', action: 'forecast', credential: '', params: { place: 'Chennai' } }, { name: 'Forecast' }),
        n('s', 'set', 560, 120, { fields: [{ key: 'line', value: '{{ today }}: {{ input.now.temperature }} C, {{ input.now.sky }}; high {{ input.days[0].max }}, rain {{ input.days[0].rain_chance }}%' }], keep: false }, { name: 'One line' }),
        n('f', 'file', 820, 120, { op: 'append', path: 'notes/weather.log', content: '{{ input.line }}' }, { name: 'Append' }),
        n('rain', 'if', 820, 300, { conditions: [{ left: '{{ node(\'Forecast\').days[0].rain_chance }}', op: 'gt', value: '60' }], combine: 'and' }, { name: 'Rain likely?' }),
      ],
      edges: [w('t', 'wx'), w('wx', 's'), w('s', 'f'), w('s', 'rain')],
    }),
  },
  {
    id: 'issues-crew',
    label: 'New GitHub issues go to the crew',
    flow: () => ({
      name: 'Issues to the crew',
      nodes: [
        n('t', 'trigger', 40, 120, { kind: 'poll', poller: 'github', repo: 'owner/name', event: 'issues', every: 10 }),
        n('only', 'filter', 300, 120, { conditions: [{ left: '{{ input.labels }}', op: 'contains', value: 'bug' }], combine: 'and' }, { name: 'Bugs only' }),
        n('a', 'agent', 560, 120, { text: 'Look into this bug report and fix it if you can:\n\n#{{ input.number }} {{ input.title }}\n\n{{ input.body }}', agent: '' }, { name: 'Fix it' }),
      ],
      edges: [w('t', 'only'), w('only', 'a')],
    }),
  },
];
