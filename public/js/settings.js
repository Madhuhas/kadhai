import { $, h, fmtNum, toast, prefs } from './util.js';
import { state, on } from './store.js';
import { api } from './api.js';

/** Register new themes here after adding their variable block to css/themes.css. */
const THEMES = [
  { id: 'light', name: 'Light' },
  { id: 'modern', name: 'Normal light' },
  { id: 'solarized', name: 'Solarized light' },
  { id: 'dark', name: 'Dark' },
  { id: 'dracula', name: 'Dracula' },
  { id: 'nord', name: 'Nord' },
  { id: 'cyberpunk', name: 'Cyberpunk' },
  { id: 'amber', name: 'Amber CRT' },
  { id: 'contrast', name: 'High contrast' },
];

const root = document.documentElement;

// Pick black or white text for whatever accent the user chose.
function inkFor(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#141414' : '#ffffff';
}

function applyAccent(hex) {
  if (hex) {
    root.style.setProperty('--accent', hex);
    root.style.setProperty('--accent-ink', inkFor(hex));
  } else {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-ink');
  }
  $('#accent-pick').value = hex || getComputedStyle(root).getPropertyValue('--accent').trim();
}

function initThemes() {
  const select = $('#theme-select');
  select.append(...THEMES.map((t) => h('option', { value: t.id }, t.name)));
  select.value = THEMES.some((t) => t.id === root.dataset.theme) ? root.dataset.theme : 'light';
  root.dataset.theme = select.value;
  select.onchange = () => {
    root.dataset.theme = select.value;
    prefs.set('theme', select.value);
    applyAccent(prefs.get('accent'));
  };

  const picker = $('#accent-pick');
  picker.oninput = () => {
    prefs.set('accent', picker.value);
    applyAccent(picker.value);
  };
  picker.ondblclick = (e) => {
    e.preventDefault();
    prefs.set('accent', null);
    applyAccent(null);
    toast('Accent reset to the theme default');
  };
  applyAccent(prefs.get('accent'));

  // A taskbar menu closes when you click away from it, open another one, or press Escape.
  const menus = [...document.querySelectorAll('.menu')];
  document.addEventListener('click', (e) => {
    for (const menu of menus) if (menu.open && !menu.contains(e.target)) menu.open = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') for (const menu of menus) menu.open = false;
  });
  // Picking something in a menu (browser, about) closes it too: what it opened takes over.
  for (const item of document.querySelectorAll('.menu .menu-item')) item.addEventListener('click', () => (item.closest('details').open = false));
}

// ------------------------------------------------------- provider routes

function renderPill() {
  const { app, providers } = state;
  const active = providers.routes.find((r) => r.id === providers.active);
  $('#route-label').textContent = !app.hasProviders
    ? 'no models yet'
    : active
      ? active.model.split('/').pop()
      : 'models';
  $('#brand-sub').textContent = app.mock ? 'demo mode' : '';
  // A pre-release says so beside the name: "beta" for 1.0.0-beta.1, nothing for 1.0.0.
  const stage = /-(alpha|beta|rc)\b/.exec(app.version ?? '')?.[1];
  $('#beta-tag').hidden = !stage;
  if (stage) $('#beta-tag').textContent = stage;
}

function statusText(route) {
  if (route.overBudget) return 'daily limit';
  if (route.status !== 'cooling') return route.status;
  const left = route.cooldownMs - (Date.now() - state.providers.at);
  return left > 0 ? `cooling ${Math.ceil(left / 1000)}s` : 'ready';
}

// Only some providers report what is left; the rest honestly show a dash.
function quotaText(quota) {
  if (!quota) return '—';
  const parts = [];
  if (quota.remainingRequests != null) parts.push(`${fmtNum(quota.remainingRequests)} req`);
  if (quota.remainingTokens != null) parts.push(`${fmtNum(quota.remainingTokens)} tok`);
  return parts.join(' · ') || '—';
}

function renderRoutes() {
  const { routes } = state.providers;
  const body = $('#routes-body');
  if (!routes.length) {
    body.replaceChildren(h('p', { class: 'muted' }, 'No provider routes yet. Add a free API key with the keys button.'));
    return;
  }
  const table = h(
    'table',
    { class: 'routes' },
    h('tr', null, ...['#', 'Provider', 'Model', 'Status', 'Today', 'Left', '429s'].map((t) => h('th', null, t))),
    ...routes.map((r, i) =>
      h(
        'tr',
        { title: r.reason ?? '' },
        h('td', null, String(i + 1)),
        h('td', null, r.label, r.paid ? h('span', { class: 'badge', title: 'Billed to your account' }, 'paid') : null),
        h('td', null, r.model),
        h('td', { dataset: { status: r.status } }, statusText(r)),
        h('td', { class: 'num' }, `${fmtNum(r.day.calls)} calls · ${fmtNum(r.day.promptTokens + r.day.completionTokens)} tok`),
        h('td', { class: 'num' }, quotaText(r.quota)),
        h('td', { class: 'num' }, fmtNum(r.day.rateLimits)),
      ),
    ),
  );
  body.replaceChildren(
    h('p', { class: 'muted' }, 'Routes are tried top to bottom. A 429 benches a route until its limit resets and the request replays on the next one. “Today” is this app’s own usage since midnight; “Left” is what the provider last reported as remaining, where it reports anything.'),
    table,
  );
}

function initRoutes() {
  const dialog = $('#routes-dialog');
  let ticker = null;
  $('#route-pill').onclick = () => {
    renderRoutes();
    dialog.showModal();
    ticker = setInterval(renderRoutes, 1000); // keeps cooldown countdowns moving
  };
  dialog.addEventListener('close', () => clearInterval(ticker));
  dialog.addEventListener('click', (e) => e.target === dialog && dialog.close());
  $('#routes-close').onclick = () => dialog.close();
  $('#routes-skip').onclick = () => api.skipProvider().catch((err) => toast(err.message, 'err'));
  $('#routes-reset').onclick = () => api.resetProviders().catch((err) => toast(err.message, 'err'));

  const refresh = () => {
    renderPill();
    if (dialog.open) renderRoutes();
  };
  on('sync', refresh);
  on('providers', refresh);
}

export function initSettings() {
  initThemes();
  initRoutes();
}
