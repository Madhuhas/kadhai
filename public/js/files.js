import { $, h, fmtBytes, toast } from './util.js';
import { tintOf } from './ascii.js';
import { state, on, emit } from './store.js';
import { api } from './api.js';
import { highlight, renderDiff } from './highlight.js';
import { openRoom } from './rooms.js';

const MEMORY = 'memory.md';
const GUTTER_MAX_LINES = 5000;
const RUNNERS = { js: 'node', mjs: 'node', cjs: 'node', py: 'python' };
const PREVIEWABLE = new Set(['html', 'htm', 'svg']);
const DRAG_TYPE = 'text/kadhai-path';

const extOf = (path) => path.split('.').pop().toLowerCase();
const baseOf = (path) => path.split('/').pop();
const dirOf = (path) => path.split('/').slice(0, -1).join('/');
const join = (dir, name) => (dir ? `${dir}/${name}` : name);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

let files = [];
let treeCut = false; // the folder has more entries than the tree lists
let current = null; // the open file, as returned by the API
let diff = null; // { title, files, patch, truncated } while a run's changes are open
let editing = false;
let view = 'kitchen'; // which tab of the stage is showing: 'kitchen', 'doc', 'browser' or 'agent:<id>'
let browsing = false; // whether the browser tab is open (browser.js owns what is in it)
let agentTabs = []; // every agent open in a tab, in the order they were opened: [{ id, name }]
let shownAgent = null; // the agent whose tab is in front, as last told to crew.js

const AGENT = 'agent:';
/** The id of the agent whose tab is in front, or null. */
const agentInView = () => (view.startsWith(AGENT) ? view.slice(AGENT.length) : null);
let targetDir = ''; // where "new file" and "new folder" will land
let inline = null; // { mode: 'file' | 'folder' | 'rename', dir, path? } while a name is being typed
let treeTimer = null;
let moving = false; // while a move is in flight, the open file's old path is expected to vanish
const collapsed = new Set();

const lockOwner = (path) => state.locks.find((l) => same(l.path, path))?.owner;
const fail = (err) => toast(err.status === 423 ? `${err.message} (try again in a moment)` : err.message, 'err');

// ================================================================== the tree

async function loadTree() {
  try {
    ({ files, truncated: treeCut } = await api.files());
  } catch {
    return;
  }
  renderTree();
}

/** A text field in the tree, for naming a new file or folder or renaming one. */
function nameField(initial, depth, commit) {
  const input = h('input', { type: 'text', class: 'name-input', value: initial, ariaLabel: 'Name' });
  input.spellcheck = false;
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    inline = null;
    if (save && name && name !== initial) await commit(name).catch(fail);
    renderTree();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  };
  input.onblur = () => finish(true);
  queueMicrotask(() => {
    input.focus();
    // Select the name but not the extension, which is usually what you keep.
    const dot = initial.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  });
  return h('div', { class: 'tree-item naming', style: `padding-left:${8 + depth * 14}px` }, h('span', { class: 'glyph' }), input);
}

async function createIn(dir, mode, name) {
  if (/[\\/]/.test(name)) throw new Error('Type a name, not a path');
  const path = join(dir, name);
  if (mode === 'folder') {
    await api.makeDir(path);
    targetDir = path;
  } else {
    await api.writeFile(path, '');
    await openFile(path);
    editing = true;
    renderStage();
  }
  await loadTree();
}

async function moveTo(from, to) {
  if (from === to) return;
  moving = true;
  try {
    await api.move(from, to);
    // If the open file (or a folder it lives in) just moved, follow it to its new path.
    if (current && (current.path === from || current.path.startsWith(`${from}/`))) {
      await openFile(to + current.path.slice(from.length), { silent: true });
    }
  } finally {
    moving = false;
  }
  if (targetDir === from || targetDir.startsWith(`${from}/`)) targetDir = to + targetDir.slice(from.length);
  await loadTree();
}

async function remove(entry) {
  const isDir = entry.type === 'dir';
  if (!confirm(isDir ? `Delete the folder "${entry.path}" and everything in it?` : `Delete "${entry.path}"?`)) return;
  await (isDir ? api.deleteDir(entry.path) : api.deleteFile(entry.path));
  if (current && (current.path === entry.path || current.path.startsWith(`${entry.path}/`))) closeDoc();
  if (targetDir === entry.path || targetDir.startsWith(`${entry.path}/`)) targetDir = dirOf(entry.path);
  await loadTree();
}

/** Drag a file or folder onto a folder (or onto empty space, for the top level) to move it. */
function dropTarget(el, dir) {
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.add('drop');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drop');
    const from = e.dataTransfer.getData(DRAG_TYPE);
    if (!from || dirOf(from) === dir) return;
    moveTo(from, join(dir, baseOf(from))).catch(fail);
  });
}

function row(entry, branch) {
  const parts = entry.path.split('/');
  const depth = parts.length - 1;
  const isDir = entry.type === 'dir';
  const fixed = entry.path === MEMORY; // the crew's shared memory: read-only, never moved
  if (inline?.mode === 'rename' && inline.path === entry.path) {
    return nameField(parts.at(-1), depth, (name) => moveTo(entry.path, join(dirOf(entry.path), name)));
  }

  const owner = !isDir && lockOwner(entry.path);
  const classes = [
    'tree-item',
    isDir && 'dir',
    fixed && 'pinned',
    current && view === 'doc' && same(current.path, entry.path) && 'active',
    isDir && entry.path === targetDir && 'target',
  ];
  const el = h(
    'div',
    {
      class: classes.filter(Boolean).join(' '),
      role: 'button',
      tabIndex: 0,
      draggable: !fixed,
      title: isDir ? `${entry.path}/` : `${entry.path} · ${fmtBytes(entry.size)}`,
      onclick: () => {
        if (!isDir) {
          targetDir = dirOf(entry.path);
          return openFile(entry.path);
        }
        // Clicking a folder opens or closes it, and makes it where new things go.
        if (targetDir === entry.path && !collapsed.has(entry.path)) collapsed.add(entry.path);
        else collapsed.delete(entry.path);
        targetDir = entry.path;
        renderTree();
      },
      onkeydown: (e) => {
        // Only the row itself: its rename and delete buttons handle their own keys.
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        e.currentTarget.click();
      },
      ondragstart: (e) => {
        e.dataTransfer.setData(DRAG_TYPE, entry.path);
        e.dataTransfer.effectAllowed = 'move';
      },
    },
    h('span', { class: 'branch' }, branch),
    h('span', { class: 'glyph' }, isDir && collapsed.has(entry.path) ? '+ ' : fixed ? '* ' : ''),
    h('span', { class: 'name' }, isDir ? `${parts.at(-1)}/` : parts.at(-1)),
    owner && h('span', { class: 'lock', title: `Locked by ${owner}` }, '[lock]'),
    !fixed &&
      h(
        'span',
        { class: 'row-actions' },
        h('button', { class: 'icon-btn', title: 'Rename', onclick: (e) => { e.stopPropagation(); inline = { mode: 'rename', path: entry.path }; renderTree(); } }, 'ren'),
        h('button', { class: 'icon-btn', title: 'Delete', onclick: (e) => { e.stopPropagation(); remove(entry).catch(fail); } }, 'del'),
      ),
  );
  if (isDir) dropTarget(el, entry.path);
  return el;
}

function renderTree() {
  // memory.md is the crew's shared brain: pin it to the top.
  const ordered = [...files].sort((a, b) => (b.path === MEMORY) - (a.path === MEMORY));
  const rows = [];
  const naming = inline && inline.mode !== 'rename' ? inline : null;
  const namingRow = () => nameField('', naming.dir ? naming.dir.split('/').length : 0, (name) => createIn(naming.dir, naming.mode, name));

  if (naming && !naming.dir) rows.push(namingRow());
  const hidden = (entry) => entry.path.split('/').slice(0, -1).some((_, i, parts) => collapsed.has(parts.slice(0, i + 1).join('/')));
  const shown = ordered.filter((entry) => !hidden(entry));
  // Draw the branches like a directory listing: the last entry of a folder closes its line.
  const lastIn = new Map(shown.map((entry) => [dirOf(entry.path), entry.path]));
  const isLast = (path) => lastIn.get(dirOf(path)) === path;
  const branchOf = (path) => {
    const parts = path.split('/');
    const above = parts.slice(0, -1).map((_, i) => (isLast(parts.slice(0, i + 1).join('/')) ? '   ' : '│  '));
    return `${above.join('')}${isLast(path) ? '└─ ' : '├─ '}`;
  };
  for (const entry of shown) {
    rows.push(row(entry, branchOf(entry.path)));
    if (naming && entry.type === 'dir' && entry.path === naming.dir) rows.push(namingRow());
  }
  if (!rows.length) {
    rows.push(h('div', { class: 'tree-empty' }, 'This folder is empty.', h('br'), 'Use + to add a file, or ask the crew to build something.'));
  }
  if (treeCut) rows.push(h('div', { class: 'tree-empty' }, `A large folder: only the first ${files.length} files and folders are listed here. The crew can still read and write every file.`));
  const tree = $('#tree');
  tree.replaceChildren(...rows);
  tree.classList.toggle('target', targetDir === '');
}

function startNaming(mode) {
  // New things go into the folder you last clicked; make sure it is open so the field is visible.
  const dir = files.some((f) => f.type === 'dir' && f.path === targetDir) ? targetDir : '';
  for (const part of dir.split('/').map((_, i, all) => all.slice(0, i + 1).join('/'))) collapsed.delete(part);
  inline = { mode, dir };
  renderTree();
}

function renderLocks() {
  $('#locks-wrap').hidden = !state.locks.length;
  $('#locks').replaceChildren(...state.locks.map((l) => h('li', null, h('span', null, l.path), h('span', { class: 'owner tinted', style: tintOf(l.owner) }, state.agents[l.owner]?.name ?? l.owner))));
}

// ================================================================= the stage

function closeDoc() {
  current = null;
  diff = null;
  editing = false;
  if (view === 'doc') view = 'kitchen';
  renderStage();
  renderTree();
}

function closeAgent(id) {
  const at = agentTabs.findIndex((agent) => agent.id === id);
  if (at < 0) return;
  agentTabs.splice(at, 1);
  // Closing the tab in front moves to its neighbour, like tabs anywhere else.
  if (agentInView() === id) {
    const next = agentTabs[at] ?? agentTabs[at - 1];
    view = next ? AGENT + next.id : 'kitchen';
  }
  renderStage();
}

function closeBrowser() {
  browsing = false;
  $('#browser-frame').src = 'about:blank'; // a closed tab stops its page
  emit('browserclosed');
  if (view === 'browser') view = 'kitchen';
  renderStage();
}

function renderTabs() {
  const hasDoc = Boolean(current || diff);
  const tab = (id, label, closable) =>
    h(
      'button',
      { class: `tab${view === id ? ' active' : ''}${id.startsWith(AGENT) ? ' tinted' : ''}`, style: id.startsWith(AGENT) ? tintOf(id.slice(AGENT.length)) : null, role: 'tab', 'aria-selected': String(view === id), title: label, onclick: () => { if (editing && id !== 'doc') return toast('Save or cancel your edit first', 'err'); view = id; renderStage(); renderTree(); } },
      h('span', { class: 'tab-label' }, label),
      closable && h('span', { class: 'tab-close', title: 'Close', onclick: (e) => { e.stopPropagation(); if (id.startsWith(AGENT)) return closeAgent(id.slice(AGENT.length)); if (id === 'browser') return closeBrowser(); if (editing && !confirm('Discard your unsaved changes?')) return; closeDoc(); } }, '×'),
    );
  // replaceChildren() would print a bare false as the text "false", so only real nodes go in.
  $('#tabs').replaceChildren(
    tab('kitchen', 'kitchen.exe', false),
    ...agentTabs.map((agent) => tab(AGENT + agent.id, agent.name, true)),
    ...(browsing ? [tab('browser', 'browser', true)] : []),
    ...(hasDoc ? [tab('doc', diff ? 'Changes' : baseOf(current.path), true)] : []),
  );
}

function renderDiffView(body) {
  const STATUS = { A: 'added', M: 'changed', D: 'deleted', R: 'renamed' };
  for (const id of ['file-run', 'file-preview', 'file-edit', 'file-save', 'file-cancel']) $(`#${id}`).hidden = true;
  $('#file-path').textContent = diff.title;
  $('#file-meta').textContent = `${diff.files.length ? `${diff.files.length} file(s) changed` : 'what changed'}${diff.truncated ? ' · diff truncated' : ''}`;
  if (!diff.patch.trim()) {
    body.replaceChildren(h('div', { class: 'empty' }, 'There are no changes to show.'));
    return;
  }
  body.replaceChildren(
    ...(diff.files.length ? [h('div', { class: 'diff-files' }, diff.files.map((f) => h('span', { class: `diff-file ${f.status}` }, `${STATUS[f.status] ?? f.status} ${f.path}`)))] : []),
    h('pre', { class: 'diff', innerHTML: renderDiff(diff.patch) }),
  );
  body.scrollTop = 0;
}

function renderStage() {
  const body = $('#file-body');
  if (view === 'doc' && !current && !diff) view = 'kitchen';
  if (agentInView() && !agentTabs.some((agent) => agent.id === agentInView())) view = 'kitchen';
  renderTabs();

  // All agent tabs share one panel; crew.js fills it with whichever agent is in front.
  const agent = agentInView();
  if (agent !== shownAgent) {
    shownAgent = agent;
    emit('agentshow', agent);
  }
  $('#agent-view').hidden = !agent;
  if (view === 'browser' && !browsing) view = 'kitchen';
  $('#browser-view').hidden = view !== 'browser';
  body.hidden = Boolean(agent) || view === 'browser';
  if (agent || view === 'browser') {
    $('#file-bar').hidden = true;
    return;
  }

  if (view === 'kitchen') {
    $('#file-bar').hidden = true;
    // Keep the floor alive across re-renders instead of rebuilding it under the animation.
    if (!body.firstElementChild?.classList.contains('floor')) {
      const floor = h('div', { class: 'floor' });
      body.replaceChildren(floor);
      emit('floor', floor); // crew.js fills it in and keeps it live
    }
    return;
  }

  $('#file-bar').hidden = false;
  if (diff) return renderDiffView(body);

  const editable = !current.binary && !current.truncated && current.path !== MEMORY;
  const owner = lockOwner(current.path);
  const ext = extOf(current.path);
  $('#file-path').textContent = current.path;
  $('#file-meta').textContent = `${fmtBytes(current.size)}${owner ? ` · locked by ${owner}` : ''}${current.path === MEMORY ? ' · kept by the crew, read-only' : ''}`;
  $('#file-run').hidden = editing || !RUNNERS[ext] || state.exec.mode === 'off';
  $('#file-preview').hidden = editing || !PREVIEWABLE.has(ext) || !state.app.previewUrl;
  $('#file-edit').hidden = !editable || editing;
  $('#file-save').hidden = !editing;
  $('#file-cancel').hidden = !editing;

  if (current.binary) {
    body.replaceChildren(h('div', { class: 'empty' }, 'This is a binary file, so there is nothing to show.'));
    return;
  }
  if (editing) {
    const editor = h('textarea', { class: 'editor', value: current.content, ariaLabel: `Contents of ${current.path}`, spellcheck: false });
    editor.spellcheck = false;
    body.replaceChildren(editor);
    editor.focus();
    return;
  }
  const scroll = body.firstElementChild?.classList.contains('code-wrap') ? body.scrollTop : 0;
  const lines = current.content.split('\n').length;
  const gutter = lines <= GUTTER_MAX_LINES && h('pre', { class: 'gutter' }, Array.from({ length: lines }, (_, i) => i + 1).join('\n'));
  body.replaceChildren(h('div', { class: 'code-wrap' }, gutter, h('pre', { class: 'code', innerHTML: highlight(current.content, ext) })));
  body.scrollTop = scroll;
}

async function openFile(path, { silent = false } = {}) {
  if (editing && !silent && !confirm('Discard your unsaved changes?')) return;
  try {
    const next = await api.readFile(path);
    const changed = !current || !same(current.path, next.path);
    current = next;
    diff = null;
    if (!silent) view = 'doc';
    if (changed) $('#file-body').scrollTop = 0;
  } catch (err) {
    if (err.status !== 404) return silent ? undefined : toast(err.message, 'err');
    current = null; // it is gone
  }
  editing = false;
  renderStage();
  renderTree();
}

async function save() {
  try {
    await api.writeFile(current.path, $('#file-body textarea').value);
    toast(`Saved ${baseOf(current.path)}`, 'ok');
    editing = false;
    await openFile(current.path);
  } catch (err) {
    fail(err);
  }
}

// ============================================================ folder dialog

let browsed = null; // what the dialog is showing: { path, parent, dirs, places, recent, dir }

async function browse(path) {
  try {
    browsed = await api.browse(path);
  } catch (err) {
    return toast(err.message, 'err');
  }
  $('#folder-path').value = browsed.path;
  const here = same(browsed.path, browsed.dir);
  $('#folder-open').disabled = here;
  // The folder already open here cannot also be a second room.
  $('#folder-room').disabled = here;
  $('#folder-open').textContent = here ? 'Already open' : `Open "${baseOf(browsed.path.replace(/\\/g, '/')) || browsed.path}"`;

  const chip = (label, target) => h('button', { class: 'chip', type: 'button', title: target, onclick: () => browse(target) }, label);
  $('#folder-places').replaceChildren(
    ...browsed.places.map((p) => chip(p.label, p.path)),
    ...browsed.recent.filter((r) => !same(r, browsed.dir)).map((r) => chip(`~ ${baseOf(r.replace(/\\/g, '/'))}`, r)),
  );
  const item = (label, target, cls = '') => h('button', { class: `folder-item ${cls}`, type: 'button', onclick: () => browse(target) }, h('span', { class: 'glyph' }, cls ? '..' : '>'), label);
  const sep = browsed.path.includes('\\') ? '\\' : '/';
  $('#folder-list').replaceChildren(
    ...(browsed.parent ? [item('Up one level', browsed.parent, 'up')] : []),
    ...browsed.dirs.map((name) => item(name, browsed.path.endsWith(sep) ? browsed.path + name : browsed.path + sep + name)),
    ...(browsed.dirs.length ? [] : [h('div', { class: 'tree-empty' }, 'No folders in here.')]),
  );
}

function initFolderDialog() {
  const dialog = $('#folder-dialog');
  $('#folder-btn').onclick = async () => {
    await browse('');
    dialog.showModal();
  };
  $('#folder-close').onclick = $('#folder-cancel').onclick = () => dialog.close();
  dialog.addEventListener('click', (e) => e.target === dialog && dialog.close());
  $('#folder-path-form').addEventListener('submit', (e) => {
    e.preventDefault();
    browse($('#folder-path').value.trim());
  });
  $('#folder-new').onclick = async () => {
    const name = prompt(`New folder inside\n${browsed.path}`, 'my-project');
    if (!name) return;
    try {
      const made = await api.makeFolder(browsed.path, name);
      await browse(made.path);
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  // The other way to open a folder: leave this room alone and give the folder a room of its own.
  $('#folder-room').onclick = async () => {
    const button = $('#folder-room');
    button.disabled = true;
    button.textContent = 'Opening the kitchen…';
    try {
      const room = await openRoom(browsed.path);
      if (room) toast(`Kitchen "${room.name}" opened in its own window`, 'ok');
      dialog.close();
    } catch (err) {
      toast(err.message, 'err');
    }
    button.textContent = 'Open in a new kitchen';
    button.disabled = false;
  };
  // "+ new room" in the rooms menu is this same dialog.
  on('newroom', async () => {
    await browse('');
    dialog.showModal();
  });
  $('#folder-open').onclick = async () => {
    // The server drops the live connection while it swaps folders; that is expected, not an outage.
    state.switching = true;
    try {
      const info = await api.openWorkspace(browsed.path);
      dialog.close();
      // A different folder is a different project: start from a clean slate.
      files = [];
      collapsed.clear();
      targetDir = '';
      inline = null;
      closeDoc();
      toast(`Now working in ${info.name}`, 'ok');
      emit('resync');
    } catch (err) {
      state.switching = false;
      toast(err.message, 'err');
    }
  };
}

// ====================================================================== init

export function initFiles() {
  on('sync', () => {
    $('#folder-name').textContent = baseOf(String(state.app.workspaceDir ?? '').replace(/\\/g, '/')) || 'workspace';
    $('#folder-btn').title = `${state.app.workspaceDir}\nClick to open a different folder`;
    // An agent that was let go loses its tab; a renamed one gets its new name.
    agentTabs = agentTabs.filter((open) => state.agents[open.id]).map((open) => ({ id: open.id, name: state.agents[open.id].name }));
    loadTree();
    renderLocks();
    renderStage();
  });
  on('locks', () => {
    renderLocks();
    renderTree();
    if (current && !editing && view === 'doc') renderStage();
  });
  on('fs', (paths = []) => {
    clearTimeout(treeTimer);
    treeTimer = setTimeout(() => !inline && loadTree(), 120);
    // Live-refresh the open file, but never under the user's cursor.
    if (current && !editing && !moving && (!paths.length || paths.some((p) => same(p, current.path)))) openFile(current.path, { silent: true });
  });
  on('execmode', () => current && !editing && view === 'doc' && renderStage());

  // Clicking an agent opens it in its own tab, or brings its tab to the front if it already has one.
  on('agenttab', (agent) => {
    if (editing) return toast('Save or cancel your edit first', 'err');
    if (!agentTabs.some((open) => open.id === agent.id)) agentTabs.push(agent);
    view = AGENT + agent.id;
    renderStage();
    renderTree();
  });

  // A page on this computer, in the browser tab (browser.js loads it).
  on('browsertab', () => {
    if (editing) return toast('Save or cancel your edit first', 'err');
    browsing = true;
    view = 'browser';
    renderStage();
    renderTree();
  });

  // "View changes" on a finished run: open its diff as a tab.
  on('showdiff', async (run) => {
    if (editing) return toast('Save or cancel your edit first', 'err');
    try {
      diff = { title: run.objective, ...(await api.runDiff(run.id)) };
      current = null;
      view = 'doc';
      renderStage();
      renderTree();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  // A change picked in Source control: show that one file's patch.
  on('showpatch', (patch) => {
    if (editing) return toast('Save or cancel your edit first', 'err');
    diff = { files: [], ...patch };
    current = null;
    view = 'doc';
    renderStage();
    renderTree();
  });

  $('#refresh-files').onclick = loadTree;
  $('#new-file').onclick = () => startNaming('file');
  $('#new-folder').onclick = () => startNaming('folder');
  dropTarget($('#tree'), ''); // drop on empty space = move to the top level
  $('#tree').addEventListener('click', (e) => {
    if (e.target !== e.currentTarget) return;
    targetDir = '';
    renderTree();
  });

  $('#file-edit').onclick = () => {
    editing = true;
    renderStage();
  };
  $('#file-cancel').onclick = () => {
    editing = false;
    renderStage();
  };
  $('#file-save').onclick = save;
  $('#file-run').onclick = () =>
    api
      .exec(`${RUNNERS[extOf(current.path)]} "${current.path}"`)
      .then(() => emit('openterminal')) // show the result where it will appear
      .catch((err) => toast(err.message, 'err'));
  $('#file-preview').onclick = () => emit('browsertab', `${state.app.previewUrl}/${current.path.split('/').map(encodeURIComponent).join('/')}`);

  document.addEventListener('keydown', (e) => {
    if (editing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  });

  initFolderDialog();
}
