import fs from 'node:fs/promises';
import { watch as fsWatch, realpathSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sleep } from './util.js';

export const MEMORY_FILE = 'memory.md';
const INTERNAL_DIR = '.kadhai';
const IGNORED = new Set([INTERNAL_DIR, '.git', 'node_modules']);
const MAX_READ_BYTES = 512 * 1024;
const WINDOWS = process.platform === 'win32';
// Windows and macOS disks ignore letter case: MEMORY.MD is memory.md there.
const CASELESS = WINDOWS || process.platform === 'darwin';

/** A path segment as a forgiving disk reads it: any letter case, and (on Windows) trailing dots and spaces dropped. */
const canon = (part) => part.toLowerCase().replace(/[. ]+$/, '');
const isProtected = (rel) => rel.split('/').some((part) => IGNORED.has(canon(part)));

export class WorkspaceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'WorkspaceError';
    this.status = status;
  }
}

/** The only door to the disk: every path is confined to the workspace root. */
export class Workspace {
  #watcher = null;

  constructor({ root, locks, bus }) {
    this.root = path.resolve(root);
    this.locks = locks;
    this.bus = bus;
    this.tmpDir = path.join(this.root, INTERNAL_DIR, 'tmp');
  }

  async init() {
    await fs.mkdir(this.tmpDir, { recursive: true });
    this.realRoot = realpathSync(this.root);
    for (const name of await fs.readdir(this.tmpDir)) {
      await fs.rm(path.join(this.tmpDir, name), { force: true });
    }
  }

  /** Workspace-relative path -> { rel, abs }, or throws if it escapes the sandbox. */
  resolve(relPath) {
    // Models often write "/index.html" or "./index.html" meaning the workspace root.
    const cleaned = String(relPath ?? '').replace(/\\/g, '/').trim().replace(/^(\.?\/)+/, '');
    if (!cleaned || cleaned.includes('\0')) throw new WorkspaceError('A file path is required');
    if (/^[a-zA-Z]:/.test(cleaned)) {
      throw new WorkspaceError(`Use a workspace-relative path, not "${cleaned}"`);
    }
    const abs = path.resolve(this.root, cleaned);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new WorkspaceError(`"${cleaned}" is outside the workspace`);
    }
    const rel = path.relative(this.root, abs).split(path.sep).join('/');
    if (!rel) throw new WorkspaceError('A file path is required');
    // Checked as the disk will read it, so ".GIT" or ".git." is no way round.
    if (isProtected(rel)) throw new WorkspaceError(`"${rel}" is in a protected folder`);
    // Windows drops a trailing dot or space, and "name:stream" addresses a hidden stream of the file.
    if (WINDOWS && rel.split('/').some((part) => part.includes(':') || /[. ]$/.test(part))) {
      throw new WorkspaceError(`"${rel}" is not a valid file name on Windows`);
    }
    return { rel, abs };
  }

  /**
   * Does this path, followed through any link or junction, stay inside the folder? The preview
   * server asks before it serves a file, so a link in the folder cannot expose the rest of the disk.
   * A path that does not exist is "inside": the static server then answers 404 by itself.
   */
  async staysInside(relPath) {
    const abs = path.resolve(this.root, String(relPath ?? '').replace(/^[\\/]+/, ''));
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) return false;
    try {
      const real = await fs.realpath(abs);
      return real === this.realRoot || real.startsWith(this.realRoot + path.sep);
    } catch {
      return true;
    }
  }

  /** Is this the state file? It is reserved in whatever letter case the disk accepts. */
  isMemory(rel) {
    return (CASELESS ? String(rel).toLowerCase() : rel) === MEMORY_FILE;
  }

  // Refuse paths that leave the workspace through a symlink or junction, or that reach a
  // protected folder by another name (a link to it, or a Windows short name such as GIT~1).
  async #guardLinks(abs) {
    let probe = abs;
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        if (real !== this.realRoot && !real.startsWith(this.realRoot + path.sep)) {
          throw new WorkspaceError('Path leaves the workspace through a link');
        }
        const inside = path.relative(this.realRoot, real).split(path.sep).join('/');
        if (inside && isProtected(inside)) throw new WorkspaceError('Path leads into a protected folder');
        return;
      } catch (err) {
        if (err instanceof WorkspaceError) throw err;
        const parent = path.dirname(probe);
        if (parent === probe) return;
        probe = parent;
      }
    }
  }

  async tree({ maxEntries = 1500, maxDepth = 8 } = {}) {
    const out = [];
    const walk = async (dirAbs, relDir, depth) => {
      let entries;
      try {
        entries = await fs.readdir(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => b.isDirectory() - a.isDirectory() || a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (out.length >= maxEntries) return;
        if (IGNORED.has(entry.name)) continue;
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          out.push({ path: rel, type: 'dir' });
          if (depth < maxDepth) await walk(path.join(dirAbs, entry.name), rel, depth + 1);
        } else if (entry.isFile()) {
          const st = await fs.stat(path.join(dirAbs, entry.name)).catch(() => null);
          out.push({ path: rel, type: 'file', size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 });
        }
      }
    };
    await walk(this.root, '', 0);
    return out;
  }

  async exists(relPath) {
    try {
      return (await fs.stat(this.resolve(relPath).abs)).isFile();
    } catch {
      return false;
    }
  }

  async readFile(relPath) {
    const { rel, abs } = this.resolve(relPath);
    await this.#guardLinks(abs);
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      throw new WorkspaceError(`"${rel}" does not exist`, 404);
    }
    if (!st.isFile()) throw new WorkspaceError(`"${rel}" is not a file`);

    const fh = await fs.open(abs, 'r');
    try {
      const length = Math.min(st.size, MAX_READ_BYTES);
      // Only what was really read: a file that shrank since stat() must not end in zero bytes.
      const read = await fh.read(Buffer.alloc(length), 0, length, 0);
      const buffer = read.buffer.subarray(0, read.bytesRead);
      const binary = buffer.subarray(0, 8192).includes(0);
      return {
        path: rel,
        size: st.size,
        mtime: st.mtimeMs,
        binary,
        truncated: st.size > MAX_READ_BYTES,
        content: binary ? '' : buffer.toString('utf8'),
      };
    } finally {
      await fh.close();
    }
  }

  /**
   * Locked, atomic write: the content lands in a temp file first and is then
   * renamed over the target, so readers never observe a half-written file.
   */
  async writeFile(relPath, content, { owner, timeoutMs = 10000, system = false, quiet = false } = {}) {
    const { rel, abs } = this.resolve(relPath);
    if (this.isMemory(rel) && !system) {
      throw new WorkspaceError(`${MEMORY_FILE} is managed by the state engine and cannot be written directly`);
    }
    await this.#guardLinks(abs);
    await this.locks.withLock(
      rel,
      owner,
      async () => {
        const existing = await fs.stat(abs).catch(() => null);
        if (existing?.isDirectory()) throw new WorkspaceError(`"${rel}" is a folder, not a file`);
        try {
          await fs.mkdir(path.dirname(abs), { recursive: true });
        } catch {
          throw new WorkspaceError(`Cannot create "${rel}": part of that path is a file, not a folder`);
        }
        const tmp = path.join(this.tmpDir, `${crypto.randomUUID()}.tmp`);
        await fs.writeFile(tmp, content, 'utf8');
        try {
          await this.#renameWithRetry(tmp, abs);
        } catch (err) {
          await fs.rm(tmp, { force: true });
          throw err;
        }
      },
      { timeoutMs, quiet },
    );
    if (!quiet) this.bus?.publish('fs:write', { path: rel, owner, bytes: Buffer.byteLength(content) });
    return { path: rel };
  }

  // Windows can briefly refuse a rename while antivirus or an editor holds the target.
  async #renameWithRetry(from, to) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fs.rename(from, to);
      } catch (err) {
        if (attempt >= 6 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
        await sleep(30 * (attempt + 1));
      }
    }
  }

  async deleteFile(relPath, { owner, timeoutMs = 10000 } = {}) {
    const { rel, abs } = this.resolve(relPath);
    if (this.isMemory(rel)) throw new WorkspaceError(`${MEMORY_FILE} cannot be deleted`);
    await this.#guardLinks(abs);
    await this.locks.withLock(
      rel,
      owner,
      async () => {
        const st = await fs.stat(abs).catch(() => null);
        if (!st) throw new WorkspaceError(`"${rel}" does not exist`, 404);
        if (!st.isFile()) throw new WorkspaceError(`"${rel}" is not a file`);
        await fs.rm(abs);
      },
      { timeoutMs },
    );
    this.bus?.publish('fs:write', { path: rel, owner, deleted: true });
    return { path: rel };
  }

  /** The first lock held on anything inside a folder, if any. */
  async #lockedUnder(rel) {
    const prefix = `${this.locks.key(rel)}/`;
    return (await this.locks.list()).find((lock) => this.locks.key(lock.path).startsWith(prefix)) ?? null;
  }

  async makeDir(relPath) {
    const { rel, abs } = this.resolve(relPath);
    await this.#guardLinks(abs);
    if (await fs.stat(abs).catch(() => null)) throw new WorkspaceError(`"${rel}" already exists`, 409);
    try {
      await fs.mkdir(abs, { recursive: true });
    } catch {
      throw new WorkspaceError(`Cannot create "${rel}": part of that path is a file, not a folder`);
    }
    this.bus?.publish('fs:change', { paths: [rel] });
    return { path: rel };
  }

  /**
   * Move or rename a file or a folder. Never overwrites. A file is moved while
   * holding the lock on both its old and its new path; a folder is refused if
   * an agent holds a lock on anything inside it.
   */
  async move(fromPath, toPath, { owner, timeoutMs = 1500 } = {}) {
    const from = this.resolve(fromPath);
    const to = this.resolve(toPath);
    if (this.isMemory(from.rel) || this.isMemory(to.rel)) throw new WorkspaceError(`${MEMORY_FILE} cannot be moved or replaced`);
    if (from.rel === to.rel) return { path: to.rel, from: from.rel };
    if (`${to.rel}/`.startsWith(`${from.rel}/`)) throw new WorkspaceError('A folder cannot be moved into itself');
    await this.#guardLinks(from.abs);
    await this.#guardLinks(to.abs);

    const st = await fs.stat(from.abs).catch(() => null);
    if (!st) throw new WorkspaceError(`"${from.rel}" does not exist`, 404);
    // Changing only the letter case is a rename of the same entry on Windows, not a collision.
    const caseOnly = this.locks.key(from.rel) === this.locks.key(to.rel);
    if (!caseOnly && (await fs.stat(to.abs).catch(() => null))) throw new WorkspaceError(`"${to.rel}" already exists`, 409);

    const relocate = async () => {
      try {
        await fs.mkdir(path.dirname(to.abs), { recursive: true });
      } catch {
        throw new WorkspaceError(`Cannot move to "${to.rel}": part of that path is a file, not a folder`);
      }
      await this.#renameWithRetry(from.abs, to.abs);
    };

    if (st.isDirectory()) {
      const held = await this.#lockedUnder(from.rel);
      if (held) throw new WorkspaceError(`"${held.path}" inside that folder is locked by ${held.owner}`, 423);
      await relocate();
    } else {
      const [first, second] = [from.rel, to.rel].sort();
      await this.locks.withLock(first, owner, () => this.locks.withLock(second, owner, relocate, { timeoutMs }), { timeoutMs });
    }
    this.bus?.publish('fs:change', { paths: [from.rel, to.rel] });
    return { path: to.rel, from: from.rel };
  }

  /** Delete a folder and everything in it. Refused while an agent holds a lock inside. */
  async deleteDir(relPath) {
    const { rel, abs } = this.resolve(relPath);
    await this.#guardLinks(abs);
    const st = await fs.stat(abs).catch(() => null);
    if (!st) throw new WorkspaceError(`"${rel}" does not exist`, 404);
    if (!st.isDirectory()) throw new WorkspaceError(`"${rel}" is not a folder`);
    const held = await this.#lockedUnder(rel);
    if (held) throw new WorkspaceError(`"${held.path}" inside that folder is locked by ${held.owner}`, 423);
    await fs.rm(abs, { recursive: true, force: true });
    this.bus?.publish('fs:change', { paths: [rel] });
    return { path: rel };
  }

  /** Push debounced change notices so the sidebar stays live without polling. */
  watch() {
    if (this.#watcher) return;
    let pending = new Set();
    let timer = null;
    this.stopWatching = () => clearTimeout(timer);
    const flush = () => {
      timer = null;
      const paths = [...pending];
      pending = new Set();
      this.bus?.publish('fs:change', { paths });
    };
    try {
      this.#watcher = fsWatch(this.root, { recursive: true }, (_event, filename) => {
        const rel = String(filename ?? '').split(path.sep).join('/');
        if (rel.split('/').some((part) => IGNORED.has(part))) return;
        pending.add(rel);
        timer ??= setTimeout(flush, 150);
      });
      this.#watcher.on('error', () => {});
    } catch {
      this.#watcher = null;
    }
  }

  close() {
    this.stopWatching?.();
    this.#watcher?.close();
    this.#watcher = null;
  }
}
