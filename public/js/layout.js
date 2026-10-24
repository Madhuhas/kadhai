/**
 * The window layout. Locked (the default) is the usual grid. Unlocked, the files and chat
 * windows can be made wider or narrower by dragging their inner edge (or with the arrow keys
 * on it), and any window - files, stage, chat, flows - can fill the screen with its [] button
 * or a double-click on its title bar. Locking puts everything back the way it was.
 * Kept per browser: it is a preference, not something the server needs to know.
 */
import { $, h, prefs } from './util.js';

const WINDOWS = { files: '.files-col', stage: '.stage', chat: '.chat-col' };
const NAMES = { files: 'files', stage: 'stage', chat: 'chat', flows: 'flows' };
const MIN = { files: 160, chat: 260, stage: 440 };
const STEP = 16;

let layout = read();

function read() {
  try {
    const saved = JSON.parse(prefs.get('layout', 'null'));
    if (saved && typeof saved === 'object') {
      return {
        locked: saved.locked !== false,
        files: width(saved.files),
        chat: width(saved.chat),
        max: WINDOWS[saved.max] ? saved.max : null,
      };
    }
  } catch {
    // A damaged preference just means the default layout.
  }
  return { locked: true, files: null, chat: null, max: null };
}

function width(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function save() {
  prefs.set('layout', layout.locked ? null : JSON.stringify(layout));
}

function apply() {
  const app = $('#app');
  app.classList.toggle('unlocked', !layout.locked);
  app.classList.toggle('sized', !layout.locked && Boolean(layout.files || layout.chat));
  for (const key of ['files', 'chat']) {
    if (!layout.locked && layout[key]) app.style.setProperty(`--${key}-w`, `${layout[key]}px`);
    else app.style.removeProperty(`--${key}-w`);
  }
  if (layout.max && !layout.locked) app.dataset.max = layout.max;
  else delete app.dataset.max;

  const button = $('#layout-btn');
  button.classList.toggle('on', !layout.locked);
  button.setAttribute('aria-label', layout.locked ? 'Layout locked' : 'Layout unlocked');
  button.title = layout.locked
    ? 'Layout locked to the default. Click to unlock: drag window edges to resize, open any window full screen'
    : 'Layout unlocked: drag the edges of the files and chat windows, or press [] on a window. Click to lock it back to the default';

  // Its twin in the phone's "more" menu.
  $('#more-layout').firstChild.textContent = layout.locked ? 'unlock layout ' : 'lock layout ';

  const flows = $('#flows-dialog');
  if (layout.locked) flows.classList.remove('full');
  for (const btn of document.querySelectorAll('.win-max')) {
    const win = btn.dataset.win ?? 'flows';
    const full = win === 'flows' ? flows.classList.contains('full') : layout.max === win;
    btn.hidden = layout.locked;
    btn.textContent = full ? '][' : '[]';
    btn.title = full ? 'Back to the normal size (Esc)' : 'Full screen';
    btn.setAttribute('aria-label', full ? `Show the ${NAMES[win]} window at its normal size` : `Show the ${NAMES[win]} window full screen`);
    btn.setAttribute('aria-pressed', String(full));
  }
  requestAnimationFrame(describeEdges);
  save();
}

function toggleMax(win) {
  if (layout.locked) return;
  if (win === 'flows') $('#flows-dialog').classList.toggle('full');
  else layout.max = layout.max === win ? null : win;
  apply();
}

/** The current width of a window, as drawn. */
function drawn(key) {
  return $(WINDOWS[key]).getBoundingClientRect().width;
}

/** Widths that leave the stage at least its minimum. */
function clampWidth(key, value) {
  const room = drawn('stage') + drawn(key) - MIN.stage;
  return Math.round(Math.max(MIN[key], Math.min(value, room)));
}

function resize(key, value) {
  // The other window keeps the width it has now, so moving one edge never moves the other.
  const other = key === 'files' ? 'chat' : 'files';
  if (!layout[other]) layout[other] = Math.round(drawn(other));
  layout[key] = clampWidth(key, value);
  apply();
}

function reset(key) {
  layout[key] = null;
  apply();
}

function describeEdges() {
  for (const edge of document.querySelectorAll('.win-edge')) {
    edge.setAttribute('aria-valuenow', String(Math.round(drawn(edge.dataset.win))));
  }
}

/** A drag handle on a window's inner edge: the files window's right edge, the chat window's left one. */
function edge(key) {
  const sign = key === 'files' ? 1 : -1;
  const el = h('div', {
    class: 'win-edge',
    role: 'separator',
    tabindex: '0',
    'aria-orientation': 'vertical',
    'aria-label': `Width of the ${key} window`,
    'aria-valuemin': String(MIN[key]),
    title: 'Drag to resize, double-click for the default width',
  });
  el.dataset.win = key;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || layout.locked) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = drawn(key);
    const app = $('#app');
    app.classList.add('resizing');
    el.classList.add('dragging');
    const move = (ev) => resize(key, startW + sign * (ev.clientX - startX));
    const end = () => {
      app.classList.remove('resizing');
      el.classList.remove('dragging');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  });
  el.addEventListener('dblclick', () => reset(key));
  el.addEventListener('keydown', (e) => {
    const by = { ArrowRight: STEP * sign, ArrowLeft: -STEP * sign }[e.key];
    if (by) {
      e.preventDefault();
      resize(key, drawn(key) + by);
    } else if (e.key === 'Home') {
      e.preventDefault();
      reset(key);
    }
  });
  return el;
}

export function initLayout() {
  $('.files-col').append(edge('files'));
  $('.chat-col').append(edge('chat'));

  $('#layout-btn').onclick = () => {
    layout = layout.locked ? { ...layout, locked: false } : { locked: true, files: null, chat: null, max: null };
    apply();
  };
  for (const btn of document.querySelectorAll('.win-max')) btn.onclick = () => toggleMax(btn.dataset.win ?? 'flows');

  // On a phone the taskbar's buttons live in the "more" menu: each entry presses the real one.
  for (const item of document.querySelectorAll('[data-proxy]')) {
    item.onclick = () => {
      $('#more-menu').open = false;
      $(`#${item.dataset.proxy}`).click();
    };
  }

  // A double-click on a title bar (not on a button or a tab in it) does the same as its [] button.
  const heads = [
    ['files', $('.files-col > .panel-head')],
    ['chat', $('.chat-col > .panel-head')],
    ['stage', $('.stage-head')],
    ['flows', $('#flows-dialog > .panel-head')],
  ];
  for (const [win, head] of heads) {
    head.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, a, input, select')) return;
      toggleMax(win);
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !layout.max || document.querySelector('dialog:modal')) return;
    layout.max = null;
    apply();
  });

  apply();
}
