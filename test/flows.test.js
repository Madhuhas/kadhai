import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createEngine } from '../src/core/engine.js';
import { Toolbox } from '../src/core/connectors/google.js';
import { fill, value, test as check, keep } from '../src/core/flowData.js';
import { parseFeed, SERVICES, CREDENTIAL_TYPES, catalog } from '../src/core/services.js';
import { readOpenApi } from '../src/core/flows.js';
import { GIVES } from '../src/core/flowDraft.js';

const tmpDir = (name) => fs.mkdtemp(path.join(os.tmpdir(), `kadhai-${name}-`));
const FAKE_PROVIDER = [{ id: 'fake', label: 'Fake', baseUrl: 'x', keys: ['k'], models: ['m'] }];
const reply = (text) => ({ text, reasoning: '', finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 } });
const node = (id, type, config = {}, extra = {}) => ({ id, type, x: 0, y: 0, config, ...extra });
const wire = (from, to, port = 'out') => ({ from, to, port });
const start = node('t', 'trigger', { kind: 'manual' });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

test('flow data: expressions read paths, keep types, and are never code', () => {
  const ctx = { input: { title: 'Hi', items: [{ url: 'a' }, { url: 'b' }], n: 3 }, trigger: '{"chat":"42"}', node: (name) => ({ fetch: { body: 'ok' } })[name.toLowerCase()], now: () => Date.UTC(2026, 9, 15) };
  assert.equal(fill('{{ input.title }} / {{input.items[1].url}} / {{ trigger.chat }}', ctx), 'Hi / b / 42', 'text that holds JSON is read as JSON');
  assert.equal(fill("{{ node('Fetch').body }} and {{ node(\"fetch\").body }}", ctx), 'ok and ok');
  assert.equal(fill('{{ input }}', { input: { a: 1 } }), '{"a":1}');
  assert.equal(fill('{{ today }}', ctx), '2026-10-15');
  assert.equal(fill('{{ input.missing.deeper }}|{{ nope }}|{{ input.constructor.constructor("x")() }}', ctx), '|{{ nope }}|{{ input.constructor.constructor("x")() }}', 'unknown stays as written; calls are not expressions');
  assert.deepEqual(value('{{ input.items }}', ctx), [{ url: 'a' }, { url: 'b' }], 'one expression alone keeps its type');
  assert.equal(value('{{ input.n }}', ctx), 3);
  assert.equal(value('n = {{ input.n }}', ctx), 'n = 3');
  assert.ok(check({ left: '{{ input.n }}', op: 'gt', value: '2' }, ctx));
  assert.ok(!check({ left: '{{ input.title }}', op: 'equals', value: 'bye' }, ctx));
  assert.ok(check({ left: '{{ input.items }}', op: 'not_empty' }, ctx));
  assert.ok(check({ left: '{{ input.title }}', op: 'matches', value: '^h' }, ctx));
  assert.deepEqual(keep('x'.repeat(50), 10), { '[clipped]': `${'x'.repeat(10)}…`, length: 50 });
});

test('services: feeds parse, every endpoint is https, the catalog carries no functions', () => {
  const rss = '<rss><channel><item><title><![CDATA[First &amp; best]]></title><link>https://a.example/1</link><guid>g1</guid><pubDate>Mon</pubDate><description>&lt;p&gt;Hello &lt;b&gt;there&lt;/b&gt;&lt;/p&gt;</description></item></channel></rss>';
  assert.deepEqual(parseFeed(rss)[0], { title: 'First & best', link: 'https://a.example/1', id: 'g1', published: 'Mon', author: '', summary: 'Hello there' });
  const atom = '<feed><entry><title>v2</title><link rel="alternate" href="https://g.example/r/2"/><id>tag:2</id><updated>2026</updated><content type="html">notes</content></entry></feed>';
  assert.deepEqual(parseFeed(atom)[0], { title: 'v2', link: 'https://g.example/r/2', id: 'tag:2', published: '2026', author: '', summary: 'notes' });
  const cat = catalog();
  assert.ok(!JSON.stringify(cat).includes('=>'), 'no code goes to the browser');
  for (const s of cat.services) {
    assert.ok(s.actions.length, s.id);
    if (s.auth) assert.ok(CREDENTIAL_TYPES[s.auth], `${s.id} names a credential type that exists`);
  }
  assert.ok(Object.keys(SERVICES).length >= 14);
});

test('flows: data, new nodes, credentials, sub-flows, pins, history, polled starts and test steps', async (t) => {
  const dir = await tmpDir('flows2');
  const work = path.join(dir, 'work');
  await fs.mkdir(work);
  const calls = [];
  let feed = '<rss><item><title>old</title><guid>1</guid></item></rss>';
  const fetch = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, method: options.method ?? 'GET', headers: options.headers ?? {}, body: options.body ?? null });
    if (u.startsWith('https://api.telegram.org/bot')) return u.includes('123:good') ? json({ ok: true, result: { message_id: 7, chat: { id: 42 }, username: 'kbot' } }) : json({ ok: false, description: 'Unauthorized' }, 401);
    if (u.startsWith('https://feed.example')) return new Response(feed, { headers: { 'content-type': 'application/rss+xml' } });
    if (u.startsWith('https://api.example.com/items')) return json({ items: [{ id: 1, name: 'pen', price: 3 }, { id: 2, name: 'ink', price: 12 }] });
    if (u.startsWith('https://api.example.com/fail')) return json({ message: 'nope' }, 503);
    if (u.startsWith('https://spec.example')) return json({ openapi: '3.0.0', info: { title: 'Pets' }, servers: [{ url: 'https://pets.example/v1' }], paths: { '/pets/{id}': { get: { summary: 'One pet', parameters: [{ name: 'id', in: 'path', required: true }, { name: 'fields', in: 'query' }] } }, '/pets': { post: { operationId: 'addPet', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } } } }, components: { schemas: { Pet: { type: 'object', properties: { name: { type: 'string', example: 'Rex' }, age: { type: 'integer' } } } } } });
    return new Response('ok');
  };
  const completion = async (_route, req) => {
    const system = req.messages[0].content;
    const user = req.messages.at(-1).content;
    if (system.includes('one step of an automation')) return reply(system.includes('JSON') ? `Sure: {"mood": "happy", "words": ${user.length}}` : `SUMMARY OF: ${user}`);
    return reply('{}');
  };
  let clock = Date.UTC(2026, 9, 15, 9, 0);
  const engine = await createEngine({ workspaceDir: work, agentsFile: path.join(dir, 'agents.json'), flowsFile: path.join(dir, 'flows.json'), triggersFile: path.join(dir, 'triggers.json'), credentialsFile: path.join(dir, 'credentials.json'), providers: FAKE_PROVIDER, completion, fetch, now: () => clock, mcp: false, limits: { execMode: 'off' } });
  t.after(() => engine.close());
  engine.orchestrator.mcp = new Toolbox([{ tools: () => [{ name: 'shop__stock', description: 'stock', params: ['item'] }], call: async (_n, args) => JSON.stringify({ item: args.item, left: 5 }) }]);
  const { flows, credentials, triggers } = engine;
  const finished = async (id) => {
    for (let i = 0; i < 1500 && flows.list().find((f) => f.id === id).running; i++) await new Promise((r) => setTimeout(r, 10));
    return flows.list().find((f) => f.id === id);
  };

  // ---- credentials: secrets encrypted on disk, never listed, checked against the service
  await assert.rejects(credentials.add({ type: 'telegram', token: 'not a token' }), /does not look like/);
  const bot = await credentials.add({ type: 'telegram', name: 'My bot', token: '123:good_token_aaaaaaaaaaaaaaaa' });
  const bad = await credentials.add({ type: 'telegram', token: '999:bad_token_bbbbbbbbbbbbbbbbbb' });
  const api = await credentials.add({ type: 'header', name: 'Shop', value: 'sekret-value-1234' });
  assert.ok(!(await fs.readFile(path.join(dir, 'credentials.json'), 'utf8')).includes('good_token'), 'encrypted at rest');
  assert.ok(!JSON.stringify(credentials.list()).includes('good_token'));
  assert.equal(credentials.list().find((c) => c.id === api.id).shown.name, 'Shop', 'the non-secret part is shown');
  assert.deepEqual(await credentials.test(bot.id), { ok: true, note: '@kbot' });
  const refused = await credentials.test(bad.id);
  assert.equal(refused.ok, false);
  assert.ok(!refused.note.includes('bad_token'));

  // ---- validation of the new kinds
  await assert.rejects(flows.save({ name: 'xx', nodes: [start, node('a', 'set', { fields: [{ key: 'a', value: '{{ inptu }}' }] })] }), /not something a flow can read/);
  await assert.rejects(flows.save({ name: 'xx', nodes: [start, node('a', 'service', { service: 'telegram', action: 'send', credential: bot.id, params: { chat: '{{ trigger.chat }}', text: 'x' } }), node('b', 'service', { service: 'ntfy', action: 'send', params: { topic: '{{ input }}', message: 'x' } })] }), /is fixed/);
  await assert.rejects(flows.save({ name: 'xx', nodes: [start, node('a', 'service', { service: 'telegram', action: 'send', credential: api.id, params: { chat: '1', text: 'x' } })] }), /for something else/);
  await assert.rejects(flows.save({ name: 'xx', nodes: [start, node('a', 'command', { command: 'echo {{ input }}' })] }), /never put into it/);
  await assert.rejects(flows.save({ name: 'xx', nodes: [start, node('a', 'file', { op: 'write', path: '../outside.txt' })] }), /outside|escape|workspace/i);
  await assert.rejects(flows.save({ name: 'xx', nodes: [start, node('a', 'http', { method: 'GET', url: 'https://a.example', headers: [{ key: 'X-Who', value: '{{ input }}' }] })] }), /headers are fixed/);
  await assert.rejects(flows.save({ name: 'xx', nodes: [start, node('a', 'set', { fields: [{ key: 'a', value: '1' }] }, { name: 'Same' }), node('b', 'set', { fields: [{ key: 'a', value: '1' }] }, { name: 'same' })] }), /names must differ/);

  // ---- one flow through most of the new nodes:
  //   start -> http (credential, query) -> code -> switch -> (1) set -> merge <- (else) ai(json)
  //                                                         merge -> filter -> service(telegram) -> file(append) -> wait
  const big = await flows.save({
    name: 'Shop watch',
    tags: ['Shop', 'daily', 'bad tag!'],
    nodes: [
      start,
      node('h', 'http', { method: 'GET', url: 'https://api.example.com/items', query: [{ key: 'q', value: '{{ now }}' }], credential: api.id }, { name: 'Fetch items' }),
      node('c', 'code', { code: "console.log('n', input.items.length); return { cheap: input.items.filter((i) => i.price < 10), total: input.items.length };" }),
      node('s', 'switch', { rules: [{ left: '{{ input.total }}', op: 'gt', value: '1' }] }),
      node('set1', 'set', { fields: [{ key: 'summary.first', value: '{{ input.cheap[0].name }}' }, { key: 'count', value: "{{ node('Fetch items').items }}" }], keep: false }, { name: 'Shape' }),
      node('ai1', 'ai', { prompt: 'How do you feel about {{ input }}', json: true }),
      node('m', 'merge', { mode: 'combine' }),
      node('f', 'filter', { conditions: [{ left: '{{ input.summary.first }}', op: 'equals', value: 'PEN' }] }),
      node('tg', 'service', { service: 'telegram', action: 'send', credential: bot.id, params: { chat: '42', text: 'Cheapest: {{ input.summary.first }} of {{ input.count }}' } }),
      node('w', 'file', { op: 'append', path: 'log/shop.txt', content: 'sent {{ input.message_id }}' }),
      node('z', 'wait', { seconds: 1 }),
      node('n1', 'note', { text: 'A note never runs' }),
    ],
    edges: [wire('t', 'h'), wire('h', 'c'), wire('c', 's'), wire('s', 'set1', '1'), wire('s', 'ai1', 'else'), wire('set1', 'm'), wire('ai1', 'm'), wire('m', 'f'), wire('f', 'tg'), wire('tg', 'w'), wire('w', 'z'), wire('n1', 'h')],
  });
  assert.deepEqual(big.tags, ['shop', 'daily']);
  assert.equal(big.edges.length, 11, 'a wire to a note is dropped');
  flows.runNow(big.id);
  let after = await finished(big.id);
  const r = after.lastRun;
  assert.equal(r.ok, true, JSON.stringify(r.nodes));
  const shopCall = calls.find((c) => c.url.startsWith('https://api.example.com/items'));
  assert.equal(shopCall.headers['x-shop'], undefined);
  assert.equal(shopCall.headers.shop, 'sekret-value-1234', 'a header credential is put on the request');
  assert.match(shopCall.url, /\?q=2026-10-15T09%3A00/);
  assert.deepEqual(r.nodes.c.output, { cheap: [{ id: 1, name: 'pen', price: 3 }], total: 2 });
  assert.deepEqual(r.nodes.c.logs, ['n 2']);
  assert.equal(r.nodes.s.port, '1');
  assert.deepEqual(r.nodes.set1.output, { summary: { first: 'pen' }, count: [{ id: 1, name: 'pen', price: 3 }, { id: 2, name: 'ink', price: 12 }] });
  assert.ok(!('ai1' in r.nodes), 'the else branch did not run');
  assert.equal(r.nodes.tg.status, 'ok');
  const sent = JSON.parse(calls.find((c) => c.url.includes('/sendMessage')).body);
  assert.equal(sent.text, 'Cheapest: pen of [{"id":1,"name":"pen","price":3},{"id":2,"name":"ink","price":12}]');
  assert.equal(await fs.readFile(path.join(work, 'log/shop.txt'), 'utf8'), 'sent 7');
  assert.equal(r.nodes.m.items, 1);
  assert.ok(!('n1' in r.nodes));

  // ---- the history keeps each run; a failing node can carry on; retries; switched-off nodes pass through
  const second = await flows.save({
    name: 'Careful',
    nodes: [
      start,
      node('bad', 'http', { method: 'GET', url: 'https://api.example.com/fail' }, { onError: 'continue', retries: 1 }),
      node('off', 'set', { fields: [{ key: 'x', value: '1' }] }, { disabled: true }),
      node('ai2', 'ai', { prompt: 'Tell me about {{ input.error }}' }),
    ],
    edges: [wire('t', 'bad'), wire('bad', 'off'), wire('off', 'ai2')],
  });
  flows.runNow(second.id);
  after = await finished(second.id);
  assert.equal(after.lastRun.ok, true);
  assert.equal(after.lastRun.nodes.bad.status, 'failed');
  assert.match(after.lastRun.nodes.bad.output, /answered 503: nope/);
  assert.equal(calls.filter((c) => c.url.includes('/fail')).length, 2, 'tried twice');
  assert.equal(after.lastRun.nodes.off.note, 'switched off: passed on unchanged');
  assert.match(after.lastRun.nodes.ai2.output, /^SUMMARY OF: Tell me about api\.example\.com answered 503/);
  assert.equal(flows.runs(second.id).length, 1);

  // ---- sub-flows: one flow runs another; a circle of flows is refused; a flow in use cannot be deleted
  const child = await flows.save({ name: 'Child', nodes: [start, node('up', 'code', { code: 'return JSON.stringify(input).toUpperCase();' })], edges: [wire('t', 'up')] });
  const parent = await flows.save({ name: 'Parent', nodes: [start, node('d', 'set', { fields: [{ key: 'v', value: 'hello' }] }), node('call', 'flow', { flow: child.id })], edges: [wire('t', 'd'), wire('d', 'call')], onFail: second.id });
  await assert.rejects(flows.save({ name: 'Child', nodes: [start, node('back', 'flow', { flow: parent.id })], edges: [wire('t', 'back')] }, child.id), /run itself again/);
  await assert.rejects(flows.remove(child.id), /uses this flow/);
  flows.runNow(parent.id);
  after = await finished(parent.id);
  assert.equal(after.lastRun.nodes.call.output, '{"V":"HELLO"}');
  assert.equal(flows.runs(child.id)[0].source, 'flow', 'the child keeps a record of being run');

  // ---- pinned data stands in for a node when run by hand; "if it fails" runs the error flow
  const pinned = await flows.save({
    name: 'Pinned',
    nodes: [start, node('p', 'http', { method: 'GET', url: 'https://api.example.com/fail' }, { pinned: { items: [{ name: 'from pin' }] } }), node('q', 'set', { fields: [{ key: 'got', value: '{{ input.items[0].name }}' }] })],
    edges: [wire('t', 'p'), wire('p', 'q')],
    onFail: child.id,
  });
  flows.runNow(pinned.id);
  after = await finished(pinned.id);
  assert.deepEqual([after.lastRun.ok, after.lastRun.nodes.p.note, after.lastRun.nodes.q.output], [true, 'pinned data', { got: 'from pin' }]);
  const childRuns = flows.runs(child.id).length;
  flows.runNow(pinned.id, { pins: false });
  after = await finished(pinned.id);
  assert.equal(after.lastRun.ok, false, 'without pins the real request is made, and fails');
  // The error flow starts once the failed run is saved: wait for it to start, then to finish.
  for (let i = 0; i < 1500 && flows.runs(child.id).length === childRuns && !flows.list().find((f) => f.id === child.id).running; i++) await new Promise((r) => setTimeout(r, 10));
  await finished(child.id);
  assert.equal(flows.runs(child.id).length, childRuns + 1);
  assert.equal(flows.runs(child.id)[0].source, 'error');
  assert.match(flows.runs(child.id)[0].nodes.up.output, /"FLOW":"PINNED"/);

  // ---- a polled start: the first look only notes what is there; new items start the flow once each
  const watcher = await flows.save({ name: 'Feed', nodes: [node('t', 'trigger', { kind: 'poll', poller: 'rss', url: 'https://feed.example/rss', every: 5 }), node('s', 'set', { fields: [{ key: 'title', value: '{{ input.title }}' }] })], edges: [wire('t', 's')] });
  await flows.tick();
  assert.equal(flows.runs(watcher.id).length, 0, 'what was already there is not new');
  feed = '<rss><item><title>newer</title><guid>2</guid></item><item><title>old</title><guid>1</guid></item></rss>';
  await flows.tick();
  assert.equal(flows.runs(watcher.id).length, 0, 'not before its interval');
  clock += 5 * 60000;
  await flows.tick();
  after = await finished(watcher.id);
  assert.deepEqual([after.lastRun.source, after.lastRun.nodes.s.output], ['poll', { title: 'newer' }]);
  clock += 5 * 60000;
  await flows.tick();
  await finished(watcher.id);
  assert.equal(flows.runs(watcher.id).length, 1, 'each item once');

  // ---- a webhook bound to a flow delivers its whole JSON
  const hook = await triggers.add({ type: 'webhook', name: 'orders' });
  const onHook = await flows.save({ name: 'Orders', nodes: [node('t', 'trigger', { kind: 'trigger', id: hook.id }), node('s', 'set', { fields: [{ key: 'who', value: '{{ input.customer.name }}' }, { key: 'total', value: '{{ trigger.total }}' }] })], edges: [wire('t', 's')] });
  await triggers.fire(hook.id, hook.token, { customer: { name: 'Asha' }, total: 30 });
  after = await finished(onHook.id);
  assert.deepEqual(after.lastRun.nodes.s.output, { who: 'Asha', total: 30 });

  // ---- test one node of an unsaved drawing, with the data given; sample a polled start
  const draft = { name: '', nodes: [start, node('x', 'set', { fields: [{ key: 'name', value: '{{ input.a }}-{{ node("Prev").b }}' }] }), node('y', 'service', { service: 'currency', action: 'convert', params: { amount: '1', from: 'USD', to: 'USD' } })], edges: [] };
  const { ms, ...tested } = await flows.testNode(draft, 'x', { input: { a: 'one' }, nodes: { Prev: { b: 'two' } } });
  assert.deepEqual(tested, { ok: true, output: { name: 'one-two' }, port: undefined, stopped: false, logs: [] });
  assert.equal(typeof ms, 'number');
  assert.deepEqual((await flows.testNode(draft, 'y')).output, { amount: 1, from: 'USD', to: 'USD', rate: 1, result: 1 });
  const sample = await flows.testNode({ name: 'd', nodes: [node('t', 'trigger', { kind: 'poll', poller: 'rss', url: 'https://feed.example/rss' })], edges: [] }, 't');
  assert.equal(sample.output.title, 'newer');

  // ---- an OpenAPI description becomes a list of requests
  const spec = await readOpenApi({ url: 'https://spec.example/openapi.json' }, fetch);
  assert.equal(spec.base, 'https://pets.example/v1');
  assert.deepEqual(spec.operations.map((o) => `${o.method} ${o.path}`), ['GET /pets/{id}', 'POST /pets']);
  assert.deepEqual(spec.operations[0].params, [{ name: 'id', in: 'path', required: true }, { name: 'fields', in: 'query', required: false }]);
  assert.deepEqual(spec.operations[1].body, { name: 'Rex', age: 0 });
  await assert.rejects(readOpenApi({ textBody: 'openapi: 3.0.0' }, fetch), /YAML is not supported/);

  // ---- a stopped flow stops; the history survives a restart
  const slow = await flows.save({ name: 'Slow', nodes: [start, node('w', 'wait', { seconds: 30 }), node('s', 'set', { fields: [{ key: 'a', value: '1' }] })], edges: [wire('t', 'w'), wire('w', 's')] });
  flows.runNow(slow.id);
  await new Promise((r) => setTimeout(r, 50));
  flows.stop(slow.id);
  after = await finished(slow.id);
  assert.deepEqual([after.lastRun.ok, after.lastRun.stopped, 's' in after.lastRun.nodes], [false, true, false]);
  await engine.close();
  const again = await createEngine({ workspaceDir: work, agentsFile: path.join(dir, 'agents.json'), flowsFile: path.join(dir, 'flows.json'), triggersFile: path.join(dir, 'triggers.json'), credentialsFile: path.join(dir, 'credentials.json'), providers: FAKE_PROVIDER, completion, fetch, now: () => clock, mcp: false, limits: { execMode: 'off' } });
  t.after(() => again.close());
  assert.equal(again.flows.runs(big.id).length, 1);
  assert.equal(again.flows.list().find((f) => f.id === big.id).nodes.find((n) => n.id === 'h').name, 'Fetch items');
});

test('describe a flow: the Chef draws it, code takes out what only the user may choose, one retry at most', async (t) => {
  const dir = await tmpDir('flowdraft');
  const work = path.join(dir, 'work');
  await fs.mkdir(work);
  const answers = [];
  const prompts = [];
  const completion = async (_route, req) => {
    prompts.push(req.messages.at(-1).content);
    return reply(answers.shift() ?? '{}');
  };
  const engine = await createEngine({ workspaceDir: work, agentsFile: path.join(dir, 'agents.json'), flowsFile: path.join(dir, 'flows.json'), triggersFile: path.join(dir, 'triggers.json'), credentialsFile: path.join(dir, 'credentials.json'), providers: FAKE_PROVIDER, completion, mcp: false, limits: { execMode: 'off' } });
  t.after(() => engine.close());
  const { flows } = engine;

  // First answer: wires in a circle. Second: usable, but it tries things that are the user's to choose.
  answers.push(JSON.stringify({ name: 'Loop', nodes: [{ id: 't', type: 'trigger', config: { kind: 'manual' } }, { id: 'a', type: 'wait', config: { seconds: 1 } }, { id: 'b', type: 'wait', config: { seconds: 1 } }], edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'a' }] }));
  answers.push(`Here it is: ${JSON.stringify({
    name: 'Rain "alert"',
    nodes: [
      { id: 'T', type: 'trigger', config: { kind: 'schedule', schedule: { kind: 'daily', time: '7:30', days: [] } } },
      { id: 'wx', type: 'service', name: 'Weather', config: { service: 'weather', action: 'forecast', params: { place: 'Chennai' } } },
      { id: 'js', type: 'code', name: 'Round it', config: { code: 'return require("fs")' } },
      { id: 'tg', type: 'service', name: 'Tell me', config: { service: 'telegram', action: 'send', credential: 'abc123', params: { chat: '{{ input.chat }}', text: '{{ input }}' } } },
      { id: 'h', type: 'http', name: 'Ping', config: { method: 'POST', url: 'https://{{ input.host }}/x' } },
      { id: 'push', type: 'service', name: 'Ping', config: { service: 'ntfy', action: 'send', params: { topic: '{{ input }}', message: '{{ input }}' } } },
    ],
    edges: [{ from: 'T', to: 'wx' }, { from: 'wx', to: 'js' }, { from: 'wx', to: 'tg' }, { from: 'tg', to: 'h' }, { from: 'h', to: 'push' }],
    notes: ['Add your chat id.'],
  })}`);
  const out = await flows.draft('every morning at 7:30 tell me on telegram if it will rain');
  assert.equal(prompts.length, 2, 'one retry');
  assert.match(prompts[1], /could not be used[\s\S]*loop/i, 'the retry says what was wrong');
  const byId = Object.fromEntries(out.flow.nodes.map((n) => [n.id, n]));
  assert.equal(out.flow.name, 'Rain alert');
  assert.equal(byId.t.config.schedule.time, '07:30');
  assert.ok(!out.flow.nodes.some((n) => n.type === 'code'), 'a model never writes a code node');
  assert.equal(byId.js.type, 'note');
  assert.equal(byId.tg.config.credential, '', 'credentials are never chosen for the user');
  assert.equal(byId.push.config.params.topic, '', 'a fixed field takes no {{ }}');
  assert.equal(byId.push.name, 'Ping 2', 'names stay different');
  assert.match(byId.push.check, /fill in/);
  assert.equal(byId.h.config.url, 'https://example.com/replace-me');
  assert.match(byId.tg.check, /credential/);
  assert.match(byId.h.check, /fill in the address/);
  assert.ok(out.notes.some((n) => /Code node/.test(n)) && out.notes.includes('Add your chat id.'));
  assert.ok(byId.wx.x > byId.t.x && byId.tg.x > byId.wx.x, 'laid out along the wires');
  assert.equal(flows.list().length, 0, 'nothing is saved');

  // Two answers that do not hold together: refused, and no third call.
  answers.push('no idea', '{"nodes": "x"}');
  await assert.rejects(flows.draft('something vague that cannot be drawn'), /could not draw/);
  assert.equal(prompts.length, 4);
  await assert.rejects(flows.draft('hi'), /sentence or two/);

  // Quoting a node that does not run before it is sent back once, with the reason; then marked.
  const sideBySide = JSON.stringify({ name: 'Releases', nodes: [{ id: 't', type: 'trigger', config: { kind: 'poll', poller: 'github', repo: 'nodejs/node', event: 'release' } }, { id: 'a', type: 'ai', name: 'Sum', config: { prompt: 'Sum up {{ input }}' } }, { id: 's', type: 'set', name: 'Line', config: { fields: [{ key: 'line', value: "{{ input.tag }}: {{ node('Sum') }}" }] } }], edges: [{ from: 't', to: 'a' }, { from: 't', to: 's' }] });
  answers.push(sideBySide, sideBySide);
  const marked = await flows.draft('when node has a new release, summarise it into a line');
  assert.match(prompts.at(-1), /does not run before it/);
  assert.equal(marked.flow.nodes[0].config.event, 'releases', 'a GitHub start never quietly watches issues instead');
  assert.match(marked.flow.nodes.find((n) => n.id === 's').check, /does not run before it/);
  for (const [id, s] of Object.entries(SERVICES)) for (const action of Object.keys(s.actions)) assert.ok(GIVES[`${id}/${action}`], `the Chef is told what ${id}/${action} hands on`);
});

test('try once: reading and thinking run for real, sending, writing, running and waiting are held back', async (t) => {
  const dir = await tmpDir('flowtry');
  const work = path.join(dir, 'work');
  await fs.mkdir(work);
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push(`${options.method ?? 'GET'} ${url}`);
    if (String(url).includes('frankfurter')) return json({ rates: { INR: 84.5 }, date: '2026-10-19' });
    if (String(url).startsWith('https://api.example.com/items')) return json({ items: [1, 2] });
    return json({ ok: true });
  };
  const completion = async () => reply('A short note.');
  const engine = await createEngine({ workspaceDir: work, agentsFile: path.join(dir, 'agents.json'), flowsFile: path.join(dir, 'flows.json'), triggersFile: path.join(dir, 'triggers.json'), credentialsFile: path.join(dir, 'credentials.json'), providers: FAKE_PROVIDER, completion, fetch, mcp: false, limits: { execMode: 'off' } });
  t.after(() => engine.close());
  const ran = [];
  engine.runner.run = async (command) => (ran.push(command), { code: 0, output: '' });
  const { flows } = engine;
  const drawing = {
    name: '',
    nodes: [
      start,
      node('c', 'service', { service: 'currency', action: 'convert', params: { amount: '1', from: 'USD', to: 'INR' } }, { name: 'Rate' }),
      node('g', 'http', { method: 'GET', url: 'https://api.example.com/items' }, { name: 'Items' }),
      node('a', 'ai', { prompt: 'Note on {{ input }}' }, { name: 'Note' }),
      node('w', 'wait', { seconds: 600 }),
      node('tg', 'service', { service: 'telegram', action: 'send', params: { chat: '42', text: 'Rate {{ node(\'Rate\').rate }}: {{ input }}' } }, { name: 'Send' }),
      node('p', 'http', { method: 'POST', url: 'https://hooks.example.com/x', body: '{"text": "{{ input.text }}"}' }, { name: 'Post' }),
      node('f', 'file', { op: 'append', path: 'log.txt', content: '{{ input }}' }, { name: 'Log' }),
      node('x', 'command', { command: 'npm test' }, { name: 'Test' }),
      node('ag', 'agent', { text: 'Fix {{ input }}' }, { name: 'Crew' }),
    ],
    edges: [wire('t', 'c'), wire('c', 'g'), wire('g', 'a'), wire('a', 'w'), wire('w', 'tg'), wire('tg', 'p'), wire('p', 'f'), wire('f', 'x'), wire('x', 'ag')],
  };
  const started = Date.now();
  const record = await flows.tryOnce(drawing);
  assert.ok(Date.now() - started < 5000, 'a wait is not waited');
  assert.equal(record.ok, true, record.result);
  assert.equal(record.source, 'try');
  assert.deepEqual(calls, ['GET https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR', 'GET https://api.example.com/items'], 'only reads went out');
  assert.equal(record.nodes.a.output, 'A short note.', 'the AI step ran');
  assert.ok(record.nodes.tg.held && record.nodes.p.held && record.nodes.f.held && record.nodes.x.held && record.nodes.ag.held && record.nodes.w.held);
  assert.equal(record.nodes.tg.output.text, 'Rate 84.5: A short note.', 'held back, with the data filled in');
  assert.equal(record.nodes.tg.output.chat, '42');
  assert.equal(record.nodes.p.output.would, 'POST https://hooks.example.com/x');
  assert.deepEqual(ran, [], 'no command ran');
  await assert.rejects(fs.access(path.join(work, 'log.txt')), 'no file was written');
  assert.equal(flows.list().length, 0, 'nothing saved');
  assert.equal(engine.orchestrator.busy, false, 'the crew was not given the task');
});

test('change or fix a flow in words: what the user set is kept by code, new nodes are placed and marked', async (t) => {
  const dir = await tmpDir('flowchange');
  const work = path.join(dir, 'work');
  await fs.mkdir(work);
  const prompts = [];
  const answers = [];
  const completion = async (_route, req) => {
    prompts.push(req.messages.at(-1).content);
    return reply(answers.shift() ?? '{}');
  };
  const engine = await createEngine({ workspaceDir: work, agentsFile: path.join(dir, 'agents.json'), flowsFile: path.join(dir, 'flows.json'), triggersFile: path.join(dir, 'triggers.json'), credentialsFile: path.join(dir, 'credentials.json'), providers: FAKE_PROVIDER, completion, fetch: async () => json({ ok: true, result: { username: 'b' } }), mcp: false, limits: { execMode: 'off' } });
  t.after(() => engine.close());
  const { flows, credentials } = engine;
  const bot = await credentials.add({ type: 'telegram', name: 'Bot', token: '123:good_token_aaaaaaaaaaaaaaaa' });
  const base = {
    name: 'Morning', description: 'mine', tags: ['daily'], onFail: '',
    nodes: [
      { id: 't', type: 'trigger', x: 40, y: 80, config: { kind: 'schedule', schedule: { kind: 'daily', time: '08:00', days: [] } } },
      { id: 'wx', type: 'service', name: 'Weather', x: 300, y: 80, pinned: { now: 1 }, config: { service: 'weather', action: 'forecast', params: { place: 'Chennai' } } },
      { id: 'js', type: 'code', name: 'Shape', x: 560, y: 80, config: { code: 'return input.now;' } },
      { id: 'tg', type: 'service', name: 'Send', x: 820, y: 80, retries: 2, config: { service: 'telegram', action: 'send', credential: bot.id, params: { chat: '42', text: '{{ input }}' } } },
    ],
    edges: [wire('t', 'wx'), wire('wx', 'js'), wire('js', 'tg')],
  };
  // The model changes the time, keeps the code node (trying to rewrite it), and adds a file log after Send.
  answers.push(JSON.stringify({
    name: 'Something else',
    nodes: [
      { id: 't', type: 'trigger', config: { kind: 'schedule', schedule: { kind: 'daily', time: '09:00', days: [] } } },
      { id: 'wx', type: 'service', name: 'Weather', config: { service: 'weather', action: 'forecast', params: { place: 'Chennai' } } },
      { id: 'js', type: 'code', name: 'Shape', config: { code: 'require("child_process")' } },
      { id: 'tg', type: 'service', name: 'Send', config: { service: 'telegram', action: 'send', params: { chat: '42', text: '{{ input }}' } } },
      { id: 'log', type: 'file', name: 'Log', config: { op: 'append', path: 'notes/sent.md', content: '{{ input }}' } },
    ],
    edges: [wire('t', 'wx'), wire('wx', 'js'), wire('js', 'tg'), wire('tg', 'log')],
  }));
  const out = await flows.draft('make it 9am and keep a log of what was sent', { base });
  assert.match(prompts[0], /The flow as it is now[\s\S]*"wx"/, 'the Chef is shown the flow');
  assert.ok(!prompts[0].includes(bot.id) && !prompts[0].includes('return input.now'), 'no credential id and no code reach the model');
  const byId = Object.fromEntries(out.flow.nodes.map((n) => [n.id, n]));
  assert.equal(out.flow.name, 'Morning', 'the name stays');
  assert.deepEqual(out.flow.tags, ['daily']);
  assert.equal(byId.t.config.schedule.time, '09:00');
  assert.equal(byId.js.config.code, 'return input.now;', 'the user\'s code is kept, whatever the model wrote');
  assert.equal(byId.tg.config.credential, bot.id, 'the credential stays on the node');
  assert.equal(byId.tg.retries, 2);
  assert.deepEqual([byId.wx.x, byId.wx.y], [300, 80], 'existing nodes stay where they were');
  assert.deepEqual(byId.wx.pinned, { now: 1 });
  assert.deepEqual([byId.log.x, byId.log.y], [1070, 80], 'a new node goes beside what feeds it');
  assert.match(byId.log.check, /added by the Chef/);
  assert.match(byId.t.check, /changed by the Chef/);
  assert.equal(byId.wx.check, undefined, 'untouched nodes are not marked');
  assert.match(out.changes, /added Log; changed/);

  // Fix it: the failure goes to the Chef with the flow.
  answers.push(JSON.stringify({ nodes: base.nodes.map(({ x, y, ...n }) => n), edges: base.edges }));
  const fixed = await flows.draft('Fix it', { base, failure: { node: 'Send', error: 'Telegram refused the credential (401)', input: 'hello' } });
  assert.match(prompts[1], /What went wrong[\s\S]*Send[\s\S]*401/);
  assert.equal(fixed.changes, 'The Chef left the flow as it was.');
});
