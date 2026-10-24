import { $, h, toast } from './util.js';
import { api } from './api.js';
import { BANNER, potDrawing } from './ascii.js';

/**
 * About: which Kadhai this is, what it is running on, and what is set up -
 * the things worth knowing when something behaves oddly, in a form that can
 * be copied into a message. Nothing secret is shown: no keys, no tokens.
 */
const since = (ms) => {
  const minutes = Math.floor((Date.now() - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} days`;
};

/** The facts, as [label, value] rows grouped under headings. */
function sections(a) {
  const protection = { dpapi: 'encrypted; the key is held by your Windows account', file: 'encrypted; the key is a file beside them', none: 'nothing stored yet' };
  return [
    ['this copy', [
      ['Version', a.version],
      ['Running for', since(a.startedAt)],
      ['Mode', a.mock ? 'demo (simulated models)' : 'real models'],
      ['Running as', a.desktop ? 'the desktop app' : 'a server, in your browser'],
      ['Node.js', a.node],
      ['System', a.system],
      ['Licence', `${a.licenseName} (${a.license})`],
    ]],
    ['where', [
      ['Folder open', a.workspaceDir],
      ['Kadhai lives in', a.root],
      ...(a.data && a.data !== a.root ? [['Your settings in', a.data]] : []),
      ['Dashboard', a.dashboard],
      ['Kitchen', a.room === 'main' ? 'the first kitchen' : `an extra kitchen (${a.room})`],
      ['Preview', a.previewUrl ?? 'not available'],
    ]],
    ['what is set up', [
      ['Crew', `${a.counts.agents} agents${a.counts.hired ? ` (${a.counts.hired} hired by you)` : ''}`],
      ['Models', `${a.counts.routes} route${a.counts.routes === 1 ? '' : 's'} from ${a.providers.join(', ') || 'no provider yet'}${a.counts.paidRoutes ? ` - ${a.counts.paidRoutes} paid` : ''}`],
      ['Connections', `${a.counts.connections} connected, ${a.counts.tools} tools`],
      ['Flows', `${a.counts.flows}${a.counts.flowsOn ? ` (${a.counts.flowsOn} on)` : ''}`],
      ['Triggers', String(a.counts.triggers)],
      ['Flow credentials', String(a.counts.credentials ?? 0)],
      ['Skills', String(a.counts.skills)],
      ['Memory of this folder', `${a.counts.journal} run${a.counts.journal === 1 ? '' : 's'} in the journal, ${a.counts.lessons} lesson${a.counts.lessons === 1 ? '' : 's'} learned`],
    ]],
    ['safety', [
      ['Agent commands', { ask: 'ask before each one', auto: 'run freely', off: 'not allowed' }[a.execMode] ?? a.execMode],
      ['Sandbox', a.sandbox === 'docker' ? `Docker${a.sandboxReady ? '' : ' (not reachable: commands are refused)'}` : 'none - commands run on this computer'],
      ['Flame', a.flame === 'high' ? 'high - bigger prompts, paid models first, up to 3 steps at once, subscription CLIs as agents (edits only unless ticked per task)' : 'low - saves tokens, one step at a time'],
      ['Command time limit', `${Math.round(a.commandTimeoutMs / 1000)} s; up to ${a.keepRunning} of yours may keep running (dev servers)`],
      ['Undo per run', a.checkpoints ? 'on' : 'off (git not found)'],
      ['Saved secrets', protection[a.secrets] ?? a.secrets],
      ['Listens on', 'this computer only'],
    ]],
  ];
}

/**
 * The legal notices the AGPL asks an interactive program to show (section 5 d):
 * the copyright, that there is no warranty, and how to read the licence itself.
 */
function licence(a) {
  const text = h('pre', { class: 'about-licence', tabIndex: 0, ariaLabel: 'The licence', hidden: true });
  const read = h('button', { class: 'btn sm', type: 'button', ariaExpanded: 'false' }, 'Read the licence');
  read.onclick = async () => {
    const show = text.hidden;
    if (show && !text.textContent) {
      try {
        text.textContent = (await api.license()).text;
      } catch (err) {
        toast(err.message, 'err');
        return;
      }
    }
    text.hidden = !show;
    read.setAttribute('aria-expanded', String(show));
    read.textContent = show ? 'Hide the licence' : 'Read the licence';
  };
  return [
    h('h4', null, 'licence'),
    h('p', { class: 'about-notice' }, h('strong', null, a.copyright)),
    h('p', { class: 'about-notice' }, `Kadhai is free software: you may use, share and change it under the terms of the ${a.licenseName}. If you run a changed copy as a service for other people, you must offer them its source code.`),
    h('p', { class: 'about-notice' }, 'It comes with ABSOLUTELY NO WARRANTY, to the extent the law allows. The full text is the LICENSE file in the folder Kadhai lives in.'),
    h('div', { class: 'about-notice' }, read),
    text,
  ];
}

function render(a) {
  const groups = sections(a);
  const asText = [`Kadhai ${a.version}`, ...groups.flatMap(([title, rows]) => ['', `[${title}]`, ...rows.map(([label, value]) => `${label}: ${value}`)])].join('\n');
  const copy = h('button', { class: 'btn sm', type: 'button' }, 'Copy details');
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(asText);
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy details'), 1500);
    } catch {
      toast('Could not copy — select the text and copy it by hand', 'err');
    }
  };
  $('#about-body').replaceChildren(
    h('pre', { class: 'banner about-banner', ariaLabel: 'Kadhai' }, BANNER),
    potDrawing(),
    h('p', { class: 'about-line' }, h('strong', null, `version ${a.version}`), ` · ${a.description}`),
    ...groups.flatMap(([title, rows]) => [
      h('h4', null, title),
      h('dl', { class: 'about-list' }, ...rows.flatMap(([label, value]) => [h('dt', null, label), h('dd', null, String(value))])),
    ]),
    ...licence(a),
    h('div', { class: 'dialog-actions' }, h('span', { class: 'muted' }, 'No keys or tokens are shown here.'), h('span', { class: 'spacer' }), copy),
  );
}

export function initAbout() {
  const dialog = $('#about-dialog');
  const open = async () => {
    try {
      render(await api.about());
      if (!dialog.open) dialog.showModal();
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  $('#about-btn').onclick = open;
  $('#about-close').onclick = () => dialog.close();
  dialog.addEventListener('click', (e) => e.target === dialog && dialog.close());
}
