import { $, h, toast } from './util.js';
import { state, on, emit } from './store.js';
import { api } from './api.js';
import { logo } from './logos.js';
import { triggerPanel } from './triggers.js';

/**
 * Connections: everything the crew can reach outside the workspace.
 *
 * One searchable grid of well-known services (the catalog, served by the
 * backend). Each card connects with one click, a sign-in, or a pasted key.
 * Underneath they are all MCP tool servers, except Google, which is built in.
 * A custom MCP server can still be added by hand, and the last section shows
 * how other apps connect to Kadhai.
 */
let google = null; // last Google status from the server
let catalog = { categories: [], entries: [] };
let category = 'All';
let query = '';
let openId = null; // the one card that is expanded
let panel = { key: '', node: null }; // its contents, kept across refreshes so typing is not lost
const watching = new Set(); // connections started here: say so when they come up or fail
let before = new Map(); // id -> status at the last render

const TAG = {
  local: 'Runs on this computer',
  open: 'No account needed',
  key: 'API key needed',
  signin: 'Sign in needed',
  account: 'Sign in needed',
  custom: 'Added by you',
};
const STATE = { ready: 'Connected', connecting: 'Starting…', error: 'Did not connect', off: 'Switched off', signin: 'Sign-in not finished' };

const fail = (err) => toast(err.message, 'err');
const act = (fn, done) => async () => {
  try {
    await fn();
    if (done) toast(done, 'ok');
  } catch (err) {
    fail(err);
  }
};
const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);

function copyButton(text, label = 'Copy') {
  const button = h('button', { class: 'btn sm', type: 'button' }, label);
  button.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
      setTimeout(() => (button.textContent = label), 1500);
    } catch {
      toast('Could not copy — select the text and copy it by hand', 'err');
    }
  };
  return button;
}

const serverOf = (id) => state.mcp.find((s) => s.name === id) ?? null;

function statusOf(entry) {
  if (entry.id === 'google') return google?.connected ? 'ready' : google?.needsReconnect ? 'error' : null;
  return serverOf(entry.id)?.status ?? null;
}

/** Catalog entries, plus a card for every server that was added by hand. */
function allEntries() {
  const known = new Set(catalog.entries.map((e) => e.id));
  const custom = state.mcp
    .filter((s) => !known.has(s.name))
    .map((s) => ({ id: s.name, name: s.name, icon: 'MCP', category: 'Custom', type: 'custom', blurb: s.command, fields: [] }));
  return [...custom, ...catalog.entries];
}

async function connect(entry, values) {
  watching.add(entry.id);
  try {
    await api.connect(entry.id, values);
    openId = null;
    if (entry.type === 'signin') toast(`A browser tab is opening — sign in to ${entry.name} there`);
  } catch (err) {
    watching.delete(entry.id);
    fail(err);
  }
}

const remove = (entry) => () =>
  confirm(`Disconnect ${entry.name}?`) &&
  act(async () => {
    await api.mcp.remove(entry.id);
    if (openId === entry.id) openId = null;
    render();
  }, `${entry.name} disconnected`)();

// ------------------------------------------------------------------ Google

function googleSteps(status) {
  return h(
    'details',
    { class: 'connector-steps', open: !status.configured },
    h('summary', null, 'One-time setup: get your own Google sign-in keys (free, about 10 minutes)'),
    h(
      'ol',
      null,
      h('li', null, 'Open ', link('https://console.cloud.google.com/projectcreate', 'Google Cloud Console ↗'), ' and create a project (any name).'),
      h('li', null, 'In ', h('b', null, 'APIs & Services → Library'), ', enable the API for each thing you want: ', status.available.map((s) => s.api).join(', '), '.'),
      h('li', null, 'In ', h('b', null, 'OAuth consent screen'), ', choose External, give it a name, and add your own Google address under Test users.'),
      h('li', null, 'In ', h('b', null, 'Credentials → Create credentials → OAuth client ID'), ', pick ', h('b', null, 'Web application'), ' and add this under Authorized redirect URIs: ', h('code', null, status.redirectUri), ' ', copyButton(status.redirectUri)),
      h('li', null, 'Copy the Client ID and Client secret it shows you into the boxes below.'),
    ),
    h('p', { class: 'muted connector-note' }, 'Why your own keys: Kadhai has no servers and no account system, so there is no shared "Kadhai app" at Google to sign in through. While your project is in "Testing", Google ends the sign-in after 7 days and you connect again.'),
  );
}

function googlePanel(status) {
  if (!status) return [h('p', { class: 'muted' }, 'Loading…')];
  if (status.connected) {
    const names = status.available.filter((s) => status.services.includes(s.id)).map((s) => s.label);
    return [
      h('p', { class: 'connector-note' }, `Connected${status.email ? ` as ${status.email}` : ''}. The cooks can look things up in: ${names.join(', ')}. Read-only — they cannot send mail, edit documents or change your calendar.`),
      h('p', { class: 'muted connector-note' }, 'Anything a cook reads is sent to the AI provider in use, like any other text in a task.'),
      accessPanel('google'),
      h(
        'div',
        { class: 'dialog-actions' },
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn sm', onclick: act(() => api.connectors.googleDisconnect(false), 'Google disconnected') }, 'Disconnect'),
        h('button', { class: 'btn sm danger', onclick: () => confirm('Disconnect Google and forget the client ID and secret too?') && act(() => api.connectors.googleDisconnect(true), 'Google removed')() }, 'Remove keys too'),
      ),
    ];
  }

  const clientId = h('input', { type: 'text', ariaLabel: 'Google client ID', placeholder: status.configured ? `Client ID saved (${status.clientId}) — leave blank to keep it` : 'Client ID (ends in .apps.googleusercontent.com)' });
  const secret = h('input', { type: 'password', ariaLabel: 'Google client secret', placeholder: status.configured ? 'Client secret saved — leave blank to keep it' : 'Client secret', autocomplete: 'off' });
  clientId.spellcheck = false;
  const picked = new Set(status.services.length ? status.services : ['drive']);
  const boxes = status.available.map((s) => {
    const box = h('input', { type: 'checkbox', checked: picked.has(s.id) });
    box.onchange = () => (box.checked ? picked.add(s.id) : picked.delete(s.id));
    return h('label', null, box, s.label);
  });

  return [
    status.needsReconnect ? h('p', { class: 'mcp-error' }, 'The sign-in expired — connect again.') : null,
    googleSteps(status),
    h(
      'form',
      {
        class: 'connector-form',
        onsubmit: async (e) => {
          e.preventDefault();
          // Open the tab now, while this is still a click: browsers block pop-ups opened later.
          const tab = window.open('about:blank', '_blank');
          try {
            const { authUrl } = await api.connectors.googleSetup({ clientId: clientId.value, clientSecret: secret.value, services: [...picked] });
            if (tab) tab.location = authUrl;
            else window.location.assign(authUrl);
            panel = { key: '', node: null }; // saved: do not leave the secret on screen
            toast('Finish signing in on the Google tab that just opened');
            loadConnectors();
          } catch (err) {
            tab?.close();
            fail(err);
          }
        },
      },
      clientId,
      secret,
      h('div', { class: 'checks' }, h('span', { class: 'muted' }, 'Let the crew read:'), ...boxes),
      h('div', { class: 'dialog-actions' }, h('span', { class: 'muted mcp-warn' }, 'Read-only access. Your keys and sign-in are stored on this computer only.'), h('span', { class: 'spacer' }), h('button', { class: 'btn sm primary' }, status.needsReconnect ? 'Connect again' : 'Connect Google')),
    ),
  ];
}

// ------------------------------------------------------- who may use it

const cooks = () => Object.values(state.agents).filter((agent) => agent.role === 'coder');
const nameOf = (id) => state.agents[id]?.name ?? id;

/** "only Fixer", or '' when every cook may use the connection. */
function keptFor(id) {
  const only = state.access[id];
  return only ? `only ${only.map(nameOf).join(', ') || 'nobody'}` : '';
}

/** Every cook (the default), or a chosen few. Saved as soon as a box changes. */
function accessPanel(id) {
  const only = state.access[id] ?? null;
  const everyone = h('input', { type: 'checkbox', checked: !only });
  const boxes = cooks().map((agent) => {
    const box = h('input', { type: 'checkbox', checked: !only || only.includes(agent.id), disabled: !only });
    box.dataset.agent = agent.id;
    return box;
  });
  const save = act(() => api.restrict(id, everyone.checked ? null : boxes.filter((box) => box.checked).map((box) => box.dataset.agent)));
  everyone.onchange = save;
  for (const box of boxes) box.onchange = save;
  return h(
    'div',
    { class: 'conn-access' },
    h('span', { class: 'muted' }, 'Who may use it:'),
    h('div', { class: 'checks' }, h('label', null, everyone, 'Every cook'), ...boxes.map((box) => h('label', null, box, nameOf(box.dataset.agent)))),
  );
}

// ------------------------------------------------------------------- cards

/** The form a connector needs before it can start: a key, a file, a folder. */
function fieldsPanel(entry, again = false) {
  const inputs = entry.fields.map((field) => {
    const input = h('input', { type: field.secret ? 'password' : 'text', placeholder: field.placeholder || field.label, ariaLabel: field.label, autocomplete: 'off', required: true });
    input.spellcheck = false;
    input.dataset.field = field.id;
    return h('label', { class: 'conn-field' }, h('span', null, field.label, field.help ? [' · ', link(field.help, 'where to get it ↗')] : null), input);
  });
  const button = h('button', { class: 'btn sm primary' }, again ? 'Connect again' : 'Connect');
  return h(
    'form',
    {
      class: 'connector-form',
      onsubmit: async (e) => {
        e.preventDefault();
        button.disabled = true;
        const values = Object.fromEntries([...e.target.querySelectorAll('input[data-field]')].map((el) => [el.dataset.field, el.value]));
        await connect(entry, values);
        button.disabled = false;
      },
    },
    ...inputs,
    h('div', { class: 'dialog-actions' }, h('span', { class: 'muted mcp-warn' }, 'Stored on this computer only, in mcp.config.json.'), h('span', { class: 'spacer' }), button),
  );
}

function toolList(server) {
  if (!server.tools.length) return null;
  const short = (name) => name.slice(server.name.length + 2);
  return h(
    'details',
    { class: 'mcp-tools' },
    h('summary', null, `${server.tools.length} thing${server.tools.length === 1 ? '' : 's'} the crew can do with it`),
    ...server.tools.map((tool) => h('div', { class: 'mcp-tool' }, h('code', null, short(tool.name)), h('span', { class: 'muted' }, tool.description))),
  );
}

/** What an expanded card shows, for the state its connection is in. */
function panelFor(entry, status) {
  if (entry.id === 'google') return googlePanel(google);
  const server = serverOf(entry.id);
  if (!server) return [fieldsPanel(entry)];

  const retry = entry.fields.length ? null : h('button', { class: 'btn sm', onclick: act(() => (watching.add(entry.id), api.mcp.restart(entry.id))) }, 'Try again');
  return [
    entry.type === 'custom' ? h('code', { class: 'mcp-command' }, server.command) : null,
    status === 'error' ? h('p', { class: 'mcp-error' }, server.error) : null,
    // Not started on its own any more (that opened a browser tab on every start): it waits for you.
    status === 'signin' ? h('p', { class: 'muted connector-note' }, `The sign-in to ${entry.name} was not finished, so Kadhai no longer starts it by itself - that would open a browser tab every time. Press Sign in when you are ready.`) : null,
    status === 'error' && entry.checked === 'live' ? h('p', { class: 'muted connector-note' }, `The address of ${entry.name}'s connector was checked, but its sign-in has not been tried from Kadhai yet. Some services only allow sign-in from apps they have approved.`) : null,
    status === 'error' && entry.fields.length ? fieldsPanel(entry, true) : null,
    status === 'ready' ? toolList(server) : null,
    accessPanel(entry.id),
    h(
      'div',
      { class: 'dialog-actions' },
      h('span', { class: 'spacer' }),
      status === 'error' ? retry : null,
      status === 'signin' ? h('button', { class: 'btn sm primary', onclick: act(() => (watching.add(entry.id), api.mcp.restart(entry.id))) }, 'Sign in') : null,
      status === 'ready' ? h('button', { class: 'btn sm', onclick: act(() => api.mcp.enable(entry.id, false)) }, 'Turn off') : null,
      status === 'off' ? h('button', { class: 'btn sm primary', onclick: act(() => (watching.add(entry.id), api.mcp.enable(entry.id, true))) }, 'Turn on') : null,
      h('button', { class: 'btn sm danger', onclick: remove(entry) }, 'Disconnect'),
    ),
  ];
}

function card(entry) {
  const status = statusOf(entry);
  const server = serverOf(entry.id);
  const open = openId === entry.id;
  const toggle = () => {
    openId = open ? null : entry.id;
    render();
  };
  // Nothing to ask for? Then "Connect" just connects.
  const direct = !status && entry.id !== 'google' && !entry.fields.length;

  let action;
  if (status === 'connecting') action = h('button', { class: 'btn sm', onclick: act(() => api.mcp.remove(entry.id)) }, 'Cancel');
  else if (status) action = h('button', { class: 'btn sm', onclick: toggle }, open ? 'Close' : 'Manage');
  else if (direct) action = h('button', { class: 'btn sm', onclick: (e) => ((e.target.disabled = true), connect(entry)) }, 'Connect');
  else action = h('button', { class: 'btn sm', onclick: toggle }, open ? 'Close' : 'Connect');

  let note = TAG[entry.type];
  if (status === 'connecting') note = entry.type === 'signin' ? 'Waiting for you to sign in in the browser…' : 'Starting… the first time it is downloaded';
  else if (status === 'ready') note = entry.id === 'google' ? `Connected${google.email ? ` as ${google.email}` : ''}` : `Connected · ${server.tools.length} tool${server.tools.length === 1 ? '' : 's'}`;
  else if (status) note = STATE[status];
  if (status === 'ready' && keptFor(entry.id)) note += ` · ${keptFor(entry.id)}`;

  let more = null;
  if (open && status !== 'connecting') {
    const key = `${entry.id}:${status}:${server?.tools.length ?? ''}:${entry.id === 'google' ? `${google?.configured}` : ''}:${JSON.stringify(state.access[entry.id] ?? null)}:${cooks().length}`;
    if (panel.key !== key || !panel.node) panel = { key, node: h('div', { class: 'conn-more' }, ...panelFor(entry, status)) };
    more = panel.node;
  }

  return h(
    'article',
    { class: `conn-card${open ? ' open' : ''}`, dataset: { status: status ?? 'none' } },
    logo(entry.id, entry.icon),
    h('div', { class: 'conn-text' }, h('strong', null, entry.name), h('p', { title: entry.blurb }, entry.blurb), h('span', { class: 'conn-tag' }, status ? h('span', { class: `dot${status === 'ready' ? ' on' : status === 'connecting' ? ' wait' : ''}` }) : null, note)),
    action,
    status === 'connecting' && server?.signInUrl ? h('p', { class: 'conn-signin' }, 'No tab opened? ', link(server.signInUrl, 'Open the sign-in page ↗')) : null,
    more,
  );
}

// ------------------------------------------------- custom servers, other apps

let customForm = null;

function addForm() {
  const name = h('input', { type: 'text', placeholder: 'Name, e.g. my-tools', ariaLabel: 'Server name', maxLength: 40 });
  const command = h('input', { type: 'text', placeholder: 'Command that starts it, e.g. npx -y some-mcp-server', ariaLabel: 'Command that starts the server' });
  const env = h('textarea', { rows: 2, placeholder: 'Optional settings, one per line:  API_TOKEN=abc123', ariaLabel: 'Settings for the server, one NAME=value per line' });
  for (const el of [name, command, env]) el.spellcheck = false;
  const who = h('select', { class: 'select', ariaLabel: 'Who may use it' });
  const fillWho = () => {
    const chosen = who.value;
    who.replaceChildren(h('option', { value: '' }, 'For every cook'), ...cooks().map((agent) => h('option', { value: agent.id }, `Only for ${agent.name}`)));
    who.value = state.agents[chosen] ? chosen : '';
  };
  fillWho();
  const button = h('button', { class: 'btn sm primary' }, 'Add and start');

  return Object.assign(h(
    'form',
    {
      class: 'mcp-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const settings = Object.fromEntries(
          env.value
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.includes('='))
            .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]),
        );
        button.disabled = true;
        button.textContent = 'Starting… (a first run may download it)';
        try {
          // Reserved before it starts, so there is no moment when every cook can reach it.
          const reserved = who.value ? name.value.trim() : '';
          if (reserved) await api.restrict(reserved, [who.value]);
          let server;
          try {
            server = await api.mcp.add({ name: name.value, command: command.value, env: settings });
          } catch (err) {
            if (reserved) await api.restrict(reserved, null).catch(() => {});
            throw err;
          }
          if (server.status === 'ready') toast(`${server.name} is connected with ${server.tools.length} tool(s)`, 'ok');
          else toast(`${server.name} was saved but did not start: ${server.error}`, 'err');
          customForm = null;
        } catch (err) {
          fail(err);
          button.disabled = false;
          button.textContent = 'Add and start';
        }
        render();
      },
    },
    h('p', { class: 'muted' }, 'Not in the list? Any MCP server that is started with a command can be added. Remote ones work through the bridge: ', h('code', null, 'npx -y mcp-remote https://…/mcp')),
    h('div', { class: 'mcp-row' }, name, command),
    env,
    who,
    h('div', { class: 'dialog-actions' }, h('span', { class: 'muted mcp-warn' }, 'A tool server is a program that runs on this computer with your permissions. Only add ones you trust.'), h('span', { class: 'spacer' }), button),
  ), { fillWho });
}

function outward() {
  const url = `${location.origin}/mcp`;
  const root = String(state.app.root ?? '').replace(/\\/g, '/');
  const snippet = JSON.stringify({ mcpServers: { kadhai: { command: 'node', args: [`${root}/bin/mcp-server.js`] } } }, null, 2);
  return [
    h('p', { class: 'muted' }, 'Kadhai is an MCP server too: Claude Desktop, Claude Code, Cursor and other MCP apps can hand tasks to this crew and read or write files in the folder that is open.'),
    h('div', { class: 'mcp-out' }, h('span', { class: 'muted' }, 'While Kadhai is running (tasks show up live here):'), h('div', { class: 'mcp-copy' }, h('code', null, url), copyButton(url))),
    h('div', { class: 'mcp-out' }, h('span', { class: 'muted' }, 'Or let the app start its own copy — add this to its MCP settings:'), h('div', { class: 'mcp-copy' }, h('pre', null, snippet), copyButton(snippet))),
  ];
}

const foldOpen = { custom: false, triggers: false, outward: false };
const fold = (id, title, ...children) =>
  h('details', { class: 'more-providers', open: foldOpen[id], ontoggle: (e) => (foldOpen[id] = e.target.open) }, h('summary', null, title), ...children);

// ------------------------------------------------------------------ render

function matches(entry) {
  if (category !== 'All' && entry.category !== category) return false;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${entry.name} ${entry.blurb} ${entry.category} ${entry.id}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

function renderChips() {
  $('#conn-chips').replaceChildren(
    ...['All', ...catalog.categories].map((name) =>
      h(
        'button',
        {
          class: `chip${category === name ? ' on' : ''}`,
          type: 'button',
          onclick: () => {
            category = name;
            renderChips();
            render();
          },
        },
        name,
      ),
    ),
  );
}

/** Tell the user how a connection they started turned out, even if the dialog is closed. */
function announce(entries) {
  const now = new Map(entries.map((entry) => [entry.id, statusOf(entry)]));
  for (const entry of entries) {
    const status = now.get(entry.id);
    if (!watching.has(entry.id) || status === before.get(entry.id) || status === 'connecting') continue;
    if (status === 'ready') toast(`${entry.name} is connected`, 'ok');
    else if (status === 'error') toast(`${entry.name} did not connect: ${serverOf(entry.id)?.error ?? 'unknown reason'}`, 'err');
    else if (status === 'signin') toast(`${entry.name}: the sign-in was not finished. Press Sign in on its card to try again.`, 'err');
    if (status !== null) watching.delete(entry.id);
  }
  before = now;
}

function render() {
  const entries = allEntries();
  announce(entries);

  const active = entries.filter((entry) => statusOf(entry));
  const connected = active.filter((entry) => statusOf(entry) === 'ready').length;
  const badge = $('#mcp-count');
  badge.hidden = !connected;
  badge.textContent = String(connected);
  if (!$('#mcp-dialog').open) return;

  const body = $('#mcp-body');
  const scroll = body.scrollTop;
  const focused = document.activeElement;
  const shown = entries.filter(matches);
  const mine = shown.filter((entry) => statusOf(entry));
  const rest = shown.filter((entry) => !statusOf(entry));
  const browsing = category === 'All' && !query.trim();
  customForm ??= addForm();
  customForm.fillWho();

  const groups = browsing
    ? catalog.categories.map((name) => [name, rest.filter((entry) => entry.category === name)]).filter(([, list]) => list.length)
    : rest.length
      ? [[mine.length ? 'More' : '', rest]]
      : [];

  body.replaceChildren(
    ...(mine.length ? [h('h4', { class: 'first' }, 'Yours'), h('div', { class: 'conn-grid' }, ...mine.map(card))] : []),
    ...(browsing && !mine.length ? [h('p', { class: 'muted conn-intro' }, 'Connect a service and the crew can use it while they cook: read a GitHub issue, look up current docs, search the web, query a database. The Chef decides which sub-task needs which connection.')] : []),
    ...groups.flatMap(([name, list], i) => [name ? h('h4', { class: !mine.length && i === 0 && !browsing ? 'first' : '' }, name) : null, h('div', { class: 'conn-grid' }, ...list.map(card))]),
    ...(shown.length ? [] : [h('p', { class: 'muted conn-empty' }, catalog.entries.length ? `Nothing here matches “${query.trim()}”. If it has an MCP server, add it by hand below.` : 'Loading…')]),
    fold('custom', 'Add a custom MCP server', customForm),
    fold('triggers', 'Start tasks from outside: a webhook, GitHub, Linear, Telegram', ...triggerPanel()),
    fold('outward', 'Use Kadhai from other apps', ...outward()),
  );
  body.scrollTop = scroll;
  // Re-inserting a kept form drops the cursor: put it back.
  if (focused && focused !== document.activeElement && body.contains(focused)) focused.focus();
}

async function loadConnectors() {
  try {
    google = (await api.connectors.status()).google;
  } catch {
    google = null;
  }
  render();
}

async function loadCatalog() {
  if (catalog.entries.length) return;
  try {
    catalog = await api.catalog();
    renderChips();
    render();
  } catch (err) {
    fail(err);
  }
}

export function initMcp() {
  const dialog = $('#mcp-dialog');
  const search = $('#conn-search');
  $('#mcp-btn').onclick = () => {
    dialog.showModal();
    emit('connectionsopen');
    render();
    loadCatalog();
    loadConnectors();
    search.focus();
  };
  search.oninput = () => {
    query = search.value;
    render();
  };
  // Signing in to Google happens in another tab; this tab hears about it and refreshes.
  on('connectors', loadConnectors);
  $('#mcp-close').onclick = () => dialog.close();
  dialog.addEventListener('click', (e) => e.target === dialog && dialog.close());
  on('sync', () => {
    loadCatalog();
    loadConnectors();
  });
  on('mcp', render);
}
