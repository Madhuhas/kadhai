import { $, h, toast } from './util.js';
import { on, emit } from './store.js';
import { api } from './api.js';

/**
 * The files window's other two views: search (and replace) across every file in the folder, and
 * the folder's syntax problems. Results open the file at the line, through files.js ('openfile').
 */

let side = 'files';
const opts = { query: '', regex: false, matchCase: false, wholeWord: false, include: '', exclude: '' };
let results = null; // the last search's answer
let searchTimer = null;
let searching = 0; // the newest search, so an older answer arriving late is ignored
const problems = new Map(); // path -> [{ line, col, message, source }]
let scanned = false;
let scanning = false;

function showSide(name) {
  side = name;
  for (const tab of document.querySelectorAll('.side-tab')) {
    const on_ = tab.dataset.side === name;
    tab.classList.toggle('active', on_);
    tab.setAttribute('aria-selected', String(on_));
  }
  $('#side-files').hidden = name !== 'files';
  $('#side-search').hidden = name !== 'search';
  $('#side-problems').hidden = name !== 'problems';
  if (name === 'search') requestAnimationFrame(() => $('#search-q')?.focus());
  if (name === 'problems' && !scanned) scan();
}

// ============================================================ search

function buildSearch() {
  const field = (id, label, placeholder) => {
    const input = h('input', { id, type: 'text', class: 'search-input', placeholder, ariaLabel: label, autocomplete: 'off' });
    input.spellcheck = false;
    return input;
  };
  const toggle = (label, key, title) =>
    h('button', { type: 'button', class: 'ed-opt', title, ariaLabel: title, ariaPressed: 'false', onclick: (e) => { opts[key] = !opts[key]; e.currentTarget.setAttribute('aria-pressed', String(opts[key])); run(); } }, label);
  const q = field('search-q', 'Search in all files', 'Search');
  const r = field('search-r', 'Replace with', 'Replace');
  const include = field('search-include', 'Files to include', 'files to include, e.g. *.js, src/');
  const exclude = field('search-exclude', 'Files to exclude', 'files to exclude, e.g. dist/');
  q.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(run, 350);
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(searchTimer);
      run();
    }
  });
  for (const input of [include, exclude]) input.addEventListener('change', run);
  r.addEventListener('keydown', (e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.altKey && replaceAll());

  $('#side-search').replaceChildren(
    h('div', { class: 'search-form' },
      h('div', { class: 'search-row' }, q, toggle('Aa', 'matchCase', 'Match case'), toggle('W', 'wholeWord', 'Whole word'), toggle('.*', 'regex', 'Regular expression')),
      h('div', { class: 'search-row' }, r, h('button', { type: 'button', class: 'btn sm', title: 'Replace every match in the files listed below', onclick: replaceAll }, 'all')),
      h('details', { class: 'search-more' }, h('summary', null, 'files to include / exclude'), include, exclude)),
    h('div', { id: 'search-summary', class: 'search-summary muted', role: 'status' }),
    h('div', { id: 'search-results', class: 'search-results' }),
  );
}

async function run() {
  opts.query = $('#search-q').value;
  opts.include = $('#search-include').value;
  opts.exclude = $('#search-exclude').value;
  const summary = $('#search-summary');
  if (!opts.query) {
    results = null;
    summary.textContent = '';
    $('#search-results').replaceChildren();
    return;
  }
  const mine = ++searching;
  summary.textContent = 'searching...';
  try {
    const found = await api.search(opts);
    if (mine !== searching) return;
    results = found;
    renderResults();
  } catch (err) {
    if (mine !== searching) return;
    results = null;
    summary.textContent = err.message;
    summary.classList.add('err');
    $('#search-results').replaceChildren();
  }
}

function renderResults() {
  const summary = $('#search-summary');
  summary.classList.remove('err');
  const total = results.files.reduce((n, f) => n + f.matches.length, 0);
  summary.textContent = total
    ? `${total}${results.full ? '+' : ''} result${total === 1 ? '' : 's'} in ${results.files.length} file${results.files.length === 1 ? '' : 's'}${results.full ? ' (the list stops here: narrow the search)' : ''}`
    : `No results in ${results.searched} file${results.searched === 1 ? '' : 's'}.`;
  $('#search-results').replaceChildren(
    ...results.files.map((file) =>
      h('details', { class: 'search-file', open: true },
        h('summary', { title: file.path }, h('span', { class: 'search-path' }, file.path), h('span', { class: 'badge' }, `${file.matches.length}${file.more ? '+' : ''}`)),
        ...file.matches.map((m) =>
          h('button', { type: 'button', class: 'search-hit', title: `${file.path}:${m.line}:${m.col}`, onclick: () => emit('openfile', { path: file.path, line: m.line, col: m.col, length: m.length }) },
            h('span', { class: 'search-line muted' }, String(m.line)),
            h('span', { class: 'search-text' }, (m.cut ? '...' : '') + m.text.slice(0, m.at).trimStart(), h('mark', null, m.text.slice(m.at, m.at + m.length)), m.text.slice(m.at + m.length))))),
    ),
  );
}

async function replaceAll() {
  if (!results?.files.length) return toast('Search first: replace works on the results listed', 'err');
  const replacement = $('#search-r').value;
  const total = results.files.reduce((n, f) => n + f.matches.length, 0);
  if (!confirm(`Replace ${total}${results.full ? '+' : ''} match(es) in ${results.files.length} file(s) with "${replacement}"? Unsaved changes in open files are not included.`)) return;
  try {
    const done = await api.replaceAll(opts, replacement, results.files.map((f) => f.path));
    const changed = done.changed.reduce((n, f) => n + f.count, 0);
    toast(`Replaced ${changed} in ${done.changed.length} file(s)${done.failed.length ? `; ${done.failed.length} could not be changed (${done.failed.map((f) => f.path).join(', ')})` : ''}`, done.failed.length ? 'err' : 'ok');
    run();
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ============================================================ problems

async function scan() {
  if (scanning) return;
  scanning = true;
  renderProblems();
  try {
    const result = await api.scanProblems();
    problems.clear();
    for (const p of result.problems) problems.set(p.path, [...(problems.get(p.path) ?? []), p]);
    scanned = true;
    renderProblems(result);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    scanning = false;
    renderProblems();
  }
}

let lastScan = null;
function renderProblems(result = lastScan) {
  lastScan = result;
  const total = [...problems.values()].reduce((n, list) => n + list.length, 0);
  const badge = $('#problems-count');
  badge.hidden = !total;
  badge.textContent = String(total);
  const files = [...problems.entries()].filter(([, list]) => list.length).sort(([a], [b]) => a.localeCompare(b));
  $('#side-problems').replaceChildren(
    h('div', { class: 'search-form' },
      h('div', { class: 'search-row' },
        h('span', { class: 'muted problems-note' }, scanning ? 'checking...' : result ? `${result.checked} file(s) checked${result.capped ? ' (the first 300)' : ''}` : 'JavaScript and JSON files'),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn sm', disabled: scanning, onclick: scan }, 'check the folder'))),
    h('div', { class: 'search-results' },
      ...(files.length
        ? files.map(([path, list]) =>
            h('details', { class: 'search-file', open: true },
              h('summary', { title: path }, h('span', { class: 'search-path' }, path), h('span', { class: 'badge err' }, String(list.length)),
                h('button', { type: 'button', class: 'icon-btn wide', title: 'Ask the crew to fix it', onclick: (e) => { e.preventDefault(); askCrew(path, list); } }, 'fix')),
              ...list.map((p) =>
                h('button', { type: 'button', class: 'search-hit', title: `${p.source}: ${p.message}`, onclick: () => emit('openfile', { path, line: p.line, col: p.col }) },
                  h('span', { class: 'search-line muted' }, `${p.line}:${p.col}`),
                  h('span', { class: 'search-text err' }, p.message)))))
        : [h('div', { class: 'tree-empty' }, scanning ? '' : scanned ? 'No problems found.' : 'Not checked yet.')]),
    ),
  );
}

/** "fix" on a file's problems: an ordinary task for the crew, like anything typed in the chat. */
async function askCrew(path, list) {
  const lines = list.map((p) => `- line ${p.line}, column ${p.col}: ${p.message}`).join('\n');
  try {
    await api.task(`Fix the syntax problem${list.length === 1 ? '' : 's'} in ${path}:\n${lines}`);
    toast('Sent to the crew', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ============================================================ init

export function initSearch() {
  buildSearch();
  renderProblems();
  for (const tab of document.querySelectorAll('.side-tab')) tab.addEventListener('click', () => showSide(tab.dataset.side));
  on('sideview', (name) => showSide(name));
  // One file checked by the editor (on open and on save): its entry in the list follows.
  on('problems', ({ path, problems: list }) => {
    problems.set(path, list);
    renderProblems();
  });
  // A different folder: start again.
  on('resync', () => {
    problems.clear();
    scanned = false;
    results = null;
    $('#search-results').replaceChildren();
    $('#search-summary').textContent = '';
    renderProblems(null);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      showSide('search');
    }
  });
}
