import { $, toast } from './util.js';
import { state, emit, on } from './store.js';
import { api } from './api.js';
import { initCrew } from './crew.js';
import { initFiles } from './files.js';
import { initConsole } from './console.js';
import { initSettings } from './settings.js';
import { initKeys } from './keys.js';
import { initGit } from './git.js';
import { initMcp } from './mcp.js';
import { initTerminal } from './terminal.js';
import { initTriggers } from './triggers.js';
import { initFlows } from './flows.js';
import { initAbout } from './about.js';
import { initRooms } from './rooms.js';
import { initBrowser } from './browser.js';
import { initFlame } from './flame.js';
import { initUsage } from './usage.js';
import { initLayout } from './layout.js';

const THOUGHT_CAP = 20000;

/** Pull a full snapshot. Used on boot and after every reconnect, so the UI can never drift. */
async function sync() {
  const snap = await api.state();
  state.app = snap.app;
  state.agents = Object.fromEntries(snap.agents.map(({ thought, ...agent }) => [agent.id, agent]));
  state.thoughts = Object.fromEntries(snap.agents.map((a) => [a.id, a.thought]));
  state.skills = snap.skills ?? [];
  state.access = snap.access ?? {};
  state.providers = { ...snap.providers, at: Date.now() };
  state.mcp = snap.mcp;
  state.locks = snap.locks;
  state.chat = snap.chat;
  state.run = snap.run;
  state.exec = snap.exec;
  state.queue = snap.queue;
  state.runs = snap.runs;
  emit('sync');
}

/** Server event -> state mutation -> topic for the modules to re-render. */
const handlers = {
  'agent:update': ({ agent }) => {
    state.agents[agent.id] = agent;
    emit('agents');
  },
  'agent:thought': (data) => {
    state.thoughts[data.id] = ((state.thoughts[data.id] ?? '') + data.delta).slice(-THOUGHT_CAP);
    emit('thought', data);
  },
  'providers:update': (data) => {
    state.providers = { ...data, at: Date.now() };
    emit('providers');
  },
  'provider:swap': ({ from, to }) => {
    toast(`Hot-swapped ${from} -> ${to}`);
    emit('chat', { role: 'system', text: `hot-swap: ${from} -> ${to}` });
  },
  'mcp:update': ({ servers }) => {
    state.mcp = servers;
    emit('mcp');
  },
  'lock:acquired': (lock) => {
    state.locks = [...state.locks.filter((l) => l.path !== lock.path), lock];
    emit('locks');
  },
  'lock:released': ({ path }) => {
    state.locks = state.locks.filter((l) => l.path !== path);
    emit('locks');
  },
  'fs:change': ({ paths }) => emit('fs', paths),
  'fs:write': ({ path }) => emit('fs', [path]),
  'memory:update': () => emit('fs', ['memory.md']),
  'run:start': ({ runId, request }) => {
    state.run = { id: runId, request, plan: null, startedAt: Date.now() };
    emit('run');
  },
  'run:plan': ({ objective, subtasks }) => {
    if (state.run) state.run.plan = { objective, subtasks };
    emit('run');
  },
  'run:done': ({ ok } = {}) => {
    // For the kitchen: everyone cheers a finished run; the cooks of failed steps slump.
    const failed = (state.run?.plan?.subtasks ?? []).filter((s) => s.status === 'failed').map((s) => s.cookId);
    state.lastRun = { ok: Boolean(ok), failed, at: performance.now() };
    state.run = null;
    emit('run');
  },
  // Keys changed: providers, demo mode and the welcome text may all differ now.
  'keys:update': () => sync().catch(() => {}),
  'flame:update': ({ flame }) => {
    state.app.flame = flame;
    emit('flame');
  },
  // An agent was hired, edited or let go: the roster itself changed.
  'crew:update': () => sync().catch(() => {}),
  'git:change': () => emit('git'),
  'connectors:update': () => emit('connectors'),
  'triggers:update': () => emit('triggers'),
  'flows:update': () => emit('flows'),
  'lessons:update': () => emit('lessons'),
  'journal:update': () => emit('journal'),
  'queue:update': ({ queue }) => {
    state.queue = queue;
    emit('run');
  },
  'runs:update': ({ runs }) => {
    state.runs = runs;
    emit('runs');
  },
  'exec:mode': ({ mode }) => {
    state.exec.mode = mode;
    emit('execmode');
  },
  'exec:request': (data) => emit('exec', { type: 'request', ...data }),
  'exec:resolved': (data) => {
    if (!data.approved) state.chat.push({ role: 'exec', ...data, denied: true });
    emit('exec', { type: 'resolved', ...data });
  },
  'exec:start': (data) => {
    // Kept current between syncs: Ctrl+C in the terminal and the dev-server list read it.
    if (!state.exec.running.some((r) => r.id === data.id)) state.exec.running.push(data);
    emit('exec', { type: 'start', ...data });
  },
  'exec:output': (data) => emit('exec', { type: 'output', ...data }),
  // A command kept running printed an address on this computer: a dev server is up.
  'exec:port': (data) => {
    const job = state.exec.running.find((r) => r.id === data.id);
    if (job) job.url = data.url;
    emit('exec', { type: 'port', ...data });
  },
  'exec:end': (data) => {
    state.exec.running = state.exec.running.filter((r) => r.id !== data.id);
    state.chat.push({ role: 'exec', ...data });
    emit('exec', { type: 'end', ...data });
  },
  'chat:message': ({ message }) => {
    state.chat.push(message);
    emit('chat', message);
  },
};

function connect() {
  let warned = false;
  const events = new EventSource('/api/events');
  // Snapshot on every (re)connect: the stream is already open, so nothing is missed.
  events.onopen = () => {
    $('#conn-dot').classList.add('on');
    warned = false;
    state.switching = false;
    sync().catch((err) => toast(err.message, 'err'));
  };
  events.onerror = () => {
    // EventSource retries on its own; we only need to show that the link is down.
    $('#conn-dot').classList.remove('on');
    $('#route-label').textContent = 'server offline';
    if (!warned && !state.switching) toast('Lost the Kadhai server — retrying…', 'err');
    warned = true;
  };
  events.onmessage = (e) => {
    try {
      const { type, data } = JSON.parse(e.data);
      handlers[type]?.(data);
    } catch (err) {
      console.error('Could not handle a server event', err);
    }
  };
}

// Another folder was opened: everything on screen belongs to the old one.
on('resync', () => sync().catch((err) => toast(err.message, 'err')));

// The page's last line of defence, in place of a framework's error boundary: an error nothing
// else caught is shown (once every few seconds at most) instead of failing silently.
let lastShown = 0;
function report(message) {
  console.error(message);
  if (Date.now() - lastShown < 5000) return;
  lastShown = Date.now();
  toast(`Something went wrong on this page: ${String(message).slice(0, 160)}. Reloading usually fixes it.`, 'err');
}
window.addEventListener('error', (e) => {
  // Only this page's own scripts: an extension's error is not ours to report.
  if (e.filename && !e.filename.startsWith(location.origin)) return;
  // The browser's note that a resize was handled a frame late: harmless, never a bug of ours to show.
  if (/ResizeObserver loop/.test(e.message)) return;
  report(e.error?.message ?? e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  // An API call that failed has already been shown where it was made, or is the server being down.
  if (e.reason?.offline) return;
  report(e.reason?.message ?? e.reason);
});

// Each part starts on its own: one that fails is reported, and the rest of the page still works.
for (const [name, init] of Object.entries({ initSettings, initKeys, initGit, initMcp, initTerminal, initTriggers, initFlows, initAbout, initRooms, initBrowser, initFlame, initUsage, initLayout, initCrew, initFiles, initConsole })) {
  try {
    init();
  } catch (err) {
    report(`${name.slice(4)} could not start (${err.message})`);
  }
}

connect();
