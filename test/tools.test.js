import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createEngine } from '../src/core/engine.js';
import { globTest, patternOf, replaceInWorkspace, searchWorkspace } from '../src/core/search.js';
import { checkAll, checkFile, isCheckable } from '../src/core/problems.js';
import { createApp } from '../src/http/app.js';
import { Host } from '../src/http/host.js';

const tmpDir = (name) => fs.mkdtemp(path.join(os.tmpdir(), `kadhai-${name}-`));
const FAKE_PROVIDER = [{ id: 'fake', label: 'Fake', baseUrl: 'x', keys: ['k'], models: ['m'] }];

async function engineWith(t, files) {
  const dir = await tmpDir('tools');
  const engine = await createEngine({ workspaceDir: dir, providers: FAKE_PROVIDER, completion: async () => ({ text: '{}', usage: {} }), mcp: false });
  t.after(() => engine.close());
  for (const [rel, content] of Object.entries(files)) await engine.workspace.writeFile(rel, content, { owner: 'user' });
  return { engine, dir };
}

test('search: across the folder, with lines, columns, case, whole words, regex and include/exclude', async (t) => {
  const { engine } = await engineWith(t, {
    'src/app.js': 'const total = 1;\nconsole.log(total);\n// Total is printed\n',
    'src/util.js': 'export const subtotal = 2;\n',
    'README.md': 'The total is shown.\n',
    'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]),
  });
  const ws = engine.workspace;

  const plain = await searchWorkspace(ws, { query: 'total' });
  // In the tree's order: folders first, as the file list shows them.
  assert.deepEqual(plain.files.map((f) => [f.path, f.matches.length]), [['src/app.js', 3], ['src/util.js', 1], ['README.md', 1]], 'every text file, memory.md and the picture left out');
  assert.deepEqual(plain.files[0].matches[1], { line: 2, col: 13, length: 5, text: 'console.log(total);', at: 12, cut: false });
  assert.ok(!plain.files.some((f) => f.path === 'memory.md'));

  assert.equal((await searchWorkspace(ws, { query: 'Total', matchCase: true })).files.length, 1);
  assert.deepEqual((await searchWorkspace(ws, { query: 'total', wholeWord: true })).files.map((f) => f.path), ['src/app.js', 'README.md']);
  const re = await searchWorkspace(ws, { query: 'const (\\w+)', regex: true });
  assert.deepEqual(re.files.map((f) => f.matches[0].text), ['const total = 1;', 'export const subtotal = 2;']);
  assert.deepEqual((await searchWorkspace(ws, { query: 'total', include: '*.js', exclude: 'src/util.js' })).files.map((f) => f.path), ['src/app.js']);
  assert.deepEqual((await searchWorkspace(ws, { query: 'total', include: 'src/' })).files.map((f) => f.path), ['src/app.js', 'src/util.js']);

  assert.throws(() => patternOf({ query: '(' , regex: true }), /not a valid regular expression/);
  assert.throws(() => patternOf({ query: '' }), /Type something/);
  assert.equal(globTest('')?.('x'), undefined);
  assert.ok(globTest('**/*.test.js')('test/a/b.test.js'));
});

test('search: a pattern that backtracks for ever is stopped, and the server goes on answering', { timeout: 30000 }, async (t) => {
  const { engine } = await engineWith(t, { 'slow.txt': `${'a'.repeat(40)}!` });
  const started = Date.now();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 100);
  await assert.rejects(searchWorkspace(engine.workspace, { query: '(a+)+$', regex: true }), /took too long and was stopped/);
  clearInterval(timer);
  assert.ok(ticks > 20, 'the main thread kept running while the worker was stuck');
  assert.ok(Date.now() - started < 15000);
});

test('replace: across files with $1 groups, through Workspace, leaving a file an agent holds alone', async (t) => {
  const { engine, dir } = await engineWith(t, {
    'a.js': 'let count = 1;\nlet countB = 2;\n',
    'b.js': 'count++;\n',
    'held.js': 'count = 0;\n',
  });
  const lock = await engine.locks.acquire('held.js', 'commis');
  t.after(() => lock.release());
  const result = await replaceInWorkspace(engine.workspace, { query: '\\bcount(\\w*)', regex: true }, 'total$1');
  assert.deepEqual(result.changed.sort((x, y) => x.path.localeCompare(y.path)), [{ path: 'a.js', count: 2 }, { path: 'b.js', count: 1 }]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].path, 'held.js');
  assert.equal(await fs.readFile(path.join(dir, 'a.js'), 'utf8'), 'let total = 1;\nlet totalB = 2;\n');
  assert.equal(await fs.readFile(path.join(dir, 'held.js'), 'utf8'), 'count = 0;\n', 'a held file is not touched');

  // Limited to the files the user saw.
  await replaceInWorkspace(engine.workspace, { query: 'total', paths: ['b.js'] }, 'sum');
  assert.equal(await fs.readFile(path.join(dir, 'a.js'), 'utf8'), 'let total = 1;\nlet totalB = 2;\n');
  assert.equal(await fs.readFile(path.join(dir, 'b.js'), 'utf8'), 'sum++;\n');
});

test('problems: JSON and JavaScript syntax errors with their line and column; JSON with comments is not checked', async (t) => {
  const { engine } = await engineWith(t, {
    'ok.js': 'export const a = 1;\n',
    'bad.js': 'const a = 1;\nconst b = ;\n',
    'bad.mjs': "import x from 'y';\nexport default {\n",
    'data.json': '{\n  "a": 1,\n  "b": 2,\n}\n',
    'tsconfig.json': '{ // comments are fine here\n}\n',
    'notes.md': '# not checked',
    // Broken on purpose: node used to stop at it and blame every .js file (first browser check).
    'package.json': '{ "name": "x", }',
  });
  const ws = engine.workspace;
  assert.deepEqual(await checkFile(ws, 'ok.js'), []);
  const [js] = await checkFile(ws, 'bad.js');
  assert.equal(js.line, 2);
  assert.equal(js.col, 11);
  assert.match(js.message, /^SyntaxError: Unexpected token/);
  assert.equal(js.source, 'node --check');
  const [json] = await checkFile(ws, 'data.json');
  assert.equal(json.line, 4);
  assert.equal(json.source, 'JSON');
  assert.deepEqual(await checkFile(ws, 'tsconfig.json'), []);
  assert.ok(!isCheckable('notes.md'));

  const all = await checkAll(ws);
  assert.deepEqual(all.problems.map((p) => p.path), ['bad.js', 'bad.mjs', 'data.json', 'package.json'], 'a broken package.json is its own problem, not every script\'s');
  assert.equal(all.checked, 5, 'the JS and JSON files, not tsconfig.json or the notes');
  await assert.rejects(checkFile(ws, '../outside.js'), /outside|escape|workspace/i);
});

test('routes: quick open, search, replace and problems answer over HTTP', async (t) => {
  const dir = await tmpDir('tools-http');
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
  const send = (method, url, body) => fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  await host.engine.workspace.writeFile('deep/a/b/c/d/e/f/g/h/i/far.js', 'const x = 1\n', { owner: 'user' });
  await host.engine.workspace.writeFile('bad.json', '{"a": }', { owner: 'user' });

  const { paths } = await send('GET', '/files/paths');
  assert.ok(paths.includes('deep/a/b/c/d/e/f/g/h/i/far.js'), 'quick open reaches deeper than the tree');
  const found = await send('GET', `/search?${new URLSearchParams({ q: 'X = 1', case: '' })}`);
  assert.deepEqual(found.files.map((f) => f.path), ['deep/a/b/c/d/e/f/g/h/i/far.js']);
  assert.equal((await send('GET', '/search?q=(&regex=1')).status, 400);
  const replaced = await send('POST', '/search/replace', { query: 'const x', replace: 'let x' });
  assert.equal(replaced.changed.length, 1);
  assert.equal((await host.engine.workspace.readFile('deep/a/b/c/d/e/f/g/h/i/far.js')).content, 'let x = 1\n');
  const { problems } = await send('GET', '/problems?path=bad.json');
  assert.equal(problems[0].source, 'JSON');
  assert.equal((await send('POST', '/problems/scan')).problems.length, 1);
});

test('dispatcher: when every model is resting after a timeout, the run says so (not "rate-limited")', async () => {
  const { Dispatcher } = await import('../src/core/dispatcher.js');
  const { ProviderError } = await import('../src/core/providers.js');
  const completion = async (route) => {
    throw new ProviderError(`${route.label} timed out`, { kind: 'timeout' });
  };
  const d = new Dispatcher({ config: { providers: FAKE_PROVIDER, limits: { maxOutputTokens: 100, requestTimeoutMs: 1000, maxRateWaitMs: 1000 } }, completion });
  await assert.rejects(d.chat({ messages: [{ role: 'user', content: 'hi' }] }), (err) => err.code === 'RATE_LIMITED' && /took too long to answer/.test(err.message) && !/rate-limited/.test(err.message));
});
