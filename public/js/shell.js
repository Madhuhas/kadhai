import { $, h, toast } from './util.js';
import { on } from './store.js';
import { api } from './api.js';
import { Terminal } from './vt.js';

/**
 * The real terminal's tabs in the terminal window: "commands" (terminal.js, the crew's commands
 * and your one-off ones) and one tab per shell (a pseudo-terminal on the server, pty.js). Keys go
 * to the shell in order; its output comes back as pty:output events and is drawn by vt.js.
 * Ctrl+` (close the terminal), F1 and Ctrl+Shift+P stay with the app; every other key goes to the
 * shell, as in any terminal.
 */

const shells = new Map(); // id -> { term, title, ended, queue }
let active = 'commands';
let status = { available: false, reason: 'Checking...', shell: '' };
let resizeTimer = null;

const APP_KEYS = (e) => (e.ctrlKey && e.key === '`') || e.key === 'F1' || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p');

function renderTabs() {
  const tab = (id, label, close) =>
    h('button', { type: 'button', class: `term-tab${active === id ? ' active' : ''}`, role: 'tab', 'aria-selected': String(active === id), onclick: () => select(id) },
      label,
      close && h('span', { class: 'tab-close', title: 'Close this shell', onclick: (e) => { e.stopPropagation(); close(); } }, '×'));
  $('#term-tabs').replaceChildren(
    tab('commands', 'commands'),
    ...[...shells.entries()].map(([id, s]) => tab(id, `${s.title}${s.ended ? ' (ended)' : ''}`, () => closeShell(id))),
    h('button', { type: 'button', class: 'term-tab add', title: status.available ? `A new ${status.shell} in the folder: interactive programs work there` : status.reason, onclick: openShell }, '+ shell'),
  );
}

function select(id) {
  active = id;
  $('#terminal-view').hidden = id !== 'commands';
  for (const [sid, s] of shells) s.term.el.hidden = sid !== id;
  renderTabs();
  const s = shells.get(id);
  if (s) {
    fitActive();
    s.term.focus();
  }
}

/** Keys reach the shell one request at a time, so they arrive in the order they were typed. */
function send(id, data) {
  const s = shells.get(id);
  if (!s || s.ended || !data) return;
  s.queue = s.queue.then(() => api.ptyInput(id, data)).catch(() => {});
}

function add(id, title) {
  const term = new Terminal({ reply: (text) => send(id, text) });
  const s = { term, title, ended: false, queue: Promise.resolve() };
  shells.set(id, s);
  term.el.hidden = true;
  $('#shell-views').append(term.el);

  const input = term.input;
  input.addEventListener('keydown', (e) => {
    if (APP_KEYS(e)) return; // let the app have it
    const mod = e.ctrlKey || e.metaKey;
    const picked = String(getSelection());
    // Copy with Ctrl+C when text is selected (as Windows Terminal does), always with Ctrl+Shift+C.
    if (mod && e.key.toLowerCase() === 'c' && (picked || e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      if (picked) navigator.clipboard?.writeText(picked).catch(() => {});
      return;
    }
    // Paste arrives as a paste event.
    if (mod && e.key.toLowerCase() === 'v') {
      e.stopPropagation();
      return;
    }
    const data = term.keyData(e);
    e.stopPropagation(); // the shell's keys are not the app's shortcuts
    if (data !== null) {
      e.preventDefault();
      send(id, data);
    }
  });
  // Typed text (and what an IME composes) arrives here.
  input.addEventListener('input', (e) => {
    if (e.isComposing) return;
    if (input.value) send(id, input.value);
    input.value = '';
  });
  input.addEventListener('compositionend', () => {
    if (input.value) send(id, input.value);
    input.value = '';
  });
  input.addEventListener('paste', (e) => {
    e.preventDefault();
    send(id, term.pasteData(e.clipboardData?.getData('text') ?? ''));
  });
  // Click to type, unless you are selecting text to copy.
  term.el.addEventListener('mouseup', () => {
    if (!String(getSelection())) term.focus();
  });
  return s;
}

async function openShell() {
  if (!status.available) {
    await refresh();
    if (!status.available) return toast(status.reason, 'err');
  }
  const views = $('#shell-views');
  views.hidden = false;
  try {
    const opened = await api.ptyOpen({ cols: 100, rows: 30 });
    if (!shells.has(opened.id)) add(opened.id, opened.title);
    select(opened.id);
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function closeShell(id) {
  const s = shells.get(id);
  if (!s) return;
  if (!s.ended) await api.ptyClose(id).catch(() => {});
  s.term.el.remove();
  shells.delete(id);
  if (active === id) select('commands');
  else renderTabs();
}

/** The active shell's size follows its box: the screen here and the shell's on the server. */
function fitActive() {
  const s = shells.get(active);
  if (!s || s.term.el.hidden || !s.term.el.clientWidth) return;
  const { cols, rows } = s.term.fit();
  if (cols === s.term.screen.cols && rows === s.term.screen.rows) return;
  s.term.resize(cols, rows);
  if (!s.ended) api.ptyResize(active, cols, rows).catch(() => {});
}

async function refresh() {
  try {
    status = await api.ptyStatus();
  } catch {
    status = { available: false, reason: 'Kadhai is not answering.', open: [] };
  }
  // Shells still open on the server (this page was reloaded): pick them up with what they showed.
  for (const open of status.open ?? []) {
    if (shells.has(open.id)) continue;
    const s = add(open.id, open.title);
    const { data } = await api.ptyReplay(open.id).catch(() => ({ data: '' }));
    s.term.write(data);
  }
  for (const [id, s] of shells) if (!(status.open ?? []).some((o) => o.id === id)) s.ended = true;
  $('#shell-views').hidden = !shells.size;
  renderTabs();
}

export function initShell() {
  on('sync', refresh);
  on('execmode', refresh);
  on('pty', (event) => {
    const s = shells.get(event.id);
    if (event.type === 'output' && s) s.term.write(event.data);
    else if (event.type === 'exit' && s && !s.ended) {
      s.ended = true;
      s.term.write(`\r\n\x1b[2m[the shell has ended${event.code != null ? ` (exit code ${event.code})` : ''}]\x1b[0m\r\n`);
      renderTabs();
    }
  });
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitActive, 80);
  }).observe($('#shell-views'));
  renderTabs();
}
