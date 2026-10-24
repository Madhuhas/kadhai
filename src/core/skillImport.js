import { parseSkill, slug } from './skills.js';
import { condenseSystem, condenseUser } from './prompts.js';
import { HIGH, LOW_EXTRAS } from './flame.js';

/*
 * A skill from a link: a SKILL.md (Claude's layout, as in github.com/wshobson/agents) or any
 * Markdown file. Fetched over https, read as text, and - if it is longer than high flame
 * carries - condensed in one model call through the Chef. Nothing is saved here: the
 * result goes back to the skill form, the user reads and edits it, and saves it as their own.
 */
const MAX_BYTES = 300_000;
const FETCH_TIMEOUT_MS = 15000;
const INPUT_CHARS = 20000; // of a very long file, what the condensing model reads
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/** A GitHub page address becomes its raw file; a folder of a skill becomes its SKILL.md. */
export function rawSkillUrl(input) {
  let url;
  try {
    url = new URL(String(input ?? '').trim());
  } catch {
    throw fail('Paste a full link, starting with https://');
  }
  if (url.protocol !== 'https:') throw fail('Only https links can be imported');
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.hostname === 'github.com' && parts.length >= 4 && (parts[2] === 'blob' || parts[2] === 'tree')) {
    const [owner, repo, kind, ...rest] = parts;
    const file = kind === 'tree' && !/\.md$/i.test(rest.at(-1) ?? '') ? [...rest, 'SKILL.md'] : rest;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${file.join('/')}`;
  }
  return url.href;
}

async function fetchText(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'follow', headers: { accept: 'text/plain, text/markdown, */*' } });
    if (!res.ok) throw fail(res.status === 404 ? 'Nothing at that link (404). Link to the SKILL.md file, or the folder that holds it.' : `The link answered ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw fail('That file is too big to be a skill');
    if (/^\s*<(!doctype|html)/i.test(text)) throw fail('That link is a web page, not a skill file. Link to the SKILL.md itself.');
    return text;
  } catch (err) {
    if (err.name === 'AbortError') throw fail('The link took too long to answer');
    if (err.status) throw err;
    throw fail(`Could not fetch the link: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** A line of only dashes would end the saved file's header; the form refuses it too. */
const tidy = (text) => text.replace(/\r\n/g, '\n').replace(/^-{3,}\s*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

/** One line of at most `max` characters: whole sentences if they fit, else whole words. */
function words(text, max) {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  const sentence = line.slice(0, max).match(/^.*[.!?](?=\s|$)/)?.[0];
  if (sentence && sentence.length > max / 2) return sentence;
  return `${line.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}

/** Cut at a line end, never mid-sentence, to fit `max`. */
function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf('\n'), max * 0.8)).trimEnd();
}

/**
 * Fetch and, if needed, condense. Resolves to { name, description, body, source, condensed }.
 * `condense(system, user)` is one model call (the engine passes crew.call for the Chef).
 */
export async function importSkill(link, { fetch: fetchImpl = globalThis.fetch, condense } = {}) {
  const source = rawSkillUrl(link);
  const raw = await fetchText(source, fetchImpl);
  const fallbackName = decodeURIComponent(source.split('/').filter((p) => !/^skill\.md$/i.test(p)).at(-1) ?? 'imported').replace(/\.md$/i, '');
  const parsed = parseSkill(slug(fallbackName) || 'imported', raw, { whole: true });
  if (!parsed) throw fail('That file is empty');
  // "python-error-handling" reads as "Python error handling".
  const spaced = parsed.name.replace(/[-_]+/g, ' ').trim();
  const name = (spaced.charAt(0).toUpperCase() + spaced.slice(1)).slice(0, 40) || 'Imported skill';
  let body = tidy(parsed.body);
  const description = words((parsed.description || body.split('\n').find((l) => /\w/.test(l)) || name).replace(/^#+\s*/, ''), 200);
  const credit = `\n\nSource: ${link}`;
  const room = HIGH.skillChars - credit.length;
  let condensed = false;
  if (body.length > room) {
    if (!condense) throw fail('That skill is long and needs a model to condense it, but none is available');
    const out = await condense(condenseSystem(LOW_EXTRAS.skillChars, HIGH.skillChars), condenseUser({ name, description, body: body.slice(0, INPUT_CHARS) }));
    body = tidy(String(out ?? '').replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/i, '$1'));
    if (body.length < 40) throw fail('The model gave back too little to use. Try again, or another link.');
    condensed = true;
  }
  return { name, description, body: clip(body, room) + credit, source, condensed };
}
