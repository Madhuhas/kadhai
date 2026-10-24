/** One part of an address: a name with a "/" or "?" in it must not change the route. */
const seg = encodeURIComponent;

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // The network failed, not the request: almost always the server was stopped.
    throw Object.assign(new Error('Kadhai is not answering. Is it still running? (start it with: npm start)'), { status: 0, offline: true });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, room: data.room });
  return data;
}

const q = (path) => `?path=${encodeURIComponent(path)}`;

export const api = {
  state: () => request('GET', '/api/state'),
  about: () => request('GET', '/api/about'),
  license: () => request('GET', '/api/license'),
  lessons: () => request('GET', '/api/lessons'),
  forgetLesson: (id) => request('DELETE', `/api/lessons/${seg(id)}`),
  journal: (q = '') => request('GET', `/api/journal${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  skills: () => request('GET', '/api/skills'),
  files: () => request('GET', '/api/files'),
  readFile: (path) => request('GET', `/api/file${q(path)}`),
  writeFile: (path, content) => request('PUT', '/api/file', { path, content }),
  deleteFile: (path) => request('DELETE', `/api/file${q(path)}`),
  makeDir: (path) => request('POST', '/api/dir', { path }),
  deleteDir: (path) => request('DELETE', `/api/dir${q(path)}`),
  move: (from, to) => request('POST', '/api/move', { from, to }),
  browse: (path) => request('GET', `/api/workspace/browse${q(path ?? '')}`),
  makeFolder: (parent, name) => request('POST', '/api/workspace/folder', { parent, name }),
  openWorkspace: (path) => request('POST', '/api/workspace/open', { path }),
  rooms: {
    list: () => request('GET', '/api/workspace/rooms'),
    open: (path) => request('POST', '/api/workspace/rooms', { path }),
    close: (id) => request('DELETE', `/api/workspace/rooms/${seg(id)}`),
  },
  catalog: () => request('GET', '/api/catalog'),
  connect: (id, fields) => request('POST', `/api/catalog/${seg(id)}/connect`, fields ?? {}),
  connectors: {
    status: () => request('GET', '/api/connectors'),
    googleSetup: (settings) => request('POST', '/api/connectors/google/setup', settings),
    googleDisconnect: (forget = false) => request('POST', '/api/connectors/google/disconnect', { forget }),
  },
  mcp: {
    add: (server) => request('POST', '/api/mcp-servers', server),
    remove: (name) => request('DELETE', `/api/mcp-servers/${encodeURIComponent(name)}`),
    restart: (name) => request('POST', `/api/mcp-servers/${encodeURIComponent(name)}/restart`),
    enable: (name, enabled) => request('POST', `/api/mcp-servers/${encodeURIComponent(name)}/enabled`, { enabled }),
  },
  git: {
    status: () => request('GET', '/api/git/status'),
    init: () => request('POST', '/api/git/init'),
    stage: (paths, all = false) => request('POST', '/api/git/stage', { paths, all }),
    unstage: (paths, all = false) => request('POST', '/api/git/unstage', { paths, all }),
    discard: (path) => request('POST', '/api/git/discard', { path }),
    commit: (message) => request('POST', '/api/git/commit', { message }),
    diff: (path, staged) => request('GET', `/api/git/diff${q(path)}${staged ? '&staged=1' : ''}`),
    log: () => request('GET', '/api/git/log'),
    checkout: (branch, create = false) => request('POST', '/api/git/checkout', { branch, create }),
    pull: () => request('POST', '/api/git/pull'),
    push: () => request('POST', '/api/git/push'),
  },
  flows: {
    list: () => request('GET', '/api/flows'),
    create: (flow) => request('POST', '/api/flows', flow),
    save: (id, flow) => request('PUT', `/api/flows/${seg(id)}`, flow),
    remove: (id) => request('DELETE', `/api/flows/${seg(id)}`),
    enable: (id, enabled) => request('POST', `/api/flows/${seg(id)}/enabled`, { enabled }),
    run: (id, pins = true) => request('POST', `/api/flows/${seg(id)}/run`, { pins }),
    stop: (id) => request('POST', `/api/flows/${seg(id)}/stop`),
    runs: (id) => request('GET', `/api/flows/${seg(id)}/runs`),
    catalog: () => request('GET', '/api/flows/catalog'),
    test: (body) => request('POST', '/api/flows/test', body),
    openapi: (body) => request('POST', '/api/flows/openapi', body),
    // With `base` (the drawing on the canvas) it changes that flow; with `failure` too, it fixes it.
    draft: (text, extra = {}) => request('POST', '/api/flows/draft', { text, ...extra }),
    try: (flow) => request('POST', '/api/flows/try', { flow }),
  },
  credentials: {
    list: () => request('GET', '/api/credentials'),
    add: (credential) => request('POST', '/api/credentials', credential),
    remove: (id) => request('DELETE', `/api/credentials/${seg(id)}`),
    test: (id) => request('POST', `/api/credentials/${seg(id)}/test`),
  },
  triggers: {
    list: () => request('GET', '/api/triggers'),
    add: (trigger) => request('POST', '/api/triggers', trigger),
    remove: (id) => request('DELETE', `/api/triggers/${seg(id)}`),
    enable: (id, enabled) => request('POST', `/api/triggers/${seg(id)}/enabled`, { enabled }),
  },
  task: (text, attachments = [], shell = false) => request('POST', '/api/task', { text, attachments, ...(shell ? { shell } : {}) }),
  attach: (name, data) => request('POST', '/api/attach', { name, data }),
  stop: () => request('POST', '/api/run/stop'),
  note: (id, text) => request('POST', `/api/agents/${seg(id)}/note`, { text }),
  pause: (id) => request('POST', `/api/agents/${seg(id)}/pause`),
  resume: (id) => request('POST', `/api/agents/${seg(id)}/resume`),
  skipProvider: () => request('POST', '/api/providers/skip'),
  resetProviders: () => request('POST', '/api/providers/reset'),
  unqueue: (id) => request('DELETE', `/api/queue/${seg(id)}`),
  runDiff: (id) => request('GET', `/api/runs/${seg(id)}/diff`),
  undoRun: (id) => request('POST', `/api/runs/${seg(id)}/undo`),
  hire: (agent) => request('POST', '/api/crew', agent),
  generateAgent: (text) => request('POST', '/api/crew/generate', { text }),
  retrain: (id, agent) => request('PUT', `/api/crew/${seg(id)}`, agent),
  dismiss: (id) => request('DELETE', `/api/crew/${seg(id)}`),
  connections: () => request('GET', '/api/connections'),
  tools: () => request('GET', '/api/tools'),
  restrict: (id, agents) => request('PUT', `/api/connections/${encodeURIComponent(id)}/access`, { agents }),
  skill: (id) => request('GET', `/api/skills/${seg(id)}`),
  skillGallery: () => request('GET', '/api/skills/gallery'),
  importSkill: (url) => request('POST', '/api/skills/import', { url }),
  flame: () => request('GET', '/api/workspace/flame'),
  setFlame: (flame) => request('PUT', '/api/workspace/flame', { flame }),
  saveSkill: (skill, id = null) => (id ? request('PUT', `/api/skills/${seg(id)}`, skill) : request('POST', '/api/skills', skill)),
  removeSkill: (id) => request('DELETE', `/api/skills/${seg(id)}`),
  configure: (id, settings) => request('PUT', `/api/crew/${seg(id)}/settings`, settings),
  keys: () => request('GET', '/api/keys'),
  addAnyKey: (key) => request('POST', '/api/keys', { key }),
  practice: () => request('POST', '/api/practice'),
  keySettings: (settings) => request('PUT', '/api/keys-settings', settings),
  addEndpoint: (endpoint) => request('POST', '/api/endpoints', endpoint),
  removeEndpoint: (id) => request('DELETE', `/api/endpoints/${seg(id)}`),
  setSubscription: (id, enabled) => request('PUT', `/api/subscriptions/${seg(id)}`, { enabled }),
  setSubscriptionModels: (id, models) => request('PUT', `/api/subscriptions/${seg(id)}/models`, { models }),
  addKey: (provider, key) => request('POST', `/api/keys/${seg(provider)}`, { key }),
  removeKey: (provider, id) => request('DELETE', `/api/keys/${seg(provider)}/${seg(id)}`),
  availableModels: (provider) => request('GET', `/api/keys/${seg(provider)}/models`),
  setModels: (provider, models) => request('PUT', `/api/keys/${seg(provider)}/models`, { models }),
  exec: (command, dir = '', keep = false) => request('POST', '/api/exec', { command, dir, keep }),
  which: (names) => request('GET', `/api/exec/which?names=${names.map(encodeURIComponent).join(',')}`),
  execMode: (mode) => request('POST', '/api/exec/mode', { mode }),
  execAction: (id, action) => request('POST', `/api/exec/${seg(id)}/${seg(action)}`),
};
