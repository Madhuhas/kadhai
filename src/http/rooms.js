import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { killTree, log } from '../core/util.js';

export const MAX_ROOMS = 4; // extra rooms beside the first: each is a whole process of its own
const PORT_STEP = 10; // a room takes two ports (dashboard and preview), and there is space between rooms
const READY_TIMEOUT_MS = 30000;
const fail = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });
// Where a folder really is, so a Windows short name (PROGRA~1) or a link cannot open one folder in two rooms.
const real = (p) => {
  try {
    return fs.realpathSync.native(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
};
const same = (a, b) => real(a).toLowerCase() === real(b).toLowerCase();

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const alive = (pid) => {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

// ----------------------------------------------------- one folder, one room

const lockFile = (dir) => path.join(dir, '.kadhai', 'room.lock');

/** Who has this folder open as a room, if it is another process that is still running. */
export function roomHolder(dir) {
  const lock = readJson(lockFile(dir));
  return lock && lock.pid !== process.pid && alive(lock.pid) ? lock : null;
}

/** Mark a folder as open in this room. Quietly does nothing if the mark cannot be written. */
export function claimRoom(dir, port) {
  try {
    fs.mkdirSync(path.dirname(lockFile(dir)), { recursive: true });
    fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: process.pid, port, at: Date.now() }));
  } catch (err) {
    log.warn(`Could not mark ${dir} as open here: ${err.message}`);
  }
}

export function releaseRoom(dir) {
  try {
    if (readJson(lockFile(dir))?.pid === process.pid) fs.rmSync(lockFile(dir), { force: true });
  } catch {
    // Left behind, it names a process that is gone, and is ignored.
  }
}

/** Is anything listening on this port already? */
const portFree = (port) =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });

/**
 * Rooms: more than one folder open at once.
 *
 * The first room is the server you started. Every other room is another copy
 * of the same server, started by this one as a child process on ports of its
 * own, working in a different folder and shown in its own browser window. So
 * two projects really do run side by side, and nothing one room does - a long
 * run, a crash, a restart - touches the other.
 *
 * What rooms share: your keys, your skills, the MCP servers' settings. What
 * each room has to itself: its folder, its crew's live state and their
 * settings, its chat, journal and lessons, its flows and triggers.
 *
 * A room is remembered in rooms.local/<id>.json and comes back when Kadhai
 * is started again. Rooms end when this server ends.
 */
export class Rooms {
  #children = new Map(); // id -> { child, state: 'starting' | 'running' | 'stopped', error }

  constructor({ root, data = root, host, port, serverFile, dir = path.join(data, 'rooms.local'), mock = false, launch = null }) {
    this.root = root;
    this.data = data; // where the user's files are (agents.local.json)
    this.host = host;
    this.port = port;
    this.serverFile = serverFile;
    this.dir = dir;
    this.mock = mock;
    // Tests stand in for a real child process with a function of their own.
    this.launch = launch ?? ((record) => this.#spawn(record));
  }

  #file(id, suffix = '') {
    if (!/^[0-9a-f]{6}$/.test(String(id))) throw fail('No such kitchen', 404);
    return path.join(this.dir, `${id}${suffix}.json`);
  }

  #records() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((name) => /^[0-9a-f]{6}\.json$/.test(name))
      .map((name) => readJson(path.join(this.dir, name)))
      .filter((record) => record && typeof record.id === 'string' && Number.isInteger(record.port) && typeof record.workspaceDir === 'string')
      // In the order they were opened (ports are handed out upwards), not in the order of their random ids.
      .sort((x, y) => x.port - y.port);
  }

  /** Bring back the rooms that were open last time. */
  async start() {
    for (const record of this.#records()) {
      if (!fs.existsSync(record.workspaceDir)) continue; // its folder is gone: the room stays closed
      this.#start(record);
    }
  }

  #spawn(record) {
    return spawn(process.execPath, [this.serverFile, '--room', record.id, ...(this.mock ? ['--mock'] : [])], {
      cwd: this.root,
      // Inside the desktop app process.execPath is Electron: run it as Node.js, like the first server.
      env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}), PORT: String(record.port), WORKSPACE_DIR: record.workspaceDir, KADHAI_LOBBY: `http://127.0.0.1:${this.port}`, KADHAI_ROOMS_DIR: this.dir },
      // Its stdin is held open by us: when this server goes, the pipe closes and the room closes itself.
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  #start(record) {
    const entry = { child: null, state: 'starting', error: null };
    this.#children.set(record.id, entry);
    try {
      const child = this.launch(record);
      entry.child = child;
      child.stdout?.on('data', () => {}); // its banner: not ours to print
      child.stderr?.on('data', (chunk) => (entry.lastLog = String(chunk).trim().split('\n').pop()));
      child.once('error', (err) => Object.assign(entry, { state: 'stopped', error: err.message }));
      child.once('exit', (code) => {
        // Closed on purpose, it is already gone from the list.
        if (this.#children.get(record.id) === entry) Object.assign(entry, { state: 'stopped', error: `it stopped (exit ${code})${entry.lastLog ? `: ${entry.lastLog}` : ''}` });
      });
    } catch (err) {
      Object.assign(entry, { state: 'stopped', error: err.message });
    }
    return entry;
  }

  async #ready(record, entry, fetchImpl = globalThis.fetch) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (entry.state === 'stopped') throw fail(`The kitchen could not start: ${entry.error ?? 'unknown reason'}`, 500);
      try {
        const res = await fetchImpl(`http://127.0.0.1:${record.port}/api/workspace`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) {
          entry.state = 'running';
          return;
        }
      } catch {
        // Not up yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw fail('The kitchen did not come up in time', 504);
  }

  #view(record) {
    const entry = this.#children.get(record.id);
    return {
      id: record.id,
      main: false,
      dir: record.workspaceDir,
      name: path.basename(record.workspaceDir) || record.workspaceDir,
      port: record.port,
      url: `http://localhost:${record.port}`,
      state: entry?.state ?? 'stopped',
      error: entry?.error ?? null,
    };
  }

  /** Every room, the first one first. A room that moved to another folder says so in its own file. */
  list() {
    const dir = this.host.engine.config.workspaceDir;
    return [
      { id: 'main', main: true, dir, name: path.basename(dir) || dir, port: this.port, url: `http://localhost:${this.port}`, state: 'running', error: null },
      ...this.#records().filter((record) => this.#children.has(record.id)).map((record) => this.#view(record)),
    ];
  }

  /** Open a folder in a room of its own. Resolves once that room answers. */
  async open(target) {
    const raw = String(target ?? '').trim();
    if (!raw || !path.isAbsolute(raw)) throw fail('Give the full path of the folder');
    const dir = path.resolve(raw);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw fail('That folder does not exist');
    if (path.dirname(dir) === dir) throw fail('Pick a folder, not a whole drive');

    // A folder is only ever open in one room: two crews in one folder would write over each other.
    const open = this.list().find((room) => same(room.dir, dir));
    if (open) throw fail(`That folder is already open in ${open.main ? 'the first kitchen' : 'another kitchen'}`, 409, { room: open });
    const holder = roomHolder(dir);
    if (holder) throw fail(`That folder is already open in another Kadhai${holder.port ? ` (http://localhost:${holder.port})` : ''}`, 409);
    if (this.#children.size >= MAX_ROOMS) throw fail(`At most ${MAX_ROOMS} extra kitchens at once - each is a whole copy of Kadhai. Close one first.`, 409);

    // The first pair of ports nobody is using, above this server's own.
    const taken = new Set(this.#records().map((record) => record.port));
    let port = null;
    for (let k = 1; k <= 30 && port === null; k++) {
      const candidate = this.port + k * PORT_STEP;
      if (!taken.has(candidate) && (await portFree(candidate)) && (await portFree(candidate + 1))) port = candidate;
    }
    if (port === null) throw fail('No free port was found for another kitchen', 503);

    const record = { id: crypto.randomBytes(3).toString('hex'), port, workspaceDir: dir };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.#file(record.id), `${JSON.stringify(record, null, 2)}\n`);
    // A new room starts with the specialists you have hired so far; from then on its crew is its own.
    try {
      fs.copyFileSync(path.join(this.data, 'agents.local.json'), this.#file(record.id, '.agents'), fs.constants.COPYFILE_EXCL);
    } catch {
      // Nobody hired yet, or the copy exists.
    }

    const entry = this.#start(record);
    try {
      await this.#ready(record, entry);
    } catch (err) {
      await this.close(record.id).catch(() => {});
      throw err;
    }
    return this.#view(record);
  }

  /** Close a room for good: its process ends and it will not come back at the next start. Its folder is untouched. */
  async close(id) {
    const entry = this.#children.get(id);
    if (!entry) throw fail(id === 'main' ? 'The first kitchen is Kadhai itself: stop the server to close it' : 'No such kitchen', id === 'main' ? 409 : 404);
    this.#children.delete(id);
    killTree(entry.child);
    for (const suffix of ['', '.agents', '.flows', '.triggers']) fs.rmSync(this.#file(id, suffix), { force: true });
    return { closed: id };
  }

  /** This server is stopping: the rooms go with it, but stay on the list for next time. */
  stopAll() {
    for (const entry of this.#children.values()) killTree(entry.child);
    this.#children.clear();
  }
}

/** Inside an extra room: the list and the buttons are the first room's, reached over this machine's loopback. */
export class RoomsProxy {
  constructor({ lobby, id, fetch = globalThis.fetch }) {
    this.lobby = lobby;
    this.id = id;
    this.fetch = (...args) => fetch(...args);
  }

  async #call(method, pathname, body) {
    let res;
    try {
      res = await this.fetch(`${this.lobby}/api/workspace/rooms${pathname}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(READY_TIMEOUT_MS + 5000),
      });
    } catch {
      throw fail('The first kitchen is not answering', 502);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw fail(data.error ?? 'The first kitchen refused', res.status, { room: data.room });
    return data;
  }

  async list() {
    return (await this.#call('GET', '')).rooms;
  }

  open(dir) {
    return this.#call('POST', '', { path: dir });
  }

  close(id) {
    if (id === this.id) throw fail('Close this kitchen from another kitchen\'s list - it cannot close itself while you are in it', 409);
    return this.#call('DELETE', `/${id}`);
  }
}
