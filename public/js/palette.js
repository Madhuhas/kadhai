import { $, h, toast } from './util.js';
import { state, on, emit } from './store.js';
import { api } from './api.js';

/**
 * Quick open and the command palette, one box as in VS Code:
 *   Ctrl+P            a file by name (fuzzy: "fjs" finds files.js); "name:12" opens it at line 12
 *   Ctrl+Shift+P, F1  ">" - a command: anything the taskbar, menus and editor can do
 *   Ctrl+G            ":" - a line in the open file
 * Commands press the same buttons a click would, so they never do anything a click cannot.
 */

const SHOWN = 60;
let paths = null; // every file's path, fetched when the box opens and dropped when files change
let items = [];
let at = 0;
const recent = []; // files opened from here, newest first

const click = (id) => () => $(`#${id}`)?.click();
const THEMES = () => [...($('#theme-select')?.options ?? [])].map((o) => ({ id: o.value, name: o.textContent }));

/** Every command, built when the box opens so it lists what is there now (agents, themes). */
function commands() {
  const list = [
    { label: 'Go to file...', keys: 'Ctrl+P', run: () => open('') },
    { label: 'Go to line...', keys: 'Ctrl+G', run: () => open(':') },
    { label: 'File: Save', keys: 'Ctrl+S', run: () => emit('savefile') },
    { label: 'File: Close', run: () => emit('closefile') },
    { label: 'File: New file', run: () => emit('newfile') },
    { label: 'File: Find in this file', keys: 'Ctrl+F', run: () => emit('findinfile', false) },
    { label: 'File: Replace in this file', keys: 'Ctrl+H', run: () => emit('findinfile', true) },
    { label: 'Search: Search in all files', keys: 'Ctrl+Shift+F', run: () => emit('sideview', 'search') },
    { label: 'Problems: Show the folder\'s problems', run: () => emit('sideview', 'problems') },
    { label: 'View: Files', run: () => emit('sideview', 'files') },
    { label: 'View: Kitchen', run: () => emit('kitchentab') },
    { label: 'View: Terminal', keys: 'Ctrl+`', run: click('term-btn') },
    { label: 'View: Browser', run: click('browser-btn') },
    { label: 'View: Flows', run: click('flows-btn') },
    { label: 'View: Connections', run: click('mcp-btn') },
    { label: 'View: Keys and models', run: click('keys-btn') },
    { label: 'View: Providers', run: click('route-pill') },
    { label: 'View: About', run: click('about-btn') },
    { label: 'Layout: Lock or unlock the windows', run: click('layout-btn') },
    { label: 'Folder: Open a different folder', run: click('folder-btn') },
    { label: 'Flame: Low (saves tokens)', run: () => setFlame('low') },
    { label: 'Flame: High (better results, more tokens)', run: () => setFlame('high') },
    { label: 'Report a bug', run: click('bug-btn') },
  ];
  for (const theme of THEMES()) {
    list.push({ label: `Theme: ${theme.name}`, run: () => { const select = $('#theme-select'); select.value = theme.id; select.dispatchEvent(new Event('change')); } });
  }
  for (const [id, agent] of Object.entries(state.agents ?? {})) {
    list.push({ label: `Crew: Open ${agent.name}`, run: () => emit('agenttab', { id, name: agent.name }) });
  }
  return list;
}

async function setFlame(level) {
  try {
    await api.setFlame(level);
    emit('flame');
    toast(`${level === 'high' ? 'High' : 'Low'} flame`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

/** How well `query` matches `text`, or -1: every letter in order, with more for runs, word starts and the name. */
function score(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const base = t.lastIndexOf('/') + 1;
  let s = 0;
  let from = 0;
  let run = 0;
  const hits = [];
  for (const c of q) {
    if (c === ' ') continue;
    const i = t.indexOf(c, from);
    if (i < 0) return { score: -1, hits };
    run = i === from && hits.length ? run + 1 : 0;
    s += 1 + run * 3 + (i === 0 || /[/._\- ]/.test(t[i - 1]) ? 4 : 0) + (i >= base ? 2 : 0);
    hits.push(i);
    from = i + 1;
  }
  // Shorter paths, and the whole query in the file's name, come first.
  if (t.slice(base).includes(q)) s += 10;
  return { score: s - text.length * 0.02, hits };
}

/** Text with the matched letters in bold, built from text nodes (never HTML). */
function marked(text, hits) {
  const set = new Set(hits);
  const out = [];
  let plain = '';
  for (const [i, c] of [...text].entries()) {
    if (set.has(i)) {
      if (plain) out.push(plain);
      plain = '';
      out.push(h('b', null, c));
    } else plain += c;
  }
  if (plain) out.push(plain);
  return out;
}

async function filesFor(query) {
  if (!paths) {
    try {
      ({ paths } = await api.filePaths());
    } catch {
      paths = [];
    }
  }
  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(query.trim());
  const name = m ? m[1] : query.trim();
  const line = m ? Number(m[2]) : undefined;
  const col = m?.[3] ? Number(m[3]) : undefined;
  const pick = (path, hits = []) => ({ label: path, hits, hint: recent.includes(path) ? 'recently opened' : '', run: () => openPath(path, line, col) });
  if (!name) return [...recent.filter((p) => paths.includes(p)), ...paths.filter((p) => !recent.includes(p))].slice(0, SHOWN).map((p) => pick(p));
  return paths
    .map((path) => ({ path, ...score(name, path) }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score || (recent.includes(b.path) - recent.includes(a.path)))
    .slice(0, SHOWN)
    .map((r) => pick(r.path, r.hits));
}

function openPath(path, line, col) {
  const was = recent.indexOf(path);
  if (was >= 0) recent.splice(was, 1);
  recent.unshift(path);
  recent.length = Math.min(recent.length, 20);
  emit('openfile', { path, ...(line ? { line, col } : {}) });
}

async function refresh() {
  const value = $('#palette-input').value;
  if (value.startsWith('>')) {
    const query = value.slice(1).trim();
    items = commands()
      .map((c) => ({ ...c, ...(query ? score(query, c.label) : { score: 0, hits: [] }) }))
      .filter((c) => c.score >= 0)
      .sort((a, b) => (query ? b.score - a.score : 0));
  } else if (value.startsWith(':')) {
    const [line, col] = value.slice(1).split(/[:,]/).map((n) => Number(n.trim()));
    items = line > 0 ? [{ label: `Go to line ${line}${col ? `, column ${col}` : ''}`, hits: [], run: () => emit('gotoline', { line, col }) }] : [{ label: 'Type a line number', hits: [], run: () => {} }];
  } else {
    items = await filesFor(value);
    if (!items.length) items = [{ label: paths?.length ? 'No file matches' : 'No files in this folder yet', hits: [], run: () => {} }];
  }
  at = 0;
  render();
}

function render() {
  const list = $('#palette-list');
  list.replaceChildren(
    ...items.map((item, i) =>
      h('div', { id: `palette-item-${i}`, class: `palette-item${i === at ? ' active' : ''}`, role: 'option', 'aria-selected': String(i === at), onmousedown: (e) => { e.preventDefault(); choose(i); }, onmousemove: () => { if (at !== i) { at = i; render(); } } },
        h('span', { class: 'palette-label' }, ...marked(item.label, item.hits ?? [])),
        item.hint && h('span', { class: 'muted palette-hint' }, item.hint),
        item.keys && h('span', { class: 'palette-keys' }, item.keys)),
    ),
  );
  $('#palette-input').setAttribute('aria-activedescendant', items.length ? `palette-item-${at}` : '');
  list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function choose(i = at) {
  const item = items[i];
  $('#palette').close();
  item?.run();
}

/** Open the box with this text in it: '' for files, '>' for commands, ':' for a line. */
export function open(prefix = '') {
  const dialog = $('#palette');
  if (!dialog.open) dialog.showModal();
  const input = $('#palette-input');
  input.value = prefix;
  input.focus();
  refresh();
}

export function initPalette() {
  const input = h('input', { id: 'palette-input', type: 'text', class: 'palette-input', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', ariaLabel: 'Go to a file, or type > for a command and : for a line', placeholder: 'Go to a file  ( > for commands, : for a line )', autocomplete: 'off' });
  input.spellcheck = false;
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      at = (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose();
    }
  });
  const dialog = h('dialog', { id: 'palette', class: 'dialog palette', ariaLabel: 'Quick open and commands' }, input, h('div', { id: 'palette-list', class: 'palette-list', role: 'listbox', ariaLabel: 'Results' }));
  dialog.addEventListener('click', (e) => e.target === dialog && dialog.close());
  document.body.append(dialog);

  on('fs', () => (paths = null));
  on('resync', () => {
    paths = null;
    recent.length = 0;
  });
  on('command', (name) => (name === 'goto' ? open(':') : name === 'problems' ? emit('sideview', 'problems') : null));
  on('palette', (prefix) => open(prefix ?? '>'));
  $('#palette-btn').onclick = () => {
    $('#more-menu').open = false;
    open('>');
  };

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.key === 'F1' || (mod && e.shiftKey && key === 'p')) {
      e.preventDefault();
      open('>');
    } else if (mod && !e.shiftKey && !e.altKey && key === 'p') {
      e.preventDefault();
      open('');
    } else if (mod && !e.shiftKey && key === 'g' && !e.defaultPrevented) {
      e.preventDefault();
      open(':');
    }
  });
}
