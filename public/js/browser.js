import { $, h, toast } from './util.js';
import { state, on, emit } from './store.js';
import { api } from './api.js';

/*
 * The browser tab: a page on this computer (the folder's preview, or a dev server
 * the user started) shown inside the stage. It is a frame of another origin, so the
 * page cannot touch the dashboard; the address bar only takes loopback addresses,
 * because the CSP frames nothing else. The frame stays alive while other tabs are in
 * front, so a page keeps its state. A page from the folder's preview reloads itself
 * when files in the folder change, reports its errors (the preview adds a small script
 * to the folder's HTML pages) and opens by itself when a run makes a page or a dev
 * server you started prints its address.
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const RELOAD_DELAY = 400; // ms: a run writes several files in a row; reload once after the last

let history = []; // addresses visited here, for back and forward (the frame's own history is out of reach)
let at = -1;
let timer = null;
let folder = null; // the folder the preview served when it was last loaded
let errors = []; // what the page in front reported: [{ kind, message, where, page }]
let seenRuns = null; // runs already known, so only a new one opens its page
const MAX_ERRORS = 10;
const TASK_CHARS = 2000;

const frame = () => $('#browser-frame');
const current = () => history[at] ?? '';

/** What the user typed, as a loopback address, or null. "3000", "localhost:5173" and "/page.html" all work. */
export function toAddress(text) {
  let value = String(text ?? '').trim();
  if (!value) return null;
  if (/^\d{2,5}(\/.*)?$/.test(value)) value = `localhost:${value}`;
  else if (value.startsWith('/')) value = (state.app.previewUrl ?? '') + value;
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!LOOPBACK.has(url.hostname.toLowerCase())) return null;
  url.hostname = 'localhost'; // the CSP names localhost and 127.0.0.1; [::1] cannot be written there
  return url.href;
}

/** The workspace preview serves the open folder; its pages follow the folder's files. */
const isPreview = (address) => Boolean(state.app.previewUrl) && toAddress(address)?.startsWith(toAddress(state.app.previewUrl));

function renderErrors() {
  const box = $('#browser-errors');
  box.hidden = !errors.length;
  if (!errors.length) return box.replaceChildren();
  box.replaceChildren(
    h(
      'div',
      { class: 'browser-errors-head' },
      h('span', null, `[!] ${errors.length === 1 ? 'This page reported an error' : `This page reported ${errors.length} errors`}`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm primary', type: 'button', title: 'Send these errors to the Chef as a task', onclick: fixErrors }, 'Fix this'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => ((errors = []), renderErrors()) }, 'Dismiss'),
    ),
    // The first line says what went wrong; the whole stack is there on hover.
    ...errors.map((e) => h('pre', { class: 'browser-error', title: e.message }, e.message.split('\n')[0], e.where ? h('span', { class: 'muted' }, e.where) : null)),
  );
}

/** Hand the page's errors to the crew: an ordinary task, like one typed in the chat. */
async function fixErrors() {
  const page = errors[0]?.page || '/';
  const list = errors.map((e) => `- ${e.message.split('\n')[0]}${e.where ? ` (${e.where})` : ''}`).join('\n');
  const text = `The page ${page} shows these errors in the browser:\n${list}\nFind the cause in the folder's files and fix it.`.slice(0, TASK_CHARS);
  try {
    await api.task(text);
    toast('Sent to the crew - the page reloads when they change the files');
    errors = [];
    renderErrors();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function show(address) {
  errors = []; // a fresh load starts with a clean slate
  renderErrors();
  $('#browser-address').value = address;
  $('#browser-back').disabled = at <= 0;
  $('#browser-forward').disabled = at >= history.length - 1;
  $('#browser-live').hidden = !isPreview(address);
  frame().src = address; // setting src always loads, even when it is the same address
}

function go(text) {
  const address = toAddress(text);
  if (!address) return toast('Only pages on this computer open here: localhost, 127.0.0.1, or a port like 3000', 'err');
  if (new URL(address).port === location.port) return toast('That is the dashboard itself - open a page or another port', 'err');
  if (address === current()) return show(address);
  history = [...history.slice(0, at + 1), address];
  at = history.length - 1;
  show(address);
}

const step = (by) => {
  if (!history[at + by]) return;
  at += by;
  show(current());
};

export function initBrowser() {
  // "Open preview" and the file bar's Preview send an address; the taskbar button sends none.
  on('browsertab', (address) => {
    if (address) go(address);
    else if (!current()) go(state.app.previewUrl ?? 'localhost:3000');
  });

  // Closing the tab forgets where it was: opening it again starts at the preview.
  on('browserclosed', () => {
    clearTimeout(timer);
    history = [];
    at = -1;
  });

  // The crew (or you) changed files: a preview page follows, once the writing settles.
  on('fs', () => {
    if (!current() || !isPreview(current())) return;
    clearTimeout(timer);
    timer = setTimeout(() => show(current()), RELOAD_DELAY);
  });

  // Another folder was opened: the preview now serves a different folder, so load it again.
  on('sync', () => {
    const opened = state.app.workspaceDir;
    if (folder && opened !== folder && current() && isPreview(current())) show(current());
    folder = opened;
    seenRuns = new Set(state.runs.map((run) => run.id));
  });

  // A run made or changed a web page: show it (pages that run already showed just reload).
  on('runs', () => {
    const fresh = state.runs.filter((run) => !seenRuns?.has(run.id));
    seenRuns = new Set(state.runs.map((run) => run.id));
    const run = fresh.find((r) => r.ok && !r.undone && r.files?.some((f) => /\.html?$/i.test(f)));
    if (!run || !state.app.previewUrl) return;
    const page = run.files.find((f) => /(^|\/)index\.html?$/i.test(f)) ?? run.files.find((f) => /\.html?$/i.test(f));
    emit('browsertab', `${state.app.previewUrl}/${page.split('/').map(encodeURIComponent).join('/')}`);
  });

  // A dev server you started printed its address: open it.
  on('exec', (event) => {
    if (event.type !== 'port' || state.agents[event.owner]) return;
    toast(`Serving at ${event.url}`);
    emit('browsertab', event.url);
  });

  // Errors from the page in the frame (only pages from the folder's preview carry the reporter).
  window.addEventListener('message', (e) => {
    if (e.source !== frame().contentWindow || !current() || !isPreview(current())) return;
    if (e.origin !== new URL(toAddress(state.app.previewUrl)).origin) return;
    const data = e.data;
    if (!data || data.kadhai !== 'page-error' || typeof data.message !== 'string') return;
    const error = { kind: String(data.kind), message: data.message.slice(0, 600), where: String(data.where ?? '').slice(0, 200), page: String(data.page ?? '').slice(0, 200) };
    if (errors.length >= MAX_ERRORS || errors.some((x) => x.message === error.message && x.where === error.where)) return;
    errors.push(error);
    renderErrors();
  });

  $('#browser-form').onsubmit = (e) => {
    e.preventDefault();
    go($('#browser-address').value);
  };
  $('#browser-back').onclick = () => step(-1);
  $('#browser-forward').onclick = () => step(1);
  $('#browser-reload').onclick = () => current() && show(current());
  $('#browser-out').onclick = () => current() && window.open(current(), '_blank', 'noopener');
  $('#browser-btn').onclick = () => emit('browsertab');
}
