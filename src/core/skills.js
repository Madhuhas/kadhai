import fs from 'node:fs';
import path from 'node:path';

/** Skills the user writes in the dashboard. */
export const MAX_OWN_SKILLS = 30;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** A skill file: `name` and `description` between two `---` lines, then the instructions. */
export function parseSkill(id, raw, { whole = false } = {}) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/.exec(raw);
  const meta = {};
  for (const line of (match?.[1] ?? '').split(/\r?\n/)) {
    const pair = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (pair) meta[pair[1].toLowerCase()] = pair[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  const body = (match ? match[2] : raw).trim();
  if (!id || !body) return null;
  return { id, name: (meta.name || id).slice(0, 40), description: whole ? meta.description || '' : (meta.description || '').slice(0, 200), body };
}

/**
 * The skills library: `<dir>/<id>.md`, or `<dir>/<id>/SKILL.md` (the layout
 * Claude skills use, so those can be dropped in as they are).
 * `ownDir` holds the ones the user wrote in the dashboard; they are marked `own` and can be
 * changed there. A built-in keeps its place if one of the user's has the same id.
 */
export function loadSkills(dir, ownDir = null) {
  const skills = new Map();
  for (const skill of readDir(dir)) skills.set(skill.id, { ...skill, own: false });
  for (const skill of ownDir ? readDir(ownDir) : []) if (!skills.has(skill.id)) skills.set(skill.id, { ...skill, own: true });
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function readDir(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = new Map();
  for (const entry of entries) {
    const isFile = entry.isFile() && /\.md$/i.test(entry.name) && !/^readme\.md$/i.test(entry.name);
    if (!isFile && !entry.isDirectory()) continue;
    const file = isFile ? path.join(dir, entry.name) : path.join(dir, entry.name, 'SKILL.md');
    try {
      const skill = parseSkill(slug(isFile ? entry.name.replace(/\.md$/i, '') : entry.name), fs.readFileSync(file, 'utf8'));
      if (skill && !skills.has(skill.id)) skills.set(skill.id, skill);
    } catch {
      // A folder without a SKILL.md, or an unreadable file: not a skill.
    }
  }
  return [...skills.values()];
}

/** What the user typed for a skill of their own, checked. Throws a sentence they can act on. */
export function cleanSkill(input = {}) {
  const line = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const name = line(input.name, 40);
  const description = line(input.description, 200);
  const body = String(input.body ?? '').replace(/\r\n/g, '\n').trim().slice(0, 4000);
  if (name.length < 2) throw fail('Give the skill a name');
  if (!slug(name)) throw fail('The name needs at least one letter or digit');
  if (description.length < 5) throw fail('Say in a line what the skill is for - that is what you will read when choosing skills for an agent');
  if (body.length < 10) throw fail('Write the advice the agent should follow');
  // A line of three dashes would be read as the end of the file's header.
  if (/^---\s*$/m.test(body)) throw fail('A line with only "---" cannot be part of a skill');
  return { name, description, body };
}

/** Save one of the user's skills as "<id>.md", in the same form as the built-in ones. */
export async function writeSkill(dir, { id, name, description, body }) {
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.md`);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
  await fs.promises.rename(tmp, file);
}

export async function deleteSkill(dir, id) {
  await fs.promises.rm(path.join(dir, `${id}.md`), { force: true });
}
