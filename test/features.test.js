import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyEdits, parseWorkerOutput } from '../src/core/parse.js';
import { spawnSpec } from '../src/core/runner.js';
import { createEngine } from '../src/core/engine.js';
import { CATALOG, CATEGORIES, checkFields, publicCatalog, specFor } from '../src/core/connectors/catalog.js';
import { Toolbox } from '../src/core/connectors/google.js';
import { managerSystem } from '../src/core/prompts.js';
import { ProviderError } from '../src/core/providers.js';
import { loadSkills } from '../src/core/skills.js';
import { classifyCli, cliCompletion } from '../src/core/cliProvider.js';

const tmpDir = (name) => fs.mkdtemp(path.join(os.tmpdir(), `kadhai-${name}-`));
const FAKE_PROVIDER = [{ id: 'fake', label: 'Fake', baseUrl: 'x', keys: ['k'], models: ['m'] }];
const reply = (text) => ({ text, reasoning: '', finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 } });

const editBlock = (file, search, replace) =>
  `<<<EDIT ${file}>>>\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n<<<END>>>`;

test('edits: SEARCH/REPLACE parsing and tolerant application', () => {
  const parsed = parseWorkerOutput(
    `${editBlock('a.js', 'const a = 1;', 'const a = 2;')}\n<<<EDIT b.js>>>\n<<<<<<< SEARCH\nx\n=======\n>>>>>>> REPLACE\n<<<<<<< SEARCH\ny\n=======\nz\n>>>>>>> REPLACE\n<<<END>>>\nSUMMARY: ok`,
  );
  assert.deepEqual(parsed.edits, [
    { path: 'a.js', hunks: [{ search: 'const a = 1;', replace: 'const a = 2;' }], stray: '' },
    { path: 'b.js', hunks: [{ search: 'x', replace: '' }, { search: 'y', replace: 'z' }], stray: '' },
  ]);
  assert.equal(parsed.files.length, 0);
  assert.equal(parsed.truncated, false);
  assert.equal(parseWorkerOutput('<<<EDIT a.js>>>\n<<<<<<< SEARCH\nconst').truncated, true);

  // Exact match, including "$" in the replacement being taken literally.
  assert.deepEqual(applyEdits('a\nb\nc\n', [{ search: 'b', replace: '$1 & $&' }]), { content: 'a\n$1 & $&\nc\n', failed: [] });
  // Trailing whitespace differences are forgiven.
  assert.equal(applyEdits('if (x) {   \n  go();\n}\n', [{ search: 'if (x) {\n  go();', replace: 'if (y) {\n  go();' }]).content, 'if (y) {\n  go();\n}\n');
  // Wrong indentation is forgiven, and the replacement is shifted to match the file.
  assert.equal(
    applyEdits('def f():\n    if a:\n        return 1\n', [{ search: 'if a:\n    return 1', replace: 'if b:\n    return 2' }]).content,
    'def f():\n    if b:\n        return 2\n',
  );
  // CRLF files stay CRLF.
  assert.equal(applyEdits('a\r\nb\r\n', [{ search: 'b', replace: 'c' }]).content, 'a\r\nc\r\n');
  // An empty SEARCH appends to the end of the file.
  assert.equal(applyEdits('a\n', [{ search: '', replace: 'b' }]).content, 'a\nb\n');
  assert.equal(applyEdits('a', [{ search: '', replace: 'b\n' }]).content, 'a\nb\n');

  // Seen with a real model: a second "hunk" with no SEARCH marker. It must be noticed, not dropped.
  const sloppy = parseWorkerOutput('<<<EDIT t.js>>>\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n=======\ntest("new", () => {});\n>>>>>>> REPLACE\n<<<END>>>');
  assert.equal(sloppy.edits[0].hunks.length, 1);
  assert.match(sloppy.edits[0].stray, /test\("new"/);

  // A miss is reported, and nothing else is disturbed.
  assert.deepEqual(applyEdits('a\n', [{ search: 'zzz', replace: 'q' }, { search: 'a', replace: 'b' }]), { content: 'b\n', failed: [1] });
});

test('sandbox: docker commands are confined to the workspace mount', () => {
  const spec = spawnSpec({ sandbox: 'docker', command: 'node test.js && echo "ok"', cwd: 'C:\\ws', id: 'abc', image: 'node:22-alpine', network: 'none' });
  assert.equal(spec.file, 'docker');
  assert.equal(spec.shell, false, 'no host shell is involved');
  assert.deepEqual(spec.args.slice(-4), ['node:22-alpine', 'sh', '-c', 'node test.js && echo "ok"']);
  assert.ok(spec.args.join(' ').includes('--network none'));
  assert.ok(spec.args.includes('C:\\ws:/workspace'));
  assert.deepEqual(spawnSpec({ sandbox: 'none', command: 'dir' }), { file: 'dir', args: [], shell: true });
});

test('sandbox: with EXEC_SANDBOX=docker and no Docker, commands are refused rather than run on the host', async () => {
  const { Runner } = await import('../src/core/runner.js');
  const runner = new Runner({ cwd: await tmpDir('sb'), limits: { execMode: 'auto', execSandbox: 'docker', execTimeoutMs: 2000, execOutputChars: 500 } });
  runner.sandboxReady = false; // what init() concludes when the daemon is unreachable
  await assert.rejects(runner.run('node -v', { owner: 'user', trusted: true }), /Docker is not running/);
});

test('run: edit retry, verification, checkpoint diff, undo, queue and persistence', async (t) => {
  const workspaceDir = await tmpDir('feat');
  await fs.writeFile(path.join(workspaceDir, 'calc.js'), 'const add = (a, b) => a - b;\nif (add(2, 3) !== 5) process.exit(1);\n');

  const coderPrompts = [];
  let reviews = 0;
  const completion = async (_route, req, { role: agent }) => {
    const prompt = req.messages.at(-1).content;
    if (agent === 'manager') {
      const second = prompt.includes('## User request\nsecond task');
      return reply(
        JSON.stringify({
          objective: second ? 'Add a note' : 'Fix add()',
          reply: '',
          subtasks: [
            second
              ? { title: 'Write note', instructions: 'Create note.txt', files: ['note.txt'] }
              : { title: 'Fix the operator', instructions: 'add() must add', files: ['calc.js'] },
          ],
          verify: second ? '' : 'node calc.js',
        }),
      );
    }
    if (agent === 'coder') {
      coderPrompts.push(prompt);
      if (prompt.includes('note.txt')) return reply('<<<FILE note.txt>>>\nhello\n<<<END>>>\nSUMMARY: wrote the note');
      // First attempt quotes the file wrongly; the correction arrives in the next round.
      if (!prompt.includes('Problems with your previous answer')) {
        return reply(`${editBlock('calc.js', 'const add = (x, y) => x - y;', 'nope')}\nSUMMARY: fixed`);
      }
      return reply(`${editBlock('calc.js', 'const add = (a, b) => a - b;', 'const add = (a, b) => a + b;')}\nSUMMARY: add() now adds`);
    }
    reviews += 1;
    // The first run has a verify command: the Taster must see its real result.
    if (prompt.includes('calc.js')) assert.match(prompt, /## Verification\n\$ node calc\.js\nexit code 0/);
    return reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'works' }));
  };

  const options = { workspaceDir, providers: FAKE_PROVIDER, completion, mcp: false, persist: true, limits: { execMode: 'auto' } };
  const engine = await createEngine(options);
  const { orchestrator } = engine;
  if (!engine.checkpoints.available) return t.skip('git is not installed');

  // Two tasks at once: the second waits in the queue.
  const first = orchestrator.start('fix the calculator');
  const second = orchestrator.start('second task');
  assert.equal(first.queued, false);
  assert.equal(second.queued, true);
  assert.deepEqual(orchestrator.queueView().map((q) => q.request), ['second task']);

  const one = await first.done;
  assert.equal(one.ok, true, one.reply);
  assert.match(one.reply, /\*\*Verify:\*\* `node calc\.js` — passed/);
  assert.equal(coderPrompts.filter((p) => p.includes('Fix the operator')).length, 2, 'the failed EDIT was retried once');
  assert.match(coderPrompts[1], /EDIT of calc\.js was NOT applied/);
  assert.match(await fs.readFile(path.join(workspaceDir, 'calc.js'), 'utf8'), /a \+ b/);
  const two = await second.done;
  assert.equal(two.ok, true, two.reply);
  assert.deepEqual(orchestrator.queueView(), []);
  assert.equal(await fs.readFile(path.join(workspaceDir, 'note.txt'), 'utf8'), 'hello\n');

  // Diff of the first run shows exactly the one-line change.
  const [runOne, runTwo] = orchestrator.runsView();
  assert.deepEqual([runOne.canUndo, runTwo.canUndo], [false, true], 'only the latest run can be undone');
  const diff = await orchestrator.diff(runOne.id);
  assert.deepEqual(diff.files, [{ status: 'M', path: 'calc.js' }]);
  assert.match(diff.patch, /-const add = \(a, b\) => a - b;\n\+const add = \(a, b\) => a \+ b;/);
  await assert.rejects(orchestrator.undo(runOne.id), /most recent run/);

  // Undo the second run: its file disappears, the first run's fix stays.
  await orchestrator.undo(runTwo.id);
  await assert.rejects(fs.access(path.join(workspaceDir, 'note.txt')));
  assert.match(await fs.readFile(path.join(workspaceDir, 'calc.js'), 'utf8'), /a \+ b/);
  assert.equal(orchestrator.runsView()[0].canUndo, true, 'the previous run becomes undoable');
  await orchestrator.undo(runOne.id);
  assert.match(await fs.readFile(path.join(workspaceDir, 'calc.js'), 'utf8'), /a - b/);
  assert.match(await engine.memory.read(), /Undid the run "Fix add\(\)"/);

  // Everything above survives a restart.
  const usage = engine.dispatcher.status().routes[0].day;
  assert.ok(usage.calls >= 5);
  await engine.close();
  const reborn = await createEngine(options);
  t.after(() => reborn.close());
  assert.equal(reborn.orchestrator.chat.length, orchestrator.chat.length);
  assert.ok(reborn.orchestrator.chat.some((m) => m.role === 'exec' && m.command === 'node calc.js'));
  assert.deepEqual(reborn.orchestrator.runsView().map((r) => r.undone), [true, true]);
  assert.equal(reborn.dispatcher.status().routes[0].day.calls, usage.calls);
});

test('review: a failing verification forces a fix round even if the Reviewer approves', async (t) => {
  const workspaceDir = await tmpDir('verify');
  let coderCalls = 0;
  const completion = async (_route, _req, { role: agent }) => {
    if (agent === 'manager') {
      return reply(JSON.stringify({ objective: 'Make check.js pass', subtasks: [{ title: 'Write it', instructions: 'x', files: ['check.js'] }], verify: 'node check.js' }));
    }
    if (agent === 'coder') {
      coderCalls += 1;
      const body = coderCalls === 1 ? 'process.exit(2);' : 'console.log("fine");';
      return reply(`<<<FILE check.js>>>\n${body}\n<<<END>>>\nSUMMARY: attempt ${coderCalls}`);
    }
    return reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'looks fine to me' }));
  };
  const engine = await createEngine({ workspaceDir, providers: FAKE_PROVIDER, completion, mcp: false, limits: { execMode: 'auto' } });
  t.after(() => engine.close());

  const result = await engine.orchestrator.start('go').done;
  assert.equal(coderCalls, 2, 'a cook was sent back to fix the failing check');
  assert.equal(result.ok, true, result.reply);
  assert.match(result.reply, /Verify:.*passed/);
  assert.match(result.reply, /Review:\*\* 1 issue\(s\) found — fixed by the Fixer/);
});

test('keys: added from the dashboard, verified, used live, masked, and removable', async (t) => {
  for (const name of ['GROQ_API_KEYS', 'GROQ_API_KEY', 'GROQ_MODELS']) delete process.env[name];
  const keysFile = path.join(await tmpDir('keys'), 'keys.local.json');
  const secret = 'gsk_test_0123456789abcdefWXYZ';
  const verifyKey = async (_provider, key) =>
    key.startsWith('bad')
      ? { rejected: true, verified: false, models: [] }
      : { rejected: false, verified: true, models: ['openai/gpt-oss-120b', 'some-new-model:free', 'some-new-model'] };
  const engine = await createEngine({ workspaceDir: await tmpDir('ws'), keysFile, verifyKey, mock: true, mcp: false });
  t.after(() => engine.close());
  const { keys, dispatcher } = engine;

  // Starts in demo mode with nothing saved.
  assert.equal((await engine.snapshot()).app.mock, true);
  assert.deepEqual(keys.list().find((p) => p.id === 'groq').keys, []);

  await assert.rejects(keys.add('groq', 'short'), /does not look like/);
  await assert.rejects(keys.add('groq', 'bad_key_0123456789'), /rejected this key/);
  await assert.rejects(keys.add('nope', secret), /Unknown provider/);
  assert.equal(dispatcher.routes[0].provider, 'mock', 'a rejected key changes nothing');

  // A good key leaves demo mode and becomes routes immediately - no restart.
  const added = await keys.add('groq', secret);
  assert.equal(added.verified, true);
  assert.equal(added.availableModels[0], 'some-new-model:free', 'free models are listed first');
  assert.deepEqual((await keys.available('groq')).models.length, 3);
  assert.deepEqual(added.missingModels, ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b'], 'models the key cannot use are flagged');
  const snap = await engine.snapshot();
  assert.equal(snap.app.mock, false);
  assert.equal(snap.app.hasProviders, true);
  assert.ok(dispatcher.routes.length > 0 && dispatcher.routes.every((r) => r.provider === 'groq' && r.key === secret));
  await assert.rejects(keys.add('groq', secret), /already saved/);

  // The key never travels back: not in the listing, not in the snapshot.
  const listed = keys.list().find((p) => p.id === 'groq').keys;
  assert.deepEqual(listed.map((k) => [k.masked, k.source]), [['••••WXYZ', 'ui']]);
  assert.ok(!JSON.stringify([keys.list(), snap]).includes(secret));

  // Model list edits apply live and survive a reload of the config.
  await keys.setModels('groq', ['some-new-model']);
  assert.deepEqual(dispatcher.routes.map((r) => r.id), ['groq/some-new-model']);
  const { readProviders } = await import('../src/config.js');
  assert.deepEqual(readProviders(keysFile).map((p) => [p.id, p.keys, p.models]), [['groq', [secret], ['some-new-model']]]);
  await keys.setModels('groq', []);
  assert.equal(dispatcher.routes.length, 3, 'an empty list restores the defaults');

  await keys.remove('groq', listed[0].id);
  assert.equal(dispatcher.routes.length, 0);
  await assert.rejects(dispatcher.chat({ messages: [] }), { code: 'NO_PROVIDERS' });
});

test('crew: sub-tasks go to the right cook by difficulty, and a failed one is escalated once', async (t) => {
  const calls = [];
  const completion = async (route, req, { agent, role }) => {
    calls.push({ agent, role, model: route.model });
    const prompt = req.messages.at(-1).content;
    if (role === 'manager') {
      return reply(
        JSON.stringify({
          objective: 'Three dishes',
          subtasks: [
            { title: 'Easy', instructions: 'x', files: ['easy.txt'], level: 'simple' },
            { title: 'Normal', instructions: 'x', files: ['normal.txt'] },
            { title: 'Hard', instructions: 'x', files: ['hard.txt'], level: 'complex' },
          ],
        }),
      );
    }
    if (role === 'reviewer') return reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'fine' }));
    // The junior fumbles the easy dish; whoever picks it up next gets it right.
    if (agent === 'commis') return reply('I am not sure what to do here.');
    const file = /Files to produce: (\S+)/.exec(prompt)[1];
    return reply(`<<<FILE ${file}>>>\ndone by ${agent}\n<<<END>>>\nSUMMARY: cooked ${file}`);
  };
  const dir = await tmpDir('crew');
  const engine = await createEngine({
    workspaceDir: dir,
    agentsFile: path.join(dir, 'agents.json'),
    providers: [{ id: 'fake', label: 'Fake', baseUrl: 'x', keys: ['k'], models: ['big', 'small'] }],
    completion,
    mcp: false,
    limits: { execMode: 'off', maxToolRounds: 0 },
  });
  t.after(() => engine.close());

  const result = await engine.orchestrator.start('cook three things').done;
  assert.equal(result.ok, true, result.reply);
  assert.deepEqual(
    calls.map((c) => c.agent),
    ['general-manager', 'commis', 'executive-chef', 'chef-de-partie', 'executive-chef', 'head-chef'],
    'simple -> Prep (escalated once), standard -> Cook, complex -> Senior Cook, then the pass',
  );
  assert.equal(calls[1].model, 'small', 'the Prep reaches for the lighter model first');
  assert.equal(calls[3].model, 'big');
  const read = (f) => fs.readFile(path.join(dir, f), 'utf8');
  assert.equal(await read('easy.txt'), 'done by executive-chef\n');
  assert.equal(await read('normal.txt'), 'done by chef-de-partie\n');
  assert.deepEqual(
    (await engine.snapshot()).agents.map((a) => a.id),
    ['general-manager', 'commis', 'chef-de-partie', 'executive-chef', 'head-chef', 'sous-chef'],
    'the house crew is exactly the six agents that do work',
  );
});

test('custom agents: hire, get used by the Chef, retrain, persist, dismiss', async (t) => {
  const dir = await tmpDir('hire');
  const agentsFile = path.join(dir, 'agents.json');
  const seen = { managerPrompt: '', cooks: [], pastrySystem: '' };
  const completion = async (_route, req, { agent, role }) => {
    if (role === 'manager') {
      seen.managerPrompt = req.messages[0].content;
      return reply(
        JSON.stringify({
          objective: 'Style the page',
          subtasks: [
            { title: 'Styles', instructions: 'write the css', files: ['style.css'], cook: 'pastry-chef' },
            { title: 'Markup', instructions: 'write the html', files: ['index.html'], cook: 'nobody-by-this-name' },
          ],
        }),
      );
    }
    if (role === 'reviewer') return reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'fine' }));
    seen.cooks.push(agent);
    if (agent === 'pastry-chef') seen.pastrySystem = req.messages[0].content;
    const file = /Files to produce: (\S+)/.exec(req.messages.at(-1).content)[1];
    return reply(`<<<FILE ${file}>>>\nby ${agent}\n<<<END>>>\nSUMMARY: wrote ${file}`);
  };
  const options = { workspaceDir: dir, agentsFile, providers: FAKE_PROVIDER, completion, mcp: false, limits: { execMode: 'off' } };
  const engine = await createEngine(options);
  const { hiring, crew } = engine;

  // Validation speaks plainly.
  assert.throws(() => crew.hire({ name: 'X', specialty: 'css things' }), /name/);
  assert.throws(() => crew.hire({ name: 'Pastry Chef', specialty: '' }), /good at/);
  assert.throws(() => crew.hire({ name: 'taster', specialty: 'reviews things' }), /already an agent called/);

  const hired = await hiring.hire({ name: 'Pastry Chef', emoji: '🧁', specialty: 'CSS, layout and visual polish', instructions: 'Always use CSS variables for colours.' });
  assert.deepEqual([hired.id, hired.custom, hired.state], ['pastry-chef', true, 'standby']);
  assert.throws(() => crew.dismiss('head-chef'), /house crew/);

  // The plan may hand a sub-task to the specialist; an unknown name falls back to the house crew.
  const result = await engine.orchestrator.start('make it pretty').done;
  assert.equal(result.ok, true, result.reply);
  assert.match(seen.managerPrompt, /pastry-chef: CSS, layout and visual polish/);
  assert.deepEqual(seen.cooks, ['pastry-chef', 'chef-de-partie']);
  assert.match(seen.pastrySystem, /You are the cook called Pastry Chef[\s\S]*Always use CSS variables for colours\./);
  assert.equal(crew.get('pastry-chef').metrics.calls, 1);

  await hiring.retrain('pastry-chef', { name: 'Pastry Chef', emoji: '🧁', specialty: 'Only SCSS', instructions: '', tier: 'light' });
  assert.equal(crew.get('pastry-chef').tier, 'light');
  await engine.close();

  // Hired agents are still there after a restart, and can be let go.
  const reborn = await createEngine(options);
  t.after(() => reborn.close());
  assert.deepEqual(reborn.crew.specialists(), [{ id: 'pastry-chef', name: 'Pastry Chef', specialty: 'Only SCSS' }]);
  await reborn.hiring.dismiss('pastry-chef');
  assert.deepEqual(reborn.crew.specialists(), []);
  assert.deepEqual(JSON.parse(await fs.readFile(agentsFile, 'utf8')), { agents: [] });
});

test('agent settings: any agent can get a colour, a model to start with and up to three skills', async (t) => {
  const dir = await tmpDir('settings');
  const agentsFile = path.join(dir, 'agents.json');
  const skillsDir = path.join(dir, 'skills');
  await fs.mkdir(path.join(skillsDir, 'tidy'), { recursive: true });
  // Both layouts: a folder with SKILL.md (as Claude skills are laid out), and a plain file.
  await fs.writeFile(path.join(skillsDir, 'tidy', 'SKILL.md'), '---\nname: Tidy\ndescription: "Keep it neat."\n---\n\nALWAYS-SORT-IMPORTS\n');
  for (const id of ['brief', 'long', 'extra']) {
    await fs.writeFile(path.join(skillsDir, `${id}.md`), `---\nname: ${id}\ndescription: about ${id}\n---\n${id === 'long' ? 'x'.repeat(3000) : `BODY-OF-${id}`}\n`);
  }
  await fs.writeFile(path.join(skillsDir, 'README.md'), 'not a skill');

  const seen = { routes: [], cookSystem: '' };
  let failPreferred = false;
  const completion = async (route, req, { role }) => {
    if (role === 'manager') return reply(JSON.stringify({ objective: 'x', subtasks: [{ title: 'a', instructions: 'write it', files: ['a.txt'] }] }));
    if (role === 'reviewer') return reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'fine' }));
    seen.routes.push(route.model);
    if (failPreferred && route.model === 'm2') throw new ProviderError('quota', { kind: 'rate_limit', retryAfterMs: 60000 });
    seen.cookSystem = req.messages[0].content;
    return reply('<<<FILE a.txt>>>\nhello\n<<<END>>>\nSUMMARY: wrote a.txt');
  };
  const providers = [{ id: 'fake', label: 'Fake', baseUrl: 'x', keys: ['k'], models: ['m1', 'm2'] }];
  const options = { workspaceDir: dir, agentsFile, skillsDir, providers, completion, mcp: false, limits: { execMode: 'off' } };
  const engine = await createEngine(options);
  const { hiring, crew } = engine;

  assert.deepEqual((await engine.snapshot()).skills.map((s) => [s.id, s.name, s.description]), [
    ['brief', 'brief', 'about brief'],
    ['extra', 'extra', 'about extra'],
    ['long', 'long', 'about long'],
    ['tidy', 'Tidy', 'Keep it neat.'],
  ]);

  // Bad input is refused whole, and says why.
  assert.throws(() => crew.configure('chef-de-partie', { hue: 400 }), /hue from 0 to 359/);
  assert.throws(() => crew.configure('nobody', { hue: 1 }), /Unknown agent/);

  // A house agent can be configured (though still not renamed), and unknown skills are dropped.
  const view = await hiring.configure('chef-de-partie', { hue: 300, model: 'fake/m2', skills: ['tidy', 'long', 'no-such-skill'] });
  assert.deepEqual([view.hue, view.model, view.skills], [300, 'fake/m2', ['tidy', 'long']]);
  assert.throws(() => crew.retrain('chef-de-partie', { name: 'Other', specialty: 'other things' }), /house crew/);

  // Its calls start on the chosen model, and its skills come after the output protocol, clipped.
  assert.equal((await engine.orchestrator.start('write a').done).ok, true);
  assert.deepEqual(seen.routes, ['m2']);
  assert.match(seen.cookSystem, /<<<FILE[\s\S]*## Skills you have loaded[\s\S]*### Tidy\nALWAYS-SORT-IMPORTS/);
  assert.ok(!seen.cookSystem.includes('x'.repeat(901)), 'a long skill is clipped');

  // When that model is out, the usual order takes over.
  failPreferred = true;
  seen.routes.length = 0;
  assert.equal((await engine.orchestrator.start('write a again').done).ok, true);
  assert.deepEqual(seen.routes, ['m2', 'm1']);
  await engine.close();

  // Settings survive a restart; clearing them takes them out of the file again.
  assert.deepEqual(JSON.parse(await fs.readFile(agentsFile, 'utf8')).settings, { 'chef-de-partie': { hue: 300, model: 'fake/m2', skills: ['tidy', 'long'] } });
  const reborn = await createEngine(options);
  t.after(() => reborn.close());
  const back = reborn.crew.snapshot().find((a) => a.id === 'chef-de-partie');
  assert.deepEqual([back.hue, back.model, back.skills], [300, 'fake/m2', ['tidy', 'long']]);
  await reborn.hiring.configure('chef-de-partie', { hue: null, model: '', skills: [] });
  assert.deepEqual(JSON.parse(await fs.readFile(agentsFile, 'utf8')), { agents: [] });
});

test('skills: the built-in library is well-formed and each one fits a prompt whole', () => {
  const skills = loadSkills(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills'));
  assert.ok(skills.length >= 10);
  for (const skill of skills) {
    assert.match(skill.id, /^[a-z0-9-]+$/);
    assert.ok(skill.name && skill.description.length >= 20, `${skill.id} has a name and a description`);
    assert.ok(skill.body.length <= 900, `${skill.id} is ${skill.body.length} characters; 900 is what a prompt keeps`);
  }
});

test('providers: the wider catalog is well-formed, and keys are verified the right way for each', async () => {
  const { PROVIDER_PRESETS, providerCatalog } = await import('../src/config.js');
  const { verifyKey } = await import('../src/core/keyStore.js');

  for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
    if (id === 'custom') continue;
    assert.match(preset.baseUrl, /^https:\/\/[^ ]+[^/]$/, `${id}: https base URL without a trailing slash`);
    assert.match(preset.keyUrl, /^https:\/\//, `${id}: has a page to get a key from`);
    assert.ok(Array.isArray(preset.models) && preset.models.every((m) => m && !/\s/.test(m)), `${id}: model ids`);
    assert.ok(preset.freeTier || preset.paid, `${id}: says what the free tier is, or that it is paid`);
  }
  const catalog = providerCatalog(path.join(await tmpDir('cat'), 'none.json'));
  assert.deepEqual(catalog.filter((p) => !p.extra && !p.paid && p.baseUrl).map((p) => p.id), ['gemini', 'groq', 'cerebras'], 'the core three stay up front');

  // A stand-in for the network, so the three verification styles can be checked offline.
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(url);
    const good = init.headers.authorization === 'Bearer good-key-123456';
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (url.endsWith('/key') || url.includes('whoami')) return json(good ? 200 : 401, {});
    if (url.includes('needs-auth')) return json(good ? 200 : 401, { data: [{ id: 'm1' }] });
    return json(200, { data: [{ id: 'models/public-1' }, { id: 'public-2:free' }] }); // a public /models
  };
  try {
    // Default: /models itself needs the key.
    const plain = { baseUrl: 'https://needs-auth.test/v1' };
    assert.deepEqual(await verifyKey(plain, 'good-key-123456'), { rejected: false, verified: true, models: ['m1'] });
    assert.equal((await verifyKey(plain, 'bad-key-12345678')).rejected, true);

    // Public /models: the key is checked on another endpoint, the list still comes from /models.
    const viaKey = { baseUrl: 'https://public.test/v1', verifyUrl: '/key' };
    assert.equal((await verifyKey(viaKey, 'bad-key-12345678')).rejected, true, 'a public model list must not make a bad key look good');
    assert.deepEqual(await verifyKey(viaKey, 'good-key-123456'), { rejected: false, verified: true, models: ['public-1', 'public-2:free'] });

    // No way to check: never claims the key was verified, but still lists models.
    calls.length = 0;
    const blind = { baseUrl: 'https://public.test/v1', verifyUrl: false };
    assert.deepEqual(await verifyKey(blind, 'whatever-key-1234'), { rejected: false, verified: false, models: ['public-1', 'public-2:free'] });
    assert.deepEqual(calls, ['https://public.test/v1/models']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('edits: a block with stray text is refused whole, and the cook is told how to append', async (t) => {
  const workspaceDir = await tmpDir('stray');
  await fs.writeFile(path.join(workspaceDir, 't.js'), 'import { a } from "./a.js";\n');
  const cookPrompts = [];
  const completion = async (_route, req, { role }) => {
    const prompt = req.messages.at(-1).content;
    if (role === 'manager') return reply(JSON.stringify({ objective: 'Add a test', subtasks: [{ title: 'Edit', instructions: 'x', files: ['t.js'] }] }));
    if (role === 'reviewer') return reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'ok' }));
    cookPrompts.push(prompt);
    // First answer is the malformed one a real model produced; the retry does it properly.
    if (cookPrompts.length === 1) {
      return reply('<<<EDIT t.js>>>\n<<<<<<< SEARCH\nimport { a } from "./a.js";\n=======\nimport { a, b } from "./a.js";\n>>>>>>> REPLACE\n=======\ntest("b", () => {});\n>>>>>>> REPLACE\n<<<END>>>\nSUMMARY: added import and test');
    }
    return reply('<<<EDIT t.js>>>\n<<<<<<< SEARCH\nimport { a } from "./a.js";\n=======\nimport { a, b } from "./a.js";\n>>>>>>> REPLACE\n<<<<<<< SEARCH\n=======\ntest("b", () => {});\n>>>>>>> REPLACE\n<<<END>>>\nSUMMARY: added import and test');
  };
  const engine = await createEngine({ workspaceDir, agentsFile: path.join(workspaceDir, 'agents.json'), providers: FAKE_PROVIDER, completion, mcp: false, limits: { execMode: 'off' } });
  t.after(() => engine.close());

  const result = await engine.orchestrator.start('add a test').done;
  assert.equal(result.ok, true, result.reply);
  assert.equal(cookPrompts.length, 2, 'the malformed edit was sent back once');
  assert.match(cookPrompts[1], /had text outside its SEARCH\/REPLACE hunks, so NONE of it was applied/);
  assert.equal(await fs.readFile(path.join(workspaceDir, 't.js'), 'utf8'), 'import { a, b } from "./a.js";\ntest("b", () => {});\n');
});

test('files: folders, rename and move never overwrite, and respect the crew\'s locks', async (t) => {
  const engine = await createEngine({ workspaceDir: await tmpDir('fs'), mock: true, mcp: false, limits: { execMode: 'off' } });
  t.after(() => engine.close());
  const { workspace, locks } = engine;
  const list = async () => (await workspace.tree()).map((e) => e.path).filter((p) => p !== 'memory.md');

  await workspace.makeDir('src/lib');
  await assert.rejects(workspace.makeDir('src'), /already exists/);
  await workspace.writeFile('a.txt', 'A', { owner: 'user' });
  await workspace.writeFile('b.txt', 'B', { owner: 'user' });

  // Rename, then move into a folder.
  await workspace.move('a.txt', 'alpha.txt', { owner: 'user' });
  await workspace.move('alpha.txt', 'src/lib/alpha.txt', { owner: 'user' });
  assert.deepEqual(await list(), ['src', 'src/lib', 'src/lib/alpha.txt', 'b.txt']);
  assert.equal((await workspace.readFile('src/lib/alpha.txt')).content, 'A');

  // Guards.
  await assert.rejects(workspace.move('b.txt', 'src/lib/alpha.txt', { owner: 'user' }), /already exists/);
  await assert.rejects(workspace.move('src', 'src/lib/inner', { owner: 'user' }), /into itself/);
  await assert.rejects(workspace.move('memory.md', 'notes.md', { owner: 'user' }), /cannot be moved/);
  await assert.rejects(workspace.move('b.txt', '../outside.txt', { owner: 'user' }), /outside the workspace/);
  await assert.rejects(workspace.move('nope.txt', 'x.txt', { owner: 'user' }), /does not exist/);

  // A file the crew is working on cannot be moved, nor can a folder that contains it.
  const held = await locks.acquire('src/lib/alpha.txt', 'chef-de-partie');
  await assert.rejects(workspace.move('src/lib/alpha.txt', 'moved.txt', { owner: 'user', timeoutMs: 100 }), { code: 'ELOCKED' });
  await assert.rejects(workspace.move('src', 'source', { owner: 'user' }), /locked by chef-de-partie/);
  await assert.rejects(workspace.deleteDir('src'), /locked by chef-de-partie/);
  await held.release();

  // Whole folders move and delete once nothing in them is locked.
  await workspace.move('src', 'source', { owner: 'user' });
  assert.deepEqual(await list(), ['source', 'source/lib', 'source/lib/alpha.txt', 'b.txt']);
  await workspace.deleteDir('source');
  assert.deepEqual(await list(), ['b.txt']);
  assert.deepEqual(await locks.list(), []);
});

test('host: opening another folder swaps the engine, keeps runtime choices, and is remembered', async (t) => {
  const { Host } = await import('../src/http/host.js');
  const base = await tmpDir('host');
  const first = path.join(base, 'one');
  const second = path.join(base, 'two');
  await fs.mkdir(first);
  await fs.mkdir(second);
  const settingsFile = path.join(base, 'settings.json');
  const options = { workspaceDir: first, mock: true, mcp: false, agentsFile: path.join(base, 'agents.json'), keysFile: path.join(base, 'keys.json') };

  const host = await new Host({ createEngine, options, settingsFile }).start();
  t.after(() => host.engine.close());
  const original = host.engine;
  await original.workspace.writeFile('in-one.txt', '1', { owner: 'user' });
  original.runner.setMode('auto');
  let streamEnded = false;
  original.streams.add({ end: () => (streamEnded = true) });

  // Bad targets are refused with a plain reason.
  await assert.rejects(host.open('relative/path'), /full path/);
  await assert.rejects(host.open(path.join(base, 'missing')), /does not exist/);
  await assert.rejects(host.open(path.parse(base).root), /whole drive/);

  const listing = await host.browse(base);
  assert.deepEqual(listing.dirs, ['one', 'two']);
  assert.equal(listing.dir, first);

  const info = await host.open(second);
  assert.equal(info.name, 'two');
  assert.notEqual(host.engine, original);
  assert.equal(host.engine.config.workspaceDir, second);
  assert.equal(host.engine.runner.mode, 'auto', 'the command setting survives the switch');
  assert.equal(streamEnded, true, 'open dashboards are told to reconnect');
  assert.deepEqual((await host.engine.workspace.tree()).map((e) => e.path), ['memory.md'], 'the new folder has its own files');
  assert.equal(await fs.readFile(path.join(first, 'in-one.txt'), 'utf8'), '1', 'the old folder is left as it was');

  // The choice is remembered, and the old folder is offered as a recent one.
  const again = await new Host({ createEngine, options, settingsFile }).start();
  t.after(() => again.engine.close());
  assert.equal(again.engine.config.workspaceDir, second);
  assert.ok(again.info().recent.includes(first));

  const made = await host.makeFolder(base, 'three');
  assert.equal(made.path, path.join(base, 'three'));
  await assert.rejects(host.makeFolder(base, 'a/b'), /valid folder name/);
});

test('source control: status, stage, commit, diff, discard and branches on the folder\'s own repo', async (t) => {
  const workspaceDir = await tmpDir('git');
  const engine = await createEngine({ workspaceDir, mock: true, mcp: false, limits: { execMode: 'off' } });
  t.after(() => engine.close());
  const { git, workspace } = engine;

  const before = await git.status();
  if (!before.available) return t.skip('git is not installed');
  assert.equal(before.repo, false);

  await git.init();
  // A fixed identity for this repo only, so the test does not depend on the machine's git config.
  const { execFileSync } = await import('node:child_process');
  const cfg = (...args) => execFileSync('git', ['config', ...args], { cwd: workspaceDir });
  cfg('user.name', 'Test Cook');
  cfg('user.email', 'cook@example.com');

  await workspace.writeFile('a.txt', 'one\n', { owner: 'user' });
  await workspace.writeFile('src/b.js', 'let b = 1;\n', { owner: 'user' });
  let status = await git.status();
  assert.equal(status.repo, true);
  assert.equal(status.hasCommits, false);
  assert.deepEqual(status.files.map((f) => [f.path, f.work, f.staged]).sort(), [['a.txt', 'U', false], ['src/b.js', 'U', false]], 'memory.md and .kadhai are kept out of the user\'s repo');

  // Stage one file, see it move; unstage works even before the first commit.
  await git.stage(['a.txt']);
  status = await git.status();
  assert.deepEqual(status.files.find((f) => f.path === 'a.txt'), { path: 'a.txt', index: 'A', work: ' ', staged: true, unstaged: false, conflicted: false });
  await git.unstage(['a.txt']);
  assert.equal((await git.status()).files.find((f) => f.path === 'a.txt').staged, false);

  assert.match((await git.diff('src/b.js')).patch, /new file: src\/b\.js[\s\S]*\+let b = 1;/);
  await assert.rejects(git.commit('  '), /commit message/);
  await assert.rejects(git.diff('../outside.txt'), /outside the workspace/);

  // Nothing staged: commit takes everything.
  const first = await git.commit('first commit');
  assert.match(first.commit, /^[0-9a-f]{7,}$/);
  status = await git.status();
  assert.deepEqual([status.hasCommits, status.files.length], [true, 0]);
  assert.deepEqual((await git.log()).map((c) => [c.subject, c.author]), [['first commit', 'Test Cook']]);

  // Change, diff, discard.
  await workspace.writeFile('a.txt', 'two\n', { owner: 'user' });
  await workspace.writeFile('junk.txt', 'x', { owner: 'user' });
  assert.match((await git.diff('a.txt')).patch, /-one\n\+two/);
  await git.discard('a.txt');
  await git.discard('junk.txt');
  // Git may hand the file back with Windows line endings (core.autocrlf); the content is what matters.
  assert.equal((await workspace.readFile('a.txt')).content.replace(/\r/g, ''), 'one\n');
  assert.equal(await workspace.exists('junk.txt'), false);
  assert.equal((await git.status()).files.length, 0);

  // Branches.
  const main = (await git.status()).branch;
  await git.checkout('feature/x', true);
  assert.equal((await git.status()).branch, 'feature/x');
  assert.deepEqual((await git.branches()).sort(), ['feature/x', main].sort());
  await assert.rejects(git.checkout('--force'), /valid branch name/);
  await git.checkout(main);
  assert.equal((await git.status()).branch, main);
});

test('mcp: tool servers can be added, used, switched off, restarted and removed while running', async (t) => {
  const { McpHub, splitCommand } = await import('../src/protocols/mcpClient.js');

  assert.deepEqual(splitCommand('npx -y @scope/server "C:/My Files/data" --flag=\'a b\''), ['npx', '-y', '@scope/server', 'C:/My Files/data', '--flag=a b']);
  assert.deepEqual(splitCommand('node "C:\\Users\\me\\My Server\\run.js" ""'), ['node', 'C:\\Users\\me\\My Server\\run.js', ''], 'Windows backslashes are kept as they are');
  assert.deepEqual(splitCommand("node 'my server.js'"), ['node', 'my server.js']);
  assert.deepEqual(splitCommand('   '), []);

  // A minimal MCP server, speaking newline-delimited JSON-RPC on stdio.
  const dir = await tmpDir('mcp');
  const serverFile = path.join(dir, 'echo-server.js');
  await fs.writeFile(
    serverFile,
    [
      "const rl = require('readline').createInterface({ input: process.stdin });",
      "const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');",
      "rl.on('line', (line) => {",
      '  const m = JSON.parse(line);',
      "  if (m.method === 'initialize') reply(m.id, { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' } });",
      "  else if (m.method === 'tools/list') reply(m.id, { tools: [{ name: 'shout', description: 'Upper-case some text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });",
      "  else if (m.method === 'tools/call') reply(m.id, { content: [{ type: 'text', text: String(m.params.arguments.text).toUpperCase() + ' (' + process.env.GREETING + ')' }] });",
      '});',
    ].join('\n'),
  );
  const configPath = path.join(dir, 'mcp.config.json');
  const events = [];
  const hub = new McpHub({ configPath, version: 'test', bus: { publish: (type) => events.push(type) } });
  t.after(() => hub.close());
  await hub.loadConfig();
  assert.deepEqual(hub.status(), []);

  await assert.rejects(hub.add({ name: 'bad name!', command: 'node x.js' }), /short name/);
  await assert.rejects(hub.add({ name: 'echo', command: '  ' }), /Type the command/);

  const added = await hub.add({ name: 'echo', command: ['node', serverFile], env: { GREETING: 'secret-value' } });
  assert.equal(added.status, 'ready', added.error);
  assert.deepEqual(added.tools, [{ name: 'echo__shout', description: 'Upper-case some text', params: ['text'] }]);
  assert.deepEqual(added.envKeys, ['GREETING']);
  assert.ok(!JSON.stringify(hub.status()).includes('secret-value'), 'setting values never leave the server');
  assert.equal(await hub.call('echo__shout', { text: 'hi' }), 'HI (secret-value)');
  assert.ok(events.includes('mcp:update'));
  await assert.rejects(hub.add({ name: 'echo', command: 'node x.js' }), /already a server/);

  // It is remembered for next time, in the same shape other MCP apps use.
  // Saved in the shape Claude Desktop uses, with the setting's value encrypted.
  const saved = JSON.parse(await fs.readFile(configPath, 'utf8')).mcpServers.echo;
  assert.deepEqual([saved.command, saved.args, Object.keys(saved.env)], ['node', [serverFile], ['GREETING']]);
  assert.match(saved.env.GREETING, /^enc:v1:/);

  // Off: its tools are no longer offered. On again: they are back.
  assert.equal((await hub.setEnabled('echo', false)).status, 'off');
  assert.deepEqual(hub.tools(), []);
  assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).mcpServers.echo.disabled, true);
  assert.equal((await hub.setEnabled('echo', true)).status, 'ready');
  assert.equal(hub.tools().length, 1);
  assert.equal((await hub.restart('echo')).status, 'ready');

  // A command that is not an MCP server is saved but reported, not fatal.
  const broken = await hub.add({ name: 'broken', command: 'node -e "process.exit(1)"' });
  assert.equal(broken.status, 'error');
  assert.match(broken.error, /it stopped \(exit 1\)/);

  await hub.remove('broken');
  await hub.remove('echo');
  assert.deepEqual(hub.status(), []);
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), { mcpServers: {} });
  await assert.rejects(hub.remove('echo'), /No such MCP server/);
});

test('google connector: sign-in flow, read-only tools, token refresh, and nothing secret leaves the server', async () => {
  const { GoogleConnector, Toolbox } = await import('../src/core/connectors/google.js');
  const file = path.join(await tmpDir('google'), 'connectors.json');
  const redirectUri = 'http://localhost:4747/api/connectors/google/callback';

  // A stand-in for Google: records every request and answers like the real endpoints.
  const calls = [];
  let accessToken = 'access-1';
  let refreshFails = false;
  const idToken = 'x.' + Buffer.from(JSON.stringify({ email: 'cook@example.com' })).toString('base64url') + '.y';
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const fakeFetch = async (url, init = {}) => {
    const body = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null;
    calls.push({ url: String(url), auth: init.headers?.authorization, body });
    if (String(url).includes('oauth2.googleapis.com/token')) {
      if (body.client_secret !== 'shh-very-secret') return json(401, { error: 'invalid_client' });
      if (body.grant_type === 'authorization_code') return json(200, { access_token: accessToken, expires_in: 3600, refresh_token: 'refresh-abc', id_token: idToken });
      if (refreshFails) return json(400, { error: 'invalid_grant' });
      accessToken = 'access-2';
      return json(200, { access_token: accessToken, expires_in: 3600 });
    }
    if (String(url).includes('/revoke')) return json(200, {});
    if (init.headers?.authorization !== 'Bearer ' + accessToken) return json(401, { error: { message: 'Invalid Credentials' } });
    if (String(url).includes('/drive/v3/files?')) return json(200, { files: [{ id: 'file-0123456789', name: 'Spec', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-01T10:00:00Z' }] });
    if (String(url).includes('/export')) return json(200, 'Build a todo app.');
    if (String(url).includes('/drive/v3/files/')) return json(200, { name: 'Spec', mimeType: 'application/vnd.google-apps.document' });
    if (String(url).includes('/calendar/')) return json(403, { error: { message: 'Google Calendar API has not been used in project 123 before or it is disabled.' } });
    return json(404, { error: { message: 'not found' } });
  };

  const events = [];
  const google = new GoogleConnector({ file, redirectUri, fetch: fakeFetch, bus: { publish: (type) => events.push(type) } });
  await google.init();
  assert.deepEqual([(await google.status()).configured, google.tools()], [false, []]);

  await assert.rejects(google.setup({ clientId: 'nope', clientSecret: 'shh-very-secret', services: ['drive'] }), /client ID/);
  await assert.rejects(google.setup({ clientId: 'abc-123.apps.googleusercontent.com', clientSecret: 'shh-very-secret', services: [] }), /at least one/);

  const { authUrl } = await google.setup({ clientId: 'abc-123.apps.googleusercontent.com', clientSecret: 'shh-very-secret', services: ['drive', 'calendar', 'bogus'] });
  const url = new URL(authUrl);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const scopes = url.searchParams.get('scope').split(' ');
  assert.deepEqual(scopes, ['openid', 'email', 'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/calendar.readonly']);
  assert.ok(scopes.every((s) => !/\/auth\//.test(s) || s.endsWith('.readonly')), 'only read-only access is ever requested');
  const state = url.searchParams.get('state');

  // A callback that did not start here is refused, and uses up the attempt.
  await assert.rejects(google.callback({ code: 'c', state: 'forged' }), /did not start from this Kadhai/);
  await assert.rejects(google.callback({ code: 'c', state }), /expired/);

  const again = new URL((await google.setup({ services: ['drive', 'calendar'] })).authUrl).searchParams.get('state');
  await assert.rejects(google.callback({ error: 'access_denied', state: again }), /did not give permission/);
  const third = new URL((await google.setup({ services: ['drive', 'calendar'] })).authUrl).searchParams.get('state');
  assert.deepEqual(await google.callback({ code: 'one-time-code', state: third }), { email: 'cook@example.com' });
  const exchange = calls.find((c) => c.body?.grant_type === 'authorization_code');
  assert.equal(exchange.body.code, 'one-time-code');
  assert.ok(exchange.body.code_verifier.length > 30, 'PKCE verifier is sent');

  const status = await google.status();
  assert.deepEqual([status.connected, status.email, status.tools], [true, 'cook@example.com', ['google__drive_search', 'google__drive_read', 'google__calendar_events']]);
  for (const secret of ['shh-very-secret', 'refresh-abc', 'access-1']) assert.ok(!JSON.stringify(status).includes(secret), 'status never carries ' + secret);
  assert.ok(events.includes('connectors:update'));

  // The cooks see these tools next to any MCP ones.
  const toolbox = new Toolbox([{ tools: () => [{ name: 'other__thing', description: '', params: [] }], call: async () => 'from mcp' }, google]);
  assert.deepEqual(toolbox.tools().map((t) => t.name), ['other__thing', 'google__drive_search', 'google__drive_read', 'google__calendar_events']);
  assert.equal(await toolbox.call('other__thing', {}), 'from mcp');
  assert.match(await toolbox.call('google__drive_search', { query: "todo's" }), /^file-0123456789\tSpec\tgoogle document\t2026-10-01$/);
  assert.ok(!decodeURIComponent(calls.at(-1).url).includes("todo's"), 'quotes in a query cannot break out of the Drive filter');
  assert.equal(await toolbox.call('google__drive_read', { fileId: 'file-0123456789' }), '# Spec\nBuild a todo app.');
  await assert.rejects(toolbox.call('google__drive_read', { fileId: '../etc' }), /must be an id/);
  await assert.rejects(toolbox.call('google__gmail_search', { query: 'x' }), /unknown tool/, 'a service that was not chosen has no tools');
  await assert.rejects(toolbox.call('google__calendar_events', {}), /not switched on in your Google Cloud project/);

  // A restart keeps the connection; an expired access token is refreshed quietly.
  const reborn = new GoogleConnector({ file, redirectUri, fetch: fakeFetch });
  await reborn.init();
  assert.equal(reborn.connected, true);
  assert.match(await reborn.call('google__drive_search', { query: 'spec' }), /Spec/);
  assert.equal(calls.filter((c) => c.body?.grant_type === 'refresh_token').length, 1);

  // Revoked at Google: the tools go away and the dashboard is told to reconnect.
  const expired = new GoogleConnector({ file, redirectUri, fetch: fakeFetch });
  await expired.init();
  refreshFails = true;
  await assert.rejects(expired.call('google__drive_search', { query: 'spec' }), /sign-in has expired/);
  assert.deepEqual([(await expired.status()).needsReconnect, expired.tools()], [true, []]);

  const after = await google.disconnect();
  assert.deepEqual([after.connected, after.configured, after.email], [false, true, null]);
  assert.ok(calls.some((c) => c.url.includes('/revoke')));
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).google.refreshToken, undefined);
  assert.equal((await google.disconnect({ forget: true })).configured, false);
});

test('connector catalog: well-formed, hides its commands, and turns what the user typed into a server to start', () => {
  assert.equal(new Set(CATALOG.map((e) => e.id)).size, CATALOG.length, 'ids are unique');
  for (const entry of CATALOG) {
    assert.match(entry.id, /^[\w.-]{1,40}$/, entry.id);
    assert.ok(CATEGORIES.includes(entry.category), `${entry.id}: category`);
    assert.ok(['local', 'open', 'key', 'signin', 'account'].includes(entry.type), `${entry.id}: type`);
    assert.ok(['used', 'starts', 'live'].includes(entry.checked), `${entry.id}: checked`);
    assert.ok(entry.name && entry.icon && entry.blurb, `${entry.id}: text`);
    if (entry.type !== 'account') assert.deepEqual(entry.run.slice(0, 2), ['npx', '-y'], `${entry.id}: runs with npx`);
    if (entry.type === 'signin' || entry.type === 'open') assert.match(entry.run[3], /^https:\/\//, `${entry.id}: bridged to an https address`);
    if (entry.type === 'key') assert.ok(entry.fields?.some((f) => f.secret && f.env), `${entry.id}: asks for a key`);
    // Every "{placeholder}" in a command has a field to fill it.
    for (const part of entry.run ?? []) {
      const key = part.match(/^\{(\w+)\}$/)?.[1];
      if (key) assert.ok(entry.fields.some((f) => f.id === key), `${entry.id}: field for {${key}}`);
    }
  }

  const shown = JSON.stringify(publicCatalog());
  assert.ok(!shown.includes('mcp-remote') && !shown.includes('AUTH_HEADER'), 'commands and env names stay on the server');

  assert.deepEqual(specFor('memory'), { name: 'memory', command: ['npx', '-y', '@modelcontextprotocol/server-memory'], env: {}, startupTimeoutMs: undefined });
  const github = specFor('github', { token: ' ghp_abc ' });
  assert.deepEqual(github.env, { AUTH_HEADER: 'Bearer ghp_abc' });
  assert.ok(!github.command.join(' ').includes('ghp_abc'), 'the token travels in the environment, not on the command line');
  assert.equal(specFor('sqlite', { path: 'C:/My Data/app.db' }).command.at(-1), 'C:/My Data/app.db');
  assert.ok(specFor('linear').startupTimeoutMs >= 120000, 'a sign-in gets minutes, not seconds');

  assert.throws(() => specFor('nope'), { status: 404 });
  assert.throws(() => specFor('google'), /own panel/);
  assert.throws(() => specFor('tavily', {}), /API key is needed/);
  assert.throws(() => specFor('sqlite', { path: 'a.db" & calc "' }), /cannot contain quotes/);
});

test('connector catalog: a token is checked with the service before anything starts', async () => {
  // A refused GitHub token used to start mcp-remote anyway, which then opened a browser sign-in.
  const seen = [];
  const refuse = async (url, init) => {
    seen.push([url, init.headers.authorization ?? init.headers.Authorization]);
    return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401, headers: { 'content-type': 'application/json' } });
  };
  await assert.rejects(checkFields('github', { token: 'ghp_wrong' }, refuse), (err) => err.status === 400 && /GitHub did not accept that, so it was not started/.test(err.message));
  assert.equal(seen[0][0], 'https://api.github.com/user');
  const accept = async () => new Response(JSON.stringify({ login: 'someone' }), { status: 200, headers: { 'content-type': 'application/json' } });
  await checkFields('github', { token: 'ghp_right' }, accept);
  // Entries with nothing to check pass straight through, without a request.
  await checkFields('memory', {}, () => assert.fail('no request expected'));
  assert.ok(CATALOG.filter((e) => e.verify).every((e) => e.type === 'key'), 'only entries that take a key are checked');
});

test('tools are scoped: the Chef sees one line per connection, a cook only the tools of its sub-task', async (t) => {
  const tool = (name) => ({ name, description: `does ${name}`, params: ['q'] });
  const source = { tools: () => [tool('context7__resolve'), tool('context7__docs'), tool('big__one'), tool('big__two'), tool('google__drive_search')] };
  const box = new Toolbox([source], (id) => (id === 'context7' ? 'library docs' : null));
  assert.deepEqual(box.groups(), [
    { id: 'context7', count: 2, about: 'library docs' },
    { id: 'big', count: 2, about: 'tools: one, two' },
    { id: 'google', count: 1, about: 'tools: drive_search' },
  ]);
  assert.deepEqual(box.toolsFor(['context7', 'missing']).map((x) => x.name), ['context7__resolve', 'context7__docs']);
  assert.deepEqual(box.toolsFor(), []);
  assert.deepEqual(box.toolsFor(undefined), []);

  const system = managerSystem(6, false, [], box.groups());
  assert.match(system, /- context7: library docs/);
  assert.ok(!system.includes('context7__resolve'), 'tool descriptions are not in the plan prompt');
  assert.ok(!managerSystem(6).includes('"tools"'), 'no connections, no mention of them');

  // End to end: the plan names a connection for one sub-task only.
  const dir = await tmpDir('scope');
  const prompts = [];
  const completion = async (_route, req, { role }) => {
    if (role === 'manager') {
      return reply(JSON.stringify({ objective: 'two files', subtasks: [
        { title: 'with docs', instructions: 'write a.txt', files: ['a.txt'], level: 'simple', tools: ['context7', 'nonsense'] },
        { title: 'plain', instructions: 'write b.txt', files: ['b.txt'], level: 'simple' },
      ] }));
    }
    if (role === 'reviewer') return reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'fine' }));
    prompts.push(req.messages[0].content);
    const file = /Files to produce: (\S+)/.exec(req.messages.at(-1).content)[1];
    return reply(`<<<FILE ${file}>>>\nhello\n<<<END>>>\nSUMMARY: wrote ${file}`);
  };
  const engine = await createEngine({ workspaceDir: dir, providers: FAKE_PROVIDER, completion, mcp: false, limits: { execMode: 'off' } });
  t.after(() => engine.close());
  engine.orchestrator.mcp = Object.assign(box, { call: async () => 'ok' });
  const result = await engine.orchestrator.start('make two files').done;
  assert.equal(result.ok, true, result.reply);
  const withTools = prompts.filter((p) => p.includes('context7__docs'));
  assert.equal(prompts.length, 2);
  assert.equal(withTools.length, 1, 'only the sub-task that asked for context7 was shown its tools');
  assert.ok(!prompts.some((p) => p.includes('big__one') || p.includes('google__drive_search')), 'connections nobody asked for cost nothing');
});

test('attachments: files sent with a task are shown to the Chef up front and named in the chat', async (t) => {
  const dir = await tmpDir('attach');
  let managerPrompt = '';
  const completion = async (_route, req, { role }) => {
    if (role === 'manager') {
      managerPrompt = req.messages.at(-1).content;
      return reply(JSON.stringify({ objective: 'answer', reply: 'The spec asks for a todo app.', subtasks: [] }));
    }
    return reply('{}');
  };
  const engine = await createEngine({ workspaceDir: dir, providers: FAKE_PROVIDER, completion, mcp: false, limits: { execMode: 'off' } });
  t.after(() => engine.close());
  await engine.workspace.writeFile('attachments/spec.md', '# Spec\nBuild a todo app with tags.', { owner: 'user' });
  await engine.workspace.writeFile('attachments/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]), { owner: 'user' });
  assert.deepEqual([...(await fs.readFile(path.join(dir, 'attachments/logo.png')))], [0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1], 'binary files are saved byte for byte');

  const run = engine.orchestrator.start('what does the spec ask for?', { attachments: ['attachments/spec.md', 'attachments/logo.png', '../outside.txt', 'memory.md'] });
  assert.deepEqual(run.attachments, ['attachments/spec.md', 'attachments/logo.png'], 'paths outside the workspace and memory.md are dropped');
  const result = await run.done;
  assert.equal(result.ok, true, result.reply);
  assert.match(managerPrompt, /Files the user attached/);
  assert.match(managerPrompt, /Build a todo app with tags\./);
  assert.match(managerPrompt, /\(binary file\)/, 'a binary attachment is named, not dumped');
  assert.match(engine.orchestrator.chat.find((m) => m.role === 'user').text, /Attached: attachments\/spec\.md, attachments\/logo\.png/);

  // Without attachments nothing changes.
  await engine.orchestrator.start('and again').done;
  assert.ok(!managerPrompt.includes('Files the user attached'));
});

test('runner: a command can run in a sub-folder of the workspace, and says where it ran', async (t) => {
  const dir = await tmpDir('subdir');
  const engine = await createEngine({ workspaceDir: dir, providers: FAKE_PROVIDER, mcp: false, limits: { execMode: 'auto' } });
  t.after(() => engine.close());
  await engine.workspace.writeFile('pkg/where.js', 'console.log(process.cwd().split(/[\\\\/]/).pop());', { owner: 'user' });

  const inSub = await engine.runner.run('node where.js', { trusted: true, dir: 'pkg' });
  assert.deepEqual([inSub.code, inSub.output, inSub.dir], [0, 'pkg', 'pkg']);
  const atTop = await engine.runner.run('node pkg/where.js', { trusted: true });
  assert.deepEqual([atTop.code, atTop.output, atTop.dir], [0, path.basename(dir), '']);

  // In the sandbox the container is told where to work instead.
  assert.ok(spawnSpec({ sandbox: 'docker', command: 'ls', cwd: '/ws', id: 'x', image: 'i', network: 'none', dir: 'pkg' }).args.join(' ').includes('-w /workspace/pkg'));
  // The route resolves the folder through the workspace, so it cannot point outside it.
  assert.throws(() => engine.workspace.resolve('../elsewhere'));
});

test('connections per agent: a cook is shown, and can call, only the connections it was given', async (t) => {
  const dir = await tmpDir('access');
  const agentsFile = path.join(dir, 'agents.json');
  const tool = (name) => ({ name, description: `does ${name}`, params: ['q'] });
  const called = [];
  const box = new Toolbox([{ tools: () => [tool('github__issues'), tool('notion__search')], call: async (name) => (called.push(name), `result of ${name}`) }]);

  const prompts = [];
  let round = 0;
  const completion = async (_route, req, { role }) => {
    if (role === 'manager') {
      return reply(JSON.stringify({ objective: 'x', subtasks: [{ title: 'a', instructions: 'write a.txt', files: ['a.txt'], tools: ['github', 'notion'] }] }));
    }
    if (role === 'reviewer') return reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'fine' }));
    prompts.push(`${req.messages[0].content}\n${req.messages.at(-1).content}`);
    // First it tries both tools - one it was shown, one it was not - then it writes the file.
    if (round++ === 0) return reply('<<<TOOL github__issues>>>{"q":"1"}<<<END>>>\n<<<TOOL notion__search>>>{"q":"2"}<<<END>>>');
    return reply('<<<FILE a.txt>>>\nhello\n<<<END>>>\nSUMMARY: wrote a.txt');
  };
  const options = { workspaceDir: dir, agentsFile, providers: FAKE_PROVIDER, completion, mcp: false, limits: { execMode: 'off' } };
  const engine = await createEngine(options);
  engine.orchestrator.mcp = box;
  const { crew, hiring } = engine;

  // By default an agent may use everything.
  assert.equal(crew.snapshot().find((a) => a.id === 'chef-de-partie').connections, null);
  assert.equal(crew.mayUse('chef-de-partie', 'notion'), true);
  assert.throws(() => crew.configure('chef-de-partie', { connections: 'github' }), /list of connection names/);

  const view = await hiring.configure('chef-de-partie', { connections: ['github', 'github', 'bad name!'] });
  assert.deepEqual(view.connections, ['github']);
  assert.deepEqual([crew.mayUse('chef-de-partie', 'github'), crew.mayUse('chef-de-partie', 'notion')], [true, false]);
  assert.equal(crew.mayUse('executive-chef', 'notion'), true, 'the others are untouched');

  const result = await engine.orchestrator.start('use the tools').done;
  assert.equal(result.ok, true, result.reply);
  assert.ok(prompts[0].includes('github__issues') && !prompts[0].includes('notion__search'), 'only the allowed connection is offered');
  assert.deepEqual(called, ['github__issues'], 'the tool it was never given was not called, even though it asked');
  assert.match(prompts[1], /result of github__issues/);
  assert.match(prompts[1], /Cook has no access to the "notion" connection/);
  await engine.close();

  // Saved, restored, and an empty list means none at all; null goes back to everything.
  assert.deepEqual(JSON.parse(await fs.readFile(agentsFile, 'utf8')).settings, { 'chef-de-partie': { connections: ['github'] } });
  const reborn = await createEngine(options);
  t.after(() => reborn.close());
  assert.equal(reborn.crew.mayUse('chef-de-partie', 'notion'), false);
  await reborn.hiring.configure('chef-de-partie', { connections: [] });
  assert.equal(reborn.crew.mayUse('chef-de-partie', 'github'), false);
  assert.deepEqual(JSON.parse(await fs.readFile(agentsFile, 'utf8')).settings, { 'chef-de-partie': { connections: [] } });
  await reborn.hiring.configure('chef-de-partie', { connections: null });
  assert.deepEqual(JSON.parse(await fs.readFile(agentsFile, 'utf8')), { agents: [] });
});

test('connections can be kept for certain cooks: nobody else is shown them or can call them', async (t) => {
  const dir = await tmpDir('reserve');
  const agentsFile = path.join(dir, 'agents.json');
  const options = { workspaceDir: dir, agentsFile, mock: true, mcp: false };
  const engine = await createEngine(options);
  const { crew, hiring } = engine;

  assert.deepEqual((await engine.snapshot()).access, {});
  assert.throws(() => crew.restrict('bad name!', ['sous-chef']), /not the name of a connection/);
  assert.throws(() => crew.restrict('github', ['head-chef']), /never uses connections/);
  assert.throws(() => crew.restrict('github', ['nobody-here']), /Unknown agent/);
  assert.throws(() => crew.restrict('github', 'sous-chef'), /list of agent ids/);

  await hiring.hire({ name: 'Git Chef', specialty: 'everything about GitHub' });
  assert.deepEqual(await hiring.restrict('github', ['git-chef', 'git-chef']), { connection: 'github', agents: ['git-chef'] });
  assert.deepEqual([crew.mayUse('git-chef', 'github'), crew.mayUse('sous-chef', 'github'), crew.mayUse('sous-chef', 'notion')], [true, false, true]);

  // Both rules count: the connection's own list, and the agent's.
  await hiring.configure('git-chef', { connections: ['notion'] });
  assert.equal(crew.mayUse('git-chef', 'github'), false, 'reserved for it, but the agent itself is limited to notion');
  await hiring.configure('git-chef', { connections: null });
  assert.equal(crew.mayUse('git-chef', 'github'), true);
  await engine.close();

  // It survives a restart, and letting the agent go does not open the connection to everyone.
  assert.deepEqual(JSON.parse(await fs.readFile(agentsFile, 'utf8')).access, { github: ['git-chef'] });
  const reborn = await createEngine(options);
  t.after(() => reborn.close());
  assert.equal(reborn.crew.mayUse('sous-chef', 'github'), false);
  await reborn.hiring.dismiss('git-chef');
  assert.deepEqual(reborn.crew.access(), { github: [] });
  assert.equal(reborn.crew.mayUse('sous-chef', 'github'), false, 'still reserved - for nobody - until the user says otherwise');
  await reborn.hiring.restrict('github', null);
  assert.equal(reborn.crew.mayUse('sous-chef', 'github'), true);
  assert.deepEqual(JSON.parse(await fs.readFile(agentsFile, 'utf8')), { agents: [] });
});

test('subscription CLIs: used as a model through stdin, in an empty folder, with failover and no keys in their environment', async (t) => {
  const dir = await tmpDir('cli');
  const record = path.join(dir, 'record.json');
  const fake = path.join(dir, 'fake-cli.mjs');
  // Stands in for a real CLI: notes how it was called, then answers the way its arguments ask.
  await fs.writeFile(
    fake,
    `import fs from 'node:fs';
let input = '';
process.stdin.on('data', (c) => (input += c)).on('end', () => {
  const args = process.argv.slice(2);
  const at = args.indexOf('--system-prompt-file');
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, input, cwd: process.cwd(), files: fs.readdirSync('.'), system: at >= 0 ? fs.readFileSync(args[at + 1], 'utf8') : null, leaked: Object.keys(process.env).filter((k) => /API_KEY|TOKEN/.test(k)) }));
  const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : '';
  if (model === 'limited') { console.error('You have hit your usage limit. Try again later.'); process.exit(1); }
  if (model === 'signedout') { console.error('Not logged in. Please run /login'); process.exit(1); }
  if (args.includes('--output-format') && args[args.indexOf('--output-format') + 1] === 'json') console.log(JSON.stringify({ result: 'from the json field', is_error: false, usage: { input_tokens: 7, output_tokens: 3 } }));
  else console.log('<<<FILE a.txt>>>\\nfrom the subscription\\n<<<END>>>\\nSUMMARY: wrote a.txt');
});
`,
  );
  const command = [process.execPath, fake];
  const req = { messages: [{ role: 'system', content: 'SYSTEM RULES "quoted" & <odd> chars' }, { role: 'user', content: 'USER TASK' }] };
  const seen = async () => JSON.parse(await fs.readFile(record, 'utf8'));

  process.env.KADHAI_TEST_API_KEY = 'must-not-leak';
  t.after(() => delete process.env.KADHAI_TEST_API_KEY);

  // A CLI with no system-prompt option gets one text on stdin; nothing of the prompt is on its command line.
  const deltas = [];
  const out = await cliCompletion({ provider: 'codex', label: 'Codex CLI', model: 'default', command }, req, { onDelta: (d) => deltas.push(d.text) });
  assert.match(out.text, /from the subscription/);
  assert.equal(out.usage.estimated, true);
  assert.equal(deltas.length, 1);
  let call = await seen();
  assert.deepEqual(call.args, ['exec', '--skip-git-repo-check', '--ephemeral', '-']);
  assert.match(call.input, /SYSTEM RULES "quoted" & <odd> chars[\s\S]*USER TASK/);
  assert.deepEqual(call.leaked, [], 'no key or token reaches the CLI');
  assert.notEqual(path.resolve(call.cwd), path.resolve(dir));
  assert.deepEqual(call.files, [], 'it runs in an empty folder of its own');
  assert.equal(await fs.access(call.cwd).then(() => true, () => false), false, 'which is removed afterwards');

  // Claude Code takes the system prompt as a file, its tools are switched off, and its JSON answer is read.
  const claude = await cliCompletion({ provider: 'claude-code', label: 'Claude Code', model: 'opus', command }, { ...req, json: true });
  assert.equal(claude.text, 'from the json field');
  assert.deepEqual([claude.usage.promptTokens, claude.usage.completionTokens, claude.usage.estimated], [7, 3, false]);
  call = await seen();
  assert.equal(call.system, 'SYSTEM RULES "quoted" & <odd> chars');
  assert.match(call.input, /^USER TASK[\s\S]*JSON object only/);
  assert.deepEqual(call.args.filter((a) => !a.includes('system.txt')), ['-p', '--system-prompt-file', '--tools', '', '--strict-mcp-config', '--max-turns', '1', '--no-session-persistence', '--output-format', 'json', '--model', 'opus']);

  // Failures are classified: a used-up window cools down, a signed-out or missing CLI is switched off.
  await assert.rejects(cliCompletion({ provider: 'claude-code', label: 'Claude Code', model: 'limited', command }, req), (err) => err.kind === 'rate_limit' && /usage limit/.test(err.message));
  await assert.rejects(cliCompletion({ provider: 'claude-code', label: 'Claude Code', model: 'signedout', command }, req), (err) => err.kind === 'unavailable' && /claude auth login/.test(err.message));
  await assert.rejects(cliCompletion({ provider: 'codex', label: 'Codex CLI', model: 'default', command: ['kadhai-no-such-program'] }, req), (err) => err.kind === 'unavailable' && /not installed/.test(err.message));
  await assert.rejects(cliCompletion({ provider: 'codex', label: 'Codex CLI', model: 'bad name; rm' }, req), (err) => err.kind === 'not_found');
  assert.deepEqual([classifyCli('quota exceeded'), classifyCli('boom'), classifyCli('', new Error('ENOENT'))], ['rate_limit', 'server', 'unavailable']);

  // In a run: the subscription is asked first; when its window is used up the free route carries on.
  const used = [];
  const completion = async (route, r, opts) => {
    if (route.kind === 'cli') return cliCompletion(route, r, opts);
    used.push(`${opts.role}:${route.id}`);
    if (opts.role === 'manager') return reply(JSON.stringify({ objective: 'x', subtasks: [{ title: 'a', instructions: 'write it', files: ['a.txt'] }] }));
    if (opts.role === 'reviewer') return reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'fine' }));
    return reply('<<<FILE a.txt>>>\nfrom the free tier\n<<<END>>>\nSUMMARY: wrote a.txt');
  };
  const providers = [
    { id: 'claude-code', label: 'Claude Code', kind: 'cli', command, baseUrl: 'cli://claude-code', keys: [''], models: ['limited'] },
    ...FAKE_PROVIDER,
  ];
  const engine = await createEngine({ workspaceDir: dir, agentsFile: path.join(dir, 'agents.json'), keysFile: path.join(dir, 'keys.json'), providers, completion, mcp: false, limits: { execMode: 'off' } });
  t.after(() => engine.close());
  assert.deepEqual(engine.dispatcher.status().routes.map((r) => [r.id, r.kind]), [['claude-code/limited', 'cli'], ['fake/m', 'api']]);
  const result = await engine.orchestrator.start('write a').done;
  assert.equal(result.ok, true, result.reply);
  assert.equal(used[0], 'manager:fake/m');
  const [first] = engine.dispatcher.status().routes;
  assert.deepEqual([first.status, first.stats.rateLimits], ['cooling', 1], 'the subscription rests; nothing was switched off');

  // Switching one on needs the program to be there, and says how to get it.
  for (const sub of engine.keys.subscriptions()) {
    assert.deepEqual([typeof sub.installed, sub.enabled], ['boolean', false]);
    if (!sub.installed) await assert.rejects(engine.keys.setSubscription(sub.id, true), /is not installed on this computer/);
  }
  await assert.rejects(engine.keys.setSubscription('no-such-cli', true), /Unknown subscription/);
});

test('triggers: a webhook, a labelled GitHub issue and a Telegram message each start a task, once, behind a gate', async (t) => {
  const dir = await tmpDir('triggers');
  const triggersFile = path.join(dir, 'triggers.json');
  const tasks = [];
  const completion = async (_route, req, { role }) => {
    if (role === 'manager') {
      tasks.push(/## User request\n([\s\S]*?)(\n## |$)/.exec(req.messages.at(-1).content)?.[1].trim() ?? req.messages.at(-1).content);
      return reply(JSON.stringify({ objective: '', reply: 'Done: noted.', subtasks: [] }));
    }
    return reply('{}');
  };

  // Stand-ins for the three services.
  const world = { issues: [], updates: [], sent: [], calls: [] };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, options = {}) => {
    world.calls.push({ url: String(url), auth: options.headers?.authorization ?? null });
    const address = new URL(url);
    if (address.host === 'api.github.com') {
      if (options.headers?.authorization === 'Bearer wrong') return json({ message: 'Bad credentials' }, 401);
      return json(world.issues.filter((issue) => issue.labels.includes(address.searchParams.get('labels'))));
    }
    if (address.host === 'api.telegram.org' && address.pathname.endsWith('/getUpdates')) {
      const offset = Number(address.searchParams.get('offset') ?? 0);
      return json({ ok: true, result: world.updates.filter((u) => u.update_id >= offset) });
    }
    if (address.host === 'api.telegram.org' && address.pathname.endsWith('/sendMessage')) {
      world.sent.push(JSON.parse(options.body));
      return json({ ok: true });
    }
    return json({}, 404);
  };

  const options = { workspaceDir: dir, agentsFile: path.join(dir, 'agents.json'), triggersFile, providers: FAKE_PROVIDER, completion, fetch, mcp: false, limits: { execMode: 'off' } };
  const engine = await createEngine(options);
  const { triggers, orchestrator } = engine;
  // Idle three looks in a row: what a finished run sets off (the reply sent back to Telegram) has landed too.
  // A single short wait after the run made this test fail now and then on a busy machine.
  const settle = async () => {
    for (let quiet = 0; quiet < 3; ) {
      await new Promise((r) => setTimeout(r, 25));
      quiet = orchestrator.busy || orchestrator.queue.length ? 0 : quiet + 1;
    }
  };

  // An engine nobody switched triggers on for (the MCP server, most tests) has none and starts none.
  const plain = await createEngine({ workspaceDir: await tmpDir('plain'), agentsFile: path.join(dir, 'agents2.json'), mock: true, mcp: false });
  assert.deepEqual(plain.triggers.list(), []);
  await assert.rejects(plain.triggers.add({ type: 'webhook' }), /set up in the dashboard/);
  await plain.close();

  // ---- webhook: a token made here, shown once, needed on every call
  const hook = await triggers.add({ type: 'webhook', name: 'nightly' });
  assert.match(hook.token, /^[\w-]{30,}$/);
  assert.equal(hook.path, `/api/hooks/${hook.id}`);
  assert.ok(!('token' in triggers.list()[0]), 'the list never carries it again');
  await assert.rejects(triggers.fire(hook.id, 'nope', { text: 'x' }), /wrong token/);
  await assert.rejects(triggers.fire('0000000000000000', hook.token, { text: 'x' }), /wrong token/);
  await assert.rejects(triggers.fire(hook.id, hook.token, { nothing: true }), /Send the task as JSON/);
  const fired = await triggers.fire(hook.id, hook.token, { text: 'run the nightly tidy-up' });
  assert.match(fired.runId, /^[0-9a-f]{8}$/);
  await settle();
  assert.deepEqual(tasks, ['run the nightly tidy-up']);
  assert.equal(orchestrator.chat.find((m) => m.role === 'user').source, 'webhook');

  // ---- GitHub: only the label counts, each issue once, pull requests never
  await assert.rejects(triggers.add({ type: 'github', repo: 'not a repo' }), /owner\/name/);
  const gh = await triggers.add({ type: 'github', repo: 'me/site', label: 'kadhai', token: 'ghp_SECRET_TOKEN' });
  world.issues = [
    { number: 7, title: 'Fix the footer', body: 'It overlaps on phones.', html_url: 'https://github.com/me/site/issues/7', labels: ['kadhai'] },
    { number: 8, title: 'Unrelated', body: '', html_url: 'u', labels: ['bug'] },
    { number: 9, title: 'A pull request', body: '', html_url: 'u', labels: ['kadhai'], pull_request: {} },
  ];
  await triggers.poll();
  await settle();
  assert.equal(tasks.length, 2);
  assert.match(tasks[1], /GitHub issue #7 in me\/site: Fix the footer[\s\S]*overlaps on phones[\s\S]*issues\/7/);
  await triggers.poll();
  await settle();
  assert.equal(tasks.length, 2, 'the same issue is not a new task the next minute');
  assert.equal(world.calls.find((c) => c.url.includes('api.github.com')).auth, 'Bearer ghp_SECRET_TOKEN');

  // ---- Telegram: the backlog is skipped, strangers are ignored (but noted), the report is sent back
  world.updates = [{ update_id: 100, message: { chat: { id: 42 }, text: 'sent before the trigger existed' } }];
  const tg = await triggers.add({ type: 'telegram', token: '123:TG_SECRET', chats: '42' });
  await triggers.poll();
  await settle();
  assert.equal(tasks.length, 2, 'old messages are not tasks');
  world.updates.push({ update_id: 101, message: { chat: { id: 666 }, text: 'delete everything' } }, { update_id: 102, message: { chat: { id: 42 }, text: 'add a dark theme' } });
  await triggers.poll();
  await settle();
  assert.deepEqual(tasks.slice(2), ['add a dark theme']);
  assert.deepEqual(world.sent, [{ chat_id: 42, text: 'Done: noted.' }]);
  assert.equal(triggers.list().find((x) => x.id === tg.id).stranger, '666');

  // ---- a bad token is a status to show, with the secret kept out of it
  const bad = await triggers.add({ type: 'github', repo: 'me/other', token: 'wrong' });
  await triggers.poll();
  assert.match(triggers.list().find((x) => x.id === bad.id).lastError, /token was rejected/);

  // ---- on disk: tokens are encrypted; after a restart everything is still there and still gated
  const saved = await fs.readFile(triggersFile, 'utf8');
  for (const secret of [hook.token, 'ghp_SECRET_TOKEN', '123:TG_SECRET']) assert.ok(!saved.includes(secret), 'no token in the file');
  await triggers.setEnabled(gh.id, false);
  await engine.close();
  const reborn = await createEngine(options);
  t.after(() => reborn.close());
  assert.deepEqual(reborn.triggers.list().map((x) => [x.type, x.enabled, x.fired]), [['webhook', true, 1], ['github', false, 1], ['telegram', true, 1], ['github', true, 0]]);
  await assert.rejects(reborn.triggers.fire(hook.id, 'nope', { text: 'x' }), /wrong token/);
  assert.match((await reborn.triggers.fire(hook.id, hook.token, { text: 'again' })).runId, /^[0-9a-f]{8}$/);
  await reborn.triggers.remove(hook.id);
  await assert.rejects(reborn.triggers.fire(hook.id, hook.token, { text: 'x' }), /wrong token/);
  while (reborn.orchestrator.busy) await new Promise((r) => setTimeout(r, 20));
});

test('paid keys: Claude natively, any OpenAI-style server, keys that find their provider, and a daily limit', async (t) => {
  const { detectProvider } = await import('../src/config.js');
  const { anthropicCompletion, classifyAnthropic } = await import('../src/core/anthropic.js');
  const { chatCompletion } = await import('../src/core/providers.js');
  const { verifyKey } = await import('../src/core/keyStore.js');

  // ---- a pasted key finds its provider when its prefix is unmistakable, and only then
  assert.deepEqual(
    ['sk-ant-api03-abc', 'sk-or-v1-abc', 'sk-proj-abc', 'gsk_abc', 'AIzaSyAbc', 'xai-abc', 'sk-abcdef', 'whatever'].map((k) => detectProvider(k)),
    ['anthropic', 'openrouter', 'openai', 'groq', 'gemini', 'xai', null, null],
  );

  // ---- the Claude API, spoken natively
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  const sent = [];
  const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  let answer = () => sse([
    { type: 'message_start', message: { usage: { input_tokens: 40, cache_read_input_tokens: 2 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
    { type: 'message_stop' },
  ]);
  globalThis.fetch = async (url, init = {}) => {
    sent.push({ url: String(url), headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
    return answer();
  };
  const claude = { label: 'Claude', baseUrl: 'https://api.anthropic.com/v1', key: 'sk-ant-test', model: 'claude-opus-5-5' };
  const req = { maxTokens: 4096, json: true, messages: [{ role: 'system', content: 'RULES' }, { role: 'user', content: 'TASK' }] };
  const deltas = [];
  const out = await anthropicCompletion(claude, req, { onDelta: (d) => deltas.push(`${d.type}:${d.text}`) });
  assert.deepEqual([out.text, out.reasoning, out.finishReason], ['Hello', 'hmm', 'end_turn']);
  assert.deepEqual(out.usage, { promptTokens: 42, completionTokens: 9, estimated: false });
  assert.deepEqual(deltas, ['reasoning:hmm', 'text:Hel', 'text:lo']);
  const call = sent.at(-1);
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.deepEqual([call.headers['x-api-key'], call.headers['anthropic-version'], call.headers.authorization], ['sk-ant-test', '2023-06-01', undefined]);
  assert.equal(call.body.system, 'RULES');
  assert.deepEqual(call.body.messages.map((m) => m.role), ['user']);
  assert.match(call.body.messages[0].content, /^TASK[\s\S]*JSON object only/);
  assert.ok(call.body.max_tokens >= 16000, 'room for thinking as well as the answer');
  assert.ok(!('temperature' in call.body) && !('thinking' in call.body), 'neither is accepted across the current models');

  // A refusal is "not this route for this request"; errors are sorted by what can be done about them.
  answer = () => sse([{ type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { category: 'cyber' } } }]);
  await assert.rejects(anthropicCompletion(claude, req), (err) => err.kind === 'bad_request' && /declined this request \(cyber\)/.test(err.message));
  const errorReply = (status, type, headers = {}) => () => new Response(JSON.stringify({ type: 'error', error: { type, message: 'because' } }), { status, headers });
  for (const [status, type, kind] of [[401, 'authentication_error', 'auth'], [402, 'billing_error', 'unavailable'], [403, 'permission_error', 'unavailable'], [404, 'not_found_error', 'not_found'], [429, 'rate_limit_error', 'rate_limit'], [529, 'overloaded_error', 'rate_limit'], [500, 'api_error', 'server']]) {
    answer = errorReply(status, type, status === 429 ? { 'retry-after': '7' } : {});
    await assert.rejects(anthropicCompletion(claude, req), (err) => err.kind === kind && (status !== 429 || err.retryAfterMs === 7000), `${status} ${type}`);
    assert.equal(classifyAnthropic(status, type), kind);
  }
  answer = errorReply(402, 'billing_error');
  await assert.rejects(anthropicCompletion(claude, req), /billing problem/);

  // Its key is checked with its own header, against its own model list.
  answer = () => new Response(JSON.stringify({ data: [{ id: 'claude-opus-5-5' }] }), { status: 200 });
  const checked = await verifyKey({ api: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }, 'sk-ant-test');
  assert.deepEqual([checked.verified, checked.models], [true, ['claude-opus-5-5']]);
  assert.equal(sent.at(-1).headers['x-api-key'], 'sk-ant-test');

  // ---- an OpenAI-style server that wants max_completion_tokens and no temperature: learned once, remembered
  const chat = () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  answer = () => {
    const body = sent.at(-1).body;
    if ('max_tokens' in body) return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead. 'temperature' does not support 0.2." } }), { status: 400 });
    return chat();
  };
  const strict = { label: 'Strict', baseUrl: 'https://strict.example/v1', key: 'k', model: 'reasoner' };
  sent.length = 0;
  assert.equal((await chatCompletion(strict, { ...req, json: false })).text, 'ok');
  assert.equal(sent.length, 2, 'one refusal, then the adapted request');
  assert.deepEqual([sent[1].body.max_completion_tokens, 'temperature' in sent[1].body, 'max_tokens' in sent[1].body], [4096, false, false]);
  await chatCompletion(strict, { ...req, json: false });
  assert.equal(sent.length, 3, 'the next call gets it right first time');
  globalThis.fetch = realFetch;

  // ---- in the app: paid keys are listed as paid, ordered by choice, and held to a daily limit
  const dir = await tmpDir('paid');
  const keysFile = path.join(dir, 'keys.json');
  const usedRoutes = [];
  const completion = async (route, r, { role }) => {
    usedRoutes.push(route.id);
    const usage = { promptTokens: 600, completionTokens: 400 };
    if (role === 'manager') return { ...reply(JSON.stringify({ objective: 'x', subtasks: [{ title: 'a', instructions: 'write it', files: ['a.txt'] }] })), usage };
    if (role === 'reviewer') return { ...reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'fine' })), usage };
    return { ...reply('<<<FILE a.txt>>>\nhello\n<<<END>>>\nSUMMARY: wrote a.txt'), usage };
  };
  const engine = await createEngine({ workspaceDir: dir, keysFile, agentsFile: path.join(dir, 'agents.json'), completion, verifyKey: async () => ({ rejected: false, verified: true, models: [] }), mcp: false, limits: { execMode: 'off' } });
  t.after(() => engine.close());
  const { keys, dispatcher } = engine;

  await assert.rejects(keys.addAny('sk-abcdef-not-telling'), /does not say which provider/);
  const added = await keys.addAny('sk-ant-api03-REAL_LOOKING_KEY');
  assert.deepEqual([added.provider, added.paid], ['anthropic', true]);
  await keys.add('groq', 'gsk_free_key_1234567890');
  assert.ok(!(await fs.readFile(keysFile, 'utf8')).includes('REAL_LOOKING_KEY'), 'encrypted on disk like every other key');
  assert.deepEqual(keys.list().filter((p) => p.paid).map((p) => p.id), ['anthropic', 'openai', 'xai', 'deepseek']);

  // Paid first by default: Claude's best model leads, the free tier is the next hop.
  assert.deepEqual(dispatcher.status().routes.slice(0, 2).map((r) => [r.id, r.paid]), [['anthropic/claude-opus-5-5', true], [dispatcher.status().routes[1].id, false]]);
  assert.match(dispatcher.status().routes[1].id, /^groq\//);
  await keys.setSettings({ paidOrder: 'last' });
  assert.match(dispatcher.status().routes[0].id, /^groq\//, 'or only as a fallback, if you say so');
  await keys.setSettings({ paidOrder: 'first', paidDailyTokens: 1500 });
  await assert.rejects(keys.setSettings({ paidDailyTokens: -5 }), /whole number of tokens/);

  // One run: the first call (1,000 tokens) is under the limit, the second takes it over, the rest go to the free route.
  const result = await engine.orchestrator.start('write a').done;
  assert.equal(result.ok, true, result.reply);
  assert.deepEqual(usedRoutes.map((id) => id.split('/')[0]), ['anthropic', 'anthropic', 'groq']);
  const status = dispatcher.status();
  assert.deepEqual(status.paid, { budget: 1500, usedToday: 2000 });
  assert.equal(status.routes.find((r) => r.id === 'anthropic/claude-opus-5-5').overBudget, true);
  assert.equal(keys.settings().paidUsedToday, 2000);

  // With nothing free to fall back on, the run says exactly why it stopped.
  await keys.remove('groq', keys.list().find((p) => p.id === 'groq').keys[0].id);
  const stuck = await engine.orchestrator.start('write a again').done;
  assert.equal(stuck.ok, false);
  assert.match(stuck.reply, /limit for paid models \(1,500 tokens\) is used up/);

  // ---- an endpoint of your own: https (or this computer), then a key and models like any provider
  await assert.rejects(keys.addEndpoint({ name: 'Bad', baseUrl: 'http://example.com/v1' }), /must start with https/);
  await assert.rejects(keys.addEndpoint({ name: 'Bad', baseUrl: 'not a url' }), /full base address/);
  const mine = await keys.addEndpoint({ name: 'My Gateway', baseUrl: 'https://llm.example.com/v1/' });
  assert.deepEqual(mine, { id: 'own-my-gateway', label: 'My Gateway', keyless: false });
  await keys.add(mine.id, 'gw_key_1234567890');
  await keys.setModels(mine.id, ['big-model']);
  assert.ok(dispatcher.status().routes.some((r) => r.id === 'own-my-gateway/big-model' && r.paid));
  const local = await keys.addEndpoint({ name: 'Ollama', baseUrl: 'http://localhost:11434/v1' });
  assert.equal(local.keyless, true);
  await keys.setModels(local.id, ['llama']);
  assert.ok(dispatcher.status().routes.some((r) => r.id === 'own-ollama/llama' && !r.paid), 'a model on this machine needs no key and is not counted as paid');
  await keys.removeEndpoint(mine.id);
  assert.ok(!dispatcher.status().routes.some((r) => r.id.startsWith('own-my-gateway')));
  assert.ok(!(await fs.readFile(keysFile, 'utf8')).includes('own-my-gateway'), 'its key and models go with it');
});

test('flows: a graph of trigger, app, agent, if and http nodes runs along its wires, branches, and never loops', async (t) => {
  const { nextRun } = await import('../src/core/flows.js');

  // ---- when a schedule is next due
  const at = (y, m, d, h, min) => new Date(y, m - 1, d, h, min).getTime();
  assert.equal(nextRun({ kind: 'interval', minutes: 30 }, at(2026, 10, 7, 9, 0)), at(2026, 10, 7, 9, 30));
  assert.equal(nextRun({ kind: 'daily', time: '09:00', days: [] }, at(2026, 10, 7, 8, 0)), at(2026, 10, 7, 9, 0), 'later today');
  assert.equal(nextRun({ kind: 'daily', time: '09:00', days: [] }, at(2026, 10, 7, 9, 0)), at(2026, 10, 8, 9, 0), 'not twice in the same minute');
  // 7 October 2026 is a Wednesday; a Monday-only flow waits until the 12th.
  assert.equal(nextRun({ kind: 'daily', time: '18:30', days: [1] }, at(2026, 10, 7, 12, 0)), at(2026, 10, 12, 18, 30));

  const dir = await tmpDir('flows');
  const flowsFile = path.join(dir, 'flows.json');
  const tool = (name) => ({ name, description: `does ${name}`, params: ['q'] });
  const toolCalls = [];
  let issues = '3 open issues: #7 footer, #8 typo, #9 crash';
  const box = new Toolbox([{
    tools: () => [tool('github__list_issues'), tool('notion__search')],
    call: async (name, args) => {
      toolCalls.push({ name, args });
      if (name === 'notion__search') return 'ERROR: not signed in';
      return issues;
    },
  }]);

  const cooks = []; // one entry per cook call: who, and which tools they were shown
  const requests = []; // what the Chef was asked, per run
  const posted = [];
  const completion = async (_route, req, { role, agent }) => {
    const user = req.messages.at(-1).content;
    if (role === 'manager') {
      requests.push(/## User request\n([\s\S]*?)(\n## |$)/.exec(user)[1].trim());
      // The Chef asks for a junior cook and for notion; what the node pins overrules both.
      return reply(JSON.stringify({ objective: 'x', subtasks: [{ title: 'a', instructions: 'write it', files: ['a.txt'], level: 'simple', tools: ['notion'] }] }));
    }
    if (role === 'reviewer') return reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'fine' }));
    cooks.push({ agent, github: req.messages[0].content.includes('github__list_issues'), notion: req.messages[0].content.includes('notion__search') });
    return reply(`<<<FILE a.txt>>>\nrun ${cooks.length}\n<<<END>>>\nSUMMARY: summary number ${cooks.length}`);
  };
  let clock = at(2026, 10, 7, 9, 0);
  const fetch = async (url, options) => {
    posted.push({ url: String(url), method: options.method, body: options.body ? JSON.parse(options.body) : null });
    return new Response('received', { status: String(url).includes('broken') ? 500 : 200 });
  };
  const options = { workspaceDir: dir, agentsFile: path.join(dir, 'agents.json'), flowsFile, triggersFile: path.join(dir, 'triggers.json'), providers: FAKE_PROVIDER, completion, fetch, now: () => clock, mcp: false, limits: { execMode: 'off' } };
  const engine = await createEngine(options);
  engine.orchestrator.mcp = box;
  const { flows, triggers, orchestrator } = engine;
  const finished = async (id) => {
    // Up to 30 s: under a loaded machine a flow's mock model calls take longer; it stops as soon as the run is done.
    for (let i = 0; i < 2000 && (flows.list().find((f) => f.id === id).running || orchestrator.busy); i++) await new Promise((r) => setTimeout(r, 15));
    return flows.list().find((f) => f.id === id);
  };
  const node = (id, type, config = {}, x = 0, y = 0) => ({ id, type, x, y, config });
  const wire = (from, to, port = 'out') => ({ from, to, port });
  const start = node('t', 'trigger', { kind: 'manual' });

  // An engine nobody switched flows on for has none, like triggers.
  const plain = await createEngine({ workspaceDir: await tmpDir('plain'), agentsFile: path.join(dir, 'agents2.json'), mock: true, mcp: false });
  assert.deepEqual(plain.flows.list(), []);
  await assert.rejects(plain.flows.save({ name: 'x', nodes: [start] }), /set up in the dashboard/);
  await plain.close();

  // ---- drawings that cannot be saved, and why
  const agent = (id, text = 'do it') => node(id, 'agent', { text });
  await assert.rejects(flows.save({ name: '', nodes: [start] }), /Give the flow a name/);
  await assert.rejects(flows.save({ name: 'No start', nodes: [agent('a')] }), /exactly one start/);
  await assert.rejects(flows.save({ name: 'Two starts', nodes: [start, node('u', 'trigger')] }), /exactly one start/);
  await assert.rejects(flows.save({ name: 'Blank', nodes: [start, agent('a', ' ')] }), /nothing to do yet/);
  await assert.rejects(flows.save({ name: 'Loop', nodes: [start, agent('a'), agent('b')], edges: [wire('t', 'a'), wire('a', 'b'), wire('b', 'a')] }), /form a loop/);
  await assert.rejects(flows.save({ name: 'Backwards', nodes: [start, agent('a')], edges: [wire('a', 't')] }), /wired into the start/);
  await assert.rejects(flows.save({ name: 'Fast', nodes: [node('t', 'trigger', { kind: 'schedule', schedule: { kind: 'interval', minutes: 1 } })] }), /at least 5/);
  await assert.rejects(flows.save({ name: 'Idle app', nodes: [start, node('g', 'app', { connection: 'github' })], edges: [wire('t', 'g')] }), /no action chosen/);
  await assert.rejects(flows.save({ name: 'Bad json', nodes: [start, node('g', 'app', { tool: 'github__list_issues', args: '{oops' })] }), /must be a JSON object/);
  await assert.rejects(flows.save({ name: 'Plain http', nodes: [start, node('h', 'http', { url: 'http://example.com/x' })] }), /must start with https/);
  await assert.rejects(flows.save({ name: 'Tool on if', nodes: [start, node('g', 'app', { connection: 'github' }), node('i', 'if', { value: 'x' })], edges: [wire('g', 'i', 'tool')] }), /only on an agent node/);
  await assert.rejects(flows.save({ name: 'Crowd', nodes: [start, ...Array.from({ length: 9 }, (_, i) => agent(`a${i}`))] }), /At most 8 agent nodes/);
  await assert.rejects(
    flows.save({ name: 'Greedy', nodes: [start, agent('a'), ...['w', 'x', 'y', 'z'].map((c) => node(c, 'app', { connection: c }))], edges: ['w', 'x', 'y', 'z'].map((c) => wire(c, 'a', 'tool')) }),
    /at most 3 apps plugged in/,
  );

  // ---- the full shape: trigger -> app -> if -> (true) agent with an app as its tool -> http ; (false) http
  //
  //   [start] --> [github: list issues] --> [if contains "crash"] --true--> [agent: Fixer] --> [POST done]
  //                                                               \--false--> [POST quiet]        ^
  //                                                                             [github] --tool---'
  const flow = await flows.save({
    name: 'Issue watch',
    nodes: [
      start,
      node('list', 'app', { tool: 'github__list_issues', args: '{"repo": "me/site", "note": "{{trigger}}"}' }, 200, 100),
      node('check', 'if', { op: 'contains', value: 'CRASH' }, 400, 100),
      node('fix', 'agent', { text: 'Look into these and say what to do first: {{input}}', agent: 'sous-chef' }, 600, 50),
      node('gh', 'app', { connection: 'github' }, 600, 250),
      node('done', 'http', { method: 'POST', url: 'https://hooks.example.com/done', body: '{"summary": "{{input}}"}' }, 800, 50),
      node('quiet', 'http', { method: 'POST', url: 'https://hooks.example.com/quiet' }, 600, 400),
      node('spare', 'agent', { text: 'never wired in' }, 900, 400),
    ],
    edges: [wire('t', 'list'), wire('list', 'check'), wire('check', 'fix', 'true'), wire('check', 'quiet', 'false'), wire('gh', 'fix', 'tool'), wire('fix', 'done'), wire('gone', 'fix'), wire('t', 'list')],
  });
  assert.equal(flow.edges.length, 6, 'a wire to a node that is not there, and a doubled wire, are dropped');
  assert.deepEqual([flow.enabled, flow.nextRunAt, flow.nodes.find((n) => n.id === 'gh').config], [true, null, { connection: 'github', tool: '', args: '{}' }]);

  assert.match(flows.runNow(flow.id).id, /^[0-9a-f]{8}$/);
  assert.throws(() => flows.runNow(flow.id), /still running/);
  let after = await finished(flow.id);
  assert.deepEqual(toolCalls, [{ name: 'github__list_issues', args: { repo: 'me/site', note: '' } }], 'the app node called its tool itself, with no model in between');
  assert.match(requests[0], /^Look into these and say what to do first: 3 open issues: #7 footer, #8 typo, #9 crash/);
  assert.deepEqual(cooks, [{ agent: 'sous-chef', github: true, notion: false }], 'the pinned cook, with the app plugged into it and not the Chef\'s pick');
  assert.deepEqual(posted.map((p) => p.url), ['https://hooks.example.com/done'], 'only the branch that was taken');
  assert.match(posted[0].body.summary, /summary number 1/);
  assert.deepEqual(Object.fromEntries(Object.entries(after.lastRun.nodes).map(([id, n]) => [id, n.status])), { t: 'ok', list: 'ok', check: 'ok', fix: 'ok', done: 'ok' });
  assert.deepEqual([after.lastRun.ok, after.lastRun.nodes.check.port, after.lastRun.result, after.runs], [true, 'true', 'received', 1]);

  // The other branch: no agent is woken at all.
  issues = 'nothing new';
  posted.length = 0;
  cooks.length = 0;
  flows.runNow(flow.id);
  after = await finished(flow.id);
  assert.deepEqual([posted.map((p) => p.url), cooks.length, after.lastRun.nodes.check.port], [['https://hooks.example.com/quiet'], 0, 'false']);
  assert.ok(!('fix' in after.lastRun.nodes) && !('spare' in after.lastRun.nodes), 'nodes off the path taken did not run');

  // Text from outside cannot break out of an app node's JSON, and a failing node ends the round there.
  const hook = await triggers.add({ type: 'webhook', name: 'inbox' });
  const bound = await flows.save({
    name: 'From outside',
    nodes: [node('t', 'trigger', { kind: 'trigger', id: hook.id }), node('a', 'app', { tool: 'github__list_issues', args: '{"q": "{{input}}"}' }), node('n', 'app', { tool: 'notion__search', args: '{}' }), agent('z', 'unreachable')],
    edges: [wire('t', 'a'), wire('a', 'n'), wire('n', 'z')],
  });
  toolCalls.length = 0;
  requests.length = 0;
  const fired = await triggers.fire(hook.id, hook.token, { text: 'tidy "the docs"\n", "admin": true, "x": "' });
  assert.match(fired.runId, /^[0-9a-f]{8}$/);
  after = await finished(bound.id);
  assert.deepEqual(toolCalls[0].args, { q: 'tidy "the docs"\n", "admin": true, "x": "' }, 'one string, as sent - not extra settings');
  assert.deepEqual([after.lastRun.ok, after.lastRun.failedAt, after.lastRun.nodes.n.status, after.lastRun.nodes.n.output], [false, 'n', 'failed', 'not signed in']);
  assert.equal(requests.length, 0, 'the trigger started the flow, not a plain task, and nothing ran past the failure');

  // ---- on a schedule: not before its time, once when due, and counted from then
  const timed = await flows.save({ name: 'Every half hour', nodes: [node('t', 'trigger', { kind: 'schedule', schedule: { kind: 'interval', minutes: 30 } }), node('h', 'http', { method: 'GET', url: 'https://hooks.example.com/ping' })], edges: [wire('t', 'h')] });
  assert.equal(timed.nextRunAt, clock + 30 * 60000);
  posted.length = 0;
  clock += 29 * 60000;
  await flows.tick();
  assert.equal(posted.length, 0);
  clock += 2 * 60000;
  await flows.tick();
  await flows.tick();
  after = await finished(timed.id);
  assert.deepEqual(posted.map((p) => [p.method, p.url]), [['GET', 'https://hooks.example.com/ping']], 'due once, run once');
  assert.equal(after.nextRunAt, clock + 30 * 60000);
  await flows.setEnabled(timed.id, false);
  clock += 60 * 60000;
  await flows.tick();
  assert.equal((await finished(timed.id)).runs, 1, 'switched off means off');
  await engine.close();

  // ---- saved: drawings, positions and state survive a restart; an old list-of-steps file is read as a graph
  const file = JSON.parse(await fs.readFile(flowsFile, 'utf8'));
  file.flows.push({ id: 'oldstyle0001', name: 'Old style', trigger: { kind: 'manual' }, steps: [{ text: 'first', agent: 'sous-chef', connections: [] }, { text: 'then {{previous}}', agent: '' }], notify: { url: 'https://hooks.example.com/old' } });
  await fs.writeFile(flowsFile, JSON.stringify(file));
  const reborn = await createEngine(options);
  t.after(() => reborn.close());
  assert.deepEqual(reborn.flows.list().map((f) => [f.name, f.enabled, f.runs, f.running]), [['Issue watch', true, 2, false], ['From outside', true, 1, false], ['Every half hour', false, 1, false], ['Old style', true, 0, false]]);
  assert.deepEqual(reborn.flows.list()[0].nodes.find((n) => n.id === 'fix').x, 600);
  const old = reborn.flows.list()[3];
  assert.deepEqual([old.nodes.map((n) => n.type), old.edges.map((e) => `${e.from}>${e.to}`)], [['trigger', 'agent', 'agent', 'http'], ['t>s0', 's0>s1', 's1>n']]);
  await reborn.flows.setEnabled(timed.id, true);
  assert.equal(reborn.flows.list()[2].nextRunAt, clock + 30 * 60000, 'the schedule counts from now');
  await reborn.flows.remove(flow.id);
  await assert.rejects(reborn.flows.remove(flow.id), /No such flow/);
});

test('a sub-task that must produce files is not done until it has, and the Chef is told about a flow\'s connections', async (t) => {
  const dir = await tmpDir('words');
  const tool = (name) => ({ name, description: `does ${name}`, params: [] });
  const cookPrompts = [];
  const managerPrompts = [];
  let wordsOnly = 1; // how many times the first cook answers with a summary and nothing else
  const completion = async (_route, req, { role, agent }) => {
    if (role === 'manager') {
      managerPrompts.push(req.messages.at(-1).content);
      return reply(JSON.stringify({ objective: 'x', subtasks: [{ title: 'graph', instructions: 'write graph.md', files: ['graph.md'] }] }));
    }
    if (role === 'reviewer') return reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'fine' }));
    cookPrompts.push({ agent, text: req.messages.at(-1).content });
    if (agent !== 'executive-chef' && wordsOnly-- > 0) return reply('SUMMARY: I looked into it and it seems fine.');
    return reply('<<<FILE graph.md>>>\n- Kadhai\n<<<END>>>\nSUMMARY: wrote graph.md');
  };
  const engine = await createEngine({ workspaceDir: dir, agentsFile: path.join(dir, 'agents.json'), providers: FAKE_PROVIDER, completion, mcp: false, limits: { execMode: 'off' } });
  t.after(() => engine.close());
  engine.orchestrator.mcp = new Toolbox([{ tools: () => [tool('memory__read_graph')], call: async () => 'ok' }]);

  // Words only, once: the cook is told what is missing and gets it right in the next round.
  let result = await engine.orchestrator.start('make the graph', { tools: ['memory'] }).done;
  assert.equal(result.ok, true, result.reply);
  assert.equal(cookPrompts.length, 2);
  assert.match(cookPrompts[1].text, /you wrote none of the files this sub-task must produce \(graph\.md\)[\s\S]*call a tool/);
  assert.equal((await engine.workspace.readFile('graph.md')).content, '- Kadhai\n');
  // The Chef was told the request has a connection attached, and that it is not a file.
  assert.match(managerPrompts[0], /## Connections attached to this request[\s\S]*memory \(tools: read_graph\)[\s\S]*"memory" is not a file to read/);

  // Words only, every time: that is a failed sub-task, so it goes up the line instead of being reported as done.
  await engine.workspace.deleteFile('graph.md', { owner: 'user' });
  wordsOnly = 99;
  cookPrompts.length = 0;
  result = await engine.orchestrator.start('make the graph again').done;
  assert.equal(result.ok, true, result.reply);
  assert.deepEqual([...new Set(cookPrompts.map((p) => p.agent))], ['chef-de-partie', 'executive-chef'], 'escalated once');
  assert.ok(!/Connections attached/.test(managerPrompts.at(-1)), 'an ordinary request says nothing about attached connections');

  // New files at a path of its own instead of the one it was given: told once, then it writes the right one.
  let elsewhere = 1;
  const moved = async (_route, req, { role, agent }) => {
    if (role === 'manager') return reply(JSON.stringify({ objective: 'x', subtasks: [{ title: 'calc', instructions: 'write calc.js', files: ['calc.js'] }] }));
    if (role === 'reviewer') return reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'fine' }));
    cookPrompts.push({ agent, text: req.messages.at(-1).content });
    if (elsewhere-- > 0) return reply('<<<FILE src/calc.js>>>\nexport const add = (a, b) => a + b;\n<<<END>>>\nSUMMARY: wrote it');
    return reply('<<<FILE calc.js>>>\nexport const add = (a, b) => a + b;\n<<<END>>>\nSUMMARY: wrote calc.js');
  };
  const placed = await createEngine({ workspaceDir: await tmpDir('elsewhere'), agentsFile: path.join(dir, 'agents4.json'), providers: FAKE_PROVIDER, completion: moved, mcp: false, limits: { execMode: 'off' } });
  t.after(() => placed.close());
  cookPrompts.length = 0;
  assert.equal((await placed.orchestrator.start('make calc').done).ok, true);
  assert.equal(cookPrompts.length, 2);
  assert.match(cookPrompts[1].text, /must produce calc\.js, but you created src\/calc\.js instead/);
  assert.equal((await placed.workspace.readFile('calc.js')).content, 'export const add = (a, b) => a + b;\n');

  // Editing a file that already exists at another path is a fair correction of the plan: no complaint.
  const fix = async (_route, req, { role, agent }) => {
    if (role === 'manager') return reply(JSON.stringify({ objective: 'x', subtasks: [{ title: 'calc', instructions: 'fix calc', files: ['calc.js'] }] }));
    if (role === 'reviewer') return reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'fine' }));
    cookPrompts.push({ agent, text: req.messages.at(-1).content });
    return reply('<<<FILE lib/calc.js>>>\nnew\n<<<END>>>\nSUMMARY: the file is in lib/');
  };
  const guessed = await createEngine({ workspaceDir: await tmpDir('guessed'), agentsFile: path.join(dir, 'agents5.json'), providers: FAKE_PROVIDER, completion: fix, mcp: false, limits: { execMode: 'off' } });
  t.after(() => guessed.close());
  await guessed.workspace.writeFile('lib/calc.js', 'old\n', { owner: 'user' });
  cookPrompts.length = 0;
  assert.equal((await guessed.orchestrator.start('fix calc').done).ok, true);
  assert.equal(cookPrompts.length, 1, 'no second round');
  assert.equal((await guessed.workspace.readFile('lib/calc.js')).content, 'new\n');

  // A sub-task that names no files (look something up, run something) may still finish with a summary alone.
  const noFiles = async (_route, req, { role }) => (role === 'manager' ? reply(JSON.stringify({ objective: 'x', subtasks: [{ title: 'look', instructions: 'report', files: [] }] })) : reply('SUMMARY: all quiet'));
  const other = await createEngine({ workspaceDir: await tmpDir('nofiles'), agentsFile: path.join(dir, 'agents3.json'), providers: FAKE_PROVIDER, completion: noFiles, mcp: false, limits: { execMode: 'off' } });
  t.after(() => other.close());
  assert.equal((await other.orchestrator.start('have a look').done).ok, true);
});

test('a cook that asks for its tool in an odd way still gets it: name(), READ of a tool, or only in its thinking', async (t) => {
  const { parseWorkerOutput } = await import('../src/core/parse.js');
  assert.deepEqual(parseWorkerOutput('<<<TOOL memory__read_graph()>>>{}<<<END>>>SUMMARY: asked').tools, [{ name: 'memory__read_graph', args: {}, invalid: false }]);

  const dir = await tmpDir('oddtool');
  const tool = (name) => ({ name, description: `does ${name}`, params: [] });
  const called = [];
  // Three cooks' worth of odd first answers, as gpt-oss-120b gave them on Groq.
  const first = [
    { text: '<<<READ memory__read_graph>>>\nSUMMARY: Retrieved graph data.', reasoning: '' },
    { text: 'SUMMARY: Retrieved graph data.', reasoning: 'We need the graph. First call the tool.<<<TOOL memory__read_graph()>>>{}<<<END>>>' },
    { text: 'SUMMARY: Looking.', reasoning: 'I could write <<<FILE graph.md>>>\nguess\n<<<END>>> or run <<<RUN del graph.md>>>\nbut first <<<READ notes.txt>>>' },
  ];
  let round = 0;
  const seen = [];
  const completion = async (_route, req, { role }) => {
    if (role === 'manager') return reply(JSON.stringify({ objective: 'x', subtasks: [{ title: 'graph', instructions: 'write graph.md', files: ['graph.md'], tools: ['memory'] }] }));
    if (role === 'reviewer') return reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'fine' }));
    const user = req.messages.at(-1).content;
    seen.push(user);
    if (round < first.length && !user.includes('## Data you requested')) return { ...reply(first[round].text), reasoning: first[round].reasoning };
    round += 1;
    return reply('<<<FILE graph.md>>>\n- from the tool\n<<<END>>>\nSUMMARY: wrote graph.md');
  };
  const engine = await createEngine({ workspaceDir: dir, agentsFile: path.join(dir, 'agents.json'), providers: FAKE_PROVIDER, completion, mcp: false, limits: { execMode: 'auto' } });
  t.after(() => engine.close());
  engine.orchestrator.mcp = new Toolbox([{ tools: () => [tool('memory__read_graph')], call: async (name) => (called.push(name), 'GRAPH: Kadhai') }]);
  const ran = [];
  engine.bus.subscribe(({ type, data }) => type === 'exec:start' && ran.push(data.command));
  await engine.workspace.writeFile('notes.txt', 'a note', { owner: 'user' });

  for (const what of ['READ of a tool name', 'tool call left in the thinking']) {
    seen.length = 0;
    const result = await engine.orchestrator.start('make the graph').done;
    assert.equal(result.ok, true, `${what}: ${result.reply}`);
    assert.match(seen[1], /## Data you requested[\s\S]*Tool memory__read_graph\nGRAPH: Kadhai/, what);
    assert.equal(seen.length, 2, `${what}: one round to ask, one to write`);
  }
  assert.deepEqual(called, ['memory__read_graph', 'memory__read_graph']);

  // From the thinking only look-ups are taken. A file or a command that was merely thought about is never acted on.
  seen.length = 0;
  await engine.workspace.writeFile('graph.md', 'before', { owner: 'user' });
  const result = await engine.orchestrator.start('make the graph').done;
  assert.equal(result.ok, true, result.reply);
  assert.match(seen[1], /## Data you requested[\s\S]*notes\.txt[\s\S]*a note/);
  assert.ok(!seen[1].includes('guess'));
  assert.deepEqual(ran, [], 'no command from the thinking was run, even with commands on "auto"');
  assert.equal((await engine.workspace.readFile('graph.md')).content, '- from the tool\n');
});

test('skills of your own: written in the dashboard, loaded into an agent at once, edited, and removed', async (t) => {
  const dir = await tmpDir('ownskills');
  const skillsDir = path.join(dir, 'skills');
  const ownSkillsDir = path.join(dir, 'skills.local');
  await fs.mkdir(skillsDir);
  await fs.writeFile(path.join(skillsDir, 'testing.md'), '---\nname: Testing\ndescription: Built-in advice about tests.\n---\n\nBUILT-IN-BODY\n');

  let cookSystem = '';
  const completion = async (_route, req, { role }) => {
    if (role === 'manager') return reply(JSON.stringify({ objective: 'x', subtasks: [{ title: 'a', instructions: 'write it', files: ['a.txt'] }] }));
    if (role === 'reviewer') return reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'fine' }));
    cookSystem = req.messages[0].content;
    return reply('<<<FILE a.txt>>>\nhello\n<<<END>>>\nSUMMARY: wrote a.txt');
  };
  const options = { workspaceDir: dir, agentsFile: path.join(dir, 'agents.json'), skillsDir, ownSkillsDir, providers: FAKE_PROVIDER, completion, mcp: false, limits: { execMode: 'off' } };
  const engine = await createEngine(options);
  const { skills, hiring, crew } = engine;
  assert.deepEqual(skills.list(), [{ id: 'testing', name: 'Testing', description: 'Built-in advice about tests.', own: false }]);

  // What cannot be saved, and why.
  await assert.rejects(skills.save({ name: '', description: 'something useful', body: 'advice here' }), /Give the skill a name/);
  await assert.rejects(skills.save({ name: 'House style', description: 'x', body: 'advice here' }), /what the skill is for/);
  await assert.rejects(skills.save({ name: 'House style', description: 'How we write code', body: 'short' }), /Write the advice/);
  await assert.rejects(skills.save({ name: 'House style', description: 'How we write code', body: 'line one\n---\nline two' }), /"---" cannot be part/);
  await assert.rejects(skills.save({ name: 'testing', description: 'Same name as a built-in', body: 'advice here' }), /already a skill called/);
  await assert.rejects(skills.save({ name: 'New name', description: 'trying to edit a built-in', body: 'advice here' }, 'testing'), /built-in skill and cannot be changed/);
  await assert.rejects(skills.remove('testing'), /built-in skill/);

  // Written once, it is in the library straight away and can be loaded into any agent.
  const made = await skills.save({ name: 'House style', description: 'How code is laid out here', body: '- ALWAYS-TWO-SPACES\n- single quotes' });
  assert.deepEqual([made.id, made.own, made.body], ['house-style', true, '- ALWAYS-TWO-SPACES\n- single quotes']);
  assert.deepEqual(skills.list().map((s) => [s.id, s.own]), [['house-style', true], ['testing', false]]);
  assert.match(await fs.readFile(path.join(ownSkillsDir, 'house-style.md'), 'utf8'), /^---\nname: House style\ndescription: How code is laid out here\n---\n\n- ALWAYS-TWO-SPACES/);
  assert.deepEqual(await fs.readdir(skillsDir), ['testing.md'], 'the built-in folder is left alone');

  await hiring.configure('chef-de-partie', { skills: ['house-style', 'testing'] });
  assert.equal((await engine.orchestrator.start('write a').done).ok, true);
  assert.match(cookSystem, /### House style\n- ALWAYS-TWO-SPACES[\s\S]*### Testing\nBUILT-IN-BODY/);

  // Edited: same id, new text, used on the very next call.
  const edited = await skills.save({ name: 'House style', description: 'How code is laid out here', body: '- NOW-FOUR-SPACES everywhere' }, 'house-style');
  assert.equal(edited.id, 'house-style');
  await engine.orchestrator.start('write a again').done;
  assert.ok(cookSystem.includes('NOW-FOUR-SPACES') && !cookSystem.includes('ALWAYS-TWO-SPACES'));
  await engine.close();

  // After a restart it is still there and still loaded; deleting it takes it off the agents that had it.
  const reborn = await createEngine(options);
  t.after(() => reborn.close());
  assert.deepEqual(reborn.crew.snapshot().find((a) => a.id === 'chef-de-partie').skills, ['house-style', 'testing']);
  await reborn.skills.remove('house-style');
  assert.deepEqual(reborn.skills.list().map((s) => s.id), ['testing']);
  assert.deepEqual(reborn.crew.snapshot().find((a) => a.id === 'chef-de-partie').skills, ['testing']);
  assert.deepEqual(JSON.parse(await fs.readFile(options.agentsFile, 'utf8')).settings, { 'chef-de-partie': { skills: ['testing'] } });
  assert.deepEqual(await fs.readdir(ownSkillsDir), []);
  await assert.rejects(reborn.skills.remove('house-style'), /No such skill/);
});

test('memory: every run is journalled, questions are answered from it, and a few lessons reach later prompts', async (t) => {
  const { Journal, timeWindow, LESSONS_IN_PROMPT, LESSON_PROMPT_CHARS } = await import('../src/core/journal.js');

  // ---- "yesterday" and friends, as a window of time
  const noon = new Date(2026, 9, 7, 12, 0).getTime();
  const day = 86400000;
  const midnight = new Date(2026, 9, 7).getTime();
  assert.deepEqual(timeWindow('what did we do yesterday?', noon), [midnight - day, midnight]);
  assert.deepEqual(timeWindow('anything today', noon), [midnight, noon + 1]);
  assert.deepEqual(timeWindow('in the last 3 days', noon), [midnight - 2 * day, noon + 1]);
  assert.equal(timeWindow('who wrote the footer', noon), null);

  const dir = await tmpDir('journal');
  let clock = noon - day; // the first two runs happen "yesterday"
  let reviewMode = 'lesson';
  const seen = { manager: [], managerSystem: '', cook: [] };
  const completion = async (_route, req, { role }) => {
    const user = req.messages.at(-1).content;
    if (role === 'manager') {
      seen.manager.push(user);
      seen.managerSystem = req.messages[0].content;
      const request = /## User request\n([\s\S]*)$/.exec(user)[1];
      if (/\?/.test(request)) {
        // A question about the past: first ask for the journal, then answer from it.
        if (!user.includes('## From the journal of past runs')) return reply(JSON.stringify({ objective: '', reply: '', need_history: 'footer', subtasks: [] }));
        return reply(JSON.stringify({ objective: '', reply: `ANSWERED FROM: ${/## From the journal of past runs\n([\s\S]*?)\n\n## /.exec(user)[1].split('\n')[0]}`, subtasks: [] }));
      }
      const file = /footer/.test(request) ? 'footer.html' : 'header.html';
      return reply(JSON.stringify({ objective: `Add the ${file.split('.')[0]}`, subtasks: [{ title: `Write ${file}`, instructions: 'write it', files: [file] }], verify: '' }));
    }
    if (role === 'reviewer') {
      if (reviewMode === 'lesson') return reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'looks right', lessons: ['Pages are plain HTML with no build step.', 'x', 'Styles live in site.css.', 'a third one that must be dropped'] }));
      if (reviewMode === 'revise') {
        reviewMode = 'approve';
        return reply(JSON.stringify({ verdict: 'revise', issues: [{ file: 'header.html', problem: 'the nav has no closing tag', fix: 'close it' }], summary: 'one defect' }));
      }
      return reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'fine now' }));
    }
    seen.cook.push(user);
    const file = /Files to produce: (\S+)/.exec(user)[1];
    return reply(`<<<FILE ${file}>>>\n<p>${seen.cook.length}</p>\n<<<END>>>\nSUMMARY: wrote ${file}`);
  };
  const options = { workspaceDir: dir, agentsFile: path.join(dir, 'agents.json'), providers: FAKE_PROVIDER, completion, journal: true, now: () => clock, mcp: false, limits: { execMode: 'off', maxReviewRounds: 2 } };
  const engine = await createEngine(options);
  const { journal, orchestrator } = engine;

  // An engine without a journal (most tests, the MCP server) keeps none and offers the Chef no such thing.
  const plain = await createEngine({ ...options, workspaceDir: await tmpDir('plain'), journal: false });
  await plain.orchestrator.start('add a footer').done;
  assert.deepEqual([plain.journal.size, plain.journal.listLessons().length], [0, 0]);
  assert.ok(!seen.managerSystem.includes('need_history'));
  await plain.close();
  seen.manager.length = 0;
  seen.cook.length = 0;

  // ---- run 1: journalled with who did what, and the Taster's two lessons kept (the junk and the third dropped)
  assert.equal((await orchestrator.start('add a footer to the site').done).ok, true);
  assert.equal(journal.size, 1);
  const [first] = journal.recent();
  assert.deepEqual([first.request, first.objective, first.ok, first.files, first.source], ['add a footer to the site', 'Add the footer', true, ['footer.html'], 'ui']);
  assert.deepEqual(first.steps.map((s) => [s.title, s.cook, s.cookName, s.model, s.status]), [['Write footer.html', 'chef-de-partie', 'Cook', 'm', 'done']]);
  assert.deepEqual(first.review, { verdict: 'approved', issues: 0, summary: 'looks right' });
  assert.deepEqual(journal.listLessons().map((l) => [l.text, l.for]), [['Pages are plain HTML with no build step.', 'all'], ['Styles live in site.css.', 'all']]);
  assert.ok(!seen.cook[0].includes('Learned on earlier work'), 'nothing had been learned yet');

  // ---- run 2: a defect found in a cook's step becomes that cook's own lesson; the project's lessons are in its prompt
  reviewMode = 'revise';
  clock += 3600000;
  assert.equal((await orchestrator.start('add a header').done).ok, true);
  assert.match(seen.cook[1], /## Learned on earlier work in this folder\n- Pages are plain HTML with no build step\.\n- Styles live in site\.css\./);
  assert.deepEqual(journal.listLessons().filter((l) => l.for !== 'all').map((l) => [l.text, l.for]), [['In header.html a review found: the nav has no closing tag', 'chef-de-partie']]);
  assert.deepEqual(journal.recent()[0].review, { verdict: 'revised', issues: 1, summary: 'fine now' });
  assert.deepEqual(journal.recent()[0].steps.map((s) => s.cook), ['chef-de-partie', 'sous-chef']);

  // ---- "today": a question in plain words is answered from the journal, and is not itself journalled
  clock = noon;
  seen.manager.length = 0;
  const answer = await orchestrator.start('who worked on the footer yesterday, and how did it go?').done;
  assert.equal(seen.manager.length, 2, 'one call to ask for the journal, one to answer');
  assert.match(seen.managerSystem, /"need_history"/);
  const shown = /## From the journal of past runs\n([\s\S]*?)\n\n## /.exec(seen.manager[1])[1];
  assert.match(shown, /2026-10-06 12:00 \[finished\] asked: "add a footer to the site"[\s\S]*steps: Write footer\.html - Cook on m, done[\s\S]*files: footer\.html[\s\S]*review: approved - looks right/);
  assert.match(shown.split('\n')[0], /footer/, 'the run about the footer comes first');
  assert.match(answer.reply, /^ANSWERED FROM: - 2026-10-06 12:00 \[finished\] asked: "add a footer to the site"/);
  assert.equal(journal.size, 2);
  // The same through the API's door: by words, by time, or simply the latest.
  assert.deepEqual(journal.search('header').map((e) => e.objective), ['Add the header']);
  assert.equal(journal.search('what happened today?').length, 0);
  assert.equal(journal.search('what did we do yesterday?').length, 2);
  assert.match(journal.describe([]), /nothing that matches/);

  // ---- however much is learned, a prompt gets a handful: the agent's own first, within a fixed size
  await journal.learn(Array.from({ length: 12 }, (_, i) => ({ text: `Project fact number ${i} that is reasonably long so the size limit is what stops the list, not the count.`, for: 'all' })), 'x');
  const forCook = journal.lessonsFor('chef-de-partie');
  assert.ok(forCook.length <= LESSONS_IN_PROMPT && forCook.join('').length <= LESSON_PROMPT_CHARS);
  assert.match(forCook[0], /^In header\.html a review found/, 'its own lesson leads');
  assert.ok(!journal.lessonsFor('sous-chef').some((l) => l.startsWith('In header.html')), 'another cook is not told of a mistake that was not its own');
  // Said again, a lesson is not stored twice.
  const before = journal.listLessons().length;
  await journal.learn([{ text: 'pages are plain HTML, with no build step', for: 'all' }], 'y');
  assert.equal(journal.listLessons().length, before);
  assert.equal(journal.listLessons().find((l) => l.text.startsWith('Pages are plain')).seen, 2);
  await engine.close();

  // ---- it outlives the session: a new engine on the same folder has the runs and the lessons, and one can be forgotten
  assert.equal((await fs.readFile(path.join(dir, '.kadhai', 'journal.jsonl'), 'utf8')).trim().split('\n').length, 2);
  const reborn = await createEngine(options);
  t.after(() => reborn.close());
  assert.equal(reborn.journal.size, 2);
  assert.deepEqual(reborn.journal.search('footer').map((e) => e.request), ['add a footer to the site']);
  const own = reborn.journal.listLessons().find((l) => l.for === 'chef-de-partie');
  await reborn.journal.forget(own.id);
  assert.ok(!reborn.journal.lessonsFor('chef-de-partie').some((l) => l.startsWith('In header.html')));
  await assert.rejects(reborn.journal.forget(own.id), /No such lesson/);
  // A damaged last line (a crash mid-write) loses that line only.
  await fs.appendFile(path.join(dir, '.kadhai', 'journal.jsonl'), '{"id":"half');
  const again = new Journal({ dir: path.join(dir, '.kadhai'), enabled: true });
  await again.init();
  assert.equal(again.size, 2);
});

test('generate an agent: the Chef writes the hire form; nothing is hired, made-up skills and taken names are fixed', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kadhai-gen-'));
  const skillsDir = path.join(dir, 'skills');
  await fs.mkdir(skillsDir);
  await fs.writeFile(path.join(skillsDir, 'testing.md'), '---\nname: Testing\ndescription: Write tests first\n---\n- Test edge cases.\n');
  const prompts = [];
  const completion = async (_route, req) => {
    prompts.push(req.messages.map((m) => m.content).join('\n'));
    return reply(JSON.stringify({ name: 'Chef', specialty: 'Unit tests with node:test and fixtures', instructions: ['Write the failing test first', '- Never touch the network'], skills: ['testing', 'made-up'] }));
  };
  const engine = await createEngine({ workspaceDir: dir, agentsFile: path.join(dir, 'agents.json'), skillsDir, ownSkillsDir: path.join(dir, 'own'), providers: FAKE_PROVIDER, completion, mcp: false });
  t.after(() => engine.close());
  const draft = await engine.hiring.generate('someone who writes tests for my node code');
  assert.match(prompts[0], /testing: Write tests first/, 'the Chef is shown the skill library');
  assert.equal(draft.name, 'Chef 2', 'a name already in the crew is not reused');
  assert.equal(draft.specialty, 'Unit tests with node:test and fixtures');
  assert.equal(draft.instructions, '- Write the failing test first\n- Never touch the network');
  assert.deepEqual(draft.skills, ['testing'], 'only skills that exist');
  assert.equal(engine.crew.customDefinitions().length, 0, 'nobody is hired until the user presses Hire');
  await assert.rejects(engine.hiring.generate(''), /few words/);
});
