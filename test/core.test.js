import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LockManager } from '../src/core/lockManager.js';
import { Dispatcher } from '../src/core/dispatcher.js';
import { ProviderError } from '../src/core/providers.js';
import { extractJson, parseWorkerOutput } from '../src/core/parse.js';
import { createEngine } from '../src/core/engine.js';
import { JsonRpcPeer } from '../src/protocols/jsonrpc.js';
import { createMcpServer } from '../src/protocols/mcpServer.js';

const tmpDir = (name) => fs.mkdtemp(path.join(os.tmpdir(), `kadhai-${name}-`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const okResult = (text) => ({ text, reasoning: '', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 } });

test('mutex: only one owner inside the critical section at a time', async () => {
  const locks = new LockManager({ lockDir: await tmpDir('locks') });
  let inside = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      locks.withLock('src/app.js', `agent-${i}`, async () => {
        inside += 1;
        peak = Math.max(peak, inside);
        await sleep(10);
        inside -= 1;
      }),
    ),
  );
  assert.equal(peak, 1);
  assert.deepEqual(await locks.list(), []);
});

test('mutex: a held lock blocks others until explicitly released, and is re-entrant for its owner', async () => {
  const locks = new LockManager({ lockDir: await tmpDir('locks') });
  const handle = await locks.acquire('a.txt', 'coder');
  await assert.rejects(locks.acquire('a.txt', 'user', { timeoutMs: 120 }), { code: 'ELOCKED' });

  const again = await locks.acquire('A.TXT'.toLowerCase(), 'coder');
  await again.release();
  await assert.rejects(locks.acquire('a.txt', 'user', { timeoutMs: 80 }), { code: 'ELOCKED' });

  await handle.release();
  const next = await locks.acquire('a.txt', 'user', { timeoutMs: 500 });
  await next.release();
});

test('mutex: locks from a dead process are reclaimed', async () => {
  const lockDir = await tmpDir('locks');
  const locks = new LockManager({ lockDir });
  const handle = await locks.acquire('dead.txt', 'ghost');
  const [file] = await fs.readdir(lockDir);
  const record = JSON.parse(await fs.readFile(path.join(lockDir, file), 'utf8'));
  await fs.writeFile(path.join(lockDir, file), JSON.stringify({ ...record, pid: 2 ** 30, token: 'gone' }));

  const fresh = new LockManager({ lockDir });
  const taken = await fresh.acquire('dead.txt', 'coder', { timeoutMs: 500 });
  await taken.release();
  await handle.release();
});

test('dispatcher: a 429 hot-swaps to the next provider without surfacing an error', async () => {
  const swaps = [];
  const seen = [];
  const dispatcher = new Dispatcher({
    config: {
      limits: { maxRateWaitMs: 50, maxOutputTokens: 100, requestTimeoutMs: 1000 },
      providers: [
        { id: 'gemini', label: 'Gemini', baseUrl: 'x', keys: ['k'], models: ['g1', 'g2'] },
        { id: 'groq', label: 'Groq', baseUrl: 'x', keys: ['k'], models: ['q1'] },
      ],
    },
    bus: { publish: (type, data) => type === 'provider:swap' && swaps.push(data) },
    completion: async (route) => {
      seen.push(route.id);
      if (route.provider === 'gemini') {
        throw new ProviderError('quota', { kind: 'rate_limit', status: 429, retryAfterMs: 60000 });
      }
      return okResult('hello');
    },
  });

  // Tiered interleaving: both providers' best models come before any fallback model.
  assert.deepEqual(dispatcher.routes.map((r) => r.id), ['gemini/g1', 'groq/q1', 'gemini/g2']);

  const out = await dispatcher.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(out.text, 'hello');
  assert.deepEqual(seen, ['gemini/g1', 'groq/q1']);
  assert.equal(swaps.length, 1);
  assert.equal(swaps[0].to, 'groq/q1');

  // The rate-limited route stays benched; the next call goes straight to Groq.
  await dispatcher.chat({ messages: [{ role: 'user', content: 'again' }] });
  assert.equal(seen.at(-1), 'groq/q1');
  assert.equal(dispatcher.status().routes[0].status, 'cooling');
});

test('dispatcher: reports RATE_LIMITED when every route is cooling, and disables bad keys', async () => {
  const make = (kind) =>
    new Dispatcher({
      config: {
        limits: { maxRateWaitMs: 50, maxOutputTokens: 100, requestTimeoutMs: 1000 },
        providers: [{ id: 'groq', label: 'Groq', baseUrl: 'x', keys: ['k'], models: ['m'] }],
      },
      completion: async () => {
        throw new ProviderError('nope', { kind, retryAfterMs: 60000 });
      },
    });
  await assert.rejects(make('rate_limit').chat({ messages: [] }), { code: 'RATE_LIMITED' });
  const bad = make('auth');
  await assert.rejects(bad.chat({ messages: [] }), { code: 'EXHAUSTED' });
  assert.equal(bad.status().routes[0].status, 'disabled');
});

test('parser: file blocks, requests, truncation and JSON extraction', () => {
  const parsed = parseWorkerOutput(
    'ok\n<<<FILE src/a.js>>>\nconst a = 1;\n<<<END>>>\n<<<FILE b.md>>>\n```md\n# hi\n```\n<<<END>>>\n<<<READ c.txt>>>\n<<<DELETE old.js>>>\nSUMMARY: did it',
  );
  assert.deepEqual(parsed.files, [
    { path: 'src/a.js', content: 'const a = 1;\n' },
    { path: 'b.md', content: '# hi\n' },
  ]);
  assert.deepEqual(parsed.reads, ['c.txt']);
  assert.deepEqual(parsed.deletes, ['old.js']);
  assert.equal(parsed.summary, 'did it');
  assert.equal(parsed.truncated, false);

  assert.equal(parseWorkerOutput('<<<FILE a.js>>>\nconst a =').truncated, true);
  assert.deepEqual(parseWorkerOutput('Here:\n```js\nlet x;\n```', ['x.js']).files, [{ path: 'x.js', content: 'let x;\n' }]);
  assert.deepEqual(extractJson('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(extractJson('no json here'), null);
});

test('engine: sandbox, memory.md, a full hub-and-spoke run, and the MCP surface', async (t) => {
  const engine = await createEngine({ workspaceDir: await tmpDir('ws'), mock: true, mcp: false, limits: { execMode: 'off' } });
  t.after(() => engine.close());
  const { workspace, memory, orchestrator, locks } = engine;

  // Sandbox and reserved files.
  assert.throws(() => workspace.resolve('../escape.txt'), /outside the workspace/);
  assert.throws(() => workspace.resolve('.kadhai/locks/x'), /protected/);
  await assert.rejects(workspace.writeFile('memory.md', 'x', { owner: 'user' }), /state engine/);

  // A file locked by an agent rejects everyone else.
  const handle = await locks.acquire('notes.txt', 'coder');
  await assert.rejects(workspace.writeFile('notes.txt', 'x', { owner: 'user', timeoutMs: 100 }), { code: 'ELOCKED' });
  await memory.flush();
  assert.match(await memory.read(), /- notes\.txt — coder/);
  await handle.release();

  // Full run: the Chef plans -> cooks write two files -> the Taster approves.
  const events = [];
  engine.bus.subscribe((e) => events.push(e.type));
  const result = await orchestrator.start('Build a demo page').done;
  assert.equal(result.ok, true, result.reply);
  assert.deepEqual(result.changed, ['demo/app.js', 'demo/index.html']);
  assert.match((await workspace.readFile('demo/index.html')).content, /app\.js/);
  assert.ok(events.includes('provider:swap'), 'the simulated 429 should trigger a hot-swap');
  assert.ok(events.includes('lock:acquired') && events.includes('lock:released'));

  await memory.flush();
  const state = await memory.read();
  assert.match(state, /## Current Objective\nDemo build for: Build a demo page/);
  assert.match(state, /## Active File Locks\n- none/);
  assert.match(state, /## Last Completed Milestone\nFinished/);
  assert.ok(state.length < 700, 'memory.md must stay tiny');

  // The same engine through MCP.
  const replies = [];
  const peer = new JsonRpcPeer({ send: (m) => replies.push(m), ...createMcpServer(engine) });
  await peer.receive({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  await peer.receive({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'workspace_write_file', arguments: { path: 'via-mcp.txt', content: 'hi' } } });
  await peer.receive({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'workspace_read_file', arguments: { path: '../../etc/passwd' } } });
  assert.equal(replies[0].result.protocolVersion, '2025-06-18');
  assert.equal(replies[1].result.isError, false);
  assert.equal((await workspace.readFile('via-mcp.txt')).content, 'hi');
  assert.equal(replies[2].result.isError, true);
});

test('runner: runs in the workspace, honours modes, approval, blocklist and timeout', async () => {
  const { Runner } = await import('../src/core/runner.js');
  const cwd = await tmpDir('run');
  const events = [];
  const make = (limits, extra = {}) =>
    new Runner({ cwd, bus: { publish: (type) => events.push(type) }, limits: { execTimeoutMs: 5000, execOutputChars: 2000, ...limits }, ...extra });

  const auto = make({ execMode: 'auto' });
  await fs.writeFile(path.join(cwd, 'hi.js'), 'console.log(6 * 7, process.env.GROQ_API_KEYS ?? "no-key")');
  process.env.GROQ_API_KEYS = 'secret';
  const ok = await auto.run('node hi.js', { owner: 'coder' });
  delete process.env.GROQ_API_KEYS;
  assert.equal(ok.code, 0);
  assert.equal(ok.output, '42 no-key', 'runs in the workspace and never sees provider keys');
  assert.deepEqual(events.filter((e) => e !== 'exec:output'), ['exec:start', 'exec:end']);

  assert.equal((await auto.run('node -e "process.exit(3)"', { owner: 'coder' })).code, 3);
  await assert.rejects(auto.run('shutdown /s /t 0', { owner: 'coder' }), /Blocked/);
  await assert.rejects(make({ execMode: 'off' }).run('node hi.js', { owner: 'user', trusted: true }), /switched off/);

  const slow = await make({ execMode: 'auto', execTimeoutMs: 400 }).run('node -e "setTimeout(() => {}, 20000)"', { owner: 'coder' });
  assert.equal(slow.timedOut, true);
  assert.ok(slow.durationMs < 5000);

  // ask mode: no dashboard -> refused; with one -> waits for the operator's answer.
  await assert.rejects(make({ execMode: 'ask' }).run('node hi.js', { owner: 'coder' }), /approval/);
  const ask = make({ execMode: 'ask' }, { interactive: true });
  const denied = ask.run('node hi.js', { owner: 'coder' });
  assert.equal(ask.deny(ask.view().pending[0].id), true);
  await assert.rejects(denied, /denied/);
  const approved = ask.run('node hi.js', { owner: 'coder' });
  ask.approve(ask.view().pending[0].id);
  assert.equal((await approved).code, 0);
  // The operator's own commands never wait.
  assert.equal((await ask.run('node hi.js', { owner: 'user', trusted: true })).code, 0);
});

test('runner: a command you keep running has no time limit, announces its address once, and still stops', async () => {
  const { Runner, findLocalUrl, onPath } = await import('../src/core/runner.js');
  const cwd = await tmpDir('keep');
  const events = [];
  const runner = new Runner({ cwd, bus: { publish: (type, data) => events.push({ type, data }) }, limits: { execMode: 'auto', execTimeoutMs: 300, execOutputChars: 2000, keepRunning: 1 } });
  // Prints its address in two pieces (a chunk boundary in the middle) and twice, then waits forever.
  await fs.writeFile(path.join(cwd, 'serve.js'), "process.stdout.write('  Local: http://local'); setTimeout(() => console.log('host:5173/ ready\\nalso http://localhost:9999/'), 100); setInterval(() => {}, 1000);");

  await assert.rejects(runner.run('node serve.js', { owner: 'coder', keep: true }), /type yourself/, 'only the operator keeps things running');
  const job = runner.run('node serve.js', { owner: 'user', trusted: true, keep: true });
  for (let i = 0; i < 60 && !events.some((e) => e.type === 'exec:port'); i++) await new Promise((r) => setTimeout(r, 50));
  const ports = events.filter((e) => e.type === 'exec:port');
  assert.deepEqual(ports.map((e) => e.data.url), ['http://localhost:5173/'], 'found across chunks, announced once');
  assert.equal(runner.view().running[0].url, 'http://localhost:5173/', 'a re-synced dashboard learns it too');
  assert.throws(() => runner.checkKeep({ trusted: true }), /already kept running/, 'a cap on how many');
  await new Promise((r) => setTimeout(r, 500)); // past execTimeoutMs
  assert.equal(runner.view().running.length, 1, 'no time limit');
  runner.kill(runner.view().running[0].id);
  const result = await job;
  assert.equal(result.killed, true);
  assert.equal(result.timedOut, false);

  assert.equal(findLocalUrl('Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...'), 'http://localhost:8000/');
  assert.equal(findLocalUrl('\u001b[1mLocal\u001b[22m: http://localhost:\u001b[1m3000\u001b[22m/app'), 'http://localhost:3000/app', 'colour codes in the middle');
  assert.equal(findLocalUrl('see https://example.com:8080/'), null, 'only this computer');
  assert.equal(onPath('node'), true);
  assert.equal(onPath('cd'), true, 'a shell built-in');
  assert.equal(onPath('kadhai-no-such-program'), false);
  assert.equal(onPath('../node'), false, 'a name, never a path');
});

test('orchestrator: the Coder can run a command and gets its output back', async (t) => {
  const engine = await createEngine({ workspaceDir: await tmpDir('ws'), mock: true, mcp: false, limits: { execMode: 'auto' } });
  t.after(() => engine.close());
  const ran = [];
  engine.bus.subscribe((e) => e.type === 'exec:end' && ran.push(e.data));
  const result = await engine.orchestrator.start('Build a demo page').done;
  assert.equal(result.ok, true, result.reply);
  assert.deepEqual(ran.map((r) => r.owner), ['chef-de-partie', 'head-chef'], 'the cook checked its file, then the Taster verified the plan');
  assert.match(ran[0].command, /^node --check demo\/app\.js$/);
  assert.equal(ran[0].code, 0);
  assert.equal(engine.orchestrator.chat.filter((m) => m.role === 'exec').length, 2);
  assert.deepEqual(parseWorkerOutput('<<<RUN node a.js > out.txt>>>\nSUMMARY: x').runs, ['node a.js > out.txt']);
});

test('providers: a 400 is classified by what it says, since providers disagree on status codes', async () => {
  const { classify } = await import('../src/core/providers.js');
  assert.equal(classify(429), 'rate_limit');
  assert.equal(classify(401), 'auth');
  assert.equal(classify(404), 'not_found');
  assert.equal(classify(503), 'server');
  assert.equal(classify(400, '{"error":{"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}'), 'auth');
  assert.equal(classify(400, '{"error":{"message":"The model `llama3-70b` has been decommissioned","code":"model_decommissioned"}}'), 'not_found');
  assert.equal(classify(400, "This model's maximum context length is 8192 tokens. Please reduce the length of the messages."), 'too_large');
  assert.equal(classify(400, '{"error":{"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded"}}'), 'rate_limit');
  assert.equal(classify(400, '{"error":{"message":"Unsupported parameter: stream_options"}}'), 'bad_request');
});

test('workspace: writing onto a folder, or beneath a file, is refused cleanly', async (t) => {
  const engine = await createEngine({ workspaceDir: await tmpDir('ws'), mock: true, mcp: false, limits: { execMode: 'off' } });
  t.after(() => engine.close());
  const { workspace } = engine;
  await workspace.writeFile('dir/file.txt', 'x', { owner: 'user' });
  await assert.rejects(workspace.writeFile('dir', 'x', { owner: 'user' }), { name: 'WorkspaceError', message: /is a folder/ });
  await assert.rejects(workspace.writeFile('dir/file.txt/deeper.txt', 'x', { owner: 'user' }), { name: 'WorkspaceError', message: /part of that path is a file/ });
  assert.deepEqual(await engine.locks.list(), [], 'a refused write leaves no lock behind');
});
