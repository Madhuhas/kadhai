/**
 * A deliberately small syntax highlighter: one regex pass per file, no
 * dependencies, good enough to make code readable. It never changes the text,
 * only wraps runs of it in <span class="tok-…">.
 */
const MAX_CHARS = 150000;

import { escapeHtml } from './util.js';
const words = (list) => `\\b(?:${list.trim().split(/\s+/).join('|')})\\b`;

const STRING = `"(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*'`;
const NUMBER = `\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b`;

// Each family is an ordered list of [token class, pattern]; the first match wins.
const FAMILIES = {
  c: [
    ['com', `\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/`],
    ['str', `${STRING}|\`(?:\\\\.|[^\`\\\\])*\``],
    ['num', NUMBER],
    ['kw', words(`async await break case catch class const continue default delete do else enum export extends finally for from
      function if implements import in instanceof interface let new of package private protected public return static struct
      switch throw try type typeof var void while yield null undefined true false this super func go defer fn impl mut pub use`)],
    ['fn', `\\b[A-Za-z_$][\\w$]*(?=\\()`],
  ],
  py: [
    ['com', `#[^\\n]*`],
    ['str', `"""[\\s\\S]*?"""|'''[\\s\\S]*?'''|${STRING}`],
    ['num', NUMBER],
    ['kw', words(`and as assert async await break class continue def del elif else except finally for from global if import in is
      lambda None nonlocal not or pass raise return True False try while with yield self`)],
    ['fn', `\\b[A-Za-z_]\\w*(?=\\()`],
  ],
  sh: [
    ['com', `#[^\\n]*`],
    ['str', STRING],
    ['num', NUMBER],
    ['kw', words('if then else elif fi for while do done case esac function return in export echo true false null yes no')],
    ['fn', `^[ \\t-]*[\\w.-]+(?=:)`],
  ],
  css: [
    ['com', `\\/\\*[\\s\\S]*?\\*\\/`],
    ['str', STRING],
    ['kw', `@[\\w-]+|[\\w-]+(?=\\s*:[^:])`],
    ['num', `#[0-9a-fA-F]{3,8}\\b|-?\\b\\d+(?:\\.\\d+)?(?:px|em|rem|vh|vw|fr|deg|ms|s|%)?`],
    ['fn', `[.#][A-Za-z_][\\w-]*`],
  ],
  html: [
    ['com', `<!--[\\s\\S]*?-->`],
    ['kw', `<\\/?[A-Za-z][\\w:-]*|\\/?>`],
    ['str', `"[^"]*"|'[^']*'`],
    ['fn', `\\b[\\w:-]+(?==)`],
  ],
  md: [
    ['com', `^\`\`\`[^\\n]*`],
    ['kw', `^#{1,6} [^\\n]*`],
    ['str', `\`[^\`\\n]+\``],
    ['fn', `\\*\\*[^*\\n]+\\*\\*`],
    ['num', `^[ \\t]*(?:[-*+]|\\d+\\.) `],
  ],
};

const EXTENSIONS = {
  c: 'js mjs cjs jsx ts tsx json java c h cpp cs go rs kt swift php',
  py: 'py',
  sh: 'sh bash yml yaml toml env ini rb',
  css: 'css scss less',
  html: 'html htm xml svg vue',
  md: 'md markdown',
};

const familyOf = Object.fromEntries(
  Object.entries(EXTENSIONS).flatMap(([family, list]) => list.split(' ').map((ext) => [ext, family])),
);
const compiled = {};

function matcher(family) {
  compiled[family] ??= {
    classes: FAMILIES[family].map(([cls]) => cls),
    regex: new RegExp(FAMILIES[family].map(([, pattern]) => `(${pattern})`).join('|'), 'gm'),
  };
  return compiled[family];
}

const NAMES = {
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript JSX', ts: 'TypeScript', tsx: 'TypeScript JSX', json: 'JSON',
  java: 'Java', c: 'C', h: 'C', cpp: 'C++', cs: 'C#', go: 'Go', rs: 'Rust', kt: 'Kotlin', swift: 'Swift', php: 'PHP', py: 'Python',
  sh: 'Shell', bash: 'Shell', yml: 'YAML', yaml: 'YAML', toml: 'TOML', env: 'Env', ini: 'INI', rb: 'Ruby', css: 'CSS', scss: 'SCSS',
  less: 'Less', html: 'HTML', htm: 'HTML', xml: 'XML', svg: 'SVG', vue: 'Vue', md: 'Markdown', markdown: 'Markdown', sql: 'SQL', txt: 'Plain text',
};
// How a line is commented out: a prefix, or [open, close] around it. JSON has none.
const COMMENTS = { c: '//', py: '#', sh: '#', css: ['/*', '*/'], html: ['<!--', '-->'], md: ['<!--', '-->'] };

/** The language of a file extension, for the editor: its name and how it comments a line. */
export function languageOf(ext) {
  const family = familyOf[ext];
  return { name: NAMES[ext] ?? (ext ? ext.toUpperCase() : 'Plain text'), comment: ext === 'json' ? null : ext === 'sql' ? '--' : (COMMENTS[family] ?? null) };
}

/** Returns HTML for `code`, highlighted according to the file extension. */
export function highlight(code, ext) {
  const family = familyOf[ext];
  if (!family || code.length > MAX_CHARS) return escapeHtml(code);
  const { classes, regex } = matcher(family);
  regex.lastIndex = 0;
  let html = '';
  let last = 0;
  for (let m = regex.exec(code); m; m = regex.exec(code)) {
    if (!m[0]) {
      regex.lastIndex += 1; // never loop on an empty match
      continue;
    }
    const cls = classes[m.findIndex((group, i) => i > 0 && group !== undefined) - 1];
    html += `${escapeHtml(code.slice(last, m.index))}<span class="tok-${cls}">${escapeHtml(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return html + escapeHtml(code.slice(last));
}

/** Returns HTML for a unified diff: one coloured line per patch line. */
export function renderDiff(patch) {
  return patch
    .split('\n')
    .map((line) => {
      const cls = line.startsWith('@@')
        ? 'hunk'
        : /^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)
          ? 'meta'
          : line.startsWith('+')
            ? 'add'
            : line.startsWith('-')
              ? 'del'
              : '';
      return `<span class="diff-line ${cls}">${escapeHtml(line) || ' '}</span>`;
    })
    .join('');
}
