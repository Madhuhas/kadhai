import path from 'node:path';
import express from 'express';
import { JsonRpcPeer } from '../protocols/jsonrpc.js';
import { createMcpServer } from '../protocols/mcpServer.js';
import { checkFields, publicCatalog, specFor } from '../core/connectors/catalog.js';
import { onPath } from '../core/runner.js';
import { SKILL_GALLERY } from '../core/skillGallery.js';
import { catalog as flowCatalog } from '../core/services.js';
import { readOpenApi } from '../core/flows.js';
import { escapeHtml, log } from '../core/util.js';
import { licenseText } from '../config.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const hostOf = (value) => String(value ?? '').replace(/:\d+$/, '').toLowerCase();
const isLocalHost = (req) => LOCAL_HOSTS.has(hostOf(req.headers.host));

/** How many files and folders the file tree lists at most. */
const TREE_SHOWN = 1500;

/**
 * The server can read and write files, so it only talks to this machine:
 * requests must target a loopback Host (blocks DNS rebinding) and, when a
 * browser sends an Origin, it must be this very server (blocks drive-by sites
 * and - because the preview lives on another port - the crew's own generated
 * pages, which must never be able to call this API).
 */
function localOnly(req, res, next) {
  if (!isLocalHost(req)) return res.status(403).json({ error: 'Local access only' });
  const { origin } = req.headers;
  if (origin) {
    let ok = false;
    try {
      ok = new URL(origin).host.toLowerCase() === String(req.headers.host).toLowerCase();
    } catch {
      ok = false;
    }
    if (!ok) return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
  }
  // Browsers also say where a request came from in Sec-Fetch-Site, even in the rare cases they
  // leave Origin out. Anything that changes something must come from the dashboard itself
  // (or from a program on this computer, which sends no such header). Reads stay open: the
  // Google sign-in returns to a GET from another site, and a cross-site page cannot read the reply.
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
  }
  next();
}

/**
 * The dashboard shows text that models wrote. It is escaped before it reaches the page; this is
 * the second line of defence: only this server's own script files may run, and nothing may frame it.
 */
const CONTENT_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "object-src 'none'",
  // The browser tab frames pages on this computer only (the preview port, a dev server).
  "frame-src http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function secureHeaders(_req, res, next) {
  res.set({ 'Content-Security-Policy': CONTENT_POLICY, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  next();
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

/** The small page Google sends the browser back to. */
const callbackPage = (title, detail, ok) => `<!doctype html><meta charset="utf-8"><title>Kadhai</title>
<body style="margin:0;display:grid;place-items:center;height:100vh;background:#e6e6e6 radial-gradient(circle,#b8b8b8 1px,transparent 1px) 0 0/22px 22px;color:#111;font:13px/1.5 'JetBrains Mono',Consolas,monospace">
<div style="width:min(440px,90vw);border:2px solid #999;border-radius:5px;background:#fff;box-shadow:4px 4px 0 rgba(0,0,0,.16)">
<div style="height:30px;line-height:30px;padding:0 8px;background:linear-gradient(#dcdcdc,#cacaca);border-bottom:1px solid #aaa;font-weight:500">${ok ? 'connected.ok' : 'error.log'}</div>
<div style="padding:16px">
<pre style="margin:0 0 12px;font:inherit;line-height:1.1">${ok ? ' )  )  )\n\\_______/' : '  .---.\n  | ! |\n  \'---\''}</pre>
<h1 style="font-size:14px;font-weight:600;margin:0 0 6px">${title}</h1>
<p style="margin:0;color:#666">${detail}</p>
</div></div></body>`;

const ATTACH_DIR = 'attachments';
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024; // as base64 this still fits the 4 MB JSON limit

export function apiRouter(engine) {
  const { workspace, crew, dispatcher, orchestrator, memory, bus, runner, keys, hiring, git, mcp, connectors, triggers, flows, credentials, skills, journal } = engine;
  const api = express.Router();

  api.get('/state', wrap(async (_req, res) => res.json(await engine.snapshot())));
  api.get('/about', (_req, res) => res.json(engine.about()));
  api.get('/license', (_req, res) => res.json({ text: licenseText() }));

  // Server-Sent Events: one long-lived response carries every live update.
  api.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const unsubscribe = bus.subscribe((event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
    engine.streams.add(res);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      engine.streams.delete(res);
    });
  });

  // A very large folder is listed only in part, and the browser says so rather than look complete.
  api.get('/files', wrap(async (_req, res) => {
    const files = await workspace.tree({ maxEntries: TREE_SHOWN + 1 });
    res.json({ files: files.slice(0, TREE_SHOWN), truncated: files.length > TREE_SHOWN });
  }));

  api.get('/file', wrap(async (req, res) => res.json(await workspace.readFile(req.query.path))));

  api.put(
    '/file',
    wrap(async (req, res) => {
      const { path: file, content } = req.body ?? {};
      if (typeof content !== 'string') return res.status(400).json({ error: '"content" must be a string' });
      // Fail fast: if an agent holds the lock the user should hear about it now.
      res.json(await workspace.writeFile(file, content, { owner: 'user', timeoutMs: 1500 }));
    }),
  );

  api.delete(
    '/file',
    wrap(async (req, res) => res.json(await workspace.deleteFile(req.query.path, { owner: 'user', timeoutMs: 1500 }))),
  );

  // A file attached in the chat: saved under attachments/, never over an existing file.
  api.post(
    '/attach',
    wrap(async (req, res) => {
      const { name, data } = req.body ?? {};
      const safe = String(name ?? '').replace(/[^\w.\- ]+/g, '_').replace(/^[. ]+/, '').slice(-80).trim();
      if (!safe || typeof data !== 'string') return res.status(400).json({ error: 'An attachment needs a name and its contents' });
      const bytes = Buffer.from(data, 'base64');
      if (!bytes.length) return res.status(400).json({ error: `"${safe}" is empty` });
      if (bytes.length > MAX_ATTACHMENT_BYTES) return res.status(413).json({ error: `"${safe}" is larger than 2 MB` });
      const dot = safe.lastIndexOf('.');
      const [stem, ext] = dot > 0 ? [safe.slice(0, dot), safe.slice(dot)] : [safe, ''];
      let rel = `${ATTACH_DIR}/${safe}`;
      for (let n = 2; await workspace.exists(rel); n++) rel = `${ATTACH_DIR}/${stem}-${n}${ext}`;
      res.status(201).json({ ...(await workspace.writeFile(rel, bytes, { owner: 'user', timeoutMs: 1500 })), bytes: bytes.length });
    }),
  );

  // Folders, and moving or renaming anything.
  api.post('/dir', wrap(async (req, res) => res.status(201).json(await workspace.makeDir(req.body?.path))));
  api.delete('/dir', wrap(async (req, res) => res.json(await workspace.deleteDir(req.query.path))));
  api.post('/move', wrap(async (req, res) => res.json(await workspace.move(req.body?.from, req.body?.to, { owner: 'user' }))));

  // Connected accounts (Google). Secrets and tokens stay on the server; only the email comes back.
  api.get('/connectors', wrap(async (_req, res) => res.json({ google: await connectors.google.status() })));
  api.post('/connectors/google/setup', wrap(async (req, res) => res.json(await connectors.google.setup(req.body ?? {}))));
  api.post('/connectors/google/disconnect', wrap(async (req, res) => res.json(await connectors.google.disconnect({ forget: req.body?.forget === true }))));
  // Google redirects the browser here after the consent screen.
  api.get('/connectors/google/callback', async (req, res) => {
    try {
      const { email } = await connectors.google.callback(req.query);
      res.send(callbackPage('Google is connected', `${email ? `Signed in as ${escapeHtml(email)}. ` : ''}You can close this tab and go back to Kadhai.`, true));
    } catch (err) {
      res.status(err.status ?? 400).send(callbackPage('Google was not connected', escapeHtml(err.message), false));
    }
  });

  // The connector catalog: known services that can be switched on with one click.
  api.get('/catalog', (_req, res) => res.json(publicCatalog()));
  api.post('/catalog/:id/connect', wrap(async (req, res) => {
    const spec = specFor(req.params.id, req.body ?? {});
    await checkFields(req.params.id, req.body ?? {});
    // Connecting again replaces a failed or stale attempt.
    if (mcp.status().some((s) => s.name === spec.name)) await mcp.remove(spec.name);
    // Answer straight away: a first download or a sign-in can take minutes, and progress arrives as events.
    res.status(202).json(await mcp.add({ ...spec, wait: false }));
  }));

  // MCP tool servers for the cooks. Adding one runs a program on this machine, so this
  // is reachable only by the operator's own dashboard (see localOnly).
  api.get('/mcp-servers', (_req, res) => res.json({ servers: mcp.status() }));
  api.post('/mcp-servers', wrap(async (req, res) => res.status(201).json(await mcp.add(req.body ?? {}))));
  api.delete('/mcp-servers/:name', wrap(async (req, res) => {
    const removed = await mcp.remove(req.params.name);
    // A server added later under the same name starts with a clean slate.
    if (req.params.name in crew.access()) await hiring.restrict(req.params.name, null);
    res.json(removed);
  }));
  api.post('/mcp-servers/:name/restart', wrap(async (req, res) => res.json(await mcp.restart(req.params.name))));
  api.post('/mcp-servers/:name/enabled', wrap(async (req, res) => res.json(await mcp.setEnabled(req.params.name, req.body?.enabled === true))));

  // Source control: the folder's own git repository.
  api.get('/git/status', wrap(async (_req, res) => {
    const status = await git.status();
    res.json(status.repo ? { ...status, branches: await git.branches() } : status);
  }));
  api.post('/git/init', wrap(async (_req, res) => res.json(await git.init())));
  api.post('/git/stage', wrap(async (req, res) => res.json({ ok: (await git.stage(req.body?.paths, req.body?.all === true), true) })));
  api.post('/git/unstage', wrap(async (req, res) => res.json({ ok: (await git.unstage(req.body?.paths, req.body?.all === true), true) })));
  api.post('/git/discard', wrap(async (req, res) => res.json({ ok: (await git.discard(req.body?.path), true) })));
  api.post('/git/commit', wrap(async (req, res) => res.json(await git.commit(req.body?.message))));
  api.get('/git/diff', wrap(async (req, res) => res.json(await git.diff(req.query.path, req.query.staged === '1'))));
  api.get('/git/log', wrap(async (_req, res) => res.json({ commits: await git.log() })));
  api.post('/git/checkout', wrap(async (req, res) => res.json({ ok: (await git.checkout(req.body?.branch, req.body?.create === true), true) })));
  api.post('/git/pull', wrap(async (_req, res) => res.json(await git.pull())));
  api.post('/git/push', wrap(async (_req, res) => res.json(await git.push())));

  // Triggers: ways a task can arrive from outside the dashboard. Tokens are write-only, as keys are.
  api.get('/triggers', (_req, res) => res.json({ triggers: triggers.list(), types: triggers.types() }));
  api.post('/triggers', wrap(async (req, res) => res.status(201).json(await triggers.add(req.body ?? {}))));
  api.delete('/triggers/:id', wrap(async (req, res) => res.json(await triggers.remove(req.params.id))));
  api.post('/triggers/:id/enabled', wrap(async (req, res) => res.json(await triggers.setEnabled(req.params.id, req.body?.enabled === true))));
  // A webhook from a program on this computer (localOnly still applies). The token goes in a header, never the address.
  api.post('/hooks/:id', wrap(async (req, res) => {
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? req.headers['x-kadhai-token'];
    res.status(202).json(await triggers.fire(req.params.id, token, req.body));
  }));

  // Flows: a graph of nodes joined by wires. The catalog says what built-in services and starts there are.
  api.get('/flows', (_req, res) => res.json({ flows: flows.list() }));
  api.get('/flows/catalog', (_req, res) => res.json(flowCatalog()));
  api.post('/flows/test', wrap(async (req, res) => res.json(await flows.testNode(req.body?.flow ?? {}, String(req.body?.node ?? ''), { input: req.body?.input ?? '', trigger: req.body?.trigger ?? '', nodes: req.body?.nodes ?? {} }))));
  api.post('/flows/try', wrap(async (req, res) => res.json(await flows.tryOnce(req.body?.flow ?? {}))));
  api.post('/flows/draft', wrap(async (req, res) => res.json(await flows.draft(req.body?.text, { base: req.body?.base ?? null, failure: req.body?.failure ?? null, id: typeof req.body?.id === 'string' ? req.body.id : null }))));
  api.post('/flows/openapi', wrap(async (req, res) => res.json(await readOpenApi({ url: req.body?.url, textBody: typeof req.body?.text === 'string' ? req.body.text : '' }, flows.fetch))));
  api.get('/flows/:id/runs', wrap(async (req, res) => res.json({ runs: flows.runs(req.params.id) })));
  api.post('/flows/:id/stop', wrap(async (req, res) => res.json(flows.stop(req.params.id))));
  api.post('/flows', wrap(async (req, res) => res.status(201).json(await flows.save(req.body ?? {}))));
  api.put('/flows/:id', wrap(async (req, res) => res.json(await flows.save(req.body ?? {}, req.params.id))));
  api.delete('/flows/:id', wrap(async (req, res) => res.json(await flows.remove(req.params.id))));
  api.post('/flows/:id/enabled', wrap(async (req, res) => res.json(await flows.setEnabled(req.params.id, req.body?.enabled === true))));
  api.post('/flows/:id/run', (req, res) => res.status(202).json({ started: flows.runNow(req.params.id, { pins: req.body?.pins !== false }).id }));

  // Credentials for flows: write-only, like keys. A list gives names and masked hints, never a secret.
  api.get('/credentials', (_req, res) => res.json({ credentials: credentials.list() }));
  api.post('/credentials', wrap(async (req, res) => res.status(201).json(await credentials.add(req.body ?? {}))));
  api.delete('/credentials/:id', wrap(async (req, res) => res.json(await credentials.remove(req.params.id))));
  api.post('/credentials/:id/test', wrap(async (req, res) => res.json(await credentials.test(req.params.id))));

  // What the crew remembers about this folder: past runs (optionally the ones answering a question), and lessons.
  api.get('/journal', (req, res) => res.json({ entries: req.query.q ? journal.search(String(req.query.q), { limit: 20 }) : journal.recent(50), total: journal.size }));
  api.get('/lessons', (_req, res) => res.json({ lessons: journal.listLessons() }));
  api.delete('/lessons/:id', wrap(async (req, res) => res.json(await journal.forget(req.params.id))));

  api.get('/memory', wrap(async (_req, res) => res.json({ content: await memory.read() })));

  api.post('/task', (req, res) => {
    const run = orchestrator.start(req.body?.text, { source: 'ui', attachments: req.body?.attachments, shell: req.body?.shell === true });
    res.status(202).json({ runId: run.id, queued: run.queued });
  });
  api.delete('/queue/:id', (req, res) => res.json({ removed: orchestrator.cancel(req.params.id) }));

  api.get('/runs/:id/diff', wrap(async (req, res) => res.json(await orchestrator.diff(req.params.id))));
  api.post('/runs/:id/undo', wrap(async (req, res) => res.json(await orchestrator.undo(req.params.id))));

  api.post('/run/stop', (_req, res) => res.json({ stopped: orchestrator.stop() }));

  api.post('/agents/:id/note', (req, res) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return res.status(400).json({ error: 'The note is empty' });
    crew.note(req.params.id, text);
    res.json({ queued: true });
  });
  api.post('/agents/:id/pause', (req, res) => {
    crew.pause(req.params.id);
    res.json({ paused: true });
  });
  api.post('/agents/:id/resume', (req, res) => {
    crew.resume(req.params.id);
    res.json({ paused: false });
  });

  // Custom agents: hire, retrain, dismiss.
  api.post('/crew', wrap(async (req, res) => res.status(201).json(await hiring.hire(req.body))));
  api.post('/crew/generate', wrap(async (req, res) => res.json(await hiring.generate(req.body?.text))));
  api.put('/crew/:id', wrap(async (req, res) => res.json(await hiring.retrain(req.params.id, req.body))));
  // Any agent, house or hired: its colour, model preference and loaded skills.
  api.put('/crew/:id/settings', wrap(async (req, res) => res.json(await hiring.configure(req.params.id, req.body ?? {}))));
  api.get('/skills', (_req, res) => res.json(skills.list()));
  // Skills of the user's own. The built-in ones can be read but not changed.
  // Hand-picked skills to import; "added" when one of the user's own skills came from that link.
  // Before /skills/:id, which would otherwise read "gallery" as the id of a skill.
  api.get('/skills/gallery', (_req, res) => {
    const own = skills.list().filter((s) => s.own).map((s) => skills.get(s.id).body);
    res.json({ skills: SKILL_GALLERY.map((entry) => ({ ...entry, added: own.some((body) => body.includes(entry.url)) })) });
  });
  api.get('/skills/:id', (req, res) => res.json(skills.get(req.params.id)));
  api.post('/skills/import', wrap(async (req, res) => res.json(await skills.import(req.body?.url))));
  api.post('/skills', wrap(async (req, res) => res.status(201).json(await skills.save(req.body ?? {}))));
  api.put('/skills/:id', wrap(async (req, res) => res.json(await skills.save(req.body ?? {}, req.params.id))));
  api.delete('/skills/:id', wrap(async (req, res) => res.json(await skills.remove(req.params.id))));
  // What is connected right now, for choosing which agents may use what.
  api.get('/connections', (_req, res) => res.json(orchestrator.mcp?.groups?.() ?? []));
  // Every tool of every connection, for choosing what an app node in a flow does.
  api.get('/tools', (_req, res) => res.json((orchestrator.mcp?.tools?.() ?? []).map((tool) => ({ name: tool.name, description: tool.description, params: tool.params ?? [] }))));
  // Keep a connection for certain cooks ({ agents: [ids] }), or open it to everyone again ({ agents: null }).
  api.put('/connections/:id/access', wrap(async (req, res) => res.json(await hiring.restrict(req.params.id, req.body?.agents ?? null))));
  api.delete('/crew/:id', wrap(async (req, res) => res.json(await hiring.dismiss(req.params.id))));

  api.post('/providers/skip', (_req, res) => res.json({ skipped: dispatcher.skipActive() }));
  api.post('/providers/reset', (_req, res) => {
    dispatcher.reset();
    res.json(dispatcher.status());
  });

  // Provider keys: write-only. Responses carry masks and opaque ids, never a key.
  api.get('/keys', (_req, res) => res.json({ providers: keys.list(), subscriptions: keys.subscriptions(), settings: keys.settings() }));
  // A key pasted without choosing a provider: recognised by how it starts.
  api.post('/keys', wrap(async (req, res) => res.json(await keys.addAny(req.body?.key))));
  // No key yet: demo mode, with simulated models (refused once real models are set up).
  api.post('/practice', wrap(async (_req, res) => res.json(keys.practice())));
  // Paid keys: asked first or last, and a daily ceiling in tokens.
  api.put('/keys-settings', wrap(async (req, res) => res.json(await keys.setSettings(req.body ?? {}))));
  // Any other OpenAI-compatible server, added by its address.
  api.post('/endpoints', wrap(async (req, res) => res.status(201).json(await keys.addEndpoint(req.body ?? {}))));
  api.delete('/endpoints/:id', wrap(async (req, res) => res.json(await keys.removeEndpoint(req.params.id))));
  // Subscription CLIs (Claude Code, Codex, Gemini CLI) used as models: on, off, and which of their models.
  api.put('/subscriptions/:id', wrap(async (req, res) => res.json(await keys.setSubscription(req.params.id, req.body?.enabled === true))));
  api.put('/subscriptions/:id/models', wrap(async (req, res) => res.json(await keys.setSubscriptionModels(req.params.id, req.body?.models))));
  api.post('/keys/:provider', wrap(async (req, res) => res.json(await keys.add(req.params.provider, req.body?.key))));
  api.delete('/keys/:provider/:id', wrap(async (req, res) => res.json(await keys.remove(req.params.provider, req.params.id))));
  api.get('/keys/:provider/models', wrap(async (req, res) => res.json(await keys.available(req.params.provider))));
  api.put('/keys/:provider/models', wrap(async (req, res) => res.json(await keys.setModels(req.params.provider, req.body?.models))));

  // Commands typed by the operator are trusted: no approval step.
  api.post('/exec', (req, res) => {
    const command = runner.check(req.body?.command, { trusted: true });
    // The terminal may be in a sub-folder; resolve() keeps it inside the workspace.
    const dir = req.body?.dir ? workspace.resolve(req.body.dir).rel : '';
    // A dev server or a watcher: no time limit (refused here, before the 202, if it may not).
    const keep = req.body?.keep === true;
    if (keep) runner.checkKeep({ trusted: true });
    runner.run(command, { owner: 'user', trusted: true, dir, keep }).catch(() => {});
    res.status(202).json({ started: true, keep });
  });
  // Which of these programs are installed? Only looks in the PATH folders; never runs anything.
  api.get('/exec/which', (req, res) => {
    const names = String(req.query.names ?? '').split(',').filter(Boolean).slice(0, 20);
    res.json({ found: Object.fromEntries(names.map((name) => [name, onPath(name)])) });
  });
  api.post('/exec/mode', (req, res) => {
    runner.setMode(req.body?.mode);
    res.json({ mode: runner.mode });
  });
  api.post('/exec/:id/approve', (req, res) => res.json({ ok: runner.approve(req.params.id) }));
  api.post('/exec/:id/deny', (req, res) => res.json({ ok: runner.deny(req.params.id) }));
  api.post('/exec/:id/kill', (req, res) => res.json({ ok: runner.kill(req.params.id) }));

  api.use((_req, res) => res.status(404).json({ error: 'Unknown API route' }));
  return api;
}

/** MCP "Streamable HTTP" in its simplest legal form: one JSON reply per POST. */
export function mcpEndpoint(engine) {
  const server = createMcpServer(engine);
  return wrap(async (req, res) => {
    const replies = [];
    const peer = new JsonRpcPeer({ send: (message) => replies.push(message), ...server });
    await peer.receive(req.body);
    if (!replies.length) return res.status(202).end();
    res.json(Array.isArray(req.body) ? replies : replies[0]);
  });
}

/** Folder switching lives above any one engine, so it is served by the host itself. */
function workspaceRouter(host) {
  const router = express.Router();
  router.get('/', (_req, res) => res.json(host.info()));
  router.get('/browse', wrap(async (req, res) => res.json(await host.browse(req.query.path))));
  router.post('/folder', wrap(async (req, res) => res.status(201).json(await host.makeFolder(req.body?.parent, req.body?.name))));
  router.post('/open', wrap(async (req, res) => res.json(await host.open(req.body?.path))));
  // The flame (low / high): it outlives a folder switch, so it lives with the host, not the engine.
  router.get('/flame', (_req, res) => res.json(host.flameInfo()));
  router.put('/flame', wrap(async (req, res) => res.json(await host.setFlame(req.body?.flame ?? null))));
  // Rooms: other folders open at the same time, each in a server and a window of its own.
  const rooms = () => {
    if (!host.rooms) throw Object.assign(new Error('Rooms are not available here'), { status: 404 });
    return host.rooms;
  };
  router.get('/rooms', wrap(async (_req, res) => res.json({ rooms: (await rooms().list()).map((room) => ({ ...room, here: room.id === host.roomId })) })));
  router.post('/rooms', wrap(async (req, res) => res.status(201).json(await rooms().open(req.body?.path))));
  router.delete('/rooms/:id', wrap(async (req, res) => res.json(await rooms().close(req.params.id))));
  return router;
}

/**
 * Static preview of the workspace on its own port. A different port is a
 * different browser origin, so pages the crew generated get full browser
 * features (scripts, localStorage) yet cannot reach the dashboard API.
 */
export function createPreviewApp(host) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => (isLocalHost(req) ? next() : res.status(403).send('Local access only')));
  app.use((req, res, next) => host.preview(req, res, next)); // always the folder that is open now
  app.use((_req, res) => res.status(404).send('Not found in the workspace'));
  return app;
}

export function createApp(host) {
  const app = express();
  app.disable('x-powered-by');
  app.use(localOnly);
  app.use(secureHeaders);
  app.use(express.json({ limit: '4mb' }));

  // Everything below delegates to whichever engine the host currently holds.
  app.use('/api/workspace', workspaceRouter(host));
  app.use('/api', (req, res, next) => host.api(req, res, next));
  app.post('/mcp', (req, res, next) => host.mcp(req, res, next));
  app.all('/mcp', (_req, res) => res.set('Allow', 'POST').status(405).json({ error: 'Use POST' }));

  app.use(express.static(path.join(host.engine.config.root, 'public'), { extensions: ['html'] }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.code === 'ELOCKED' ? 423 : err.status ?? (err.type === 'entity.parse.failed' ? 400 : 500);
    // A 4xx is the request's fault and its message says so; a 500 is a bug, so it is logged with its stack.
    if (status >= 500) log.warn(`Unexpected error in ${_req.method} ${_req.path}: ${err.stack ?? err.message}`);
    res.status(status).json({ error: err.message, code: err.code, room: err.room });
  });
  return app;
}
