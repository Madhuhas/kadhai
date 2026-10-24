import { MEMORY_FILE } from './workspace.js';
import { clip, log } from './util.js';

const OWNER = 'memory-engine';
const FIELD_MAX = 280;
const NONE = 'None yet.';

const SECTIONS = {
  objective: 'Current Objective',
  locks: 'Active File Locks',
  milestone: 'Last Completed Milestone',
};

function section(text, title) {
  const match = new RegExp(`^## ${title}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(text);
  return match ? match[1].trim() : '';
}

const oneLine = (text) => clip(String(text ?? '').replace(/\s+/g, ' ').trim(), FIELD_MAX);

/**
 * memory.md - the whole cross-model handoff state, in three tiny sections.
 * Agents never see chat history; they see this file. Keeping it this small is
 * what makes a provider hot-swap nearly free in tokens.
 */
export class MemoryEngine {
  #patch = {};
  #chain = Promise.resolve();
  #queued = null;
  #unsubscribe = null;

  constructor({ workspace, locks, bus }) {
    this.workspace = workspace;
    this.locks = locks;
    this.bus = bus;
  }

  async init() {
    await this.flush();
    // Lock traffic is part of the state, so the file follows it automatically.
    this.#unsubscribe = this.bus.subscribe((event) => {
      if (event.type === 'lock:acquired' || event.type === 'lock:released') this.flush();
    });
  }

  close() {
    this.#unsubscribe?.();
  }

  async read() {
    try {
      return (await this.workspace.readFile(MEMORY_FILE)).content.trim();
    } catch {
      return this.#render({}, []);
    }
  }

  /** set({ objective, milestone }) - either field is optional. */
  set(fields) {
    for (const key of ['objective', 'milestone']) {
      if (fields[key] != null) this.#patch[key] = oneLine(fields[key]) || NONE;
    }
    return this.flush();
  }

  /** Coalesced, serialised rewrite. Safe to call from anywhere, any number of times. */
  flush() {
    if (this.#queued) return this.#queued;
    const run = this.#chain
      .then(async () => {
        this.#queued = null;
        await this.#write();
      })
      .catch((err) => log.warn(`memory.md update failed: ${err.message}`));
    this.#queued = run;
    this.#chain = run;
    return run;
  }

  async #write() {
    // Read-modify-write under the file's own lock, so several processes can
    // share one workspace without clobbering each other's fields.
    await this.locks.withLock(
      MEMORY_FILE,
      OWNER,
      async () => {
        let existing = '';
        try {
          existing = (await this.workspace.readFile(MEMORY_FILE)).content;
        } catch {
          // First run: nothing to merge.
        }
        const patch = this.#patch;
        this.#patch = {};
        const state = {
          objective: patch.objective ?? section(existing, SECTIONS.objective),
          milestone: patch.milestone ?? section(existing, SECTIONS.milestone),
        };
        const content = this.#render(state, await this.locks.list());
        if (content !== existing) {
          await this.workspace.writeFile(MEMORY_FILE, content, { owner: OWNER, system: true, quiet: true });
          this.bus.publish('memory:update', { content });
        }
      },
      { quiet: true },
    );
  }

  #render(state, locks) {
    const lockLines = locks.length
      ? locks.slice(0, 20).map((l) => `- ${l.path} — ${l.owner}`)
      : ['- none'];
    return [
      '# memory.md — Kadhai handoff state (auto-managed)',
      '',
      `## ${SECTIONS.objective}`,
      state.objective || NONE,
      '',
      `## ${SECTIONS.locks}`,
      ...lockLines,
      '',
      `## ${SECTIONS.milestone}`,
      state.milestone || NONE,
      '',
    ].join('\n');
  }
}
