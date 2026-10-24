/**
 * The data that travels along a flow's wires, and the {{ expressions }} that read it.
 *
 * A node's output is any JSON value: text, a number, an object, a list. A
 * setting may quote it with an expression:
 *
 *   {{ input }}                     what arrived on the wire (all of it)
 *   {{ input.title }}               one field of it
 *   {{ input.items[0].url }}        a field of the first entry of a list
 *   {{ trigger.text }}              what started the flow
 *   {{ node('Fetch issues').body }} the output of another node, by its name (or id)
 *   {{ now }} / {{ today }}         the time the expression is read, as ISO text
 *
 * An expression is a path, never code: there is nothing to call and nothing to
 * evaluate, so text from outside that ends up in a setting stays text.
 */

const EXPR = /\{\{\s*([^{}]*?)\s*\}\}/g;
const ONE = /^\s*\{\{\s*([^{}]*?)\s*\}\}\s*$/;
const ROOT = /^(input|previous|trigger|now|today|node\(\s*(?:'([^']{1,60})'|"([^"]{1,60})")\s*\))/;
const STEP = /^(?:\.([A-Za-z_$][\w$-]*)|\[\s*(\d{1,6})\s*\]|\[\s*(?:'([^']{1,80})'|"([^"]{1,80})")\s*\])/;
const MISSING = Symbol('missing');

/** A value as text: text as it is, nothing as '', anything else as JSON. */
export function toText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Text that looks like JSON becomes the value it spells; anything else stays text. */
export function parseMaybe(text) {
  if (typeof text !== 'string') return text;
  const t = text.trim();
  if (!/^[[{]/.test(t)) return text;
  try {
    return JSON.parse(t);
  } catch {
    return text;
  }
}

/** Read one expression. MISSING when it is not one this module understands. */
function read(expr, ctx) {
  const root = ROOT.exec(expr);
  if (!root) return MISSING;
  let value;
  const name = root[2] ?? root[3];
  if (name != null) value = ctx.node?.(name);
  else if (root[1] === 'now') value = new Date(ctx.now?.() ?? Date.now()).toISOString();
  else if (root[1] === 'today') value = new Date(ctx.now?.() ?? Date.now()).toISOString().slice(0, 10);
  else value = root[1] === 'trigger' ? ctx.trigger : ctx.input;
  let rest = expr.slice(root[0].length);
  while (rest.trim()) {
    const step = STEP.exec(rest.trimStart());
    if (!step) return MISSING;
    rest = rest.trimStart().slice(step[0].length);
    const key = step[1] ?? step[3] ?? step[4] ?? (step[2] != null ? Number(step[2]) : null);
    // A field of text that holds JSON (a tool's answer, say) is read as if it had arrived parsed.
    if (typeof value === 'string') value = parseMaybe(value);
    value = value != null && typeof value === 'object' ? value[key] : undefined;
  }
  return value;
}

/**
 * Fill every {{ expression }} in a template with text. `escape` is applied to
 * each filled-in piece (jsonEscape for a value landing inside a JSON string).
 * An expression this module does not understand is left as written.
 */
export function fill(template, ctx, escape = (v) => v) {
  return String(template ?? '').replace(EXPR, (whole, expr) => {
    const value = read(expr, ctx);
    return value === MISSING ? whole : escape(toText(value));
  });
}

/** A template that is one expression and nothing else keeps the value's own type; anything else is text. */
export function value(template, ctx) {
  const one = ONE.exec(String(template ?? ''));
  if (one) {
    const v = read(one[1], ctx);
    if (v !== MISSING) return v;
  }
  return fill(template, ctx);
}

/** For a value landing inside a JSON string: quotes and line breaks must not end the string. */
export const jsonEscape = (v) => JSON.stringify(String(v)).slice(1, -1);

/** Every expression in a template that cannot be read, for a helpful message when saving. */
export function badExpressions(template) {
  const bad = [];
  for (const [, expr] of String(template ?? '').matchAll(EXPR)) if (read(expr, { input: null, trigger: null, node: () => null }) === MISSING) bad.push(expr);
  return bad;
}

/**
 * Keep a value small enough to store with a run: JSON longer than `max`
 * characters is replaced by a note holding its beginning, so a run history
 * never grows with whatever a service sent back.
 */
export function keep(value, max = 3000) {
  const text = toText(value);
  if (text.length <= max) return value;
  return { '[clipped]': `${text.slice(0, max)}…`, length: text.length };
}

// ---------------------------------------------------------------- conditions

export const OPS = ['contains', 'not_contains', 'equals', 'not_equals', 'starts', 'ends', 'matches', 'empty', 'not_empty', 'gt', 'lt'];
export const UNARY = new Set(['empty', 'not_empty']);

/** One condition: { left, op, value }. Text comparisons ignore letter case. */
export function test(condition, ctx) {
  const left = value(condition.left || '{{ input }}', ctx);
  const right = fill(condition.value ?? '', ctx);
  const l = toText(left).toLowerCase();
  const r = right.toLowerCase();
  switch (condition.op) {
    case 'contains': return l.includes(r);
    case 'not_contains': return !l.includes(r);
    case 'equals': return l.trim() === r.trim();
    case 'not_equals': return l.trim() !== r.trim();
    case 'starts': return l.startsWith(r);
    case 'ends': return l.endsWith(r);
    case 'matches': return new RegExp(right, 'i').test(toText(left));
    case 'empty': return left == null || (Array.isArray(left) ? !left.length : typeof left === 'object' ? !Object.keys(left).length : !l.trim());
    case 'not_empty': return !test({ ...condition, op: 'empty' }, ctx);
    case 'gt':
    case 'lt': {
      const a = Number(toText(left).trim());
      const b = Number(right.trim());
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return condition.op === 'gt' ? a > b : a < b;
    }
    default: return false;
  }
}

/** Several conditions, all of which (or any of which) must hold. */
export const testAll = (conditions, combine, ctx) => (combine === 'or' ? conditions.some((c) => test(c, ctx)) : conditions.every((c) => test(c, ctx)));

/** Set `value` at a dotted path ("a.b.c") inside `target`, making the objects on the way. */
export function setPath(target, path, v) {
  const parts = path.split('.').filter(Boolean);
  let at = target;
  parts.forEach((part, i) => {
    if (i === parts.length - 1) at[part] = v;
    else {
      if (at[part] == null || typeof at[part] !== 'object') at[part] = {};
      at = at[part];
    }
  });
  return target;
}
