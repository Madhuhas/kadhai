import { $, h, fmtBytes, toast } from './util.js';
import { tintOf } from './ascii.js';
import { state, on, emit } from './store.js';
import { api } from './api.js';
import { renderDiff } from './highlight.js';
import { createEditor } from './editor.js';
import { openRoom } from './rooms.js';

const MEMORY = 'memory.md';
const RUNNERS = { js: 'node', mjs: 'node', cjs: 'node', py: 'python' };
const PREVIEWABLE = new Set(['html', 'htm', 'svg']);
const CHECKABLE = /\.(m?js|cjs|json)$/i; // what the problems check reads (src/core/problems.js)
const DRAG_TYPE = 'text/kadhai-path';
const MAX_OPEN = 12; // open files; the oldest one without unsaved changes makes room

const extOf = (path) => path.split('.').pop().toLowerCase();
const baseOf = (path) => path.split('/').pop();
const dirOf = (path) => path.split('/').slice(0, -1).join('/');
const join = (dir, name) => (dir ? `${dir}/${name}` : name);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

let files = [];
let treeCut = false; // the folder has more entries than the tree lists
/**
 * The open files, in tab order. Each keeps its own editor (and with it the undo history and the
 * unsaved text) while other tabs are in front: { path, size, binary, truncated, content, editor,
 * dirty, problems, disk, gone }. `content` is the text as last read or saved; `disk` is a newer
 * version written by someone else while this one had unsaved changes.
 */
let docs = [];
let diff = null; // { title, files, patch, truncated } while a run's changes (or one file's) are open
let view = 'kitchen'; // which tab of the stage is showing: 'kitchen', 'file:<path>', 'diff', 'browser' or 'agent:<id>'
let browsing = false; // whether the browser tab is open (browser.js owns what is in it)
let agentTabs = []; // every agent open in a tab, in the order they were opened: [{ id, name }]
let shownAgent = null; // the agent whose tab is in front, as last told to crew.js

const AGENT = 'agent:';
const FILE = 'file:';
/** The id of the agent whose tab is in front, or null. */
const agentInView = () => (view.startsWith(AGENT) ? view.slice(AGENT.length) : null);
/** The open file in front, or null. */
const docInView = () => (view.startsWith(FILE) ? (docs.find((d) => d.path === view.slice(FILE.length)) ?? null) : null);
const docOf = (path) => docs.find((d) => same(d.path, path));
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
  }
  await loadTree();
}

async function moveTo(from, to) {
  if (from === to) return;
  moving = true;
  try {
    await api.move(from, to);
    // Open files that moved (or live in a folder that did) follow it, unsaved changes and all.
    for (const doc of docs) {
      if (doc.path !== from && !doc.path.startsWith(`${from}/`)) continue;
      const next = to + doc.path.slice(from.length);
      if (view === FILE + doc.path) view = FILE + next;
      doc.path = next;
    }
    renderStage();
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
  for (const doc of docs.filter((d) => d.path === entry.path || d.path.startsWith(`${entry.path}/`))) closeFile(doc, { force: true });
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
  const open = !isDir && docOf(entry.path);
  const classes = [
    'tree-item',
    isDir && 'dir',
    fixed && 'pinned',
    open && docInView() === open && 'active',
    open?.dirty && 'unsaved',
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
    open?.dirty && h('span', { class: 'unsaved-mark', title: 'Unsaved changes' }, ' *'),
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
  if (treeCut) rows.push(h('div', { class: 'tree-empty' }, `A large folder: only the first ${files.length} files and folders are listed here. The crew can still read and write every file, and Ctrl+P finds any of them.`));
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

/** Close one open file. Unsaved changes are asked about first, unless `force`. -> whether it closed */
function closeFile(doc, { force = false } = {}) {
  if (!force && doc.dirty && !confirm(`"${baseOf(doc.path)}" has unsaved changes. Close it and lose them?`)) return false;
  const at = docs.indexOf(doc);
  docs.splice(at, 1);
  doc.editor?.destroy();
  if (view === FILE + doc.path) {
    const next = docs[at] ?? docs[at - 1];
    view = next ? FILE + next.path : 'kitchen';
  }
  renderStage();
  renderTree();
  return true;
}

function closeDiff() {
  diff = null;
  if (view === 'diff') view = docs.length ? FILE + docs.at(-1).path : 'kitchen';
  renderStage();
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

function show(id) {
  // The file being left keeps its caret and scroll for when it comes back.
  const leaving = docInView();
  if (leaving?.editor && id !== view) leaving.view = leaving.editor.view();
  view = id;
  renderStage();
  renderTree();
}

function renderTabs() {
  const tab = (id, label, onClose, { title = label, tint = null, unsaved = false } = {}) =>
    h(
      'button',
      { class: `tab${view === id ? ' active' : ''}${tint ? ' tinted' : ''}${unsaved ? ' unsaved' : ''}`, style: tint ? tintOf(tint) : null, role: 'tab', 'aria-selected': String(view === id), title, onclick: () => show(id), onauxclick: (e) => e.button === 1 && onClose?.() },
      h('span', { class: 'tab-label' }, label),
      unsaved && h('span', { class: 'tab-unsaved', title: 'Unsaved changes' }, '*'),
      onClose && h('span', { class: 'tab-close', title: 'Close', onclick: (e) => { e.stopPropagation(); onClose(); } }, '×'),
    );
  // Two open files with the same name are told apart by their folder.
  const label = (doc) => (docs.filter((d) => baseOf(d.path) === baseOf(doc.path)).length > 1 ? `${baseOf(dirOf(doc.path)) || '.'}/${baseOf(doc.path)}` : baseOf(doc.path));
  // replaceChildren() would print a bare false as the text "false", so only real nodes go in.
  $('#tabs').replaceChildren(
    tab('kitchen', 'kitchen.exe', null),
    ...agentTabs.map((agent) => tab(AGENT + agent.id, agent.name, () => closeAgent(agent.id), { tint: agent.id })),
    ...(browsing ? [tab('browser', 'browser', closeBrowser)] : []),
    ...docs.map((doc) => tab(FILE + doc.path, label(doc), () => closeFile(doc), { title: doc.path, unsaved: doc.dirty })),
    ...(diff ? [tab('diff', 'Changes', closeDiff, { title: diff.title })] : []),
  );
  $('#tabs').querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderDiffView(body) {
  const STATUS = { A: 'added', M: 'changed', D: 'deleted', R: 'renamed' };
  for (const id of ['file-run', 'file-preview', 'file-save', 'file-revert']) $(`#${id}`).hidden = true;
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

/** The bar over an open file that someone else changed or deleted while it had unsaved changes. */
function diskBar(doc) {
  if (doc.gone) {
    return h('div', { class: 'disk-bar', role: 'status' },
      h('span', null, 'This file was deleted on disk. Saving puts it back.'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', type: 'button', onclick: () => closeFile(doc, { force: true }) }, 'Close it'));
  }
  if (doc.disk == null) return null;
  const who = lockOwner(doc.path) ?? 'someone else';
  return h('div', { class: 'disk-bar', role: 'status' },
    h('span', null, `This file was changed on disk (${state.agents[who]?.name ?? who}) while you had unsaved changes.`),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm', type: 'button', title: 'Throw away your changes and load the new version', onclick: () => { const text = doc.disk; doc.disk = null; doc.content = text; doc.editor.setText(text); renderStage(); check(doc); } }, 'Use theirs'),
    h('button', { class: 'btn sm', type: 'button', title: 'Keep your version; saving will overwrite theirs', onclick: () => { doc.disk = null; renderStage(); } }, 'Keep mine'));
}

function renderStage() {
  const body = $('#file-body');
  if (view === 'diff' && !diff) view = 'kitchen';
  if (view.startsWith(FILE) && !docInView()) view = 'kitchen';
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
  if (view === 'diff') return renderDiffView(body);

  const doc = docInView();
  const owner = lockOwner(doc.path);
  const ext = extOf(doc.path);
  $('#file-path').textContent = doc.path;
  $('#file-meta').textContent = `${fmtBytes(doc.size)}${owner ? ` · locked by ${state.agents[owner]?.name ?? owner}` : ''}${doc.path === MEMORY ? ' · kept by the crew, read-only' : doc.truncated ? ' · too large to edit here' : ''}`;
  $('#file-run').hidden = doc.dirty || !RUNNERS[ext] || state.exec.mode === 'off';
  $('#file-preview').hidden = doc.dirty || !PREVIEWABLE.has(ext) || !state.app.previewUrl;
  $('#file-save').hidden = !doc.editor || !(doc.dirty || doc.gone);
  $('#file-revert').hidden = !doc.editor || !doc.dirty;

  if (!doc.editor) {
    body.replaceChildren(h('div', { class: 'empty' }, 'This is a binary file, so there is nothing to show.'));
    return;
  }
  // Re-renders happen all the time (locks, runs): the editor element is only moved in when it is not already there.
  const holder = body.firstElementChild?.classList.contains('doc') ? body.firstElementChild : null;
  const bar = diskBar(doc);
  if (holder?.lastElementChild !== doc.editor.el || holder.children.length !== (bar ? 2 : 1)) {
    body.replaceChildren(h('div', { class: 'doc' }, ...(bar ? [bar] : []), doc.editor.el));
    doc.editor.restore(doc.view);
  }
}

/** Problems in an open file (JSON and JavaScript only), into its editor and the problems view. */
async function check(doc) {
  if (!CHECKABLE.test(doc.path) || !doc.editor) return;
  try {
    const { problems } = await api.problems(doc.path);
    doc.problems = problems;
    doc.editor.setProblems(problems);
    emit('problems', { path: doc.path, problems });
  } catch {
    // A check that cannot run is not a problem in the file.
  }
}

function makeDoc(data) {
  const doc = { path: data.path, size: data.size, binary: data.binary, truncated: data.truncated, content: data.content, dirty: false, problems: [], disk: null, gone: false, view: null, editor: null };
  if (!data.binary) {
    doc.editor = createEditor({
      text: data.content,
      ext: extOf(data.path),
      readOnly: data.truncated || data.path === MEMORY,
      onDirty: (dirty) => {
        doc.dirty = dirty;
        renderTabs();
        renderTree();
        if (docInView() === doc) {
          $('#file-save').hidden = !(dirty || doc.gone);
          $('#file-revert').hidden = !dirty;
          $('#file-run').hidden = dirty || !RUNNERS[extOf(doc.path)] || state.exec.mode === 'off';
        }
      },
      onSave: () => save(doc),
      onCommand: (command) => emit('command', command),
    });
  }
  return doc;
}

/**
 * Open a file in a tab of its own, or bring its tab to the front. `line` (and `col`, `length`)
 * put the caret there - search results, problems and quick open use it.
 */
async function openFile(path, { line, col, length, silent = false } = {}) {
  let doc = docOf(path);
  if (!doc) {
    let data;
    try {
      data = await api.readFile(path);
    } catch (err) {
      return silent ? undefined : toast(err.message, 'err');
    }
    doc = docOf(data.path) ?? makeDoc(data);
    if (!docs.includes(doc)) {
      // Room for one more: the oldest tab without unsaved changes goes.
      if (docs.length >= MAX_OPEN) {
        const spare = docs.find((d) => !d.dirty && docInView() !== d);
        if (spare) closeFile(spare, { force: true });
      }
      docs.push(doc);
      check(doc);
    }
  }
  if (!silent) show(FILE + doc.path);
  if (line && doc.editor) requestAnimationFrame(() => doc.editor.goTo(line, col ?? 1, length ?? 0));
  else if (!silent) requestAnimationFrame(() => doc.editor?.focus());
}

/** The open file read again after someone else wrote it. Unsaved changes are never overwritten. */
async function reload(doc) {
  let data;
  try {
    data = await api.readFile(doc.path);
  } catch (err) {
    if (err.status === 404 && !moving) {
      doc.gone = true;
      if (!doc.dirty) return closeFile(doc, { force: true });
      renderStage();
    }
    return;
  }
  doc.gone = false;
  doc.size = data.size;
  if (data.content === doc.content) return;
  if (doc.dirty) {
    doc.disk = data.content;
  } else {
    doc.content = data.content;
    doc.editor?.setText(data.content);
    check(doc);
  }
  if (docInView() === doc) renderStage();
}

async function save(doc = docInView()) {
  if (!doc?.editor || doc.editor.dirty() === false && !doc.gone) return;
  const text = doc.editor.text();
  try {
    await api.writeFile(doc.path, text);
    doc.content = text;
    doc.disk = null;
    doc.gone = false;
    doc.editor.markSaved();
    toast(`Saved ${baseOf(doc.path)}`, 'ok');
    renderStage();
    check(doc);
  } catch (err) {
    fail(err);
  }
}

function revert(doc = docInView()) {
  if (!doc?.editor || !confirm(`Throw away your changes to "${baseOf(doc.path)}"?`)) return;
  doc.editor.setText(doc.disk ?? doc.content);
  if (doc.disk != null) doc.content = doc.disk;
  doc.disk = null;
  renderStage();
}

/** Close every open file (a different folder was opened): unsaved changes are asked about once. -> whether all closed */
function closeAll() {
  const unsaved = docs.filter((d) => d.dirty);
  if (unsaved.length && !confirm(`${unsaved.length} file(s) have unsaved changes (${unsaved.map((d) => baseOf(d.path)).join(', ')}). Close them and lose the changes?`)) return false;
  for (const doc of [...docs]) closeFile(doc, { force: true });
  closeDiff();
  return true;
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
    // A different folder is a different project: its files close first, unsaved ones asked about.
    if (!closeAll()) return;
    // The server drops the live connection while it swaps folders; that is expected, not an outage.
    state.switching = true;
    try {
      const info = await api.openWorkspace(browsed.path);
      dialog.close();
      files = [];
      collapsed.clear();
      targetDir = '';
      inline = null;
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
    for (const doc of docs) reload(doc);
  });
  on('locks', () => {
    renderLocks();
    renderTree();
    if (docInView()) renderStage();
  });
  on('fs', (paths = []) => {
    clearTimeout(treeTimer);
    treeTimer = setTimeout(() => !inline && loadTree(), 120);
    // Open files follow the disk; one with unsaved changes is never overwritten (reload says so instead).
    if (moving) return;
    for (const doc of docs) if (!paths.length || paths.some((p) => same(p, doc.path))) reload(doc);
  });
  on('execmode', () => docInView() && renderStage());

  // Clicking an agent opens it in its own tab, or brings its tab to the front if it already has one.
  on('agenttab', (agent) => {
    if (!agentTabs.some((open) => open.id === agent.id)) agentTabs.push(agent);
    show(AGENT + agent.id);
  });

  // A page on this computer, in the browser tab (browser.js loads it).
  on('browsertab', () => {
    browsing = true;
    show('browser');
  });

  // "View changes" on a finished run: open its diff as a tab.
  on('showdiff', async (run) => {
    try {
      diff = { title: run.objective, ...(await api.runDiff(run.id)) };
      show('diff');
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  // A change picked in Source control: show that one file's patch.
  on('showpatch', (patch) => {
    diff = { files: [], ...patch };
    show('diff');
  });

  // Other modules (search, problems, quick open) open files here: { path, line?, col?, length? }.
  on('openfile', ({ path, ...at }) => openFile(path, at));
  on('kitchentab', () => show('kitchen'));
  on('savefile', () => save());
  on('closefile', () => docInView() && closeFile(docInView()));
  on('findinfile', (replace) => docInView()?.editor?.openFind(Boolean(replace)));
  on('gotoline', ({ line, col }) => (docInView()?.editor ? docInView().editor.goTo(line, col || 1) : toast('Open a file first', 'err')));
  on('newfile', () => startNaming('file'));

  $('#refresh-files').onclick = loadTree;
  $('#new-file').onclick = () => startNaming('file');
  $('#new-folder').onclick = () => startNaming('folder');
  dropTarget($('#tree'), ''); // drop on empty space = move to the top level
  $('#tree').addEventListener('click', (e) => {
    if (e.target !== e.currentTarget) return;
    targetDir = '';
    renderTree();
  });

  $('#file-save').onclick = () => save();
  $('#file-revert').onclick = () => revert();
  $('#file-run').onclick = () =>
    api
      .exec(`${RUNNERS[extOf(docInView().path)]} "${docInView().path}"`)
      .then(() => emit('openterminal')) // show the result where it will appear
      .catch((err) => toast(err.message, 'err'));
  $('#file-preview').onclick = () => emit('browsertab', `${state.app.previewUrl}/${docInView().path.split('/').map(encodeURIComponent).join('/')}`);

  // Ctrl+S with the focus outside the editor (on the tab, the tree) still saves the file in front.
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 's' && docInView()) {
      e.preventDefault();
      save();
    }
  });
  // Leaving the page with unsaved changes asks first, as any editor does.
  window.addEventListener('beforeunload', (e) => {
    if (docs.some((d) => d.dirty)) e.preventDefault();
  });

  initFolderDialog();
}
