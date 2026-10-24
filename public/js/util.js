export const $ = (selector, root = document) => root.querySelector(selector);

/** Tiny hyperscript helper: h('div', { class: 'x', onclick }, child, ...). Text is always set safely. */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value);
  }
  el.append(...children.flat().filter((child) => child != null && child !== false));
  return el;
}

export const fmtNum = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Text made safe to put inside HTML (and inside a quoted attribute). The only escape the page uses. */
export const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Escape first, then allow just **bold**, `code` and line breaks. */
export const mdLite = (text) =>
  escapeHtml(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/\n/g, '<br>');

export function toast(message, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, message);
  // An open modal dialog covers the page, so the toasts have to live inside it to be seen.
  const host = $('#toasts');
  (document.querySelector('dialog[open]') ?? document.body).append(host);
  host.append(el);
  setTimeout(() => el.remove(), 4500);
}

/** localStorage that never throws (private windows, blocked storage). */
export const prefs = {
  get(key, fallback = null) {
    try {
      return localStorage.getItem(`kadhai.${key}`) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(`kadhai.${key}`);
      else localStorage.setItem(`kadhai.${key}`, value);
    } catch {
      // Preferences are a convenience, not a requirement.
    }
  },
};
