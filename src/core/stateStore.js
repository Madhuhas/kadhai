import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { log } from './util.js';

const SAVE_DELAY_MS = 800;

/**
 * Small JSON file under .kadhai/ that survives restarts: chat history, the
 * run list (for diff/undo) and today's per-route usage. Writes are debounced
 * and atomic. When disabled (tests, the stdio MCP server) it does nothing.
 */
export class StateStore {
  #timer = null;
  #source = null;

  constructor({ dir, enabled }) {
    this.file = path.join(dir, 'state.json');
    this.tmpDir = path.join(dir, 'tmp');
    this.enabled = enabled;
  }

  async load() {
    if (!this.enabled) return {};
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      return data && typeof data === 'object' ? data : {};
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`Saved state ignored: ${err.message}`);
      return {};
    }
  }

  /** `source` is a function returning the object to save; it is called at write time. */
  schedule(source) {
    if (!this.enabled) return;
    this.#source = source;
    this.#timer ??= setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, SAVE_DELAY_MS);
  }

  async flush() {
    clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.enabled || !this.#source) return;
    const tmp = path.join(this.tmpDir, `${crypto.randomUUID()}.state`);
    try {
      await fs.writeFile(tmp, JSON.stringify(this.#source()));
      await fs.rename(tmp, this.file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      log.warn(`Could not save state: ${err.message}`);
    }
  }
}
