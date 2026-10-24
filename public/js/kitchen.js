/**
 * The kitchen floor: the 3D kadhai on its stove at the top, and the crew below it, one station
 * each in a row that wraps, so any number of agents fits.
 *
 * The kadhai and the cooks are 3D, rendered as coloured text by ascii3d.js; each cook has its own
 * hat, head and tool (lookOf in ascii.js) and its coat in its own colour. A cook at work walks up
 * to the pot, stirs, and walks back; the others look at the mouse, wave when it comes near, and
 * doze after a quiet spell; after a run they cheer, or the ones whose step failed slump.
 *
 * The run is acted out from what really happens: a ticket flies from the Chef's station to each
 * cook as its step starts (from the Taster, who says "Sent back!", for a fix the review asked for)
 * and the dish flies to the Taster when the step is done. Clicking a cook makes it answer;
 * clicking it again while it talks (or pressing Enter on it) opens its tab.
 *
 * Everything draws only when it changed, rests while the tab is hidden, and is one still frame
 * under "reduce motion" (see animate in ascii.js).
 */
import { state } from './store.js';
import { animate, still, pointer, watchPointer, lookOf, tintOf } from './ascii.js';
import { Grid, drawFigure, drawKadhai, setRamp, FIGURE_W, FIGURE_H, POT_W, POT_H } from './ascii3d.js';

const hash = (text) => {
  let n = 2166136261;
  for (const ch of String(text)) n = Math.imul(n ^ ch.charCodeAt(0), 16777619);
  return n >>> 0;
};

// Each theme shades the 3D kitchen with characters of its own (--ascii-ramp in themes.css).
// Switching theme bumps `styleVersion`, so every figure and the kadhai draw themselves again.
let styleVersion = -1;
const restyle = new Set();
function readLooks() {
  setRamp(getComputedStyle(document.documentElement).getPropertyValue('--ascii-ramp').trim().replace(/^['"]|['"]$/g, ''));
  styleVersion += 1;
  for (const redraw of restyle) redraw();
}
function watchLooks() {
  if (styleVersion >= 0) return;
  readLooks();
  new MutationObserver(readLooks).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

// ------------------------------------------------------------- the cooks

const memory = new Map(); // agent id -> { st, since, jumpAt }: survives the station being drawn again
const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
const q = (v, step = 0.08) => Math.round(v / step) * step;
const WALK = { out: 1400, stir: 3200, back: 1400, home: 3000 }; // one round trip to the pot, in ms
const ROUND = WALK.out + WALK.stir + WALK.back + WALK.home;
const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);

/** Where a working cook's figure stands relative to its station: on the way to the pot, at it, or home. */
function walkOf(el, phase, offset) {
  const floor = el.closest('.floor');
  const hob = floor?.querySelector('.hob .ascii-scene');
  const station = el.closest('.station');
  if (!hob || !station) return null;
  const a = station.getBoundingClientRect();
  const b = hob.getBoundingClientRect();
  // Stand in front of the pot, a little apart from the others.
  const dx = b.left + b.width / 2 + ((offset % 5) - 2) * 26 - (a.left + a.width / 2);
  const dy = b.bottom - 24 - a.top;
  let p;
  let dir = Math.sign(dx) || 1;
  if (phase < WALK.out) p = ease(phase / WALK.out);
  else if (phase < WALK.out + WALK.stir) p = 1;
  else if (phase < WALK.out + WALK.stir + WALK.back) {
    p = 1 - ease((phase - WALK.out - WALK.stir) / WALK.back);
    dir = -dir;
  } else p = 0;
  const walking = phase < WALK.out || (phase >= WALK.out + WALK.stir && phase < WALK.out + WALK.stir + WALK.back);
  return { x: dx * p, y: Math.min(0, dy) * p, walking, dir, atPot: p === 1 };
}

/** How a cook stands right now, from its state, the run, the mouse and the time. */
function poseOf(id, el, st, mem, now, look) {
  const offset = hash(id) % 997;
  const s = (now + offset * 37) / 1000;
  const blink = (now + offset * 61) % 5200 < 140;
  const eyes = blink ? '-' : 'o';
  const done = state.lastRun;
  const coder = state.agents?.[id]?.role === 'coder';
  // The run just ended: everyone cheers, or whoever failed (everyone, if it was not one step) slumps.
  if (done && !state.run && now - done.at < 4500) {
    if (done.ok) return { pose: { armL: [2.6 + 0.25 * Math.sin(s * 9), 0.1], armR: [2.6 + 0.25 * Math.sin(s * 9 + 1), 0.1], bob: 0.14 * Math.abs(Math.sin(s * 6)), eyes: '^' } };
    if (!done.failed.length || done.failed.includes(id)) return { pose: { lean: 0.32, headPitch: 0.42, armL: [0.04, 0], armR: [0.04, 0], bob: -0.05, eyes: '-' }, above: '[!]' };
  }
  if (st === 'working') {
    if (mem.jumpAt && now - mem.jumpAt < 650) {
      const p = (now - mem.jumpAt) / 650;
      return { pose: { bob: 0.45 * Math.sin(Math.PI * p), armL: [1.6, 0], armR: [1.6, 0], eyes: 'o' } };
    }
    const stir = { armR: [0.45 + 0.25 * Math.sin(s * 7), 0.9 + 0.35 * Math.cos(s * 7)], holding: look.tool, eyes };
    if (coder) {
      const walk = walkOf(el, Math.max(0, now - mem.since - 650) % ROUND, offset);
      if (walk?.walking) {
        const leg = 0.55 * Math.sin(s * 11);
        return { pose: { yaw: walk.dir * 1.2, step: leg, armL: [0.1, -leg], armR: [0.1, leg], holding: look.tool, eyes, bob: 0.04 * Math.abs(Math.sin(s * 11)) }, walk };
      }
      return { pose: { ...stir, yaw: walk?.atPot ? 0.5 : -0.3 }, walk };
    }
    // The Chef plans with the clipboard up; the Taster tastes.
    return { pose: { yaw: -0.25, armR: [0.4, 1.2 + 0.15 * Math.sin(s * 3)], holding: look.tool, headPitch: 0.15 + 0.1 * Math.sin(s * 2), eyes } };
  }
  // Waiting, paused or out of quota: look at the mouse, wave when it comes near, doze when nothing happens.
  const r = el.getBoundingClientRect();
  const hover = el.closest('.station, .agent-head')?.matches(':hover');
  const looking = pointer.x >= 0 && r.width ? { yaw: q(clamp((pointer.x - (r.left + r.width / 2)) / 380) * 0.7), headPitch: q(clamp((pointer.y - (r.top + r.height / 3)) / 380) * 0.3) } : {};
  if (hover) return { pose: { ...looking, armR: [2.5 + 0.35 * Math.sin(s * 9), 0.25], eyes: 'o' } };
  const quiet = now - Math.max(pointer.at, state.lastRun?.at ?? 0, mem.since) > 45000 + (offset % 20) * 1000;
  if (!state.run && quiet && st === 'standby') return { pose: { headPitch: 0.38, yaw: 0.15, lean: 0.08, eyes: '-' }, above: ['z  ', ' z ', 'zZ ', ' Z '][Math.floor(s / 1.2) % 4] };
  return { pose: { ...looking, headYaw: q((looking.yaw ?? 0) * 0.35), eyes } };
}

/**
 * An agent's figure: a 3D cook that reacts. It works whenever an ancestor carries
 * data-state="working" (on the kitchen floor a cook walks to the pot and back); otherwise it
 * looks at the mouse, waves when you come near, and dozes if nothing happens for a while.
 * Used at the stations and in the agent's own tab.
 */
export function figure(id) {
  watchPointer();
  watchLooks();
  const look = lookOf(id);
  const el = document.createElement('pre');
  el.className = 'ascii-figure';
  el.setAttribute('aria-hidden', 'true');
  const g = new Grid(FIGURE_W, FIGURE_H, { scale: 12.5, cx: FIGURE_W / 2, cy: FIGURE_H - 1.2, dist: 6, pitch: 0.12 });
  let shown = '';
  return animate(el, () => {
    const now = performance.now();
    const host = el.isConnected ? el.closest('[data-state]') : null;
    const mem = memory.get(id) ?? { st: host?.dataset.state ?? 'standby', since: now };
    memory.set(id, mem);
    const st = host?.dataset.state ?? mem.st;
    if (host && st !== mem.st) {
      if (st === 'working') mem.jumpAt = now;
      Object.assign(mem, { st, since: now });
    }
    const { pose, above, walk } = still.matches ? { pose: { eyes: 'o' } } : poseOf(id, el, st, mem, now, look);
    // Only draw when something visible changed: a still kitchen costs nothing.
    const key = JSON.stringify([pose, above, styleVersion]);
    if (key !== shown) {
      shown = key;
      drawFigure(g, look, pose);
      if (above) g.put(Math.floor(FIGURE_W / 2) + 2, 0, above, 'mark');
      el.innerHTML = g.html();
    }
    const move = walk && (walk.x || walk.y) ? `translate(${Math.round(walk.x)}px, ${Math.round(walk.y)}px)` : '';
    if (el.style.transform !== move) el.style.transform = move;
    el.classList.toggle('away', Boolean(move));
  });
}

// ------------------------------------------------------------- the kadhai

/**
 * The kitchen's centrepiece: a 3D kadhai on its stove, coloured per material. Still at rest; while
 * the crew cooks it turns, the oil ripples and bubbles, the fire burns and steam rises. It can be
 * dragged to spin. Returns { el, cooking(on) }.
 */
export function kadhai() {
  watchLooks();
  const el = document.createElement('pre');
  el.className = 'ascii-scene';
  el.setAttribute('aria-label', 'A kadhai on its stove. Drag to spin it.');
  el.title = 'Drag to spin';
  const g = new Grid(POT_W, POT_H, { scale: 15, cx: POT_W / 2, cy: 8, dist: 6, pitch: 0.45 });
  let busy = false;
  let started = 0;
  let spin = 0.35;
  let speed = 0;
  let drag = null;
  const draw = () => {
    drawKadhai(g, { spin, t: busy ? (performance.now() - started) / 1000 : 0, cooking: busy });
    el.innerHTML = g.html();
  };
  restyle.add(() => el.isConnected && draw());
  // The shared timer calls this on every tick; it draws only while cooking, being dragged, or still spinning.
  animate(el, () => {
    if (!drag && Math.abs(speed) > 0.002) {
      spin += speed;
      speed *= 0.93;
    } else if (busy && !drag && !still.matches) spin += 0.01;
    if ((busy && !still.matches) || drag || Math.abs(speed) > 0.002) draw();
  });
  el.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX };
    speed = 0;
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const d = (e.clientX - drag.x) * 0.012;
    drag.x = e.clientX;
    spin += d;
    speed = still.matches ? 0 : d;
    draw();
  });
  const drop = () => {
    drag = null;
    el.classList.remove('dragging');
  };
  el.addEventListener('pointerup', drop);
  el.addEventListener('pointercancel', drop);
  draw();
  return {
    el,
    cooking(on) {
      if (busy === on) return;
      busy = on;
      started = performance.now();
      draw();
    },
  };
}

// ------------------------------------------------------------ the stations

// What a cook says when clicked, by job.
const LINES = {
  manager: ['Order in!', 'Plates up, people!', 'What are we cooking?', 'Yes?'],
  reviewer: ['Needs salt.', 'Hmm... good.', 'Send it!', 'Tasting...'],
  coder: ['Yes, Chef!', 'On it!', 'Hot pan!', 'Chopping!'],
};
const SAY_MS = 2600;
const FLY_MS = 1100;
const shownState = (a) => (a.off && a.state !== 'working' ? 'off' : a.paused && a.state !== 'working' ? 'paused' : a.state);

/**
 * The crew at their stations, one each, in a row that wraps: the 3D cook, its name and what it is
 * doing, and a speech bubble. Hand-offs fly between stations: a ticket from the Chef to a cook as
 * its step starts (from the Taster, with "Sent back!", for a fix the review asked for), the dish
 * from the cook to the Taster when the step is done.
 * Returns { el, render() } - render() after the roster or a state changes.
 */
export function stations({ onOpen }) {
  const el = document.createElement('div');
  el.className = 'stations';
  // The cooks are as big as they can be with the whole crew on one row (from 9px down to 5px; only
  // a crew too big even for that wraps onto a second row).
  let size = 0;
  const fit = () => {
    const width = el.clientWidth;
    const n = cards.size;
    if (!width || !n) return;
    const next = Math.max(5, Math.min(9, Math.floor(((width - (n - 1) * 4) / n / 15) * 4) / 4));
    if (next === size) return;
    size = next;
    el.style.setProperty('--cook', `${next}px`);
    el.classList.toggle('small', next < 7.5);
  };
  new ResizeObserver(() => requestAnimationFrame(fit)).observe(el);
  const cards = new Map(); // id -> { root, cook, bubble, text, name, role }
  const said = new Map(); // id -> { text, at, auto }
  const steps = new Map(); // `${run}:${index}` -> the status last seen
  let planned = { run: null, n: 0 }; // how many steps the plan had before the review added fixes
  let clicks = 0;

  const talk = (id, text, auto = false) => said.set(id, { text, at: performance.now(), auto });

  /** Something handed from one station to another: a ticket or a dish flies across. */
  const fly = (fromId, toId, token) => {
    const from = cards.get(fromId)?.root;
    const to = cards.get(toId)?.root;
    const box = el.parentElement;
    if (!from || !to || from === to || !box || still.matches) return;
    const base = box.getBoundingClientRect();
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    const item = document.createElement('span');
    item.className = 'flying-ticket tinted';
    item.setAttribute('style', tintOf(fromId));
    item.setAttribute('aria-hidden', 'true');
    item.textContent = token;
    item.style.left = `${a.left + a.width / 2 - base.left - 16}px`;
    item.style.top = `${a.top - base.top + box.scrollTop}px`;
    box.append(item);
    const dx = b.left - a.left;
    const dy = b.top - a.top;
    item.animate(
      [{ transform: 'translate(0, 0)' }, { transform: `translate(${dx / 2}px, ${dy / 2 - 40}px)`, offset: 0.5 }, { transform: `translate(${dx}px, ${dy}px)` }],
      { duration: FLY_MS, easing: 'ease-in-out' },
    ).finished.then(() => item.remove(), () => item.remove());
  };

  /** Follow the run: tickets handed out, dishes handed in, fixes sent back. */
  const follow = () => {
    const run = state.run;
    if (!run?.plan) return;
    const agents = Object.values(state.agents);
    const chef = agents.find((a) => a.role === 'manager')?.id;
    const taster = agents.find((a) => a.role === 'reviewer')?.id;
    if (planned.run !== run.id) planned = { run: run.id, n: run.plan.subtasks.length };
    run.plan.subtasks.forEach((s, i) => {
      const key = `${run.id}:${i}`;
      if (steps.get(key) === s.status) return;
      steps.set(key, s.status);
      const fix = i >= planned.n;
      if (s.status === 'working') {
        fly(fix ? taster : chef, s.cookId, `[#${i + 1}]`);
        if (fix && taster) talk(taster, 'Sent back!', true);
      } else if (s.status === 'done' && taster) {
        fly(s.cookId, taster, '(###)');
      }
    });
  };

  /** A station for an agent, made once and kept, so its cook's animation never restarts. */
  const make = (a) => {
    const root = document.createElement('button');
    root.type = 'button';
    root.className = 'station tinted';
    const bubble = document.createElement('span');
    bubble.className = 'bubble';
    bubble.hidden = true;
    const text = document.createElement('span');
    text.className = 'bubble-text';
    bubble.append(text);
    const label = document.createElement('span');
    label.className = 'station-card';
    const name = document.createElement('span');
    name.className = 'station-name';
    const role = document.createElement('span');
    role.className = 'station-role';
    label.append(name, role);
    root.append(bubble, figure(a.id), label);
    root.addEventListener('click', (e) => {
      const id = root.dataset.agent;
      const before = said.get(id);
      // The keyboard opens it straight away; a pointer clicks twice: once to talk, once to open.
      if (e.detail === 0 || (before && !before.auto && performance.now() - before.at < SAY_MS)) {
        said.delete(id);
        onOpen?.(id);
        return;
      }
      const lines = LINES[state.agents[id]?.role] ?? LINES.coder;
      talk(id, lines[clicks++ % lines.length]);
    });
    return { root, bubble, text, name, role };
  };

  const render = () => {
    for (const [id, card] of cards) if (!state.agents[id]) {
      card.root.remove();
      cards.delete(id);
    }
    for (const a of Object.values(state.agents ?? {})) {
      const card = cards.get(a.id) ?? make(a);
      cards.set(a.id, card);
      const st = shownState(a);
      card.root.dataset.agent = a.id;
      card.root.dataset.state = st;
      card.root.setAttribute('style', tintOf(a.id));
      card.root.title = `${a.blurb}\nClick to talk to it, click again to open it`;
      card.root.setAttribute('aria-label', `${a.name}, ${st === 'standby' ? 'ready' : st === 'off' ? 'switched off' : st}. Open its tab`);
      card.name.textContent = a.name;
      card.role.textContent = st === 'working' ? (a.role === 'manager' ? 'planning' : a.role === 'reviewer' ? 'tasting' : 'cooking') : st === 'standby' ? (a.custom ? 'specialist' : 'ready') : st === 'limit-reached' ? 'out of quota' : st === 'off' ? 'switched off' : st;
      el.append(card.root); // keeps the roster's order
    }
    fit();
  };

  // Hand-offs and speech bubbles; each cook draws itself.
  animate(el, () => {
    follow();
    const now = performance.now();
    for (const [id, card] of cards) {
      const s = said.get(id);
      const words = s && now - s.at < SAY_MS ? s.text : '';
      if (card.bubble.hidden !== !words) card.bubble.hidden = !words;
      if (card.text.textContent !== words) card.text.textContent = words;
    }
  });
  render();
  return { el, render };
}
