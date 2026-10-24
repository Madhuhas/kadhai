import fs from 'node:fs';

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

/** Custom agents the user hired, kept in agents.local.json next to .env. */
export function loadCustomAgents(file) {
  const data = read(file);
  return Array.isArray(data.agents) ? data.agents : [];
}

/** What the user changed about any agent, house or hired: `{ id: { hue, model, skills } }`. */
export function loadAgentSettings(file) {
  const { settings } = read(file);
  return settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
}

/** Connections kept for certain cooks only: `{ connection: [agent ids] }`. */
export function loadAgentAccess(file) {
  const { access } = read(file);
  return access && typeof access === 'object' && !Array.isArray(access) ? access : {};
}

export async function saveCustomAgents(file, agents, settings = {}, access = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  const data = { agents };
  if (Object.keys(settings).length) data.settings = settings;
  if (Object.keys(access).length) data.access = access;
  await fs.promises.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await fs.promises.rename(tmp, file);
}
