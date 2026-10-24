/** Single source of truth for the UI. Modules read `state` and re-render on `on(topic)`. */
export const state = {
  app: {},
  agents: {}, // id -> agent view
  thoughts: {}, // id -> thought stream text
  skills: [], // the skills library: id, name, description
  access: {}, // connections kept for certain cooks: connection id -> agent ids
  providers: { active: null, routes: [], at: 0 },
  mcp: [],
  locks: [],
  chat: [],
  run: null,
  switching: false, // true while another folder is being opened (the live connection drops on purpose)
  queue: [], // tasks waiting for the crew
  runs: [], // finished runs that changed files (diff / undo)
  exec: { mode: 'ask', pending: [], running: [] },
};

const listeners = {};

export function on(topic, fn) {
  (listeners[topic] ??= []).push(fn);
}

export function emit(topic, data) {
  for (const fn of listeners[topic] ?? []) fn(data);
}
