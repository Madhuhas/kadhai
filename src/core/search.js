import { Worker } from 'node:worker_threads';

/**
 * Search across the workspace, and replace across it, for the dashboard's search view.
 * Files are listed and read through Workspace (never fs here); the matching runs in a worker
 * thread that is stopped after TIME_LIMIT_MS, so a pattern that backtracks for ever cannot
 * freeze the server and the crew with it.
 */

const MAX_FILES = 5000; // files looked at in one search
const MAX_MATCHES = 2000; // matches returned, all files together
const PER_FILE = 200; // matches listed for one file
const PREVIEW = 220; // characters of a matching line shown
const TIME_LIMIT_MS = 8000;

/** "*.js, src/**, !dist" -> a test for a path. Empty -> everything. */
export function globTest(list) {
  const parts = String(list ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const toRegex = (glob) => {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*' && glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else if (c === '*') re += '[^/]*';
      else if (c === '?') re += '[^/]';
      else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    // "*.js" matches at any depth, "src/" or "src" means the folder and everything in it.
    const anywhere = !glob.includes('/');
    return new RegExp(`${anywhere ? '(^|/)' : '^'}${re.replace(/\/$/, '')}($|/)`, 'i');
  };
  const tests = parts.map(toRegex);
  return (path) => tests.some((t) => t.test(path));
}

/** The pattern a query stands for, or throws a plain-words error for a broken regular expression. */
export function patternOf({ query, regex = false, matchCase = false, wholeWord = false }) {
  if (!query) throw Object.assign(new Error('Type something to search for'), { status: 400 });
  let source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord) source = `\\b(?:${source})\\b`;
  try {
    return new RegExp(source, `g${matchCase ? '' : 'i'}m`);
  } catch (err) {
    throw Object.assign(new Error(`That is not a valid regular expression: ${err.message.replace(/^Invalid regular expression: /, '')}`), { status: 400 });
  }
}

// The matching, in a worker. It receives the files' text and returns matches (or replaced text).
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { source, flags, files, replace, perFile, maxMatches, preview } = workerData;
const out = [];
let total = 0;
for (const file of files) {
  const re = new RegExp(source, flags);
  if (replace !== null) {
    // String.replace applies $1, $& and $<name> itself.
    const count = (file.text.match(re) ?? []).filter(Boolean).length;
    if (count) out.push({ path: file.path, text: file.text.replace(re, replace), count });
    continue;
  }
  const lineStarts = [0];
  for (let i = file.text.indexOf('\\n'); i >= 0; i = file.text.indexOf('\\n', i + 1)) lineStarts.push(i + 1);
  const lineOf = (index) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= index) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  const matches = [];
  let m;
  while ((m = re.exec(file.text)) && matches.length < perFile && total < maxMatches) {
    if (!m[0]) { re.lastIndex++; continue; }
    const line = lineOf(m.index);
    const start = lineStarts[line];
    const end = file.text.indexOf('\\n', start);
    const full = file.text.slice(start, end < 0 ? file.text.length : end).replace(/\\r$/, '');
    const col = m.index - start;
    // Long lines are shown around the match, not from their start.
    const from = Math.max(0, Math.min(col - 40, full.length - preview));
    matches.push({ line: line + 1, col: col + 1, length: Math.min(m[0].length, full.length - col), text: full.slice(from, from + preview), at: col - from, cut: from > 0 });
    total++;
  }
  if (matches.length) out.push({ path: file.path, matches, more: re.exec(file.text) !== null && matches.length >= perFile });
  if (total >= maxMatches) break;
}
parentPort.postMessage({ out, full: total >= maxMatches });
`;

function inWorker(data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { eval: true, workerData: data, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(Object.assign(new Error('The search took too long and was stopped. A regular expression that can match in many ways is the usual cause.'), { status: 400 }));
    }, TIME_LIMIT_MS);
    worker.once('message', (msg) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(msg);
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** The text files a search looks at, read through Workspace. Binary, clipped and memory.md are left out. */
async function textFiles(workspace, { include, exclude, paths }) {
  const wanted = globTest(include);
  const unwanted = globTest(exclude);
  const listed = paths ?? (await workspace.tree({ maxEntries: MAX_FILES * 2, maxDepth: 20 })).filter((e) => e.type === 'file').map((e) => e.path);
  const out = [];
  let skipped = 0;
  for (const path of listed) {
    if (out.length >= MAX_FILES) break;
    if ((wanted && !wanted(path)) || (unwanted && unwanted(path)) || workspace.isMemory(path)) continue;
    try {
      const file = await workspace.readFile(path);
      if (file.binary || file.truncated) {
        skipped++;
        continue;
      }
      out.push({ path: file.path, text: file.content });
    } catch {
      skipped++;
    }
  }
  return { files: out, skipped, capped: listed.length > MAX_FILES };
}

/**
 * -> { files: [{ path, matches: [{ line, col, length, text, at, cut }], more }], searched, skipped, full }
 * `full`: the match limit was reached, so there may be more.
 */
export async function searchWorkspace(workspace, opts) {
  const re = patternOf(opts);
  const { files, skipped, capped } = await textFiles(workspace, opts);
  const { out, full } = await inWorker({ source: re.source, flags: re.flags, files, replace: null, perFile: PER_FILE, maxMatches: MAX_MATCHES, preview: PREVIEW });
  return { files: out, searched: files.length, skipped, full: full || capped };
}

/**
 * Replace every match in the files given (or every file the search would look at), each written
 * through Workspace under `owner`'s lock. A file an agent holds is left alone and reported.
 * -> { changed: [{ path, count }], failed: [{ path, error }] }
 */
export async function replaceInWorkspace(workspace, opts, replacement, { owner = 'user' } = {}) {
  const re = patternOf(opts);
  const { files } = await textFiles(workspace, opts);
  const { out } = await inWorker({ source: re.source, flags: re.flags, files, replace: String(replacement ?? ''), perFile: PER_FILE, maxMatches: MAX_MATCHES, preview: PREVIEW });
  const changed = [];
  const failed = [];
  for (const file of out) {
    try {
      await workspace.writeFile(file.path, file.text, { owner, timeoutMs: 1500 });
      changed.push({ path: file.path, count: file.count });
    } catch (err) {
      failed.push({ path: file.path, error: err.message });
    }
  }
  return { changed, failed };
}
