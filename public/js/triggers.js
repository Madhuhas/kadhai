import { h, toast } from './util.js';
import { on } from './store.js';
import { api } from './api.js';

/**
 * Triggers: tasks that arrive from outside the dashboard - a webhook from a
 * program on this computer, a labelled GitHub or Linear issue, a message to
 * your Telegram bot. Shown as a section of the connections dialog.
 */
let types = [];
let triggers = [];
let shownToken = null; // { id, token }: a new webhook's token, shown until the dialog is next opened
const list = h('div', { class: 'trigger-list' });
let form = null;

const fail = (err) => toast(err.message, 'err');
const act = (fn, done) => async () => {
  try {
    await fn();
    if (done) toast(done, 'ok');
  } catch (err) {
    fail(err);
  }
};

function copyButton(text) {
  const button = h('button', { class: 'btn sm', type: 'button' }, 'Copy');
  button.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
      setTimeout(() => (button.textContent = 'Copy'), 1500);
    } catch {
      toast('Could not copy — select the text and copy it by hand', 'err');
    }
  };
  return button;
}

const when = (ts) => (ts ? new Date(ts).toLocaleString() : 'never');

/** What a trigger is watching, in a few words. */
function watching(t) {
  if (t.type === 'github') return `${t.config.repo} · label "${t.config.label}"`;
  if (t.type === 'linear') return `label "${t.config.label}"`;
  if (t.type === 'telegram') return t.config.chats.length ? `chat ${t.config.chats.join(', ')}` : 'no chat allowed yet';
  return `POST ${location.origin}${t.path}`;
}

function webhookHelp(t) {
  const url = `${location.origin}${t.path}`;
  const token = shownToken?.id === t.id ? shownToken.token : null;
  const example = `curl -X POST ${url} -H "Authorization: Bearer ${token ?? '<token>'}" -H "Content-Type: application/json" -d "{\\"text\\": \\"what to do\\"}"`;
  return [
    token
      ? h('div', { class: 'mcp-out' }, h('span', { class: 'muted' }, 'Its token — shown this once, so copy it now:'), h('div', { class: 'mcp-copy' }, h('code', null, token), copyButton(token)))
      : null,
    h('div', { class: 'mcp-out' }, h('span', { class: 'muted' }, 'Send a task from this computer like this:'), h('div', { class: 'mcp-copy' }, h('pre', null, example), copyButton(example))),
  ];
}

function row(t) {
  return h(
    'article',
    { class: 'trigger', dataset: { state: t.lastError ? 'error' : t.enabled ? 'on' : 'off' } },
    h(
      'div',
      { class: 'trigger-head' },
      h('strong', null, t.name),
      h('span', { class: 'badge' }, t.label),
      h('span', { class: `badge${t.lastError ? ' warn' : t.enabled ? ' on' : ''}` }, t.lastError ? 'problem' : t.enabled ? 'listening' : 'off'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', type: 'button', onclick: act(() => api.triggers.enable(t.id, !t.enabled)) }, t.enabled ? 'Turn off' : 'Turn on'),
      h('button', { class: 'btn sm danger', type: 'button', onclick: () => confirm(`Remove the trigger "${t.name}"?`) && act(() => api.triggers.remove(t.id), 'Trigger removed')() }, 'Remove'),
    ),
    h('p', { class: 'muted' }, `${watching(t)} · started ${t.fired} task${t.fired === 1 ? '' : 's'} · last: ${when(t.lastFiredAt)}`),
    t.lastError ? h('p', { class: 'mcp-error' }, `Last check failed: ${t.lastError}`) : null,
    t.type === 'telegram' && t.stranger && !t.config.chats.includes(t.stranger)
      ? h('p', { class: 'muted' }, `A message came from chat ${t.stranger}, which is not on the list. If that is you, remove this trigger and add it again with that chat id.`)
      : null,
    ...(t.type === 'webhook' ? webhookHelp(t) : []),
  );
}

function renderList() {
  list.replaceChildren(...(triggers.length ? triggers.map(row) : [h('p', { class: 'muted' }, 'Nothing can start a task from outside yet.')]));
}

async function refresh() {
  try {
    ({ triggers, types } = await api.triggers.list());
    renderList();
    form?.fill();
  } catch (err) {
    fail(err);
  }
}

function addForm() {
  const kind = h('select', { class: 'select', ariaLabel: 'What wakes the crew' });
  const name = h('input', { type: 'text', placeholder: 'A name for it (optional)', ariaLabel: 'Name', maxLength: 40 });
  const about = h('p', { class: 'muted' });
  const fields = h('div', { class: 'connector-form' });
  const button = h('button', { class: 'btn sm primary' }, 'Add trigger');

  const showFields = () => {
    const type = types.find((t) => t.id === kind.value);
    about.textContent = type ? `${type.about}${type.checked === 'live' ? ' Not yet tried from Kadhai with a real account — if it reports a problem, the message will say why.' : ''}` : '';
    fields.replaceChildren(
      ...(type?.fields ?? []).map((field) => {
        const input = h('input', { type: field.secret ? 'password' : 'text', placeholder: field.placeholder ?? '', ariaLabel: field.label, autocomplete: 'off', required: !field.optional && !field.placeholder });
        input.spellcheck = false;
        input.dataset.field = field.id;
        return h('label', { class: 'conn-field' }, h('span', null, field.label), input);
      }),
    );
  };
  kind.onchange = showFields;

  const node = h(
    'form',
    {
      class: 'mcp-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const values = Object.fromEntries([...fields.querySelectorAll('input[data-field]')].map((el) => [el.dataset.field, el.value]));
        button.disabled = true;
        try {
          const made = await api.triggers.add({ type: kind.value, name: name.value, ...values });
          shownToken = made.token ? { id: made.id, token: made.token } : shownToken;
          toast(`${made.name} is listening`, 'ok');
          name.value = '';
          showFields();
          await refresh();
        } catch (err) {
          fail(err);
        }
        button.disabled = false;
      },
    },
    h('div', { class: 'mcp-row' }, kind, name),
    about,
    fields,
    h('div', { class: 'dialog-actions' }, h('span', { class: 'muted mcp-warn' }, 'A task that arrives this way is treated like one you typed: its commands still wait for your OK.'), h('span', { class: 'spacer' }), button),
  );
  // The kinds arrive from the server; keep what was picked when they are filled in again.
  node.fill = () => {
    const picked = kind.value;
    kind.replaceChildren(...types.map((t) => h('option', { value: t.id }, t.label)));
    if (types.some((t) => t.id === picked)) kind.value = picked;
    else showFields();
  };
  return node;
}

/** The section's contents. The same nodes every time, so typing survives a refresh of the dialog. */
export function triggerPanel() {
  form ??= addForm();
  return [
    h('p', { class: 'muted' }, 'Let something other than the chat box start a task. Kadhai still only listens on this computer: GitHub, Linear and Telegram are asked once a minute, nothing calls in from the internet.'),
    list,
    form,
  ];
}

export function initTriggers() {
  on('triggers', refresh);
  on('sync', refresh);
  // A token is shown once: opening the dialog afresh is the end of that once.
  on('connectionsopen', () => {
    shownToken = null;
    refresh();
  });
}
