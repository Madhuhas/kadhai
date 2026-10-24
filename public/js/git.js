import { $, h, toast, prefs } from './util.js';
import { state, on, emit } from './store.js';
import { api } from './api.js';

/**
 * Source control: the folder's own git repository, shown under the file tree.
 * What changed, stage / unstage, commit, discard, diff, branches, push and pull.
 */
let status = null; // last answer from the server
let history = [];
let timer = null;
let open = prefs.get('scm') !== 'closed';
let showHistory = false;

const LETTER = { M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', U: 'U', T: 'T' };
const MEANING = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'new (untracked)', T: 'type changed' };
const baseOf = (path) => path.split('/').pop();
const dirOf = (path) => path.split('/').slice(0, -1).join('/');
const fail = (err) => toast(err.message, 'err');

async function refresh() {
  try {
    status = await api.git.status();
    if (status.repo && showHistory) history = (await api.git.log()).commits;
  } catch (err) {
    status = { available: true, repo: false, error: err.message };
  }
  render();
}

/** Things change often while the crew works: refresh shortly after, not on every event. */
function refreshSoon() {
  clearTimeout(timer);
  timer = setTimeout(refresh, 500);
}

/** Run a git action, then show the new state. */
const run = (action, done) => async () => {
  try {
    const result = await action();
    if (done) toast(typeof done === 'function' ? done(result) : done, 'ok');
  } catch (err) {
    fail(err);
  }
  refresh();
};

function fileRow(file, staged) {
  const letter = staged ? file.index : file.work;
  const dir = dirOf(file.path);
  return h(
    'div',
    {
      class: 'scm-file',
      role: 'button',
      tabIndex: 0,
      title: `${file.path}: ${MEANING[letter] ?? letter}${file.conflicted ? ' (conflict)' : ''}\nClick to see the change`,
      onclick: async () => {
        try {
          const diff = await api.git.diff(file.path, staged);
          emit('showpatch', { title: `${file.path}${staged ? ' (staged)' : ''}`, patch: diff.patch, truncated: diff.truncated });
        } catch (err) {
          fail(err);
        }
      },
    },
    h('span', { class: `scm-letter s-${letter}` }, LETTER[letter] ?? letter),
    h('span', { class: 'name' }, baseOf(file.path), dir && h('span', { class: 'scm-dir' }, ` ${dir}`)),
    h(
      'span',
      { class: 'row-actions' },
      !staged &&
        h(
          'button',
          {
            class: 'icon-btn',
            title: 'Discard this change',
            onclick: (e) => {
              e.stopPropagation();
              const what = letter === 'U' ? `Delete the new file "${file.path}"?` : `Throw away your changes to "${file.path}"?`;
              if (confirm(`${what}\n\nThis cannot be undone.`)) run(() => api.git.discard(file.path))();
            },
          },
          'rv',
        ),
      h(
        'button',
        { class: 'icon-btn', title: staged ? 'Unstage' : 'Stage', onclick: (e) => { e.stopPropagation(); run(() => (staged ? api.git.unstage([file.path]) : api.git.stage([file.path])))(); } },
        staged ? '−' : '+',
      ),
    ),
  );
}

function group(label, files, staged) {
  if (!files.length) return [];
  return [
    h(
      'div',
      { class: 'scm-group' },
      h('span', null, `${label} (${files.length})`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn', title: staged ? 'Unstage everything' : 'Stage everything', onclick: run(() => (staged ? api.git.unstage([], true) : api.git.stage([], true))) }, staged ? '−' : '+'),
    ),
    ...files.map((file) => fileRow(file, staged)),
  ];
}

async function pickBranch(select) {
  const value = select.value;
  if (value === status.branch) return;
  if (value !== '\u0000new') return run(() => api.git.checkout(value), `Now on ${value}`)();
  const name = prompt('Name for the new branch:', 'feature/');
  select.value = status.branch;
  if (name?.trim()) run(() => api.git.checkout(name.trim(), true), `Created ${name.trim()}`)();
}

function render() {
  const body = $('#scm-body');
  const badge = $('#scm-count');
  $('#scm').classList.toggle('closed', !open);
  $('#scm-toggle').textContent = open ? '[-]' : '[+]';
  const changed = status?.repo ? status.files.length : 0;
  badge.hidden = !changed;
  badge.textContent = String(changed);
  if (!open || !status) return body.replaceChildren();

  if (!status.available) {
    return body.replaceChildren(h('p', { class: 'scm-note' }, 'Git is not installed on this computer, so there is no source control here.'));
  }
  if (!status.repo) {
    return body.replaceChildren(
      h('p', { class: 'scm-note' }, status.parent ? `This folder is inside a larger repository (${status.parent}). Open that folder to commit from here.` : status.error ?? 'This folder is not a git repository yet.'),
      ...(status.parent || status.error ? [] : [h('button', { class: 'btn sm', onclick: run(() => api.git.init(), 'Repository created') }, 'Initialize repository')]),
    );
  }

  const staged = status.files.filter((f) => f.staged);
  const unstaged = status.files.filter((f) => f.unstaged);
  const message = h('textarea', { id: 'scm-message', ariaLabel: 'Commit message', rows: 2, placeholder: `Message (commit on ${status.branch})`, value: body.querySelector('#scm-message')?.value ?? '' });
  const commit = h(
    'button',
    {
      class: 'btn sm',
      disabled: !status.files.length,
      title: staged.length ? 'Commit what is staged' : 'Nothing is staged, so this commits every change',
      onclick: async () => {
        try {
          const result = await api.git.commit(message.value);
          message.value = '';
          toast(`Committed ${result.commit}`, 'ok');
        } catch (err) {
          fail(err);
        }
        refresh();
      },
    },
    staged.length ? `Commit ${staged.length} staged` : 'Commit all',
  );

  const branches = h(
    'select',
    { class: 'select scm-branch', title: 'Switch branch', onchange: (e) => pickBranch(e.target) },
    ...[...new Set([status.branch, ...(status.branches ?? [])])].map((b) => h('option', { value: b, selected: b === status.branch }, b)),
    h('option', { value: '\u0000new' }, '+ New branch…'),
  );

  const sync = status.upstream
    ? [
        h(
          'div',
          { class: 'scm-sync' },
          h('span', { class: 'muted', title: `Tracking ${status.upstream}` }, `↑${status.ahead} ↓${status.behind}`),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn sm', onclick: run(() => api.git.pull(), (r) => r.message) }, 'Pull'),
          h('button', { class: 'btn sm', disabled: !status.ahead, onclick: run(() => api.git.push(), 'Pushed') }, 'Push'),
        ),
      ]
    : [];

  body.replaceChildren(
    h('div', { class: 'scm-top' }, branches, h('span', { class: 'spacer' }), h('button', { class: 'icon-btn wide', title: 'Refresh', onclick: refresh }, 'reload')),
    message,
    h('div', { class: 'scm-commit' }, commit),
    ...group('Staged', staged, true),
    ...group('Changes', unstaged, false),
    ...(status.files.length ? [] : [h('p', { class: 'scm-note' }, status.hasCommits ? 'Nothing to commit. Everything is saved in git.' : 'No changes yet. Add some files, then make your first commit.')]),
    ...sync,
    h(
      'button',
      {
        class: 'scm-history-toggle',
        onclick: () => {
          showHistory = !showHistory;
          refresh();
        },
      },
      `${showHistory ? '[-]' : '[+]'} History`,
    ),
    ...(showHistory
      ? history.length
        ? history.map((c) => h('div', { class: 'scm-commit-row', title: `${c.hash} · ${c.author} · ${c.when}` }, h('span', { class: 'name' }, c.subject), h('span', { class: 'scm-dir' }, c.when)))
        : [h('p', { class: 'scm-note' }, 'No commits yet.')]
      : []),
  );
}

export function initGit() {
  $('#scm-head').onclick = () => {
    open = !open;
    prefs.set('scm', open ? 'open' : 'closed');
    render();
    if (open) refresh();
  };
  on('sync', refresh);
  on('fs', refreshSoon);
  on('git', refreshSoon);
  on('run', () => !state.run && refreshSoon());
}
