import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEngine } from '../src/core/engine.js';
import { canAct } from '../src/core/cliAgent.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent.mjs');
const tmpDir = (name) => fs.mkdtemp(path.join(os.tmpdir(), `kadhai-${name}-`));
const reply = (text) => ({ text, reasoning: '', finishReason: 'stop', usage: { promptTokens: 100, completionTokens: 20 } });
const approve = reply(JSON.stringify({ verdict: 'approve', issues: [], summary: 'fine' }));

/** An engine whose subscription "CLI" is the fake agent, beside an ordinary HTTP model. */
async function kitchen(step, { command = ['node', FAKE], flame = 'high' } = {}) {
  const dir = await tmpDir('agents');
  const calls = [];
  const completion = async (route, req, { role }) => {
    calls.push({ route: route.id, role });
    if (role === 'manager') return reply(JSON.stringify({ objective: 'x', subtasks: [step] }));
    if (role === 'reviewer') return approve;
    // The ordinary cook: what is used when no CLI can take the step.
    return reply('<<<FILE hello.js>>>\nconsole.log("from a model");\n<<<END>>>\nSUMMARY: wrote it as a model');
  };
  const engine = await createEngine({
    workspaceDir: path.join(dir, 'ws'),
    agentsFile: path.join(dir, 'agents.json'),
    providers: [
      { id: 'claude-code', label: 'Claude Code', kind: 'cli', command, baseUrl: 'cli://claude-code', keys: [''], models: ['default'] },
      { id: 'fake', label: 'Fake', baseUrl: 'x', keys: ['k'], models: ['m1'] },
    ],
    completion,
    mcp: false,
    limits: { execMode: 'off' },
  });
  engine.setFlame(flame);
  const ws = (file) => path.join(engine.config.workspaceDir, file);
  return { engine, calls, ws, thoughts: () => engine.crew.snapshot().map((a) => a.thought).join('\n') };
}

test('only a CLI that can switch its shell off acts as an agent without the shell', () => {
  assert.equal(canAct('claude-code', false), true);
  assert.equal(canAct('codex', false), false);
  assert.equal(canAct('gemini-cli', false), false);
  assert.equal(canAct('codex', true), true);
  assert.equal(canAct('groq', true), false, 'an HTTP model is never an agent');
});

test('high flame: a CLI agent does the step in a copy; its changes come back through the workspace', async (t) => {
  const { engine, ws, thoughts } = await kitchen({ title: 'Say hello', instructions: 'write hello.js, remove old.txt', files: ['hello.js'] });
  t.after(() => engine.close());
  await fs.writeFile(ws('old.txt'), 'bye\n');
  const memoryBefore = await fs.readFile(ws('memory.md'), 'utf8');
  const writes = [];
  engine.bus.subscribe(({ type, data }) => type === 'fs:write' && writes.push(data));

  const result = await engine.orchestrator.start('say hello').done;
  assert.equal(result.ok, true, result.reply);
  assert.equal(await fs.readFile(ws('hello.js'), 'utf8'), 'console.log("hello");\n');
  await assert.rejects(fs.stat(ws('old.txt')), 'its delete came back too');
  assert.match(result.reply, /wrote hello\.js and removed old\.txt/);
  // Written by the cook, through Workspace - and memory.md is never taken from the copy.
  assert.ok(writes.some((w) => w.path === 'hello.js' && w.owner === 'chef-de-partie'));
  assert.notEqual(await fs.readFile(ws('memory.md'), 'utf8'), 'an agent must not get to write this');
  assert.ok(memoryBefore.length > 0);
  // Edits only, unless the operator said otherwise for the run; nothing the folder brought may run.
  const text = thoughts();
  assert.match(text, /\[agent\] Claude Code works on a copy of the folder, edits only/);
  assert.match(text, /\[Write\] hello\.js/);
  assert.match(text, /--tools Read,Edit,Write,Glob,Grep/);
  assert.doesNotMatch(text, /Bash/);
  assert.match(text, /--setting-sources user --strict-mcp-config/);
  // Counted like any call, and undoable like any run.
  const route = engine.dispatcher.status().routes.find((r) => r.provider === 'claude-code');
  assert.ok(route.day.promptTokens >= 1200);
  const diff = await engine.orchestrator.diff(result.runId);
  assert.deepEqual(diff.files.map((f) => f.path).sort(), ['hello.js', 'old.txt']);
});

test('the shell is allowed only when the operator asked for it in the dashboard', async (t) => {
  const { engine, thoughts } = await kitchen({ title: 'Say hello', instructions: 'write hello.js', files: ['hello.js'] });
  t.after(() => engine.close());
  await engine.orchestrator.start('say hello', { source: 'flow', shell: true }).done;
  assert.doesNotMatch(thoughts(), /Bash/, 'a flow never gets it');
  await engine.orchestrator.start('say hello again', { source: 'ui', shell: true }).done;
  assert.match(thoughts(), /commands allowed/);
  assert.match(thoughts(), /--tools Bash,Read,Edit,Write,Glob,Grep --permission-mode acceptEdits --allowedTools Bash/);
});

test('low flame never starts an agent: the CLI stays a model', async (t) => {
  const { engine, thoughts, ws } = await kitchen({ title: 'Say hello', instructions: 'write hello.js', files: ['hello.js'] }, { flame: 'low' });
  t.after(() => engine.close());
  const result = await engine.orchestrator.start('say hello').done;
  assert.equal(result.ok, true);
  assert.doesNotMatch(thoughts(), /\[agent\]/);
  assert.equal(await fs.readFile(ws('hello.js'), 'utf8'), 'console.log("from a model");\n');
});

test('a CLI that cannot be used is switched off and an ordinary model takes the step', async (t) => {
  const { engine, ws, thoughts } = await kitchen({ title: 'Say hello', instructions: 'MODE:signed-out write hello.js', files: ['hello.js'] });
  t.after(() => engine.close());
  const result = await engine.orchestrator.start('say hello').done;
  assert.equal(result.ok, true, result.reply);
  assert.equal(await fs.readFile(ws('hello.js'), 'utf8'), 'console.log("from a model");\n');
  assert.match(thoughts(), /not signed in - run "claude auth login".* an ordinary model takes this step/);
  assert.equal(engine.dispatcher.status().routes.find((r) => r.provider === 'claude-code').status, 'disabled');
});

test('an agent that wrote nothing, or ran out of turns, has failed its step', async (t) => {
  const { engine } = await kitchen({ title: 'Say hello', instructions: 'MODE:talk write hello.js', files: ['hello.js'] });
  t.after(() => engine.close());
  const talked = await engine.orchestrator.start('say hello').done;
  // Escalated once, and the Senior Cook (also an agent here) only talked too.
  assert.equal(talked.ok, false);
  assert.match(talked.reply, /none of its files were written \(hello\.js\)/);

  const { engine: second } = await kitchen({ title: 'Say hello', instructions: 'MODE:turns', files: [] });
  t.after(() => second.close());
  const out = await second.orchestrator.start('say hello').done;
  assert.equal(out.ok, false);
  assert.match(out.reply, /Claude Code stopped: it used up its turns/);
});

test('a file changed in the folder while the agent worked is merged, and a real conflict is refused', async (t) => {
  for (const [ours, expected, ok] of [
    ['one\ntwo\nTHREE\n', 'ONE\ntwo\nTHREE\n', true], // different lines: both changes kept
    ['uno\ntwo\nthree\n', 'uno\ntwo\nthree\n', false], // the same line: ours stays, the step fails
  ]) {
    const { engine, ws } = await kitchen({ title: 'Shout', instructions: 'MODE:merge', files: [] });
    t.after(() => engine.close());
    await fs.writeFile(ws('notes.txt'), 'one\ntwo\nthree\n');
    // As soon as the agent is at work, someone edits the same file here.
    const stop = engine.bus.subscribe(({ type, data }) => {
      if (type === 'agent:thought' && /\[agent\]/.test(data.delta)) {
        stop();
        engine.workspace.writeFile('notes.txt', ours, { owner: 'user' });
      }
    });
    const steps = [];
    engine.bus.subscribe(({ type, data }) => type === 'run:plan' && steps.push(...data.subtasks.map((s) => s.summary)));
    await engine.orchestrator.start('shout').done;
    assert.equal(await fs.readFile(ws('notes.txt'), 'utf8'), expected);
    // A conflict fails the step (it is then retried, and the retry finds nothing left to shout).
    assert.equal(steps.some((s) => /notes\.txt changed here meanwhile and the two versions conflict/.test(s)), !ok);
  }
});

// ------------------------------------------------------------- parallel steps

/** A kitchen with ordinary models only; each cook's call takes a moment, and when it ran is noted. */
async function line(subtasks, flame = 'high', together = []) {
  // Steps named in together wait (up to 5 s) until all of them have started: overlap then does not
  // depend on how busy the machine is, and steps that ran one after another still show no overlap.
  const begun = new Set();
  const dir = await tmpDir('parallel');
  const spans = [];
  const chef = [];
  const completion = async (route, req, { role, agent }) => {
    if (role === 'manager') {
      chef.push(req.messages[0].content);
      return reply(JSON.stringify({ objective: 'x', subtasks }));
    }
    if (role === 'reviewer') return approve;
    const step = subtasks.find((s) => req.messages[1].content.includes(`## Your sub-task: ${s.title}`));
    const span = { title: step.title, agent, start: Date.now() };
    begun.add(step.title);
    const until = Date.now() + 5000;
    while (together.includes(step.title) && !together.every((s) => begun.has(s)) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 300));
    span.end = Date.now();
    spans.push(span);
    return reply(`<<<FILE ${step.files[0]}>>>\n// ${step.title}\n<<<END>>>\nSUMMARY: did ${step.title}`);
  };
  const engine = await createEngine({
    workspaceDir: path.join(dir, 'ws'),
    agentsFile: path.join(dir, 'agents.json'),
    providers: [{ id: 'fake', label: 'Fake', baseUrl: 'x', keys: ['k'], models: ['m1'] }],
    completion,
    mcp: false,
    limits: { execMode: 'off' },
  });
  engine.setFlame(flame);
  const span = (title) => spans.find((s) => s.title === title);
  const overlap = (a, b) => span(a).start < span(b).end && span(b).start < span(a).end;
  return { engine, span, overlap, chef };
}

test('high flame: steps that need nothing from each other are cooked at once, by different cooks', async (t) => {
  const { engine, span, overlap, chef } = await line([
    { title: 'A', instructions: 'a', files: ['a.js'], level: 'standard', needs: [] },
    { title: 'B', instructions: 'b', files: ['b.js'], level: 'standard', needs: [] },
    { title: 'C', instructions: 'c', files: ['c.js'], level: 'standard', needs: [1, 2] },
  ], 'high', ['A', 'B']);
  t.after(() => engine.close());
  const plans = [];
  engine.bus.subscribe(({ type, data }) => type === 'run:plan' && plans.push(data.subtasks.map((s) => s.cookId)));
  const result = await engine.orchestrator.start('three files').done;
  assert.equal(result.ok, true, result.reply);
  assert.ok(overlap('A', 'B'), 'A and B at the same time');
  assert.ok(span('C').start >= Math.max(span('A').end, span('B').end), 'C after both');
  // Both were "standard": the second went to the next free cook up the line, and the plan shows who.
  assert.notEqual(span('A').agent, span('B').agent);
  assert.deepEqual(plans.at(-1).slice(0, 2), ['chef-de-partie', 'executive-chef']);
  assert.match(chef[0], /"needs":\[numbers of the earlier sub-tasks/);
});

test('steps that share a file, or say nothing about needs, still go one at a time', async (t) => {
  const { engine, overlap } = await line([
    { title: 'A', instructions: 'a', files: ['shared.js'], needs: [] },
    { title: 'B', instructions: 'b', files: ['shared.js'], needs: [] },
    { title: 'C', instructions: 'c', files: ['c.js'] }, // no "needs": after the one before it
  ]);
  t.after(() => engine.close());
  assert.equal((await engine.orchestrator.start('go').done).ok, true);
  assert.equal(overlap('A', 'B'), false);
  assert.equal(overlap('B', 'C'), false);
});

test('a need that points forward or at itself is dropped: no step can wait for ever', async (t) => {
  const { engine, overlap } = await line([
    { title: 'A', instructions: 'a', files: ['a.js'], needs: [2, 1, 99] },
    { title: 'B', instructions: 'b', files: ['b.js'], needs: [] },
  ], 'high', ['A', 'B']);
  t.after(() => engine.close());
  assert.equal((await engine.orchestrator.start('go').done).ok, true);
  assert.ok(overlap('A', 'B'));
});

test('low flame keeps one step at a time, and the Chef is not asked about needs', async (t) => {
  const { engine, overlap, chef } = await line(
    [
      { title: 'A', instructions: 'a', files: ['a.js'], needs: [] },
      { title: 'B', instructions: 'b', files: ['b.js'], needs: [] },
    ],
    'low',
  );
  t.after(() => engine.close());
  assert.equal((await engine.orchestrator.start('go').done).ok, true);
  assert.equal(overlap('A', 'B'), false);
  assert.doesNotMatch(chef[0], /"needs"/);
});

test('stopping a run with steps cooking side by side waits for both, and the next task still starts', async (t) => {
  const { engine } = await line([
    { title: 'A', instructions: 'a', files: ['a.js'], needs: [] },
    { title: 'B', instructions: 'b', files: ['b.js'], needs: [] },
  ]);
  t.after(() => engine.close());
  const first = engine.orchestrator.start('go');
  const second = engine.orchestrator.start('then this');
  await new Promise((resolve) => setTimeout(resolve, 100));
  engine.orchestrator.stop();
  const stopped = await first.done;
  assert.equal(stopped.ok, false);
  assert.match(stopped.reply, /stopped/i);
  assert.equal((await second.done).ok, true, 'the queue moved on');
  assert.ok(engine.crew.snapshot().every((a) => a.state !== 'working'));
});

// ------------------------------------------------------------ recall of files

test('high flame: a cook is told what earlier runs did to its files; low flame is not', async (t) => {
  const dir = await tmpDir('recall');
  const prompts = [];
  let review = { verdict: 'revise', issues: [{ file: 'login.js', problem: 'compares passwords in plain text', fix: 'hash them' }], summary: 'passwords in plain text' };
  const completion = async (route, req, { role }) => {
    if (role === 'manager') return reply(JSON.stringify({ objective: req.messages[1].content.includes('second') ? 'Add a logout' : 'Add a login', subtasks: [{ title: 'Write login.js', instructions: 'do it', files: ['login.js'] }] }));
    if (role === 'reviewer') {
      const out = reply(JSON.stringify(review));
      review = { verdict: 'approve', issues: [], summary: 'fine' };
      return out;
    }
    prompts.push(req.messages[1].content);
    return reply('<<<FILE login.js>>>\nexport const login = () => true;\n<<<END>>>\nSUMMARY: wrote the login');
  };
  const engine = await createEngine({
    workspaceDir: path.join(dir, 'ws'),
    agentsFile: path.join(dir, 'agents.json'),
    providers: [{ id: 'fake', label: 'Fake', baseUrl: 'x', keys: ['k'], models: ['m1'] }],
    completion,
    mcp: false,
    journal: true,
    limits: { execMode: 'off' },
  });
  t.after(() => engine.close());

  await engine.orchestrator.start('first: a login').done;
  engine.setFlame('low');
  prompts.length = 0;
  await engine.orchestrator.start('second, low flame').done;
  assert.doesNotMatch(prompts[0], /Earlier work on these files/);

  engine.setFlame('high');
  prompts.length = 0;
  await engine.orchestrator.start('second, high flame').done;
  const recall = /## Earlier work on these files\n([\s\S]*?)(\n\n|$)/.exec(prompts[0])?.[1] ?? '';
  assert.match(recall, /"Add a login" - Write login\.js \(Cook, done\): wrote the login; Apply review fixes \(Fixer, done\): .*Review found 1 issue\(s\): passwords in plain text/);
  assert.match(recall.split('\n')[0], /"Add a logout"/, 'newest first');
  // A fixed amount, whatever the journal holds.
  assert.ok(recall.length <= 1200 + 40);
});
