import { clip } from './util.js';
import { OPS } from './flowData.js';
import { SERVICES, POLLERS, CREDENTIAL_TYPES } from './services.js';

/**
 * "Describe a flow": the user says in plain words what should happen, the Chef
 * answers with one drawing (nodes and wires) in one model call, and this file
 * turns that answer into a draft the canvas can open. Nothing is saved or run
 * here: the draft opens unsaved, the user looks it over and presses Create.
 *
 * What the model may not decide is taken out of its hands in code, not by
 * asking nicely: it never chooses a credential (they are cleared), never
 * writes a Code node (the operator writes those - see codeNode.js), never puts
 * {{ }} into a fixed field (it is emptied), and its positions are ignored (the
 * layout is worked out from the wires). Every node the user should check - a
 * credential to choose, an address, a recipient, a command - is marked.
 */

/** Marks the drawing prompt (the mock provider looks for it). */
export const DRAFT_MARK = '## Flow to draw';
export const DRAFT_INPUT_CHARS = 1500;
const APP_TOOLS = 200; // of a very large set of connected tools, what the prompt names (the flame's draftCatalogChars cuts first)
const COL = 250;
const ROW = 150;
const PLACEHOLDER_URL = 'https://example.com/replace-me';

/**
 * What each start and service hands on, so the model quotes fields that exist. Written from
 * what the run functions in services.js return; keep the two together when one changes.
 */
const ISSUE = '{number, title, state, url, author, labels[], created, body}';
const FEED = 'a list of {title, link, published, author, summary}';
const HN = 'a list of {title, url, points, comments, author, hn, created}';
export const GIVES = {
  'telegram/send': '{sent, message_id, chat}',
  'discord/send': '{sent, id}',
  'slack/send': '{sent}',
  'ntfy/send': '{sent, id, topic}',
  'email/send': '{sent, id}',
  'github/create_issue': ISSUE,
  'github/comment': '{id, url}',
  'github/list_issues': `a list of ${ISSUE}`,
  'github/list_pulls': `a list of ${ISSUE.slice(0, -1)}, branch, draft}`,
  'github/latest_release': '{tag, name, url, published, notes}',
  'github/get_file': '{path, size, url, content}',
  'notion/create_page': '{id, url}',
  'notion/append': '{added, page}',
  'notion/search': 'a list of {id, kind, title, url}',
  'todoist/create_task': '{id, content, due}',
  'todoist/list_tasks': 'a list of {id, content, due, priority}',
  'todoist/close_task': '{closed}',
  'trello/create_card': '{id, url}',
  'trello/list_cards': 'a list of {id, name, url, due, desc}',
  'rss/read': FEED,
  'reddit/read': FEED,
  'hackernews/front_page': HN,
  'hackernews/search': HN,
  'wikipedia/summary': '{title, description, extract, url}',
  'wikipedia/search': 'a list of {title, snippet, url}',
  'weather/forecast': '{place, now: {temperature, feels_like, humidity, wind_kmh, rain_mm, sky}, days: [{day, sky, max, min, rain_chance}]}',
  'currency/convert': '{amount, from, to, rate, result, date}',
  'poll:rss': 'one item {title, link, published, author, summary}',
  'poll:reddit': 'one post {title, link, published, author, summary}',
  'poll:github': `one item {repo, ...} - an issue or pull request ${ISSUE}, or a release {repo, tag, name, url, published, notes}`,
  'poll:hackernews': 'one story {title, url, points, comments, author, hn, created}',
  'poll:watch': 'what the address answered',
};

const one = (s, max) => clip(String(s ?? '').replace(/\s+/g, ' ').trim(), max);

/** The services, starts and apps, one line each: what the model may build from. */
function catalogLines({ apps = [], flows = [] }) {
  const service = Object.entries(SERVICES).flatMap(([id, s]) =>
    Object.entries(s.actions).map(([aid, a]) => {
      const fields = a.fields.map((f) => `${f.id}${f.fixed ? '!' : ''}${f.optional ? '?' : ''}`).join(', ');
      const auth = s.auth && (!s.authOptional || a.needsAuth) ? ' [credential]' : '';
      return `- ${id}/${aid}: ${one(a.label, 60)} (${fields})${auth} -> ${GIVES[`${id}/${aid}`] ?? 'its answer'}`;
    }),
  );
  const pollers = Object.entries(POLLERS).map(([id, p]) => `- ${id}: ${one(p.label, 60)} (${p.fields.map((f) => `${f.id}: ${one(f.label, 40)}`).join('; ')}) -> ${GIVES[`poll:${id}`] ?? 'one item'}`);
  const tools = apps.slice(0, APP_TOOLS).map((t) => `- ${t.name}(${(t.params ?? []).slice(0, 6).join(', ')}): ${one(t.description, 90)}`);
  return [
    '## Built-in services (node type "service": "service" is the part before /, "action" after; fields marked ! are fixed, ? optional; after -> is what it hands on)',
    ...service,
    '',
    '## What a polled start can watch ("poller"; it starts the flow once per new item, and that item is {{ trigger }} and the first node\'s {{ input }})',
    ...pollers,
    '',
    tools.length ? '## Connected apps (node type "app": "tool" is the full name)' : '## Connected apps\nNone are connected: do not use app nodes.',
    ...tools,
    ...(flows.length ? ['', '## The user\'s other flows (node type "flow": "flow" is the id)', ...flows.slice(0, 30).map((f) => `- ${f.id}: ${one(f.name, 50)}`)] : []),
  ].join('\n');
}

export function draftSystem(context = {}) {
  return `You draw automations ("flows") for Kadhai from what the user describes. A flow is a graph: one start node, then nodes joined by wires; each node's output travels down its wires and becomes the next node's input.

Answer with one JSON object and nothing else:
{"name": "a few plain words, e.g. Morning weather note", "description": "one sentence", "nodes": [{"id": "t", "type": "trigger", "name": "...", "config": {...}}, ...], "edges": [{"from": "t", "to": "a", "port": "out"}], "notes": ["what the user still has to do or what could not be done"]}

Node ids: short, lowercase letters and digits. Names: short, no quotes or braces, all different.

## Node types and their config
- trigger (exactly one): {"kind": "manual"} | {"kind": "schedule", "schedule": {"kind": "daily", "time": "08:00", "days": [1,2,3,4,5]}} (days 0 = Sunday; [] = every day) | {"kind": "schedule", "schedule": {"kind": "interval", "minutes": 60}} (at least 5) | {"kind": "poll", "poller": "<id>", "every": 15, <its fields>} | {"kind": "file", "path": "notes/"} (a file or folder in the project changes)
- service: {"service": "weather", "action": "forecast", "params": {"place": "Chennai"}}
- ai: {"prompt": "Summarise in three lines:\\n\\n{{ input }}", "json": false} - one model answer: summarise, write, classify, translate, pull out fields (json true gives an object)
- agent: {"text": "the task"} - a coding crew that edits files in the project. Only for work on code or files that needs thought.
- app: {"tool": "<full name>", "args": "{\\"query\\": \\"{{ input }}\\"}"} - args is a JSON object written as a string
- if / filter: {"conditions": [{"left": "{{ input.price }}", "op": "gt", "value": "10"}], "combine": "and"} - if sends down port "true" or "false"; filter goes on only when they hold
- switch: {"rules": [<condition>, ...]} - ports "1", "2", ... for the first rule that holds, else "else"
- merge: {"mode": "append" | "combine" | "text"} - waits for every wire into it
- set: {"fields": [{"key": "line", "value": "{{ input.title }}: {{ input.url }}"}]} - builds an object
- wait: {"seconds": 60}
- http: {"method": "GET", "url": "https://...", "query": [{"key": "q", "value": "{{ input }}"}], "bodyType": "json", "body": "{\\"text\\": \\"{{ input }}\\"}"}
- file: {"op": "read" | "write" | "append", "path": "notes/log.md", "content": "{{ input }}"}
- command: {"command": "npm test", "failOnError": true} - one line, runs in the project after the user approves it; hands on {code, output}. With failOnError true a failing command ends the flow there, so when the flow should react to a failure set it false and test {{ input.code }} not_equals 0 in an if node
- file hands on {path, chars} after a write (read: the file's text); http hands on what the address answered
- flow: {"flow": "<id>"} - runs another of the user's flows
- note: {"text": "..."} - a sticky note; never wired, never runs
Condition ops: ${OPS.join(', ')}.

## Expressions
Settings may quote data with {{ input }} (what arrived on the wire - only the node right before it), {{ input.field }}, {{ input.items[0].title }}, {{ node('Name').field }} (an earlier node's output), {{ trigger }}, {{ now }}, {{ today }}. Nothing else: no functions, no maths. When you do not know the exact fields a service returns, give the whole {{ input }} to an ai node and let it pick. A field marked ! (an address, a recipient, a chat, a topic, a repository), an http url, its headers, a file path and a command are fixed: write a plain value or leave it "", never {{ }}.

## Rules
- Use the fewest nodes that do the job. Prefer a built-in service over http. Use ai nodes for anything that needs judgement or writing.
- A node sees only what its wires bring. To use the output of an ai node, wire it on and quote {{ input }}; to use two results together, put them one after the other or join them with a merge node. {{ node('Name') }} must name a node that runs earlier on the same path. An ai node hands on plain text (an object only with json true).
- Wires: port "out" for most nodes, "true"/"false" from if, "1"/"2"/"else" from switch, and "tool" from an app into an agent's tools. No loops: wires never lead back to an earlier node. For "each item" work, hand the whole list to one ai node.
- Never write a code node. Never choose credentials: the user does that. Leave a fixed field "" when the user did not give its value, and say so in notes.
- If something cannot be done with these nodes, draw what can be done and say what is missing in notes. Keep notes short and plain.

${clip(catalogLines(context), context.catalogChars ?? 9000)}`;
}

/** A flow as the model sees it when asked to change it: no credentials, and code it may not touch. */
function baseForPrompt(base) {
  const nodes = base.nodes.map((n) => {
    const { credential, ...config } = n.config ?? {};
    if (n.type === 'code') return { id: n.id, type: 'code', name: n.name, config: { code: '(written by the user: keep this node exactly as it is, same id)' } };
    return { id: n.id, type: n.type, ...(n.name ? { name: n.name } : {}), config };
  });
  return JSON.stringify({ name: base.name, nodes, edges: base.edges });
}

export function draftUser(request, retry, { base = null, failure = null } = {}) {
  return [
    ...(base
      ? [
          `## The flow as it is now\n${clip(baseForPrompt(base), 16000)}`,
          ...(failure ? [`## What went wrong when it ran\nIt stopped at the node "${clip(String(failure.node ?? ''), 60)}" with this error:\n${clip(String(failure.error ?? ''), 800)}${failure.input ? `\nWhat that node received:\n${clip(String(failure.input), 1200)}` : ''}`] : []),
          '## How to answer\nAnswer with the whole flow, changed as asked. When the change or fix needs a value only the user knows (a place, an address, an id), do not make one up: leave it as it is and say what to fill in, in notes. Keep every node you do not need to change exactly as it is, with the same id, name and config, and keep their wires. New nodes get new ids. Leave out a node only if the change means it must go.',
        ]
      : []),
    `${DRAFT_MARK}\n${clip(String(request), DRAFT_INPUT_CHARS)}`,
    retry ? `## Your last answer could not be used\n${retry.error}\nAnswer again with the whole flow, corrected.` : '',
  ].filter(Boolean).join('\n\n');
}

// Small models name things like ids ("format_line", "searchHN"): shown as words.
const plainName = (s) => {
  const name = one(String(s ?? '').replace(/['"{}]/g, '').replace(/[_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'), 40);
  return name ? name[0].toUpperCase() + name.slice(1) : '';
};

/**
 * The model's answer as a drawing the flows checker can read, plus what the
 * user is told. Throws (status 400) when there is nothing usable in it.
 */
export function shapeDraft(raw, { agents = new Set(), base = null } = {}) {
  // Code nodes the user already wrote may stay (unchanged, by id); the model never writes one.
  const userCode = new Map((base?.nodes ?? []).filter((n) => n.type === 'code').map((n) => [n.id, n]));
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes)) throw Object.assign(new Error('The answer has no "nodes" list'), { status: 400 });
  const notes = (Array.isArray(raw.notes) ? raw.notes : []).map((n) => one(n, 300)).filter(Boolean).slice(0, 8);
  const ids = new Map(); // model's id -> ours
  const names = new Set();
  const nodes = [];
  let trigger = null;
  for (const [index, given] of raw.nodes.entries()) {
    if (!given || typeof given !== 'object') continue;
    let type = String(given.type ?? '').toLowerCase();
    if (type === 'start') type = 'trigger';
    const config = given.config && typeof given.config === 'object' ? structuredClone(given.config) : {};
    if (type === 'code' && userCode.has(String(given.id))) Object.assign(config, structuredClone(userCode.get(String(given.id)).config));
    else if (type === 'code') {
      // The operator writes code, never a model (invariant 16): what it was for becomes a note.
      notes.push(`"${plainName(given.name) || 'A code step'}" needs a Code node, which you write yourself - a note marks where it goes.`);
      type = 'note';
      config.text = `A Code node goes here: ${one(given.name || config.description || 'a step the Chef could not draw', 200)}`;
    }
    if (!['trigger', 'agent', 'ai', 'app', 'service', 'if', 'switch', 'filter', 'merge', 'set', 'wait', 'http', 'flow', 'file', 'command', 'note', 'code'].includes(type)) continue; // code: only a user's own, kept above
    if (type === 'trigger') {
      if (trigger) continue; // one start: the first wins
      trigger = true;
    }
    let id = String(given.id ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || `n${index}`;
    while ([...ids.values()].includes(id)) id = `${id.slice(0, 10)}${index}${nodes.length}`.slice(0, 12);
    ids.set(String(given.id ?? `#${index}`), id);
    let name = type === 'trigger' || type === 'note' ? '' : plainName(given.name);
    for (let k = 2; name && names.has(name.toLowerCase()); k++) name = `${plainName(given.name).slice(0, 36)} ${k}`;
    if (name) names.add(name.toLowerCase());
    // What only the user may choose.
    delete config.credential;
    if (type === 'agent' && !agents.has(config.agent)) delete config.agent;
    if (type === 'ai' && !agents.has(config.agent)) delete config.agent;
    if (type === 'app' && config.args && typeof config.args === 'object') config.args = JSON.stringify(config.args);
    if (type === 'http' && config.body && typeof config.body === 'object') config.body = JSON.stringify(config.body);
    if (type === 'service') {
      const action = SERVICES[config.service]?.actions[config.action];
      const params = config.params && typeof config.params === 'object' ? config.params : {};
      for (const field of action?.fields ?? []) {
        const v = params[field.id];
        // Escaped twice by the model ("Tests failed:\\n..."): a line break was meant.
        params[field.id] = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v).replace(/\\n/g, '\n');
        if (field.fixed && params[field.id].includes('{{')) params[field.id] = '';
      }
      config.params = params;
    }
    for (const key of ['url', 'path', 'command']) if (type !== 'trigger' && typeof config[key] === 'string' && config[key].includes('{{')) config[key] = '';
    // Stand-ins the checker accepts; the node is marked for the user to fill in.
    if (type === 'http' && !/^https?:\/\/\S+$/.test(String(config.url ?? ''))) config.url = PLACEHOLDER_URL;
    if (type === 'file' && !String(config.path ?? '').trim()) config.path = 'notes/flow.txt';
    // The GitHub start reads anything else as "issues": a model's "release" must not quietly watch issues.
    if (type === 'trigger' && config.poller === 'github') config.event = /release/i.test(config.event) ? 'releases' : /pull|pr\b/i.test(config.event) ? 'pulls' : 'issues';
    if (type === 'trigger' && config.schedule?.kind === 'daily') config.schedule.time = String(config.schedule.time ?? '').replace(/^(\d):/, '0$1:');
    const node = { id, type, x: 0, y: 0, config };
    if (name) node.name = name;
    if (type === 'note') Object.assign(node, { w: 260, h: 100 });
    nodes.push(node);
  }
  if (!trigger) {
    nodes.unshift({ id: 'start', type: 'trigger', x: 0, y: 0, config: { kind: 'manual' } });
    notes.push('It starts when you press Run: say when it should start, or change the start.');
  }
  const edges = (Array.isArray(raw.edges) ? raw.edges : [])
    .map((e) => ({ from: ids.get(String(e?.from)), to: ids.get(String(e?.to)), port: String(e?.port ?? 'out') }))
    .filter((e) => e.from && e.to);
  if (!trigger) {
    // The start the model forgot goes before every node nothing was wired into.
    const fed = new Set(edges.map((e) => e.to));
    for (const n of nodes) if (n.type !== 'trigger' && n.type !== 'note' && !fed.has(n.id) && !edges.some((e) => e.from === n.id && e.port === 'tool')) edges.push({ from: 'start', to: n.id, port: 'out' });
  }
  // Small models answer with ids for names ("morning_weather_rate"): shown as words.
  const title = one(String(raw.name ?? '').replace(/['"]/g, '').replace(/[_-]+/g, ' '), 50);
  // An ai node whose prompt quotes nothing would never see what arrived on its wire.
  for (const n of nodes) {
    if (n.type === 'ai' && edges.some((e) => e.to === n.id) && !String(n.config.prompt ?? '').includes('{{')) n.config.prompt = `${String(n.config.prompt ?? '').trim()}\n\n{{ input }}`;
  }
  const flow = { name: title ? title[0].toUpperCase() + title.slice(1) : 'New flow', description: one(raw.description, 300), tags: [], onFail: '', nodes, edges };
  layout(flow);
  return { flow, notes };
}

/**
 * A changed drawing on top of the one it changes. What the user set themselves comes back from
 * the old drawing by node id, never from the model: credentials (when the node still talks to the
 * same service), pinned data, switched-off, retries, carry-on-error, note sizes, and positions.
 * New nodes are placed beside the node that feeds them. The name, tags and "if it fails" stay.
 */
export function mergeWithBase(flow, base) {
  const before = new Map(base.nodes.map((n) => [n.id, n]));
  const sameService = (a, b) => a.type === b.type && (a.type !== 'service' || a.config.service === b.config.service) && (a.type !== 'trigger' || a.config.poller === b.config.poller);
  const placed = [];
  for (const node of flow.nodes) {
    const old = before.get(node.id);
    if (!old || old.type !== node.type) continue;
    if (old.config?.credential && sameService(old, node)) node.config.credential = old.config.credential;
    for (const key of ['pinned', 'disabled', 'retries', 'onError', 'w', 'h']) if (old[key] !== undefined) node[key] = structuredClone(old[key]);
    Object.assign(node, { x: old.x, y: old.y });
    placed.push(node);
  }
  // New nodes: to the right of what feeds them, moved down until the spot is free.
  const free = (x, y) => !placed.some((p) => Math.abs(p.x - x) < 200 && Math.abs(p.y - y) < 110);
  const lowest = Math.max(80, ...placed.map((p) => p.y));
  for (const node of flow.nodes.filter((n) => !placed.includes(n))) {
    const feed = flow.edges.map((e) => (e.to === node.id ? placed.find((p) => p.id === e.from) : null)).find(Boolean);
    const x = feed ? feed.x + COL : 40;
    let y = feed ? feed.y : lowest + ROW;
    for (let i = 0; i < 30 && !free(x, y); i++) y += ROW;
    Object.assign(node, { x, y });
    placed.push(node);
  }
  return { ...flow, name: base.name, description: base.description ?? '', tags: base.tags ?? [], onFail: base.onFail ?? '' };
}

/**
 * What a change did, comparing two checked drawings (both through the flows checker, so a setting
 * the model left out and the checker filled in is not a change): the ids added or changed, in words.
 */
export function diffFlows(base, flow) {
  const before = new Map(base.nodes.map((n) => [n.id, n]));
  const configOf = (n) => {
    const { credential, ...rest } = n.config ?? {};
    return JSON.stringify(rest);
  };
  const label = (n) => n.name || (n.type === 'trigger' ? 'the start' : n.type);
  const touched = new Set();
  const added = [];
  const changed = [];
  for (const node of flow.nodes) {
    const old = before.get(node.id);
    if (!old || old.type !== node.type) {
      touched.add(node.id);
      if (node.type !== 'note') added.push(label(node));
    } else if (configOf(old) !== configOf(node) || (old.name ?? '') !== (node.name ?? '')) {
      touched.add(node.id);
      changed.push(label(node));
    }
  }
  const removed = base.nodes.filter((n) => n.type !== 'note' && !flow.nodes.some((m) => m.id === n.id)).map(label);
  const wires = (f) => new Set(f.edges.map((e) => `${e.from}>${e.to}:${e.port}`));
  const was = wires(base);
  const now = wires(flow);
  const rewired = [...now].some((w) => !was.has(w)) || [...was].some((w) => !now.has(w));
  const words = [
    added.length ? `added ${added.join(', ')}` : '',
    changed.length ? `changed ${changed.join(', ')}` : '',
    removed.length ? `removed ${removed.join(', ')}` : '',
    rewired && !added.length && !removed.length ? 'rewired some steps' : '',
  ].filter(Boolean);
  return { touched, changes: words.length ? `The Chef ${words.join('; ')}.` : 'The Chef left the flow as it was.' };
}

/** Columns by how far a node is from the start along the wires; apps plugged in as tools sit under their agent. */
export function layout(flow) {
  const main = flow.edges.filter((e) => e.port !== 'tool');
  const depth = new Map();
  const start = flow.nodes.find((n) => n.type === 'trigger');
  if (start) depth.set(start.id, 0);
  // Longest path from the start: the wires were checked loop-free, so this settles (bounded anyway).
  for (let round = 0; round < flow.nodes.length + 1; round++) {
    let moved = false;
    for (const e of main) {
      if (!depth.has(e.from)) continue;
      const d = depth.get(e.from) + 1;
      if ((depth.get(e.to) ?? -1) < d) {
        depth.set(e.to, d);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const rows = new Map();
  const place = (node, col, row) => Object.assign(node, { x: 40 + col * COL, y: 80 + row * ROW });
  const tools = new Map(flow.edges.filter((e) => e.port === 'tool').map((e) => [e.from, e.to]));
  const loose = [];
  for (const node of flow.nodes) {
    if (node.type === 'note' || tools.has(node.id) || !depth.has(node.id)) continue;
    const col = depth.get(node.id);
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    place(node, col, row);
  }
  const lowest = Math.max(0, ...[...rows.values()]);
  const under = new Map();
  for (const node of flow.nodes) {
    if (tools.has(node.id)) {
      const agent = flow.nodes.find((n) => n.id === tools.get(node.id));
      const k = under.get(agent.id) ?? 0;
      under.set(agent.id, k + 1);
      Object.assign(node, { x: agent.x + k * 40, y: 80 + (lowest + k) * ROW + 40 });
    } else if (node.type === 'note' || !depth.has(node.id)) loose.push(node);
  }
  const below = lowest + (under.size ? Math.max(...under.values()) : 0);
  loose.forEach((node, i) => place(node, i, below + 0.3));
  return flow;
}

/**
 * {{ node('Name') }} that cannot be read when the node runs: a name that is not there, or a
 * node that does not run before it on the wires. [{ node, text }]
 */
export function badReferences(flow) {
  const main = flow.edges.filter((e) => e.port !== 'tool');
  const before = (id, seen = new Set()) => {
    for (const e of main) if (e.to === id && !seen.has(e.from)) (seen.add(e.from), before(e.from, seen));
    return seen;
  };
  const out = [];
  for (const n of flow.nodes) {
    if (n.type === 'note') continue;
    const earlier = before(n.id);
    for (const [, a, b] of JSON.stringify(n.config).matchAll(/node\(\s*(?:'([^']{1,60})'|\\?"([^"\\]{1,60})\\?")\s*\)/g)) {
      const name = (a ?? b).toLowerCase();
      const target = flow.nodes.find((m) => m.id === name || m.name?.toLowerCase() === name);
      if (!target) out.push({ node: n.id, text: `${n.name || n.type} quotes node('${a ?? b}'), but no node has that name` });
      else if (!earlier.has(target.id)) out.push({ node: n.id, text: `${n.name || n.type} quotes node('${a ?? b}'), which does not run before it - wire them one after the other` });
    }
  }
  return out;
}

/** What the user should look at before saving: one line per node that needs it. */
export function attention(flow, { credentials = [], request = '' } = {}) {
  const asked = String(request).toLowerCase();
  const out = [];
  const label = (n) => n.name || (n.type === 'trigger' ? 'The start' : n.type);
  const has = (type) => credentials.some((c) => c.type === type);
  for (const n of flow.nodes) {
    const c = n.config;
    const say = (text) => out.push({ node: n.id, text: `${label(n)}: ${text}` });
    if (n.type === 'service') {
      const service = SERVICES[c.service];
      const action = service?.actions[c.action];
      if (service?.auth && !c.credential && (!service.authOptional || action?.needsAuth)) {
        const kind = CREDENTIAL_TYPES[service.auth]?.label ?? service.auth;
        say(has(service.auth) ? `choose your ${kind} credential` : `add a ${kind} credential (more… -> Credentials), then choose it`);
      }
      const empty = (action?.fields ?? []).filter((f) => !f.optional && !String(c.params?.[f.id] ?? '').trim()).map((f) => f.label);
      if (empty.length) say(`fill in ${empty.join(', ')}`);
      // A fixed value the user wrote in the request is theirs; one the Chef made up is worth a look.
      const fixed = (action?.fields ?? []).filter((f) => f.fixed && String(c.params?.[f.id] ?? '').trim() && !asked.includes(String(c.params[f.id]).trim().toLowerCase())).map((f) => `${f.label} (${clip(String(c.params[f.id]), 40)})`);
      if (fixed.length) say(`check ${fixed.join(', ')} - the Chef chose it`);
    }
    if (n.type === 'trigger' && c.kind === 'poll') {
      const p = POLLERS[c.poller];
      // A start's credential is optional (GitHub reads public repositories without one).
      if (p?.fields.some((f) => !f.optional && !String(c[f.id] ?? '').trim())) say('fill in what it watches');
    }
    if (n.type === 'http') say(c.url === PLACEHOLDER_URL ? 'fill in the address' : 'check the address - the Chef filled it in');
    if (n.type === 'command') say('check the command; it waits for your OK when it runs');
    if (n.type === 'file' && c.op !== 'read') say(`check the file name (${c.path || 'none yet'})`);
  }
  return out;
}
