import { $, h } from './util.js';
import { state, on } from './store.js';

/*
 * The usage bar: a thin strip along the bottom of the window with what the models have used
 * today, kept live from the providers:update the dispatcher sends after every call. Only the
 * models that matter right now get a chip (in use, rate-limited, or used today - at most
 * SHOWN); the rest are one "+N more" that opens the full list. Per model:
 * whether it is in use, ready, rate-limited (with the time left) or switched off; its tokens
 * today; and, when the provider reports it, how much of its quota is left. Then the paid daily
 * limit, if one is set, and the flame. Tokens only - Kadhai knows no prices.
 */
const kTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));
const STATE_WORD = { active: 'in use', ready: 'ready', cooling: 'rate-limited', disabled: 'off' };
let ticker = null;
const SHOWN = 3; // model chips in the bar; the rest are one "+N more"
const usedOf = (r) => (r.day?.promptTokens ?? 0) + (r.day?.completionTokens ?? 0);

/** What is left of a provider's quota, as a share and a label - or null when it reports nothing. */
function quotaOf(route) {
  const q = route.quota;
  if (!q) return null;
  if (Number.isFinite(q.remainingTokens) && q.limitTokens > 0) return { share: q.remainingTokens / q.limitTokens, label: `${kTokens(q.remainingTokens)} tokens left` };
  if (Number.isFinite(q.remainingRequests) && q.limitRequests > 0) return { share: q.remainingRequests / q.limitRequests, label: `${kTokens(q.remainingRequests)} requests left` };
  return null;
}

const meter = (share, cls = '') =>
  h('span', { class: `usage-meter ${cls}`, 'aria-hidden': 'true' }, h('span', { style: `width:${Math.round(Math.max(0, Math.min(1, share)) * 100)}%` }));

function chip(route) {
  const used = (route.day?.promptTokens ?? 0) + (route.day?.completionTokens ?? 0);
  const quota = quotaOf(route);
  const status = route.overBudget ? 'disabled' : route.status;
  const wait = status === 'cooling' && route.cooldownMs > 0 ? ` ${Math.ceil(Math.max(0, route.cooldownMs - (Date.now() - state.providers.at)) / 1000)}s` : '';
  const title = [
    `${route.label} · ${route.model}`,
    `${STATE_WORD[status] ?? status}${wait}`,
    `today: ${used.toLocaleString('en-US')} tokens in ${route.day?.calls ?? 0} call(s)${route.day?.rateLimits ? `, ${route.day.rateLimits} rate limit(s)` : ''}`,
    quota ? `${quota.label} (as the provider last reported)` : '',
    route.paid ? 'paid - counts towards the daily limit' : '',
    route.reason && status !== 'active' && status !== 'ready' ? `last error: ${route.reason}` : '',
  ].filter(Boolean).join('\n');
  return h(
    'button',
    { class: 'usage-chip', type: 'button', dataset: { status }, title, onclick: () => $('#route-pill').click() },
    h('span', { class: 'dot' }),
    h('span', { class: 'usage-model' }, route.model.split('/').pop()),
    h('span', { class: 'usage-num' }, `${kTokens(used)}${wait}`),
    ...(quota ? [meter(quota.share, quota.share < 0.15 ? 'low' : '')] : []),
    ...(route.paid ? [h('span', { class: 'usage-tag' }, 'paid')] : []),
  );
}

/** The models without a chip, as one button that opens the full list (the providers menu). */
function more(n, total) {
  const ready = (state.providers.routes ?? []).filter((r) => r.status === 'ready').length;
  return h('button', { class: 'usage-chip usage-more', type: 'button', title: `${total} models in all, ${ready} ready.
Click for the full list.`, onclick: () => $('#route-pill').click() }, n === total ? `${total} models ready` : `+${n} more`);
}

function render() {
  const bar = $('#usage-bar');
  const routes = state.providers.routes ?? [];
  if (!routes.length) return bar.replaceChildren(h('span', { class: 'muted' }, state.app.mock ? 'demo mode - no real models' : 'no models yet - add a key under keys'));
  const tokens = routes.reduce((sum, r) => sum + (r.day?.promptTokens ?? 0) + (r.day?.completionTokens ?? 0), 0);
  const calls = routes.reduce((sum, r) => sum + (r.day?.calls ?? 0), 0);
  // In use first, then rate-limited, then by tokens today; a model nobody has touched today stays in "+N more".
  const rank = (r) => (r.status === 'active' ? 0 : r.status === 'cooling' ? 1 : 2);
  const shown = routes.filter((r) => r.status === 'active' || r.status === 'cooling' || usedOf(r) > 0).sort((a, b) => rank(a) - rank(b) || usedOf(b) - usedOf(a)).slice(0, SHOWN);
  const rest = routes.length - shown.length;
  const paid = state.providers.paid;
  const working = Object.values(state.agents).some((a) => a.state === 'working');
  bar.replaceChildren(
    h('span', { class: `usage-total${working ? ' live' : ''}`, title: 'All models together, since midnight' }, h('b', null, kTokens(tokens)), ` tokens today · ${calls} call${calls === 1 ? '' : 's'}`),
    h('span', { class: 'usage-routes' }, ...shown.map(chip), ...(rest ? [more(rest, routes.length)] : [])),
    h('span', { class: 'spacer' }),
    ...(paid?.budget > 0
      ? [h('span', { class: 'usage-paid', title: 'Paid models, all together, against the daily limit set under keys' }, `paid ${kTokens(paid.usedToday)} / ${kTokens(paid.budget)}`, meter(1 - paid.usedToday / paid.budget, paid.usedToday / paid.budget > 0.85 ? 'low' : ''))]
      : []),
  );
  // A rate-limited model counts down: tick once a second while one is, and only then.
  const cooling = routes.some((r) => r.status === 'cooling');
  if (cooling && !ticker) ticker = setInterval(() => (document.hidden ? null : render()), 1000);
  if (!cooling && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

export function initUsage() {
  on('sync', render);
  on('providers', render);
  on('agents', render);
  on('flame', render);
}
