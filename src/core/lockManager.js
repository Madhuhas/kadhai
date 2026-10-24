import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { sleep } from './util.js';

export class LockError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'LockError';
    this.code = 'ELOCKED';
    this.info = info;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Strict per-file mutex.
 *
 * A lock is a file created with O_EXCL ("wx"), which the OS guarantees to be
 * atomic - so the mutex holds across processes too (web server, MCP server and
 * ACP agent can all share one workspace). Locks are re-entrant per owner,
 * heartbeat while held, and are reclaimed only when the holder is provably gone
 * (dead pid or expired TTL).
 */
export class LockManager {
  #held = new Map();

  constructor({ lockDir, bus, ttlMs = 120000 }) {
    this.lockDir = lockDir;
    this.bus = bus;
    this.ttlMs = ttlMs;
  }

  key(relPath) {
    const norm = String(relPath).replace(/\\/g, '/').replace(/^\.?\/+/, '');
    return process.platform === 'win32' ? norm.toLowerCase() : norm;
  }

  #file(key) {
    return path.join(this.lockDir, `${crypto.createHash('sha1').update(key).digest('hex')}.lock`);
  }

  async acquire(relPath, owner, { timeoutMs = 10000, quiet = false } = {}) {
    const key = this.key(relPath);
    const mine = this.#held.get(key);
    if (mine && mine.owner === owner) {
      mine.depth += 1;
      return mine.handle;
    }

    await fs.mkdir(this.lockDir, { recursive: true });
    const file = this.#file(key);
    const deadline = Date.now() + timeoutMs;
    let delay = 25;

    for (;;) {
      const record = {
        path: String(relPath).replace(/\\/g, '/'),
        owner,
        quiet,
        pid: process.pid,
        token: crypto.randomUUID(),
        acquiredAt: Date.now(),
        expiresAt: Date.now() + this.ttlMs,
      };
      try {
        const fh = await fs.open(file, 'wx');
        try {
          await fh.writeFile(JSON.stringify(record));
        } finally {
          await fh.close();
        }
        return this.#register(key, file, record);
      } catch (err) {
        // EPERM: Windows reports it while a just-deleted lock file is still closing.
        if (err.code !== 'EEXIST' && err.code !== 'EPERM') throw err;
      }

      const current = await this.#inspect(file);
      if (current?.stale) {
        await this.#reclaim(file, current);
        continue;
      }
      if (Date.now() >= deadline) {
        const holder = current?.owner ?? 'another process';
        throw new LockError(`"${record.path}" is locked by ${holder}`, { path: record.path, owner: holder });
      }
      await sleep(delay);
      delay = Math.min(delay * 1.5, 200);
    }
  }

  #register(key, file, record) {
    const entry = { ...record, key, file, depth: 1 };
    entry.handle = {
      path: record.path,
      owner: record.owner,
      token: record.token,
      release: () => this.release(entry.handle),
    };
    // Heartbeat: keeps long-held locks from being mistaken for abandoned ones.
    entry.timer = setInterval(() => {
      record.expiresAt = Date.now() + this.ttlMs;
      fs.writeFile(file, JSON.stringify(record)).catch(() => {});
    }, Math.max(1000, this.ttlMs / 3));
    entry.timer.unref();
    this.#held.set(key, entry);
    if (!record.quiet) this.bus?.publish('lock:acquired', { path: record.path, owner: record.owner });
    return entry.handle;
  }

  async #inspect(file) {
    const record = await readJson(file);
    if (record) {
      return { ...record, stale: record.expiresAt < Date.now() || !pidAlive(record.pid) };
    }
    // Unreadable: either mid-creation (fresh) or wreckage from a crash (old).
    try {
      const st = await fs.stat(file);
      return { owner: 'another process', token: null, stale: Date.now() - st.mtimeMs > this.ttlMs };
    } catch {
      return null;
    }
  }

  // Move the dead lock aside atomically, so two reclaimers cannot both "win".
  async #reclaim(file, stale) {
    const tomb = `${file}.${crypto.randomUUID()}.stale`;
    try {
      await fs.rename(file, tomb);
    } catch {
      return;
    }
    const moved = await readJson(tomb);
    if (stale.token && moved?.token !== stale.token) {
      // We grabbed a lock someone re-created in the meantime: put it back.
      await fs.link(tomb, file).catch(() => {});
    }
    await fs.rm(tomb, { force: true });
  }

  async release(handle) {
    const key = this.key(handle.path);
    const entry = this.#held.get(key);
    if (!entry || entry.token !== handle.token) return false;
    entry.depth -= 1;
    if (entry.depth > 0) return true;

    clearInterval(entry.timer);
    this.#held.delete(key);
    const onDisk = await readJson(entry.file);
    if (onDisk?.token === entry.token) await fs.rm(entry.file, { force: true });
    if (!entry.quiet) this.bus?.publish('lock:released', { path: entry.path, owner: entry.owner });
    return true;
  }

  async withLock(relPath, owner, fn, opts) {
    const handle = await this.acquire(relPath, owner, opts);
    try {
      return await fn(handle);
    } finally {
      await handle.release();
    }
  }

  /** Live locks from every process sharing this workspace. */
  async list() {
    let names;
    try {
      names = await fs.readdir(this.lockDir);
    } catch {
      return [];
    }
    const locks = [];
    for (const name of names) {
      if (!name.endsWith('.lock')) continue;
      const record = await this.#inspect(path.join(this.lockDir, name));
      if (!record || record.stale || record.quiet || !record.path) continue;
      locks.push({ path: record.path, owner: record.owner, acquiredAt: record.acquiredAt });
    }
    return locks.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Drop wreckage left behind by crashed processes. */
  async sweep() {
    let names;
    try {
      names = await fs.readdir(this.lockDir);
    } catch {
      return;
    }
    for (const name of names) {
      const file = path.join(this.lockDir, name);
      if (name.endsWith('.stale')) await fs.rm(file, { force: true });
      else if (name.endsWith('.lock')) {
        const record = await this.#inspect(file);
        if (record?.stale) await this.#reclaim(file, record);
      }
    }
  }

  async releaseAll() {
    for (const entry of [...this.#held.values()]) {
      entry.depth = 1;
      await this.release(entry.handle);
    }
  }
}
