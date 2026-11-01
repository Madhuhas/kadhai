import zlib from 'node:zlib';

/**
 * Files that are not text - a PDF, a Word, Excel or PowerPoint file, an image - turned into
 * something the crew can read. No model and no dependency: PDFs and Office files are taken
 * apart with zlib, which Node already has. An image (or a scanned page, which is one) cannot
 * be read here: it comes back in `images`, and the orchestrator decides whether a model that
 * can see is asked to write it down.
 *
 * readDocument(name, bytes) -> { format, text, pages?, images: [{ mime, data, page? }], problem? }
 * `problem` says, in words for the user, why nothing (or not everything) could be read.
 */

const MAX_TEXT = 200000; // characters from one file; the prompt keeps far less
const MAX_PAGES = 300;
const MAX_IMAGES = 20; // scanned pages handed on; the flame decides how many are read
const MAX_UNZIPPED = 20 * 1024 * 1024; // all the parts of one Office file together, unpacked
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

const starts = (bytes, sig) => bytes.length >= sig.length && sig.every((b, i) => b === null || bytes[i] === b);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

const IMAGES = [
  { mime: 'image/png', sig: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', sig: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', sig: ascii('GIF8') },
  { mime: 'image/webp', sig: [...ascii('RIFF'), null, null, null, null, ...ascii('WEBP')] },
];

/** Formats known by their first bytes, whatever the file is called. */
export function sniff(bytes) {
  if (starts(bytes, ascii('%PDF-'))) return 'pdf';
  if (starts(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'zip';
  if (starts(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole'; // .doc, .xls, .ppt before 2007
  const image = IMAGES.find((i) => starts(bytes, i.sig));
  return image ? image.mime : null;
}

/** Bytes that are certainly not text, even when no zero byte shows it (a PDF can be all ASCII at the start). */
export const isKnownBinary = (bytes) => sniff(bytes) !== null;

const SPACING_ACCENTS = { '\u00B4': '\u0301', '\u00A8': '\u0308', '\u02C6': '\u0302', '\u02DC': '\u0303', '\u02C7': '\u030C', '\u02DA': '\u030A', '\u00B8': '\u0327' };
const clip = (text) => (text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text);
const tidy = (text) =>
  text
    .replace(/[\uFB00-\uFB06]/g, (c) => c.normalize('NFKC')) // ligatures: the single "fi" character -> "f" and "i"
    // Older TeX fonts print an accent as a character of its own, before its letter: "R(acute)esum(acute)e" -> "Resume" with accented e's.
    .replace(/([\u00B4\u00A8\u02C6\u02DC\u02C7\u02DA\u00B8])\s?([A-Za-z])/g, (_, accent, letter) => (letter + SPACING_ACCENTS[accent]).normalize('NFC'))
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export function readDocument(name, bytes) {
  const kind = sniff(bytes);
  try {
    if (kind === 'pdf') return readPdf(bytes);
    if (kind === 'zip') return readOffice(name, bytes);
    if (kind === 'ole') return { format: 'old Office file', text: '', images: [], problem: 'it is in the old Office format (.doc, .xls or .ppt), which cannot be read here. Save it as .docx, .xlsx, .pptx or PDF and attach that.' };
    if (kind?.startsWith('image/')) {
      if (bytes.length > MAX_IMAGE_BYTES) return { format: 'image', text: '', images: [], problem: 'the image is too large to send to a model' };
      return { format: 'image', text: '', images: [{ mime: kind, data: bytes }] };
    }
    // Text saved as UTF-16 (Notepad's "Unicode") is full of zero bytes, so it looks binary.
    if (starts(bytes, [0xff, 0xfe]) || starts(bytes, [0xfe, 0xff])) {
      const text = new TextDecoder(bytes[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(bytes.subarray(2));
      return { format: 'UTF-16 text', text: clip(text), images: [] };
    }
  } catch (err) {
    return { format: kind === 'pdf' ? 'PDF' : 'document', text: '', images: [], problem: `it could not be taken apart (${err.message})` };
  }
  return { format: 'binary file', text: '', images: [], problem: 'it is not a format that can be read here (text, PDF, Word, Excel, PowerPoint, OpenDocument or an image)' };
}

// ================================================================== PDF

class Name {
  constructor(n) {
    this.n = n;
  }
}
class Ref {
  constructor(r) {
    this.r = r;
  }
}
class Str {
  constructor(s) {
    this.s = s; // the raw bytes, as a latin1 string
  }
}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)));

/** A reader over PDF syntax: objects and content streams share it. `src` is a latin1 string. */
class Lexer {
  constructor(src, pos = 0) {
    this.src = src;
    this.pos = pos;
  }

  skip() {
    const { src } = this;
    while (this.pos < src.length) {
      const c = src.charCodeAt(this.pos);
      if (WS.has(c)) this.pos++;
      else if (c === 0x25) while (this.pos < src.length && src[this.pos] !== '\n' && src[this.pos] !== '\r') this.pos++;
      else break;
    }
  }

  word() {
    const begin = this.pos;
    while (this.pos < this.src.length) {
      const c = this.src.charCodeAt(this.pos);
      if (WS.has(c) || DELIM.has(c)) break;
      this.pos++;
    }
    return this.src.slice(begin, this.pos);
  }

  /** The next value, or an operator word as { op } (content streams), or undefined at the end. */
  next(refs = true) {
    this.skip();
    const { src } = this;
    if (this.pos >= src.length) return undefined;
    const c = src[this.pos];
    if (c === '/') {
      this.pos++;
      return new Name(this.word().replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
    }
    if (c === '(') return new Str(this.literal());
    if (c === '<') {
      if (src[this.pos + 1] === '<') {
        this.pos += 2;
        return this.dict(refs);
      }
      const end = src.indexOf('>', this.pos);
      const hex = src.slice(this.pos + 1, end < 0 ? src.length : end).replace(/[^0-9a-fA-F]/g, '');
      this.pos = end < 0 ? src.length : end + 1;
      return new Str(Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex').toString('latin1'));
    }
    if (c === '[') {
      this.pos++;
      const list = [];
      for (;;) {
        this.skip();
        if (this.pos >= src.length) return list;
        if (src[this.pos] === ']') {
          this.pos++;
          return list;
        }
        const value = this.next(refs);
        if (value === undefined) return list;
        list.push(value);
      }
    }
    if (c === ']' || c === '>' || c === ')' || c === '{' || c === '}') {
      this.pos++;
      return { op: c };
    }
    const w = this.word();
    if (!w) {
      this.pos++;
      return { op: c };
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
      const number = Number(w);
      // "12 0 R" is a reference, only inside objects.
      if (refs && /^\d+$/.test(w)) {
        const m = /^\s+(\d+)\s+R(?![^\s/<>[\]()%])/.exec(src.slice(this.pos, this.pos + 24));
        if (m) {
          this.pos += m[0].length;
          return new Ref(number);
        }
      }
      return number;
    }
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    return { op: w };
  }

  dict(refs) {
    const out = Object.create(null);
    for (;;) {
      this.skip();
      if (this.pos >= this.src.length) return out;
      if (this.src.startsWith('>>', this.pos)) {
        this.pos += 2;
        return out;
      }
      const key = this.next(refs);
      if (!(key instanceof Name)) {
        if (key === undefined) return out;
        continue;
      }
      out[key.n] = this.next(refs);
    }
  }

  literal() {
    const { src } = this;
    let depth = 0;
    let out = '';
    this.pos++;
    while (this.pos < src.length) {
      const c = src[this.pos++];
      if (c === '\\') {
        const e = src[this.pos++];
        const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
        if (e in simple) out += simple[e];
        else if (e === '\r') {
          if (src[this.pos] === '\n') this.pos++;
        } else if (e === '\n') {
          // a line continued
        } else if (/[0-7]/.test(e)) {
          let oct = e;
          while (oct.length < 3 && /[0-7]/.test(src[this.pos])) oct += src[this.pos++];
          out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        } else if (e !== undefined) out += e;
      } else if (c === '(') {
        depth++;
        out += c;
      } else if (c === ')') {
        if (depth === 0) break;
        depth--;
        out += c;
      } else out += c;
    }
    return out;
  }
}

function inflate(data) {
  for (const attempt of [
    () => zlib.inflateSync(data),
    () => zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }),
    () => zlib.inflateRawSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }),
  ]) {
    try {
      return attempt();
    } catch {
      // the next way, then give up
    }
  }
  throw new Error('a compressed part is damaged');
}

function ascii85(data) {
  const src = data.toString('latin1').replace(/\s+/g, '').replace(/^<~/, '').replace(/~>.*$/, '');
  const out = [];
  let group = [];
  const flush = (n) => {
    while (group.length < 5) group.push(84);
    let value = 0;
    for (const d of group) value = value * 85 + d;
    const bytes = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
    out.push(...bytes.slice(0, n));
    group = [];
  };
  for (const ch of src) {
    if (ch === 'z' && !group.length) out.push(0, 0, 0, 0);
    else {
      group.push(ch.charCodeAt(0) - 33);
      if (group.length === 5) flush(4);
    }
  }
  if (group.length) flush(group.length - 1);
  return Buffer.from(out);
}

/** The PNG predictors a stream may name in /DecodeParms (used by some PDF writers on any stream). */
function unpredict(data, parms) {
  const predictor = parms?.Predictor ?? 1;
  if (predictor < 10) return data;
  const colors = parms.Colors ?? 1;
  const bpc = parms.BitsPerComponent ?? 8;
  const columns = parms.Columns ?? 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const row = Math.ceil((colors * bpc * columns) / 8);
  const out = Buffer.alloc(Math.floor(data.length / (row + 1)) * row);
  let prev = Buffer.alloc(row);
  for (let r = 0, i = 0; i + row < data.length + 1 && r * row < out.length; r++) {
    const type = data[i++];
    const line = Buffer.from(data.subarray(i, i + row));
    i += row;
    for (let x = 0; x < row; x++) {
      const left = x >= bpp ? line[x - bpp] : 0;
      const up = prev[x];
      const ul = x >= bpp ? prev[x - bpp] : 0;
      if (type === 1) line[x] = (line[x] + left) & 255;
      else if (type === 2) line[x] = (line[x] + up) & 255;
      else if (type === 3) line[x] = (line[x] + ((left + up) >> 1)) & 255;
      else if (type === 4) {
        const p = left + up - ul;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - ul);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul)) & 255;
      }
    }
    line.copy(out, r * row);
    prev = line;
  }
  return out;
}

// What the 1-byte codes of a simple font mean when it says nothing else.
const WIN_ANSI = new TextDecoder('windows-1252');
const winAnsi = (code) => WIN_ANSI.decode(Uint8Array.of(code));

// Glyph names that appear in /Differences: letters and digits are their own; these are the rest that matter for prose.
const GLYPHS = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'",
  parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-', period: '.', slash: '/',
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[',
  backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|',
  braceright: '}', asciitilde: '~', quoteleft: '\u2018', quoteright: '\u2019', quotedblleft: '\u201C',
  quotedblright: '\u201D', quotesinglbase: '\u201A', quotedblbase: '\u201E', bullet: '\u2022', endash: '\u2013',
  emdash: '\u2014', ellipsis: '\u2026', fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl', copyright: '\u00A9',
  registered: '\u00AE', trademark: '\u2122', degree: '\u00B0', minus: '\u2212', multiply: '\u00D7', divide: '\u00F7',
  Euro: '\u20AC', sterling: '\u00A3', yen: '\u00A5', cent: '\u00A2', section: '\u00A7', paragraph: '\u00B6',
  periodcentered: '\u00B7', dagger: '\u2020', daggerdbl: '\u2021', nbspace: ' ', uni00A0: ' ', middot: '\u00B7',
  // Accents on their own (TeX prints them before the letter; tidy() joins them).
  acute: '\u00B4', dieresis: '\u00A8', circumflex: '\u02C6', tilde: '\u02DC', caron: '\u02C7', ring: '\u02DA', cedilla: '\u00B8',
};
const ACCENTS = { acute: '\u0301', grave: '\u0300', circumflex: '\u0302', dieresis: '\u0308', tilde: '\u0303', ring: '\u030A', cedilla: '\u0327', caron: '\u030C' };

function glyphToText(name) {
  if (name in GLYPHS) return GLYPHS[name];
  if (/^[A-Za-z]$/.test(name)) return name;
  let m = /^uni((?:[0-9A-Fa-f]{4})+)$/.exec(name);
  if (m) return String.fromCharCode(...m[1].match(/.{4}/g).map((h) => parseInt(h, 16)));
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  m = /^([A-Za-z])(acute|grave|circumflex|dieresis|tilde|ring|cedilla|caron)$/.exec(name);
  if (m) return (m[1] + ACCENTS[m[2]]).normalize('NFC');
  m = /^([A-Za-z]+)\.[\w.]+$/.exec(name); // "a.sc", "one.oldstyle"
  if (m) return glyphToText(m[1]);
  return '';
}

/** UTF-16BE bytes (as latin1) to text. */
function utf16(s) {
  let out = '';
  for (let i = 0; i + 1 < s.length; i += 2) out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
  return out;
}

/** A /ToUnicode CMap: which bytes stand for which text, and how many bytes a code takes. */
function parseCMap(src) {
  const map = new Map();
  const lengths = new Set();
  const hexes = (block) => [...block.matchAll(/<([0-9a-fA-F]*)>|\[([^\]]*)\]/g)];
  const bytesOf = (hex) => Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex').toString('latin1');
  for (const [, block] of src.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<[0-9a-fA-F]+>/g)) lengths.add(Math.ceil(m[1].length / 2));
  }
  for (const [, block] of src.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    const items = hexes(block);
    for (let i = 0; i + 1 < items.length; i += 2) {
      const code = items[i][1];
      if (code === undefined || items[i + 1][1] === undefined) continue;
      map.set(parseInt(code || '0', 16), utf16(bytesOf(items[i + 1][1])));
      lengths.add(Math.ceil(code.length / 2) || 1);
    }
  }
  for (const [, block] of src.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const items = hexes(block);
    for (let i = 0; i + 2 < items.length; i += 3) {
      const lo = parseInt(items[i][1] || '0', 16);
      const hi = parseInt(items[i + 1][1] || '0', 16);
      if (hi - lo > 65535 || hi < lo) continue;
      lengths.add(Math.ceil((items[i][1] ?? '').length / 2) || 1);
      if (items[i + 2][2] !== undefined) {
        const list = [...items[i + 2][2].matchAll(/<([0-9a-fA-F]*)>/g)];
        list.forEach((m, k) => map.set(lo + k, utf16(bytesOf(m[1]))));
      } else {
        const base = utf16(bytesOf(items[i + 2][1] ?? ''));
        if (!base) continue;
        const last = base.charCodeAt(base.length - 1);
        for (let code = lo; code <= hi; code++) map.set(code, base.slice(0, -1) + String.fromCharCode(last + (code - lo)));
      }
    }
  }
  return { map, length: lengths.size === 1 ? [...lengths][0] : lengths.has(2) && !lengths.has(1) ? 2 : null };
}

const multiply = (m, n) => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];
const IDENTITY = [1, 0, 0, 1, 0, 0];

class Pdf {
  constructor(bytes) {
    this.bytes = bytes;
    this.src = bytes.toString('latin1');
    this.objects = new Map(); // number -> { text, value?, stream? }
    this.fonts = new Map();
    this.missingMaps = false;
    this.#index();
  }

  #index() {
    const { src } = this;
    const header = /(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = header.exec(src))) {
      const start = header.lastIndex;
      const endObj = src.indexOf('endobj', start);
      const streamAt = src.indexOf('stream', start);
      const entry = { start };
      if (streamAt >= 0 && (endObj < 0 || streamAt < endObj) && src.slice(start, streamAt).includes('<<')) {
        entry.text = src.slice(start, streamAt);
        let data = streamAt + 6;
        if (src[data] === '\r') data++;
        if (src[data] === '\n') data++;
        const finish = src.indexOf('endstream', data);
        const end = finish < 0 ? src.length : finish;
        entry.data = [data, end];
        header.lastIndex = end;
      } else entry.text = src.slice(start, endObj < 0 ? src.length : endObj);
      this.objects.set(Number(m[1]), entry); // a later version of an object (an incremental save) replaces the earlier
    }
    // PDF 1.5 and later keep most small objects packed inside object streams.
    for (const entry of [...this.objects.values()]) {
      if (!entry.data || !/\/Type\s*\/ObjStm/.test(entry.text)) continue;
      try {
        const dict = this.value(entry);
        const body = this.decode(entry, dict).toString('latin1');
        const first = dict.First ?? 0;
        const head = body.slice(0, first).trim().split(/\s+/).map(Number);
        for (let i = 0; i + 1 < head.length; i += 2) {
          const num = head[i];
          if (this.objects.has(num) && !this.objects.get(num).packed) continue;
          const from = first + head[i + 1];
          const to = i + 3 < head.length ? first + head[i + 3] : body.length;
          this.objects.set(num, { text: body.slice(from, to), packed: true });
        }
      } catch {
        // one damaged object stream: the rest of the file may still read
      }
    }
  }

  value(entry) {
    if (entry.value === undefined) entry.value = new Lexer(entry.text).next() ?? null;
    return entry.value;
  }

  get(v, depth = 0) {
    if (v instanceof Ref) {
      const entry = this.objects.get(v.r);
      if (!entry || depth > 20) return null;
      return this.get(this.value(entry), depth + 1);
    }
    return v;
  }

  streamOf(v) {
    if (!(v instanceof Ref)) return null;
    const entry = this.objects.get(v.r);
    return entry?.data ? entry : null;
  }

  raw(entry, dict = this.value(entry)) {
    let [from, to] = entry.data;
    const length = this.get(dict?.Length);
    if (Number.isInteger(length) && length >= 0 && from + length <= this.bytes.length) to = Math.min(to, from + length);
    return this.bytes.subarray(from, to);
  }

  filters(dict) {
    const f = this.get(dict?.Filter);
    const list = (Array.isArray(f) ? f : f ? [f] : []).map((x) => this.get(x)?.n ?? '');
    const p = this.get(dict?.DecodeParms);
    const parms = Array.isArray(p) ? p.map((x) => this.get(x)) : list.map(() => p);
    return { list, parms };
  }

  decode(entry, dict = this.value(entry), { stopAt = null } = {}) {
    let data = this.raw(entry, dict);
    const { list, parms } = this.filters(dict);
    for (const [i, name] of list.entries()) {
      if (stopAt?.includes(name)) return data;
      if (name === 'FlateDecode' || name === 'Fl') data = unpredict(inflate(data), this.get(parms[i]));
      else if (name === 'ASCIIHexDecode' || name === 'AHx') data = Buffer.from(data.toString('latin1').replace(/>.*$/s, '').replace(/[^0-9a-fA-F]/g, ''), 'hex');
      else if (name === 'ASCII85Decode' || name === 'A85') data = ascii85(data);
      else throw new Error(`the ${name} format inside it is not supported`);
    }
    return data;
  }

  trailer() {
    const at = this.src.lastIndexOf('trailer');
    if (at >= 0) {
      const dict = new Lexer(this.src, at + 7).next();
      if (dict && typeof dict === 'object' && dict.Root) return dict;
    }
    // A cross-reference stream carries the trailer's keys in its own dictionary.
    for (const entry of [...this.objects.values()].reverse()) {
      if (/\/Type\s*\/XRef/.test(entry.text)) return this.value(entry);
    }
    return null;
  }

  pages() {
    const trailer = this.trailer();
    const root = this.get(trailer?.Root);
    const out = [];
    const seen = new Set();
    const walk = (node, inherited, depth) => {
      if (!node || depth > 30 || out.length >= MAX_PAGES || seen.has(node)) return;
      seen.add(node);
      const resources = node.Resources !== undefined ? node.Resources : inherited;
      const kids = this.get(node.Kids);
      if (Array.isArray(kids)) for (const kid of kids) walk(this.get(kid), resources, depth + 1);
      else if (node.Contents !== undefined || this.get(node.Type)?.n === 'Page') out.push({ node, resources });
    };
    walk(this.get(root?.Pages), undefined, 0);
    if (out.length) return out;
    // No usable page tree: every page object, in file order.
    for (const entry of this.objects.values()) {
      if (/\/Type\s*\/Page(?![s\w])/.test(entry.text)) {
        const node = this.value(entry);
        out.push({ node, resources: node?.Resources });
      }
    }
    return out.slice(0, MAX_PAGES);
  }

  font(ref) {
    const key = ref instanceof Ref ? ref.r : ref;
    if (this.fonts.has(key)) return this.fonts.get(key);
    const dict = this.get(ref) ?? {};
    const font = { twoByte: false, map: null, codes: new Map(), widths: new Map(), defaultWidth: 500 };
    const subtype = this.get(dict.Subtype)?.n;
    font.twoByte = subtype === 'Type0';
    const toUnicode = this.streamOf(dict.ToUnicode);
    if (toUnicode) {
      try {
        const cmap = parseCMap(this.decode(toUnicode).toString('latin1'));
        font.map = cmap.map;
        if (cmap.length === 1) font.twoByte = false;
        if (cmap.length === 2) font.twoByte = true;
      } catch {
        // fall back on the encoding below
      }
    }
    if (subtype === 'Type0') {
      const descendant = this.get(this.get(dict.DescendantFonts)?.[0]) ?? {};
      font.defaultWidth = this.get(descendant.DW) ?? 1000;
      const w = this.get(descendant.W);
      if (Array.isArray(w)) {
        for (let i = 0; i < w.length; ) {
          const first = this.get(w[i]);
          const next = this.get(w[i + 1]);
          if (Array.isArray(next)) {
            next.forEach((width, k) => font.widths.set(first + k, this.get(width)));
            i += 2;
          } else {
            const width = this.get(w[i + 2]);
            for (let c = first; c <= next && c - first < 65536; c++) font.widths.set(c, width);
            i += 3;
          }
        }
      }
      if (!font.map) this.missingMaps = true; // CIDs with no map to text: nothing honest to print
    } else {
      const firstChar = this.get(dict.FirstChar) ?? 0;
      const widths = this.get(dict.Widths);
      if (Array.isArray(widths)) widths.forEach((width, i) => font.widths.set(firstChar + i, this.get(width)));
      const encoding = this.get(dict.Encoding);
      const differences = this.get(encoding?.Differences);
      if (Array.isArray(differences)) {
        let code = 0;
        for (const item of differences) {
          const v = this.get(item);
          if (typeof v === 'number') code = v;
          else if (v instanceof Name) font.codes.set(code++, glyphToText(v.n));
        }
      }
    }
    this.fonts.set(key, font);
    return font;
  }
}

/** The text a string shows in a font, and how far it moves along the line (in thousandths of the font size). */
function show(font, s) {
  let text = '';
  let advance = 0;
  let spaces = 0;
  const step = font.twoByte ? 2 : 1;
  for (let i = 0; i + step <= s.length; i += step) {
    const code = step === 2 ? (s.charCodeAt(i) << 8) | s.charCodeAt(i + 1) : s.charCodeAt(i);
    let piece = font.map?.get(code);
    if (piece === undefined) piece = font.codes.get(code);
    if (piece === undefined) piece = font.twoByte ? '' : winAnsi(code);
    if (piece === ' ') spaces++;
    text += piece.replace(/[\u0000-\u0008\u000B-\u001F]/g, '');
    advance += font.widths.get(code) ?? font.defaultWidth;
  }
  return { text, advance, spaces };
}

function pageText(pdf, page, images) {
  const lines = [];
  let line = '';
  let last = null; // where the previous piece of text ended, on the page
  const emit = (text, at, size) => {
    if (!text) return;
    if (last) {
      const dy = Math.abs(at.y - last.y);
      const tolerance = Math.max(1, Math.min(size, last.size) * 0.5);
      if (dy > tolerance) {
        lines.push(line);
        if (dy > Math.max(size, last.size) * 2.2) lines.push('');
        line = '';
      } else {
        const gap = at.x - last.x;
        // A gap on the line, or a jump back to the left (another column at the same height), is a space.
        const apart = gap > Math.min(size, last.size) * 0.18 || gap < -Math.max(size, last.size);
        if (apart && !/\s$/.test(line) && !/^\s/.test(text)) line += ' ';
      }
    }
    line += text;
  };

  const run = (content, resources, ctm0, depth) => {
    if (depth > 6) return;
    const res = pdf.get(resources) ?? {};
    const fonts = pdf.get(res.Font) ?? {};
    const xobjects = pdf.get(res.XObject) ?? {};
    const lex = new Lexer(content);
    const stack = [];
    let ctm = ctm0;
    let tm = IDENTITY;
    let lm = IDENTITY;
    let font = null;
    let size = 12;
    let leading = 0;
    let charSpace = 0;
    let wordSpace = 0;
    let scale = 1;
    let operands = [];

    const at = () => {
      const m = multiply(tm, ctm);
      return { x: m[4], y: m[5], scale: Math.hypot(m[2], m[3]) || 1 };
    };
    const move = (tx, ty) => {
      lm = multiply([1, 0, 0, 1, tx, ty], lm);
      tm = lm;
    };
    const draw = (s) => {
      if (!font) return;
      const { text, advance, spaces } = show(font, s);
      const here = at();
      emit(text, here, size * here.scale);
      const width = ((advance / 1000) * size + charSpace * (font.twoByte ? s.length / 2 : s.length) + wordSpace * spaces) * scale;
      tm = multiply([1, 0, 0, 1, width, 0], tm);
      // A glyph that prints nothing (a bullet with no map to text) must not move the line: the next text decides.
      if (!text) return;
      const end = at();
      last = { x: end.x, y: end.y, size: size * end.scale };
    };

    for (let token = lex.next(false); token !== undefined; token = lex.next(false)) {
      if (!token || typeof token !== 'object' || !('op' in token)) {
        operands.push(token);
        continue;
      }
      const o = operands;
      operands = [];
      switch (token.op) {
        case 'q':
          stack.push(ctm);
          break;
        case 'Q':
          ctm = stack.pop() ?? ctm0;
          break;
        case 'cm':
          if (o.length === 6) ctm = multiply(o, ctm);
          break;
        case 'BT':
          tm = lm = IDENTITY;
          break;
        case 'Tf':
          font = o[0] instanceof Name ? pdf.font(fonts[o[0].n]) : null;
          size = typeof o[1] === 'number' ? Math.abs(o[1]) || 1 : size;
          break;
        case 'Tc':
          charSpace = o[0] ?? 0;
          break;
        case 'Tw':
          wordSpace = o[0] ?? 0;
          break;
        case 'Tz':
          scale = (o[0] ?? 100) / 100;
          break;
        case 'TL':
          leading = o[0] ?? 0;
          break;
        case 'Td':
          move(o[0] ?? 0, o[1] ?? 0);
          break;
        case 'TD':
          leading = -(o[1] ?? 0);
          move(o[0] ?? 0, o[1] ?? 0);
          break;
        case 'Tm':
          if (o.length === 6) tm = lm = o;
          break;
        case 'T*':
          move(0, -leading);
          break;
        case 'Tj':
          if (o[0] instanceof Str) draw(o[0].s);
          break;
        case "'":
          move(0, -leading);
          if (o[0] instanceof Str) draw(o[0].s);
          break;
        case '"':
          wordSpace = o[0] ?? wordSpace;
          charSpace = o[1] ?? charSpace;
          move(0, -leading);
          if (o[2] instanceof Str) draw(o[2].s);
          break;
        case 'TJ':
          for (const item of Array.isArray(o[0]) ? o[0] : []) {
            if (item instanceof Str) draw(item.s);
            else if (typeof item === 'number') {
              tm = multiply([1, 0, 0, 1, (-item / 1000) * size * scale, 0], tm);
              // A big gap inside one TJ is a space the writer did not print.
              if (item < -180 && line && !/\s$/.test(line)) line += ' ';
              const end = at();
              if (last) last = { ...last, x: end.x };
            }
          }
          break;
        case 'Do': {
          const name = o[0] instanceof Name ? o[0].n : null;
          const entry = name && pdf.streamOf(xobjects[name]);
          if (!entry) break;
          const dict = pdf.value(entry);
          const subtype = pdf.get(dict?.Subtype)?.n;
          if (subtype === 'Form') {
            try {
              const matrix = pdf.get(dict.Matrix);
              run(pdf.decode(entry, dict).toString('latin1'), dict.Resources ?? resources, Array.isArray(matrix) && matrix.length === 6 ? multiply(matrix, ctm) : ctm, depth + 1);
            } catch {
              // an unreadable form: skip it
            }
          } else if (subtype === 'Image' && images) images.push({ entry, dict, area: Math.abs(ctm[0] * ctm[3]) });
          break;
        }
        case 'BI': {
          // An inline image: skip its bytes, which can hold anything.
          const end = content.indexOf('EI', lex.pos);
          const data = content.indexOf('ID', lex.pos);
          if (data >= 0) {
            const finish = /\sEI(?=[\s]|$)/g;
            finish.lastIndex = data + 3;
            const m = finish.exec(content);
            lex.pos = m ? m.index + m[0].length : end < 0 ? content.length : end + 2;
          }
          break;
        }
        default:
      }
    }
  };

  const contents = pdf.get(page.node.Contents);
  const parts = (Array.isArray(contents) ? contents : [page.node.Contents]).map((c) => pdf.streamOf(c)).filter(Boolean);
  const content = parts
    .map((entry) => {
      try {
        return pdf.decode(entry).toString('latin1');
      } catch {
        return '';
      }
    })
    .join('\n');
  run(content, page.resources, IDENTITY, 0);
  lines.push(line);
  return lines.join('\n');
}

/** A PNG file of raw image samples (8-bit grey or RGB), built with zlib. */
function png(width, height, channels, samples) {
  const crcTable = png.table ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const row = width * channels;
  const raw = Buffer.alloc((row + 1) * height);
  for (let y = 0; y < height; y++) samples.copy(raw, y * (row + 1) + 1, y * row, (y + 1) * row);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 3 ? 2 : 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Grey (1) or colour (3) samples, or 0 for what a PNG cannot hold as it is. Browsers and scanner apps
 * name an embedded colour profile (Edge: [/ICCBased 5 0 R]) rather than DeviceRGB: its /N says which.
 */
function colorChannels(pdf, value) {
  const space = pdf.get(value);
  const name = space instanceof Name ? space.n : Array.isArray(space) ? pdf.get(space[0])?.n : null;
  if (name === 'DeviceRGB' || name === 'CalRGB') return 3;
  if (name === 'DeviceGray' || name === 'CalGray') return 1;
  if (name === 'ICCBased') {
    const profile = pdf.streamOf(space[1]);
    const n = profile ? pdf.get(pdf.value(profile)?.N) : 0;
    return n === 1 || n === 3 ? n : 0;
  }
  return 0;
}

/** A scanned page's picture, as a file a model can look at, or null when its format cannot be handed on. */
function pageImage(pdf, { entry, dict }) {
  const { list } = pdf.filters(dict);
  if (list.at(-1) === 'DCTDecode' || list.at(-1) === 'DCT') {
    const jpeg = pdf.decode(entry, dict, { stopAt: ['DCTDecode', 'DCT'] });
    return jpeg.length <= MAX_IMAGE_BYTES ? { mime: 'image/jpeg', data: Buffer.from(jpeg) } : null;
  }
  const width = pdf.get(dict.Width);
  const height = pdf.get(dict.Height);
  const channels = colorChannels(pdf, dict.ColorSpace);
  if (!channels || pdf.get(dict.BitsPerComponent) !== 8 || !(width > 0 && height > 0) || width * height * channels > 40e6) return null;
  const samples = pdf.decode(entry, dict);
  if (samples.length < width * height * channels) return null;
  const file = png(width, height, channels, samples);
  return file.length <= MAX_IMAGE_BYTES ? { mime: 'image/png', data: file } : null;
}

export function readPdf(bytes) {
  const pdf = new Pdf(bytes);
  const trailer = pdf.trailer();
  if (trailer?.Encrypt !== undefined) {
    return { format: 'PDF', text: '', images: [], problem: 'the PDF is protected (encrypted), so its text cannot be read. Open it and print it to a new PDF, or paste the text into the chat.' };
  }
  const pages = pdf.pages();
  const out = [];
  const images = [];
  let total = 0;
  for (const [i, page] of pages.entries()) {
    const found = [];
    let text = '';
    try {
      text = tidy(pageText(pdf, page, found));
    } catch {
      text = '';
    }
    // A page with (almost) no text but a picture is a scan: hand on its biggest picture.
    if (text.replace(/\s/g, '').length < 20 && found.length && images.length < MAX_IMAGES) {
      const biggest = found.sort((a, b) => b.area - a.area)[0];
      try {
        const image = pageImage(pdf, biggest);
        if (image) images.push({ ...image, page: i + 1 });
      } catch {
        // a picture in a format that cannot be handed on
      }
    }
    if (text) out.push(pages.length > 1 ? `--- page ${i + 1} ---\n${text}` : text);
    total += text.length;
    if (total > MAX_TEXT) break;
  }
  const text = clip(out.join('\n\n'));
  const result = { format: 'PDF', text, pages: pages.length, images };
  if (!text && !images.length) {
    result.problem = pdf.missingMaps
      ? 'the PDF draws its text with fonts that carry no map back to letters, so the text cannot be read. Paste the text into the chat instead.'
      : pages.length
        ? 'no text was found in the PDF (a scan, or text drawn as shapes), and its pages are not pictures that can be handed on. Paste the text into the chat instead.'
        : 'no pages were found in the PDF; it may be damaged.';
  }
  return result;
}

// ================================================================== Office (zip of XML)

/** The parts of a zip file whose names pass `wanted`, unpacked. Stored and deflated entries only; capped in size. */
export function unzip(bytes, wanted) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a complete zip file');
  const count = bytes.readUInt16LE(eocd + 10);
  let at = bytes.readUInt32LE(eocd + 16);
  const out = new Map();
  let budget = MAX_UNZIPPED;
  for (let n = 0; n < count && at + 46 <= bytes.length; n++) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) break;
    const method = bytes.readUInt16LE(at + 10);
    const size = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extra = bytes.readUInt16LE(at + 30);
    const comment = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extra + comment;
    if (!wanted(name) || local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + size);
    let part;
    if (method === 0) part = data;
    else if (method === 8) part = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, budget) });
    else continue;
    budget -= part.length;
    if (budget < 0) throw new Error('it unpacks to more than 20 MB');
    out.set(name, part);
  }
  return out;
}

const entities = (s) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (all, e) =>
    e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'amp' ? '&' : e === 'quot' ? '"' : e === 'apos' ? "'" : e[1] === 'x' ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(Number(e.slice(1))),
  );

/** The text of a WordprocessingML, DrawingML or OpenDocument part: paragraphs on their own lines. */
function xmlText(xml, { text, paragraph, tab = [], breaks = [] }) {
  const pattern = new RegExp(`<(${text})(?:\\s[^>]*)?>([^<]*)</\\1>|<(?:${[...tab, ...breaks].join('|') || '_'})(?:\\s[^>]*)?/>|</(?:${paragraph})>`, 'g');
  let out = '';
  for (const m of xml.matchAll(pattern)) {
    if (m[1]) out += entities(m[2]);
    else if (tab.some((t) => m[0].startsWith(`<${t}`))) out += '\t';
    else out += '\n';
  }
  return out;
}

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Each table row as one paragraph of its own, cells split by tabs - otherwise every cell's paragraph
 * lands on a line of its own and the rows are lost. `read` turns a cell's XML into text, `paragraph`
 * wraps the row's text back into the format's own paragraph, for the reading that follows.
 */
const flattenTables = (xml, { row, cell, read, paragraph }) =>
  xml.replace(new RegExp(`<${row}\\b[^>]*>([\\s\\S]*?)</${row}>`, 'g'), (_, inner) => {
    const cells = [...inner.matchAll(new RegExp(`<${cell}\\b[^>]*?(?:/>|>([\\s\\S]*?)</${cell}>)`, 'g'))].map((m) => read(m[1] ?? '').replace(/\s*\n\s*/g, ' ').trim());
    return paragraph(escapeXml(cells.join('\t').replace(/\t+$/, '')));
  });

const byNumber = (prefix) => (a, b) => Number(a.slice(prefix.length).match(/\d+/)?.[0] ?? 0) - Number(b.slice(prefix.length).match(/\d+/)?.[0] ?? 0);

function readOffice(name, bytes) {
  const parts = unzip(bytes, (n) => /^(word\/(document|header\d*|footer\d*|footnotes)\.xml|xl\/(workbook\.xml|sharedStrings\.xml|worksheets\/sheet\d+\.xml|_rels\/workbook\.xml\.rels)|ppt\/slides\/slide\d+\.xml|content\.xml|mimetype)$/.test(n));
  const str = (n) => parts.get(n)?.toString('utf8') ?? '';

  if (parts.has('word/document.xml')) {
    // <w:tabs> only defines tab stops: its <w:tab .../> entries are not tabs in the text.
    const runs = (xml) => xmlText(xml.replace(/<w:tabs>[\s\S]*?<\/w:tabs>/g, ''), { text: 'w:t', paragraph: 'w:p', tab: ['w:tab'], breaks: ['w:br', 'w:cr'] });
    const word = (xml) => runs(flattenTables(xml, { row: 'w:tr', cell: 'w:tc', read: runs, paragraph: (t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>` }));
    const names = [...parts.keys()];
    const headers = names.filter((n) => /^word\/header/.test(n)).sort().map((n) => word(str(n)));
    const footers = names.filter((n) => /^word\/(footer|footnotes)/.test(n)).sort().map((n) => word(str(n)));
    const text = tidy([...headers, word(str('word/document.xml')), ...footers].map((part) => part.replace(/\n+$/, '')).filter(Boolean).join('\n'));
    return withProblem({ format: 'Word document', text: clip(text), images: [] });
  }

  if (parts.has('xl/workbook.xml')) {
    const shared = [...str('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => [...m[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => entities(t[1])).join(''));
    const rels = Object.fromEntries([...str('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [/Id="([^"]+)"/.exec(m[0])?.[1], /Target="([^"]+)"/.exec(m[0])?.[1]]));
    const sheets = [...str('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: entities(/name="([^"]*)"/.exec(m[0])?.[1] ?? 'Sheet'), rel: /r:id="([^"]+)"/.exec(m[0])?.[1] }));
    const files = [...parts.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(byNumber('xl/worksheets/sheet'));
    const blocks = [];
    let rows = 0;
    files.forEach((file, i) => {
      const sheet = sheets.find((s) => rels[s.rel] && file.endsWith(rels[s.rel].replace(/^\/?(xl\/)?/, ''))) ?? sheets[i] ?? { name: `Sheet ${i + 1}` };
      const lines = [];
      for (const row of str(file).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        if (rows++ > 5000) break;
        const cells = [];
        for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const ref = /r="([A-Z]+)\d+"/.exec(c[1])?.[1];
          const col = ref ? [...ref].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : cells.length;
          const type = /t="([^"]+)"/.exec(c[1])?.[1];
          const v = /<v>([^<]*)<\/v>/.exec(c[2] ?? '')?.[1];
          let value = '';
          if (type === 's') value = shared[Number(v)] ?? '';
          else if (type === 'inlineStr') value = [...(c[2] ?? '').matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => entities(t[1])).join('');
          else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
          else value = entities(v ?? '');
          while (cells.length < col && col < 200) cells.push('');
          cells.push(value.replace(/[\t\n]+/g, ' '));
        }
        if (cells.some(Boolean)) lines.push(cells.join('\t').replace(/\t+$/, ''));
      }
      blocks.push(`--- sheet: ${sheet.name} ---\n${lines.join('\n')}`);
    });
    return withProblem({ format: 'Excel workbook', text: clip(blocks.join('\n\n').trim()), images: [] });
  }

  const slides = [...parts.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNumber('ppt/slides/slide'));
  if (slides.length) {
    const runs = (xml) => xmlText(xml, { text: 'a:t', paragraph: 'a:p', breaks: ['a:br'] });
    const slide = (xml) => runs(flattenTables(xml, { row: 'a:tr', cell: 'a:tc', read: runs, paragraph: (t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>` }));
    const text = slides.map((n, i) => `--- slide ${i + 1} ---\n${tidy(slide(str(n)))}`).join('\n\n');
    return withProblem({ format: 'PowerPoint deck', text: clip(text), images: [], pages: slides.length });
  }

  if (parts.has('content.xml')) {
    const kind = str('mimetype');
    const format = /spreadsheet/.test(kind) ? 'OpenDocument spreadsheet' : /presentation/.test(kind) ? 'OpenDocument presentation' : 'OpenDocument text';
    // Indentation between elements is not text; <text:s/> is a real space.
    const xml = str('content.xml').replace(/>\s*\n\s*</g, '><').replace(/<text:s(?:\s[^>]*)?\/>/g, ' ');
    const plain = (part) => entities(part.replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>|<\/text:p>|<\/text:h>/g, '\n').replace(/<[^>]+>/g, ''));
    const flat = flattenTables(xml, { row: 'table:table-row', cell: 'table:table-cell', read: plain, paragraph: (t) => `<text:p>${t}</text:p>` });
    const text = tidy(plain(flat));
    return withProblem({ format, text: clip(text), images: [] });
  }

  return { format: 'zip file', text: '', images: [], problem: `${/\.zip$/i.test(name) ? 'it is a zip archive' : 'it is a zip-based file that is not a Word, Excel, PowerPoint or OpenDocument file'}, which cannot be read here. Unpack it into the folder instead.` };
}

const withProblem = (result) => (result.text ? result : { ...result, problem: `the ${result.format} has no text in it` });
