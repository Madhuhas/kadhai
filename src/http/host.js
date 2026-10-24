import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { apiRouter, mcpEndpoint } from './app.js';
import { log, escapeHtml } from '../core/util.js';
import { claimRoom, releaseRoom, roomHolder } from './rooms.js';
import { cleanFlame } from '../core/flame.js';

const RECENT_MAX = 6;
const HIDDEN = /^[.$]|^(node_modules|System Volume Information)$/i;

/**
 * A folder in the preview with no index.html: list what is in it, so the browser tab
 * shows the folder's pages instead of "not found". Read through Workspace like any
 * other file access; dot-files stay hidden, as the static server denies them.
 */
async function previewListing(workspace, req, res, next) {
  if (req.method !== 'GET' || !req.path.endsWith('/')) return next();
  let dir;
  try {
    dir = decodeURIComponent(req.path).replace(/^\/+|\/+$/g, '');
  } catch {
    return next();
  }
  if (dir.split('/').some((part) => part.startsWith('.'))) return next();
  const depth = dir ? dir.split('/').length : 0;
  const tree = await workspace.tree({ maxDepth: depth, maxEntries: 3000 });
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  if (dir && !tree.some((e) => e.type === 'dir' && same(e.path, dir))) return next();
  const entries = tree.filter((e) => {
    const parent = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '';
    return same(parent, dir) && !e.path.split('/').pop().startsWith('.');
  });
  const link = (e) => {
    const name = e.path.split('/').pop();
    const slash = e.type === 'dir' ? '/' : '';
    return `<li><a href="${escapeHtml(encodeURIComponent(name) + slash)}">${escapeHtml(name + slash)}</a></li>`;
  };
  res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><meta charset="utf-8"><title>/${escapeHtml(dir)}</title>
<body style="margin:0;padding:16px 20px;font:14px/1.7 Consolas,'Cascadia Mono',monospace;color:#222;background:#fff">
<p style="margin:0 0 8px;color:#666">/${escapeHtml(dir)}${dir ? '/' : ''} - no index.html here, so these are the files</p>
<ul style="margin:0;padding-left:20px">${dir ? '<li><a href="../">../</a></li>' : ''}${entries.map(link).join('') || '<li style="color:#666">(empty)</li>'}</ul>`);
}

/**
 * Added to every HTML page the preview serves: tells the dashboard's browser tab about the
 * page's errors (uncaught errors, failed loads, rejected promises, console.error), so it can
 * offer "Fix this". It does nothing when the page is not in a frame, and it only ever sends.
 */
const PAGE_ERRORS_PATH = '/__kadhai/errors.js';
const PAGE_ERRORS_SCRIPT = `(() => {
  if (window.parent === window) return;
  const text = (value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === 'object') { try { return JSON.stringify(value); } catch { return String(value); } }
    return String(value);
  };
  const send = (kind, message, where) => {
    try { parent.postMessage({ kadhai: 'page-error', kind, message: text(message).slice(0, 600), where: String(where || '').slice(0, 200), page: location.pathname }, '*'); } catch {}
  };
  addEventListener('error', (e) => {
    const el = e.target;
    if (el && el !== window && (el.src || el.href)) send('load', 'Could not load ' + (el.src || el.href).replace(location.origin, ''), el.tagName.toLowerCase());
    else send('error', e.error || e.message, e.filename ? e.filename.replace(location.origin, '') + ':' + e.lineno : '');
  }, true);
  addEventListener('unhandledrejection', (e) => send('promise', e.reason, ''));
  const original = console.error;
  console.error = function (...args) { send('console', args.map(text).join(' '), ''); return original.apply(this, args); };
})();
`;

/**
 * An HTML page from the folder, with the error reporter added at the top of its head.
 * Read through Workspace like any other file; anything unusual (a dot-folder, a binary or
 * very large file, no such page) is left to the static server, which serves it unchanged.
 */
async function previewPage(workspace, req, res, next) {
  if (req.method !== 'GET') return next();
  let rel;
  try {
    rel = decodeURIComponent(req.path).replace(/^\/+/, '');
  } catch {
    return next();
  }
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  if (!/\.html?$/i.test(rel) || rel.split('/').some((part) => part.startsWith('.'))) return next();
  let file;
  try {
    file = await workspace.readFile(rel);
  } catch {
    return next();
  }
  if (file.binary || file.truncated) return next();
  const tag = `<script src="${PAGE_ERRORS_PATH}"></script>`;
  const head = /<head[^>]*>/i.exec(file.content) ?? /<html[^>]*>/i.exec(file.content);
  const html = head ? file.content.slice(0, head.index + head[0].length) + tag + file.content.slice(head.index + head[0].length) : tag + file.content;
  res.set('Cache-Control', 'no-store').type('html').send(html);
}

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const isDir = (dir) => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The web server's handle on "the engine in use right now".
 *
 * An engine is bound to one workspace folder for life, so opening a different
 * folder from the dashboard means building a fresh engine and swapping it in.
 * Everything the HTTP layer needs per engine (API router, MCP endpoint, preview
 * files) hangs off this object and is rebuilt on every swap; the Express app
 * itself only ever talks to the host.
 */
export class Host {
  constructor({ createEngine, options, settingsFile, globalSettingsFile = settingsFile }) {
    this.createEngine = createEngine;
    this.options = options;
    this.settingsFile = settingsFile;
    // The flame is one setting for every room (kept by the first room's file); a room may override it in its own.
    this.globalSettingsFile = globalSettingsFile;
    this.onGlobalChange = null;
    this.previewUrl = null;
    this.engine = null;
    // More than one folder at once: set by server.js (see rooms.js). Absent in tests that need only one.
    this.rooms = null;
    this.roomId = 'main';
  }

  async start() {
    const saved = readJson(this.settingsFile);
    // The folder chosen in the dashboard wins over the default, as long as it still exists.
    const workspaceDir = saved.workspaceDir && isDir(saved.workspaceDir) ? saved.workspaceDir : this.options.workspaceDir;
    this.engine = await this.createEngine({ ...this.options, workspaceDir });
    this.defaultDir = path.resolve(this.engine.config.data ?? this.engine.config.root, process.env.WORKSPACE_DIR ?? 'workspace');
    // A folder is open in one room at a time. At start-up a folder held elsewhere is reported, not fatal.
    const holder = roomHolder(this.engine.config.workspaceDir);
    if (holder) log.warn(`${this.engine.config.workspaceDir} is also open in another Kadhai (process ${holder.pid}). Two crews in one folder can write over each other.`);
    else claimRoom(this.engine.config.workspaceDir, this.engine.config.port);
    this.#applyFlame();
    // A room that follows the main window's flame notices when it changes there.
    if (this.isRoom) {
      this.onGlobalChange = () => this.#applyFlame();
      fs.watchFile(this.globalSettingsFile, { interval: 3000 }, this.onGlobalChange);
    }
    this.#mount();
    return this;
  }

  get isRoom() {
    return path.resolve(this.settingsFile) !== path.resolve(this.globalSettingsFile);
  }

  /** The flame this process cooks on: the room's own, else the one every room shares, else low. */
  #applyFlame() {
    const own = this.isRoom ? cleanFlame(readJson(this.settingsFile).flame) : null;
    const flame = own ?? cleanFlame(readJson(this.globalSettingsFile).flame) ?? 'low';
    if (this.engine.flame !== flame) this.engine.setFlame(flame);
  }

  flameInfo() {
    const own = this.isRoom ? cleanFlame(readJson(this.settingsFile).flame) : null;
    return { flame: this.engine.flame, room: this.isRoom, own: Boolean(own), shared: cleanFlame(readJson(this.globalSettingsFile).flame) ?? 'low' };
  }

  /**
   * Set the flame. In the first room it is the setting every room follows; in another room it is
   * that room's own, and null goes back to following the first room.
   */
  async setFlame(level) {
    const flame = level === null && this.isRoom ? null : cleanFlame(level);
    if (!flame && !(level === null && this.isRoom)) throw fail('The flame is "low" or "high"');
    const rest = readJson(this.settingsFile);
    delete rest.flame;
    // Merged, not replaced: the file also holds the folder (and, for a room, its id and port).
    await fs.promises.writeFile(this.settingsFile, `${JSON.stringify(flame ? { ...rest, flame } : rest, null, 2)}\n`);
    this.#applyFlame();
    return this.flameInfo();
  }

  #mount() {
    const { engine } = this;
    engine.previewUrl = this.previewUrl;
    this.api = apiRouter(engine);
    this.mcp = mcpEndpoint(engine);
    const files = express.static(engine.config.workspaceDir, {
      dotfiles: 'deny',
      setHeaders: (res) => res.set('Cache-Control', 'no-store'),
    });
    this.preview = (req, res, next) => {
      if (req.path === PAGE_ERRORS_PATH) return res.set('Cache-Control', 'no-store').type('js').send(PAGE_ERRORS_SCRIPT);
      // A page gets the error reporter; everything else is served as it is; a folder with no page is listed.
      // Nothing is served through a link that leads out of the folder (static would follow it).
      const serveFile = () => {
        let rel;
        try {
          rel = decodeURIComponent(req.path);
        } catch {
          return next();
        }
        engine.workspace.staysInside(rel).then((inside) => (inside ? files(req, res, () => previewListing(engine.workspace, req, res, next).catch(next)) : next()), next);
      };
      previewPage(engine.workspace, req, res, serveFile).catch(next);
    };
  }

  setPreviewUrl(url) {
    this.previewUrl = url;
    this.engine.previewUrl = url;
  }

  #recent() {
    const saved = readJson(this.settingsFile);
    const current = this.engine.config.workspaceDir;
    return [...new Set([current, ...(Array.isArray(saved.recent) ? saved.recent : []), this.defaultDir])].filter(isDir).slice(0, RECENT_MAX);
  }

  info() {
    const dir = this.engine.config.workspaceDir;
    return { dir, name: path.basename(dir) || dir, recent: this.#recent(), defaultDir: this.defaultDir, room: this.roomId, rooms: Boolean(this.rooms) };
  }

  /** The server is stopping: let go of the folder, and of the rooms started from here. */
  async close() {
    if (this.onGlobalChange) fs.unwatchFile(this.globalSettingsFile, this.onGlobalChange);
    this.rooms?.stopAll?.();
    releaseRoom(this.engine.config.workspaceDir);
    await this.engine.close().catch(() => {});
  }

  /** Folders inside `target`, for the "open folder" dialog. Names only; nothing is read. */
  async browse(target) {
    const abs = path.resolve(target || path.dirname(this.engine.config.workspaceDir));
    let entries;
    try {
      entries = await fs.promises.readdir(abs, { withFileTypes: true });
    } catch (err) {
      throw fail(err.code === 'ENOENT' ? 'That folder does not exist' : `Cannot open that folder (${err.code})`, 400);
    }
    const home = os.homedir();
    const places = [
      { label: 'Home', path: home },
      { label: 'Desktop', path: path.join(home, 'Desktop') },
      { label: 'Documents', path: path.join(home, 'Documents') },
      // On Windows the drives are the roots.
      ...(process.platform === 'win32' ? 'CDEFGHIJ'.split('').map((letter) => ({ label: `${letter}:`, path: `${letter}:\\` })) : [{ label: '/', path: '/' }]),
    ].filter((place) => isDir(place.path));
    return {
      path: abs,
      parent: path.dirname(abs) === abs ? null : path.dirname(abs),
      dirs: entries
        .filter((e) => e.isDirectory() && !HIDDEN.test(e.name))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b)),
      places,
      ...this.info(),
    };
  }

  /** Create a folder while browsing, e.g. for a brand-new project. */
  async makeFolder(parent, name) {
    const clean = String(name ?? '').trim();
    if (!clean || /[\\/:*?"<>|]/.test(clean) || clean === '.' || clean === '..') throw fail('That is not a valid folder name');
    if (!parent || !path.isAbsolute(String(parent)) || !isDir(parent)) throw fail('Pick an existing folder to create it in');
    const target = path.join(parent, clean);
    if (fs.existsSync(target)) throw fail(`"${clean}" already exists there`, 409);
    await fs.promises.mkdir(target);
    return { path: target };
  }

  /** Switch the whole app to another workspace folder. */
  async open(dir) {
    const raw = String(dir ?? '').trim();
    if (!raw || !path.isAbsolute(raw)) throw fail('Give the full path of the folder');
    const abs = path.resolve(raw);
    if (!isDir(abs)) throw fail('That folder does not exist');
    if (path.dirname(abs) === abs) throw fail('Pick a folder, not a whole drive');
    const old = this.engine;
    if (path.resolve(old.config.workspaceDir) === abs) return this.info();
    if (old.orchestrator.busy || old.orchestrator.queue.length) throw fail('Wait for the crew to finish (or stop the run) before changing folder', 409);
    const holder = roomHolder(abs);
    if (holder) throw fail(`That folder is already open in another kitchen${holder.port ? ` (http://localhost:${holder.port})` : ''}. A folder is open in one kitchen at a time.`, 409);

    const next = await this.createEngine({
      ...this.options,
      // Carry over what the operator changed at runtime, so a folder switch changes nothing else.
      mock: old.config.mock,
      workspaceDir: abs,
    });
    next.dispatcher.importUsage(old.dispatcher.exportUsage());
    next.runner.mode = old.runner.mode;
    if (next.flame !== old.flame) next.setFlame(old.flame);

    this.engine = next;
    this.#mount();
    releaseRoom(old.config.workspaceDir);
    claimRoom(abs, next.config.port);
    // The folder just left goes straight to the top of "recent", so it is one click to go back.
    const recent = [...new Set([abs, old.config.workspaceDir, ...this.#recent()])].slice(0, RECENT_MAX);
    // Remembering the choice is a convenience: failing to must not leave the old engine half shut down.
    // Merged, not replaced: an extra room keeps its id and port in the same file.
    await fs.promises.writeFile(this.settingsFile, `${JSON.stringify({ ...readJson(this.settingsFile), workspaceDir: abs, recent }, null, 2)}\n`).catch((err) => log.warn(`Could not remember the folder: ${err.message}`));

    // Open dashboards are still listening to the old engine: end those streams so they reconnect to the new one.
    for (const stream of old.streams) stream.end();
    await old.close();
    return this.info();
  }
}
