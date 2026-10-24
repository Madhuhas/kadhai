import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { clip, log } from './util.js';

const MAX_ENTRIES = 500; // runs kept in the journal; older ones are dropped
const MAX_LESSONS = 40; // per folder, all agents together
const LESSON_CHARS = 140;
export const LESSONS_IN_PROMPT = 5; // lines of lessons an agent is shown...
export const LESSON_PROMPT_CHARS = 500; // ...and never more than this, so prompts stay small
const HISTORY_CHARS = 2400; // what one look into the journal may add to the Chef's prompt
const DAY = 86400000;

const STOP = new Set('a an and are about any at be been but by can could did do does for from had has have how i if in into is it its me my of on or our that the their them then there this to up was we were what when where which who why will with you your did done made make work worked working task tasks run runs ran tell show list give'.split(' '));
// Words worth matching on: lower-cased, without the full stop or comma that happened to follow them.
const words = (text) =>
  String(text ?? '')
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9._-]{1,}/g)
    ?.map((w) => w.replace(/[._-]+$/, ''))
    .filter((w) => w.length > 1 && !STOP.has(w)) ?? [];
const stamp = (ts) => {
  const d = new Date(ts);
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

/** "today", "yesterday", "this week", "last 3 days" in a question, as a [from, to) window of time; null if it names none. */
export function timeWindow(question, now) {
  const q = String(question ?? '').toLowerCase();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const start = midnight.getTime();
  if (/\btoday\b|\bthis morning\b|\bthis afternoon\b/.test(q)) return [start, now + 1];
  if (/\byesterday\b/.test(q)) return [start - DAY, start];
  const days = /\b(?:last|past)\s+(\d{1,2})\s+days?\b/.exec(q);
  if (days) return [start - (Number(days[1]) - 1) * DAY, now + 1];
  if (/\b(?:this|last|past)\s+week\b/.test(q)) return [start - 6 * DAY, now + 1];
  return null;
}

/**
 * What the crew remembers about a folder, on disk under .kadhai/:
 *
 *   journal.jsonl  one line per finished run: what was asked, the plan, who
 *                  cooked each step on which model, the files, the commands,
 *                  the review. Nothing in it is ever put into a prompt unless
 *                  the Chef asks to look something up.
 *   lessons.json   short facts and mistakes worth not repeating, at most
 *                  MAX_LESSONS. A handful of them (LESSONS_IN_PROMPT lines,
 *                  LESSON_PROMPT_CHARS characters) go into every prompt.
 *
 * Both are plain files the user can read. The journal costs no tokens; the
 * lessons cost a fixed, small number - that cap is what lets agents stay
 * stateless and cheap while still not starting from nothing every time.
 */
export class Journal {
  #entries = [];
  #lessons = [];

  constructor({ dir, enabled, bus, now = () => Date.now(), limits = null }) {
    // The flame's caps (config.limits, read on every use); the constants are low flame's.
    this.limits = limits;
    this.file = path.join(dir, 'journal.jsonl');
    this.lessonsFile = path.join(dir, 'lessons.json');
    this.enabled = Boolean(enabled);
    this.bus = bus;
    this.now = now;
  }

  async init() {
    if (!this.enabled) return;
    try {
      const raw = await fs.promises.readFile(this.file, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          this.#entries.push(JSON.parse(line));
        } catch {
          // A half-written last line after a crash: skip it, keep the rest.
        }
      }
      this.#entries = this.#entries.slice(-MAX_ENTRIES);
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`The journal could not be read: ${err.message}`);
    }
    try {
      const saved = JSON.parse(await fs.promises.readFile(this.lessonsFile, 'utf8'));
      this.#lessons = (Array.isArray(saved.lessons) ? saved.lessons : []).filter((l) => l && typeof l.text === 'string' && typeof l.id === 'string');
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`The lessons could not be read: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------- journal

  get size() {
    return this.#entries.length;
  }

  /** Record a finished run. Appended as one line, so a crash can lose at most the line being written. */
  async add(entry) {
    if (!this.enabled) return;
    this.#entries.push(entry);
    try {
      if (this.#entries.length > MAX_ENTRIES + 50) {
        // Now and then, drop what is too old by rewriting the file whole.
        this.#entries = this.#entries.slice(-MAX_ENTRIES);
        const tmp = `${this.file}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmp, `${this.#entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
        await fs.promises.rename(tmp, this.file);
      } else {
        await fs.promises.appendFile(this.file, `${JSON.stringify(entry)}\n`);
      }
    } catch (err) {
      log.warn(`The journal could not be written: ${err.message}`);
    }
    this.bus?.publish('journal:update', {});
  }

  /** The newest runs first. */
  recent(limit = 20) {
    return this.#entries.slice(-limit).reverse();
  }

  /**
   * The runs that best answer a question: by its words (in the request, the objective, step
   * titles, file names, cooks, summaries), within any time it names, newest first on a tie.
   * A question with no telling words ("what did we do yesterday?") gets the latest runs.
   */
  search(question, { limit = 6 } = {}) {
    const window = timeWindow(question, this.now());
    const pool = window ? this.#entries.filter((e) => e.at >= window[0] && e.at < window[1]) : this.#entries;
    // Time words chose the window; they are not something to look for in the text.
    const wanted = [...new Set(words(question))].filter((w) => !/^(today|yesterday|week|days?|last|past|morning|afternoon|earlier|before|ago|history|journal)$/.test(w));
    if (!wanted.length) return pool.slice(-limit).reverse();
    const scored = pool
      .map((entry, index) => {
        const strong = `${entry.request} ${entry.objective}`.toLowerCase();
        const weak = `${entry.steps.map((s) => `${s.title} ${s.cookName} ${s.cook} ${s.summary} ${s.files.join(' ')} ${s.model ?? ''}`).join(' ')} ${entry.files.join(' ')} ${entry.commands.map((c) => c.command).join(' ')} ${entry.review?.summary ?? ''}`.toLowerCase();
        const score = wanted.reduce((sum, w) => sum + (strong.includes(w) ? 2 : 0) + (weak.includes(w) ? 1 : 0), 0);
        return { entry, score, index };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.index - a.index);
    return scored.slice(0, limit).map((s) => s.entry);
  }

  /**
   * High flame: what earlier runs did to these files, for the cook about to change them - newest
   * first, one line a run, within `limits.fileRecall` characters (0 on low flame: nothing). Chosen
   * by the files alone, with no model call, so it costs the same small, fixed amount every time.
   */
  recallFiles(files) {
    const budget = this.limits?.fileRecall ?? 0;
    if (!budget || !files.length) return [];
    const wanted = new Set(files.map((f) => f.toLowerCase()));
    const lines = [];
    let used = 0;
    for (const e of this.recent(50)) {
      const steps = e.steps.filter((s) => (s.files ?? []).some((f) => wanted.has(f.toLowerCase())));
      if (!steps.length && !e.files.some((f) => wanted.has(f.toLowerCase()))) continue;
      const what = steps.map((s) => `${s.title} (${s.cookName}, ${s.status})${s.summary ? `: ${clip(s.summary, 90)}` : ''}`).join('; ');
      const review = e.review && e.review.verdict === 'revised' ? ` Review found ${e.review.issues} issue(s): ${clip(e.review.summary, 100)}` : '';
      const line = clip(`${stamp(e.at)} ${e.ok ? '' : 'FAILED '}"${clip(e.objective || e.request, 80)}" - ${what || `changed ${e.files.join(', ')}`}.${review}`, 320);
      if (used + line.length > budget) break;
      lines.push(line);
      used += line.length;
    }
    return lines;
  }

  /** Journal entries as text for the Chef: who, what, when and how it went, a few lines each. */
  describe(entries) {
    if (!entries.length) return '(the journal has nothing that matches)';
    const lines = [];
    let used = 0;
    for (const e of entries) {
      const steps = e.steps.map((s) => `${s.title} - ${s.cookName}${s.model ? ` on ${s.model}` : ''}, ${s.status}${s.summary ? `: ${clip(s.summary, 90)}` : ''}`).join('; ');
      const text = clip(
        [
          `- ${stamp(e.at)} [${e.ok ? 'finished' : 'FAILED'}${e.source && e.source !== 'ui' ? `, via ${e.source}` : ''}] asked: "${clip(e.request, 140)}"`,
          e.objective ? `  objective: ${e.objective}` : '',
          steps ? `  steps: ${steps}` : '',
          e.files.length ? `  files: ${e.files.join(', ')}` : '',
          e.commands.length ? `  commands: ${e.commands.map((c) => `${clip(c.command, 60)} (exit ${c.code}, ${c.owner})`).join('; ')}` : '',
          e.review ? `  review: ${e.review.verdict}${e.review.issues ? `, ${e.review.issues} issue(s)` : ''} - ${clip(e.review.summary, 120)}` : '',
          e.error ? `  ended with: ${clip(e.reply, 160)}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        700,
      );
      if (used + text.length > (this.limits?.historyChars ?? HISTORY_CHARS)) break;
      lines.push(text);
      used += text.length;
    }
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- lessons

  listLessons() {
    return this.#lessons.map((l) => ({ ...l }));
  }

  async #saveLessons() {
    try {
      const tmp = `${this.lessonsFile}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, `${JSON.stringify({ lessons: this.#lessons }, null, 2)}\n`);
      await fs.promises.rename(tmp, this.lessonsFile);
    } catch (err) {
      log.warn(`The lessons could not be saved: ${err.message}`);
    }
    this.bus?.publish('lessons:update', {});
  }

  /**
   * Keep what a run taught. `items`: [{ text, for }] where `for` is an agent id, or 'all' for a
   * fact about the project. Said twice, a lesson is kept once (and counted as confirmed).
   */
  async learn(items, runId) {
    if (!this.enabled) return;
    let changed = false;
    for (const item of items) {
      const text = clip(String(item?.text ?? '').replace(/\s+/g, ' ').trim(), LESSON_CHARS);
      if (text.length < 12) continue;
      const who = item.for || 'all';
      const key = words(text).join(' ');
      const known = this.#lessons.find((l) => l.for === who && words(l.text).join(' ') === key);
      if (known) {
        known.seen = (known.seen ?? 1) + 1;
        known.at = this.now();
      } else {
        this.#lessons.push({ id: crypto.randomBytes(5).toString('hex'), text, for: who, at: this.now(), runId, seen: 1 });
      }
      changed = true;
    }
    if (!changed) return;
    // Over the limit, the ones confirmed least and longest ago go first.
    if (this.#lessons.length > MAX_LESSONS) {
      this.#lessons = [...this.#lessons].sort((a, b) => (b.seen ?? 1) - (a.seen ?? 1) || b.at - a.at).slice(0, MAX_LESSONS).sort((a, b) => a.at - b.at);
    }
    await this.#saveLessons();
  }

  async forget(id) {
    const before = this.#lessons.length;
    this.#lessons = this.#lessons.filter((l) => l.id !== id);
    if (this.#lessons.length === before) throw Object.assign(new Error('No such lesson'), { status: 404 });
    await this.#saveLessons();
    return { forgotten: id };
  }

  /**
   * The few lessons one agent is shown: its own first, then the project's, the most confirmed and
   * most recent of each - within a fixed number of lines and characters, whatever has been learned.
   */
  lessonsFor(agentId) {
    const rank = (list) => [...list].sort((a, b) => (b.seen ?? 1) - (a.seen ?? 1) || b.at - a.at);
    const picked = [];
    let used = 0;
    for (const lesson of [...rank(this.#lessons.filter((l) => l.for === agentId)), ...rank(this.#lessons.filter((l) => l.for === 'all'))]) {
      if (picked.length >= (this.limits?.lessonLines ?? LESSONS_IN_PROMPT) || used + lesson.text.length > (this.limits?.lessonChars ?? LESSON_PROMPT_CHARS)) break;
      picked.push(lesson.text);
      used += lesson.text.length;
    }
    return picked;
  }
}
