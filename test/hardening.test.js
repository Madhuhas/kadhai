import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createEngine } from '../src/core/engine.js';
import { childEnv } from '../src/core/runner.js';
import { McpHub } from '../src/protocols/mcpClient.js';
import { EventBus } from '../src/core/eventBus.js';
import { hasPlainKeys, loadStoredKeys } from '../src/core/keyStore.js';
import { vaultFor } from '../src/core/vault.js';
import { loadConfig, readProviders } from '../src/config.js';
import { createApp, createPreviewApp } from '../src/http/app.js';
import { Host } from '../src/http/host.js';

const tmpDir = (name) => fs.mkdtemp(path.join(os.tmpdir(), `kadhai-${name}-`));
const reply = (text) => ({ text, reasoning: '', finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 } });
const FAKE_PROVIDER = [{ id: 'fake', label: 'Fake', baseUrl: 'x', keys: ['k'], models: ['m'] }];
const CASELESS_DISK = process.platform === 'win32' || process.platform === 'darwin';

/** A crew that writes one file and approves it, for tests that only need a run to happen. */
const simpleCrew = async (_route, req, { role }) => {
  if (role === 'manager') return reply(JSON.stringify({ objective: 'x', subtasks: [{ title: 'a', instructions: 'write it', files: ['a.txt'] }] }));
  if (role === 'reviewer') return reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'fine' }));
  return reply('<<<FILE a.txt>>>\nhello\n<<<END>>>\nSUMMARY: wrote a.txt');
};

const exists = (file) => fs.access(file).then(() => true, () => false);

test('workspace: protected folders and memory.md cannot be reached by another spelling', async (t) => {
  const dir = await tmpDir('spelling');
  const engine = await createEngine({ workspaceDir: dir, agentsFile: path.join(dir, 'agents.json'), mock: true, mcp: false });
  t.after(() => engine.close());
  const { workspace } = engine;

  // On a disk that ignores letter case these are the protected folders themselves.
  for (const spelled of ['.GIT/hooks/pre-commit', '.Kadhai/state.json', 'Node_Modules/x.js', 'src/.Git/config', '.git./config', '.kadhai /git/config']) {
    assert.throws(() => workspace.resolve(spelled), /protected folder|not a valid file name/, spelled);
  }
  if (process.platform === 'win32') {
    // Windows quietly drops trailing dots and spaces, and "name:stream" addresses a hidden stream of the file.
    for (const spelled of ['notes.txt.', 'docs /notes.txt', 'notes.txt:hidden', '.git::$INDEX_ALLOCATION/config']) {
      assert.throws(() => workspace.resolve(spelled), /not a valid file name|protected folder/, spelled);
    }
  }
  if (CASELESS_DISK) {
    await assert.rejects(workspace.writeFile('MEMORY.MD', 'mine now', { owner: 'cook' }), /managed by the state engine/);
    await assert.rejects(workspace.deleteFile('Memory.md', { owner: 'cook' }), /cannot be deleted/);
    await workspace.writeFile('a.txt', 'x', { owner: 'user' });
    await assert.rejects(workspace.move('a.txt', 'Memory.MD', { owner: 'user' }), /cannot be moved or replaced/);
  }
  assert.match(await engine.memory.read(), /## Current Objective/, 'memory.md is still the engine\'s own');
  // Ordinary names that merely resemble them are fine.
  assert.equal(workspace.resolve('docs/git/readme.md').rel, 'docs/git/readme.md');
  assert.equal(workspace.resolve('.gitignore').rel, '.gitignore');
});

test('checkpoints: nothing planted in a folder\'s .kadhai/git can run, and only commit ids reach git', async (t) => {
  const dir = await tmpDir('planted');
  const options = { workspaceDir: dir, agentsFile: path.join(dir, 'agents.json'), providers: FAKE_PROVIDER, completion: simpleCrew, mcp: false, limits: { execMode: 'off' } };
  const first = await createEngine(options);
  if (!first.checkpoints.available) {
    await first.close();
    return t.skip('git is not installed');
  }
  await first.close();

  // Someone hands you a project folder that already carries a shadow repository of their making.
  const gitDir = path.join(dir, '.kadhai', 'git');
  await fs.mkdir(path.join(gitDir, 'hooks'), { recursive: true });
  for (const hook of ['pre-commit', 'post-commit']) {
    await fs.writeFile(path.join(gitDir, 'hooks', hook), `#!/bin/sh\necho ran > "hooked-${hook}.txt"\n`, { mode: 0o755 });
  }
  await fs.appendFile(path.join(gitDir, 'config'), '\n[core]\n\tfsmonitor = "echo ran > hooked-fsmonitor.txt; false"\n');

  const engine = await createEngine(options);
  t.after(() => engine.close());
  const result = await engine.orchestrator.start('write a').done;
  assert.equal(result.ok, true, result.reply);
  const [run] = engine.orchestrator.runsView();
  assert.equal(run.hasDiff, true, 'the checkpoint was still taken');

  for (const marker of ['hooked-pre-commit.txt', 'hooked-post-commit.txt', 'hooked-fsmonitor.txt']) {
    assert.equal(await exists(path.join(dir, marker)), false, `${marker}: a planted command ran`);
  }
  assert.doesNotMatch(await fs.readFile(path.join(gitDir, 'config'), 'utf8'), /fsmonitor/);

  // A saved run list is a file in the folder too: its ids must not be able to pass options to git.
  await assert.rejects(async () => engine.checkpoints.diff('--output=stolen.txt', 'HEAD'), /checkpoint/);
  await assert.rejects(async () => engine.checkpoints.restore('--help'), /checkpoint/);
  assert.equal(await exists(path.join(dir, 'stolen.txt')), false);
  assert.match((await engine.orchestrator.diff(run.id)).patch, /\+hello/);
});

test('runner: child processes get the environment without anything that looks like a secret', () => {
  const env = childEnv({
    PATH: '/usr/bin',
    HOME: '/home/me',
    PATHEXT: '.EXE',
    MONKEY: 'banana',
    GROQ_API_KEY: 'a',
    GEMINI_API_KEYS: 'a,b',
    AWS_SECRET_ACCESS_KEY: 'a',
    MY_APIKEY: 'a',
    GH_TOKEN: 'a',
    GITHUB_PAT: 'a',
    DB_PASSWORD: 'a',
    CLIENT_SECRET: 'a',
    GOOGLE_APPLICATION_CREDENTIALS: 'a',
  });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'MONKEY', 'PATH', 'PATHEXT']);
});

test('orchestrator: plan steps carry the cook\'s id, and a fault while wrapping up cannot wedge the queue', async (t) => {
  const dir = await tmpDir('wedge');
  const engine = await createEngine({ workspaceDir: dir, agentsFile: path.join(dir, 'agents.json'), providers: FAKE_PROVIDER, completion: simpleCrew, mcp: false, limits: { execMode: 'off' } });
  t.after(() => engine.close());
  const { orchestrator, crew, bus } = engine;

  const plans = [];
  bus.subscribe(({ type, data }) => type === 'run:plan' && plans.push(data));

  // The first run's clean-up blows up; a second task is already waiting behind it.
  const settle = crew.settle.bind(crew);
  let broken = true;
  crew.settle = () => {
    if (broken) {
      broken = false;
      throw new Error('clean-up fell over');
    }
    settle();
  };
  const one = orchestrator.start('first');
  const two = orchestrator.start('second');
  assert.equal(two.queued, true);

  const first = await one.done;
  assert.deepEqual([first.ok, first.error], [false, 'ERROR'], 'done resolves, it never rejects');
  assert.match(first.reply, /clean-up fell over/);
  const second = await two.done;
  assert.equal(second.ok, true, second.reply);
  assert.equal(orchestrator.busy, false);

  // The UI colours a step by who has it, so it needs the id, not just the name.
  assert.deepEqual(plans.at(-1).subtasks.map((s) => [s.cook, s.cookId]), [['Cook', 'chef-de-partie']]);
});

test('mcp: stopping a server ends the real process, not just the shell that launched it', async (t) => {
  const dir = await tmpDir('mcp-kill');
  const pidFile = path.join(dir, 'server.pid');
  const script = path.join(dir, 'server.mjs');
  // A minimal MCP server that records its own pid.
  await fs.writeFile(
    script,
    `import fs from 'node:fs';
import readline from 'node:readline';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: {}, serverInfo: { name: 't', version: '1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [] } });
});
setInterval(() => {}, 1000);
`,
  );
  const hub = new McpHub({ configPath: path.join(dir, 'mcp.json'), bus: new EventBus(), version: 'test' });
  t.after(() => hub.close());
  const added = await hub.add({ name: 'pidder', command: [process.execPath, script] });
  assert.equal(added.status, 'ready', added.error ?? '');
  const pid = Number(await fs.readFile(pidFile, 'utf8'));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(alive(), true);

  await hub.remove('pidder');
  for (let i = 0; i < 40 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(), false, 'the server process was left running');
});

test('a workspace opened by its Windows short name (C:\\Users\\RUNNER~1) still works', async (t) => {
  // Seen on GitHub's Windows runners: os.tmpdir() is a short name, and every write was refused as
  // "leaves the workspace through a link" because the root was resolved one way and paths the other.
  if (process.platform !== 'win32') return t.skip('Windows only');
  const { execFileSync } = await import('node:child_process');
  const long = path.join(await tmpDir('short'), 'a folder with a long name');
  await fs.mkdir(long);
  let short = execFileSync('cmd', ['/d', '/c', `for %I in ("${long}") do @echo %~sI`], { windowsVerbatimArguments: true }).toString().trim();
  // A disk may make no short names for new folders; the temp folder itself may still be one (GitHub's runners).
  const { realpathSync } = await import('node:fs');
  const named = (p) => Boolean(p) && p.toLowerCase() !== realpathSync.native(p).toLowerCase();
  if (!named(short)) short = named(long) ? long : null;
  if (!short) return t.skip('no Windows short name to try on this computer');
  const engine = await createEngine({ workspaceDir: short, mock: true, mcp: false, agentsFile: path.join(long, '..', 'agents.json') });
  t.after(() => engine.close());
  await engine.workspace.writeFile('hello.txt', 'hi', { owner: 'test' });
  assert.equal((await engine.workspace.readFile('hello.txt')).content, 'hi');
  assert.equal(await fs.readFile(path.join(long, 'hello.txt'), 'utf8'), 'hi');
});

test('KADHAI_DATA moves every file of the user out of the code folder (the desktop app\'s data folder)', async () => {
  const { execFileSync } = await import('node:child_process');
  const data = await tmpDir('data');
  const script = `import { loadConfig, ROOT, DATA } from './src/config.js';
    const c = loadConfig();
    console.log(JSON.stringify({ ROOT, DATA, c }));`;
  const run = (env) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: path.resolve('.'), env: Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([k, v]) => k !== 'WORKSPACE_DIR' && v !== '')) }).toString());
  const moved = run({ KADHAI_DATA: data });
  const own = ['keysFile', 'connectorsFile', 'agentsFile', 'ownSkillsDir', 'triggersFile', 'flowsFile', 'credentialsFile', 'mcpConfigPath'];
  for (const key of own) assert.equal(path.dirname(moved.c[key]), data, `${key} is in the data folder`);
  assert.equal(moved.c.workspaceDir, path.join(data, 'workspace'));
  assert.equal(moved.c.data, data);
  assert.equal(moved.c.skillsDir, path.join(moved.ROOT, 'skills'), 'the built-in skills stay with the code');
  // Not set: everything stays beside the code, as before.
  const plain = run({ KADHAI_DATA: '' });
  assert.equal(plain.DATA, plain.ROOT);
  for (const key of own) assert.equal(path.dirname(plain.c[key]), plain.ROOT);
});

test('about shows the legal notices the AGPL asks for, and the licence itself can be read', async (t) => {
  const dir = await tmpDir('licence');
  const host = await new Host({
    createEngine,
    options: { workspaceDir: dir, mock: true, mcp: false, agentsFile: path.join(dir, 'agents.json'), keysFile: path.join(dir, 'keys.json') },
    settingsFile: path.join(dir, 'settings.json'),
  }).start();
  const server = createApp(host).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.close();
    await host.engine.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const about = await (await fetch(`${base}/about`)).json();
  assert.equal(about.license, 'AGPL-3.0-or-later');
  assert.match(about.licenseName, /Affero General Public License, version 3 or later/);
  assert.match(about.copyright, /^Copyright \(C\) \d{4} \S/, 'a copyright line with a name');
  const { text } = await (await fetch(`${base}/license`)).json();
  assert.match(text, /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/);
});

test('http: local only, own origin only, and pages may run nothing but this server\'s scripts', async (t) => {
  const dir = await tmpDir('http');
  const host = await new Host({
    createEngine,
    options: { workspaceDir: dir, mock: true, mcp: false, agentsFile: path.join(dir, 'agents.json'), keysFile: path.join(dir, 'keys.json') },
    settingsFile: path.join(dir, 'settings.json'),
  }).start();
  const server = createApp(host).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.close();
    await host.engine.close();
  });
  const { port } = server.address();
  const get = (pathname, headers = {}) =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res));
      }).on('error', reject);
    });

  const page = await get('/');
  assert.equal(page.statusCode, 200);
  const policy = page.headers['content-security-policy'];
  assert.match(policy, /script-src 'self'(;|$)/, 'no inline or foreign scripts');
  assert.match(policy, /frame-ancestors 'none'/);
  // The browser tab may frame pages on this computer, and nothing else.
  const frames = policy.match(/frame-src ([^;]*)/)[1].split(' ');
  assert.ok(frames.every((source) => /^https?:\/\/(localhost|127\.0\.0\.1):\*$/.test(source)), frames.join(' '));
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  // The policy would break the page if it still carried an inline script.
  assert.doesNotMatch(await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'), /<script(?![^>]*\bsrc=)/);

  assert.equal((await get('/api/state')).statusCode, 200);
  assert.equal((await get('/api/state', { host: 'evil.example' })).statusCode, 403, 'a name that merely points at this machine');
  assert.equal((await get('/api/state', { origin: 'http://evil.example' })).statusCode, 403, 'another site');
  assert.equal((await get('/api/state', { origin: `http://127.0.0.1:${port + 1}` })).statusCode, 403, 'the preview port: pages the crew wrote');
  assert.equal((await get('/api/state', { origin: `http://127.0.0.1:${port}` })).statusCode, 200, 'the dashboard itself');

  const send = (method, pathname, body, headers = {}) =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      });
      req.on('error', reject);
      req.end(data);
    });
  // A browser that leaves Origin out still names a cross-site request in Sec-Fetch-Site.
  assert.equal((await send('POST', '/api/exec', { command: 'echo pwned' }, { 'sec-fetch-site': 'cross-site' })).status, 403, 'cross-site, no Origin');
  assert.equal((await send('POST', '/api/exec', { command: 'echo pwned' }, { 'sec-fetch-site': 'same-site' })).status, 403, 'another port of this machine, no Origin');
  assert.equal((await get('/api/state', { 'sec-fetch-site': 'cross-site' })).statusCode, 200, 'reads stay open (the Google sign-in comes back as one)');
  // Task text: a string, and short enough to fit a prompt.
  assert.equal((await send('POST', '/api/task', { text: { a: 1 } })).status, 400, 'not text');
  const long = await send('POST', '/api/task', { text: 'x'.repeat(20001) });
  assert.equal(long.status, 413);
  assert.match(long.text, /Attach long text as a file/);
  // A file list cut short says so.
  const listed = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/files' }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve(JSON.parse(text)));
    }).on('error', reject);
  });
  assert.equal(listed.truncated, false);
});

test('vault: secrets are encrypted on disk, read back, and plain ones from before are sealed in place', async (t) => {
  const dir = await tmpDir('vault');
  const keysFile = path.join(dir, 'keys.local.json');
  const secret = 'gsk_live_PLAINTEXT_SECRET_1234';
  // A key file as an older version left it: plain text.
  await fs.writeFile(keysFile, JSON.stringify({ keys: { groq: [secret] }, models: { groq: ['m1'] } }));
  assert.equal(hasPlainKeys(keysFile), true);

  const engine = await createEngine({ workspaceDir: dir, keysFile, agentsFile: path.join(dir, 'agents.json'), mock: true, mcp: false });
  t.after(() => engine.close());
  const onDisk = await fs.readFile(keysFile, 'utf8');
  assert.ok(!onDisk.includes(secret), 'the key is no longer readable in the file');
  assert.match(onDisk, /"enc:v1:/);
  assert.equal(hasPlainKeys(keysFile), false);
  assert.deepEqual(loadStoredKeys(keysFile).keys, { groq: [secret] }, 'and still comes back whole');
  assert.deepEqual(readProviders(keysFile).map((p) => [p.id, p.keys]), [['groq', [secret]]]);

  // The master key sits beside it; on Windows it is wrapped by the account, so it is not the raw key.
  const vault = vaultFor(keysFile);
  const keyRecord = JSON.parse(await fs.readFile(path.join(dir, 'secret.local.key'), 'utf8'));
  assert.equal(keyRecord.protection, process.platform === 'win32' ? 'dpapi' : 'file');
  assert.equal(vault.protection, keyRecord.protection);

  // Same text twice gives different ciphertext; tampering or a foreign value opens as nothing, never as garbage.
  const [a, b] = [vault.encrypt('same'), vault.encrypt('same')];
  assert.notEqual(a, b);
  assert.deepEqual([vault.decrypt(a), vault.decrypt(b)], ['same', 'same']);
  assert.equal(vault.decrypt(`${a.slice(0, -4)}AAAA`), '');
  assert.equal(vault.decrypt('plain text from before'), 'plain text from before');
  assert.equal(vault.encrypt(''), '');

  // MCP server settings: the token is sealed in the file, and reaches the server as it was typed.
  const hub = new McpHub({ configPath: path.join(dir, 'mcp.json'), bus: new EventBus(), version: 'test' });
  t.after(() => hub.close());
  const probe = path.join(dir, 'probe.mjs');
  await fs.writeFile(probe, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(dir, 'seen.txt'))}, process.env.API_TOKEN ?? ''); setInterval(() => {}, 1000);`);
  await hub.add({ name: 'probe', command: [process.execPath, probe], env: { API_TOKEN: 'tok_SECRET_9' }, startupTimeoutMs: 1500, wait: false });
  const config = await fs.readFile(path.join(dir, 'mcp.json'), 'utf8');
  assert.ok(!config.includes('tok_SECRET_9') && config.includes('enc:v1:'));
  for (let i = 0; i < 40 && !(await exists(path.join(dir, 'seen.txt'))); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await fs.readFile(path.join(dir, 'seen.txt'), 'utf8'), 'tok_SECRET_9');
  assert.deepEqual(hub.status()[0].envKeys, ['API_TOKEN'], 'names only, as before');
});

test('an engine built with the default files never rewrites them', async (t) => {
  // Most tests leave keysFile alone, which means the real keys.local.json: reading it is fine, writing is not.
  const config = loadConfig({ workspaceDir: await tmpDir('defaults') });
  assert.equal(config.sealSecrets, false);
  assert.equal(config.triggers, false);
  assert.equal(loadConfig({ keysFile: path.join(await tmpDir('own'), 'k.json') }).sealSecrets, true);
});

test('an opening marker with no ">>>" at all still opens the block, when the line holds nothing but the path', async () => {
  const { parseWorkerOutput } = await import('../src/core/parse.js');
  // The end of a real answer (gpt-oss-120b on Groq, the Fixer, high flame): every block right except the opener.
  const real = [
    'Thus output:',
    '',
    '<<<FILE login.js',
    "const crypto = require('crypto');",
    '',
    'function checkLogin(username, password) {',
    '  return crypto.timingSafeEqual(Buffer.from(username), Buffer.from(password));',
    '}',
    '',
    'module.exports = { checkLogin };',
    '<<<END>>>',
    'SUMMARY: Resent complete login.js implementing secure scrypt hashing.',
  ].join('\n');
  const parsed = parseWorkerOutput(real, ['login.js']);
  assert.equal(parsed.truncated, false);
  assert.deepEqual(parsed.files.map((f) => f.path), ['login.js']);
  assert.match(parsed.files[0].content, /^const crypto = require\('crypto'\);\n[\s\S]*module\.exports = \{ checkLogin \};\n$/);
  assert.equal(parsed.summary, 'Resent complete login.js implementing secure scrypt hashing.');
  // Only a lone path: words after it mean this is not a marker line, and nothing is guessed.
  const prose = parseWorkerOutput('<<<FILE login.js now follows\nx\n<<<END>>>', []);
  assert.deepEqual(prose.files, []);
  // The same slip on an EDIT opener.
  const edit = parseWorkerOutput('<<<EDIT a.js\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n<<<END>>>', []);
  assert.deepEqual(edit.edits.map((e) => [e.path, e.hunks.length, e.stray]), [['a.js', 1, '']]);
});

test('a RUN whose ">>>" slipped onto the next line still runs; a multi-line command never does', async () => {
  const { parseWorkerOutput } = await import('../src/core/parse.js');
  // From a real answer (gpt-oss-120b on Groq, the Fixer): the check it was told to run, closed one line late.
  const real = [
    '<<<RUN node - <<\'EOF\'',
    "const crypto = require('crypto');",
    'console.log(crypto.randomBytes(16).toString(\'base64\'));',
    'EOF',
    '>>>',
    '<<<RUN node -e "const {checkLogin}=require(\'./login.js\'); if(!checkLogin(\'testuser\',\'password123\')) process.exit(1); console.log(\'ok\');" ',
    '>>>',
    'SUMMARY: Updated login.js to use scrypt and timingSafeEqual; regenerated users.json with salted hash.',
  ].join('\n');
  const parsed = parseWorkerOutput(real, []);
  assert.deepEqual(parsed.runs, ['node -e "const {checkLogin}=require(\'./login.js\'); if(!checkLogin(\'testuser\',\'password123\')) process.exit(1); console.log(\'ok\');"']);
  // The ordinary form, with ">" inside the command, is unchanged.
  assert.deepEqual(parseWorkerOutput('<<<RUN node a.js > out.txt>>>', []).runs, ['node a.js > out.txt']);
});

test('a model that forgets <<<END>>> still gets its file saved, but an answer cut off at the limit never does', async (t) => {
  const { parseWorkerOutput } = await import('../src/core/parse.js');
  const { classify } = await import('../src/core/providers.js');

  // What a small model really sent (from a run on Groq): the whole file, a closing sentence, no <<<END>>>.
  const readme = '<<<FILE README.md>>>\n# FizzBuzz CLI\n\n```bash\nnode cli.js 15\n```\n\nRun the tests with `node --test`.';
  // Not known to be complete: treated as cut off, nothing to save.
  assert.deepEqual([parseWorkerOutput(readme).files.length, parseWorkerOutput(readme).truncated], [0, true]);
  // Known to be complete: the block runs to the end of the answer.
  let parsed = parseWorkerOutput(readme, [], { complete: true });
  assert.deepEqual([parsed.files.length, parsed.truncated], [1, false]);
  assert.equal(parsed.files[0].content, '# FizzBuzz CLI\n\n```bash\nnode cli.js 15\n```\n\nRun the tests with `node --test`.\n');

  // A SUMMARY line or a request after the block is not part of the file.
  parsed = parseWorkerOutput('<<<FILE a.js>>>\nconst a = 1;\nSUMMARY: wrote a.js', [], { complete: true });
  assert.deepEqual([parsed.files[0].content, parsed.summary], ['const a = 1;\n', 'wrote a.js']);
  parsed = parseWorkerOutput('<<<FILE a.js>>>\nconst a = 1;\n<<<RUN node --check a.js>>>', [], { complete: true });
  assert.deepEqual([parsed.files[0].content, parsed.runs], ['const a = 1;\n', ['node --check a.js']]);
  // Earlier blocks that were closed properly are untouched; only the last one is closed for the model.
  parsed = parseWorkerOutput('<<<FILE a.js>>>\none\n<<<END>>>\n<<<FILE b.js>>>\ntwo', [], { complete: true });
  assert.deepEqual(parsed.files.map((f) => [f.path, f.content]), [['a.js', 'one\n'], ['b.js', 'two\n']]);
  // An edit whose last hunk is unfinished is still refused whole, complete or not.
  parsed = parseWorkerOutput('<<<EDIT a.js>>>\n<<<<<<< SEARCH\nconst', [], { complete: true });
  assert.deepEqual([parsed.edits[0].hunks.length, Boolean(parsed.edits[0].stray)], [0, true]);

  // In a run: finish_reason "stop" saves the file in one go; "length" asks for it again in smaller pieces.
  const dir = await tmpDir('noend');
  let finishReason = 'stop';
  const cookPrompts = [];
  const completion = async (_route, req, { role }) => {
    if (role === 'manager') return reply(JSON.stringify({ objective: 'x', subtasks: [{ title: 'readme', instructions: 'write it', files: ['README.md'] }] }));
    if (role === 'reviewer') return reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'fine' }));
    cookPrompts.push(req.messages.at(-1).content);
    if (finishReason === 'length' && cookPrompts.length > 1) return reply('<<<FILE README.md>>>\nshort\n<<<END>>>\nSUMMARY: wrote it');
    return { ...reply(readme), finishReason };
  };
  const engine = await createEngine({ workspaceDir: dir, agentsFile: path.join(dir, 'agents.json'), providers: FAKE_PROVIDER, completion, mcp: false, limits: { execMode: 'off' } });
  t.after(() => engine.close());
  let result = await engine.orchestrator.start('write a readme').done;
  assert.equal(result.ok, true, result.reply);
  assert.equal(cookPrompts.length, 1, 'no round wasted asking for the same file again');
  assert.match((await engine.workspace.readFile('README.md')).content, /^# FizzBuzz CLI[\s\S]*node --test`\.\n$/);

  finishReason = 'length';
  cookPrompts.length = 0;
  result = await engine.orchestrator.start('write a readme again').done;
  assert.equal(result.ok, true, result.reply);
  assert.equal(cookPrompts.length, 2);
  assert.match(cookPrompts[1], /ran out of room in the middle of a block, so that block was NOT saved/);
  assert.equal((await engine.workspace.readFile('README.md')).content, 'short\n', 'the half-sent file was never written');

  // Groq answers 429 both for "slow down" and for "this one request is too big for the model": only the first is worth waiting for.
  assert.equal(classify(429, 'Rate limit reached for model `x` on tokens per minute (TPM)'), 'rate_limit');
  assert.equal(classify(429, 'Request too large for model `x` on output tokens per minute (TPM): Limit 6000, Requested 8192'), 'too_large');
});

test('parser: what real models get slightly wrong is still understood', async () => {
  const { parseWorkerOutput, applyEdits } = await import('../src/core/parse.js');
  // Taken from answers of openai/gpt-oss-120b on Groq.
  const twoBrackets = '<<<FILE graph.md>>\n## Kadhai\n**Type:** project\n<<<END>>>\nSUMMARY: Created graph.md.';
  let parsed = parseWorkerOutput(twoBrackets);
  assert.deepEqual([parsed.files.map((f) => [f.path, f.content]), parsed.truncated, parsed.summary], [[['graph.md', '## Kadhai\n**Type:** project\n']], false, 'Created graph.md.']);

  const longMarker = '<<<EDIT graph.md>>>\n<<<<<<< SEARCH\n=======\n**Type:** project\n>>>>>>>>>> REPLACE\n<<<END>>>';
  parsed = parseWorkerOutput(longMarker);
  assert.deepEqual([parsed.edits[0].hunks, parsed.edits[0].stray], [[{ search: '', replace: '**Type:** project' }], '']);
  assert.equal(applyEdits('## Kadhai\n', parsed.edits[0].hunks).content, '## Kadhai\n**Type:** project\n');

  // The same tool call written twice is made once; two different calls are both made.
  const twice = '<<<TOOL memory__read_graph>>>{"query":""}<<<END>>><<<TOOL memory__read_graph>>>{"query":""}<<<END>>>\n<<<TOOL memory__search_nodes>>>{"query":"x"}<<<END>>';
  assert.deepEqual(parseWorkerOutput(twice).tools.map((c) => c.name), ['memory__read_graph', 'memory__search_nodes']);

  // Commands keep their own ">" signs, whatever the bracket count around them.
  assert.deepEqual(parseWorkerOutput('<<<RUN echo a >> log.txt>>>\n<<<RUN node -e "1>0">>\n<<<READ a.js>>\n<<<DELETE b.js>>>').runs, ['echo a >> log.txt', 'node -e "1>0"']);
  assert.deepEqual(parseWorkerOutput('<<<READ a.js>>\n<<<DELETE b.js>>>').reads, ['a.js']);
  // What is still refused: a block that is opened and never closed, in an answer not known to be complete.
  assert.equal(parseWorkerOutput('<<<FILE a.js>>\nconst a =').truncated, true);
});

test('about: says what this copy is and what is set up, and carries nothing secret', async (t) => {
  const dir = await tmpDir('about');
  const keysFile = path.join(dir, 'keys.json');
  const engine = await createEngine({ workspaceDir: dir, keysFile, agentsFile: path.join(dir, 'agents.json'), flowsFile: path.join(dir, 'flows.json'), triggersFile: path.join(dir, 'triggers.json'), verifyKey: async () => ({ rejected: false, verified: true, models: [] }), completion: async () => ({}), mcp: false });
  t.after(() => engine.close());
  await engine.keys.add('groq', 'gsk_SECRET_KEY_1234567890');
  const hook = await engine.triggers.add({ type: 'webhook', name: 'inbox' });
  await engine.hiring.hire({ name: 'Pastry Chef', specialty: 'CSS and layout' });

  const about = engine.about();
  assert.match(about.version, /^\d+\.\d+\.\d+(-[\w.]+)?$/, 'a version, maybe a pre-release such as 1.0.0-beta.1');
  assert.deepEqual([about.name, about.license, about.mock, about.execMode, about.sandbox], ['Kadhai', 'AGPL-3.0-or-later', false, 'ask', 'none']);
  assert.equal(about.workspaceDir, dir);
  assert.match(about.node, /^v\d+/);
  assert.ok(Date.now() - about.startedAt < 60000);
  assert.deepEqual(about.providers, ['Groq']);
  assert.deepEqual([about.counts.agents, about.counts.hired, about.counts.triggers, about.counts.flows, about.counts.paidRoutes], [7, 1, 1, 0, 0]);
  assert.ok(about.counts.routes >= 1 && about.counts.skills >= 10);
  assert.ok(['dpapi', 'file'].includes(about.secrets), 'how saved secrets are protected, not the secrets');
  const text = JSON.stringify(about);
  for (const secret of ['gsk_SECRET_KEY_1234567890', hook.token]) assert.ok(!text.includes(secret));
});

test('rooms: a second folder opens in a process of its own, a folder is only ever open once, and rooms come back', async (t) => {
  const { spawn } = await import('node:child_process');
  const { Rooms, RoomsProxy, roomHolder, MAX_ROOMS } = await import('../src/http/rooms.js');
  const base = await tmpDir('rooms');
  const [first, second, third] = await Promise.all(['one', 'two', 'three'].map(async (name) => {
    const dir = path.join(base, name);
    await fs.mkdir(dir);
    return dir;
  }));
  const roomsDir = path.join(base, 'rooms.local');
  const settingsFile = path.join(base, 'settings.json');
  const options = { workspaceDir: first, mock: true, mcp: false, agentsFile: path.join(base, 'agents.json'), keysFile: path.join(base, 'keys.json') };
  const host = await new Host({ createEngine, options, settingsFile }).start();
  t.after(() => host.close());

  // ---- the mark a room leaves in its folder
  assert.equal(JSON.parse(await fs.readFile(path.join(first, '.kadhai', 'room.lock'), 'utf8')).pid, process.pid);
  assert.equal(roomHolder(first), null, 'our own mark is not "another room"');
  // Another live process holds the second folder: this room may not move there.
  await fs.mkdir(path.join(second, '.kadhai'), { recursive: true });
  await fs.writeFile(path.join(second, '.kadhai', 'room.lock'), JSON.stringify({ pid: process.ppid, port: 5555 }));
  assert.equal(roomHolder(second).port, 5555);
  await assert.rejects(host.open(second), /already open in another kitchen \(http:\/\/localhost:5555\)/);
  // A mark left by a process that is gone does not count.
  await fs.writeFile(path.join(second, '.kadhai', 'room.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, port: 5555 }));
  assert.equal(roomHolder(second), null);
  await host.open(second);
  assert.equal(JSON.parse(await fs.readFile(path.join(second, '.kadhai', 'room.lock'), 'utf8')).pid, process.pid);
  assert.equal(await exists(path.join(first, '.kadhai', 'room.lock')), false, 'moving on lets go of the old folder');
  await host.open(first);

  // ---- rooms: a stand-in for the real child server, which answers on its port like one
  const port = 21000 + Math.floor(Math.random() * 3000) * 2;
  const script = `require('http').createServer((q, s) => s.end('{}')).listen(process.env.PORT, '127.0.0.1'); process.stdin.resume();`;
  const launched = [];
  const launch = (record) => {
    launched.push(record);
    return spawn(process.execPath, ['-e', script], { env: { ...process.env, PORT: String(record.port) }, stdio: ['pipe', 'pipe', 'pipe'] });
  };
  await fs.writeFile(path.join(base, 'agents.local.json'), JSON.stringify({ agents: [{ id: 'pastry-chef', name: 'Pastry Chef', specialty: 'CSS and layout' }] }));
  const rooms = new Rooms({ root: base, host, port, serverFile: 'unused', dir: roomsDir, launch });
  host.rooms = rooms;
  assert.deepEqual(rooms.list().map((r) => [r.id, r.main, r.dir, r.state]), [['main', true, first, 'running']]);

  await assert.rejects(rooms.open('relative/path'), /full path/);
  await assert.rejects(rooms.open(path.join(base, 'nowhere')), /does not exist/);
  await assert.rejects(rooms.open(first), (err) => err.status === 409 && /already open in the first kitchen/.test(err.message) && err.room.id === 'main');

  const room = await rooms.open(second);
  assert.match(room.id, /^[0-9a-f]{6}$/);
  assert.deepEqual([room.dir, room.name, room.port, room.url, room.state, room.main], [second, 'two', port + 10, `http://localhost:${port + 10}`, 'running', false]);
  assert.equal((await fetch(`${room.url.replace('localhost', '127.0.0.1')}/api/workspace`)).ok, true, 'the room answers on its own port');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(roomsDir, `${room.id}.json`), 'utf8')), { id: room.id, port: port + 10, workspaceDir: second });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(roomsDir, `${room.id}.agents.json`), 'utf8')).agents[0].id, 'pastry-chef', 'it starts with the specialists hired so far');
  await assert.rejects(rooms.open(second), (err) => err.status === 409 && err.room.id === room.id);
  assert.deepEqual(rooms.list().map((r) => r.name), ['one', 'two']);

  // A second extra room gets the next pair of ports.
  const other = await rooms.open(third);
  assert.equal(other.port, port + 20);

  // ---- from inside an extra room, the list and the buttons are the first room's
  const server = createApp(host).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const proxy = new RoomsProxy({ lobby: `http://127.0.0.1:${server.address().port}`, id: room.id });
  assert.deepEqual((await proxy.list()).map((r) => [r.name, r.here]), [['one', true], ['two', false], ['three', false]]);
  await assert.rejects(proxy.open(third), (err) => err.status === 409 && err.room?.id === other.id, 'the refusal says which room has the folder');
  assert.throws(() => proxy.close(room.id), /cannot close itself/);
  await assert.rejects(new RoomsProxy({ lobby: 'http://127.0.0.1:9', id: 'x' }).list(), /first kitchen is not answering/);

  // ---- closing a room ends its process and forgets it; the folder is untouched
  await proxy.close(other.id);
  assert.deepEqual(rooms.list().map((r) => r.name), ['one', 'two']);
  assert.equal(await exists(path.join(roomsDir, `${other.id}.json`)), false);
  await assert.rejects(rooms.close(other.id), /No such kitchen/);
  await assert.rejects(rooms.close('main'), /first kitchen is Kadhai itself/);
  const gone = async (p) => {
    for (let i = 0; i < 40; i++) {
      try {
        await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(300) });
      } catch {
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  assert.equal(await gone(other.port), true, 'its process is gone');
  assert.equal(await exists(third), true);

  // ---- the server stops: rooms stop with it, and are brought back by the next one
  rooms.stopAll();
  assert.equal(await gone(room.port), true);
  launched.length = 0;
  const again = new Rooms({ root: base, host, port, serverFile: 'unused', dir: roomsDir, launch });
  t.after(() => again.stopAll());
  await again.start();
  assert.deepEqual(launched.map((r) => [r.id, r.workspaceDir, r.port]), [[room.id, second, port + 10]]);
  assert.deepEqual(again.list().map((r) => r.name), ['one', 'two']);
  assert.ok(MAX_ROOMS >= 2);
});

test('preview: a folder with no index.html lists its files, escaped, with dot-files hidden', async (t) => {
  const dir = await tmpDir('preview');
  await fs.mkdir(path.join(dir, 'site'));
  await fs.writeFile(path.join(dir, 'site', 'index.html'), '<p>home</p>');
  await fs.writeFile(path.join(dir, "a&b'c.html"), 'x');
  await fs.writeFile(path.join(dir, '.env'), 'SECRET=1');
  const host = await new Host({
    createEngine,
    options: { workspaceDir: dir, mock: true, mcp: false, agentsFile: path.join(dir, 'agents.json'), keysFile: path.join(dir, 'keys.json') },
    settingsFile: path.join(dir, 'settings.json'),
  }).start();
  const server = createPreviewApp(host).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.close();
    await host.engine.close();
  });
  const { port } = server.address();
  const get = (pathname) =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });

  const root = await get('/');
  assert.equal(root.status, 200);
  assert.match(root.body, /href="site\/"/);
  assert.match(root.body, />a&amp;b&#39;c\.html</, 'a file name is text, never markup');
  assert.doesNotMatch(root.body, /\.env/, 'dot-files stay hidden');
  // A page gets the error reporter at the top of its head (or of the page, with no head).
  assert.equal((await get('/site/')).body, '<script src="/__kadhai/errors.js"></script><p>home</p>', 'an index.html still wins');
  await fs.writeFile(path.join(dir, 'site', 'full.html'), '<html><head><title>t</title></head><body></body></html>');
  assert.match((await get('/site/full.html')).body, /^<html><head><script src="\/__kadhai\/errors\.js"><\/script><title>/);
  const reporter = await get('/__kadhai/errors.js');
  assert.equal(reporter.status, 200);
  assert.match(reporter.body, /window\.parent === window\) return/, 'does nothing outside a frame');
  assert.doesNotMatch(reporter.body, /fetch|XMLHttpRequest|localStorage|document\.cookie/, 'it only ever sends a message to the frame around it');
  assert.equal((await get('/a&b\'c.html')).body, '<script src="/__kadhai/errors.js"></script>x');
  assert.equal((await get('/nothing/')).status, 404);
  assert.equal((await get('/.kadhai/')).status, 404);
  assert.equal((await get('/.env')).status, 404);
});

test('a connection whose sign-in was not finished is not started again by itself (it opened a browser tab on every start)', async (t) => {
  const dir = await tmpDir('signin');
  const configPath = path.join(dir, 'mcp.json');
  const started = path.join(dir, 'started.txt');
  // Behaves like mcp-remote with no saved sign-in: asks for one on stderr, then never answers.
  const asker = path.join(dir, 'asker.mjs');
  const ask = JSON.stringify('\nPlease authorize this client by visiting:\nhttps://auth.example.com/authorize?client=1\n');
  await fs.writeFile(asker, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(started)}, 'x'); process.stderr.write(${ask}); setInterval(() => {}, 1000);`);

  const hub = new McpHub({ configPath, bus: new EventBus(), version: 'test' });
  t.after(() => hub.close());
  await hub.add({ name: 'canvaish', command: [process.execPath, asker], startupTimeoutMs: 1500 });
  assert.equal(hub.status()[0].status, 'signin');
  assert.match(hub.status()[0].error, /sign-in was not finished/);
  assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).mcpServers.canvaish.needsSignIn, true, 'remembered');
  hub.close();

  // The next start of Kadhai: listed, waiting, and not started.
  const next = new McpHub({ configPath, bus: new EventBus(), version: 'test' });
  t.after(() => next.close());
  await next.loadConfig();
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(next.status()[0].status, 'signin');
  assert.equal(await fs.readFile(started, 'utf8'), 'x', 'started once, by the add - not again');

  // "Sign in" starts it: the user asked.
  await next.restart('canvaish');
  assert.equal(await fs.readFile(started, 'utf8'), 'xx');

  // A server that comes up clears the mark.
  const ok = path.join(dir, 'ok.mjs');
  await fs.writeFile(ok, "import readline from 'node:readline'; const rl = readline.createInterface({ input: process.stdin }); rl.on('line', (l) => { const m = JSON.parse(l); if (m.id === undefined) return; const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'ok', version: '1' } } : { tools: [] }; process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + String.fromCharCode(10)); });");
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.mcpServers.canvaish = { ...config.mcpServers.canvaish, command: process.execPath, args: [ok] };
  await fs.writeFile(configPath, JSON.stringify(config));
  const third = new McpHub({ configPath, bus: new EventBus(), version: 'test' });
  t.after(() => third.close());
  await third.loadConfig();
  assert.equal(third.status()[0].status, 'signin', 'still waits until asked');
  await third.restart('canvaish');
  assert.equal(third.status()[0].status, 'ready');
  assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).mcpServers.canvaish.needsSignIn, undefined, 'cleared once it connects');
});

test('a check command is run whole or not at all - never cut short', async () => {
  // Seen on a real run: a Groq Chef wrote a 330-character node -e check; it was cut at 300 with "…",
  // failed as broken JavaScript every time, and the run was reported failed although the work was fine.
  const long = `node -e "${'var a=1;  '.repeat(35)}process.exit(0)"`;
  const tooLong = `node -e "${'var a=1;  '.repeat(110)}process.exit(0)"`;
  assert.ok(long.length > 300 && long.length <= 1000 && tooLong.length > 1000);
  for (const [verify, expected] of [
    [long, /\*\*Verify:\*\* `node -e .*process\.exit\(0\)"` — passed/],
    [tooLong, null],
  ]) {
    const dir = await tmpDir('verify');
    const engine = await createEngine({
      workspaceDir: path.join(dir, 'ws'),
      agentsFile: path.join(dir, 'agents.json'),
      providers: FAKE_PROVIDER,
      completion: async (_route, req, { role }) => {
        if (role === 'manager') return reply(JSON.stringify({ objective: 'x', verify, subtasks: [{ title: 'a', instructions: 'a', files: ['a.js'] }] }));
        if (role === 'reviewer') return reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'ok' }));
        return reply('<<<FILE a.js>>>\nconst a = 1;\n<<<END>>>\nSUMMARY: ok');
      },
      mcp: false,
      limits: { execMode: 'auto' },
    });
    const result = await engine.orchestrator.start('go').done;
    await engine.close();
    assert.equal(result.ok, true, result.reply);
    if (expected) assert.match(result.reply, expected);
    else assert.doesNotMatch(result.reply, /Verify:/, 'a check too long to be sane is dropped');
  }
});

test('preview: a link in the folder that leads outside it serves nothing from out there', async (t) => {
  const dir = await tmpDir('previewlink');
  const outside = await tmpDir('outside');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'SECRET-FROM-OUTSIDE');
  await fs.writeFile(path.join(dir, 'ok.txt'), 'inside');
  // A junction needs no special rights on Windows; elsewhere it is an ordinary directory link.
  await fs.symlink(outside, path.join(dir, 'escape'), 'junction');
  const host = await new Host({
    createEngine,
    options: { workspaceDir: dir, mock: true, mcp: false, agentsFile: path.join(dir, 'agents.json'), keysFile: path.join(dir, 'keys.json') },
    settingsFile: path.join(dir, 'settings.json'),
  }).start();
  const server = createPreviewApp(host).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.close();
    await host.engine.close();
  });
  const { port } = server.address();
  const get = (pathname) =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });
  assert.equal((await get('/ok.txt')).body, 'inside');
  const leaked = await get('/escape/secret.txt');
  assert.equal(leaked.status, 404);
  assert.doesNotMatch(leaked.body, /SECRET-FROM-OUTSIDE/);
  assert.equal(await host.engine.workspace.staysInside('escape/secret.txt'), false);
  assert.equal(await host.engine.workspace.staysInside('ok.txt'), true);
  assert.equal(await host.engine.workspace.staysInside('../x'), false);
});

test('a FILE block that still carries a piece of a marker is refused, not saved', async (t) => {
  const { parseWorkerOutput } = await import('../src/core/parse.js');
  // Seen with a real model (2026-10-22): login.test.js was saved with a lone ">>>" line before <<<END>>>,
  // and its tests could not even load. The exact answer was not kept; these are the three shapes that leak.
  const stray = (text) => parseWorkerOutput(text, [], { complete: true }).files.map((f) => f.stray ?? '');
  assert.deepEqual(stray("<<<FILE login.test.js>>>\nimport test from 'node:test';\n>>>\n<<<END>>>"), ['last line']);
  assert.deepEqual(stray("<<<FILE login.test.js\n>>>\nimport test from 'node:test';\n<<<END>>>"), ['first line']);
  assert.deepEqual(stray("<<<FILE login.test.js>>>\ntest('x', () => {});>>>\n<<<END>>>"), ['last line']);
  // Real code with >>> in it is left alone.
  assert.deepEqual(stray('<<<FILE a.py>>>\n"""\n>>> add(1, 2)\n3\n"""\n<<<END>>>'), ['']);
  assert.deepEqual(stray('<<<FILE b.js>>>\nconst y = x >>> 1;\n<<<END>>>'), ['']);
  assert.deepEqual(stray('<<<FILE c.txt>>>\nnote\n>>>>>>> branch\n<<<END>>>'), ['']);

  // In a run: the cook is told, nothing is written, and its next answer is saved.
  const dir = await tmpDir('stray');
  const cookPrompts = [];
  let slips = 1;
  const completion = async (_route, req, { role }) => {
    if (role === 'manager') return reply(JSON.stringify({ objective: 'x', subtasks: [{ title: 'test', instructions: 'write the test', files: ['login.test.js'] }] }));
    if (role === 'reviewer') return reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'fine' }));
    cookPrompts.push(req.messages.at(-1).content);
    if (slips-- > 0) return reply("<<<FILE login.test.js>>>\nimport test from 'node:test';\n>>>\n<<<END>>>\nSUMMARY: wrote it");
    return reply("<<<FILE login.test.js>>>\nimport test from 'node:test';\n<<<END>>>\nSUMMARY: wrote it");
  };
  const engine = await createEngine({ workspaceDir: dir, agentsFile: path.join(dir, 'agents.json'), providers: FAKE_PROVIDER, completion, mcp: false, limits: { execMode: 'off' } });
  t.after(() => engine.close());
  assert.equal((await engine.orchestrator.start('add a login test').done).ok, true);
  assert.equal(cookPrompts.length, 2);
  assert.match(cookPrompts[1], /stray ">>>" on its last line, so it was NOT saved/);
  assert.equal((await engine.workspace.readFile('login.test.js')).content, "import test from 'node:test';\n");
});
