import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Screen } from '../public/js/vt.js';
import { createEngine } from '../src/core/engine.js';
import { createApp } from '../src/http/app.js';
import { Host } from '../src/http/host.js';

const tmpDir = (name) => fs.mkdtemp(path.join(os.tmpdir(), `kadhai-${name}-`));
const FAKE_PROVIDER = [{ id: 'fake', label: 'Fake', baseUrl: 'x', keys: ['k'], models: ['m'] }];
const text = (screen) => screen.lines.map((l) => l.map((c) => c.c).join('').trimEnd());

// ------------------------------------------------------------ the emulator (public/js/vt.js)

test('vt: text, line breaks, wrapping, colours and erasing', () => {
  const s = new Screen(10, 4, () => {});
  s.write('hello\r\nworld');
  assert.deepEqual(text(s).slice(0, 2), ['hello', 'world']);
  s.write('\r\n0123456789AB');
  assert.deepEqual(text(s).slice(2, 4), ['0123456789', 'AB'], 'a full line wraps');
  s.write('\x1b[1;31mX\x1b[0m');
  const x = s.lines[3][2];
  assert.equal(x.c, 'X');
  assert.equal(x.s.fg, 1);
  assert.equal(x.s.bold, true);
  s.write('\x1b[38;5;200mY\x1b[38;2;1;2;3mZ');
  assert.equal(s.lines[3][3].s.fg, 200);
  assert.equal(s.lines[3][4].s.fg, 'rgb(1,2,3)');
  s.write('\x1b[2;3H\x1b[K');
  assert.equal(text(s)[1], 'wo', 'erase to the end of the line from row 2, column 3');
  s.write('\x1b[2J\x1b[H');
  assert.deepEqual(text(s), ['', '', '', '']);
});

test('vt: scrolling keeps a scrollback; the alternate screen (vim) does not touch it', () => {
  const s = new Screen(8, 3, () => {});
  s.write('one\r\ntwo\r\nthree\r\nfour');
  assert.deepEqual(text(s), ['two', 'three', 'four']);
  assert.deepEqual(s.scrollback.map((l) => l.map((c) => c.c).join('').trimEnd()), ['one']);
  s.write('\x1b[?1049h');
  assert.deepEqual(text(s), ['', '', '']);
  s.write('vim\r\n~\r\n~\r\n~');
  assert.equal(s.scrollback.length, 1, 'the alternate screen never scrolls into the scrollback');
  s.write('\x1b[?1049l');
  assert.deepEqual(text(s), ['two', 'three', 'four'], 'leaving it brings the shell back as it was');
});

test('vt: scroll regions, insert and delete, and the answers ConPTY waits for', () => {
  const replies = [];
  const s = new Screen(6, 4, (r) => replies.push(r));
  s.write('a\r\nb\r\nc\r\nd');
  s.write('\x1b[2;3r\x1b[3;1H\n');
  assert.deepEqual(text(s), ['a', 'c', '', 'd'], 'only rows 2-3 scroll');
  s.write('\x1b[r\x1b[1;1Habcdef\x1b[1;2H\x1b[2P');
  assert.equal(text(s)[0], 'adef');
  s.write('\x1b[1;2H\x1b[2@');
  assert.equal(text(s)[0], 'a  def');
  s.write('\x1b[3;4H\x1b[6n\x1b[c');
  assert.deepEqual(replies, ['\x1b[3;4R', '\x1b[?1;2c']);
  s.write('\x1b]0;a title\x07ok');
  assert.ok(!text(s).join('').includes('title'), 'a window title is skipped, not printed');
  assert.equal(text(s)[2], '   ok');
});

test('vt: a smaller window keeps the cursor line in view', () => {
  const s = new Screen(10, 5, () => {});
  s.write('1\r\n2\r\n3\r\n4\r\n5');
  s.resize(6, 3);
  assert.deepEqual(text(s), ['3', '4', '5']);
  assert.equal(s.y, 2);
  assert.equal(s.lines[0].length, 6);
});

// ------------------------------------------------------------ the server side (src/core/pty.js)

/** A stand-in for node-pty: records what it was given, echoes what is written. */
function fakeSpawn() {
  const made = [];
  const spawn = (file, args, opts) => {
    let onData = () => {};
    let onExit = () => {};
    const p = {
      pid: 999999,
      file,
      opts,
      written: [],
      size: [opts.cols, opts.rows],
      onData: (fn) => (onData = fn),
      onExit: (fn) => (onExit = fn),
      write: (d) => {
        p.written.push(d);
        onData(`echo:${d}`);
      },
      resize: (c, r) => (p.size = [c, r]),
      kill: () => onExit({ exitCode: 0 }),
    };
    made.push(p);
    return p;
  };
  return { spawn, made };
}

test('pty: a shell in the folder, without key-like variables; output arrives as events; closed with the engine', async (t) => {
  const dir = await tmpDir('pty');
  const { spawn, made } = fakeSpawn();
  process.env.SOMETHING_API_KEY = 'secret-value';
  t.after(() => delete process.env.SOMETHING_API_KEY);
  const engine = await createEngine({ workspaceDir: dir, providers: FAKE_PROVIDER, mcp: false, ptySpawn: spawn, limits: { execMode: 'ask' } });
  const events = [];
  engine.bus.subscribe((e) => e.type?.startsWith?.('pty:') && events.push(e));

  const { id } = await engine.terminals.open({ cols: 90, rows: 20 });
  assert.equal(made[0].opts.cwd, engine.workspace.root);
  assert.equal(made[0].opts.env.SOMETHING_API_KEY, undefined, 'keys stay out of the shell');
  assert.equal(made[0].opts.env.TERM, 'xterm-256color');
  engine.terminals.write(id, 'ls\r');
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(events.some((e) => e.type === 'pty:output' && e.data.data.includes('echo:ls')), JSON.stringify(events));
  assert.equal(engine.terminals.replay(id), 'echo:ls\r');
  engine.terminals.resize(id, 120, 40);
  assert.deepEqual(made[0].size, [120, 40]);

  for (let i = 0; i < 3; i++) await engine.terminals.open();
  await assert.rejects(engine.terminals.open(), /At most 4 terminals/);
  await engine.close();
  assert.equal((await engine.terminals.status()).open.length, 0, 'closing the engine closes every shell');
});

test('pty: refused without a dashboard, with commands off, and in the Docker sandbox', async (t) => {
  const dir = await tmpDir('pty-off');
  const plain = await createEngine({ workspaceDir: dir, providers: FAKE_PROVIDER, mcp: false });
  t.after(() => plain.close());
  await assert.rejects(plain.terminals.open(), /only in the dashboard/);

  const { spawn } = fakeSpawn();
  const off = await createEngine({ workspaceDir: dir, providers: FAKE_PROVIDER, mcp: false, ptySpawn: spawn, limits: { execMode: 'off' } });
  t.after(() => off.close());
  await assert.rejects(off.terminals.open(), /switched off/);
  off.runner.mode = 'ask';
  off.runner.sandbox = 'docker';
  await assert.rejects(off.terminals.open(), /Docker sandbox/);
});

test('pty: the routes answer, and only this dashboard can write to a shell', async (t) => {
  const dir = await tmpDir('pty-http');
  const { spawn, made } = fakeSpawn();
  const host = await new Host({
    createEngine,
    options: { workspaceDir: dir, mock: true, mcp: false, ptySpawn: spawn, agentsFile: path.join(dir, 'agents.json'), keysFile: path.join(dir, 'keys.json'), limits: { execMode: 'ask' } },
    settingsFile: path.join(dir, 'settings.json'),
  }).start();
  const server = createApp(host).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.close();
    await host.engine.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const send = (method, url, body, headers = {}) => fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  assert.equal((await (await send('GET', '/pty')).json()).available, true);
  const { id } = await (await send('POST', '/pty', { cols: 80, rows: 24 })).json();
  assert.equal((await send('POST', `/pty/${id}/input`, { data: 'dir\r' })).status, 200);
  assert.deepEqual(made[0].written, ['dir\r']);
  // A page on another origin cannot type into it.
  assert.equal((await send('POST', `/pty/${id}/input`, { data: 'evil\r' }, { origin: 'http://evil.example' })).status, 403);
  assert.deepEqual(made[0].written, ['dir\r']);
  assert.equal((await send('DELETE', `/pty/${id}`)).status, 200);
  assert.equal((await send('POST', `/pty/${id}/input`, { data: 'x' })).status, 404);
});

test('pty: a real shell through node-pty, when it is installed', { timeout: 30000 }, async (t) => {
  let real;
  try {
    real = await import('node-pty');
  } catch {
    return t.skip('node-pty is not installed here');
  }
  const dir = await tmpDir('pty-real');
  const engine = await createEngine({ workspaceDir: dir, providers: FAKE_PROVIDER, mcp: false, ptySpawn: (real.spawn ?? real.default.spawn), limits: { execMode: 'ask' } });
  t.after(() => engine.close());
  let out = '';
  engine.bus.subscribe((e) => e.type === 'pty:output' && (out += e.data.data));
  const { id } = await engine.terminals.open({ cols: 100, rows: 30 });
  await new Promise((r) => setTimeout(r, 1500));
  engine.terminals.write(id, process.platform === 'win32' ? 'echo kadhai-$((6*7))-pty\r' : 'echo kadhai-$((6*7))-pty\r');
  for (let i = 0; i < 50 && !/kadhai-42-pty|kadhai-\$\(\(6\*7\)\)-pty/.test(out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')); i++) await new Promise((r) => setTimeout(r, 200));
  assert.match(out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), /kadhai-(42|\$\(\(6\*7\)\))-pty/, 'the shell ran what was typed and its answer came back');
  engine.terminals.close(id);
});
