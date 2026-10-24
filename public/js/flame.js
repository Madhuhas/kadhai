import { $, h, toast } from './util.js';
import { state, on } from './store.js';
import { api } from './api.js';
import { FLAME_ART } from './ascii.js';

/*
 * Low or high flame, from the taskbar. Low is made for free tiers: small prompts, short
 * skills, one review round. High lets everything out: longer skills and context, a second
 * review round, paid keys and subscriptions tried first. Any key works on either.
 * In the main window it is the setting every room follows; in another room it can be that
 * room's own.
 */
const CHOICES = {
  low: { name: 'Low flame', line: 'Saves tokens. Best on free keys: short prompts, skills trimmed to 900 characters, one review round.' },
  high: { name: 'High flame', line: 'Everything out. Best with paid keys and subscriptions: up to three cooks at once, subscription CLIs working as real agents, longer context, two review rounds, paid models first.' },
};

let info = { flame: 'low', room: false, own: false, shared: 'low' };

const strongRoutes = () => (state.providers.routes ?? []).some((r) => r.paid || r.kind === 'cli');

function render() {
  const flame = info.flame;
  const pill = $('#flame-pill');
  pill.replaceChildren(flame, h('span', { class: 'flame-word' }, ' flame'));
  pill.classList.toggle('hot', flame === 'high');
  const choice = (id) =>
    h(
      'button',
      { class: `flame-choice${flame === id && (!info.room || info.own) ? ' on' : ''}`, type: 'button', 'aria-pressed': String(flame === id && (!info.room || info.own)), onclick: () => set(id) },
      h('pre', { class: `flame-art${id === 'high' ? ' hot' : ''}`, 'aria-hidden': 'true' }, FLAME_ART[id]),
      h('span', { class: 'flame-text' }, h('b', null, CHOICES[id].name), h('span', { class: 'muted' }, CHOICES[id].line)),
    );
  $('#flame-panel').replaceChildren(
    choice('low'),
    choice('high'),
    // An extra room follows the main window unless it was given a flame of its own.
    ...(info.room
      ? [h('button', { class: `flame-choice follow${info.own ? '' : ' on'}`, type: 'button', 'aria-pressed': String(!info.own), onclick: () => set(null) }, h('span', { class: 'flame-text' }, h('b', null, 'Follow the main window'), h('span', { class: 'muted' }, `It is on ${info.shared} flame now.`)))]
      : [h('p', { class: 'muted flame-note' }, 'Applies to every kitchen, unless a kitchen picks its own.')]),
    ...(flame === 'high' && !strongRoutes() ? [h('p', { class: 'flame-warn' }, '[!] Only free keys are set up: high flame sends bigger prompts, so their limits are reached sooner. It works, just slower.')] : []),
  );
}

async function load() {
  try {
    info = await api.flame();
  } catch {
    info = { ...info, flame: state.app.flame ?? 'low' };
  }
  render();
}

async function set(flame) {
  try {
    info = await api.setFlame(flame);
    render();
    toast(flame === null ? `Following the main window: ${info.flame} flame` : `${CHOICES[info.flame].name} - from the next model call on`);
  } catch (err) {
    toast(err.message, 'err');
  }
}

export function initFlame() {
  on('sync', load);
  // Changed here, in another tab, or (for a room) in the main window.
  on('flame', load);
  on('providers', () => info.flame === 'high' && $('#flame-menu').open && render());
}
