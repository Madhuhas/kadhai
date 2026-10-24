/**
 * Everything in Kadhai that is not plain text is ASCII art: here the crew's
 * one-line faces and colours, the spinner, the banner and the hand-drawn pot
 * (the About panel); the kitchen scene and its cooks are in kitchen.js.
 * No images, no emoji, no SVG.
 *
 * One timer drives every animation. It rests while the tab is hidden, and
 * with "reduce motion" switched on everything is drawn once and stays still.
 */

import { state } from './store.js';

// ------------------------------------------------------------------- ticker

const TICK_MS = 90;
const live = new Set(); // { el, draw(tick), missed }
const still = window.matchMedia('(prefers-reduced-motion: reduce)');
let tick = 0;
let timer = null;

function step() {
  if (document.hidden) return;
  tick += 1;
  for (const item of live) {
    if (!item.el.isConnected) {
      // Not attached yet, or re-rendered away: give it a moment, then forget it.
      if ((item.missed += 1) > 30) live.delete(item);
      continue;
    }
    item.missed = 0;
    item.draw(tick);
  }
  if (!live.size) {
    clearInterval(timer);
    timer = null;
  }
}

/** Draw now, and again on every tick for as long as the element is on the page. */
function animate(el, draw) {
  draw(tick);
  if (still.matches) return el;
  live.add({ el, draw, missed: 0 });
  timer ??= setInterval(step, TICK_MS);
  return el;
}

const setText = (el, text) => {
  if (el.textContent !== text) el.textContent = text;
};

function hash(text) {
  let n = 2166136261;
  for (const ch of text) n = Math.imul(n ^ ch.charCodeAt(0), 16777619);
  return n >>> 0;
}

/** A cheap, repeatable scramble of two integers. */
const mix = (a, b) => (Math.imul(Math.imul(a, 73856093) ^ Math.imul(b, 19349663), 2654435761) >>> 9) & 0xffff;

// ----------------------------------------------------------------- spinners

const SPIN = '|/-\\';

/** A character that turns while something is in progress. */
export function spinner() {
  const el = document.createElement('span');
  el.className = 'ascii-spin';
  el.setAttribute('aria-hidden', 'true');
  return animate(el, (t) => setText(el, SPIN[(t >> 1) & 3]));
}

// ------------------------------------------------------------------ the crew

/*
 * Each agent is a small 3D cook (ascii3d.js) told apart by its hat, its head and the
 * tool in its hand, the way a real brigade is. The look below decides those; `mini`
 * is the one-line face used in lists, tabs and buttons.
 */
const HEADS = { round: '()', square: '||', angle: '<>', curly: '{}' };
const EYES = ['o o', '0-0', '. .', '^ ^', '* *', "' '", '- o'];
const TOOLS = ['o', 'U', 'Y', '*', 'O', '#', '%', '&'];

const HOUSE = {
  'general-manager': { hat: 'toque', head: 'square', tool: '#', mini: '[o_o]' }, // a clipboard
  'executive-chef': { hat: 'tall', head: 'round', tool: 'o', mini: '{o_o}' }, // a ladle
  'head-chef': { hat: 'puff', head: 'round', tool: 'O', mini: '(0-0)' }, // a tasting spoon
  'sous-chef': { hat: 'bandana', head: 'round', tool: 'Y', mini: '(o_o)' }, // a whisk
  'chef-de-partie': { hat: 'cap', head: 'round', tool: 'U', mini: '<o_o>' }, // a pan
  commis: { hat: 'beanie', head: 'round', tool: '*', mini: '(._.)' }, // seasoning
};

/** A stable look for an agent we have never seen before, derived from its id. */
function customLook(id) {
  const n = hash(id);
  const pick = (list, shift) => list[(n >>> shift) % list.length];
  const eyes = pick(EYES, 3);
  const head = pick(Object.keys(HEADS), 9);
  return {
    hat: pick(['tall', 'puff', 'bandana', 'cap', 'beanie'], 0),
    head,
    tool: pick(TOOLS, 20),
    mini: `${HEADS[head][0]}${eyes[0]}_${eyes[2]}${HEADS[head][1]}`,
  };
}

const looks = new Map();
function lookOf(id) {
  if (!looks.has(id)) looks.set(id, HOUSE[id] ?? customLook(id));
  return looks.get(id);
}

// Where the mouse is, for the cooks to look at; and when it last moved (a still mouse lets them doze).
const pointer = { x: -1, y: -1, at: performance.now() };
let watching = false;
function watchPointer() {
  if (watching) return;
  watching = true;
  window.addEventListener('pointermove', (e) => Object.assign(pointer, { x: e.clientX, y: e.clientY, at: performance.now() }), { passive: true });
}

export const face = (id) => lookOf(id).mini;

/*
 * Every agent has a colour of its own, so you can tell at a glance who is
 * working, who ran a command, and who is talking. Only the hue is fixed here;
 * the stylesheet picks a lightness that reads on the theme in use.
 */
const HUES = { 'general-manager': 215, 'executive-chef': 20, 'head-chef': 275, 'sous-chef': 145, 'chef-de-partie': 188, commis: 42 };
const TAKEN = Object.values(HUES);

/** A hired agent's hue comes from its id, nudged away from the house crew's so it is not mistaken for one of them. */
export function defaultHue(id) {
  if (id in HUES) return HUES[id];
  let hue = hash(id) % 360;
  for (let tries = 0; tries < 12 && TAKEN.some((t) => Math.min(Math.abs(t - hue), 360 - Math.abs(t - hue)) < 14); tries += 1) hue = (hue + 29) % 360;
  return hue;
}

/** The colour the user picked for this agent, or else its usual one. */
export function hueOf(id) {
  const own = state.agents[id]?.hue;
  return Number.isInteger(own) ? own : defaultHue(id);
}

/** Inline style that carries an agent's colour to an element with the class "tinted". */
export const tintOf = (id) => `--agent-h:${hueOf(id)}`;

// ------------------------------------------------------------------- banner

export const BANNER = [
  ' _  __         _ _           _ ',
  '| |/ /__ _  __| | |__   __ _(_)',
  "| ' // _` |/ _` | '_ \\ / _` | |",
  '| . \\ (_| | (_| | | | | (_| | |',
  '|_|\\_\\__,_|\\__,_|_| |_|\\__,_|_|',
].join('\n');

/** The kadhai in one line, for the taskbar. */
export const MARK = '\\___/';

// ------------------------------------------------------------ the cooking pot

/*
 * The pot in the middle of the kitchen. It is drawn by hand, line by line, so
 * it reads cleanly at a glance; only the things that move are worked out per
 * frame: the lid rattling, froth escaping under it, steam, and the flames.
 * At rest it is a still drawing - lid on, stove off - and no timer runs for it.
 */
const W = 58;
const H = 23;
const LID = [
  '___',
  '_(___)_',
  "_..-----'       '-----.._",
  ".-'                         '-.",
  '(_______________________________)',
];
const RIM = '(===================================)';
const BODY = [
  ' .--.|                           .::::|.--. ',
  '( (  |                           .::::|  ) )',
  " '--'|                           .::::|'--' ",
  '|                           .::::|',
  '\\                         .::::/',
  "'.                      .:::.'",
  "'-.._____________________..-'",
];
const STOVE = ['_[=============================]_', '|_________________________________|'];
const LID_ROW = 6; // where the lid starts when it is resting on the pot
const RIM_ROW = LID_ROW + LID.length;
const FLAME_ROW = RIM_ROW + 1 + BODY.length; // the gap between the pot and the stove, where the grate is
const FROTH = 'oO.o*O';

/** One frame, as H lines of text. */
export function renderPot(time, cooking) {
  const cells = new Array(W * H).fill(' ');
  const set = (col, row, ch) => {
    if (col >= 0 && col < W && row >= 0 && row < H && ch !== ' ') cells[row * W + col] = ch;
  };
  const blank = (col, row) => col >= 0 && col < W && row >= 0 && row < H && cells[row * W + col] === ' ';
  const centred = (line, row, shift = 0) => {
    const start = Math.round((W - line.length) / 2) + shift;
    for (let i = 0; i < line.length; i += 1) set(start + i, row, line[i]);
  };

  // The lid rattles: up for a beat, down for a beat, with a hop to one side now and then.
  const beat = Math.floor(time * 5);
  const up = cooking && beat % 2 === 0;
  const lean = up ? (mix(beat, 7) % 3) - 1 : 0;

  centred(RIM, RIM_ROW);
  BODY.forEach((line, i) => centred(line, RIM_ROW + 1 + i));
  STOVE.forEach((line, i) => centred(line, FLAME_ROW + 1 + i));
  // The grate the pot stands on.
  for (const offset of [-11, -4, 4, 11]) set(W / 2 + offset, FLAME_ROW, '|');
  LID.forEach((line, i) => centred(line, LID_ROW + i - (up ? 1 : 0), lean));

  if (cooking) {
    // Froth showing in the gap while the lid is up, and a puff of steam out of each side.
    if (up) {
      for (let col = W / 2 - 15; col <= W / 2 + 15; col += 1) {
        const n = mix(col, beat);
        if (n % 3 === 0) set(col, RIM_ROW - 1, FROTH[n % FROTH.length]);
      }
      for (const side of [-1, 1]) {
        const edge = W / 2 + side * 18;
        set(edge, RIM_ROW - 1, '~');
        set(edge + side * 2, RIM_ROW - 2, "'");
      }
    }
    // Steam: wisps that curl as they climb from the lid, and thin out towards the top.
    const scroll = Math.floor(time * 6);
    for (let i = 0; i < 5; i += 1) {
      const base = W / 2 + (i - 2) * 7;
      // The lid is a dome: the wisps in the middle start higher than the ones at its edge.
      const from = LID_ROW + (i === 2 ? -1 : Math.abs(i - 2) === 1 ? 1 : 2) - (up ? 1 : 0);
      for (let row = from; row >= 0; row -= 1) {
        const height = from - row;
        if ((row + scroll + i * 2) % 5 >= (height > 3 ? 2 : 3)) continue; // gaps, wider up high
        const bend = row * 0.6 + time * 2.2 + i * 1.7;
        const col = Math.round(base + Math.sin(bend) * (1 + height * 0.3));
        if (blank(col, row)) set(col, row, height > 4 ? (Math.cos(bend) > 0 ? "'" : '.') : Math.cos(bend) > 0 ? ')' : '(');
      }
    }
    // Flames: a flickering bed under the pot, with taller tongues licking up round its sides.
    const flick = Math.floor(time * 10);
    for (let col = W / 2 - 17; col <= W / 2 + 17; col += 1) {
      const out = Math.abs(col - W / 2);
      const n = mix(col, flick);
      const lively = n % 3 > 0;
      set(col, FLAME_ROW, cells[FLAME_ROW * W + col] === '|' ? '|' : !lively ? "'" : (col + flick) % 2 ? '(' : ')');
      // Beside the pot there is room to climb; under it there is not.
      const height = out >= 15 ? 1 + (n % 3) : 0;
      for (let k = 1; k <= height; k += 1) if (blank(col, FLAME_ROW - k)) set(col, FLAME_ROW - k, k === height ? '^' : (col + k + flick) % 2 ? ')' : '(');
    }
  }

  const lines = [];
  for (let row = 0; row < H; row += 1) lines.push(cells.slice(row * W, (row + 1) * W).join('').trimEnd());
  return lines.join('\n');
}

/** The hand-drawn pot, still: for small places (the About panel). */
export function potDrawing() {
  const el = document.createElement('pre');
  el.className = 'ascii-scene small';
  el.setAttribute('aria-hidden', 'true');
  el.textContent = renderPot(0.3, false);
  return el;
}

// ------------------------------------------------------------------ the flame

/** The two flames under the kadhai: low (free tiers, small prompts) and high (everything). */
export const FLAME_ART = {
  low: ['       ', '   .   ', '  (_)  ', ' ~~~~~ '].join('\n'),
  high: ['  ) (  ', ' ( ) ) ', ' )(_)( ', ' ~~~~~ '].join('\n'),
};

// The kitchen scene (kitchen.js) shares the timer, the mouse and the crew's looks.
export { animate, still, pointer, watchPointer, lookOf };
