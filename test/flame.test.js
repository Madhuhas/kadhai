import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createEngine } from '../src/core/engine.js';
import { Host } from '../src/http/host.js';
import { HIGH, limitsFor } from '../src/core/flame.js';
import { rawSkillUrl } from '../src/core/skillImport.js';

const tmpDir = (name) => fs.mkdtemp(path.join(os.tmpdir(), `kadhai-${name}-`));
const reply = (text) => ({ text, reasoning: '', finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 } });

test('flame: low keeps the configured limits; high raises every bound, never lowers one, and puts strong routes first', async (t) => {
  const dir = await tmpDir('flame');
  const skillsDir = path.join(dir, 'skills');
  await fs.mkdir(skillsDir);
  for (let i = 1; i <= 6; i++) await fs.writeFile(path.join(skillsDir, `s${i}.md`), `---\nname: S${i}\ndescription: skill ${i}\n---\nSKILL-${i}-${'y'.repeat(2000)}\n`);

  const seen = { routes: [], cookSystem: '' };
  const completion = async (route, req, { role }) => {
    if (role === 'manager') return reply(JSON.stringify({ objective: 'x', subtasks: [{ title: 'a', instructions: 'write it', files: ['a.txt'] }] }));
    if (role === 'reviewer') return reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'fine' }));
    seen.routes.push(route.model);
    seen.cookSystem = req.messages[0].content;
    return reply('<<<FILE a.txt>>>\nhello\n<<<END>>>\nSUMMARY: wrote a.txt');
  };
  // A free route first in the table, a paid one second.
  const providers = [
    { id: 'free', label: 'Free', baseUrl: 'x', keys: ['k'], models: ['f1'] },
    { id: 'paid', label: 'Paid', baseUrl: 'x', keys: ['k'], models: ['p1'], paid: true },
  ];
  const engine = await createEngine({ workspaceDir: path.join(dir, 'ws'), agentsFile: path.join(dir, 'agents.json'), skillsDir, ownSkillsDir: path.join(dir, 'own'), providers, completion, mcp: false, limits: { execMode: 'off', maxSubtasks: 12 } });
  t.after(() => engine.close());
  const events = [];
  engine.bus.subscribe((e) => e.type === 'flame:update' && events.push(e.data.flame));

  // Low flame is what was configured, plus the small extras.
  assert.equal(engine.flame, 'low');
  const low = { ...engine.config.limits };
  assert.equal(low.maxSubtasks, 12, 'a number raised in the config stays');
  assert.deepEqual([low.maxReviewRounds, low.maxOutputTokens, low.skillsPerAgent, low.skillChars, low.strongFirst], [1, 4096, 3, 900, false]);

  // Up to five skills may be chosen; low flame carries the first three, 900 characters each.
  assert.throws(() => engine.crew.configure('chef-de-partie', { skills: ['s1', 's2', 's3', 's4', 's5', 's6'] }), /at most 5 skills/);
  await engine.hiring.configure('chef-de-partie', { skills: ['s1', 's2', 's3', 's4', 's5'] });
  assert.equal((await engine.orchestrator.start('write a').done).ok, true);
  assert.deepEqual(seen.routes, ['f1'], 'low flame walks the table as it is');
  assert.deepEqual([1, 2, 3, 4, 5].map((i) => seen.cookSystem.includes(`SKILL-${i}-`)), [true, true, true, false, false]);
  assert.ok(seen.cookSystem.includes(`SKILL-1-${'y'.repeat(800)}`) && !seen.cookSystem.includes('y'.repeat(901)), 'clipped at 900');

  // High flame: every bound at least as big, paid first, all five skills, far longer.
  engine.setFlame('high');
  assert.deepEqual(events, ['high']);
  const high = engine.config.limits;
  for (const [key, value] of Object.entries(HIGH)) {
    if (typeof value === 'number') assert.ok(high[key] >= value && high[key] >= (low[key] ?? 0), key);
  }
  assert.equal(high.maxSubtasks, 12, 'high never goes below what was configured');
  seen.routes.length = 0;
  assert.equal((await engine.orchestrator.start('write a again').done).ok, true);
  assert.deepEqual(seen.routes, ['p1'], 'the paid route first');
  assert.deepEqual([1, 2, 3, 4, 5].map((i) => seen.cookSystem.includes(`SKILL-${i}-`)), [true, true, true, true, true]);
  assert.ok(seen.cookSystem.includes(`SKILL-1-${'y'.repeat(2000)}`), 'whole');
  assert.equal(engine.about().flame, 'high');
  assert.equal((await engine.snapshot()).app.flame, 'high');

  // And back: exactly the configured limits again.
  engine.setFlame('low');
  assert.deepEqual({ ...engine.config.limits }, low);
  assert.throws(() => engine.setFlame('medium'), /"low" or "high"/);
  assert.deepEqual(limitsFor('high', {}).strongFirst, true);
});

test('flame: kept by the main window for every room; a room may have its own, and go back to following', async (t) => {
  const dir = await tmpDir('flamehost');
  const mainFile = path.join(dir, 'settings.json');
  const roomFile = path.join(dir, 'room.json');
  await fs.writeFile(roomFile, JSON.stringify({ id: 'r1', port: 4757 }));
  const options = (name) => ({ workspaceDir: path.join(dir, name), mock: true, mcp: false, agentsFile: path.join(dir, `${name}-agents.json`), keysFile: path.join(dir, 'keys.json') });
  await fs.mkdir(path.join(dir, 'a'));
  await fs.mkdir(path.join(dir, 'b'));
  const main = await new Host({ createEngine, options: options('a'), settingsFile: mainFile }).start();
  const room = await new Host({ createEngine, options: options('b'), settingsFile: roomFile, globalSettingsFile: mainFile }).start();
  t.after(async () => {
    await main.close();
    await room.close();
  });

  assert.deepEqual(main.flameInfo(), { flame: 'low', room: false, own: false, shared: 'low' });
  await assert.rejects(main.setFlame(null), /"low" or "high"/, 'the main window has nothing to follow');

  // The main window's choice reaches the room (it watches the shared file).
  await main.setFlame('high');
  assert.equal(main.engine.flame, 'high');
  for (let i = 0; i < 60 && room.engine.flame !== 'high'; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(room.engine.flame, 'high');

  // A room's own choice wins, and is kept in its own file next to its id and port.
  await room.setFlame('low');
  assert.deepEqual(room.flameInfo(), { flame: 'low', room: true, own: true, shared: 'high' });
  assert.deepEqual(JSON.parse(await fs.readFile(roomFile, 'utf8')), { id: 'r1', port: 4757, flame: 'low' });
  assert.equal(main.engine.flame, 'high', 'other rooms are not touched');

  // null: follow the main window again.
  assert.deepEqual(await room.setFlame(null), { flame: 'high', room: true, own: false, shared: 'high' });
  assert.deepEqual(JSON.parse(await fs.readFile(roomFile, 'utf8')), { id: 'r1', port: 4757 });

  // The flame outlives a folder switch.
  await fs.mkdir(path.join(dir, 'c'));
  await main.open(path.join(dir, 'c'));
  assert.equal(main.engine.flame, 'high');
});

test('skill import: links become raw files; a short skill is taken whole, a long one condensed by the Chef', async (t) => {
  assert.equal(rawSkillUrl('https://github.com/o/r/blob/main/plugins/p/skills/x/SKILL.md'), 'https://raw.githubusercontent.com/o/r/main/plugins/p/skills/x/SKILL.md');
  assert.equal(rawSkillUrl('https://github.com/o/r/tree/main/plugins/p/skills/x'), 'https://raw.githubusercontent.com/o/r/main/plugins/p/skills/x/SKILL.md', 'a skill folder means its SKILL.md');
  assert.equal(rawSkillUrl('https://example.com/a.md'), 'https://example.com/a.md');
  assert.throws(() => rawSkillUrl('http://example.com/a.md'), /https/);
  assert.throws(() => rawSkillUrl('not a link'), /full link/);

  const files = {
    'https://raw.githubusercontent.com/o/r/main/short/SKILL.md': '---\nname: short-skill\ndescription: Small and useful.\n---\n\n# Short\n\n- Do the thing.\n---\n- Then the other.\n',
    'https://raw.githubusercontent.com/o/r/main/long/SKILL.md': `---\nname: python-error-handling\ndescription: Errors done well.\n---\n\n${'Long advice line.\n'.repeat(400)}`,
    'https://example.com/page': '<!doctype html><html><body>hi</body></html>',
  };
  const fetched = [];
  const fakeFetch = async (url) => {
    fetched.push(url);
    if (!(url in files)) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => files[url] };
  };
  const dir = await tmpDir('import');
  const engine = await createEngine({ workspaceDir: dir, mock: true, mcp: false, agentsFile: path.join(dir, 'agents.json'), ownSkillsDir: path.join(dir, 'own'), fetch: fakeFetch });
  t.after(() => engine.close());
  const calls = () => engine.crew.snapshot().find((a) => a.id === 'general-manager').metrics.calls;

  const short = await engine.skills.import('https://github.com/o/r/blob/main/short/SKILL.md');
  assert.deepEqual([short.name, short.description, short.condensed], ['Short skill', 'Small and useful.', false]);
  assert.match(short.body, /^# Short\n\n- Do the thing\.\n\n- Then the other\.\n\nSource: https:\/\/github\.com\/o\/r\/blob\/main\/short\/SKILL\.md$/, 'a line of dashes is dropped; the source is credited');
  assert.equal(calls(), 0, 'no model call for a short one');
  // Nothing was saved: the user reads it first. Saving it is the ordinary save.
  assert.equal(engine.skills.list().filter((s) => s.own).length, 0);
  assert.equal((await engine.skills.save(short)).own, true);

  const long = await engine.skills.import('https://github.com/o/r/tree/main/long');
  assert.equal(long.condensed, true);
  assert.match(long.body, /condensed by the mock crew/);
  assert.ok(long.body.length <= 3000);
  assert.equal(calls(), 1, 'one call, by the Chef');

  await assert.rejects(engine.skills.import('https://example.com/page'), /web page, not a skill file/);
  await assert.rejects(engine.skills.import('https://github.com/o/r/blob/main/nothing/SKILL.md'), /404/);
});
