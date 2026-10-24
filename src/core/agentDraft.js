import { clip } from './util.js';
import { MAX_SKILLS_CHOSEN } from './flame.js';

/**
 * "Generate with AI" in the hire form: the user says in a few words what kind of
 * specialist they want, and the Chef writes the form for them in one call - a name,
 * the one line the Chef will later match work against, working instructions, and
 * skills from the library. Nothing is hired here: the answer fills the form, and the
 * user reads it, changes what they like and presses Hire (which validates as always).
 */

/** Marks the prompt (the mock provider looks for it). */
export const AGENT_DRAFT_MARK = '## Specialist to describe';
export const AGENT_DRAFT_INPUT_CHARS = 600;
const NAME = 30;
const SPECIALTY = 160;
const INSTRUCTIONS = 1500; // what the form and crew.hire keep

export function agentDraftSystem({ skills = [], crew = [] }) {
  return `You write the profile of a specialist agent for Kadhai, a crew of AI coding agents (the Chef plans, cooks write code, the Taster reviews). A specialist is an extra cook: the Chef gives it a step only when the step matches its "specialty" line.

Answer with one JSON object and nothing else:
{"name": "...", "specialty": "...", "instructions": "...", "skills": ["skill-id", ...]}

- name: 2 to 3 words, at most ${NAME} characters, a job title in the kitchen's spirit or a plain one (e.g. "Pastry Chef", "Test Writer"). Not one of: ${crew.map((a) => a.name).join(', ') || 'none'}.
- specialty: one line, at most ${SPECIALTY} characters, naming the concrete kinds of work it should get (technologies, file types, tasks). The Chef reads only this to decide, so be specific; no praise.
- instructions: how it works, as short imperative rules, one per line starting with "- ", most important first, at most ${INSTRUCTIONS - 300} characters. Concrete (use this, never that, check this), nothing about output format or tools - Kadhai adds those. Only rules a coding agent can follow while reading and editing this project's files and running its commands: no outside services, issue trackers or tools to install. Follow the project's existing choices (its test runner, framework, style) rather than prescribing new ones, unless the user named one.
- skills: up to ${MAX_SKILLS_CHOSEN} ids from the list below that clearly fit, or []. Never invent an id.

## Skills in the library (id: what it is)
${skills.length ? skills.map((s) => `- ${s.id}: ${clip(String(s.description || s.name).replace(/\s+/g, ' '), 100)}`).join('\n') : '(none)'}`;
}

export const agentDraftUser = (request) => `${AGENT_DRAFT_MARK}\n${clip(String(request), AGENT_DRAFT_INPUT_CHARS)}`;

/** The model's answer as form values. Throws (status 422) when there is nothing usable in it. */
export function shapeAgentDraft(raw, { skills = [], crew = [] } = {}) {
  if (!raw || typeof raw !== 'object') throw Object.assign(new Error('The Chef did not answer with a profile. Try again, or say it another way.'), { status: 422 });
  const one = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  let name = one(raw.name, NAME).replace(/["{}]/g, '');
  const taken = new Set(crew.map((a) => a.name.toLowerCase()));
  for (let n = 2; name && taken.has(name.toLowerCase()); n++) name = `${one(raw.name, NAME - 3)} ${n}`;
  const specialty = one(raw.specialty, SPECIALTY);
  if (name.length < 2 || specialty.length < 5) throw Object.assign(new Error('The Chef left out the name or what the agent is good at. Try again, or say it another way.'), { status: 422 });
  const instructions = (Array.isArray(raw.instructions) ? raw.instructions.map((l) => `- ${String(l).replace(/^-\s*/, '')}`).join('\n') : String(raw.instructions ?? ''))
    .replace(/\\n/g, '\n')
    .trim();
  const known = new Set(skills.map((s) => s.id));
  const picked = [...new Set((Array.isArray(raw.skills) ? raw.skills : []).map(String).filter((id) => known.has(id)))].slice(0, MAX_SKILLS_CHOSEN);
  // Too long: cut at the last whole rule, not half way through one.
  const kept = instructions.length <= INSTRUCTIONS ? instructions : instructions.slice(0, INSTRUCTIONS).replace(/\n[^\n]*$/, '');
  return { name, specialty, instructions: kept, skills: picked };
}
