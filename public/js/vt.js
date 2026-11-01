import { h } from './util.js';

/**
 * A small terminal emulator for the real terminal (pty.js on the server): the screen a VT100 /
 * xterm-style program draws on, and the keys it expects back. Hand-written, no library. It covers
 * what PowerShell, cmd, bash and full-screen programs like vim send through ConPTY: cursor
 * movement, erasing, scroll regions, insert and delete, the alternate screen, 16 / 256 / true
 * colours, bracketed paste, application cursor keys, and the cursor-position and device questions
 * ConPTY asks when it starts. Text is drawn with DOM nodes and textContent - never innerHTML -
 * because whatever a program prints is untrusted.
 *
 * new Terminal({ reply }) -> { el, write(data), resize(cols, rows), keyData(event), pasteData(text), focus() }
 * `reply(text)` sends answers to the program (cursor position, device attributes).
 */

const SCROLLBACK = 3000;

const BLANK_STYLE = Object.freeze({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false });
const cell = (c, s) => ({ c, s });

/** xterm's 256 colours past the 16 named ones: a 6x6x6 cube, then 24 greys. */
function colour256(n) {
  if (n < 232) {
    const v = [0, 95, 135, 175, 215, 255];
    const i = n - 16;
    return `rgb(${v[Math.floor(i / 36)]},${v[Math.floor(i / 6) % 6]},${v[i % 6]})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

class Screen {
  constructor(cols, rows, reply) {
    this.cols = cols;
    this.rows = rows;
    this.reply = reply;
    this.reset();
  }

  reset() {
    this.lines = Array.from({ length: this.rows }, () => this.blankLine());
    this.scrollback = [];
    this.x = 0;
    this.y = 0;
    this.saved = { x: 0, y: 0, style: BLANK_STYLE };
    this.style = BLANK_STYLE;
    this.top = 0;
    this.bottom = this.rows - 1;
    this.wrapNext = false;
    this.autowrap = true;
    this.insert = false;
    this.cursorVisible = true;
    this.appCursor = false;
    this.bracketedPaste = false;
    this.alt = null; // the main screen, kept while the alternate one is up
    this.dirty = new Set(Array.from({ length: this.rows }, (_, i) => i));
    this.pushed = []; // lines that left the top into the scrollback since the last draw
    this.state = 'ground';
    this.params = '';
    this.prefix = '';
    this.osc = '';
  }

  blankLine(style = BLANK_STYLE) {
    const blank = style.bg ? { ...BLANK_STYLE, bg: style.bg } : BLANK_STYLE;
    return Array.from({ length: this.cols }, () => cell(' ', blank));
  }

  allDirty() {
    for (let i = 0; i < this.rows; i++) this.dirty.add(i);
  }

  // ------------------------------------------------------------ output

  write(data) {
    for (const ch of data) {
      const code = ch.codePointAt(0);
      switch (this.state) {
        case 'ground':
          if (code === 0x1b) this.state = 'esc';
          else if (code < 0x20 || code === 0x7f) this.control(code);
          else this.put(ch);
          break;
        case 'esc':
          this.escape(ch);
          break;
        case 'csi':
          if (/[0-9;:]/.test(ch)) this.params += ch;
          else if (/[?>=!<]/.test(ch) && !this.params) this.prefix = ch;
          else if (code >= 0x40 && code <= 0x7e) {
            this.csi(ch);
            this.state = 'ground';
          } else if (code === 0x1b) this.state = 'esc';
          // intermediates (space, ", $, ') are read and ignored
          break;
        case 'osc':
          if (code === 0x07) this.state = 'ground';
          else if (code === 0x1b) this.state = 'oscEsc';
          else if (this.osc.length < 512) this.osc += ch;
          break;
        case 'oscEsc':
          this.state = ch === '\\' ? 'ground' : 'osc';
          break;
        case 'charset':
          this.state = 'ground'; // ESC ( B and friends: the character set, always ASCII here
          break;
        case 'string':
          // DCS, APC, PM, SOS: skipped up to the string terminator
          if (code === 0x1b) this.state = 'stringEsc';
          else if (code === 0x07) this.state = 'ground';
          break;
        case 'stringEsc':
          this.state = ch === '\\' ? 'ground' : 'string';
          break;
        default:
          this.state = 'ground';
      }
    }
  }

  control(code) {
    if (code === 0x0d) this.carriageReturn();
    else if (code === 0x0a || code === 0x0b || code === 0x0c) this.lineFeed();
    else if (code === 0x08) this.moveTo(this.x - 1, this.y);
    else if (code === 0x09) this.moveTo(Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8), this.y);
    // BEL and the rest: nothing to show
  }

  escape(ch) {
    this.state = 'ground';
    switch (ch) {
      case '[':
        this.state = 'csi';
        this.params = '';
        this.prefix = '';
        break;
      case ']':
        this.state = 'osc';
        this.osc = '';
        break;
      case 'P':
      case '_':
      case '^':
      case 'X':
        this.state = 'string';
        break;
      case '(':
      case ')':
      case '*':
      case '+':
        this.state = 'charset';
        break;
      case '7':
        this.saveCursor();
        break;
      case '8':
        this.restoreCursor();
        break;
      case 'D':
        this.lineFeed();
        break;
      case 'E':
        this.carriageReturn();
        this.lineFeed();
        break;
      case 'M':
        if (this.y === this.top) this.scrollDown(1);
        else this.moveTo(this.x, this.y - 1);
        break;
      case 'c':
        this.reset();
        break;
      default:
      // ESC = and ESC > (keypad modes) and the rest: nothing to do
    }
  }

  csi(final) {
    const raw = this.params.split(/[;:]/).map((p) => (p === '' ? NaN : Number(p)));
    const p = (i, fallback) => (Number.isNaN(raw[i]) || raw[i] === undefined ? fallback : raw[i]);
    const n = Math.max(1, p(0, 1));
    if (this.prefix === '?') {
      if (final === 'h' || final === 'l') for (const mode of raw) this.privateMode(mode, final === 'h');
      return;
    }
    if (this.prefix === '>' || this.prefix === '=') {
      if (final === 'c') this.reply('\x1b[>0;10;1c');
      return;
    }
    switch (final) {
      case 'A': this.moveTo(this.x, Math.max(this.y - n, this.y >= this.top ? this.top : 0)); break;
      case 'B': this.moveTo(this.x, Math.min(this.y + n, this.y <= this.bottom ? this.bottom : this.rows - 1)); break;
      case 'C': case 'a': this.moveTo(this.x + n, this.y); break;
      case 'D': this.moveTo(this.x - n, this.y); break;
      case 'E': this.moveTo(0, this.y + n); break;
      case 'F': this.moveTo(0, this.y - n); break;
      case 'G': case '`': this.moveTo(p(0, 1) - 1, this.y); break;
      case 'd': this.moveTo(this.x, p(0, 1) - 1); break;
      case 'H': case 'f': this.moveTo(p(1, 1) - 1, p(0, 1) - 1); break;
      case 'J': this.eraseDisplay(p(0, 0)); break;
      case 'K': this.eraseLine(p(0, 0)); break;
      case 'L': if (this.y >= this.top && this.y <= this.bottom) this.scrollDown(n, this.y); break;
      case 'M': if (this.y >= this.top && this.y <= this.bottom) this.scrollUp(n, this.y); break;
      case 'P': this.deleteChars(n); break;
      case '@': this.insertChars(n); break;
      case 'X': this.eraseChars(n); break;
      case 'S': this.scrollUp(n); break;
      case 'T': this.scrollDown(n); break;
      case 'm': this.sgr(raw); break;
      case 'r': {
        const top = p(0, 1) - 1;
        const bottom = p(1, this.rows) - 1;
        if (top < bottom && bottom < this.rows) {
          this.top = top;
          this.bottom = bottom;
          this.moveTo(0, 0);
        }
        break;
      }
      case 's': this.saveCursor(); break;
      case 'u': this.restoreCursor(); break;
      case 'h': if (p(0, 0) === 4) this.insert = true; break;
      case 'l': if (p(0, 0) === 4) this.insert = false; break;
      case 'n':
        if (p(0, 0) === 6) this.reply(`\x1b[${this.y + 1};${this.x + 1}R`);
        else if (p(0, 0) === 5) this.reply('\x1b[0n');
        break;
      case 'c': this.reply('\x1b[?1;2c'); break;
      default:
      // t (window), q (cursor shape) and others: nothing to draw
    }
  }

  privateMode(mode, on) {
    if (mode === 25) this.cursorVisible = on;
    else if (mode === 1) this.appCursor = on;
    else if (mode === 7) this.autowrap = on;
    else if (mode === 2004) this.bracketedPaste = on;
    else if (mode === 1049 || mode === 47 || mode === 1047) {
      if (on && !this.alt) {
        if (mode === 1049) this.saveCursor();
        this.alt = { lines: this.lines, top: this.top, bottom: this.bottom };
        this.lines = Array.from({ length: this.rows }, () => this.blankLine());
        this.allDirty();
      } else if (!on && this.alt) {
        this.lines = this.alt.lines;
        this.alt = null;
        if (mode === 1049) this.restoreCursor();
        this.allDirty();
      }
    }
  }

  sgr(raw) {
    const list = raw.length ? raw.map((v) => (Number.isNaN(v) ? 0 : v)) : [0];
    let s = { ...this.style };
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v === 0) s = { ...BLANK_STYLE };
      else if (v === 1) s.bold = true;
      else if (v === 2) s.dim = true;
      else if (v === 3) s.italic = true;
      else if (v === 4) s.underline = true;
      else if (v === 7) s.inverse = true;
      else if (v === 9) s.strike = true;
      else if (v === 22) s.bold = s.dim = false;
      else if (v === 23) s.italic = false;
      else if (v === 24) s.underline = false;
      else if (v === 27) s.inverse = false;
      else if (v === 29) s.strike = false;
      else if (v >= 30 && v <= 37) s.fg = v - 30;
      else if (v >= 90 && v <= 97) s.fg = v - 90 + 8;
      else if (v === 39) s.fg = null;
      else if (v >= 40 && v <= 47) s.bg = v - 40;
      else if (v >= 100 && v <= 107) s.bg = v - 100 + 8;
      else if (v === 49) s.bg = null;
      else if (v === 38 || v === 48) {
        // 38;5;n or 38;2;r;g;b (and the same for the background)
        let colour = null;
        if (list[i + 1] === 5) {
          colour = list[i + 2];
          i += 2;
        } else if (list[i + 1] === 2) {
          colour = `rgb(${list[i + 2] ?? 0},${list[i + 3] ?? 0},${list[i + 4] ?? 0})`;
          i += 4;
        }
        if (v === 38) s.fg = colour;
        else s.bg = colour;
      }
    }
    this.style = Object.freeze(s);
  }

  // ------------------------------------------------------------ the grid

  put(ch) {
    if (this.wrapNext && this.autowrap) {
      this.carriageReturn();
      this.lineFeed();
    }
    this.wrapNext = false;
    const line = this.lines[this.y];
    // A combining mark joins the character before it.
    if (/\p{M}/u.test(ch) && this.x > 0) {
      const prev = line[this.x - 1];
      line[this.x - 1] = cell(prev.c + ch, prev.s);
      this.dirty.add(this.y);
      return;
    }
    if (this.insert) {
      line.splice(this.x, 0, cell(' ', this.style));
      line.length = this.cols;
    }
    line[this.x] = cell(ch, this.style);
    this.dirty.add(this.y);
    if (this.x < this.cols - 1) this.x++;
    else this.wrapNext = true;
  }

  moveTo(x, y) {
    this.dirty.add(this.y);
    this.x = Math.max(0, Math.min(this.cols - 1, x));
    this.y = Math.max(0, Math.min(this.rows - 1, y));
    this.wrapNext = false;
    this.dirty.add(this.y);
  }

  carriageReturn() {
    this.dirty.add(this.y);
    this.x = 0;
    this.wrapNext = false;
  }

  lineFeed() {
    this.dirty.add(this.y);
    if (this.y === this.bottom) this.scrollUp(1);
    else if (this.y < this.rows - 1) this.y++;
    this.dirty.add(this.y);
  }

  scrollUp(n, from = this.top) {
    for (let i = 0; i < n; i++) {
      const [gone] = this.lines.splice(from, 1);
      // Only the main screen's top line goes into the scrollback.
      if (from === 0 && !this.alt) {
        this.scrollback.push(gone);
        this.pushed.push(gone);
        if (this.scrollback.length > SCROLLBACK) this.scrollback.shift();
      }
      this.lines.splice(this.bottom, 0, this.blankLine(this.style));
    }
    for (let i = from; i <= this.bottom; i++) this.dirty.add(i);
  }

  scrollDown(n, from = this.top) {
    for (let i = 0; i < n; i++) {
      this.lines.splice(this.bottom, 1);
      this.lines.splice(from, 0, this.blankLine(this.style));
    }
    for (let i = from; i <= this.bottom; i++) this.dirty.add(i);
  }

  eraseLine(mode) {
    const line = this.lines[this.y];
    const blank = this.blankLine(this.style)[0];
    const [from, to] = mode === 1 ? [0, this.x + 1] : mode === 2 ? [0, this.cols] : [this.x, this.cols];
    for (let i = from; i < to; i++) line[i] = blank;
    this.dirty.add(this.y);
  }

  eraseDisplay(mode) {
    if (mode === 3) {
      this.scrollback = [];
      this.pushed.push(null); // the view drops its scrollback too
      return;
    }
    const [from, to] = mode === 1 ? [0, this.y] : mode === 2 ? [0, this.rows] : [this.y + 1, this.rows];
    if (mode === 0) this.eraseLine(0);
    if (mode === 1) this.eraseLine(1);
    for (let i = from; i < to; i++) {
      this.lines[i] = this.blankLine(this.style);
      this.dirty.add(i);
    }
  }

  deleteChars(n) {
    const line = this.lines[this.y];
    line.splice(this.x, Math.min(n, this.cols - this.x));
    while (line.length < this.cols) line.push(cell(' ', this.style.bg ? { ...BLANK_STYLE, bg: this.style.bg } : BLANK_STYLE));
    this.dirty.add(this.y);
  }

  insertChars(n) {
    const line = this.lines[this.y];
    line.splice(this.x, 0, ...Array.from({ length: Math.min(n, this.cols - this.x) }, () => cell(' ', BLANK_STYLE)));
    line.length = this.cols;
    this.dirty.add(this.y);
  }

  eraseChars(n) {
    const line = this.lines[this.y];
    for (let i = this.x; i < Math.min(this.cols, this.x + n); i++) line[i] = cell(' ', BLANK_STYLE);
    this.dirty.add(this.y);
  }

  saveCursor() {
    this.saved = { x: this.x, y: this.y, style: this.style };
  }

  restoreCursor() {
    this.moveTo(this.saved.x, this.saved.y);
    this.style = this.saved.style;
  }

  resize(cols, rows) {
    if (cols === this.cols && rows === this.rows) return;
    const fit = (line) => (line.length > cols ? line.slice(0, cols) : [...line, ...Array.from({ length: cols - line.length }, () => cell(' ', BLANK_STYLE))]);
    const fitAll = (lines) => {
      let out = lines.map(fit);
      let shift = 0;
      let gone = [];
      if (out.length > rows) {
        // Shrinking: only the lines needed to keep the cursor in view leave through the top.
        shift = Math.max(0, this.y - (rows - 1));
        gone = out.slice(0, shift);
        out = out.slice(shift, shift + rows);
      }
      while (out.length < rows) out.push(Array.from({ length: cols }, () => cell(' ', BLANK_STYLE)));
      return { out, gone, shift };
    };
    this.cols = cols;
    const main = fitAll(this.alt ? this.alt.lines : this.lines);
    if (this.alt) {
      this.alt.lines = main.out;
      this.lines = fitAll(this.lines).out;
    } else {
      this.lines = main.out;
      for (const line of main.gone) {
        this.scrollback.push(line);
        this.pushed.push(line);
      }
      this.y -= main.shift;
    }
    this.rows = rows;
    this.top = 0;
    this.bottom = rows - 1;
    this.x = Math.min(this.x, cols - 1);
    this.y = Math.max(0, Math.min(this.y, rows - 1));
    this.dirty = new Set(Array.from({ length: rows }, (_, i) => i));
  }
}

// ------------------------------------------------------------ drawing

function styleOf(s, cursor) {
  let fg = s.fg;
  let bg = s.bg;
  if (s.inverse !== cursor) [fg, bg] = [bg ?? 'default-bg', fg ?? 'default-fg'];
  const cls = [];
  const css = [];
  const paint = (value, which) => {
    if (value === null || value === undefined) return;
    if (value === 'default-bg') cls.push(`${which}-dbg`);
    else if (value === 'default-fg') cls.push(`${which}-dfg`);
    else if (typeof value === 'number' && value < 16) cls.push(`${which}${s.bold && which === 'fg' && value < 8 ? value + 8 : value}`);
    else css.push(`${which === 'fg' ? 'color' : 'background'}:${typeof value === 'number' ? colour256(value) : value}`);
  };
  paint(fg, 'fg');
  paint(bg, 'bg');
  if (s.bold) cls.push('vt-b');
  if (s.dim) cls.push('vt-dim');
  if (s.italic) cls.push('vt-i');
  if (s.underline) cls.push('vt-u');
  if (s.strike) cls.push('vt-s');
  return { cls: cls.join(' '), css: css.join(';') };
}

/** One line as spans of same-styled text. */
function lineEl(line, cursorAt = -1) {
  const el = h('div', { class: 'vt-row' });
  let run = '';
  let runKey = null;
  let runStyle = null;
  const flush = () => {
    if (!run) return;
    const { cls, css } = runStyle;
    el.append(cls || css ? h('span', { class: cls || null, style: css || null }, run) : document.createTextNode(run));
    run = '';
  };
  line.forEach((c, i) => {
    const st = styleOf(c.s, i === cursorAt);
    const key = `${st.cls}|${st.css}`;
    if (key !== runKey) {
      flush();
      runKey = key;
      runStyle = st;
    }
    run += c.c;
  });
  flush();
  return el;
}

export class Terminal {
  constructor({ reply }) {
    this.screen = new Screen(80, 24, (text) => reply(text));
    this.rowsEl = h('div', { class: 'vt-screen' });
    this.backEl = h('div', { class: 'vt-back' });
    // Writing helpers (Grammarly) hook into every textarea and swallow or rewrite keys: kept out of this one.
    this.input = h('textarea', { class: 'vt-input', ariaLabel: 'Terminal input', autocapitalize: 'off', autocomplete: 'off', 'data-gramm': 'false', 'data-gramm_editor': 'false', 'data-enable-grammarly': 'false' });
    this.input.spellcheck = false;
    this.probe = h('span', { class: 'vt-probe', ariaHidden: 'true' }, 'W'.repeat(50));
    this.el = h('div', { class: 'vt', tabIndex: -1 }, this.backEl, this.rowsEl, this.input, this.probe);
    this.rowEls = [];
    this.queued = false;
    this.focused = false;
    this.input.addEventListener('focus', () => { this.focused = true; this.screen.dirty.add(this.screen.y); this.draw(); });
    this.input.addEventListener('blur', () => { this.focused = false; this.screen.dirty.add(this.screen.y); this.draw(); });
  }

  write(data) {
    this.screen.write(data);
    this.draw();
  }

  draw() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.render();
    });
  }

  render() {
    const s = this.screen;
    const atBottom = this.el.scrollTop + this.el.clientHeight >= this.el.scrollHeight - 4;
    for (const line of s.pushed.splice(0)) {
      if (line === null) this.backEl.replaceChildren();
      else this.backEl.append(lineEl(line));
    }
    while (this.backEl.childElementCount > SCROLLBACK) this.backEl.firstElementChild.remove();
    this.backEl.hidden = Boolean(s.alt);
    if (this.rowEls.length !== s.rows) {
      this.rowEls = s.lines.map(() => h('div', { class: 'vt-row' }));
      this.rowsEl.replaceChildren(...this.rowEls);
      s.allDirty();
    }
    for (const i of s.dirty) {
      if (i >= s.rows) continue;
      const showCursor = s.cursorVisible && i === s.y && this.focused;
      const el = lineEl(s.lines[i], showCursor ? s.x : -1);
      this.rowsEl.replaceChild(el, this.rowEls[i]);
      this.rowEls[i] = el;
    }
    s.dirty.clear();
    // Follow the output, unless the user scrolled up to read.
    if (atBottom) this.el.scrollTop = this.el.scrollHeight;
  }

  /** The columns and rows that fit the box it is drawn in. */
  fit() {
    const box = this.el.getBoundingClientRect();
    const glyph = this.probe.getBoundingClientRect();
    const style = getComputedStyle(this.el);
    const charW = glyph.width / 50 || 8;
    const lineH = parseFloat(style.fontSize) * 1.3 || 18; // .vt-row is 1.3em high
    const cols = Math.max(20, Math.floor((box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 12) / charW));
    const rows = Math.max(5, Math.floor((box.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / lineH));
    return { cols, rows };
  }

  resize(cols, rows) {
    this.screen.resize(cols, rows);
    this.render();
  }

  focus() {
    this.input.focus({ preventScroll: true });
  }

  /** What a key press sends to the program, or null to leave it to the browser (or the app). */
  keyData(e) {
    const s = this.screen;
    const mod = e.ctrlKey || e.metaKey;
    if (e.isComposing) return null;
    const app = s.appCursor;
    const arrows = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D' };
    if (arrows[e.key]) {
      const m = (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);
      return m ? `\x1b[1;${m + 1}${arrows[e.key]}` : `\x1b${app ? 'O' : '['}${arrows[e.key]}`;
    }
    const named = {
      Enter: '\r', Backspace: e.ctrlKey ? '\x08' : '\x7f', Tab: e.shiftKey ? '\x1b[Z' : '\t', Escape: '\x1b',
      Home: app ? '\x1bOH' : '\x1b[H', End: app ? '\x1bOF' : '\x1b[F', PageUp: '\x1b[5~', PageDown: '\x1b[6~', Delete: '\x1b[3~', Insert: '\x1b[2~',
      F1: '\x1bOP', F2: '\x1bOQ', F3: '\x1bOR', F4: '\x1bOS', F5: '\x1b[15~', F6: '\x1b[17~', F7: '\x1b[18~', F8: '\x1b[19~', F9: '\x1b[20~', F10: '\x1b[21~', F11: '\x1b[23~', F12: '\x1b[24~',
    };
    if (e.key in named && !(e.key === 'Enter' && mod)) return (e.altKey && e.key.length > 1 && e.key !== 'Escape' ? '\x1b' : '') + named[e.key];
    if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
      const k = e.key.toLowerCase();
      if (k >= 'a' && k <= 'z') return String.fromCharCode(k.charCodeAt(0) - 96);
      const extra = { '[': '\x1b', '\\': '\x1c', ']': '\x1d', '^': '\x1e', _: '\x1f', '@': '\x00', ' ': '\x00', '/': '\x1f', 2: '\x00', 6: '\x1e' };
      if (k in extra) return extra[k];
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.length === 1) return `\x1b${e.key}`;
    return null; // printable text arrives through the input event (IME-safe)
  }

  /** Pasted text, wrapped when the program asked for bracketed paste. Line breaks become Enter. */
  pasteData(text) {
    const body = text.replace(/\r\n?|\n/g, '\r');
    return this.screen.bracketedPaste ? `\x1b[200~${body.replace(/\x1b\[201~/g, '')}\x1b[201~` : body;
  }
}

export { Screen };
