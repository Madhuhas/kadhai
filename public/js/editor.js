import { h } from './util.js';
import { highlight, languageOf } from './highlight.js';

/**
 * The code editor: a transparent <textarea> over the highlighted code, in one scrolling sheet
 * with the line numbers. No library. Every change goes through the browser's own insertText,
 * so Ctrl+Z / Ctrl+Y undo exactly what was done, including indenting, moving lines and replace.
 *
 * createEditor({ text, ext, readOnly, onDirty, onSave, onCommand, onCursor })
 *   -> { el, text(), setText(text), markSaved(text), dirty(), focus(), goTo(line, col, length),
 *        setProblems(list), setReadOnly(on), openFind(replace), view(), restore(view) }
 * text() gives the file back with its own line endings (a CRLF file stays CRLF).
 */

const TAB_SIZE = 2; // as the file viewer has always shown tabs
const MAX_MARKS = 1000; // find matches drawn at once (only those on screen are)
const MAX_FIND = 5000;
const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = { ')': '(', ']': '[', '}': '{' };
const QUOTES = new Set(['"', "'", '`']);

const lineStart = (text, pos) => text.lastIndexOf('\n', pos - 1) + 1;
const lineEnd = (text, pos) => {
  const at = text.indexOf('\n', pos);
  return at < 0 ? text.length : at;
};
const indentOf = (line) => /^[ \t]*/.exec(line)[0];
const visualWidth = (s) => {
  let col = 0;
  for (const c of s) col = c === '\t' ? col + TAB_SIZE - (col % TAB_SIZE) : col + 1;
  return col;
};

/** Two spaces, four spaces or a tab: whatever most indented lines of the file use. */
function detectIndent(text) {
  let tabs = 0;
  const widths = {};
  for (const line of text.split('\n', 2000)) {
    const m = /^([ \t]+)\S/.exec(line);
    if (!m) continue;
    if (m[1][0] === '\t') tabs++;
    else widths[m[1].length] = (widths[m[1].length] ?? 0) + 1;
  }
  const spaced = Object.values(widths).reduce((a, b) => a + b, 0);
  if (tabs > spaced) return '\t';
  // The smallest common step: 2 if lines are indented by 2, 6, 10..., else 4.
  const steps = Object.entries(widths).filter(([, n]) => n >= 2).map(([w]) => Number(w));
  return steps.length && steps.every((w) => w % 4 === 0) ? '    ' : '  ';
}

export function createEditor({ text = '', ext = '', readOnly = false, onDirty, onSave, onCommand, onCursor } = {}) {
  const lang = languageOf(ext);
  let eol = /\r\n/.test(text) ? '\r\n' : '\n';
  let savedEol = eol;
  let saved = text.replace(/\r\n/g, '\n');
  let unit = detectIndent(saved);
  let problems = [];
  let wasDirty = false;
  let metrics = { line: 20, char: 8, top: 0, left: 0 };
  let find = { query: '', matchCase: false, wholeWord: false, regex: false, matches: [], at: -1, error: '' };

  // ------------------------------------------------------------------ the DOM
  // Writing helpers (Grammarly) hook into every textarea and draw over it or rewrite it: code is kept out of their reach.
  const input = h('textarea', { class: 'ed-input', wrap: 'off', spellcheck: false, autocapitalize: 'off', autocomplete: 'off', ariaLabel: 'Code', ariaMultiLine: 'true', 'data-gramm': 'false', 'data-gramm_editor': 'false', 'data-enable-grammarly': 'false' });
  input.value = saved;
  input.readOnly = readOnly;
  input.spellcheck = false; // h() skips false values, so this is set here
  const code = h('pre', { class: 'ed-hl', ariaHidden: 'true' });
  const layer = h('div', { class: 'ed-layer', ariaHidden: 'true' });
  const probe = h('span', { class: 'ed-probe', ariaHidden: 'true' }, 'x'.repeat(100));
  const gutter = h('pre', { class: 'ed-gutter', ariaHidden: 'true' });
  const sheetCode = h('div', { class: 'ed-code' }, layer, code, input, probe);
  const scroller = h('div', { class: 'ed-scroll' }, h('div', { class: 'ed-sheet' }, gutter, sheetCode));

  const findInput = h('input', { type: 'text', class: 'ed-find-input', placeholder: 'Find', ariaLabel: 'Find', spellcheck: false });
  const replaceInput = h('input', { type: 'text', class: 'ed-find-input', placeholder: 'Replace', ariaLabel: 'Replace with', spellcheck: false });
  findInput.spellcheck = replaceInput.spellcheck = false;
  const count = h('span', { class: 'ed-count muted' });
  const toggle = (label, key, title) =>
    h('button', { type: 'button', class: 'ed-opt', title, ariaPressed: 'false', onclick: (e) => { find[key] = !find[key]; e.currentTarget.setAttribute('aria-pressed', String(find[key])); refind(); } }, label);
  const replaceRow = h('div', { class: 'ed-find-row', hidden: true }, replaceInput,
    h('button', { type: 'button', class: 'btn sm', title: 'Replace this match (Enter)', onclick: () => replaceOne() }, 'replace'),
    h('button', { type: 'button', class: 'btn sm', title: 'Replace every match (Ctrl+Alt+Enter)', onclick: () => replaceAll() }, 'all'));
  const findBar = h('div', { class: 'ed-find', hidden: true, role: 'search' },
    h('div', { class: 'ed-find-row' },
      h('button', { type: 'button', class: 'ed-opt', title: 'Show replace', ariaLabel: 'Show replace', onclick: () => showReplace(replaceRow.hidden) }, '<>'),
      findInput,
      toggle('Aa', 'matchCase', 'Match case'), toggle('W', 'wholeWord', 'Whole word'), toggle('.*', 'regex', 'Regular expression'),
      count,
      h('button', { type: 'button', class: 'icon-btn', title: 'Previous match (Shift+Enter)', ariaLabel: 'Previous match', onclick: () => step(-1) }, '^'),
      h('button', { type: 'button', class: 'icon-btn', title: 'Next match (Enter)', ariaLabel: 'Next match', onclick: () => step(1) }, 'v'),
      h('button', { type: 'button', class: 'icon-btn', title: 'Close (Esc)', ariaLabel: 'Close find', onclick: () => closeFind() }, '×')),
    replaceRow);

  const pos = h('span', { class: 'ed-pos' });
  const note = h('span', { class: 'ed-note' });
  const problemCount = h('button', { type: 'button', class: 'ed-problems', title: 'Problems in this file', onclick: () => onCommand?.('problems') });
  const indentLabel = h('button', { type: 'button', class: 'ed-indent', title: 'Indentation: click to switch', onclick: () => { unit = unit === '\t' ? '  ' : unit === '  ' ? '    ' : '\t'; status(); } });
  const eolLabel = h('button', { type: 'button', class: 'ed-eol', title: 'Line endings: click to switch', onclick: () => { eol = eol === '\n' ? '\r\n' : '\n'; status(); emitDirty(); } });
  const statusBar = h('div', { class: 'ed-status' }, pos, note, h('span', { class: 'spacer' }), problemCount, indentLabel, eolLabel, h('span', { class: 'ed-lang' }, lang.name));
  const el = h('div', { class: 'ed' }, findBar, scroller, statusBar);

  // ------------------------------------------------------------ drawing
  let drawQueued = false;
  const draw = () => {
    const value = input.value;
    code.innerHTML = `${highlight(value, ext)}\n`;
    const lines = value.split('\n').length;
    const bad = new Set(problems.map((p) => p.line));
    // DOM nodes, not innerHTML (only mdLite, highlight and renderDiff build markup).
    if (bad.size) gutter.replaceChildren(...Array.from({ length: lines }, (_, i) => [i ? '\n' : '', bad.has(i + 1) ? h('span', { class: 'ed-bad' }, String(i + 1)) : String(i + 1)]).flat().filter((part) => part !== ''));
    else gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
    drawLayer();
    status();
  };
  const redraw = () => {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      draw();
    });
  };

  const measure = () => {
    const style = getComputedStyle(code);
    metrics = { line: parseFloat(style.lineHeight) || 20, char: probe.getBoundingClientRect().width / 100 || 8, top: parseFloat(style.paddingTop) || 0, left: parseFloat(style.paddingLeft) || 0 };
  };

  /** Where a text offset is drawn, in the code sheet. */
  const place = (offset) => {
    const value = input.value;
    const start = lineStart(value, offset);
    const line = value.slice(0, start).split('\n').length - 1;
    return { line, x: metrics.left + visualWidth(value.slice(start, offset)) * metrics.char, y: metrics.top + line * metrics.line };
  };

  const box = (cls, from, to, title) => {
    const a = place(from);
    const b = place(Math.max(to, from));
    const width = Math.max(b.x - a.x, metrics.char * 0.6);
    return h('div', { class: cls, title, style: `top:${a.y}px;left:${a.x}px;width:${width}px;height:${metrics.line}px` });
  };

  function drawLayer() {
    const value = input.value;
    const parts = [];
    const caret = place(input.selectionStart);
    parts.push(h('div', { class: 'ed-curline', style: `top:${caret.y}px;height:${metrics.line}px` }));
    // Only what is on screen: a long file with thousands of matches stays quick.
    const first = Math.floor(scroller.scrollTop / metrics.line) - 2;
    const last = first + Math.ceil(scroller.clientHeight / metrics.line) + 4;
    const lineOf = (offset) => value.slice(0, offset).split('\n').length - 1;
    if (!findBar.hidden && find.matches.length) {
      let drawn = 0;
      for (const [i, m] of find.matches.entries()) {
        if (drawn > MAX_MARKS) break;
        const line = lineOf(m.start);
        if (line < first) continue;
        if (line > last) break;
        parts.push(box(`ed-match${i === find.at ? ' current' : ''}`, m.start, m.end));
        drawn++;
      }
    }
    for (const p of problems) {
      const line = p.line - 1;
      if (line < first || line > last) continue;
      const start = offsetOf(p.line, p.col);
      const end = Math.max(start + 1, start + (/^[^\s]*/.exec(value.slice(start, lineEnd(value, start)))[0].length || 1));
      parts.push(box('ed-squiggle', start, end, p.message));
    }
    const pair = bracketPair();
    if (pair) parts.push(box('ed-bracket', pair[0], pair[0] + 1), box('ed-bracket', pair[1], pair[1] + 1));
    layer.replaceChildren(...parts);
  }

  /** The bracket at (or just before) the caret and the one it pairs with, by counting - strings are not skipped. */
  function bracketPair() {
    if (input.selectionStart !== input.selectionEnd) return null;
    const value = input.value;
    for (const at of [input.selectionStart - 1, input.selectionStart]) {
      const c = value[at];
      if (OPEN[c]) {
        for (let i = at + 1, depth = 0; i < value.length && i - at < 20000; i++) {
          if (value[i] === c) depth++;
          else if (value[i] === OPEN[c] && depth-- === 0) return [at, i];
        }
      } else if (CLOSE[c]) {
        for (let i = at - 1, depth = 0; i >= 0 && at - i < 20000; i--) {
          if (value[i] === c) depth++;
          else if (value[i] === CLOSE[c] && depth-- === 0) return [i, at];
        }
      }
    }
    return null;
  }

  function status() {
    const value = input.value;
    const { selectionStart: s, selectionEnd: e } = input;
    const start = lineStart(value, s);
    const line = value.slice(0, start).split('\n').length;
    const col = visualWidth(value.slice(start, s)) + 1;
    pos.textContent = `Ln ${line}, Col ${col}${e > s ? ` (${e - s} selected)` : ''}`;
    const here = problems.find((p) => p.line === line);
    note.textContent = here ? `[!] ${here.message}` : input.readOnly ? 'read-only' : '';
    note.classList.toggle('err', Boolean(here));
    problemCount.textContent = problems.length ? `[!] ${problems.length} problem${problems.length === 1 ? '' : 's'}` : 'no problems';
    problemCount.classList.toggle('err', problems.length > 0);
    indentLabel.textContent = unit === '\t' ? 'Tabs' : `Spaces: ${unit.length}`;
    eolLabel.textContent = eol === '\r\n' ? 'CRLF' : 'LF';
    onCursor?.({ line, col });
  }

  /** Keep the caret on screen: the textarea never scrolls itself, the sheet around it does. */
  function reveal() {
    const at = place(input.selectionEnd);
    const gutterWidth = gutter.getBoundingClientRect().width;
    const margin = metrics.line * 2;
    if (at.y < scroller.scrollTop + metrics.line) scroller.scrollTop = Math.max(0, at.y - margin);
    else if (at.y + metrics.line > scroller.scrollTop + scroller.clientHeight - metrics.line) scroller.scrollTop = at.y + metrics.line - scroller.clientHeight + margin;
    const visible = scroller.clientWidth - gutterWidth;
    if (at.x < scroller.scrollLeft + metrics.char * 4) scroller.scrollLeft = Math.max(0, at.x - metrics.char * 8);
    else if (at.x > scroller.scrollLeft + visible - metrics.char * 4) scroller.scrollLeft = at.x - visible + metrics.char * 12;
  }

  function emitDirty() {
    const now = isDirty();
    if (now !== wasDirty) {
      wasDirty = now;
      onDirty?.(now);
    }
  }
  const isDirty = () => input.value !== saved || eol !== savedEol;

  // ------------------------------------------------------------ editing (all undoable)

  /** Replace [start, end) with text through the browser's editing, so it can be undone. */
  function edit(start, end, insert, selStart, selEnd) {
    if (input.readOnly) return;
    input.focus();
    input.setSelectionRange(start, end);
    const ok = insert ? document.execCommand('insertText', false, insert) : start === end || document.execCommand('delete');
    if (!ok) {
      input.setRangeText(insert, start, end, 'end');
      input.dispatchEvent(new Event('input'));
    }
    const caret = start + insert.length;
    input.setSelectionRange(selStart ?? caret, selEnd ?? selStart ?? caret);
  }

  /** The whole lines the selection touches: [from, to) with to at the end of the last line. */
  function selectedLines() {
    const value = input.value;
    const { selectionStart: s, selectionEnd: e } = input;
    // A selection that ends at the start of a line does not take that line along.
    const endAt = e > s && value[e - 1] === '\n' ? e - 1 : e;
    return [lineStart(value, s), lineEnd(value, endAt)];
  }

  function indentLines(out) {
    const value = input.value;
    const [from, to] = selectedLines();
    const { selectionStart: s, selectionEnd: e } = input;
    const lines = value.slice(from, to).split('\n');
    // Outdenting takes one tab, or up to one indent step of spaces.
    const cutOf = (line) => (line.startsWith('\t') ? 1 : Math.min(/^ */.exec(line)[0].length, unit === '\t' ? TAB_SIZE : unit.length));
    let firstShift = 0;
    let total = 0;
    const next = lines.map((line, i) => {
      if (!out) {
        if (!line.trim() && lines.length > 1) return line;
        if (i === 0) firstShift = unit.length;
        total += unit.length;
        return unit + line;
      }
      const cut = cutOf(line);
      if (i === 0) firstShift = -cut;
      total -= cut;
      return line.slice(cut);
    });
    edit(from, to, next.join('\n'), Math.max(from, s + firstShift), Math.max(from, e + total));
  }

  function toggleComment() {
    if (!lang.comment) return;
    const value = input.value;
    const [from, to] = selectedLines();
    const lines = value.slice(from, to).split('\n');
    const used = lines.filter((l) => l.trim());
    if (!used.length) return;
    const [open, close] = Array.isArray(lang.comment) ? lang.comment : [lang.comment, ''];
    const commented = (l) => l.trimStart().startsWith(open) && (!close || l.trimEnd().endsWith(close));
    const remove = used.every(commented);
    const pad = Math.min(...used.map((l) => indentOf(l).length));
    const next = lines.map((l) => {
      if (!l.trim()) return l;
      if (remove) {
        const lead = indentOf(l);
        let body = l.slice(lead.length).slice(open.length);
        if (body.startsWith(' ')) body = body.slice(1);
        // Every character that means something in a pattern is escaped, not just the * of "*/" (CodeQL).
        if (close) body = body.replace(new RegExp(`\\s?${close.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`), '');
        return lead + body;
      }
      return `${l.slice(0, pad)}${open} ${l.slice(pad)}${close ? ` ${close}` : ''}`;
    });
    const joined = next.join('\n');
    edit(from, to, joined, from, from + joined.length);
  }

  function moveLines(dir, copy) {
    const value = input.value;
    const [from, to] = selectedLines();
    const block = value.slice(from, to);
    const { selectionStart: s, selectionEnd: e } = input;
    if (copy) {
      // Duplicate the block above or below; the copy is selected.
      edit(to, to, `\n${block}`, dir > 0 ? s + block.length + 1 : s, dir > 0 ? e + block.length + 1 : e);
      return;
    }
    if (dir < 0) {
      if (from === 0) return;
      const prevStart = lineStart(value, from - 1);
      const prev = value.slice(prevStart, from - 1);
      const shift = prev.length + 1;
      edit(prevStart, to, `${block}\n${prev}`, s - shift, e - shift);
    } else {
      if (to >= value.length) return;
      const nextEnd = lineEnd(value, to + 1);
      const nextLine = value.slice(to + 1, nextEnd);
      const shift = nextLine.length + 1;
      edit(from, nextEnd, `${nextLine}\n${block}`, s + shift, e + shift);
    }
  }

  function deleteLines() {
    const value = input.value;
    const [from, to] = selectedLines();
    if (to < value.length) edit(from, to + 1, '', from);
    // The last line: take the line break before it, and land at the start of the line above.
    else edit(Math.max(0, from - 1), to, '', from ? lineStart(value, from - 1) : 0);
  }

  function newline() {
    const value = input.value;
    const { selectionStart: s, selectionEnd: e } = input;
    const start = lineStart(value, s);
    const indent = indentOf(value.slice(start, s));
    const before = value.slice(start, s).trimEnd().slice(-1);
    const after = value[e];
    const opens = OPEN[before] !== undefined || (before === ':' && ext === 'py');
    if (OPEN[before] && after === OPEN[before]) {
      // {|} -> the caret on its own indented line, the closing bracket below.
      const inner = `\n${indent}${unit}`;
      edit(s, e, `${inner}\n${indent}`, s + inner.length);
      return;
    }
    const text = `\n${indent}${opens ? unit : ''}`;
    edit(s, e, text);
  }

  function smartHome(select) {
    const value = input.value;
    const caret = input.selectionDirection === 'backward' ? input.selectionStart : input.selectionEnd;
    const start = lineStart(value, caret);
    const first = start + indentOf(value.slice(start, lineEnd(value, start))).length;
    const target = caret === first ? start : first;
    if (select) {
      const anchor = input.selectionDirection === 'backward' ? input.selectionEnd : input.selectionStart;
      input.setSelectionRange(Math.min(anchor, target), Math.max(anchor, target), target < anchor ? 'backward' : 'forward');
    } else input.setSelectionRange(target, target);
  }

  function selectWordOrNext() {
    const value = input.value;
    const { selectionStart: s, selectionEnd: e } = input;
    if (s === e) {
      const left = /[\w$]*$/.exec(value.slice(0, s))[0].length;
      const right = /^[\w$]*/.exec(value.slice(s))[0].length;
      input.setSelectionRange(s - left, s + right);
    } else {
      // VS Code adds a cursor; with one selection this moves to the next match instead.
      const word = value.slice(s, e);
      let at = value.indexOf(word, e);
      if (at < 0) at = value.indexOf(word);
      if (at >= 0) input.setSelectionRange(at, at + word.length);
    }
    reveal();
  }

  // ------------------------------------------------------------ find and replace

  function refind() {
    const value = input.value;
    find.query = findInput.value;
    find.matches = [];
    find.error = '';
    if (find.query) {
      try {
        let source = find.regex ? find.query : find.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (find.wholeWord) source = `\\b(?:${source})\\b`;
        const re = new RegExp(source, `g${find.matchCase ? '' : 'i'}m`);
        for (let m = re.exec(value); m && find.matches.length < MAX_FIND; m = re.exec(value)) {
          if (!m[0]) {
            re.lastIndex++;
            continue;
          }
          find.matches.push({ start: m.index, end: m.index + m[0].length, groups: m });
        }
      } catch {
        find.error = 'bad pattern';
      }
    }
    // The match at or after the caret is the current one.
    const from = input.selectionStart;
    find.at = find.matches.length ? Math.max(0, find.matches.findIndex((m) => m.start >= from)) : -1;
    if (find.at < 0 && find.matches.length) find.at = 0;
    countLabel();
    drawLayer();
  }

  const countLabel = () => {
    count.textContent = find.error || (find.query ? (find.matches.length ? `${find.at + 1} of ${find.matches.length}${find.matches.length >= MAX_FIND ? '+' : ''}` : 'no results') : '');
    count.classList.toggle('err', Boolean(find.error) || (Boolean(find.query) && !find.matches.length));
  };

  function step(dir) {
    if (!find.matches.length) return;
    find.at = (find.at + dir + find.matches.length) % find.matches.length;
    const m = find.matches[find.at];
    input.setSelectionRange(m.start, m.end);
    reveal();
    countLabel();
    drawLayer();
  }

  const replacementFor = (m) => (find.regex ? expand(m.groups) : replaceInput.value);
  // $1, $& and $<name> in a regex replacement, as String.replace reads them.
  const expand = (groups) =>
    replaceInput.value.replace(/\$(\$|&|\d{1,2}|<[^>]+>)/g, (all, key) => (key === '$' ? '$' : key === '&' ? groups[0] : key[0] === '<' ? (groups.groups?.[key.slice(1, -1)] ?? '') : (groups[Number(key)] ?? all)));

  function replaceOne() {
    if (input.readOnly || find.at < 0) return;
    const m = find.matches[find.at];
    const text = replacementFor(m);
    edit(m.start, m.end, text);
    refind();
    if (find.matches.length) step(0);
  }

  function replaceAll() {
    if (input.readOnly || !find.matches.length) return;
    const value = input.value;
    let out = '';
    let last = 0;
    for (const m of find.matches) {
      out += value.slice(last, m.start) + replacementFor(m);
      last = m.end;
    }
    out += value.slice(last);
    const n = find.matches.length;
    edit(0, value.length, out, 0);
    refind();
    count.textContent = `replaced ${n}`;
  }

  function openFind(withReplace = false) {
    findBar.hidden = false;
    const { selectionStart: s, selectionEnd: e } = input;
    const picked = input.value.slice(s, e);
    if (picked && !picked.includes('\n')) findInput.value = picked;
    showReplace(withReplace);
    findInput.focus();
    findInput.select();
    refind();
  }
  function showReplace(on) {
    replaceRow.hidden = !on || input.readOnly;
  }
  function closeFind() {
    findBar.hidden = true;
    drawLayer();
    input.focus();
  }

  findInput.addEventListener('input', refind);
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') closeFind();
  });
  replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.altKey) {
      e.preventDefault();
      replaceAll();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      replaceOne();
    } else if (e.key === 'Escape') closeFind();
  });

  // ------------------------------------------------------------ keys

  input.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const ro = input.readOnly;
    const run = (fn) => {
      e.preventDefault();
      fn();
      requestAnimationFrame(reveal);
    };
    if (mod && !e.shiftKey && key.toLowerCase() === 's') return run(() => onSave?.());
    if (mod && !e.shiftKey && key.toLowerCase() === 'f') return run(() => openFind(false));
    if (mod && !e.shiftKey && key.toLowerCase() === 'h') return run(() => openFind(true));
    if (mod && !e.shiftKey && key.toLowerCase() === 'g') return run(() => onCommand?.('goto'));
    if (key === 'F3') return run(() => (findBar.hidden ? openFind(false) : step(e.shiftKey ? -1 : 1)));
    if (key === 'Escape' && !findBar.hidden) return run(closeFind);
    if (mod && !e.shiftKey && key.toLowerCase() === 'd') return run(selectWordOrNext);
    if (mod && !e.shiftKey && key.toLowerCase() === 'l') {
      return run(() => {
        const [from, to] = selectedLines();
        input.setSelectionRange(from, Math.min(to + 1, input.value.length));
      });
    }
    if (key === 'Home' && !mod && !e.altKey) return run(() => smartHome(e.shiftKey));
    if (ro) return;
    if (key === 'Tab' && !mod && !e.altKey) {
      const multi = input.value.slice(input.selectionStart, input.selectionEnd).includes('\n');
      return run(() => (e.shiftKey || multi ? indentLines(e.shiftKey) : edit(input.selectionStart, input.selectionEnd, unit)));
    }
    if (mod && (key === ']' || key === '[')) return run(() => indentLines(key === '['));
    if (mod && (key === '/' || e.code === 'Slash')) return run(toggleComment);
    if (e.altKey && !mod && (key === 'ArrowUp' || key === 'ArrowDown')) return run(() => moveLines(key === 'ArrowUp' ? -1 : 1, e.shiftKey));
    if (mod && e.shiftKey && key.toLowerCase() === 'k') return run(deleteLines);
    if (key === 'Enter' && mod) {
      return run(() => {
        const value = input.value;
        if (e.shiftKey) {
          const start = lineStart(value, input.selectionStart);
          const indent = indentOf(value.slice(start, lineEnd(value, start)));
          edit(start, start, `${indent}\n`, start + indent.length);
        } else {
          const end = lineEnd(value, input.selectionEnd);
          const indent = indentOf(value.slice(lineStart(value, end), end));
          edit(end, end, `\n${indent}`);
        }
      });
    }
    if (key === 'Enter' && !e.altKey && !e.shiftKey) return run(newline);
    if (key === 'Backspace' && !mod && !e.altKey && input.selectionStart === input.selectionEnd) {
      const value = input.value;
      const s = input.selectionStart;
      const prev = value[s - 1];
      // An empty pair the editor made: delete both halves.
      if ((OPEN[prev] && value[s] === OPEN[prev]) || (QUOTES.has(prev) && value[s] === prev)) return run(() => edit(s - 1, s + 1, ''));
      // In the indentation: back one indent step, not one space.
      const lead = value.slice(lineStart(value, s), s);
      if (unit !== '\t' && lead.length && /^ +$/.test(lead)) {
        const cut = lead.length % unit.length || unit.length;
        if (cut > 1) return run(() => edit(s - cut, s, ''));
      }
      return;
    }
    if (!mod && !e.altKey && key.length === 1) {
      const value = input.value;
      const { selectionStart: s, selectionEnd: en } = input;
      // Typing a closer that is already there steps over it.
      if ((CLOSE[key] || QUOTES.has(key)) && s === en && value[s] === key && (CLOSE[key] || value[s - 1] !== '\\')) return run(() => input.setSelectionRange(s + 1, s + 1));
      if (OPEN[key] || QUOTES.has(key)) {
        const close = OPEN[key] ?? key;
        if (s !== en) return run(() => edit(s, en, key + value.slice(s, en) + close, s + 1, en + 1)); // wrap the selection
        const next = value[s] ?? '';
        const prev = value[s - 1] ?? '';
        const free = next === '' || /[\s)\]};,]/.test(next);
        const quoteOk = !QUOTES.has(key) || (!/[\w$]/.test(prev) && prev !== key);
        if (free && quoteOk) return run(() => edit(s, s, key + close, s + 1));
      }
    }
  });

  input.addEventListener('input', () => {
    draw();
    if (!findBar.hidden) refind();
    emitDirty();
    reveal();
  });
  for (const type of ['keyup', 'mouseup', 'select', 'focus']) input.addEventListener(type, () => { drawLayer(); status(); });
  input.addEventListener('mousedown', () => requestAnimationFrame(() => { drawLayer(); status(); }));
  scroller.addEventListener('scroll', () => redraw());
  // The font follows the window width (clamp on vw): measure again whenever the editor is resized.
  const resize = new ResizeObserver(() => { measure(); drawLayer(); });
  resize.observe(scroller);

  const offsetOf = (line, col = 1) => {
    const value = input.value;
    let at = 0;
    for (let i = 1; i < line && at >= 0; i++) at = value.indexOf('\n', at) + 1 || value.length;
    const end = lineEnd(value, at);
    // col counts tabs as one character, as node and JSON report it.
    return Math.min(at + Math.max(0, col - 1), end);
  };

  queueMicrotask(() => {
    measure();
    draw();
  });

  return {
    el,
    text: () => (eol === '\r\n' ? input.value.replace(/\n/g, '\r\n') : input.value),
    dirty: isDirty,
    /** Replace the whole text (a reload): the caret and the view stay as close as they can. */
    setText(next) {
      const view = this.view();
      saved = next.replace(/\r\n/g, '\n');
      eol = savedEol = /\r\n/.test(next) ? '\r\n' : '\n';
      input.value = saved;
      unit = detectIndent(saved);
      draw();
      this.restore(view);
      emitDirty();
    },
    /** What is in the editor is now what is on disk. */
    markSaved() {
      saved = input.value;
      savedEol = eol;
      emitDirty();
    },
    focus: () => input.focus(),
    goTo(line, col = 1, length = 0) {
      const start = offsetOf(line, col);
      input.focus();
      input.setSelectionRange(start, start + length);
      measure();
      const at = place(start);
      scroller.scrollTop = Math.max(0, at.y - scroller.clientHeight / 3);
      reveal();
      drawLayer();
      status();
    },
    setProblems(list) {
      problems = (list ?? []).filter((p) => p.line > 0);
      draw();
    },
    setReadOnly(on) {
      input.readOnly = on;
      if (on) replaceRow.hidden = true;
      status();
    },
    openFind,
    view: () => ({ start: input.selectionStart, end: input.selectionEnd, top: scroller.scrollTop, left: scroller.scrollLeft }),
    restore(view) {
      if (!view) return;
      const max = input.value.length;
      input.setSelectionRange(Math.min(view.start, max), Math.min(view.end, max));
      requestAnimationFrame(() => {
        scroller.scrollTop = view.top;
        scroller.scrollLeft = view.left;
        drawLayer();
      });
    },
    destroy: () => resize.disconnect(),
  };
}
