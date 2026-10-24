import { $, h, toast } from './util.js';
import { state, on, emit } from './store.js';
import { api } from './api.js';
import { face, tintOf } from './ascii.js';

/**
 * The terminal: a window opened from the taskbar that can stay open while you
 * work. It shows every command run in the folder, yours and the crew's, with
 * its output, and has a prompt to type your own.
 *
 * It is a command runner, not a full terminal: each line you type is run as
 * its own command in the folder (or in the sub-folder you "cd" to), and the
 * output is shown when it arrives. A program cannot ask you questions here.
 */
const OUTPUT_CAP = 200000;
const entries = new Map(); // command id -> its parts on screen
const history = []; // what you typed, oldest first
let cursor = 0; // where the up and down arrows are in that history
let dir = ''; // the sub-folder you have moved to, '' for the folder itself

/*
 * Shell colours, like a terminal with syntax highlighting: the program in yellow,
 * flags, strings, operators (| && ; >), variables and comments each in their own.
 * Pieces are put in spans with textContent, so a command is never read as HTML.
 */
const SHELL_TOKENS = [
  ['space', /^\s+/],
  ['comment', /^#.*/],
  ['string', /^"(?:[^"\\]|\\.)*"?|^'[^']*'?/],
  ['op', /^(?:&&|\|\||\d?>>?(?:&\d)?|[|;&<])/],
  ['var', /^(?:\$\{?[\w:]+\}?|%\w+%)/],
  ['word', /^[^\s"'|;&<>]+/],
];

/** A command line as [{ kind, text }]: kind is program, flag, string, op, var, number, comment, arg or space. */
export function shellTokens(line) {
  const tokens = [];
  let rest = String(line);
  let expectProgram = true;
  while (rest) {
    const [kind, re] = SHELL_TOKENS.find(([, re]) => re.test(rest)) ?? ['arg', /^./];
    const text = re.exec(rest)[0];
    rest = rest.slice(text.length);
    let shown = kind;
    if (kind === 'word') {
      if (expectProgram) shown = 'program';
      else if (/^--?[\w-]/.test(text)) shown = 'flag';
      else if (/^\d+(\.\d+)?$/.test(text)) shown = 'number';
      else shown = 'arg';
    }
    if (kind !== 'space') expectProgram = kind === 'op' && !/>|</.test(text);
    tokens.push({ kind: shown, text });
  }
  return tokens;
}

// Programs looked up on this computer: name -> true (installed) / false (not found). Unknown until asked.
const installed = new Map();
let lookup = null;

/** Ask the server, in one go, about every program name not looked up yet; then call back to repaint. */
function checkPrograms(names, then) {
  const unknown = [...new Set(names.map((n) => n.toLowerCase()))].filter((n) => !installed.has(n) && /^[\w.+-]{1,64}$/.test(n));
  if (!unknown.length) return;
  clearTimeout(lookup);
  lookup = setTimeout(() => {
    api
      .which(unknown)
      .then(({ found }) => {
        for (const [name, ok] of Object.entries(found)) installed.set(name, ok);
        then();
      })
      .catch(() => {});
  }, 250);
}

/** A command as coloured pieces; a program known not to be installed is shown in red. */
export const colourLine = (line) =>
  shellTokens(line).map((t) => {
    if (t.kind === 'space') return t.text;
    const missing = t.kind === 'program' && installed.get(t.text.toLowerCase()) === false && !/[\\/]/.test(t.text);
    return h('span', { class: `sh-${t.kind}${missing ? ' sh-missing' : ''}`, title: missing ? 'Not found on this computer' : null }, t.text);
  });

// Escape codes for colour and cursor movement: shown as text, they are noise.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/**
 * Commands that serve or watch until stopped. Typed in the terminal they keep running
 * (no time limit) instead of being cut off; ending a command with " &" does the same.
 */
const KEEPS_RUNNING = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|watch)\b|(?:npx\s+|bunx\s+)?(?:vite|next\s+dev|nuxt\s+dev|astro\s+dev|live-server|http-server|serve|nodemon)\b|python3?\s+-m\s+http\.server\b|py\s+-m\s+http\.server\b|php\s+-S\b|(?:flask|uvicorn)\b|node\s+--watch\b)/i;

const promptText = () => `~/${dir}${dir ? '/' : ''} $`;
const agentOf = (owner) => state.agents[owner] ?? null;
const who = (owner) => (agentOf(owner) ? `${face(owner)} ${agentOf(owner).name}` : 'you');

function scrollDown() {
  const log = $('#term-log');
  log.scrollTop = log.scrollHeight;
}

/** A plain line of our own: a note, or an answer to a built-in like "cd". */
function note(text, cls = '') {
  $('#term-log').append(h('div', { class: `term-note ${cls}` }, text));
  scrollDown();
}

function build(info) {
  const out = h('pre', { class: 'term-out' });
  const foot = h('span', { class: 'term-foot' });
  const actions = h('span', { class: 'term-actions' });
  const agent = agentOf(info.owner);
  const el = h(
    'div',
    { class: `term-entry${agent ? ' tinted' : ''}`, style: agent ? tintOf(info.owner) : null },
    h('div', { class: 'term-cmd' }, h('span', { class: 'term-who' }, who(info.owner)), h('span', { class: 'term-dir' }, ` ~/${info.dir ?? ''} $ `), h('span', { class: 'term-line' }, colourLine(info.command))),
    out,
    h('div', { class: 'term-status' }, foot, actions),
  );
  const entry = { id: info.id, el, out, foot, actions, chars: 0, keep: Boolean(info.keep), url: info.url ?? null };
  entries.set(info.id, entry);
  $('#term-log').append(el);
  return entry;
}

const act = (promise) => promise.catch((err) => toast(err.message, 'err'));
const button = (label, onclick) => h('button', { class: 'term-btn', type: 'button', onclick }, label);

function setPhase(entry, phase, info = {}) {
  entry.actions.replaceChildren();
  entry.el.dataset.phase = phase;
  if (phase === 'request') {
    entry.foot.textContent = 'waiting for your OK';
    entry.actions.append(button('run', () => act(api.execAction(entry.id, 'approve'))), button('deny', () => act(api.execAction(entry.id, 'deny'))));
  } else if (phase === 'denied') {
    entry.foot.textContent = 'denied';
  } else if (phase === 'running') {
    entry.foot.textContent = entry.keep ? (entry.url ? `serving ${entry.url}` : 'keeps running until you stop it') : 'running...';
    if (entry.url) entry.actions.append(button('open', () => emit('browsertab', entry.url)));
    entry.actions.append(button('stop', () => act(api.execAction(entry.id, 'kill'))));
  } else if (phase === 'end') {
    const ok = info.code === 0;
    entry.el.dataset.phase = ok ? 'ok' : 'fail';
    const how = info.timedOut ? 'timed out' : info.killed ? 'stopped' : `exit ${info.code}`;
    entry.foot.textContent = `${how} · ${((info.durationMs ?? 0) / 1000).toFixed(1)}s`;
    // The final output is authoritative (and already clipped by the server). Say so when there is none.
    entry.out.textContent = (info.output || '').replace(ANSI, '');
    if (!info.output) entry.out.append(h('span', { class: 'term-quiet' }, ok ? '(finished, and printed nothing)' : '(no output)'));
    // A server cut off by the time limit: say how to keep one running.
    if (info.timedOut && info.owner === 'user') entry.out.append(h('div', { class: 'term-quiet' }, 'Tip: end a command with " &" to keep it running until you stop it (dev servers are kept running by themselves).'));
  }
}

/** The taskbar button says when a command is waiting for your OK, so you notice with the window closed. */
function renderButton() {
  const waiting = state.exec.pending.length;
  const count = $('#term-count');
  count.hidden = !waiting;
  count.textContent = String(waiting);
  $('#term-btn').classList.toggle('on', $('#terminal-dialog').open);
}

function onExec(event) {
  if (event.type !== 'output') queueMicrotask(renderButton);
  if (event.type === 'output') {
    const entry = entries.get(event.id);
    if (!entry) return;
    const chunk = event.chunk.replace(ANSI, '');
    entry.chars += chunk.length;
    if (entry.chars <= OUTPUT_CAP) entry.out.append(chunk);
    else if (entry.keep) {
      // A server talks for hours: keep its newest output.
      entry.out.textContent = (entry.out.textContent + chunk).slice(-OUTPUT_CAP / 2);
      entry.chars = entry.out.textContent.length;
    }
    scrollDown();
    return;
  }
  if (event.type === 'port') {
    const entry = entries.get(event.id);
    if (!entry) return;
    entry.url = event.url;
    if (entry.el.dataset.phase === 'running') setPhase(entry, 'running');
    return;
  }
  const entry = entries.get(event.id) ?? build(event);
  if (event.type === 'request') setPhase(entry, 'request');
  else if (event.type === 'resolved') setPhase(entry, event.approved ? 'running' : 'denied');
  else if (event.type === 'start') setPhase(entry, 'running');
  else if (event.type === 'end') setPhase(entry, 'end', event);
  scrollDown();
}

/** Rebuild from what the server remembers: finished commands, then anything still waiting or running. */
function rebuild() {
  entries.clear();
  $('#term-log').replaceChildren(h('div', { class: 'term-note' }, 'Commands run in the folder that is open. Type one below; "cd" moves between its sub-folders, "clear" empties this view. The crew\'s commands show up here too.'));
  for (const message of state.chat) {
    if (message.role !== 'exec') continue;
    setPhase(build(message), message.denied ? 'denied' : 'end', message);
  }
  for (const info of state.exec.pending) setPhase(build(info), 'request');
  for (const info of state.exec.running) setPhase(build(info), 'running');
  dir = '';
  $('#term-prompt').textContent = promptText();
  scrollDown();
}

/** "cd" is ours to handle: every command is its own process, so the folder has to be remembered here. */
async function changeDir(target) {
  const parts = dir ? dir.split('/') : [];
  if (!target || target === '~' || target === '/') parts.length = 0;
  else {
    if (/^([a-z]:|[\\/])/i.test(target)) return note('cd: stay inside the open folder - use a path relative to it', 'err');
    for (const part of target.replace(/\\/g, '/').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!parts.length) return note('cd: already at the top of the open folder', 'err');
        parts.pop();
      } else parts.push(part);
    }
  }
  const next = parts.join('/');
  if (next) {
    const { files } = await api.files();
    if (!files.some((f) => f.type === 'dir' && f.path === next)) return note(`cd: no such folder: ${next}`, 'err');
  }
  dir = next;
  $('#term-prompt').textContent = promptText();
}

async function submit(line) {
  const text = line.trim();
  if (!text) return;
  if (history.at(-1) !== text) history.push(text);
  cursor = history.length;

  if (text === 'clear' || text === 'cls') {
    entries.clear();
    $('#term-log').replaceChildren();
    return;
  }
  const cd = /^cd(?:\s+(.*))?$/.exec(text);
  if (cd) {
    note(`${promptText()} ${text}`);
    return changeDir((cd[1] ?? '').trim().replace(/^"(.*)"$/, '$1')).catch((err) => note(`cd: ${err.message}`, 'err'));
  }
  // "... &" or a known dev server: keep it running, without the usual time limit.
  const background = /\s&$/.test(text);
  const command = background ? text.replace(/\s*&$/, '') : text;
  const keep = background || KEEPS_RUNNING.test(command);
  try {
    await api.exec(command, dir, keep);
  } catch (err) {
    note(`${promptText()} ${text}`);
    note(err.message, 'err');
  }
}

/**
 * Tab: finish the file or folder name being typed, from the open folder (relative to
 * where "cd" left you). One match is filled in; several fill in what they share, and a
 * second Tab lists them.
 */
let lastTab = { at: 0, line: '' };
async function complete(input) {
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const start = Math.max(before.lastIndexOf(' '), before.lastIndexOf('"')) + 1;
  const word = before.slice(start).replace(/\\/g, '/');
  const slash = word.lastIndexOf('/');
  const typedDir = slash >= 0 ? word.slice(0, slash) : '';
  const prefix = word.slice(slash + 1).toLowerCase();
  const base = [dir, typedDir].filter(Boolean).join('/').replace(/^\.\//, '');
  let files;
  try {
    ({ files } = await api.files());
  } catch {
    return;
  }
  const matches = files
    .filter((f) => {
      const parent = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      return parent.toLowerCase() === base.toLowerCase() && f.path.split('/').pop().toLowerCase().startsWith(prefix);
    })
    .map((f) => ({ name: f.path.split('/').pop(), folder: f.type === 'dir' }));
  if (!matches.length) return;
  let fill;
  if (matches.length === 1) fill = matches[0].name + (matches[0].folder ? '/' : ' ');
  else {
    // What every match starts with (compared without case, written as the first match spells it).
    let shared = matches[0].name;
    for (const m of matches) while (!m.name.toLowerCase().startsWith(shared.toLowerCase())) shared = shared.slice(0, -1);
    fill = shared;
    const again = lastTab.line === input.value && Date.now() - lastTab.at < 1500;
    if (shared.length <= prefix.length && again) note(matches.map((m) => m.name + (m.folder ? '/' : '')).slice(0, 40).join('   '));
  }
  const head = before.slice(0, start) + (typedDir ? `${typedDir}/` : '');
  const name = / /.test(fill.trim()) && !before.slice(0, start).endsWith('"') ? `"${fill.trim()}"${fill.endsWith(' ') ? ' ' : ''}` : fill;
  input.value = head + name + input.value.slice(caret);
  const at = (head + name).length;
  input.setSelectionRange(at, at);
  lastTab = { at: Date.now(), line: input.value };
}

export function initTerminal() {
  const input = $('#term-input');
  const view = $('#terminal-view');
  const mirror = $('#term-mirror');
  // The coloured copy follows the input: its text, and its sideways scroll on a long line.
  const paint = () => {
    mirror.replaceChildren(...colourLine(input.value));
    mirror.scrollLeft = input.scrollLeft;
    // Program names not looked up yet: ask once, then paint again (red if not installed).
    checkPrograms(shellTokens(input.value).filter((t) => t.kind === 'program' && !/[\\/]/.test(t.text)).map((t) => t.text), paint);
  };
  for (const type of ['input', 'keyup', 'scroll', 'select', 'focus', 'blur']) input.addEventListener(type, paint);

  const dialog = $('#terminal-dialog');
  const show = () => {
    // Not modal: the rest of the app stays usable with the terminal open.
    if (!dialog.open) dialog.show();
    renderButton();
    scrollDown();
    input.focus();
  };
  const hide = () => {
    dialog.close();
    renderButton();
  };

  on('sync', () => {
    rebuild();
    renderButton();
  });
  on('exec', onExec);
  // Something elsewhere (the Run button on a file) wants the terminal in view.
  on('openterminal', show);
  $('#term-btn').onclick = () => (dialog.open ? hide() : show());
  $('#term-close').onclick = hide;
  $('#term-size').onclick = () => {
    dialog.classList.toggle('big');
    scrollDown();
  };
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === '`') {
      e.preventDefault();
      if (dialog.open) hide();
      else show();
    } else if (e.key === 'Escape' && dialog.open && dialog.contains(document.activeElement)) hide();
  });

  $('#term-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const line = input.value;
    input.value = '';
    paint();
    submit(line);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' && cursor > 0) {
      e.preventDefault();
      cursor -= 1;
      input.value = history[cursor];
      queueMicrotask(paint);
    } else if (e.key === 'ArrowDown' && cursor < history.length) {
      e.preventDefault();
      cursor += 1;
      input.value = history[cursor] ?? '';
      queueMicrotask(paint);
    } else if (e.key === 'c' && e.ctrlKey && !input.value && input.selectionStart === input.selectionEnd) {
      // Ctrl+C on an empty line stops what you started; servers kept running only when nothing else is.
      const mine = state.exec.running.filter((info) => !agentOf(info.owner));
      const foreground = mine.filter((info) => !info.keep);
      for (const info of foreground.length ? foreground : mine) act(api.execAction(info.id, 'kill'));
    } else if (e.key === 'Tab' && input.value.trim() && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      // On an empty line Tab still moves focus on, so the keyboard can leave the terminal.
      e.preventDefault();
      complete(input).then(paint);
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      submit('clear');
    }
  });
  // Click anywhere in the terminal to type, unless you are selecting text to copy.
  view.addEventListener('click', (e) => {
    if (!String(getSelection()) && !e.target.closest('button')) input.focus();
  });
}
