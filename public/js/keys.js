import { $, fmtNum, h, toast } from './util.js';
import { state, on } from './store.js';
import { api } from './api.js';
import { logo } from './logos.js';

// Models each provider said it offers, fetched on demand and kept for this session only.
const available = {};
let autoOpened = false;
let openId; // the provider without a key whose card is open; undefined until the first look

// Shown where a provider has no logo.
const TAGS = { gemini: 'GEM', groq: 'GQ', cerebras: 'CB', mistral: 'MI', openrouter: 'OR', nvidia: 'NV', sambanova: 'SN', huggingface: 'HF', cohere: 'CO', zai: 'ZAI', custom: '+' };
const tagOf = (provider) => TAGS[provider.id] ?? provider.label.slice(0, 2).toUpperCase();

const split = (value) => value.split(',').map((s) => s.trim()).filter(Boolean);

function keyRow(provider, key, refresh) {
  return h(
    'li',
    null,
    h('code', null, key.masked),
    h('span', { class: 'muted' }, key.source === 'env' ? 'from .env' : 'saved here'),
    h('span', { class: 'spacer' }),
    key.source === 'ui' &&
      h(
        'button',
        {
          class: 'icon-btn',
          type: 'button',
          title: 'Remove this key',
          onclick: async () => {
            if (!confirm(`Remove this ${provider.label} key?`)) return;
            try {
              await api.removeKey(provider.id, key.id);
              refresh();
            } catch (err) {
              toast(err.message, 'err');
            }
          },
        },
        '×',
      ),
  );
}

/** Clickable list of what the provider offers; a click adds or removes the model from the field. */
function modelPicker(provider, input) {
  const offered = available[provider.id];
  if (!offered) return null;
  if (!offered.length) return h('p', { class: 'muted models-offered' }, 'This provider did not return a model list. Type the model names by hand.');

  const filter = h('input', { type: 'text', placeholder: `Filter ${offered.length} models…`, class: 'model-filter', ariaLabel: 'Filter models' });
  filter.spellcheck = false;
  const chips = h('div', { class: 'model-chips' });
  const draw = () => {
    const chosen = new Set(split(input.value));
    const needle = filter.value.trim().toLowerCase();
    chips.replaceChildren(
      ...offered
        .filter((m) => !needle || m.toLowerCase().includes(needle))
        .sort((a, b) => chosen.has(b) - chosen.has(a))
        .slice(0, 60)
        .map((m) =>
          h(
            'button',
            {
              type: 'button',
              class: `chip${chosen.has(m) ? ' on' : ''}`,
              title: chosen.has(m) ? 'Click to remove' : 'Click to add',
              onclick: () => {
                const list = split(input.value);
                input.value = (list.includes(m) ? list.filter((x) => x !== m) : [...list, m]).join(', ');
                draw();
              },
            },
            m,
          ),
        ),
    );
  };
  filter.oninput = draw;
  input.addEventListener('input', draw);
  draw();
  return h('div', { class: 'model-picker' }, offered.length > 12 && filter, chips, h('p', { class: 'muted' }, 'Click models to add them, then press Save models. The first one is tried first.'));
}

/** A provider you have not set up yet: one line, until you ask for more. */
function providerRow(provider, onOpen) {
  return h(
    'button',
    { class: 'key-row', type: 'button', title: `Add a ${provider.label} key`, onclick: onOpen },
    logo(provider.id, tagOf(provider)),
    h('strong', null, provider.label),
    h('span', { class: 'key-row-tier' }, provider.freeTier ? `free: ${provider.freeTier}` : provider.own ? provider.baseUrl : provider.paid ? 'paid: billed to your account' : ''),
    h('span', { class: 'btn sm' }, provider.keyless ? 'Set up' : 'Add key'),
  );
}

function providerCard(provider, refresh, onClose) {
  const keyInput = h('input', { type: 'password', placeholder: `Paste a ${provider.label} API key`, ariaLabel: `${provider.label} API key`, autocomplete: 'off' });
  keyInput.spellcheck = false;
  const addButton = h('button', { class: 'btn sm primary' }, 'Add key');
  const addForm = h(
    'form',
    {
      class: 'key-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const key = keyInput.value.trim();
        if (!key) return;
        addButton.disabled = true;
        addButton.textContent = 'Checking…';
        try {
          const result = await api.addKey(provider.id, key);
          keyInput.value = '';
          available[provider.id] = result.availableModels;
          toast(
            result.verified
              ? `${provider.label} accepted the key`
              : result.checkable
                ? `Saved, but ${provider.label} could not be reached to check it`
                : `Saved. ${provider.label} keys cannot be checked in advance — the first task will tell`,
            result.verified ? 'ok' : '',
          );
          if (result.needsModels) toast(`Now pick which ${provider.label} models to use`);
          else if (result.missingModels.length) toast(`${provider.label} does not list: ${result.missingModels.join(', ')}. Pick replacements below.`, 'err');
          refresh();
        } catch (err) {
          toast(err.message, 'err');
          addButton.disabled = false;
          addButton.textContent = 'Add key';
        }
      },
    },
    keyInput,
    addButton,
  );

  const modelInput = h('input', { type: 'text', value: provider.models.join(', '), placeholder: 'No models chosen yet', ariaLabel: `${provider.label} models, comma-separated, best first`, title: 'Comma-separated, best first' });
  modelInput.spellcheck = false;
  const saveModels = async (models) => {
    try {
      await api.setModels(provider.id, models);
      toast(models.length ? `${provider.label} models updated` : `${provider.label} models reset to the defaults`, 'ok');
      refresh();
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  const browse = h(
    'button',
    {
      class: 'btn sm',
      type: 'button',
      onclick: async () => {
        browse.disabled = true;
        browse.textContent = 'Loading…';
        try {
          available[provider.id] = (await api.availableModels(provider.id)).models;
        } catch (err) {
          toast(err.message, 'err');
        }
        refresh();
      },
    },
    available[provider.id] ? 'Refresh list' : 'Browse models',
  );
  const modelForm = h(
    'form',
    {
      class: 'key-form',
      onsubmit: (e) => {
        e.preventDefault();
        saveModels(split(modelInput.value));
      },
    },
    modelInput,
    h('button', { class: 'btn sm' }, 'Save models'),
    browse,
    provider.modelsCustom && h('button', { class: 'btn sm', type: 'button', onclick: () => saveModels([]) }, 'Reset'),
  );

  const status = provider.needsModels ? 'pick models' : provider.keys.length ? `${provider.keys.length} key(s)` : 'no key';
  return h(
    'section',
    { class: `key-card${provider.keys.length ? ' in-use' : ''}` },
    h(
      'header',
      null,
      logo(provider.id, tagOf(provider)),
      h('strong', null, provider.label),
      h('span', { class: `badge${provider.needsModels ? ' warn' : provider.keys.length ? ' on' : ''}` }, status),
      h('span', { class: 'spacer' }),
      provider.keyUrl && h('a', { href: provider.keyUrl, target: '_blank', rel: 'noopener noreferrer' }, provider.paid ? 'Get a key ↗' : 'Get a free key ↗'),
      provider.own &&
        h('button', { class: 'btn sm danger', type: 'button', onclick: async () => {
          if (!confirm(`Remove ${provider.label}, with its key and models?`)) return;
          try {
            await api.removeEndpoint(provider.id);
            toast(`${provider.label} removed`);
          } catch (err) {
            toast(err.message, 'err');
          }
          refresh();
        } }, 'Remove'),
      onClose && h('button', { class: 'btn sm', type: 'button', onclick: onClose }, 'Close'),
    ),
    provider.freeTier && h('p', { class: 'muted free-tier' }, `Free tier: ${provider.freeTier}`),
    provider.own && h('p', { class: 'muted free-tier' }, `${provider.baseUrl}${provider.keyless ? ' · on this computer: no key needed, just name its models below' : ''}`),
    provider.paid && h('p', { class: 'muted free-tier' }, `Paid: every call is billed to your ${provider.label} account.${provider.models.length ? '' : ' After adding the key, choose its models with "Browse models".'}`),
    provider.keys.length ? h('ul', { class: 'key-list' }, provider.keys.map((key) => keyRow(provider, key, refresh))) : null,
    addForm,
    h('label', { class: 'muted' }, 'Models, best first'),
    modelForm,
    modelPicker(provider, modelInput),
  );
}

/** One box for any key: where its prefix says whose it is, it goes there by itself. */
function anyKeyForm(refresh) {
  const input = h('input', { type: 'password', placeholder: 'Paste any API key - Claude, OpenAI, Groq, Gemini, OpenRouter, xAI…', ariaLabel: 'Any API key', autocomplete: 'off' });
  input.spellcheck = false;
  const button = h('button', { class: 'btn sm primary' }, 'Add key');
  return h(
    'form',
    {
      class: 'key-form any-key',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!input.value.trim()) return;
        button.disabled = true;
        try {
          const out = await api.addAnyKey(input.value);
          toast(`${out.label} key added${out.paid ? ' - this one is billed to your account' : ''}${out.needsModels ? '. Now choose its models.' : ''}`, 'ok');
          input.value = '';
        } catch (err) {
          toast(err.message, 'err');
        }
        button.disabled = false;
        refresh();
      },
    },
    input,
    button,
  );
}

/** Paid keys cost money per call, so the user decides when they are used and how much a day. */
function paidSettings(settings, refresh) {
  const save = async (change) => {
    try {
      await api.keySettings(change);
      toast('Saved', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
    refresh();
  };
  const order = h('select', { class: 'select', ariaLabel: 'When paid keys are used', onchange: () => save({ paidOrder: order.value }) }, h('option', { value: 'first' }, 'Use paid models first'), h('option', { value: 'last' }, 'Only when the free ones run out'));
  order.value = settings.paidOrder ?? 'first';
  const limit = h('input', { type: 'text', inputMode: 'numeric', value: settings.paidDailyTokens ? String(settings.paidDailyTokens) : '', placeholder: 'no limit', ariaLabel: 'Daily limit for paid models, in tokens' });
  return h(
    'form',
    { class: 'key-form paid-settings', onsubmit: (e) => (e.preventDefault(), save({ paidDailyTokens: Number(limit.value.replace(/[,_\s]/g, '') || 0) })) },
    order,
    h('label', { class: 'paid-limit' }, h('span', { class: 'muted' }, 'Daily limit (tokens)'), limit),
    h('button', { class: 'btn sm' }, 'Save limit'),
    h('span', { class: 'muted paid-used' }, `Used today: ${fmtNum(settings.paidUsedToday ?? 0)}${settings.paidDailyTokens ? ` of ${fmtNum(settings.paidDailyTokens)}` : ''} tokens`),
  );
}

/** Any other server that speaks the OpenAI dialect. */
function endpointForm(refresh) {
  const name = h('input', { type: 'text', placeholder: 'Name, e.g. Together', ariaLabel: 'Endpoint name', maxLength: 40 });
  const url = h('input', { type: 'text', placeholder: 'Base address, e.g. https://api.example.com/v1', ariaLabel: 'Base address' });
  url.spellcheck = false;
  const paid = h('input', { type: 'checkbox', checked: true });
  return h(
    'form',
    {
      class: 'key-form',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const made = await api.addEndpoint({ name: name.value, baseUrl: url.value, paid: paid.checked });
          openId = made.id;
          toast(`${made.label} added${made.keyless ? '. Name its models to start using it.' : '. Now paste its key.'}`, 'ok');
          name.value = '';
          url.value = '';
        } catch (err) {
          toast(err.message, 'err');
        }
        refresh();
      },
    },
    name,
    url,
    h('label', { class: 'paid-limit' }, paid, h('span', { class: 'muted' }, 'it bills me per call')),
    h('button', { class: 'btn sm' }, 'Add endpoint'),
  );
}

/** A subscription CLI: something you already pay for, used as a model. */
function subscriptionCard(sub, refresh) {
  const act = (fn, done) => async () => {
    try {
      await fn();
      if (done) toast(done, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
    refresh();
  };
  const models = h('input', { type: 'text', value: sub.models.join(', '), placeholder: 'Whatever the CLI is set to', ariaLabel: `${sub.label} models, comma-separated, best first`, title: 'Comma-separated, best first. Leave empty to use the model the CLI is set to.' });
  models.spellcheck = false;
  const status = sub.enabled ? 'in use' : sub.installed ? 'installed' : 'not installed';
  // Not on this computer: one line, like a provider you have not set up. The link says how to get it.
  if (!sub.installed && !sub.enabled) {
    return h(
      'div',
      { class: 'key-row', title: `Not found on this computer (the "${sub.command}" command). Install it, sign in with "${sub.signIn}", then come back.` },
      logo(sub.id, sub.label.slice(0, 2).toUpperCase()),
      h('strong', null, sub.label),
      h('span', { class: 'key-row-tier' }, `not installed - then sign in with "${sub.signIn}"`),
      h('a', { href: sub.docs, target: '_blank', rel: 'noopener noreferrer' }, 'How to get it ↗'),
      sub.terms && h('a', { class: `key-terms${sub.terms.risky ? ' risky' : ''}`, href: sub.terms.url, target: '_blank', rel: 'noopener noreferrer', title: sub.terms.text }, `${sub.terms.risky ? '[!] ' : ''}Their terms ↗`),
    );
  }
  return h(
    'section',
    { class: `key-card${sub.enabled ? ' in-use' : ''}` },
    h(
      'header',
      null,
      logo(sub.id, sub.label.slice(0, 2).toUpperCase()),
      h('strong', null, sub.label),
      h('span', { class: `badge${sub.enabled ? ' on' : sub.installed ? '' : ' warn'}` }, status),
      h('span', { class: 'spacer' }),
      h('a', { href: sub.docs, target: '_blank', rel: 'noopener noreferrer' }, 'About it ↗'),
      sub.enabled
        ? h('button', { class: 'btn sm', type: 'button', onclick: act(() => api.setSubscription(sub.id, false), `${sub.label} switched off`) }, 'Switch off')
        : h('button', { class: 'btn sm primary', type: 'button', disabled: !sub.installed, onclick: () => (!sub.terms?.risky || confirm(`${sub.terms.text}\n\nUse ${sub.label} anyway?`)) && act(() => api.setSubscription(sub.id, true), `${sub.label} is now used first`)() }, 'Use it'),
    ),
    h('p', { class: 'muted free-tier' }, sub.installed ? `Needs ${sub.plan}, and you signed in to it (${sub.signIn}).` : `Not found on this computer (the "${sub.command}" command). Install it, sign in with "${sub.signIn}", then come back.`),
    // What the vendor's own terms say about a plan used this way: the user decides with that in front of them.
    sub.terms && h('p', { class: `key-terms${sub.terms.risky ? ' risky' : ''}` }, h('span', null, `${sub.terms.risky ? '[!] ' : ''}${sub.terms.text} `), h('a', { href: sub.terms.url, target: '_blank', rel: 'noopener noreferrer' }, 'Their terms ↗')),
    sub.enabled
      ? h(
          'form',
          { class: 'key-form', onsubmit: (e) => (e.preventDefault(), act(() => api.setSubscriptionModels(sub.id, models.value.split(',').map((m) => m.trim()).filter(Boolean)), 'Models saved')()) },
          models,
          h('button', { class: 'btn sm' }, 'Save models'),
        )
      : null,
  );
}

export function initKeys() {
  const dialog = $('#keys-dialog');
  const body = $('#keys-body');

  async function render() {
    try {
      const { providers, subscriptions = [], settings = {} } = await api.keys();
      // What you use comes first and stays open. Everything else is one line each until you pick it.
      const inUse = (p) => p.keys.length > 0 || (p.keyless && p.models.length > 0);
      const free = providers.filter((p) => !p.paid);
      const paid = providers.filter((p) => p.paid);
      const used = free.filter(inUse);
      const rest = free.filter((p) => !inUse(p));
      if (openId === undefined) openId = used.length ? null : (rest[0]?.id ?? null); // nothing set up yet: lead with the first
      const show = (id) => () => {
        openId = id;
        render();
      };
      const scroll = body.scrollTop;
      body.replaceChildren(
        h('p', { class: 'muted' }, 'Any key works here: free tiers, paid accounts, a subscription CLI, a model on this computer. Add several and Kadhai switches to the next when one hits its limit. Keys are used straight away — no restart.'),
        anyKeyForm(render),
        h('h4', null, 'subscriptions you already pay for'),
        h('p', { class: 'muted key-note' }, 'Kadhai can use a coding CLI you are signed in to as its model, so your subscription\'s limits do the work. It is tried before the free keys; when it runs out, the free ones take over. On low flame the CLI only answers: it never sees your folder. On high flame it can work as an agent on a copy of your folder; its changes come back through Kadhai, reviewed and undoable. Using a plan this way is up to each vendor\'s terms, which change: each card says what they said when this version was made.'),
        h('div', { class: 'key-rows' }, ...subscriptions.map((sub) => subscriptionCard(sub, render))),
        ...(used.length ? [h('h4', null, `free keys in use (${used.length})`), ...used.map((p) => providerCard(p, render))] : []),
        // One free provider and nothing else: when it hits its limit, there is nowhere to switch to.
        ...(used.length === 1 && !subscriptions.some((s) => s.enabled) && !paid.some(inUse)
          ? [h('p', { class: 'key-tip' }, `[!] Only ${used[0].label} is set up. When it reaches its limit the crew has to wait. Add a second free provider below, so the work carries on there instead.`)]
          : []),
        ...(rest.length
          ? [
              h('h4', null, used.length ? `add another (${rest.length} more free providers)` : 'pick a provider to start'),
              h('div', { class: 'key-rows' }, ...rest.map((p) => (p.id === openId ? providerCard(p, render, show(null)) : providerRow(p, show(p.id))))),
              h('p', { class: 'muted key-note' }, 'Free limits are as published by each provider or the awesome-freellm-apis list, and may be out of date.'),
            ]
          : []),
        h('h4', null, `paid keys${paid.filter(inUse).length ? ` (${paid.filter(inUse).length} in use)` : ''}`),
        h('p', { class: 'muted key-note' }, 'A key from an account with billing. Every call costs money there, and Kadhai cannot see your balance or prices — it counts tokens, so set a daily limit if you want a ceiling. When the limit is reached the free keys carry on.'),
        paidSettings(settings, render),
        h('div', { class: 'key-rows' }, ...paid.map((p) => (inUse(p) ? providerCard(p, render) : p.id === openId ? providerCard(p, render, show(null)) : providerRow(p, show(p.id))))),
        h('h4', null, 'another provider or a model on this computer'),
        h('p', { class: 'muted key-note' }, 'Anything that speaks the OpenAI chat format can be added by its address: another vendor, a company gateway, Ollama or LM Studio on this machine (http://localhost… needs no key).'),
        endpointForm(render),
        h('p', { class: 'muted key-note' }, 'Keys are stored on this computer only, encrypted, in keys.local.json inside the Kadhai folder (kept out of git). They are sent to their own provider and nowhere else, and are never shown in full again.'),
      );
      body.scrollTop = scroll;
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  const open = async () => {
    await render();
    if (!dialog.open) dialog.showModal();
  };

  $('#keys-btn').onclick = open;
  $('#keys-close').onclick = () => dialog.close();
  dialog.addEventListener('click', (e) => e.target === dialog && dialog.close());
  on('openkeys', open);
  on('sync', () => {
    // First visit with nothing configured: lead with the one thing that is needed.
    if (!autoOpened && !state.app.hasProviders && !state.app.mock) {
      autoOpened = true;
      open();
    }
  });
}
