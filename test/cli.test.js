import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEngine } from '../src/core/engine.js';
import { createApp } from '../src/http/app.js';
import { Host } from '../src/http/host.js';
import { claimRoom } from '../src/http/rooms.js';
import { createRenderer, markdownLite, colours } from '../src/cli/render.js';

const tmpDir = (name) => fs.mkdtemp(path.join(os.tmpdir(), `kadhai-${name}-`));
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kadhai.js');

/** Run the CLI as a real process, its own data folder so it never touches the user's keys or settings. */
function kadhai(args, { cwd, data, input = null, timeout = 60000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, '--no-color', ...args], { cwd, env: { ...process.env, KADHAI_DATA: data, KADHAI_MCP: 'off' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`kadhai timed out:\n${out}\n${err}`));
    }, timeout);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

test('cli: one task on its own crew, start to finish; the folder is released after', { timeout: 90000 }, async () => {
  const dir = await tmpDir('cli-one');
  const data = await tmpDir('cli-data');
  const { code, out } = await kadhai(['--demo', '--yes', 'build a tiny demo page'], { cwd: dir, data });
  assert.equal(code, 0, out);
  assert.match(out, /own crew, demo models/);
  assert.match(out, /plan Demo build for: build a tiny demo page/);
  assert.match(out, /\[x\] 1\. Create the demo page/);
  assert.match(out, /allowed \(--yes\): node --check demo\/app\.js/);
  assert.match(out, /\[x\] done/);
  await fs.access(path.join(dir, 'demo', 'index.html'));
  await assert.rejects(fs.access(path.join(dir, '.kadhai', 'room.lock')), 'the folder lock is gone');
});

test('cli: with nobody to ask, its own crew\'s commands are refused, never run', { timeout: 90000 }, async () => {
  const dir = await tmpDir('cli-refuse');
  const data = await tmpDir('cli-data');
  const { code, out } = await kadhai(['--demo', 'build a tiny demo page'], { cwd: dir, data });
  assert.equal(code, 0);
  assert.match(out, /not run: nobody here to approve it \(use --yes to allow commands\)/);
  assert.doesNotMatch(out, /\$ node --check/);
});

test('cli: joins the Kadhai that has the folder open; its task runs there and the dashboard sees it', { timeout: 90000 }, async (t) => {
  const dir = await tmpDir('cli-join');
  const data = await tmpDir('cli-data');
  const host = await new Host({
    createEngine,
    options: { workspaceDir: dir, mock: true, mcp: false, interactive: true, agentsFile: path.join(data, 'agents.json'), keysFile: path.join(data, 'keys.json'), limits: { execMode: 'auto' } },
    settingsFile: path.join(data, 'settings.json'),
  }).start();
  const server = createApp(host).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  claimRoom(dir, server.address().port); // as the dashboard does with its own port
  t.after(async () => {
    server.close();
    await host.engine.close();
  });

  const { code, out } = await kadhai(['add a footer'], { cwd: dir, data });
  assert.equal(code, 0, out);
  assert.match(out, new RegExp(`joined the Kadhai at http://127.0.0.1:${server.address().port}`));
  assert.match(out, /\[x\] done/);
  assert.ok(host.engine.orchestrator.chat.some((m) => m.role === 'user' && m.text === 'add a footer'), 'the task ran in the dashboard\'s crew');
});

test('cli: a folder held by another CLI is refused, and bad arguments say why', { timeout: 30000 }, async () => {
  const dir = await tmpDir('cli-held');
  const data = await tmpDir('cli-data');
  await fs.mkdir(path.join(dir, '.kadhai'), { recursive: true });
  await fs.writeFile(path.join(dir, '.kadhai', 'room.lock'), JSON.stringify({ pid: process.pid === 1 ? 2 : process.ppid, port: null }));
  const held = await kadhai(['--demo', 'x'], { cwd: dir, data });
  assert.equal(held.code, 2);
  assert.match(held.err, /open in another Kadhai/);
  const bad = await kadhai(['--flame', 'medium', 'x'], { cwd: dir, data });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--flame is low or high/);
  const help = await kadhai(['--help'], { cwd: dir, data });
  assert.match(help.out, /kadhai "task"/);
});

test('cli: the renderer shows steps as they change, commands, writes and the reply', () => {
  let text = '';
  const render = createRenderer({ out: (s) => (text += s), nameOf: (id) => ({ commis: 'Prep' })[id] ?? id });
  const plan = (status) => ({ type: 'run:plan', data: { runId: 'r1', objective: 'Make it', subtasks: [{ title: 'Page', cook: 'Prep', status, summary: status === 'done' ? 'wrote it' : '' }] } });
  render({ type: 'run:start', data: { runId: 'r1', request: 'make a page' } });
  render(plan('pending'));
  render(plan('working'));
  render({ type: 'fs:write', data: { path: 'index.html', owner: 'commis' } });
  render({ type: 'fs:write', data: { path: 'memory.md', owner: 'system' } });
  render({ type: 'exec:start', data: { id: 'e1', command: 'node --check a.js', owner: 'commis' } });
  render({ type: 'exec:output', data: { id: 'e1', chunk: 'SyntaxError: nope\n' } });
  render({ type: 'exec:end', data: { id: 'e1', code: 1 } });
  render(plan('done'));
  render({ type: 'chat:message', data: { message: { role: 'manager', runId: 'r1', text: 'Built **it** in `index.html`' } } });
  render({ type: 'run:done', data: { runId: 'r1', ok: true, tokens: 1234 } });
  assert.match(text, /plan Make it\n {3}1\. Page \(Prep\)/);
  assert.match(text, / > {2}1\. Page \(Prep\)/);
  assert.match(text, /wrote index\.html \(Prep\)/);
  assert.doesNotMatch(text, /memory\.md/, 'the crew\'s own memory file is not news');
  assert.match(text, /\$ node --check a\.js \(Prep\)\n {6}exit 1\n {6}SyntaxError: nope/);
  assert.match(text, /\[x\] 1\. Page \(Prep\): wrote it/);
  assert.match(text, /Built it in index\.html/);
  assert.match(text, /\[x\] done {2}1,234 tokens/);
  assert.equal(markdownLite('**a** `b`', colours(true)), '\x1b[1ma\x1b[0m \x1b[36mb\x1b[0m');
});
