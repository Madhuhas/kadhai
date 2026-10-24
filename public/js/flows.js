import { $, h, toast, prefs } from './util.js';
import { state, on } from './store.js';
import { api } from './api.js';
import { face, tintOf } from './ascii.js';
import { logo } from './logos.js';
import { KINDS, GROUPS, MODEL_KINDS, NO_RETRY, OPS, UNARY, outPorts, conditionText, dataView, parseCurl, parseMaybe, EXAMPLES } from './flowKit.js';

/**
 * Flows: a canvas of nodes joined by wires.
 *
 *   side (left)       your flows and the nodes you can add - or the runs of this flow
 *   canvas (middle)   drag nodes by their title; drag from a port to wire them (let go on
 *                     empty canvas to pick what comes next); drag the background to move
 *                     around, Shift+drag to select; Ctrl+wheel zooms
 *   settings (right)  the selected node, its wires and what it last produced
 *   large view        double-click a node (or Enter): its input, settings and output side
 *                     by side; fields of the data can be dragged into a setting
 *
 * Everything the mouse does has a keyboard way too: the settings panel lists wires and
 * has a "wire to" picker, Tab opens the node search, Delete removes, Ctrl+Z undoes.
 */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SVG = 'http://www.w3.org/2000/svg';
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2;

let catalog = { services: [], credentials: [], pollers: [] };
let flows = [];
let triggers = [];
let connections = [];
let tools = [];
let creds = [];
let current = null; // id of the flow on the canvas, or 'new'
let draft = null; // { name, description, tags, onFail, nodes, edges }: what the canvas shows; saved only when the user says so
let dirty = false;
let selected = new Set(); // node ids
let pickedEdge = null; // index of the selected wire
let space = null; // the canvas's inner element (nodes + wires), scaled by the zoom
let sizer = null; // what gives the scrolling area its size at this zoom
let wires = null; // the <svg> the wires are drawn in
let zoom = Number(prefs.get('flowZoom', '1')) || 1;
let past = [];
let future = [];
let committed = '';
let snapTimer = null;
let clipboard = null;
let side = 'flows'; // or 'runs'
let runs = [];
let viewing = null; // a run from the history shown on the canvas instead of the latest
let tested = {}; // node id -> what "test step" gave, this session only
let ndvId = null;
const ndvMode = { in: 'tree', out: 'tree' };
let ndvSource = null;
let lastField = null; // the setting a clicked field of the data goes into
let paletteQuery = '';
let listQuery = '';
let justDragged = false;

const fail = (err) => toast(err.message, 'err');
const newId = () => Math.random().toString(36).slice(2, 8);
const nodeOf = (id) => draft?.nodes.find((n) => n.id === id);
const saved = () => flows.find((f) => f.id === current) ?? null;
const shownRun = () => viewing ?? saved()?.lastRun ?? null;
const trigger = () => draft.nodes.find((n) => n.type === 'trigger');
const blank = () => ({ name: '', description: '', tags: [], onFail: '', nodes: [{ id: newId(), type: 'trigger', x: 40, y: 120, config: { kind: 'manual' } }], edges: [] });
const copy = (flow) => JSON.parse(JSON.stringify({ name: flow.name, description: flow.description ?? '', tags: flow.tags ?? [], onFail: flow.onFail ?? '', nodes: flow.nodes, edges: flow.edges }));
const when = (ts) => (ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const short = (ts) => (ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const typing = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '');
const serviceOf = (id) => catalog.services.find((s) => s.id === id);
const credType = (id) => catalog.credentials.find((c) => c.id === id);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ------------------------------------------------------------- history

const snapshot = () => JSON.stringify(draft);
/** Every change is noted; a burst of typing becomes one step of undo. */
function touch() {
  dirty = true;
  clearTimeout(snapTimer);
  snapTimer = setTimeout(commit, 400);
  renderBarState();
}
function commit() {
  clearTimeout(snapTimer);
  if (!draft) return;
  const now = snapshot();
  if (now === committed) return;
  past.push(committed);
  if (past.length > 80) past.shift();
  future = [];
  committed = now;
  renderTools();
}
function undo() {
  commit();
  if (!past.length) return;
  future.push(committed);
  committed = past.pop();
  draft = JSON.parse(committed);
  dirty = true;
  selected = new Set([...selected].filter((id) => nodeOf(id)));
  pickedEdge = null;
  renderAll();
}
function redo() {
  if (!future.length) return;
  past.push(committed);
  committed = future.pop();
  draft = JSON.parse(committed);
  dirty = true;
  renderAll();
}

// --------------------------------------------------------------- wording

/** The name a node shows when it has none of its own. */
function defaultTitle(node) {
  if (node.type === 'agent') return node.config.agent && state.agents[node.config.agent] ? state.agents[node.config.agent].name : 'Agent';
  if (node.type === 'app') return node.config.connection;
  if (node.type === 'service') return serviceOf(node.config.service)?.label ?? node.config.service;
  return KINDS[node.type]?.title ?? node.type;
}
const title = (node) => (node.type === 'trigger' ? 'Start' : node.name || defaultTitle(node));

function uniqueName(base, except = null) {
  const taken = new Set(draft.nodes.filter((n) => n.id !== except && n.name).map((n) => n.name.toLowerCase()));
  const clean = String(base).replace(/['"{}]/g, '').slice(0, 36) || 'Node';
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let i = 2; ; i++) if (!taken.has(`${clean} ${i}`.toLowerCase())) return `${clean} ${i}`;
}

/** The expression for another node's output: by name, which every node gets when it is made. */
function nodeRef(node) {
  if (!node.name) {
    node.name = uniqueName(defaultTitle(node), node.id);
    touch();
  }
  return `node('${node.name}')`;
}

function startText(c) {
  if (c.kind === 'schedule') {
    const s = c.schedule;
    if (s.kind === 'interval') return s.minutes % 60 === 0 ? `every ${s.minutes / 60} h` : `every ${s.minutes} min`;
    return `${s.days?.length ? s.days.map((d) => DAYS[d]).join(' ') : 'daily'} at ${s.time}`;
  }
  if (c.kind === 'trigger') {
    const t = triggers.find((x) => x.id === c.id);
    return t ? `when "${t.name}" fires${t.type === 'webhook' ? ' (webhook)' : ''}` : 'when a removed trigger fires';
  }
  if (c.kind === 'poll') {
    const what = c.poller === 'app' ? c.tool : c.poller === 'rss' || c.poller === 'watch' ? hostOf(c.url) : c.poller === 'github' ? `${c.repo} ${c.event || 'issues'}` : c.poller === 'reddit' ? `r/${c.subreddit}` : `"${c.query ?? ''}"`;
    const label = { rss: 'new in feed', reddit: 'new post', github: 'new on GitHub', hackernews: 'new HN story', watch: 'when it changes', app: 'when it changes' }[c.poller] ?? c.poller;
    return `${label}: ${what || '…'} - every ${c.every} min`;
  }
  if (c.kind === 'file') return `when ${c.path || 'a file'} changes`;
  return 'when you press Run';
}
const hostOf = (url) => {
  try {
    return new URL(url).host + new URL(url).pathname.replace(/\/$/, '');
  } catch {
    return '';
  }
};

/** One line under a node's title: what it is set to do. */
function summary(node) {
  const c = node.config;
  switch (node.type) {
    case 'trigger': return startText(c);
    case 'agent': return c.text || 'no task written yet';
    case 'ai': return (c.json ? '[json] ' : '') + (c.prompt?.split('\n').find((l) => l.trim()) ?? 'no question yet');
    case 'app': return c.tool ? c.tool.slice(c.connection.length + 2) : 'plug into an agent, or pick an action';
    case 'service': {
      const s = serviceOf(c.service);
      const a = s?.actions.find((x) => x.id === c.action);
      const first = a?.fields.map((f) => c.params?.[f.id]).find((v) => v);
      return `${a?.label ?? c.action}${first ? `: ${first}` : ''}`;
    }
    case 'if':
    case 'filter': return (c.conditions ?? []).map(conditionText).join(c.combine === 'or' ? ' or ' : ' and ');
    case 'switch': return (c.rules ?? []).map((r, i) => `${i + 1}: ${conditionText(r)}`).join('; ');
    case 'merge': return { append: 'all into one list', combine: 'fields into one object', text: 'as one text' }[c.mode];
    case 'wait': return c.seconds >= 60 && c.seconds % 60 === 0 ? `${c.seconds / 60} min` : `${c.seconds} s`;
    case 'set': return (c.fields ?? []).map((f) => f.key).join(', ') || 'no fields';
    case 'code': return c.code?.split('\n').find((l) => l.trim() && !l.trim().startsWith('//')) ?? '';
    case 'http': return `${c.method} ${hostOf(c.url) || '…'}`;
    case 'flow': return flows.find((f) => f.id === c.flow)?.name ?? 'choose a flow';
    case 'file': return `${c.op} ${c.path || '…'}`;
    case 'command': return c.command ? `$ ${c.command}` : 'no command yet';
    case 'note': return c.text;
    default: return '';
  }
}

function iconOf(node) {
  if (node.type === 'app') return logo(node.config.connection, node.config.connection.slice(0, 2).toUpperCase());
  if (node.type === 'service') return logo(node.config.service, (serviceOf(node.config.service)?.label ?? '?').slice(0, 3).toUpperCase());
  const cook = node.type === 'agent' && node.config.agent && state.agents[node.config.agent] ? node.config.agent : null;
  if (node.type === 'agent') return h('span', { class: 'node-face' }, cook ? face(cook) : '{o}');
  return h('span', { class: 'palette-tag' }, KINDS[node.type]?.tag ?? '?');
}

// -------------------------------------------------------------- making nodes

function serviceConfig(service, action) {
  const params = Object.fromEntries(action.fields.map((f) => [f.id, !f.fixed && /^\{\{/.test(f.placeholder ?? '') ? f.placeholder : '']));
  const credential = service.auth ? creds.find((c) => c.type === service.auth)?.id ?? '' : '';
  return { service: service.id, action: action.id, credential, params };
}

function appConfig(connection, tool = null) {
  if (!tool) return { connection, tool: '', args: '{}' };
  return { connection, tool: tool.name, args: JSON.stringify(Object.fromEntries(tool.params.map((p, i) => [p, i === 0 ? '{{ input }}' : ''])), null, 2) };
}

/** Where a node lands when it is clicked in rather than dropped: in view, beside what is there. */
function freeSpot() {
  const box = $('#flow-canvas');
  const view = { x: box.scrollLeft / zoom, y: box.scrollTop / zoom, w: box.clientWidth / zoom, h: box.clientHeight / zoom };
  let spot = { x: view.x + view.w / 2 - 100, y: view.y + view.h / 2 - 40 };
  for (let i = 0; i < 20 && draft.nodes.some((n) => Math.abs(n.x - spot.x) < 120 && Math.abs(n.y - spot.y) < 70); i++) spot = { x: spot.x + 30, y: spot.y + 90 };
  return spot;
}

function addNode(type, config, at = null, from = null) {
  if (!draft) return null;
  let spot = at;
  if (!spot && from) {
    const src = nodeOf(from.node);
    const ports = outPorts(src);
    spot = { x: src.x + 270, y: src.y + Math.max(0, ports.indexOf(from.port)) * 110 };
  }
  spot ??= freeSpot();
  const node = { id: newId(), type, x: Math.max(0, Math.round(spot.x)), y: Math.max(0, Math.round(spot.y)), config };
  if (type !== 'note') node.name = uniqueName(defaultTitle(node));
  if (type === 'note') Object.assign(node, { w: 240, h: 110 });
  draft.nodes.push(node);
  if (from) {
    const src = nodeOf(from.node);
    if (!mayWire(src, from.port, node)) draft.edges.push({ from: src.id, to: node.id, port: from.port });
  }
  selected = new Set([node.id]);
  pickedEdge = null;
  touch();
  commit();
  renderCanvas();
  renderSettings();
  space.querySelector(`[data-id="${node.id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return node;
}

function setStart(config) {
  const t = trigger();
  t.config = config;
  selected = new Set([t.id]);
  touch();
  commit();
  renderCanvas();
  renderSettings();
}

/** Every node and start there is, for the palette and the node search. */
function entries() {
  const list = [];
  for (const [type, kind] of Object.entries(KINDS)) {
    if (!kind.group) continue;
    list.push({ group: kind.group, label: kind.title, hint: kind.hint, icon: () => h('span', { class: 'palette-tag' }, kind.tag), make: () => ({ type, config: kind.defaults() }) });
  }
  for (const s of catalog.services) {
    for (const a of s.actions) list.push({ group: 'Services', service: s.id, label: `${s.label}: ${a.label}`, hint: s.about || `${a.label} in ${s.label}`, icon: () => logo(s.id, s.label.slice(0, 3).toUpperCase()), make: () => ({ type: 'service', config: serviceConfig(s, a) }) });
  }
  for (const c of connections) {
    list.push({ group: 'Your apps', label: `${c.id} (as a tool)`, hint: `${c.about ?? ''}\nPlug it into an agent node`, icon: () => logo(c.id, c.id.slice(0, 2).toUpperCase()), make: () => ({ type: 'app', config: appConfig(c.id) }) });
    for (const tool of tools.filter((t) => t.name.startsWith(`${c.id}__`))) list.push({ group: 'Your apps', label: `${c.id}: ${tool.name.slice(c.id.length + 2)}`, hint: tool.description, icon: () => logo(c.id, c.id.slice(0, 2).toUpperCase()), make: () => ({ type: 'app', config: appConfig(c.id, tool) }) });
  }
  return list;
}

function startEntries() {
  const list = [
    { label: 'By hand', hint: 'Only when you press Run', config: { kind: 'manual' } },
    { label: 'Every so often', hint: 'Every N minutes', config: { kind: 'schedule', schedule: { kind: 'interval', minutes: 60 } } },
    { label: 'At a time of day', hint: 'On the days you choose', config: { kind: 'schedule', schedule: { kind: 'daily', time: '09:00', days: [] } } },
    { label: 'Webhook', hint: 'A program on this computer sends JSON to an address', webhook: true },
    ...catalog.pollers.map((p) => ({ label: p.label, hint: 'Checked every few minutes; each new item starts the flow once', config: { kind: 'poll', poller: p.id, every: p.id === 'watch' ? 15 : p.every, ...Object.fromEntries(p.fields.map((f) => [f.id, ''])) } })),
    ...(tools.length ? [{ label: 'An app answers something new', hint: 'Ask one of your apps every few minutes; a different answer starts the flow', config: { kind: 'poll', poller: 'app', tool: '', args: '{}', every: 15 } }] : []),
    { label: 'A file in the folder changes', hint: 'A file or folder you name (or any)', config: { kind: 'file', path: '' } },
    ...triggers.filter((t) => t.type !== 'webhook').map((t) => ({ label: `${t.label}: ${t.name}`, hint: 'A trigger set up under "connect"', config: { kind: 'trigger', id: t.id } })),
  ];
  return list;
}

// ------------------------------------------------------------ side panel

function renderSideTabs() {
  const tab = (id, label) => h('button', { class: `flow-tab${side === id ? ' active' : ''}`, type: 'button', role: 'tab', ariaSelected: String(side === id), disabled: id === 'runs' && !saved(), onclick: () => showSide(id) }, label);
  $('#flow-side-tabs').replaceChildren(tab('flows', 'flows'), tab('runs', `runs${saved() ? ` (${saved().runs ?? 0})` : ''}`));
  $('#flow-list').hidden = side !== 'flows';
  $('#flow-palette').hidden = side !== 'flows';
  $('#flow-runs').hidden = side !== 'runs';
}

async function showSide(which) {
  side = which;
  if (which === 'flows' && viewing) {
    viewing = null;
    renderCanvas();
    renderBanner();
  }
  renderSideTabs();
  if (which === 'runs') await loadRuns();
}

async function loadRuns() {
  if (!saved()) return;
  try {
    ({ runs } = await api.flows.runs(current));
  } catch (err) {
    return fail(err);
  }
  renderRuns();
}

function renderRuns() {
  const flow = saved();
  $('#flow-runs').replaceChildren(
    h('div', { class: 'flow-side-label' }, 'runs of this flow'),
    ...(runs.length
      ? runs.map((r) => {
          const status = flow?.running && r.id === flow.lastRun?.id ? 'running' : r.stopped ? 'stopped' : r.ok ? 'ok' : 'failed';
          return h(
            'button',
            { class: `flow-item${viewing?.id === r.id ? ' active' : ''}`, type: 'button', onclick: () => viewRun(r) },
            h('strong', null, short(r.at)),
            h('span', { class: `badge${status === 'ok' || status === 'running' ? ' on' : status === 'failed' ? ' warn' : ''}` }, status),
            h('span', { class: 'muted' }, `${r.source}${r.ms ? `, ${r.ms < 1000 ? `${r.ms} ms` : `${(r.ms / 1000).toFixed(1)} s`}` : ''}${r.pins ? ', with pins' : ''}`),
          );
        })
      : [h('p', { class: 'muted palette-empty' }, 'No runs yet. Press Run, or switch the flow on and wait for its start.')]),
  );
}

function viewRun(record) {
  viewing = record;
  renderRuns();
  renderCanvas();
  renderBanner();
  renderSettings();
  if (ndvId) renderNdv();
}

function renderBanner() {
  const el = $('#flow-banner');
  el.hidden = !viewing;
  if (!viewing) return el.replaceChildren();
  const tried = viewing.source === 'try';
  el.replaceChildren(
    h('span', null, tried
      ? `Tried once${viewing.ok ? '' : ' - it stopped at a node that failed'}. Nothing was sent, written or run: nodes marked "held back" show what they would do. Open a node to see its data.${viewing.startNote ? ` (${viewing.startNote})` : ''}`
      : `Showing the run of ${when(viewing.at)} (${viewing.source}, ${viewing.stopped ? 'stopped' : viewing.ok ? 'finished' : 'failed'}). Open a node to see its data.`),
    ...(failureOf(viewing) ? [h('button', { class: 'btn sm primary', type: 'button', title: 'The Chef changes the flow so that this step works', onclick: (e) => changeFlow('Fix it so that it runs without this error.', failureOf(viewing), e.currentTarget) }, 'Fix it')] : []),
    h('button', { class: 'btn sm', type: 'button', onclick: () => viewRun(null) }, 'Back to the latest'),
  );
}

function renderList() {
  const tags = [...new Set(flows.flatMap((f) => f.tags ?? []))];
  const q = listQuery.toLowerCase();
  const shown = flows.filter((f) => !q || f.name.toLowerCase().includes(q) || (f.tags ?? []).some((t) => t.includes(q.replace(/^#/, ''))));
  const search = h('input', { type: 'search', class: 'flow-search', placeholder: 'Find a flow or #tag', ariaLabel: 'Find a flow', value: listQuery });
  search.oninput = () => {
    listQuery = search.value;
    renderList();
    $('#flow-list .flow-search')?.focus();
  };
  const example = h('select', { class: 'select', ariaLabel: 'Start from an example' }, h('option', { value: '' }, '+ from an example…'), ...EXAMPLES.map((e) => h('option', { value: e.id }, e.label)));
  example.onchange = () => {
    const ex = EXAMPLES.find((e) => e.id === example.value);
    if (ex) openDraft(ex.flow());
  };
  $('#flow-list').replaceChildren(
    h('div', { class: 'flow-side-label' }, 'your flows'),
    ...(flows.length > 4 ? [search] : []),
    ...(tags.length && flows.length > 4 ? [h('div', { class: 'tag-row' }, ...tags.map((t) => h('button', { class: `tag-chip${listQuery === `#${t}` ? ' on' : ''}`, type: 'button', onclick: () => ((listQuery = listQuery === `#${t}` ? '' : `#${t}`), renderList()) }, `#${t}`)))] : []),
    ...shown.map((flow) => {
      const status = flow.running ? 'running' : !flow.enabled ? 'off' : flow.pollError ? 'check' : flow.lastRun ? (flow.lastRun.ok ? 'ok' : 'failed') : 'new';
      return h(
        'button',
        { class: `flow-item${current === flow.id ? ' active' : ''}`, type: 'button', onclick: () => open(flow.id) },
        h('strong', null, flow.name),
        h('span', { class: `badge${status === 'ok' || status === 'running' ? ' on' : status === 'failed' || status === 'check' ? ' warn' : ''}` }, status),
        h('span', { class: 'muted' }, startText(flow.nodes.find((n) => n.type === 'trigger').config)),
      );
    }),
    h('button', { class: 'flow-item new', type: 'button', title: 'Say what should happen; the Chef draws it for you to check', onclick: describeFlow }, '+ describe a flow'),
    h('button', { class: `flow-item new${current === 'new' ? ' active' : ''}`, type: 'button', onclick: () => open('new') }, '+ new flow'),
    example,
  );
  const live = flows.filter((f) => f.enabled && f.nodes.find((n) => n.type === 'trigger').config.kind !== 'manual').length;
  $('#flows-count').hidden = !live;
  $('#flows-count').textContent = String(live);
}

function paletteItem(entry) {
  const item = h('button', { class: 'palette-item', type: 'button', draggable: true, title: `${entry.hint ?? ''}\nDrag onto the canvas, or click`, onclick: () => {
    const made = entry.make();
    addNode(made.type, made.config);
  } }, entry.icon(), h('span', null, entry.label));
  item.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-kadhai-node', JSON.stringify(entry.make()));
    e.dataTransfer.effectAllowed = 'copy';
  });
  return item;
}

function renderPalette() {
  const box = $('#flow-palette');
  if (!draft) return box.replaceChildren();
  const q = paletteQuery.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (e) => q.every((word) => `${e.label} ${e.hint ?? ''} ${e.group ?? ''}`.toLowerCase().includes(word));
  const search = h('input', { type: 'search', class: 'flow-search', placeholder: 'Search nodes', ariaLabel: 'Search nodes', value: paletteQuery });
  search.oninput = () => {
    paletteQuery = search.value;
    renderPalette();
    const again = $('#flow-palette .flow-search');
    again.focus();
    again.setSelectionRange(again.value.length, again.value.length);
  };
  const all = entries();
  const starts = startEntries().filter((e) => hit({ ...e, group: 'start' }));
  const groups = [...GROUPS, 'Services', 'Your apps'];
  const sections = [];
  if (starts.length) {
    sections.push(
      h('details', { class: 'palette-group', open: Boolean(q.length) }, h('summary', null, 'what starts it'), ...starts.map((s) => h('button', { class: 'palette-item start', type: 'button', title: s.hint, onclick: () => (s.webhook ? makeWebhook() : setStart(structuredClone(s.config))) }, h('span', { class: 'palette-tag' }, '>'), h('span', null, s.label)))),
    );
  }
  for (const g of groups) {
    let list = all.filter((e) => e.group === g && hit(e));
    if (g === 'Services' && !q.length) {
      // Unsearched, one entry per service; its actions are chosen in its settings.
      const seen = new Set();
      list = list.filter((e) => !seen.has(e.service) && seen.add(e.service)).map((e) => ({ ...e, label: serviceOf(e.service).label }));
    }
    if (!list.length) continue;
    sections.push(h('details', { class: 'palette-group', open: g !== 'Your apps' || q.length > 0 || list.length < 6 }, h('summary', null, g.toLowerCase()), ...list.slice(0, 60).map(paletteItem)));
  }
  if (!connections.length && !q.length) sections.push(h('p', { class: 'muted palette-empty' }, 'Apps you add under "connect" in the taskbar appear here too.'));
  box.replaceChildren(h('div', { class: 'flow-side-label' }, 'add a node'), search, ...sections, ...(q.length && !sections.length ? [h('p', { class: 'muted palette-empty' }, 'Nothing matches.')] : []));
}

// ---------------------------------------------------------------- canvas

/** A point on the screen, in the canvas's own (unzoomed) coordinates. */
function toSpace(clientX, clientY) {
  const b = space.getBoundingClientRect();
  return { x: (clientX - b.left) / zoom, y: (clientY - b.top) / zoom };
}

/** Centre of a port, in the canvas's own coordinates. */
function portPoint(nodeId, port) {
  const el = space.querySelector(`.flow-node[data-id="${nodeId}"] .port[data-port="${port}"]`);
  if (!el) return null;
  const a = el.getBoundingClientRect();
  const b = space.getBoundingClientRect();
  return { x: (a.left - b.left + a.width / 2) / zoom, y: (a.top - b.top + a.height / 2) / zoom };
}

/** A wire: a soft S between two points. A tool wire runs upwards, from an app into the foot of an agent. */
function wirePath(a, b, tool) {
  if (tool) {
    const d = Math.max(40, Math.abs(b.y - a.y) / 2);
    return `M ${a.x} ${a.y} C ${a.x} ${a.y - d}, ${b.x} ${b.y + d}, ${b.x} ${b.y}`;
  }
  const d = Math.max(40, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + d} ${a.y}, ${b.x - d} ${b.y}, ${b.x} ${b.y}`;
}

/** Did this wire carry something in the run on show? */
function carried(edge) {
  const rec = shownRun();
  const from = rec?.nodes?.[edge.from];
  if (!from || from.status !== 'ok' || edge.port === 'tool' || !rec.nodes[edge.to]) return null;
  if (edge.port !== 'out' && edge.port !== from.port) return null;
  return from.items ?? 1;
}

function drawWires() {
  if (!wires) return;
  wires.replaceChildren(
    ...draft.edges.flatMap((edge, index) => {
      const a = portPoint(edge.from, edge.port);
      const b = portPoint(edge.to, edge.port === 'tool' ? 'tools' : 'in');
      if (!a || !b) return [];
      const d = wirePath(a, b, edge.port === 'tool');
      const count = carried(edge);
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', `wire${edge.port === 'tool' ? ' tool' : ''}${pickedEdge === index ? ' picked' : ''}${count != null ? ' ran' : ''}`);
      // A fat invisible twin underneath, so a thin wire is still easy to click.
      const hit = document.createElementNS(SVG, 'path');
      hit.setAttribute('d', d);
      hit.setAttribute('class', 'wire-hit');
      hit.addEventListener('click', () => {
        pickedEdge = index;
        selected = new Set();
        refreshSelection();
        renderSettings();
      });
      const parts = [hit, path];
      if (count) {
        const label = document.createElementNS(SVG, 'text');
        label.setAttribute('x', String((a.x + b.x) / 2));
        label.setAttribute('y', String((a.y + b.y) / 2 - 6));
        label.setAttribute('class', 'wire-label');
        label.textContent = plural(count, 'item');
        parts.push(label);
      }
      return parts;
    }),
  );
}

function bounds() {
  const xs = draft.nodes.map((n) => n.x);
  const ys = draft.nodes.map((n) => n.y);
  return { x: Math.min(...xs), y: Math.min(...ys), r: Math.max(...draft.nodes.map((n) => n.x + (n.w ?? 210))), b: Math.max(...draft.nodes.map((n) => n.y + (n.h ?? 110))) };
}

function sizeSpace() {
  const box = $('#flow-canvas');
  const b = bounds();
  const w = Math.max(box.clientWidth / zoom, b.r + 600);
  const hgt = Math.max(box.clientHeight / zoom, b.b + 400);
  space.style.width = `${w}px`;
  space.style.height = `${hgt}px`;
  space.style.transform = `scale(${zoom})`;
  sizer.style.width = `${w * zoom}px`;
  sizer.style.height = `${hgt * zoom}px`;
}

/** Why a wire may not go from this port to that node, or null if it may. Loops are the server's to refuse. */
function mayWire(from, port, to) {
  if (!to || from.id === to.id) return 'A node cannot be wired to itself';
  if (to.type === 'trigger') return 'Nothing can be wired into the start';
  if (to.type === 'note' || from.type === 'note') return 'A note has no wires';
  if (port === 'tool' && to.type !== 'agent') return 'An app plugs in as a tool only on an agent node';
  if (draft.edges.some((e) => e.from === from.id && e.to === to.id && e.port === port)) return 'Those two are already wired';
  return null;
}

function connect(from, port, to) {
  const no = mayWire(from, port, to);
  if (no) return toast(no, 'err');
  draft.edges.push({ from: from.id, to: to.id, port });
  touch();
  commit();
  renderCanvas();
  renderSettings();
}

/** Dragging from an output port: a loose wire follows the pointer. On a node it wires; on empty canvas it asks what comes next. */
function startWire(e, node, port) {
  e.preventDefault();
  e.stopPropagation();
  const a = portPoint(node.id, port);
  const loose = document.createElementNS(SVG, 'path');
  loose.setAttribute('class', 'wire loose');
  wires.append(loose);
  const move = (ev) => loose.setAttribute('d', wirePath(a, toSpace(ev.clientX, ev.clientY), port === 'tool'));
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    loose.remove();
    const target = document.elementFromPoint(ev.clientX, ev.clientY);
    const nodeEl = target?.closest('.flow-node');
    if (nodeEl && nodeEl.dataset.id !== node.id) return connect(node, port, nodeOf(nodeEl.dataset.id));
    const far = Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) > 30;
    if (far && port !== 'tool' && target?.closest('#flow-canvas')) openCreator({ x: ev.clientX, y: ev.clientY, from: { node: node.id, port } });
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/** Dragging a node by its title moves it, and every other selected node with it. */
function startMove(e, node) {
  if (e.button !== 0 || e.target.closest('.port, .port-add, button')) return;
  if (!selected.has(node.id) && !e.shiftKey) {
    selected = new Set([node.id]);
    pickedEdge = null;
    refreshSelection();
    renderSettings();
  }
  const moving = draft.nodes.filter((n) => selected.has(n.id) || n.id === node.id);
  const start = { x: e.clientX, y: e.clientY, at: moving.map((n) => ({ n, x: n.x, y: n.y, el: space.querySelector(`[data-id="${n.id}"]`) })) };
  let moved = false;
  const move = (ev) => {
    const dx = (ev.clientX - start.x) / zoom;
    const dy = (ev.clientY - start.y) / zoom;
    if (!moved && Math.hypot(dx, dy) < 3) return;
    moved = true;
    for (const m of start.at) {
      m.n.x = Math.max(0, Math.round(m.x + dx));
      m.n.y = Math.max(0, Math.round(m.y + dy));
      m.el.style.left = `${m.n.x}px`;
      m.el.style.top = `${m.n.y}px`;
    }
    drawWires();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (moved) {
      justDragged = true;
      setTimeout(() => (justDragged = false), 0);
      touch();
      commit();
      sizeSpace();
      renderMinimap();
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function clickNode(e, node) {
  if (justDragged) return;
  if (e.shiftKey || e.ctrlKey || e.metaKey) {
    if (selected.has(node.id)) selected.delete(node.id);
    else selected.add(node.id);
  } else selected = new Set([node.id]);
  pickedEdge = null;
  refreshSelection();
  renderSettings();
}

/** Show the selection without redrawing the canvas (which would lose the scroll and the focus). */
function refreshSelection() {
  if (!space) return;
  for (const el of space.querySelectorAll('[data-id]')) el.classList.toggle('picked', selected.has(el.dataset.id));
  drawWires();
}

function noteEl(node) {
  const text = h('div', { class: 'note-text' }, node.config.text);
  const el = h('div', {
    class: `sticky${node.config.color ? ` note-${node.config.color}` : ''}${selected.has(node.id) ? ' picked' : ''}`,
    style: `left:${node.x}px;top:${node.y}px;width:${node.w ?? 240}px;height:${node.h ?? 110}px`,
    dataset: { id: node.id },
    tabIndex: 0,
    role: 'note',
    ariaLabel: `Note: ${node.config.text}`,
    onclick: (e) => clickNode(e, node),
    ondblclick: () => editNote(node, el),
  }, h('div', { class: 'note-grip', title: 'Drag to move' }), text);
  el.querySelector('.note-grip').addEventListener('pointerdown', (e) => startMove(e, node));
  text.addEventListener('pointerdown', (e) => startMove(e, node));
  // Resized with the corner handle (CSS resize): the new size is kept.
  el.addEventListener('pointerup', () => {
    const w = Math.round(el.offsetWidth);
    const hgt = Math.round(el.offsetHeight);
    if (Math.abs(w - (node.w ?? 240)) > 2 || Math.abs(hgt - (node.h ?? 110)) > 2) {
      node.w = w;
      node.h = hgt;
      touch();
      commit();
    }
  });
  return el;
}

function editNote(node, el) {
  const area = h('textarea', { class: 'note-edit', ariaLabel: 'Note text', maxLength: 2000 });
  area.value = node.config.text;
  area.onblur = () => {
    node.config.text = area.value;
    touch();
    commit();
    renderCanvas();
  };
  area.onkeydown = (e) => e.key === 'Escape' && area.blur();
  el.querySelector('.note-text').replaceWith(area);
  area.focus();
}

function nodeEl(node) {
  if (node.type === 'note') return noteEl(node);
  const ran = shownRun()?.nodes?.[node.id];
  const mark = ran ? { ok: '[x]', failed: '[!]', running: '[~]' }[ran.status] : '';
  const cook = node.type === 'agent' && node.config.agent && state.agents[node.config.agent] ? node.config.agent : null;
  const port = (name, cls, label) => h('span', { class: `port ${cls}`, dataset: { port: name }, title: label });
  const outs = outPorts(node).filter((p) => p !== 'tool').map((name) => {
    const el = port(name, 'out', name === 'out' ? 'Drag to another node to wire them, or onto empty canvas to add one' : `Drag to the node that runs on "${name}"`);
    el.addEventListener('pointerdown', (e) => startWire(e, node, name));
    const add = h('button', { class: 'port-add', type: 'button', title: 'Add a node here', ariaLabel: `Add a node after ${title(node)}${name === 'out' ? '' : ` (${name})`}`, onclick: (e) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      openCreator({ x: r.right + 8, y: r.top, from: { node: node.id, port: name } });
    } }, '+');
    return h('span', { class: 'port-row' }, name === 'out' ? null : h('span', { class: 'port-label' }, name), el, add);
  });
  const badges = [
    node.check ? h('span', { class: 'node-badge check', title: node.check }, '[!] check') : null,
    ran?.held ? h('span', { class: 'node-badge held', title: ran.note }, 'held back') : null,
    node.disabled ? h('span', { class: 'node-badge' }, 'off') : null,
    node.pinned !== undefined ? h('span', { class: 'node-badge pin', title: 'Pinned data stands in for this node when you run the flow by hand' }, 'pinned') : null,
    node.retries ? h('span', { class: 'node-badge' }, `retry ${node.retries}`) : null,
    node.onError === 'continue' ? h('span', { class: 'node-badge' }, 'on error: go on') : null,
  ].filter(Boolean);
  const el = h(
    'div',
    {
      class: `flow-node node-${node.type}${selected.has(node.id) ? ' picked' : ''}${cook ? ' tinted' : ''}${node.disabled ? ' disabled' : ''}${outPorts(node).some((p) => p !== 'out' && p !== 'tool') ? ' labelled' : ''}`,
      style: `left:${node.x}px;top:${node.y}px${cook ? `;${tintOf(cook)}` : ''}`,
      dataset: ran ? { id: node.id, status: ran.status } : { id: node.id },
      tabIndex: 0,
      role: 'button',
      ariaLabel: `${title(node)}: ${summary(node)}. Enter opens it.`,
      onclick: (e) => clickNode(e, node),
      ondblclick: () => openNdv(node.id),
      onkeydown: (e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') openNdv(node.id);
        if (e.key === ' ') e.currentTarget.click();
      },
    },
    node.type === 'trigger' ? h('span', { class: 'node-start-mark', ariaHidden: 'true' }, '>') : port('in', 'in', 'Wires arrive here'),
    h('div', { class: 'node-head' }, iconOf(node), h('strong', null, title(node)), h('span', { class: 'node-mark' }, mark)),
    h('div', { class: 'node-sum' }, summary(node)),
    badges.length ? h('div', { class: 'node-badges' }, ...badges) : null,
    h('div', { class: 'node-outs' }, ...outs),
    node.type === 'agent' ? h('span', { class: 'port-foot' }, port('tools', 'tools', 'Drag an app\'s top port here to give this agent that app'), h('span', { class: 'port-label' }, 'tools')) : null,
  );
  if (node.type === 'app') {
    const top = port('tool', 'tool', 'Drag onto an agent node to plug this app in as one of its tools');
    top.addEventListener('pointerdown', (e) => startWire(e, node, 'tool'));
    el.append(h('span', { class: 'port-top' }, top, h('span', { class: 'port-label' }, 'as tool')));
  }
  el.querySelector('.node-head').addEventListener('pointerdown', (e) => startMove(e, node));
  el.querySelector('.node-sum').addEventListener('pointerdown', (e) => startMove(e, node));
  return el;
}

function renderCanvas() {
  const box = $('#flow-canvas');
  if (!draft) {
    space = null;
    wires = null;
    box.replaceChildren(
      h(
        'div',
        { class: 'flow-welcome' },
        h('pre', { ariaHidden: 'true' }, '[ start ]──▶[ http ]──▶[ if ]──▶[ AI ]──▶[ telegram ]\n                          │\n                          └──▶[ agent ]◀── [ app ]'),
        h('p', null, 'A flow is a drawing: something that starts it, then nodes joined by wires. Data travels along the wires, and any setting can quote it with {{ input.field }}.'),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: describeFlow }, 'Describe it in words'), h('button', { class: 'btn', type: 'button', onclick: () => open('new') }, 'Draw a new flow'), h('button', { class: 'btn', type: 'button', onclick: () => openDraft(EXAMPLES[0].flow()) }, 'Open an example')),
      ),
    );
    renderMinimap();
    renderTools();
    return;
  }
  wires = document.createElementNS(SVG, 'svg');
  wires.setAttribute('class', 'flow-wires');
  wires.setAttribute('aria-hidden', 'true');
  space = h('div', { class: 'flow-space' }, wires, ...draft.nodes.map(nodeEl));
  sizer = h('div', { class: 'flow-sizer' }, space);
  const scroll = { x: box.scrollLeft, y: box.scrollTop };
  box.replaceChildren(sizer);
  sizeSpace();
  box.scrollLeft = scroll.x;
  box.scrollTop = scroll.y;
  drawWires();
  renderMinimap();
  renderTools();
}

function removeNodes(ids) {
  const gone = [...ids].filter((id) => nodeOf(id)?.type !== 'trigger');
  if (!gone.length) return toast('A flow keeps its start', 'err');
  draft.nodes = draft.nodes.filter((n) => !gone.includes(n.id));
  draft.edges = draft.edges.filter((e) => !gone.includes(e.from) && !gone.includes(e.to));
  selected = new Set();
  if (gone.includes(ndvId)) closeNdv();
  touch();
  commit();
  renderCanvas();
  renderSettings();
}

function removeEdge(index) {
  draft.edges.splice(index, 1);
  pickedEdge = null;
  touch();
  commit();
  renderCanvas();
  renderSettings();
}

// ------------------------------------------------------ zoom, minimap, tools

function setZoom(next, cx = null, cy = null) {
  const box = $('#flow-canvas');
  const r = box.getBoundingClientRect();
  const ax = cx ?? r.left + r.width / 2;
  const ay = cy ?? r.top + r.height / 2;
  const px = (box.scrollLeft + ax - r.left) / zoom;
  const py = (box.scrollTop + ay - r.top) / zoom;
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 100) / 100));
  prefs.set('flowZoom', String(zoom));
  if (!space) return renderTools();
  sizeSpace();
  box.scrollLeft = px * zoom - (ax - r.left);
  box.scrollTop = py * zoom - (ay - r.top);
  renderMinimap();
  renderTools();
}

/** Fit the whole flow in view - but never so small it cannot be read (unless asked with the button). */
function fitView(readable = false) {
  if (!draft) return;
  const box = $('#flow-canvas');
  const b = bounds();
  let next = Math.min(1.2, (box.clientWidth - 60) / (b.r - b.x + 40), (box.clientHeight - 60) / (b.b - b.y + 40));
  if (readable) next = Math.max(next, 0.85);
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 100) / 100));
  prefs.set('flowZoom', String(zoom));
  sizeSpace();
  box.scrollLeft = (b.x - 30) * zoom;
  box.scrollTop = (b.y - 30) * zoom;
  renderMinimap();
  renderTools();
}

/** Tidy up: columns by how far a node is from the start, rows in the order they were drawn. */
function tidy() {
  if (!draft) return;
  const main = draft.edges.filter((e) => e.port !== 'tool');
  const depth = new Map([[trigger().id, 0]]);
  for (let pass = 0; pass < draft.nodes.length; pass++) {
    for (const e of main) if (depth.has(e.from)) depth.set(e.to, Math.max(depth.get(e.to) ?? 0, depth.get(e.from) + 1));
  }
  const columns = new Map();
  for (const n of draft.nodes) {
    if (n.type === 'note' || n.type === 'app') continue;
    const d = depth.get(n.id) ?? 0;
    columns.set(d, [...(columns.get(d) ?? []), n]);
  }
  for (const [d, list] of columns) {
    list.sort((a, b) => a.y - b.y);
    list.forEach((n, i) => {
      n.x = 40 + d * 280;
      n.y = 60 + i * 170;
    });
  }
  // An app plugged into an agent sits under it.
  for (const e of draft.edges.filter((x) => x.port === 'tool')) {
    const app = nodeOf(e.from);
    const agent = nodeOf(e.to);
    if (app && agent) Object.assign(app, { x: agent.x, y: agent.y + 150 });
  }
  touch();
  commit();
  renderCanvas();
  fitView();
}

function renderTools() {
  const box = $('#flow-tools');
  if (!draft) return box.replaceChildren();
  const btn = (label, hint, fn, disabled = false) => h('button', { class: 'tool-btn', type: 'button', title: hint, ariaLabel: hint, disabled, onclick: fn }, label);
  box.replaceChildren(
    btn('+ node', 'Add a node (Tab)', () => openCreator({})),
    btn('undo', 'Undo (Ctrl+Z)', undo, !past.length && !dirty),
    btn('redo', 'Redo (Ctrl+Shift+Z)', redo, !future.length),
    btn('tidy', 'Tidy up: line the nodes up by step', tidy),
    btn('-', 'Zoom out (-)', () => setZoom(zoom / 1.2)),
    btn(`${Math.round(zoom * 100)}%`, 'Back to 100% (0)', () => setZoom(1)),
    btn('+', 'Zoom in (+)', () => setZoom(zoom * 1.2)),
    btn('fit', 'Fit the whole flow in view (1)', () => fitView()),
  );
}

let minimapFrame = 0;
function renderMinimap() {
  cancelAnimationFrame(minimapFrame);
  minimapFrame = requestAnimationFrame(() => {
    const map = $('#flow-minimap');
    if (!draft || !space || draft.nodes.length < 2) {
      map.hidden = true;
      return;
    }
    map.hidden = false;
    const box = $('#flow-canvas');
    const W = parseFloat(space.style.width);
    const H = parseFloat(space.style.height);
    const scale = Math.min(170 / W, 100 / H);
    map.style.width = `${Math.round(W * scale)}px`;
    map.style.height = `${Math.round(H * scale)}px`;
    const rec = shownRun();
    map.replaceChildren(
      ...draft.nodes.map((n) => h('span', { class: `mm-node${n.type === 'note' ? ' note' : ''}${rec?.nodes?.[n.id]?.status === 'failed' ? ' failed' : ''}`, style: `left:${n.x * scale}px;top:${n.y * scale}px;width:${Math.max(3, (n.w ?? 200) * scale)}px;height:${Math.max(2, (n.h ?? 70) * scale)}px` })),
      h('span', { class: 'mm-view', style: `left:${(box.scrollLeft / zoom) * scale}px;top:${(box.scrollTop / zoom) * scale}px;width:${(box.clientWidth / zoom) * scale}px;height:${(box.clientHeight / zoom) * scale}px` }),
    );
    map.dataset.scale = String(scale);
  });
}

// ------------------------------------------------------------ node search

let creatorAt = null;
function openCreator({ x = null, y = null, from = null }) {
  if (!draft) return;
  const stage = $('#flow-stage');
  const box = $('#flow-creator');
  const r = stage.getBoundingClientRect();
  const cx = x ?? r.left + r.width / 2 - 160;
  const cy = y ?? r.top + 60;
  creatorAt = { from, point: x != null ? toSpace(x, y) : null };
  box.style.left = `${Math.max(8, Math.min(cx - r.left, r.width - 330))}px`;
  box.style.top = `${Math.max(8, Math.min(cy - r.top, r.height - 380))}px`;
  box.hidden = false;
  const input = h('input', { type: 'search', class: 'flow-search', placeholder: from ? 'What comes next?' : 'Search nodes', ariaLabel: 'Search nodes' });
  const list = h('div', { class: 'creator-list', role: 'listbox' });
  let active = 0;
  let shown = [];
  const fromNode = from ? nodeOf(from.node) : null;
  const draw = () => {
    const q = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    shown = entries().filter((e) => q.every((w) => `${e.label} ${e.hint ?? ''} ${e.group}`.toLowerCase().includes(w)));
    if (fromNode) shown = shown.filter((e) => e.group !== 'Your apps' || !e.label.endsWith('(as a tool)'));
    shown = shown.slice(0, 80);
    active = Math.min(active, Math.max(0, shown.length - 1));
    let group = '';
    list.replaceChildren(
      ...shown.flatMap((e, i) => {
        const out = [];
        if (e.group !== group) {
          group = e.group;
          out.push(h('div', { class: 'creator-group' }, group.toLowerCase()));
        }
        out.push(h('button', { class: `creator-item${i === active ? ' active' : ''}`, type: 'button', role: 'option', ariaSelected: String(i === active), title: e.hint ?? '', onclick: () => pick(e), onmousemove: () => {
          if (active !== i) {
            active = i;
            draw();
          }
        } }, e.icon(), h('span', null, e.label), h('span', { class: 'muted' }, (e.hint ?? '').split('\n')[0])));
        return out;
      }),
      ...(shown.length ? [] : [h('p', { class: 'muted palette-empty' }, 'Nothing matches.')]),
    );
    list.querySelector('.creator-item.active')?.scrollIntoView({ block: 'nearest' });
  };
  const pick = (e) => {
    const { point, from: after } = creatorAt;
    closeCreator();
    const made = e.make();
    addNode(made.type, made.config, point ? { x: point.x, y: point.y - 30 } : null, after);
  };
  input.oninput = () => {
    active = 0;
    draw();
  };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length);
      draw();
    } else if (e.key === 'Enter' && shown[active]) {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeCreator();
    }
  };
  box.replaceChildren(h('div', { class: 'creator-head' }, h('strong', null, from ? `after ${title(fromNode)}${from.port !== 'out' ? ` (${from.port})` : ''}` : 'add a node'), h('button', { class: 'icon-btn', type: 'button', ariaLabel: 'Close', onclick: closeCreator }, '×')), input, list);
  draw();
  input.focus();
}

function closeCreator() {
  $('#flow-creator').hidden = true;
  creatorAt = null;
}

// ---------------------------------------------------------- the pop-up box

function pop(heading, ...content) {
  const box = $('#flow-pop');
  box.hidden = false;
  box.replaceChildren(h('div', { class: 'pop-card' }, h('div', { class: 'pop-head' }, h('strong', null, heading), h('button', { class: 'icon-btn', type: 'button', ariaLabel: 'Close', onclick: closePop }, '×')), h('div', { class: 'pop-body' }, ...content)));
  box.querySelector('input, textarea, select, button.btn')?.focus();
}
function closePop() {
  $('#flow-pop').hidden = true;
  $('#flow-pop').replaceChildren();
}

const field = (label, control, hint) => h('label', { class: 'set-field' }, h('span', null, label), control, hint ? h('span', { class: 'muted' }, hint) : null);
const select = (label, options, value) => {
  const el = h('select', { class: 'select', ariaLabel: label }, ...options.map(([v, text]) => h('option', { value: v }, text)));
  el.value = value ?? '';
  return el;
};

/** A form for a new credential of one of these types. Resolves with what was saved, or nothing. */
function credentialForm(types, done) {
  const kinds = catalog.credentials.filter((c) => types.includes(c.id));
  if (!kinds.length) return toast('No credential is needed here', 'err');
  const kind = select('Kind of credential', kinds.map((k) => [k.id, k.label]), kinds[0].id);
  const name = h('input', { type: 'text', maxLength: 40, placeholder: 'A name you will recognise', ariaLabel: 'Name' });
  const fields = h('div', { class: 'pop-fields' });
  const values = {};
  const draw = () => {
    const k = credType(kind.value);
    fields.replaceChildren(
      ...k.fields.map((f) => {
        const input = h('input', { type: f.secret ? 'password' : 'text', autocomplete: 'off', spellcheck: false, placeholder: f.placeholder ?? '', ariaLabel: f.label, oninput: () => (values[f.id] = input.value) });
        return field(f.label + (f.optional ? ' (optional)' : ''), input);
      }),
      ...(k.help ? [h('a', { href: k.help, target: '_blank', rel: 'noopener' }, 'Where to get one ->')] : []),
    );
  };
  kind.onchange = draw;
  draw();
  const save = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
    try {
      const made = await api.credentials.add({ type: kind.value, name: name.value, ...values });
      await loadCredentials();
      closePop();
      toast(`Saved "${made.name}" (stored encrypted)`, 'ok');
      done?.(made);
    } catch (err) {
      fail(err);
    }
  } }, 'Save credential');
  pop('new credential', ...(kinds.length > 1 ? [field('Kind', kind)] : []), field('Name', name), fields, h('p', { class: 'muted' }, 'Kept encrypted in this Kadhai folder and never sent to the browser again. Flows refer to it by name.'), save);
}

function credentialsManager() {
  const list = h('div', { class: 'cred-list' });
  const draw = () =>
    list.replaceChildren(
      ...(creds.length
        ? creds.map((c) => {
            const note = h('span', { class: 'muted' }, c.hint);
            return h(
              'div',
              { class: 'cred-row' },
              h('strong', null, c.name),
              h('span', { class: 'muted' }, c.typeLabel),
              note,
              h('button', { class: 'btn sm', type: 'button', onclick: async () => {
                note.textContent = 'checking…';
                try {
                  const r = await api.credentials.test(c.id);
                  note.textContent = r.ok ? `ok ${r.note}` : `[!] ${r.note}`;
                } catch (err) {
                  note.textContent = `[!] ${err.message}`;
                }
              } }, 'test'),
              h('button', { class: 'btn sm danger', type: 'button', onclick: async () => {
                if (!confirm(`Remove the credential "${c.name}"? Nodes that use it will ask for another.`)) return;
                try {
                  await api.credentials.remove(c.id);
                  await loadCredentials();
                  draw();
                } catch (err) {
                  fail(err);
                }
              } }, 'remove'),
            );
          })
        : [h('p', { class: 'muted' }, 'None yet. A service node asks for one when it needs it.')]),
    );
  draw();
  pop('credentials', list, h('button', { class: 'btn', type: 'button', onclick: () => credentialForm(catalog.credentials.map((c) => c.id), () => credentialsManager()) }, '+ add a credential'));
}

/** A credential choice for a node, with "+ new" at the end. */
function credPicker(node, types, { optional = false, key = 'credential' } = {}) {
  const mine = creds.filter((c) => types.includes(c.type));
  const el = select(
    'Credential',
    [['', optional ? 'None' : 'Choose a credential…'], ...mine.map((c) => [c.id, `${c.name} (${c.typeLabel})${c.hint ? ` ${c.hint}` : ''}`]), ['+new', '+ new credential…']],
    node.config[key] ?? '',
  );
  if (node.config[key] && !mine.some((c) => c.id === node.config[key])) el.append(h('option', { value: node.config[key] }, '(removed - choose another)')), (el.value = node.config[key]);
  el.onchange = () => {
    if (el.value === '+new') {
      el.value = node.config[key] ?? '';
      return credentialForm(types, (made) => {
        node.config[key] = made.id;
        touch();
        commit();
        reshape();
      });
    }
    node.config[key] = el.value;
    touch();
    commit();
  };
  return el;
}

/** The trigger list made a webhook for this flow; its token is shown once. */
async function makeWebhook() {
  try {
    const made = await api.triggers.add({ type: 'webhook', name: (draft.name || 'Flow').slice(0, 40) });
    ({ triggers } = await api.triggers.list());
    setStart({ kind: 'trigger', id: made.id });
    const url = `${location.origin}${made.path}`;
    pop(
      'webhook made',
      h('p', null, 'Send JSON to this address from a program on this computer. Every field of it reaches the flow: {{ input.name }} reads "name".'),
      field('Address', h('input', { type: 'text', readOnly: true, value: url })),
      field('Token (shown only now - copy it)', h('input', { type: 'text', readOnly: true, value: made.token })),
      h('pre', { class: 'dv-text' }, `curl -X POST ${url} \\\n  -H "Authorization: Bearer ${made.token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"name": "Asha", "total": 30}'`),
      h('p', { class: 'muted' }, 'Kadhai only listens on this computer, so this works for scripts and apps here, not for services on the internet. Save the flow so the webhook starts it.'),
    );
  } catch (err) {
    fail(err);
  }
}

// --------------------------------------------------------------- settings

/** Where a picked field of the data goes: the last setting that takes {{ }} you were in. */
function expr(el) {
  el.classList.add('expr');
  el.addEventListener('focus', () => (lastField = el));
  return el;
}
function putExpression(text) {
  const el = lastField;
  if (!el || !el.isConnected) return toast('Click into a setting first, or drag the field onto it', 'err');
  const at = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? at;
  el.value = el.value.slice(0, at) + text + el.value.slice(end);
  el.focus();
  el.setSelectionRange(at + text.length, at + text.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The card on the canvas follows a setting as you type, without a redraw. */
function changed(node) {
  touch();
  const card = space?.querySelector(`.flow-node[data-id="${node.id}"]`);
  if (card) {
    card.querySelector('.node-sum').textContent = summary(node);
    card.querySelector('.node-head strong').textContent = title(node);
  }
}

/** Something that changes a node's shape (its ports, its kind of form): draw again. */
function reshape() {
  commit();
  renderCanvas();
  if (ndvId) renderNdvParams();
  else renderSettings();
}

/** A text control bound to one key of a node's settings. */
function bound(node, key, el, { number = false } = {}) {
  el.value = node.config[key] ?? '';
  const sync = () => {
    node.config[key] = number ? Number(el.value) || 0 : el.value;
    changed(node);
  };
  el.addEventListener('input', sync);
  el.addEventListener('change', () => {
    sync();
    if (el.tagName === 'SELECT') reshape();
  });
  return el;
}

function checkbox(label, checked, onchange) {
  const box = h('input', { type: 'checkbox', checked });
  box.onchange = () => onchange(box.checked);
  return h('label', { class: 'check-line' }, box, label);
}

/** A list of conditions: left side, comparison, right side. */
function conditionsEditor(node, key, { max = 5, label = 'Conditions', rules = false } = {}) {
  const list = node.config[key];
  const rows = list.map((c, i) => {
    const left = expr(h('input', { type: 'text', spellcheck: false, ariaLabel: `${rules ? `Rule ${i + 1}` : 'Condition'}: what to look at`, value: c.left ?? '{{ input }}' }));
    left.oninput = () => ((c.left = left.value), changed(node));
    const op = select('Comparison', OPS, c.op);
    op.onchange = () => {
      c.op = op.value;
      changed(node);
      reshape();
    };
    const right = expr(h('input', { type: 'text', spellcheck: false, ariaLabel: 'Compared with', value: c.value ?? '', placeholder: 'value' }));
    right.oninput = () => ((c.value = right.value), changed(node));
    return h(
      'div',
      { class: 'cond-row' },
      rules ? h('span', { class: 'cond-num' }, String(i + 1)) : null,
      left,
      op,
      UNARY.has(c.op) ? null : right,
      list.length > 1 ? h('button', { class: 'icon-btn', type: 'button', ariaLabel: 'Remove', title: 'Remove', onclick: () => {
        list.splice(i, 1);
        if (rules) draft.edges = draft.edges.filter((e) => !(e.from === node.id && e.port === String(i + 1))).map((e) => (e.from === node.id && /^\d+$/.test(e.port) && Number(e.port) > i + 1 ? { ...e, port: String(Number(e.port) - 1) } : e));
        touch();
        reshape();
      } }, '×') : null,
    );
  });
  const out = [h('div', { class: 'set-field' }, h('span', null, label), ...rows, list.length < max ? h('button', { class: 'btn sm', type: 'button', onclick: () => {
    list.push({ left: '{{ input }}', op: 'contains', value: '' });
    touch();
    reshape();
  } }, rules ? '+ rule' : '+ condition') : null)];
  if (!rules && list.length > 1) {
    const combine = select('Combine', [['and', 'all of them must hold'], ['or', 'any of them is enough']], node.config.combine);
    combine.onchange = () => ((node.config.combine = combine.value), changed(node));
    out.push(field('When', combine));
  }
  return out;
}

/** Key and value pairs (query parameters, headers, fields). */
function pairsEditor(node, key, { label, keyLabel = 'name', valueLabel = 'value', exprValues = true, hint = '' }) {
  node.config[key] ??= [];
  const list = node.config[key];
  return h(
    'div',
    { class: 'set-field' },
    h('span', null, label),
    ...list.map((p, i) => {
      const k = h('input', { type: 'text', spellcheck: false, ariaLabel: keyLabel, placeholder: keyLabel, value: p.key ?? '' });
      k.oninput = () => ((p.key = k.value), changed(node));
      const v = h('input', { type: 'text', spellcheck: false, ariaLabel: valueLabel, placeholder: valueLabel, value: p.value ?? '' });
      if (exprValues) expr(v);
      v.oninput = () => ((p.value = v.value), changed(node));
      return h('div', { class: 'pair-row' }, k, v, h('button', { class: 'icon-btn', type: 'button', ariaLabel: 'Remove', onclick: () => (list.splice(i, 1), touch(), reshape()) }, '×'));
    }),
    list.length < 20 ? h('button', { class: 'btn sm', type: 'button', onclick: () => (list.push({ key: '', value: '' }), touch(), reshape()) }, `+ ${keyLabel === 'field' ? 'field' : 'add'}`) : null,
    hint ? h('span', { class: 'muted' }, hint) : null,
  );
}

function triggerSettings(node) {
  const t = node.config;
  const kinds = [
    ['manual', 'Only when I press Run'],
    ['interval', 'Every so often'],
    ['daily', 'At a time of day'],
    ...catalog.pollers.map((p) => [`poll:${p.id}`, p.label]),
    ...(tools.length ? [['poll:app', 'An app answers something new']] : []),
    ['file', 'A file in the folder changes'],
    ...triggers.map((trig) => [`trigger:${trig.id}`, `When "${trig.name}" fires (${trig.label})`]),
    ['webhook-new', '+ a new webhook…'],
  ];
  const now = t.kind === 'schedule' ? t.schedule.kind : t.kind === 'trigger' ? `trigger:${t.id}` : t.kind === 'poll' ? `poll:${t.poller}` : t.kind;
  const kind = select('What starts the flow', kinds, now);
  kind.onchange = () => {
    const v = kind.value;
    if (v === 'webhook-new') {
      kind.value = now;
      return makeWebhook();
    }
    const poller = catalog.pollers.find((p) => `poll:${p.id}` === v);
    node.config =
      v === 'interval' ? { kind: 'schedule', schedule: { kind: 'interval', minutes: 60 } }
      : v === 'daily' ? { kind: 'schedule', schedule: { kind: 'daily', time: '09:00', days: [] } }
      : v.startsWith('trigger:') ? { kind: 'trigger', id: v.slice(8) }
      : v === 'poll:app' ? { kind: 'poll', poller: 'app', tool: '', args: '{}', every: 15 }
      : poller ? { kind: 'poll', poller: poller.id, every: poller.every, ...Object.fromEntries(poller.fields.map((f) => [f.id, ''])) }
      : v === 'file' ? { kind: 'file', path: '' }
      : { kind: 'manual' };
    touch();
    reshape();
  };
  const more = [];
  if (t.kind === 'schedule' && t.schedule.kind === 'interval') {
    const minutes = h('input', { type: 'text', inputMode: 'numeric', value: String(t.schedule.minutes), ariaLabel: 'Minutes between runs' });
    minutes.oninput = () => ((t.schedule.minutes = Number(minutes.value) || 0), changed(node));
    more.push(field('Minutes between runs', minutes, '5 at least'));
  } else if (t.kind === 'schedule') {
    const time = h('input', { type: 'time', value: t.schedule.time, ariaLabel: 'Time of day' });
    time.oninput = () => ((t.schedule.time = time.value), changed(node));
    more.push(field('Time of day', time));
    more.push(h('div', { class: 'set-field' }, h('span', null, 'On these days'), h('span', { class: 'checks' }, ...DAYS.map((name, day) => {
      const box = h('input', { type: 'checkbox', checked: t.schedule.days.includes(day) });
      box.onchange = () => {
        t.schedule.days = box.checked ? [...t.schedule.days, day].sort() : t.schedule.days.filter((d) => d !== day);
        changed(node);
      };
      return h('label', null, box, name);
    })), h('span', { class: 'muted' }, 'none ticked = every day')));
  } else if (t.kind === 'trigger') {
    const trig = triggers.find((x) => x.id === t.id);
    if (trig?.type === 'webhook') more.push(field('Address', h('input', { type: 'text', readOnly: true, value: `${location.origin}${trig.path}` }), 'POST JSON here with the token in an Authorization: Bearer header. Every field reaches the flow as {{ input.field }}.'));
    else more.push(h('p', { class: 'muted' }, 'What the trigger receives (title, text, url, chat...) reaches the flow as {{ input }}. While this flow is on, that trigger starts the flow instead of a plain task.'));
  } else if (t.kind === 'poll') {
    if (t.poller === 'app') {
      const action = select('Which app action', [['', 'choose…'], ...tools.map((x) => [x.name, x.name.replace('__', ': ')])], t.tool);
      action.onchange = () => ((t.tool = action.value), changed(node));
      const args = bound(node, 'args', h('textarea', { rows: 3, spellcheck: false, class: 'code-input', ariaLabel: 'Settings (JSON)' }));
      more.push(field('Ask', action), field('Settings (JSON)', args, 'Fixed: no {{ }} here.'));
    } else {
      const p = catalog.pollers.find((x) => x.id === t.poller);
      for (const f of p?.fields ?? []) more.push(field(f.label, bound(node, f.id, h('input', { type: 'text', spellcheck: false, placeholder: f.placeholder ?? '', ariaLabel: f.label }))));
      if (p?.auth || t.poller === 'watch') more.push(field('Credential', credPicker(node, p?.auth ? [p.auth] : ['bearer', 'header', 'query', 'basic'], { optional: true }), p?.auth ? 'Only for a private repository.' : 'Only if the address needs one.'));
    }
    const every = h('input', { type: 'text', inputMode: 'numeric', value: String(t.every ?? 10), ariaLabel: 'Check every (minutes)' });
    every.oninput = () => ((t.every = Number(every.value) || 0), changed(node));
    more.push(field('Check every (minutes)', every, 'At least 5. The first check only notes what is already there; each new item after that starts the flow once.'));
    const flow = saved();
    if (flow?.pollError) more.push(h('p', { class: 'err-text' }, `[!] Last check: ${flow.pollError}`));
  } else if (t.kind === 'file') {
    more.push(field('File or folder', bound(node, 'path', h('input', { type: 'text', spellcheck: false, placeholder: 'notes/  or  todo.md  or  *.md (empty = any)', ariaLabel: 'File or folder' })), 'Changes the crew or a flow makes while a flow runs do not count, so a flow cannot keep starting itself.'));
  }
  return [field('Starts', kind), ...more];
}

function serviceSettings(node) {
  const c = node.config;
  const s = serviceOf(c.service);
  if (!s) return [h('p', { class: 'err-text' }, `[!] This Kadhai does not know the service "${c.service}".`)];
  const service = select('Service', catalog.services.map((x) => [x.id, x.label]), c.service);
  service.onchange = () => {
    const next = serviceOf(service.value);
    node.config = serviceConfig(next, next.actions[0]);
    if (!node.name || node.name.startsWith(s.label)) node.name = uniqueName(next.label, node.id);
    touch();
    reshape();
  };
  const action = select('Action', s.actions.map((a) => [a.id, a.label]), c.action);
  action.onchange = () => {
    const a = s.actions.find((x) => x.id === action.value);
    const keepParams = c.params;
    node.config = { ...serviceConfig(s, a), credential: c.credential };
    for (const f of a.fields) if (keepParams[f.id]) node.config.params[f.id] = keepParams[f.id];
    touch();
    reshape();
  };
  const a = s.actions.find((x) => x.id === c.action) ?? s.actions[0];
  c.params ??= {};
  const fields = a.fields.map((f) => {
    const el = f.long ? h('textarea', { rows: 4, spellcheck: false, placeholder: f.placeholder ?? '', ariaLabel: f.label }) : h('input', { type: 'text', spellcheck: false, placeholder: f.placeholder ?? '', ariaLabel: f.label });
    el.value = c.params[f.id] ?? '';
    el.addEventListener('input', () => ((c.params[f.id] = el.value), changed(node)));
    if (!f.fixed) expr(el);
    return field(`${f.label}${f.optional ? '' : ' *'}`, el, f.fixed ? 'Fixed: text from the flow cannot choose this.' : null);
  });
  return [
    field('Service', service, s.about || null),
    field('Action', action),
    ...(s.auth ? [field('Credential', credPicker(node, [s.auth], { optional: s.authOptional && !a.needsAuth }), s.authOptional && !a.needsAuth ? 'Optional here.' : null)] : []),
    ...fields,
    ...(s.checked === 'live' ? [h('p', { class: 'muted' }, 'Checked against the real service with a wrong key; not yet tried from Kadhai with a real account.')] : []),
  ];
}

function httpSettings(node) {
  const c = node.config;
  c.query ??= [];
  c.headers ??= [];
  c.bodyType ??= c.method === 'GET' ? 'none' : 'json';
  const method = bound(node, 'method', select('Method', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => [m, m]), c.method));
  const url = bound(node, 'url', h('input', { type: 'text', spellcheck: false, placeholder: 'https://api.example.com/items', ariaLabel: 'Address' }));
  const hasBody = !['GET', 'DELETE'].includes(c.method);
  const bodyType = bound(node, 'bodyType', select('Body', [['json', 'JSON'], ['text', 'Text'], ['none', 'None']], c.bodyType));
  const body = expr(bound(node, 'body', h('textarea', { rows: 5, spellcheck: false, class: 'code-input', ariaLabel: 'Body', placeholder: '{"text": "{{ input }}"}' })));
  return [
    h('div', { class: 'row-buttons' }, h('button', { class: 'btn sm', type: 'button', onclick: () => importCurl(node) }, 'paste a curl command'), h('button', { class: 'btn sm', type: 'button', onclick: () => importOpenApi(node) }, 'import OpenAPI')),
    field('Method', method),
    field('Address', url, 'https (or this computer). Fixed: put text from the flow in the query or the body.'),
    pairsEditor(node, 'query', { label: 'Query parameters', keyLabel: 'name', hint: 'Values may quote the data: {{ input.id }}' }),
    pairsEditor(node, 'headers', { label: 'Headers', keyLabel: 'header', exprValues: false, hint: 'Fixed values. A key or token belongs in a credential.' }),
    field('Credential', credPicker(node, ['bearer', 'header', 'query', 'basic', 'github'], { optional: true })),
    ...(hasBody ? [field('Body', bodyType), ...(c.bodyType === 'none' ? [] : [field(c.bodyType === 'json' ? 'Body (JSON)' : 'Body (text)', body, '{{ input }} is what arrived on the wire.')])] : []),
  ];
}

function importCurl(node) {
  const area = h('textarea', { rows: 8, spellcheck: false, class: 'code-input', ariaLabel: 'curl command', placeholder: "curl -X POST https://api.example.com/items -H 'Authorization: Bearer …' -d '{\"name\": \"pen\"}'" });
  pop('paste a curl command', area, h('button', { class: 'btn primary', type: 'button', onclick: async () => {
    try {
      const parsed = parseCurl(area.value);
      let credential = node.config.credential ?? '';
      if (parsed.auth) {
        const made = await api.credentials.add({ ...parsed.auth, name: `${new URL(parsed.url).host}`.slice(0, 40) });
        await loadCredentials();
        credential = made.id;
        toast(`The key in that command was saved as the credential "${made.name}"`, 'ok');
      }
      Object.assign(node.config, { method: parsed.method, url: parsed.url, query: parsed.query, headers: parsed.headers, bodyType: parsed.bodyType, body: parsed.body, credential });
      closePop();
      touch();
      reshape();
    } catch (err) {
      fail(err);
    }
  } }, 'Use it'), h('p', { class: 'muted' }, 'An Authorization header, an API-key header or -u becomes an encrypted credential instead of sitting in the flow.'));
}

function importOpenApi(node) {
  const url = h('input', { type: 'text', spellcheck: false, placeholder: 'https://petstore3.swagger.io/api/v3/openapi.json', ariaLabel: 'Address of the OpenAPI file' });
  const text = h('textarea', { rows: 4, spellcheck: false, class: 'code-input', ariaLabel: 'Or paste the JSON', placeholder: 'or paste the JSON here' });
  const out = h('div', { class: 'openapi-list' });
  const load = async () => {
    out.replaceChildren(h('p', { class: 'muted' }, 'Reading…'));
    try {
      const spec = await api.flows.openapi(text.value.trim() ? { text: text.value } : { url: url.value });
      const filter = h('input', { type: 'search', class: 'flow-search', placeholder: `Filter ${spec.operations.length} operations of ${spec.title}`, ariaLabel: 'Filter operations' });
      const list = h('div', { class: 'op-list' });
      const draw = () =>
        list.replaceChildren(
          ...spec.operations
            .filter((op) => `${op.method} ${op.path} ${op.summary}`.toLowerCase().includes(filter.value.toLowerCase()))
            .slice(0, 100)
            .map((op) => h('button', { class: 'op-item', type: 'button', onclick: () => choose(spec, op) }, h('span', { class: `op-method m-${op.method.toLowerCase()}` }, op.method), h('span', null, op.path), h('span', { class: 'muted' }, op.summary))),
        );
      filter.oninput = draw;
      draw();
      out.replaceChildren(filter, list);
      filter.focus();
    } catch (err) {
      out.replaceChildren(h('p', { class: 'err-text' }, `[!] ${err.message}`));
    }
  };
  const choose = (spec, op) => {
    const pathParams = op.params.filter((p) => p.in === 'path');
    const inputs = pathParams.map((p) => [p, h('input', { type: 'text', spellcheck: false, ariaLabel: p.name, placeholder: p.name })]);
    const base = h('input', { type: 'text', spellcheck: false, value: spec.base || '', ariaLabel: 'Server address', placeholder: 'https://api.example.com' });
    pop(
      `${op.method} ${op.path}`,
      field('Server', base),
      ...inputs.map(([p, el]) => field(`${p.name} (in the address)`, el, 'Fixed: the address cannot take {{ }}.')),
      h('button', { class: 'btn primary', type: 'button', onclick: () => {
        let path = op.path;
        for (const [p, el] of inputs) path = path.replace(`{${p.name}}`, encodeURIComponent(el.value));
        try {
          const full = new URL(base.value.replace(/\/+$/, '') + path).href;
          Object.assign(node.config, {
            method: op.method,
            url: full,
            query: op.params.filter((p) => p.in === 'query').map((p) => ({ key: p.name, value: '' })),
            bodyType: op.body != null ? 'json' : ['GET', 'DELETE'].includes(op.method) ? 'none' : 'json',
            body: op.body != null ? JSON.stringify(op.body, null, 2) : '',
          });
          if (!node.name || node.name.startsWith('HTTP request')) node.name = uniqueName(op.summary || `${op.method} ${op.path}`, node.id);
          closePop();
          touch();
          reshape();
        } catch {
          toast('Give the full server address, starting https://', 'err');
        }
      } }, 'Use this request'),
    );
  };
  pop('import an OpenAPI description', field('Address of the JSON file', url), text, h('button', { class: 'btn primary', type: 'button', onclick: load }, 'Read it'), h('p', { class: 'muted' }, 'JSON only (YAML is not read). Each operation becomes a ready request: pick one.'), out);
}

/** The settings of one kind of node. */
function nodeForm(node) {
  const c = node.config;
  switch (node.type) {
    case 'trigger': return triggerSettings(node);
    case 'note': return [field('Text', bound(node, 'text', h('textarea', { rows: 6, maxLength: 2000, ariaLabel: 'Note text' }))), field('Colour', bound(node, 'color', select('Colour', [['', 'yellow'], ['a', 'green'], ['b', 'blue'], ['c', 'red']], c.color)))];
    case 'agent': {
      const plugged = draft.edges.filter((e) => e.port === 'tool' && e.to === node.id).map((e) => nodeOf(e.from)?.config.connection).filter(Boolean);
      const who = select('Who does it', [['', 'Whoever the Chef picks'], ...Object.values(state.agents).filter((a) => a.role === 'coder').map((a) => [a.id, `${face(a.id)} ${a.name}`])], c.agent);
      return [
        field('Task', expr(bound(node, 'text', h('textarea', { rows: 6, maxLength: 2000, ariaLabel: 'Task', placeholder: 'What the crew should do, as you would type it in the chat. {{ input }} is what arrived on the wire.' })))),
        field('Who does it', bound(node, 'agent', who)),
        h('div', { class: 'set-field' }, h('span', null, 'Its tools'), h('span', { class: 'muted' }, plugged.length ? `${plugged.join(', ')} - plugged in below it` : 'None. Drag an app\'s top port ("as tool") onto this node to let the agent use that app.')),
        h('p', { class: 'muted' }, 'A full run of the crew: planned, cooked and reviewed. For one quick answer, an AI node is cheaper.'),
      ];
    }
    case 'ai': {
      const who = select('Whose model', [['', 'Prep (light models first)'], ...Object.values(state.agents).map((a) => [a.id, `${a.name}'s models`])], c.agent);
      return [
        field('Ask', expr(bound(node, 'prompt', h('textarea', { rows: 7, maxLength: 4000, ariaLabel: 'What to ask the model' }))), 'One model call. {{ input }} is what arrived.'),
        field('Extra instructions (optional)', bound(node, 'system', h('textarea', { rows: 2, maxLength: 1000, ariaLabel: 'Extra instructions' }))),
        checkbox('Answer as JSON (so the next nodes can read its fields)', c.json, (v) => ((c.json = v), changed(node))),
        field('Model', bound(node, 'agent', who), 'Uses that agent\'s model choice and the usual failover.'),
      ];
    }
    case 'app': {
      const mine = tools.filter((tool) => tool.name.startsWith(`${c.connection}__`));
      const action = select('What it does', [['', 'No action - it is a tool for an agent'], ...mine.map((tool) => [tool.name, tool.name.slice(c.connection.length + 2)])], c.tool);
      if (c.tool && !mine.some((tool) => tool.name === c.tool)) action.append(h('option', { value: c.tool }, `${c.tool.slice(c.connection.length + 2)} (not connected now)`)), (action.value = c.tool);
      action.onchange = () => {
        const chosen = mine.find((tool) => tool.name === action.value);
        c.tool = action.value;
        if (chosen && (!c.args || c.args === '{}')) c.args = appConfig(c.connection, chosen).args;
        touch();
        reshape();
      };
      const chosen = mine.find((tool) => tool.name === c.tool);
      return [
        field('What it does', action, chosen?.description),
        c.tool ? field('Settings (JSON)', expr(bound(node, 'args', h('textarea', { rows: 6, spellcheck: false, class: 'code-input', ariaLabel: 'Settings (JSON)' }))), '{{ input }} is what arrived on the wire; {{ trigger }} what started the flow.') : h('p', { class: 'muted' }, 'With no action, this node does nothing on the line. Drag its top port ("as tool") onto an agent node and that agent may use it.'),
      ];
    }
    case 'service': return serviceSettings(node);
    case 'if': return [...conditionsEditor(node, 'conditions'), h('p', { class: 'muted' }, 'What arrived carries on unchanged down "true" or "false". Text comparisons ignore letter case.')];
    case 'filter': return [...conditionsEditor(node, 'conditions'), h('p', { class: 'muted' }, 'If the conditions do not hold, the flow stops here quietly (that is not a failure).')];
    case 'switch': return [...conditionsEditor(node, 'rules', { max: 6, label: 'Rules (the first that holds wins)', rules: true }), h('p', { class: 'muted' }, 'Each rule has a port of its own; when none holds, "else".')];
    case 'merge': return [field('Combine', bound(node, 'mode', select('Combine', [['append', 'into one list'], ['combine', 'fields into one object'], ['text', 'as one text']], c.mode))), ...(c.mode === 'text' ? [field('Between them', bound(node, 'separator', h('input', { type: 'text', ariaLabel: 'Separator', placeholder: '\\n\\n (a blank line)' })))] : []), h('p', { class: 'muted' }, 'It waits for every wire into it that is on the path taken.')];
    case 'wait': return [field('Seconds', bound(node, 'seconds', h('input', { type: 'text', inputMode: 'numeric', ariaLabel: 'Seconds' }), { number: true }), '1 to 3600. Stop ends a wait at once.')];
    case 'set': return [pairsEditor(node, 'fields', { label: 'Fields', keyLabel: 'field', valueLabel: 'value', hint: 'a.b makes { a: { b } }. A value that is one {{ }} keeps its type (a list stays a list).' }), checkbox('Keep the fields that arrived, and add these', c.keep, (v) => ((c.keep = v), changed(node)))];
    case 'code': return [field('JavaScript', bound(node, 'code', h('textarea', { rows: 12, spellcheck: false, class: 'code-input', ariaLabel: 'JavaScript' })), 'input, trigger and node(\'Name\') hold the data; return the output; console.log shows below the output. 5 s and 64 MB at most. It runs on this computer: write it yourself, do not paste code you do not trust.')];
    case 'http': return httpSettings(node);
    case 'flow': {
      const others = flows.filter((f) => f.id !== current);
      return [field('Run', bound(node, 'flow', select('Which flow', [['', 'choose a flow…'], ...others.map((f) => [f.id, f.name])], c.flow)), 'It starts with what arrived here as its input; its result carries on from this node. Up to 3 deep, never round in a circle.')];
    }
    case 'file': return [field('Do', bound(node, 'op', select('Do', [['read', 'read the file'], ['write', 'write the file (replace it)'], ['append', 'add to the end']], c.op))), field('File', bound(node, 'path', h('input', { type: 'text', spellcheck: false, ariaLabel: 'File', placeholder: 'notes/log.md' })), 'In the folder that is open. Fixed.'), ...(c.op === 'read' ? [] : [field('Content', expr(bound(node, 'content', h('textarea', { rows: 5, spellcheck: false, ariaLabel: 'Content' }))))])];
    case 'command': return [field('Command', bound(node, 'command', h('input', { type: 'text', spellcheck: false, ariaLabel: 'Command', placeholder: 'npm test' })), 'Fixed: nothing from the flow is put into it. Runs in the folder and waits for your OK in "ask" mode, like the crew\'s commands.'), checkbox('Fail if it exits with an error', c.failOnError !== false, (v) => ((c.failOnError = v), changed(node)))];
    default: return [];
  }
}

/** Name, switched off, retries, what to do on an error: what every node has. */
function commonForm(node) {
  if (node.type === 'note') return [];
  const out = [];
  if (node.type !== 'trigger') {
    const name = h('input', { type: 'text', maxLength: 40, ariaLabel: 'Name', placeholder: defaultTitle(node), value: node.name ?? '' });
    name.oninput = () => {
      node.name = name.value.replace(/['"{}]/g, '');
      changed(node);
    };
    out.push(field('Name', name, `Other nodes read its output as {{ node('${node.name || defaultTitle(node)}') }}`));
  }
  if (node.type !== 'trigger') {
    out.push(checkbox('Switched off (passes what arrives on unchanged)', Boolean(node.disabled), (v) => {
      node.disabled = v || undefined;
      touch();
      reshape();
    }));
    const retry = NO_RETRY.has(node.type) ? null : select('Retries', [['0', 'no retry'], ['1', 'retry once'], ['2', 'retry twice'], ['3', 'retry 3 times']], String(node.retries ?? 0));
    if (retry) {
      retry.onchange = () => {
        node.retries = Number(retry.value) || undefined;
        touch();
        reshape();
      };
      out.push(field('If it fails, try again', retry, '3 s apart.'));
    }
    const onError = select('On an error', [['stop', 'stop the flow'], ['continue', 'carry on with { error }']], node.onError ?? 'stop');
    onError.onchange = () => {
      node.onError = onError.value === 'continue' ? 'continue' : undefined;
      touch();
      reshape();
    };
    out.push(field('On an error', onError));
  }
  return out;
}

/** The wires leaving a node, and a way to add one without the mouse. */
function wireForm(node) {
  if (node.type === 'note') return [];
  const leaving = draft.edges.map((edge, index) => ({ edge, index })).filter(({ edge }) => edge.from === node.id);
  const ports = outPorts(node);
  const port = select('From which port', ports.map((p) => [p, p === 'out' ? 'then' : p === 'tool' ? 'as a tool of' : `on ${p}`]), ports[0]);
  const target = select('Wire to which node', [['', 'wire to…'], ...draft.nodes.filter((n) => n !== node && n.type !== 'trigger' && n.type !== 'note').map((n) => [n.id, `${title(n)} - ${summary(n).slice(0, 30)}`])], '');
  target.onchange = () => target.value && connect(node, port.value, nodeOf(target.value));
  return [h(
    'div',
    { class: 'set-field' },
    h('span', null, 'Wires from here'),
    ...leaving.map(({ edge, index }) => h('span', { class: 'wire-row' }, h('span', null, `${edge.port === 'out' ? '->' : edge.port === 'tool' ? 'tool of' : `${edge.port} ->`} ${title(nodeOf(edge.to))}`), h('button', { class: 'icon-btn', type: 'button', title: 'Remove this wire', ariaLabel: `Remove the wire to ${title(nodeOf(edge.to))}`, onclick: () => removeEdge(index) }, '×'))),
    h('span', { class: 'wire-add' }, ports.length > 1 ? port : null, target),
  )];
}

function flowForm() {
  const flow = saved();
  const parts = [];
  if (flow?.running) parts.push('Running now.');
  if (flow?.waiting) parts.push(`${plural(flow.waiting, 'start')} waiting.`);
  if (flow?.nextRunAt && flow.enabled) parts.push(`Next run: ${when(flow.nextRunAt)}.`);
  if (flow?.lastRun) parts.push(`Last run ${when(flow.lastRun.at)}: ${flow.lastRun.stopped ? 'stopped' : flow.lastRun.ok ? 'finished' : 'stopped at a node that failed'}.`);
  const description = h('textarea', { rows: 2, maxLength: 300, ariaLabel: 'What this flow is for', placeholder: 'What this flow is for (optional)' });
  description.value = draft.description ?? '';
  description.oninput = () => ((draft.description = description.value), touch());
  const tags = h('input', { type: 'text', ariaLabel: 'Tags', placeholder: 'daily, github', value: (draft.tags ?? []).join(', ') });
  tags.oninput = () => ((draft.tags = tags.value.split(',').map((t) => t.trim()).filter(Boolean)), touch());
  const onFail = select('If it fails, run', [['', 'nothing'], ...flows.filter((f) => f.id !== current).map((f) => [f.id, f.name])], draft.onFail ?? '');
  onFail.onchange = () => ((draft.onFail = onFail.value), touch(), commit());
  return [
    h('h4', { class: 'first' }, 'this flow'),
    h('p', { class: 'muted' }, parts.join(' ') || (flow ? 'Not run yet.' : 'Not saved yet.')),
    ...(!viewing && failureOf(flow?.lastRun) && !dirty ? [h('button', { class: 'btn sm primary', type: 'button', title: 'The Chef changes the flow so that the step that failed works', onclick: (e) => changeFlow('Fix it so that it runs without this error.', failureOf(flow.lastRun), e.currentTarget) }, 'Fix it')] : []),
    h('h4', null, 'in words'),
    explainBlock(draft),
    ...changeBox(),
    ...(flow?.pollError ? [h('p', { class: 'err-text' }, `[!] Its start could not check: ${flow.pollError}`)] : []),
    ...(flow?.lastRun?.result ? [h('pre', { class: 'flow-result' }, flow.lastRun.result)] : []),
    field('About', description),
    field('Tags', tags, 'Comma separated; find flows by #tag.'),
    field('If it fails, run', onFail, 'That flow gets { flow, node, error, at } - send yourself a message, say.'),
    h('h4', null, 'how to draw'),
    h('ul', { class: 'flow-help' },
      h('li', null, 'Drag a node in from the left, click it, or press Tab to search.'),
      h('li', null, 'Drag from a port on a node\'s right edge to another node to wire them - or onto empty canvas to add what comes next.'),
      h('li', null, 'Double-click a node (or Enter) for its input, settings and output side by side. Drag a field of the data into a setting.'),
      h('li', null, 'Shift+drag selects several; Ctrl+C / Ctrl+V copy them, Ctrl+D duplicates, D switches off, Delete removes, Ctrl+Z undoes.'),
      h('li', null, 'Ctrl+wheel zooms; drag the background to move around. Paste a curl command onto the canvas to make a request node.'),
    ),
    h('p', { class: 'muted flow-note' }, 'A flow runs only while Kadhai is open. Agent and AI nodes use your models\' quota; commands still wait for your OK. Everything else uses no model.'),
  ];
}

function lastRunBlock(node) {
  const ran = tested[node.id] ?? shownRun()?.nodes?.[node.id];
  if (!ran) return [];
  const text = typeof ran.output === 'string' ? ran.output : JSON.stringify(ran.output, null, 2);
  return [h('h4', null, `${tested[node.id] ? 'tested' : viewing?.source === 'try' ? 'tried once' : viewing ? 'that run' : 'last run'}: ${ran.held ? 'held back' : ran.status}${ran.port ? ` (${ran.port})` : ''}`), ...(ran.held ? [h('p', { class: 'muted' }, `${ran.note}. Nothing was done; below is what it would have done.`)] : []), h('pre', { class: 'flow-result' }, (text ?? '(nothing)').slice(0, 1500)), h('button', { class: 'btn sm', type: 'button', onclick: () => openNdv(node.id) }, 'Open its data')];
}

function renderSettings() {
  const panel = $('#flow-settings');
  if (!draft) return panel.replaceChildren(h('h4', { class: 'first' }, 'settings'), h('p', { class: 'muted' }, 'Open a flow on the left, or draw a new one. The settings of the node you pick appear here.'));
  if (ndvId) return panel.replaceChildren(h('p', { class: 'muted' }, 'Editing in the large view.'));

  if (pickedEdge != null && draft.edges[pickedEdge]) {
    const edge = draft.edges[pickedEdge];
    return panel.replaceChildren(
      h('h4', { class: 'first' }, 'wire'),
      h('p', null, `${title(nodeOf(edge.from))} ${edge.port === 'out' ? '->' : edge.port === 'tool' ? 'is a tool of' : `(${edge.port}) ->`} ${title(nodeOf(edge.to))}`),
      h('button', { class: 'btn sm danger', type: 'button', onclick: () => removeEdge(pickedEdge) }, 'Remove this wire'),
    );
  }
  if (selected.size > 1) {
    return panel.replaceChildren(
      h('h4', { class: 'first' }, `${selected.size} nodes selected`),
      h('div', { class: 'row-buttons' },
        h('button', { class: 'btn sm', type: 'button', onclick: duplicateSelection }, 'Duplicate'),
        h('button', { class: 'btn sm', type: 'button', onclick: toggleDisabled }, 'Switch on / off'),
        h('button', { class: 'btn sm danger', type: 'button', onclick: () => removeNodes(selected) }, 'Remove'),
      ),
      h('p', { class: 'muted' }, 'Drag any of them to move them together. Ctrl+C copies them (paste into another flow too).'),
    );
  }
  const node = selected.size === 1 ? nodeOf([...selected][0]) : null;
  if (!node) return panel.replaceChildren(...flowForm());
  panel.replaceChildren(
    h('div', { class: 'set-title' }, h('h4', { class: 'first' }, `${(KINDS[node.type]?.title ?? node.type).toLowerCase()} node`), node.type === 'note' ? null : h('button', { class: 'btn sm', type: 'button', onclick: () => openNdv(node.id) }, 'Open')),
    ...(node.check
      ? [h('div', { class: 'flow-check' }, h('span', null, node.check), h('button', { class: 'btn sm', type: 'button', title: 'Take the mark off this node', onclick: () => {
          delete node.check;
          touch();
          renderCanvas();
          renderSettings();
        } }, 'Done'))]
      : []),
    ...commonForm(node).slice(0, 1),
    ...nodeForm(node),
    ...commonForm(node).slice(1),
    ...wireForm(node),
    ...(node.type === 'trigger' ? [] : [h('button', { class: 'btn sm danger', type: 'button', onclick: () => removeNodes([node.id]) }, node.type === 'note' ? 'Remove this note' : 'Remove this node')]),
    ...lastRunBlock(node),
  );
}

// ------------------------------------------------------------- large view

/** What a node produced: tested just now, in the run on show, or pinned. */
function dataOf(id) {
  if (tested[id]?.status === 'ok') return tested[id].output;
  const rec = shownRun()?.nodes?.[id];
  if (rec?.status === 'ok') return rec.output;
  const node = nodeOf(id);
  return node?.pinned;
}
const combine = (list) => (list.length === 1 ? list[0] : list.every((v) => typeof v === 'string') ? list.join('\n\n') : list);

function inputSources(node) {
  const parents = draft.edges.filter((e) => e.to === node.id && e.port !== 'tool').map((e) => nodeOf(e.from)).filter(Boolean);
  const list = [];
  const arrived = shownRun()?.nodes?.[node.id]?.input;
  if (arrived !== undefined && !tested[parents[0]?.id]) list.push({ id: 'arrived', label: 'what arrived here', data: arrived, root: 'input' });
  for (const p of parents) {
    const data = dataOf(p.id);
    list.push({ id: p.id, label: title(p), data, root: parents.length === 1 ? 'input' : null, node: p });
  }
  const start = trigger();
  if (node.type !== 'trigger' && !parents.includes(start)) list.push({ id: start.id, label: 'the start', data: dataOf(start.id), root: 'trigger' });
  for (const other of draft.nodes) {
    if (other === node || other.type === 'note' || other.type === 'trigger' || parents.includes(other)) continue;
    const data = dataOf(other.id);
    if (data !== undefined) list.push({ id: other.id, label: title(other), data, root: null, node: other });
  }
  return list;
}

function inputFor(node) {
  const parents = draft.edges.filter((e) => e.to === node.id && e.port !== 'tool').map((e) => e.from);
  const datas = parents.map(dataOf).filter((d) => d !== undefined);
  if (datas.length) return combine(datas);
  return shownRun()?.nodes?.[node.id]?.input ?? '';
}

function openNdv(id) {
  const node = nodeOf(id);
  if (!node || node.type === 'note') return;
  commit();
  ndvId = id;
  ndvSource = null;
  selected = new Set([id]);
  refreshSelection();
  const box = $('#flow-ndv');
  box.hidden = false;
  box.replaceChildren(
    h('div', { class: 'ndv-head' }),
    h('div', { class: 'ndv-cols' }, h('section', { class: 'ndv-col ndv-in', ariaLabel: 'Input' }), h('section', { class: 'ndv-col ndv-params', ariaLabel: 'Settings' }), h('section', { class: 'ndv-col ndv-out', ariaLabel: 'Output' })),
  );
  renderNdv();
  renderSettings();
  box.querySelector('.ndv-params input, .ndv-params textarea, .ndv-params select')?.focus();
}

function closeNdv() {
  if (!ndvId) return;
  const id = ndvId;
  ndvId = null;
  lastField = null;
  $('#flow-ndv').hidden = true;
  $('#flow-ndv').replaceChildren();
  commit();
  renderCanvas();
  renderSettings();
  space?.querySelector(`[data-id="${id}"]`)?.focus();
}

function renderNdv() {
  if (!ndvId) return;
  const node = nodeOf(ndvId);
  if (!node) return closeNdv();
  const order = draft.nodes.filter((n) => n.type !== 'note').sort((a, b) => a.x - b.x || a.y - b.y);
  const at = order.indexOf(node);
  const go = (d) => order[at + d] && openNdv(order[at + d].id);
  $('#flow-ndv .ndv-head').replaceChildren(
    iconOf(node),
    h('strong', null, title(node)),
    title(node) === (KINDS[node.type]?.title ?? node.type) ? null : h('span', { class: 'muted' }, KINDS[node.type]?.title ?? node.type),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm primary', type: 'button', title: 'Run just this node on the input shown (Ctrl+Enter)', onclick: () => testStep(node) }, node.type === 'trigger' ? 'Fetch a sample' : 'Test step'),
    h('button', { class: 'btn sm', type: 'button', disabled: at <= 0, title: 'The node before', ariaLabel: 'Previous node', onclick: () => go(-1) }, '<'),
    h('button', { class: 'btn sm', type: 'button', disabled: at >= order.length - 1, title: 'The node after', ariaLabel: 'Next node', onclick: () => go(1) }, '>'),
    h('button', { class: 'icon-btn', type: 'button', ariaLabel: 'Back to the canvas', title: 'Back to the canvas (Esc)', onclick: closeNdv }, '×'),
  );
  renderNdvIn();
  renderNdvParams();
  renderNdvOut();
}

function modeSwitch(which, redraw) {
  return h('span', { class: 'mode-switch', role: 'group', ariaLabel: 'Show as' }, ...['tree', 'table', 'text'].map((m) => h('button', { class: `mode-btn${ndvMode[which] === m ? ' on' : ''}`, type: 'button', ariaPressed: String(ndvMode[which] === m), onclick: () => ((ndvMode[which] = m), redraw()) }, m)));
}

function renderNdvIn() {
  const node = nodeOf(ndvId);
  const col = $('#flow-ndv .ndv-in');
  if (!col) return;
  if (node.type === 'trigger') return col.replaceChildren(h('div', { class: 'ndv-col-head' }, h('strong', null, 'input')), h('p', { class: 'muted' }, 'The start has no input: it is where the data comes from. Fetch a sample to see what it delivers.'));
  const sources = inputSources(node);
  const chosen = sources.find((s) => s.id === ndvSource) ?? sources.find((s) => s.data !== undefined) ?? sources[0];
  const pick = select('Data from', sources.map((s) => [s.id, `${s.label}${s.data === undefined ? ' (no data yet)' : ''}`]), chosen?.id ?? '');
  pick.onchange = () => ((ndvSource = pick.value), renderNdvIn());
  const root = !chosen ? 'input' : chosen.root ?? nodeRef(chosen.node);
  const parents = draft.edges.filter((e) => e.to === node.id && e.port !== 'tool').map((e) => nodeOf(e.from));
  col.replaceChildren(
    h('div', { class: 'ndv-col-head' }, h('strong', null, 'input'), modeSwitch('in', renderNdvIn)),
    ...(sources.length ? [pick] : []),
    chosen?.data !== undefined
      ? h('div', { class: 'ndv-data' }, dataView(chosen.data, { root, mode: ndvMode.in, onPick: putExpression }))
      : h('div', { class: 'ndv-empty' }, h('p', { class: 'muted' }, parents.length ? 'No data here yet. Run the flow, or test the step before this one.' : 'Nothing is wired into this node yet.'), ...(parents.length === 1 ? [h('button', { class: 'btn sm', type: 'button', onclick: () => testStep(parents[0], { then: node }) }, `Test "${title(parents[0])}"`)] : [])),
    h('p', { class: 'muted ndv-tip' }, 'Drag a field into a setting, or click it to put it where you last clicked.'),
  );
}

function renderNdvParams() {
  const node = nodeOf(ndvId);
  const col = $('#flow-ndv .ndv-params');
  if (!col || !node) return;
  col.replaceChildren(h('div', { class: 'ndv-col-head' }, h('strong', null, 'settings')), ...commonForm(node).slice(0, 1), ...nodeForm(node), ...commonForm(node).slice(1), ...wireForm(node));
}

function renderNdvOut() {
  const node = nodeOf(ndvId);
  const col = $('#flow-ndv .ndv-out');
  if (!col || !node) return;
  const result = tested[node.id] ?? shownRun()?.nodes?.[node.id];
  const pinned = node.pinned !== undefined;
  const parts = [h('div', { class: 'ndv-col-head' }, h('strong', null, 'output'), modeSwitch('out', renderNdvOut))];
  if (pinned) {
    parts.push(h('div', { class: 'pin-note' }, h('span', null, 'Pinned: this data stands in for the node when you run the flow by hand (scheduled and triggered runs do the real thing).'), h('button', { class: 'btn sm', type: 'button', onclick: () => editPin(node) }, 'edit'), h('button', { class: 'btn sm', type: 'button', onclick: () => {
      delete node.pinned;
      touch();
      commit();
      renderNdvOut();
      renderCanvas();
    } }, 'unpin')));
  }
  if (result) {
    const meta = [result.status === 'failed' ? '[!] failed' : result.status, result.port ? `-> ${result.port}` : '', result.items != null ? plural(result.items, 'item') : '', result.ms != null ? `${result.ms} ms` : '', tested[node.id] ? '(tested)' : viewing ? '(that run)' : '(last run)'].filter(Boolean).join('  ');
    parts.push(h('p', { class: `ndv-meta${result.status === 'failed' ? ' err-text' : ''}` }, meta));
    if (result.note) parts.push(h('p', { class: 'muted' }, result.note));
  }
  const data = result?.status === 'ok' ? result.output : result?.status === 'failed' ? undefined : node.pinned;
  if (result?.status === 'failed') parts.push(h('pre', { class: 'dv-text err-text' }, String(result.output ?? '')));
  else parts.push(h('div', { class: 'ndv-data' }, dataView(data, { root: nodeRef(node), mode: ndvMode.out, onPick: putExpression })));
  if (result?.logs?.length) parts.push(h('h4', null, 'console'), h('pre', { class: 'dv-text' }, result.logs.join('\n')));
  if (result?.status === 'ok' && node.type !== 'trigger') {
    const clipped = result.output && typeof result.output === 'object' && '[clipped]' in result.output;
    parts.push(h('div', { class: 'row-buttons' }, h('button', { class: 'btn sm', type: 'button', disabled: clipped, title: clipped ? 'Too large to pin' : 'Use this output instead of running the node, when you run by hand', onclick: () => {
      node.pinned = result.output;
      touch();
      commit();
      renderNdvOut();
      renderCanvas();
    } }, pinned ? 'pin this instead' : 'pin this output')));
  } else if (!pinned && node.type !== 'trigger') {
    parts.push(h('div', { class: 'row-buttons' }, h('button', { class: 'btn sm', type: 'button', onclick: () => editPin(node) }, 'pin data by hand')));
  }
  if (!result && !pinned) parts.push(h('p', { class: 'muted' }, node.type === 'trigger' ? 'Press "Fetch a sample" to see what the start delivers.' : 'Press "Test step" to run just this node on the input shown.'));
  col.replaceChildren(...parts);
}

function editPin(node) {
  const area = h('textarea', { rows: 12, spellcheck: false, class: 'code-input', ariaLabel: 'Pinned data (JSON)' });
  area.value = node.pinned === undefined ? '{\n  "text": "example"\n}' : typeof node.pinned === 'string' ? JSON.stringify(node.pinned) : JSON.stringify(node.pinned, null, 2);
  pop('pinned data', area, h('button', { class: 'btn primary', type: 'button', onclick: () => {
    try {
      node.pinned = JSON.parse(area.value);
    } catch {
      return toast('That is not JSON (text goes in quotes)', 'err');
    }
    closePop();
    touch();
    commit();
    renderNdvOut();
    renderCanvas();
  } }, 'Pin it'), h('p', { class: 'muted' }, 'JSON. When you run the flow by hand this stands in for the node, so you can build what comes after without calling the service (or a model) every time.'));
}

async function testStep(node, { then = null } = {}) {
  if ((MODEL_KINDS.has(node.type) || ['command', 'flow'].includes(node.type)) && !confirm(`Testing "${title(node)}" does the real thing${MODEL_KINDS.has(node.type) ? ' (a model call)' : node.type === 'command' ? ' (runs the command, after your OK)' : ' (runs that flow)'}. Go on?`)) return;
  commit();
  const nodes = {};
  for (const n of draft.nodes) {
    const d = dataOf(n.id);
    if (d === undefined) continue;
    nodes[n.id] = d;
    if (n.name) nodes[n.name] = d;
  }
  const head = $('#flow-ndv .ndv-head .btn.primary');
  if (head) (head.disabled = true), (head.textContent = 'testing…');
  try {
    const res = await api.flows.test({ flow: draft, node: node.id, input: inputFor(node), trigger: dataOf(trigger().id) ?? '', nodes });
    tested[node.id] = res.ok ? { status: 'ok', output: res.output, port: res.port, ms: res.ms, logs: res.logs, note: res.note ?? (res.stopped ? 'stopped here: the conditions did not hold' : ''), items: Array.isArray(res.output) ? res.output.length : 1 } : { status: 'failed', output: res.error, ms: res.ms };
  } catch (err) {
    tested[node.id] = { status: 'failed', output: err.message };
  }
  if (then) {
    renderNdvIn();
  } else if (ndvId) renderNdv();
  renderSettings();
}

// ------------------------------------------------------------ selection ops

function selectionData() {
  const nodes = draft.nodes.filter((n) => selected.has(n.id) && n.type !== 'trigger');
  const ids = new Set(nodes.map((n) => n.id));
  return { kadhai: 'nodes', nodes: structuredClone(nodes), edges: draft.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
}

function pasteNodes(data, offset = 40) {
  const map = new Map();
  const added = [];
  for (const n of data.nodes ?? []) {
    if (!n || !KINDS[n.type] || n.type === 'trigger') continue;
    const id = newId();
    map.set(n.id, id);
    const copy = { ...structuredClone(n), id, x: (n.x ?? 0) + offset, y: (n.y ?? 0) + offset };
    if (copy.name) copy.name = uniqueName(copy.name);
    if (copy.type === 'service' && copy.config?.credential && !creds.some((c) => c.id === copy.config.credential)) copy.config.credential = '';
    draft.nodes.push(copy);
    added.push(id);
  }
  for (const e of data.edges ?? []) if (map.has(e.from) && map.has(e.to)) draft.edges.push({ from: map.get(e.from), to: map.get(e.to), port: e.port });
  if (!added.length) return;
  selected = new Set(added);
  touch();
  commit();
  renderCanvas();
  renderSettings();
}

function duplicateSelection() {
  if (!selected.size) return;
  pasteNodes(selectionData());
}

function toggleDisabled() {
  const list = draft.nodes.filter((n) => selected.has(n.id) && n.type !== 'trigger' && n.type !== 'note');
  if (!list.length) return;
  const off = !list.every((n) => n.disabled);
  for (const n of list) n.disabled = off || undefined;
  touch();
  commit();
  renderCanvas();
  renderSettings();
}

/** Shift+drag on the background: a box that selects every node it touches. */
function startBox(e) {
  const a = toSpace(e.clientX, e.clientY);
  const box = h('div', { class: 'select-box' });
  space.append(box);
  const move = (ev) => {
    const b = toSpace(ev.clientX, ev.clientY);
    Object.assign(box.style, { left: `${Math.min(a.x, b.x)}px`, top: `${Math.min(a.y, b.y)}px`, width: `${Math.abs(b.x - a.x)}px`, height: `${Math.abs(b.y - a.y)}px` });
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    box.remove();
    const b = toSpace(ev.clientX, ev.clientY);
    const r = { x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) };
    for (const n of draft.nodes) if (n.x < r.x2 && n.x + (n.w ?? 200) > r.x1 && n.y < r.y2 && n.y + (n.h ?? 80) > r.y1) selected.add(n.id);
    pickedEdge = null;
    refreshSelection();
    renderSettings();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// ------------------------------------------------------------------ bar

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportFlow() {
  const data = { kadhai: 'flow', version: 2, ...structuredClone(draft) };
  data.onFail = '';
  for (const n of data.nodes) if (n.config?.credential) n.config.credential = '';
  download(`${(draft.name || 'flow').replace(/[^\w-]+/g, '-').toLowerCase()}.flow.json`, JSON.stringify(data, null, 2));
  toast('Exported. Credentials are not in the file: choose them again after importing.', 'ok');
}

function importFlow() {
  const input = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  input.onchange = async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.nodes)) throw new Error('That file is not a Kadhai flow');
      openDraft({ name: data.name ?? 'Imported flow', description: data.description ?? '', tags: data.tags ?? [], onFail: '', nodes: data.nodes, edges: data.edges ?? [] });
      toast('Imported - check it over, then Create', 'ok');
    } catch (err) {
      fail(err);
    }
  };
  document.body.append(input);
  input.click();
}

/** Run the drawing on the canvas once, with nothing sent or written (see Flows.tryOnce), and show it like a run. */
async function tryOnce() {
  const button = $('#flow-bar .flow-try');
  const thinking = draft.nodes.filter((n) => n.type === 'ai' && !n.disabled).length;
  if (button) {
    button.disabled = true;
    button.textContent = 'Trying…';
  }
  try {
    const record = await api.flows.try(draft);
    tested = {};
    viewRun(record);
    toast(record.ok ? `Tried once${thinking ? ` (${plural(thinking, 'model call')})` : ''}: nothing was sent` : 'Tried once: it stopped at a node that failed', record.ok ? 'ok' : 'err');
  } catch (err) {
    fail(err);
  } finally {
    renderBar();
  }
}

/**
 * The flow in words, worked out from the drawing (no model): when it starts, then each step in the
 * order it runs, with where it comes from when that is not simply the step before.
 */
function explain(d) {
  const nodes = d.nodes.filter((n) => n.type !== 'note');
  const main = d.edges.filter((e) => e.port !== 'tool');
  const toolOf = new Set(d.edges.filter((e) => e.port === 'tool').map((e) => e.from));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const start = nodes.find((n) => n.type === 'trigger');
  if (!start) return [];
  // The order the server runs them in: after everything wired into it, ties top to bottom, left to right.
  const waiting = new Map(nodes.map((n) => [n.id, main.filter((e) => e.to === n.id).length]));
  const ready = nodes.filter((n) => waiting.get(n.id) === 0);
  const order = [];
  while (ready.length) {
    ready.sort((a, b) => a.y - b.y || a.x - b.x);
    const n = ready.shift();
    order.push(n);
    for (const e of main.filter((x) => x.from === n.id)) {
      waiting.set(e.to, waiting.get(e.to) - 1);
      if (waiting.get(e.to) === 0) ready.push(byId.get(e.to));
    }
  }
  const lines = [`Starts ${summary(start)}.`];
  const step = new Map([[start.id, 0]]);
  let previous = start.id;
  const from = (e) => {
    const src = byId.get(e.from);
    const name = src.type === 'trigger' ? 'the start' : String(step.get(src.id) ?? '?');
    if (e.port === 'true' || e.port === 'false') return `${name} is ${e.port}`;
    if (e.port === 'else') return `${name} matches no rule`;
    if (e.port !== 'out') return `${name} matches rule ${e.port}`;
    return name;
  };
  let models = 0;
  let crews = 0;
  for (const n of order) {
    if (n.type === 'trigger' || (toolOf.has(n.id) && !main.some((e) => e.from === n.id || e.to === n.id))) continue;
    step.set(n.id, step.size);
    const into = main.filter((e) => e.to === n.id);
    const simple = into.length === 1 && into[0].port === 'out' && into[0].from === previous;
    const where = !into.length ? ' (nothing is wired into it: it never runs)' : simple ? '' : ` - after ${into.map(from).join(' and ')}`;
    const tools = d.edges.filter((e) => e.port === 'tool' && e.to === n.id).map((e) => title(byId.get(e.from)));
    const off = n.disabled ? ' [switched off]' : '';
    lines.push(`${step.get(n.id)}. ${title(n)}: ${summary(n)}${tools.length ? ` (using ${tools.join(', ')})` : ''}${where}${off}`);
    if (n.type === 'ai' && !n.disabled) models++;
    if (n.type === 'agent' && !n.disabled) crews++;
    previous = n.id;
  }
  if (lines.length === 1) lines.push('Nothing happens after that yet.');
  if (models || crews) lines.push(`Each run uses the model ${[models ? plural(models, 'time') : '', crews ? `${models ? 'plus ' : ''}${plural(crews, 'crew task')} (several calls each)` : ''].filter(Boolean).join(' ')}.`);
  return lines;
}

const explainBlock = (d) => h('div', { class: 'flow-explain' }, ...explain(d).map((line) => h('p', null, line)));

/** "Change it": say what should be different, and the Chef changes the drawing. */
function changeBox() {
  const area = h('textarea', { rows: 2, maxLength: 1500, ariaLabel: 'What to change in this flow', placeholder: 'also email it to me / make it 9am on weekdays / skip it when it rains' });
  const go = h('button', { class: 'btn sm', type: 'button' }, 'Change it');
  const run = () => {
    const text = area.value.trim();
    if (text.length < 3) return area.focus();
    changeFlow(text, null, go);
  };
  go.onclick = run;
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run();
  });
  return [field('Change it in words', area, 'The Chef changes the drawing; you check it before saving. Ctrl+Enter.'), go];
}

/** What went wrong in the run on show, for "Fix it": the node that failed, its error and what it received. */
function failureOf(record) {
  const id = record?.failedAt;
  const rec = id ? record.nodes?.[id] : null;
  if (!rec) return null;
  const node = nodeOf(id);
  const text = (v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));
  return { node: node ? title(node) : id, error: text(rec.output), input: text(rec.input).slice(0, 1200) };
}

/**
 * "Change it" / "Fix it": the Chef changes the drawing on the canvas. The result replaces it as one
 * step of undo (Ctrl+Z puts it back), unsaved, with what the Chef added or changed marked.
 */
async function changeFlow(text, failure = null, button = null) {
  if (!draft) return;
  commit();
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = failure ? 'Fixing…' : 'Changing…';
  }
  try {
    const out = await api.flows.draft(text, { base: draft, failure, id: saved()?.id });
    draft = { ...draft, nodes: out.flow.nodes, edges: out.flow.edges };
    dirty = true;
    viewing = null;
    tested = {};
    selected = new Set();
    commit();
    renderAll();
    const list = [...out.notes, ...out.todo];
    pop(
      failure ? 'the Chef fixed this' : 'the Chef changed this',
      h('p', null, out.changes),
      ...(list.length ? [h('ul', { class: 'flow-todo' }, ...list.map((t) => h('li', null, t)))] : []),
      h('p', null, 'In words, now:'),
      explainBlock(draft),
      h('p', { class: 'muted' }, 'Not saved yet. What it touched is marked [!] check. Try once to see it work, Save to keep it, or Ctrl+Z to put it back as it was.'),
      h('button', { class: 'btn primary', type: 'button', onclick: closePop }, 'Look it over'),
    );
  } catch (err) {
    fail(err);
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

/** "Describe a flow": the Chef draws it from plain words; it opens unsaved, with what to check marked. */
function describeFlow() {
  if (dirty && !confirm('Leave this flow without saving your changes?')) return;
  const area = h('textarea', { rows: 5, maxLength: 1500, ariaLabel: 'What the flow should do', placeholder: 'Every morning at 8, get the weather for Hyderabad and the dollar to rupee rate, write me a short note and send it to my phone.' });
  const go = h('button', { class: 'btn primary', type: 'button' }, 'Draw it');
  const status = h('p', { class: 'muted' }, 'The Chef draws it in one go. Nothing is saved or run: you look it over first, choose the credentials, then Create.');
  const draw = async () => {
    const text = area.value.trim();
    if (text.length < 8) return toast('Say in a sentence or two what the flow should do', 'err');
    go.disabled = true;
    area.disabled = true;
    go.textContent = 'The Chef is drawing…';
    try {
      const out = await api.flows.draft(text);
      dirty = false;
      openDraft(out.flow);
      // The whole drawing in view, even when that means smaller text: it is all new to the user.
      requestAnimationFrame(() => requestAnimationFrame(() => fitView()));
      const list = [...out.notes, ...out.todo];
      pop(
        'the Chef drew this',
        h('p', null, 'In words:'),
        explainBlock(draft),
        h('p', null, list.length ? 'Before you press Create:' : 'Look it over, then press Create.'),
        ...(list.length ? [h('ul', { class: 'flow-todo' }, ...list.map((t) => h('li', null, t)))] : []),
        h('p', { class: 'muted' }, 'Nodes marked [!] check need a look. Click one to see why; press Done there when it is right. Try once runs it without sending anything.'),
        h('button', { class: 'btn primary', type: 'button', onclick: closePop }, 'Look it over'),
      );
    } catch (err) {
      go.disabled = false;
      area.disabled = false;
      go.textContent = 'Draw it';
      fail(err);
    }
  };
  go.onclick = draw;
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) draw();
  });
  pop('describe a flow', field('What should happen?', area, 'When it starts, what it fetches or watches, what to do with it, where the result goes. Ctrl+Enter draws it.'), go, status);
}

async function saveFlow() {
  commit();
  const flow = saved();
  try {
    const out = flow ? await api.flows.save(flow.id, draft) : await api.flows.create(draft);
    dirty = false;
    current = out.id;
    await refresh();
    toast('Flow saved', 'ok');
  } catch (err) {
    fail(err);
  }
}

function renderBarState() {
  const save = $('#flow-bar .flow-save');
  if (save) save.textContent = `${saved() ? 'Save' : 'Create'}${dirty ? ' *' : ''}`;
}

function renderBar() {
  const bar = $('#flow-bar');
  if (!draft) return bar.replaceChildren();
  const flow = saved();
  const act = (fn, done) => async () => {
    try {
      await fn();
      if (done) toast(done, 'ok');
    } catch (err) {
      fail(err);
    }
  };
  const name = h('input', { type: 'text', value: draft.name, placeholder: 'Name this flow', ariaLabel: 'Flow name', maxLength: 50, class: 'flow-name' });
  name.oninput = () => ((draft.name = name.value), touch());
  const more = select('More', [['', 'more…'], ...(flow ? [['duplicate', 'Duplicate']] : []), ['export', 'Export to a file'], ['import', 'Import from a file'], ['credentials', 'Credentials…'], ...(flow ? [['delete', 'Delete this flow']] : [])], '');
  more.onchange = async () => {
    const v = more.value;
    more.value = '';
    if (v === 'duplicate') act(async () => {
      const out = await api.flows.create({ ...draft, name: `${draft.name} copy`.slice(0, 50) });
      current = out.id;
      dirty = false;
      await refresh();
      open(out.id);
    }, 'Duplicated')();
    if (v === 'export') exportFlow();
    if (v === 'import') importFlow();
    if (v === 'credentials') credentialsManager();
    if (v === 'delete' && confirm(`Delete the flow "${flow.name}"?`)) act(async () => {
      await api.flows.remove(flow.id);
      current = null;
      draft = null;
      dirty = false;
      await refresh();
      renderAll();
    }, 'Flow deleted')();
  };
  bar.replaceChildren(
    name,
    h('button', { class: 'btn sm primary flow-save', type: 'button', title: 'Save (Ctrl+S)', onclick: saveFlow }, `${flow ? 'Save' : 'Create'}${dirty ? ' *' : ''}`),
    h('button', { class: 'btn sm flow-try', type: 'button', title: 'Run it once as drawn, without sending, writing or running anything: reading and AI steps run for real, the rest show what they would do', onclick: tryOnce }, 'Try once'),
    ...(flow
      ? [
          flow.running
            ? h('button', { class: 'btn sm danger', type: 'button', title: 'Stop after the node it is on', onclick: act(() => api.flows.stop(flow.id), 'Stopping') }, 'Stop')
            : h('button', { class: 'btn sm', type: 'button', title: 'Run the saved flow once, now (pinned data stands in for its nodes)', onclick: act(async () => {
                if (dirty && !confirm('Run the saved version? Your unsaved changes are not in it yet.')) return;
                viewing = null;
                renderBanner();
                await api.flows.run(flow.id, true);
              }) }, 'Run now'),
          h('button', { class: `btn sm${flow.enabled ? '' : ' danger'}`, type: 'button', title: flow.enabled ? 'On: its start may start it' : 'Off: only Run now starts it', onclick: act(() => api.flows.enable(flow.id, !flow.enabled)) }, flow.enabled ? 'On' : 'Off'),
        ]
      : []),
    more,
  );
}

function renderAll() {
  renderSideTabs();
  renderList();
  renderPalette();
  renderBar();
  renderBanner();
  renderCanvas();
  renderSettings();
  if (ndvId) renderNdv();
  if (side === 'runs') renderRuns();
}

/** Older nodes have no name; give them one quietly so other nodes can quote them. */
function nameAll() {
  for (const n of draft.nodes) if (!n.name && n.type !== 'trigger' && n.type !== 'note') n.name = uniqueName(defaultTitle(n), n.id);
}

function startEditing() {
  nameAll();
  past = [];
  future = [];
  committed = snapshot();
  tested = {};
  viewing = null;
  selected = new Set();
  pickedEdge = null;
  if (ndvId) closeNdv();
}

function open(id) {
  if (dirty && id !== current && !confirm('Leave this flow without saving your changes?')) return;
  current = id;
  dirty = false;
  draft = id === 'new' ? blank() : copy(flows.find((f) => f.id === id));
  startEditing();
  if (side === 'runs' && id === 'new') side = 'flows';
  renderAll();
  if (side === 'runs') loadRuns();
  requestAnimationFrame(() => id !== 'new' && fitView(true));
}

function openDraft(flow) {
  if (dirty && !confirm('Leave this flow without saving your changes?')) return;
  current = 'new';
  draft = { description: '', tags: [], onFail: '', ...structuredClone(flow) };
  startEditing();
  dirty = true;
  side = 'flows';
  renderAll();
  requestAnimationFrame(() => fitView(true));
}

async function loadCredentials() {
  try {
    ({ credentials: creds } = await api.credentials.list());
  } catch {
    creds = [];
  }
}

let refreshing = null;
async function refresh() {
  try {
    [{ flows }, { triggers }, connections, tools] = await Promise.all([api.flows.list(), api.triggers.list(), api.connections(), api.tools()]);
  } catch (err) {
    return fail(err);
  }
  if (current && current !== 'new' && !flows.some((f) => f.id === current)) {
    current = null;
    draft = null;
  }
  renderList();
  if (!$('#flows-dialog').open) return;
  // Mid-edit, the drawing is the user's: only the run marks around it are refreshed.
  if (current && current !== 'new' && !dirty) {
    draft = copy(flows.find((f) => f.id === current));
    nameAll();
    committed = snapshot();
  }
  const busy = $('#flow-settings').contains(document.activeElement) || $('#flow-bar').contains(document.activeElement) || $('#flow-ndv').contains(document.activeElement) || $('#flow-pop').contains(document.activeElement) || $('#flow-palette').contains(document.activeElement);
  renderSideTabs();
  if (!busy) renderPalette();
  renderCanvas();
  if (!busy) {
    renderBar();
    renderSettings();
  } else renderBarState();
  if (ndvId) {
    renderNdvIn();
    renderNdvOut();
  }
  if (side === 'runs') {
    clearTimeout(refreshing);
    refreshing = setTimeout(loadRuns, 300);
  }
}

// ------------------------------------------------------------------ init

function onKey(e) {
  const dialog = $('#flows-dialog');
  if (!dialog.open || !draft) return;
  const mod = e.ctrlKey || e.metaKey;
  if (!$('#flow-pop').hidden) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePop();
    }
    return;
  }
  if (!$('#flow-creator').hidden) return;
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    return saveFlow();
  }
  if (ndvId) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeNdv();
    } else if (mod && e.key === 'Enter') {
      e.preventDefault();
      testStep(nodeOf(ndvId));
    }
    return;
  }
  if (e.key === 'Escape') {
    // A modal dialog closes on Escape; on the canvas it lets go of the selection first.
    if (selected.size || pickedEdge != null) {
      e.preventDefault();
      selected = new Set();
      pickedEdge = null;
      refreshSelection();
      renderSettings();
    }
    return;
  }
  if (typing()) return;
  const key = e.key.toLowerCase();
  if (mod && key === 'z' && !e.shiftKey) return e.preventDefault(), undo();
  if ((mod && key === 'z' && e.shiftKey) || (mod && key === 'y')) return e.preventDefault(), redo();
  if (mod && key === 'a') {
    e.preventDefault();
    selected = new Set(draft.nodes.map((n) => n.id));
    refreshSelection();
    return renderSettings();
  }
  if (mod && key === 'd') return e.preventDefault(), duplicateSelection();
  if (mod) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (pickedEdge != null) return e.preventDefault(), removeEdge(pickedEdge);
    if (selected.size) return e.preventDefault(), removeNodes(selected);
  }
  if (e.key === 'Tab') return e.preventDefault(), openCreator({});
  if (key === 'd' && selected.size) return toggleDisabled();
  if (e.key === 'Enter' && selected.size === 1) return openNdv([...selected][0]);
  if (e.key === '+' || e.key === '=') return setZoom(zoom * 1.2);
  if (e.key === '-') return setZoom(zoom / 1.2);
  if (e.key === '0') return setZoom(1);
  if (e.key === '1') return fitView();
  if (e.key.startsWith('Arrow') && selected.size) {
    e.preventDefault();
    const step = e.shiftKey ? 50 : 10;
    const [dx, dy] = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    for (const n of draft.nodes) if (selected.has(n.id)) Object.assign(n, { x: Math.max(0, n.x + dx), y: Math.max(0, n.y + dy) });
    touch();
    renderCanvas();
  }
}

export function initFlows() {
  const dialog = $('#flows-dialog');
  const canvas = $('#flow-canvas');
  $('#flows-btn').onclick = async () => {
    dialog.showModal();
    try {
      [catalog] = await Promise.all([api.flows.catalog(), loadCredentials()]);
    } catch (err) {
      fail(err);
    }
    await refresh();
    renderAll();
  };
  $('#flows-close').onclick = () => {
    if (dirty && !confirm('Close without saving your changes to this flow?')) return;
    dialog.close();
  };
  // Escape closes a modal dialog on its own; with unsaved changes, or with the large view open, it should not.
  dialog.addEventListener('cancel', (e) => {
    if (ndvId || !$('#flow-pop').hidden || !$('#flow-creator').hidden || selected.size || pickedEdge != null || (dirty && !confirm('Close without saving your changes to this flow?'))) e.preventDefault();
  });

  // A node dragged in from the palette lands where it is dropped.
  canvas.addEventListener('dragover', (e) => {
    if (draft && [...e.dataTransfer.types].includes('application/x-kadhai-node')) e.preventDefault();
  });
  canvas.addEventListener('drop', (e) => {
    const data = e.dataTransfer.getData('application/x-kadhai-node');
    if (!data || !draft) return;
    e.preventDefault();
    const { type, config } = JSON.parse(data);
    const at = toSpace(e.clientX, e.clientY);
    addNode(type, config, { x: at.x - 100, y: at.y - 20 });
  });
  // Dragging the background moves the view (Shift: draws a selection box); a plain click lets go of the selection.
  canvas.addEventListener('pointerdown', (e) => {
    if (!space || (e.target !== space && e.target !== canvas && e.target !== wires && e.target !== sizer)) return;
    closeCreator();
    if (e.shiftKey) return startBox(e);
    const start = { x: e.clientX, y: e.clientY, left: canvas.scrollLeft, top: canvas.scrollTop };
    let moved = false;
    const move = (ev) => {
      moved = moved || Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 3;
      canvas.scrollLeft = start.left - (ev.clientX - start.x);
      canvas.scrollTop = start.top - (ev.clientY - start.y);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved && (selected.size || pickedEdge != null)) {
        selected = new Set();
        pickedEdge = null;
        refreshSelection();
        renderSettings();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  canvas.addEventListener('wheel', (e) => {
    if (!space || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX, e.clientY);
  }, { passive: false });
  canvas.addEventListener('scroll', renderMinimap);
  canvas.addEventListener('dblclick', (e) => {
    if (space && (e.target === space || e.target === sizer || e.target === canvas)) openCreator({ x: e.clientX, y: e.clientY });
  });

  // The overview: click or drag in it to move the view there.
  const map = $('#flow-minimap');
  map.addEventListener('pointerdown', (e) => {
    const go = (ev) => {
      const r = map.getBoundingClientRect();
      const scale = Number(map.dataset.scale) || 1;
      canvas.scrollLeft = ((ev.clientX - r.left) / scale) * zoom - canvas.clientWidth / 2;
      canvas.scrollTop = ((ev.clientY - r.top) / scale) * zoom - canvas.clientHeight / 2;
    };
    go(e);
    const up = () => {
      window.removeEventListener('pointermove', go);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', go);
    window.addEventListener('pointerup', up);
  });

  document.addEventListener('keydown', onKey);
  // Copy, cut and paste go through the system clipboard, so nodes travel between flows (and windows).
  document.addEventListener('copy', (e) => {
    if (!dialog.open || !draft || typing() || ndvId || !selected.size) return;
    clipboard = selectionData();
    e.clipboardData.setData('text/plain', JSON.stringify(clipboard));
    e.preventDefault();
    toast(`Copied ${plural(clipboard.nodes.length, 'node')}`, 'ok');
  });
  document.addEventListener('cut', (e) => {
    if (!dialog.open || !draft || typing() || ndvId || !selected.size) return;
    clipboard = selectionData();
    e.clipboardData.setData('text/plain', JSON.stringify(clipboard));
    e.preventDefault();
    removeNodes(selected);
  });
  document.addEventListener('paste', (e) => {
    if (!dialog.open || !draft || typing() || ndvId) return;
    const text = e.clipboardData.getData('text/plain').trim();
    if (/^curl(\.exe)?\s/i.test(text)) {
      e.preventDefault();
      try {
        const parsed = parseCurl(text);
        const node = addNode('http', { ...KINDS.http.defaults(), ...parsed, auth: undefined });
        if (parsed.auth) {
          api.credentials.add({ ...parsed.auth, name: new URL(parsed.url).host.slice(0, 40) }).then(async (made) => {
            await loadCredentials();
            node.config.credential = made.id;
            touch();
            renderSettings();
            toast(`The key in that command was saved as the credential "${made.name}"`, 'ok');
          }, fail);
        }
      } catch (err) {
        fail(err);
      }
      return;
    }
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (data && (data.kadhai === 'nodes' || data.kadhai === 'flow') && Array.isArray(data.nodes)) {
      e.preventDefault();
      pasteNodes(data, data === clipboard ? 40 : 60);
    }
  });

  on('flows', refresh);
  on('triggers', refresh);
  on('mcp', refresh);
  on('sync', refresh);
}
