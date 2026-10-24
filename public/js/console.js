import { $, fmtBytes, h, mdLite, toast } from './util.js';
import { BANNER, face, spinner, tintOf } from './ascii.js';
import { state, on, emit } from './store.js';
import { api } from './api.js';
import { colourLine } from './terminal.js';

const EXEC_DOM_CAP = 20000;
const CHAT_DOM_CAP = 200; // messages kept on screen, as many as the server keeps

// ---------------------------------------------------------- command cards

const cards = new Map(); // exec id -> card

const act = (promise) => promise.catch((err) => toast(err.message, 'err'));
const button = (label, cls, onclick) => h('button', { class: `btn sm ${cls}`, type: 'button', onclick }, label);

const confirmAuto = () => confirm('Let agents run shell commands on this computer without asking you first?');

function buildCard({ id, command, owner, keep, url }) {
  const out = h('pre', { class: 'exec-out' });
  const foot = h('span', { class: 'exec-foot' });
  const actions = h('span', { class: 'exec-actions' });
  const el = h(
    'div',
    // A command run by one of the crew wears that agent's colour.
    { class: `msg exec${state.agents[owner] ? ' tinted' : ''}`, style: state.agents[owner] ? tintOf(owner) : null },
    h('div', { class: 'exec-head' }, h('code', null, '$ ', colourLine(command)), h('span', { class: 'who' }, state.agents[owner] ? `${face(owner)} ${state.agents[owner].name}` : owner.replace(/-/g, ' ')), h('span', { class: 'spacer' }), foot, actions),
    out,
  );
  return { id, el, out, foot, actions, chars: 0, keep: Boolean(keep), url: url ?? null };
}

/** Move a card to one of its states. `info` is the server event or history entry. */
function setCard(card, phase, info = {}) {
  card.actions.replaceChildren();
  card.el.classList.remove('fail', 'wait');
  if (phase === 'request') {
    card.el.classList.add('wait');
    card.foot.textContent = 'needs your OK';
    card.actions.append(
      button('Run', 'primary', () => act(api.execAction(card.id, 'approve'))),
      button('Deny', 'danger', () => act(api.execAction(card.id, 'deny'))),
      button('Always run', '', () => confirmAuto() && act(api.execMode('auto'))),
    );
  } else if (phase === 'denied') {
    card.el.classList.add('fail');
    card.foot.textContent = 'denied';
  } else if (phase === 'running') {
    // A dev server kept running says where it is, and opens there.
    card.foot.textContent = card.keep ? (card.url ? `serving ${card.url}` : 'keeps running') : 'running…';
    if (card.url) card.actions.append(button('Open', '', () => emit('browsertab', card.url)));
    card.actions.append(button(card.keep ? 'Stop' : 'Kill', 'danger', () => act(api.execAction(card.id, 'kill'))));
  } else if (phase === 'end') {
    const ok = info.code === 0;
    if (!ok) card.el.classList.add('fail');
    const how = info.timedOut ? 'timed out' : info.killed ? 'killed' : `exit ${info.code}`;
    card.foot.textContent = `${how} · ${(info.durationMs / 1000).toFixed(1)}s`;
    // The final output is authoritative (and already clipped by the server).
    card.out.textContent = info.output || (ok ? '(finished, and printed nothing)' : '');
  }
}

function liveCard(info) {
  let card = cards.get(info.id);
  if (!card) {
    card = buildCard(info);
    cards.set(info.id, card);
    append(card.el);
  }
  return card;
}

function onExec(event) {
  if (event.type === 'output') {
    const card = cards.get(event.id);
    if (!card) return;
    card.chars += event.chunk.length;
    if (card.chars <= EXEC_DOM_CAP) card.out.append(event.chunk);
    card.out.scrollTop = card.out.scrollHeight;
    return;
  }
  const card = liveCard(event);
  if (event.type === 'request') setCard(card, 'request');
  else if (event.type === 'resolved') setCard(card, event.approved ? 'running' : 'denied');
  else if (event.type === 'start') setCard(card, 'running');
  else if (event.type === 'end') setCard(card, 'end', event);
  else if (event.type === 'port') {
    card.url = event.url;
    setCard(card, 'running');
  }
}

// ------------------------------------------------------------------- chat

const MANAGER = 'general-manager';

/** Just above the box you type in: who is at work right now, in their colour. */
function renderActive() {
  const busy = Object.values(state.agents).filter((agent) => agent.state === 'working');
  const strip = $('#chat-active');
  // The strip takes room from the chat: if you were reading the latest message, keep it in view.
  const chat = $('#chat');
  const atEnd = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
  strip.hidden = !busy.length;
  strip.replaceChildren(
    ...busy.map((agent) =>
      h(
        'div',
        { class: 'active-row tinted', style: tintOf(agent.id), title: agent.task || '' },
        h('span', { class: 'face' }, face(agent.id)),
        h('strong', null, agent.name),
        h('span', { class: 'active-task' }, agent.task || 'working'),
        spinner(),
      ),
    ),
  );
  if (atEnd) chat.scrollTop = chat.scrollHeight;
}

function messageEl(message) {
  if (message.role === 'system') return h('div', { class: 'msg system' }, message.text);
  if (message.role === 'exec') {
    const card = buildCard(message);
    setCard(card, message.denied ? 'denied' : 'end', message);
    return card.el;
  }
  const who =
    message.role === 'user' ? (message.source && message.source !== 'ui' ? `You · via ${message.source}` : 'You') : `${face(MANAGER)} Chef`;
  const fromManager = message.role === 'manager';
  const failed = message.role === 'manager' && message.ok === false;
  return h(
    'div',
    { class: `msg ${message.role}${failed ? ' fail' : ''}${fromManager ? ' tinted' : ''}`, style: fromManager ? tintOf(MANAGER) : null, dataset: message.role === 'manager' && message.runId ? { run: message.runId } : {} },
    h('span', { class: 'who' }, who),
    h('div', { innerHTML: mdLite(message.text) }),
  );
}

/** Give each finished run's report its "View changes" / "Undo" buttons. */
function decorateRuns() {
  for (const el of document.querySelectorAll('#chat .msg[data-run]')) {
    el.querySelector('.run-actions')?.remove();
    const run = state.runs.find((r) => r.id === el.dataset.run);
    if (!run || !run.hasDiff) continue;
    // If the run produced a web page, offer to open it.
    const page = !run.undone && state.app.previewUrl && (run.files.find((f) => /(^|\/)index\.html?$/i.test(f)) ?? run.files.find((f) => /\.html?$/i.test(f)));
    el.append(
      h(
        'div',
        { class: 'run-actions' },
        button('View changes', '', () => emit('showdiff', run)),
        page && button('Open preview', '', () => emit('browsertab', `${state.app.previewUrl}/${page.split('/').map(encodeURIComponent).join('/')}`)),
        run.canUndo &&
          button('Undo this run', 'danger', () => {
            const sure = confirm(`Undo "${run.objective}"?\n\nEvery file goes back to how it was before this run - including any edits you made since.`);
            if (sure) act(api.undoRun(run.id));
          }),
        run.undone && h('span', { class: 'muted' }, 'undone'),
      ),
    );
  }
}

function welcome() {
  const { app } = state;
  const notice = app.mock
    ? 'Demo mode: providers are simulated (with a fake 429 every third call), so replies are canned. Add a free API key to switch to real models.'
    : !app.hasProviders
      ? 'No API keys yet. Add a free Gemini, Groq or Cerebras key to get started. It takes a minute and needs no card.'
      : '';
  return h(
    'div',
    { class: 'welcome' },
    h('pre', { class: 'banner', ariaLabel: 'Kadhai' }, BANNER),
    h('div', null, h('b', null, 'What should we cook?'), 'Type what you want built in the box below. The crew plans it, writes it and checks it, and you can watch them in the kitchen.'),
    h('div', { class: 'tip' }, 'Tip: start a line with ', h('code', null, '!'), ' to run a shell command yourself.'),
    notice && h('div', { class: 'notice' }, h('span', null, notice), button('Add API keys', 'primary', () => emit('openkeys')), !app.mock && button('Try the demo', '', () => emit('trydemo'))),
  );
}

function append(el) {
  const chat = $('#chat');
  chat.querySelector('.welcome')?.remove();
  chat.append(el);
  while (chat.childElementCount > CHAT_DOM_CAP) chat.firstElementChild.remove();
  chat.scrollTop = chat.scrollHeight;
}

function renderChat() {
  const chat = $('#chat');
  cards.clear();
  chat.replaceChildren(...(state.chat.length ? state.chat.map(messageEl) : [welcome()]));
  // Commands still waiting or running are not in the history yet.
  for (const info of state.exec.pending) setCard(liveCard(info), 'request');
  for (const info of state.exec.running) setCard(liveCard(info), 'running');
  decorateRuns();
  // A conversation opens at its latest message; the welcome opens at its top.
  chat.scrollTop = state.chat.length ? chat.scrollHeight : 0;
}

function renderRun() {
  const busy = Boolean(state.run);
  $('#chat-stop').hidden = !busy;
  $('#chat-send').textContent = busy ? 'Queue' : 'Send';
  $('#chat-send').title = busy ? 'The crew is busy: this task will start when the current one finishes' : '';

  // Tasks waiting their turn sit just above the box you type in.
  const queue = $('#queue');
  queue.hidden = !state.queue.length;
  queue.replaceChildren(
    ...state.queue.map((q, i) =>
      h(
        'span',
        { class: 'step queued', title: q.request },
        h('span', { class: 'queued-text' }, `Up next${state.queue.length > 1 ? ` (${i + 1})` : ''}: ${q.request}`),
        h('button', { class: 'icon-btn', type: 'button', title: 'Remove from the queue', onclick: () => act(api.unqueue(q.id)) }, '×'),
      ),
    ),
  );
}

function autosize(input) {
  input.style.height = 'auto';
  input.style.height = `${Math.min(Math.max(input.scrollHeight + 2, 54), 180)}px`;
}

// Files picked for the next message. They are saved into the workspace (attachments/) when it is sent.
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
let attachments = []; // [{ name, size, data }] - data is base64

function renderAttachments() {
  const list = $('#attachments');
  list.hidden = !attachments.length;
  list.replaceChildren(
    ...attachments.map((file) =>
      h(
        'span',
        { class: 'attach', title: file.name },
        h('span', { class: 'name' }, file.name),
        h('span', { class: 'muted' }, fmtBytes(file.size)),
        h('button', { class: 'icon-btn', type: 'button', title: 'Remove', onclick: () => ((attachments = attachments.filter((f) => f !== file)), renderAttachments()) }, '×'),
      ),
    ),
  );
}

const readBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
    reader.onerror = () => reject(new Error(`Could not read "${file.name}"`));
    reader.readAsDataURL(file);
  });

async function addAttachments(files) {
  for (const file of files) {
    if (attachments.length >= MAX_ATTACHMENTS) {
      toast(`At most ${MAX_ATTACHMENTS} files per message`, 'err');
      break;
    }
    if (!file.size) toast(`"${file.name}" is empty`, 'err');
    else if (file.size > MAX_ATTACHMENT_BYTES) toast(`"${file.name}" is larger than 2 MB`, 'err');
    else {
      try {
        attachments.push({ name: file.name || 'pasted-file', size: file.size, data: await readBase64(file) });
      } catch (err) {
        toast(err.message, 'err');
      }
    }
  }
  renderAttachments();
}

export function initConsole() {
  const input = $('#chat-input');
  const mode = $('#exec-mode');

  on('sync', () => {
    renderChat();
    renderRun();
    mode.value = state.exec.mode;
  });
  on('chat', (message) => {
    append(messageEl(message));
    decorateRuns();
  });
  on('runs', decorateRuns);
  on('agents', renderActive);
  // High flame with a subscription CLI set up: its agents may be allowed commands, task by task.
  const agentShell = () => {
    $('#agent-shell').hidden = !(state.app.flame === 'high' && (state.providers.routes ?? []).some((r) => r.kind === 'cli' && !r.disabled));
  };
  on('flame', agentShell);
  on('providers', agentShell);
  on('sync', agentShell);
  on('sync', renderActive);
  on('run', renderRun);
  on('exec', onExec);
  on('execmode', () => {
    mode.value = state.exec.mode;
  });

  mode.onchange = () => {
    if (mode.value === 'auto' && !confirmAuto()) {
      mode.value = state.exec.mode;
      return;
    }
    act(api.execMode(mode.value));
  };

  $('#chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    const isCommand = text.startsWith('!');
    if (!text) {
      if (attachments.length) toast('Say what to do with the attached files');
      return;
    }
    const files = isCommand ? [] : attachments;
    input.value = '';
    autosize(input);
    if (!isCommand) attachments = [];
    renderAttachments();
    try {
      if (isCommand) await api.exec(text.slice(1));
      else {
        const paths = [];
        for (const file of files) paths.push((await api.attach(file.name, file.data)).path);
        // Asked per task: it goes back to edits only after each one.
        const shell = !$('#agent-shell').hidden && $('#agent-shell-box').checked;
        $('#agent-shell-box').checked = false;
        if ((await api.task(text, paths, shell)).queued) toast('Queued. It starts when the current task finishes');
      }
    } catch (err) {
      input.value = text;
      autosize(input);
      attachments = files;
      renderAttachments();
      toast(err.message, 'err');
    }
  });
  input.addEventListener('input', () => autosize(input));

  // Attach by button, by dropping files on the composer, or by pasting them.
  const form = $('#chat-form');
  const picker = $('#attach-input');
  $('#attach-btn').onclick = () => picker.click();
  picker.onchange = () => {
    addAttachments([...picker.files]);
    picker.value = '';
  };
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  form.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    form.classList.add('drop');
  });
  form.addEventListener('dragleave', () => form.classList.remove('drop'));
  form.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    form.classList.remove('drop');
    addAttachments([...e.dataTransfer.files]);
  });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    addAttachments(files);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#chat-form').requestSubmit();
    }
  });
  $('#chat-stop').onclick = () => act(api.stop());

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      input.focus();
    }
  });

  input.focus();
}
