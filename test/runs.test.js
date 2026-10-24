import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createEngine } from '../src/core/engine.js';

const tmpDir = (name) => fs.mkdtemp(path.join(os.tmpdir(), `kadhai-${name}-`));
const reply = (text) => ({ text, reasoning: '', finishReason: 'stop', usage: { promptTokens: 100, completionTokens: 20 } });
const cookOf = (req) => /You are the cook called ([^\n]+?) in Kadhai/.exec(req.messages[0].content)?.[1];
const plan = (subtasks, extra = {}) => reply(JSON.stringify({ objective: 'x', subtasks, ...extra }));
const approve = reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'fine' }));

async function engineWith(completion, extra = {}) {
  const dir = await tmpDir('runs');
  const engine = await createEngine({
    workspaceDir: path.join(dir, 'ws'),
    agentsFile: path.join(dir, 'agents.json'),
    providers: [{ id: 'fake', label: 'Fake', baseUrl: 'x', keys: ['k'], models: ['m1'] }],
    completion,
    mcp: false,
    journal: true,
    limits: { execMode: 'off' },
    ...extra,
  });
  return { engine, dir };
}

test('the Taster carries the security skill by default; taking it off is remembered', async (t) => {
  const { engine, dir } = await engineWith(async () => approve);
  t.after(() => engine.close());
  const taster = () => engine.crew.snapshot().find((a) => a.id === 'head-chef');
  assert.deepEqual(taster().skills, ['security']);
  assert.equal((await engine.snapshot()).agents.find((a) => a.id === 'head-chef').name, 'Taster');
  // Defaults are not written to the file...
  await engine.hiring.configure('head-chef', { hue: 10 });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'agents.json'), 'utf8')).settings['head-chef'], { hue: 10 });
  // ...but taking the skill off is, and survives a restart.
  await engine.hiring.configure('head-chef', { skills: [] });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'agents.json'), 'utf8')).settings['head-chef'], { hue: 10, skills: [] });
  const again = await createEngine({ ...engine.config, workspaceDir: engine.config.workspaceDir, agentsFile: path.join(dir, 'agents.json'), providers: [], mcp: false });
  t.after(() => again.close());
  assert.deepEqual(again.crew.snapshot().find((a) => a.id === 'head-chef').skills, []);
});

test('a run keeps what it cost (journal); a failed run leaves a lesson about why', async (t) => {
  let failing = false;
  const completion = async (route, req, { role }) => {
    if (role === 'manager') return plan([{ title: 'Write the page', instructions: 'write it', files: ['page.html'] }]);
    if (role === 'reviewer') return approve;
    // A cook that only talks: the step fails (it must write page.html), on retry too.
    return reply(failing ? 'SUMMARY: I could not find the template the page needs' : '<<<FILE page.html>>>\n<p>hi</p>\n<<<END>>>\nSUMMARY: wrote it');
  };
  const { engine } = await engineWith(completion);
  t.after(() => engine.close());

  const ok = await engine.orchestrator.start('make a page').done;
  assert.equal(ok.ok, true);
  assert.ok(ok.tokens > 0 && ok.flame === 'low');
  // The cost is kept in the journal, not written into the chat (the usage bar shows usage live).
  assert.doesNotMatch(engine.orchestrator.chat.filter((m) => m.role === 'manager').at(-1).text, /tokens on/);
  assert.equal(engine.journal.recent(1)[0].tokens, ok.tokens);
  assert.equal(engine.journal.listLessons().length, 0, 'a good run teaches nothing here');

  failing = true;
  const bad = await engine.orchestrator.start('make it again').done;
  assert.equal(bad.ok, false);
  const lessons = engine.journal.listLessons();
  assert.equal(lessons.length, 1);
  assert.match(lessons[0].text, /^"Write the page" failed before: I could not find the template the page needs/);
  assert.equal(lessons[0].for, 'executive-chef', 'the cook whose step it was (after the retry)');
  // The next prompt of that cook carries it.
  assert.ok(engine.journal.lessonsFor('executive-chef')[0].includes('Write the page'));
});

test('circuit breaker: steered, then a narrower job, then stopped early; two failed steps skip the rest', async (t) => {
  const prompts = [];
  const completion = async (route, req, { role }) => {
    if (role === 'manager') {
      return plan([
        { title: 'one', instructions: 'a', files: ['a.js'] },
        { title: 'two', instructions: 'b', files: ['b.js'] },
        { title: 'three', instructions: 'c', files: ['c.js'] },
      ]);
    }
    if (role === 'reviewer') return approve;
    prompts.push({ cook: cookOf(req), system: req.messages[0].content, user: req.messages[1].content });
    // Always a broken edit: the same mistake every round.
    return reply('<<<EDIT a.js>>>\nnot a hunk at all\n<<<END>>>');
  };
  const { engine } = await engineWith(completion, { limits: { execMode: 'off', maxToolRounds: 6 } });
  t.after(() => engine.close());
  const result = await engine.orchestrator.start('three steps').done;
  assert.equal(result.ok, false);

  // Step one: Cook, three rounds (not seven), the third already narrowed; then the Senior Cook's retry, three more.
  const first = prompts.filter((p) => p.cook === 'Cook').slice(0, 3);
  assert.equal(prompts.filter((p) => p.cook === 'Cook').length, 6, 'two steps x three rounds, not seven each');
  assert.doesNotMatch(first[1].user, /NARROWER JOB/);
  assert.match(first[2].user, /NARROWER JOB from now on/);
  assert.match(engine.crew.snapshot().find((a) => a.id === 'chef-de-partie').thought, /\[breaker\] two rounds in a row went wrong[\s\S]*\[breaker\] 3 rounds in a row went wrong - this step stops here/);

  // Steps one and two failed (each after its retry): three is skipped, not cooked.
  assert.match(result.reply, /\[-\] 3\. three — skipped: 2 steps before it failed/);
  assert.ok(!prompts.some((p) => p.user.includes('c.js') && p.user.includes('three')), 'no cook ever saw step three');
});

test('high flame: a change touching sign-in gets one security pass, and its findings are fixed; low flame never does', async (t) => {
  const calls = { security: 0, fixer: 0 };
  let file = 'login.js';
  const completion = async (route, req, { role }) => {
    if (role === 'manager') return plan([{ title: 'Write it', instructions: 'write', files: [file] }]);
    if (role === 'reviewer') {
      if (!req.messages[0].content.includes('SECURITY REVIEW ONLY')) return approve;
      calls.security += 1;
      return reply(JSON.stringify({ verdict: 'revise', issues: [{ file, problem: 'the password is compared with ==', fix: 'use a constant-time compare' }], summary: 'one problem' }));
    }
    // The Fixer really changes the file: a Fixer that writes it back unchanged is reported as having fixed nothing.
    if (cookOf(req) === 'Fixer') calls.fixer += 1;
    return reply(`<<<FILE ${file}>>>\nexport const ok = ${cookOf(req) === 'Fixer' ? 2 : 1};\n<<<END>>>\nSUMMARY: wrote it`);
  };
  const { engine } = await engineWith(completion);
  t.after(() => engine.close());

  // Low flame: no security pass, whatever the files are.
  await engine.orchestrator.start('add a login').done;
  assert.deepEqual(calls, { security: 0, fixer: 0 });

  engine.setFlame('high');
  const high = await engine.orchestrator.start('add a login again').done;
  assert.deepEqual(calls, { security: 1, fixer: 1 });
  assert.match(high.reply, /\*\*Security:\*\* 1 issue\(s\) found — fixed by the Fixer/);
  assert.match(high.reply, /Apply security fixes/);

  // High flame, nothing sensitive in name or content: no extra call.
  file = 'colours.css';
  await engine.orchestrator.start('change the colours').done;
  assert.equal(calls.security, 1);
});

test('a Fixer that changes nothing is reported as such, not as a fix', async (t) => {
  // Seen with a real model: the Taster flagged a wrong import path, the Fixer answered "no changes needed"
  // and wrote the file back as it was, and the report said "fixed by the Fixer".
  const completion = async (route, req, { role }) => {
    if (role === 'manager') return plan([{ title: 'Write it', instructions: 'write', files: ['README.md'] }]);
    if (role === 'reviewer') return reply(JSON.stringify({ verdict: 'revise', issues: [{ file: 'README.md', problem: 'the import path is wrong', fix: 'use ./cart.js' }], summary: 'one problem' }));
    return reply('<<<FILE README.md>>>\n# Cart\n<<<END>>>\nSUMMARY: no changes needed');
  };
  const { engine } = await engineWith(completion);
  t.after(() => engine.close());
  const result = await engine.orchestrator.start('write the readme').done;
  assert.match(result.reply, /\*\*Review:\*\* 1 issue\(s\) found — the Fixer changed nothing \(it judged the code already right\) - check: the import path is wrong/);
  assert.doesNotMatch(result.reply, /fixed by the Fixer/);
});

test('agents can be switched off: their work goes to a stand-in, a switched-off Taster means no review, and it is remembered', async (t) => {
  const calls = { reviewer: 0, cooks: [] };
  const completion = async (route, req, { role }) => {
    if (role === 'manager') return plan([{ title: 'Simple one', instructions: 'write', files: ['a.js'], level: 'simple' }]);
    if (role === 'reviewer') {
      calls.reviewer += 1;
      return reply(JSON.stringify({ verdict: 'revise', issues: [{ file: 'a.js', problem: 'off by one', fix: 'add one' }], summary: 'one problem' }));
    }
    calls.cooks.push(cookOf(req));
    return reply(`<<<FILE a.js>>>\nexport const n = ${calls.cooks.length};\n<<<END>>>\nSUMMARY: wrote it`);
  };
  const { engine, dir } = await engineWith(completion);
  t.after(() => engine.close());

  // The Chef plans every run, and one cook always stays on.
  await assert.rejects(async () => engine.hiring.configure('general-manager', { off: true }), /cannot be switched off/);
  for (const id of ['commis', 'chef-de-partie', 'executive-chef']) await engine.hiring.configure(id, { off: true });
  await assert.rejects(async () => engine.hiring.configure('sous-chef', { off: true }), /one cook has to stay on/);
  assert.equal(engine.crew.cookFor('commis'), 'sous-chef', 'the only cook left takes everything');
  await engine.hiring.configure('executive-chef', { off: false });

  // Prep is off: its simple step goes up the line to the Senior Cook. The Fixer still fixes what the Taster found.
  const first = await engine.orchestrator.start('one simple step').done;
  assert.deepEqual(calls.cooks, ['Senior Cook', 'Fixer']);
  assert.equal(calls.reviewer, 1);
  assert.match(first.reply, /Simple one/);

  // The Fixer off as well: the fix goes to its stand-in. Then the Taster off: no review, no fix, and the report says so.
  await engine.hiring.configure('sous-chef', { off: true });
  calls.cooks.length = 0;
  await engine.orchestrator.start('again').done;
  assert.deepEqual(calls.cooks, ['Senior Cook', 'Senior Cook']);
  await engine.hiring.configure('head-chef', { off: true });
  calls.cooks.length = 0;
  const quiet = await engine.orchestrator.start('without a review').done;
  assert.deepEqual(calls.cooks, ['Senior Cook']);
  assert.equal(calls.reviewer, 2, 'no review while the Taster is off');
  assert.match(quiet.reply, /\*\*Review:\*\* skipped - the Taster is switched off/);

  // Saved, and still off after a restart; the snapshot says so for the dashboard.
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'agents.json'), 'utf8')).settings['head-chef'].off, true);
  const again = await createEngine({ ...engine.config, agentsFile: path.join(dir, 'agents.json'), providers: [], mcp: false });
  t.after(() => again.close());
  assert.deepEqual(again.crew.snapshot().filter((a) => a.off).map((a) => a.id).sort(), ['chef-de-partie', 'commis', 'head-chef', 'sous-chef']);
});

test('a switched-off specialist is not offered to the Chef', async (t) => {
  const { engine } = await engineWith(async () => approve);
  t.after(() => engine.close());
  await engine.hiring.hire({ name: 'Docs Writer', specialty: 'writes the README and other docs' });
  assert.deepEqual(engine.crew.specialists().map((s) => s.name), ['Docs Writer']);
  await engine.hiring.configure('docs-writer', { off: true });
  assert.deepEqual(engine.crew.specialists(), []);
});

test('the skill gallery is served (and not read as a skill called "gallery"); every entry is a wshobson/agents skill folder', async (t) => {
  const { Host } = await import('../src/http/host.js');
  const { createApp } = await import('../src/http/app.js');
  const http = await import('node:http');
  const dir = await tmpDir('gallery');
  const host = await new Host({ createEngine, options: { workspaceDir: dir, mock: true, mcp: false, agentsFile: path.join(dir, 'a.json'), keysFile: path.join(dir, 'k.json'), ownSkillsDir: path.join(dir, 'own') }, settingsFile: path.join(dir, 's.json') }).start();
  const server = createApp(host).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => {
    server.close();
    await host.engine.close();
  });
  const body = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/skills/gallery' }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
    }).on('error', reject);
  });
  assert.equal(body.status, 200);
  assert.equal(body.json.skills.length, 16);
  for (const entry of body.json.skills) {
    assert.match(entry.url, /^https:\/\/github\.com\/wshobson\/agents\/tree\/main\/plugins\/[\w-]+\/skills\/[\w-]+$/);
    assert.equal(entry.added, false);
  }
});

test('circuit breaker: asking again and again for the same missing file is a mistake too (seen with a real Fixer)', async (t) => {
  const calls = [];
  const completion = async (route, req, { role }) => {
    if (role === 'manager') return plan([{ title: 'Fix login', instructions: 'fix it', files: ['login.js'] }]);
    if (role === 'reviewer') return approve;
    calls.push({ cook: cookOf(req), user: req.messages[1].content });
    return reply('<<<READ package.json>>>');
  };
  const { engine } = await engineWith(completion, { limits: { execMode: 'off', maxToolRounds: 6 } });
  t.after(() => engine.close());
  await engine.orchestrator.start('fix the login').done;
  const cook = calls.filter((c) => c.cook === 'Cook');
  // Round 1 is answered ("does not exist"); rounds 2-4 repeat it and are not served: stopped after 4, not 7.
  assert.equal(cook.length, 4);
  assert.match(cook[2].user, /you asked again for package\.json/);
  assert.match(cook[3].user, /NARROWER JOB/);
});

test('circuit breaker: running the same command again with nothing changed is a repeat; after a change it is fair', async (t) => {
  const asks = [];
  let round = 0;
  const completion = async (route, req, { role }) => {
    if (role === 'manager') return plan([{ title: 'Check it', instructions: 'check', files: ['a.js'] }]);
    if (role === 'reviewer') return approve;
    round += 1;
    asks.push(req.messages[1].content);
    // Round 1 writes and checks; round 2 checks again unchanged (a repeat); round 3 writes then checks (fair).
    if (round === 1) return reply('<<<FILE a.js>>>\nconst a = 1;\n<<<END>>>\n<<<RUN node --check a.js>>>');
    if (round === 2) return reply('<<<RUN node --check a.js>>>');
    if (round === 3) return reply('<<<FILE a.js>>>\nconst a = 2;\n<<<END>>>\n<<<RUN node --check a.js>>>');
    return reply('SUMMARY: done');
  };
  const { engine } = await engineWith(completion, { limits: { execMode: 'auto', maxToolRounds: 6 } });
  t.after(() => engine.close());
  const ran = [];
  engine.bus.subscribe((e) => e.type === 'exec:end' && e.data.owner !== 'head-chef' && ran.push(e.data.command));
  await engine.orchestrator.start('check a').done;
  assert.deepEqual(ran, ['node --check a.js', 'node --check a.js'], 'run in rounds 1 and 3, not in round 2');
  assert.match(asks[2], /you asked again for "node --check a\.js" \(nothing changed since it ran\)/);
});
