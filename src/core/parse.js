/** Tolerant parsers for model output. Free models are sloppy; these are not allowed to be. */

/** Pull the first JSON object out of a reply, with or without fences or chatter around it. */
export function extractJson(text) {
  const source = String(text ?? '').trim();
  const candidates = [source];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source);
  if (fenced) candidates.push(fenced[1].trim());
  const first = source.indexOf('{');
  const last = source.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(source.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object') return value;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

// Models miscount brackets. Real answers have carried "<<<FILE a.md>>" (two, not three) and a REPLACE
// marker ten ">" long. A marker is recognised by its word; the bracket count only has to be close.
const CLOSE = '>{2,4}';
// Three "<" exactly: a shell here-document ("cat <<END") inside a file must not end the block.
const END = '<<<END>{2,4}';
// An opener may lose its ">>>" altogether ("<<<FILE login.js", from a real answer): accepted only when
// the line holds the path and nothing else, so prose such as "<<<FILE a.js now follows" is never read as one.
const OPENS = `[ \\t]+(?:([^>\\r\\n]+?)[ \\t]*${CLOSE}|([^\\s>]+))[ \\t]*\\r?\\n`;
const FILE_RE = new RegExp(`<<<FILE${OPENS}([\\s\\S]*?)\\r?\\n?${END}`, 'g');
const EDIT_RE = new RegExp(`<<<EDIT${OPENS}([\\s\\S]*?)\\r?\\n?${END}`, 'g');
const HUNK_RE = /^<{5,12} ?SEARCH[ \t]*\r?\n([\s\S]*?)\r?\n?^={5,12}[ \t]*\r?\n([\s\S]*?)\r?\n?^>{5,12} ?REPLACE[ \t]*\r?$/gm;
const DELETE_RE = new RegExp(`<<<DELETE[ \\t]+([^>\\r\\n]+?)[ \\t]*${CLOSE}`, 'g');
const READ_RE = new RegExp(`<<<READ[ \\t]+([^>\\r\\n]+?)[ \\t]*${CLOSE}`, 'g');
// Lazy up to the closing brackets at the end of the line: the command itself may contain ">".
// Or a one-line command whose ">>>" slipped onto a line of its own (a real answer did this). A command
// that runs over several lines is never accepted: a RUN is one line.
const RUN_RE = new RegExp(`^[ \\t]*<<<RUN[ \\t]+(.+?)(?:${CLOSE}|[ \\t]*\\r?\\n[ \\t]*${CLOSE})[ \\t]*\\r?$`, 'gm');
// The name may come written as a call, "name()": the brackets are not part of it.
const TOOL_RE = new RegExp(`<<<TOOL[ \\t]+([\\w.\\-]+)(?:\\(\\))?[ \\t]*${CLOSE}([\\s\\S]*?)${END}`, 'g');
const END_RE = new RegExp(END);
const FENCE_RE = /^```[\w+-]*[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/;

const OPENER_RE = /<<<(?:FILE|EDIT)[ \t]+(?:[^>\r\n]+>{2,4}|[^\s>]+[ \t]*(?=\r?\n))/g;
const NEXT_MARKER_RE = /\r?\n[ \t]*<<<(?:RUN|READ|DELETE|TOOL)[ \t]/;
const TRAILING_SUMMARY_RE = /\r?\n[ \t]*SUMMARY:[^\n]*\s*$/i;

/**
 * Smaller models often write a whole FILE or EDIT block and simply stop, without the closing
 * <<<END>>>. When the provider says the answer ended on purpose (not at the output limit), the
 * last block is taken to run to the end of the answer - up to a SUMMARY line or a request
 * marker - and is closed for them. An answer that hit the limit is left alone: that block
 * really is half a file, and half a file is never saved.
 */
function closeLastBlock(source) {
  const last = [...source.matchAll(OPENER_RE)].at(-1);
  if (!last || END_RE.test(source.slice(last.index))) return source;
  let block = source.slice(last.index);
  let after = '';
  const marker = NEXT_MARKER_RE.exec(block);
  if (marker) [block, after] = [block.slice(0, marker.index), block.slice(marker.index)];
  const summary = TRAILING_SUMMARY_RE.exec(block);
  if (summary) [block, after] = [block.slice(0, summary.index), summary[0] + after];
  return `${source.slice(0, last.index)}${block.trimEnd()}\n<<<END>>>${after}`;
}

function unfence(content) {
  const match = FENCE_RE.exec(content.trim());
  return match ? match[1] : content;
}

const withNewline = (content) => (content && !content.endsWith('\n') ? `${content}\n` : content);

/**
 * Worker output protocol (plain text - no JSON escaping for code):
 *   <<<FILE path>>> ...full content... <<<END>>>
 *   <<<EDIT path>>> one or more SEARCH/REPLACE hunks <<<END>>>
 *   <<<DELETE path>>>      <<<READ path>>>      <<<RUN shell command>>>
 *   <<<TOOL name>>>{json args}<<<END>>>
 *   SUMMARY: one line
 * A last block without its <<<END>>> is accepted only when the answer is known to be complete.
 */
/**
 * Where a FILE block's content still carries a piece of a marker: a lone ">>>" as its first or last line,
 * or ">>>" glued to the end of its last line. Seen with a real model: login.test.js was saved with a
 * ">>>" line before <<<END>>> and its tests could not even load. Such a file is refused, not repaired:
 * which side of the marker the model meant is a guess about content. Returns 'first line', 'last line' or ''.
 */
function strayMarker(content) {
  const lines = content.replace(/\s+$/, '').split('\n');
  if (lines[0].trim() === '>>>') return 'first line';
  const last = lines.at(-1).trimEnd();
  if (last.trim() === '>>>' || (last.endsWith('>>>') && !last.endsWith('>>>>'))) return 'last line';
  return '';
}

export function parseWorkerOutput(text, declaredFiles = [], { complete = false } = {}) {
  // `complete`: the provider reported that the model finished its answer, rather than being cut off.
  const source = complete ? closeLastBlock(String(text ?? '')) : String(text ?? '');
  const result = { files: [], edits: [], deletes: [], reads: [], runs: [], tools: [], summary: '', truncated: false };

  // m[1]: the path before ">>>"; m[2]: a lone path with no ">>>"; m[3]: the block's content.
  for (const m of source.matchAll(FILE_RE)) {
    const content = withNewline(unfence(m[3]));
    const stray = strayMarker(content);
    result.files.push({ path: (m[1] ?? m[2]).trim(), content, ...(stray ? { stray } : {}) });
  }
  for (const m of source.matchAll(EDIT_RE)) {
    const hunks = [...m[3].matchAll(HUNK_RE)].map((h) => ({ search: h[1], replace: h[2] }));
    // Whatever is left over is not a well-formed hunk. It is kept so the caller can
    // refuse the edit and say so, rather than quietly applying only part of it.
    result.edits.push({ path: (m[1] ?? m[2]).trim(), hunks, stray: m[3].replace(HUNK_RE, '').trim() });
  }
  // An opener without its END means the model ran out of tokens mid-block.
  const openers = (source.match(/<<<(?:FILE|EDIT)[ \t]+/g) ?? []).length;
  result.truncated = openers > result.files.length + result.edits.length;

  const outside = source.replace(FILE_RE, '').replace(EDIT_RE, '');
  for (const m of outside.matchAll(TOOL_RE)) {
    const args = m[2].trim() ? extractJson(m[2]) : {};
    // The same call written twice in one answer is one call.
    if (result.tools.some((seen) => seen.name === m[1] && JSON.stringify(seen.args) === JSON.stringify(args ?? {}))) continue;
    result.tools.push({ name: m[1], args: args ?? {}, invalid: args === null });
  }
  for (const m of outside.matchAll(DELETE_RE)) result.deletes.push(m[1].trim());
  for (const m of outside.matchAll(READ_RE)) result.reads.push(m[1].trim());
  for (const m of outside.matchAll(RUN_RE)) result.runs.push(m[1].trim());

  // Fallback: exactly one expected file and one fenced block is unambiguous enough.
  if (!openers && declaredFiles.length === 1) {
    const blocks = [...source.matchAll(/```[\w+-]*[ \t]*\r?\n([\s\S]*?)\r?\n```/g)];
    if (blocks.length === 1) result.files.push({ path: declaredFiles[0], content: withNewline(blocks[0][1]) });
  }

  const summaries = [...outside.matchAll(/^\s*SUMMARY:\s*(.+)$/gim)];
  if (summaries.length) result.summary = summaries.at(-1)[1].trim();
  return result;
}

const leadingSpace = (line) => /^[ \t]*/.exec(line)[0];

/**
 * Locate `search` in `text` ignoring trailing whitespace, then ignoring
 * indentation. Models routinely get both slightly wrong.
 */
function fuzzyFind(text, search, replace) {
  const lines = text.split('\n');
  const wanted = search.split('\n');
  for (const norm of [(s) => s.trimEnd(), (s) => s.trim()]) {
    const target = wanted.map(norm);
    for (let i = 0; i + target.length <= lines.length; i++) {
      if (!target.every((line, k) => norm(lines[i + k]) === line)) continue;
      const start = lines.slice(0, i).reduce((sum, line) => sum + line.length + 1, 0);
      const end = start + lines.slice(i, i + target.length).join('\n').length;
      // Matched at a different indent: shift the replacement by the same amount.
      const fileIndent = leadingSpace(lines[i]);
      const searchIndent = leadingSpace(wanted[0]);
      const extra = fileIndent.startsWith(searchIndent) ? fileIndent.slice(searchIndent.length) : '';
      const shifted = extra ? replace.split('\n').map((line) => (line ? extra + line : line)).join('\n') : replace;
      return { start, end, replace: shifted };
    }
  }
  return null;
}

/**
 * Apply SEARCH/REPLACE hunks to a file's content.
 * Returns { content, failed } where `failed` lists the 1-based hunks whose
 * SEARCH text could not be found. A hunk with an empty SEARCH appends to the
 * end of the file. Line endings of the original are preserved.
 */
export function applyEdits(original, hunks) {
  const crlf = original.includes('\r\n');
  let text = crlf ? original.replace(/\r\n/g, '\n') : original;
  const failed = [];

  hunks.forEach((hunk, index) => {
    const search = hunk.search.replace(/\r\n/g, '\n');
    const replace = hunk.replace.replace(/\r\n/g, '\n');
    if (!search.trim()) {
      // Empty SEARCH: append. The natural way to add a new function or test.
      text = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${replace}${replace.endsWith('\n') ? '' : '\n'}`;
      return;
    }
    const at = text.indexOf(search);
    const hit = at >= 0 ? { start: at, end: at + search.length, replace } : fuzzyFind(text, search, replace);
    if (!hit) return failed.push(index + 1);
    text = text.slice(0, hit.start) + hit.replace + text.slice(hit.end);
  });

  return { content: crlf ? text.replace(/\n/g, '\r\n') : text, failed };
}
