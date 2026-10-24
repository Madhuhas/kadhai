import { $, h, fmtNum, toast } from './util.js';
import { state, on, emit } from './store.js';
import { api } from './api.js';
import { defaultHue, face, spinner, tintOf } from './ascii.js';
import { figure, kadhai, stations } from './kitchen.js';

const LABEL = { working: 'Working', standby: 'Standby', 'limit-reached': 'Limit reached', paused: 'Paused', off: 'Switched off' };
const STEP_MARK = { pending: '[ ]', working: '[~]', done: '[x]', failed: '[!]', skipped: '[-]' };
const THOUGHT_DOM_CAP = 40000;

let selected = null; // the agent whose tab is in front, if any
let editing = null; // id of the agent in the edit form, or null when hiring
let pickedHue = null; // the colour chosen in the form, or null for the agent's usual one
const MAX_SKILLS = 5; // the server enforces the same limit; low flame uses the first 3
const LOW_SKILLS = 3;
let connections = []; // what is connected right now, asked for each time the form opens
let thoughtChars = 0;
let floor = null; // the kitchen's parts, while the Kitchen tab is showing

/** A switched-off or paused agent that is not mid-call is shown as such. */
const shownState = (agent) => (agent.off && agent.state !== 'working' ? 'off' : agent.paused && agent.state !== 'working' ? 'paused' : agent.state);

/** Switch an agent off (given no work) or on again. The Chef always stays on; the server also keeps one cook on. */
async function setDuty(agent, off) {
  try {
    await api.configure(agent.id, { off });
    toast(off ? `${agent.name} is switched off${agent.role === 'reviewer' ? ' - runs skip the review' : ' - its work goes to another cook'}` : `${agent.name} is back on`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

/** Two or three words for a speech bubble: what this agent is up to right now. */
function mood(agent, st) {
  if (st === 'standby') return '';
  if (st === 'paused') return 'paused';
  if (st === 'off') return 'off';
  if (st === 'limit-reached') return 'out of quota';
  const task = agent.task || '';
  if (agent.role === 'manager') return 'planning';
  if (task.startsWith('Verifying')) return 'running tests';
  if (agent.role === 'reviewer') return 'reviewing';
  if (task.startsWith('Command:')) return 'running it';
  return 'cooking';
}


// ================================================================= crew bar

function card(agent) {
  const st = shownState(agent);
  const says = mood(agent, st);
  return h(
    'button',
    { class: 'agent-card tinted', style: tintOf(agent.id), dataset: { state: st }, title: `${agent.name} · ${says || LABEL[st]}\n${agent.task || agent.blurb}\nClick to open in a tab`, onclick: () => openAgent(agent.id) },
    h('span', { class: 'face' }, face(agent.id)),
    h('span', { class: 'agent-name' }, agent.name),
    st === 'working' && spinner(),
  );
}

/** A line of the crew list: who, what they are doing, and a switch (not for the Chef, who plans every run). */
function row(agent) {
  const st = shownState(agent);
  const open = h(
    'button',
    {
      class: 'crew-row tinted',
      style: tintOf(agent.id),
      type: 'button',
      dataset: { state: st },
      title: `${agent.task || agent.blurb}\nClick to open in a tab`,
      onclick: () => {
        $('#crew-menu').open = false;
        openAgent(agent.id);
      },
    },
    h('span', { class: 'face' }, face(agent.id)),
    h('span', { class: 'agent-name' }, agent.name),
    h('span', { class: 'crew-state' }, mood(agent, st) || (agent.custom ? 'specialist' : 'standby')),
    st === 'working' && spinner(),
  );
  const duty = agent.role === 'manager'
    ? h('span', { class: 'crew-duty fixed', title: 'The Chef plans every run and is always on' }, 'on')
    : h('button', { class: 'crew-duty', type: 'button', ariaPressed: String(!agent.off), ariaLabel: `${agent.name}: ${agent.off ? 'switched off - switch on' : 'on - switch off'}`, title: agent.off ? 'Switched off: given no work. Click to switch on' : 'On. Click to switch off for now', onclick: () => setDuty(agent, !agent.off) }, agent.off ? 'off' : 'on');
  return h('div', { class: 'crew-line', dataset: { off: agent.off ? 'true' : 'false' } }, open, duty);
}

function renderCrew() {
  const agents = Object.values(state.agents);
  const working = agents.filter((agent) => shownState(agent) === 'working').length;
  const on = agents.filter((agent) => !agent.off).length;
  const count = on === agents.length ? String(agents.length) : `${on}/${agents.length}`;
  $('#crew-count').textContent = working ? `${count} · ${working} working` : count;
  $('#crew-count').title = on === agents.length ? 'Everyone is on' : `${agents.length - on} switched off`;
  $('#crew-count').classList.toggle('on', working > 0);
  $('#crew-list').replaceChildren(
    ...agents.map(row),
    h(
      'button',
      {
        class: 'crew-row hire',
        type: 'button',
        title: 'Hire: add your own specialist agent',
        onclick: () => {
          $('#crew-menu').open = false;
          openForm(null);
        },
      },
      '+ hire a specialist',
    ),
  );
  // Beside the list, a button for each agent that is not simply standing by.
  $('#crew').replaceChildren(...agents.filter((agent) => !['standby', 'off'].includes(shownState(agent))).map(card));
  renderFloor();
}

// ============================================================ kitchen floor

/** Build the kitchen once; after that only its parts change, so the animation never restarts. */
function mountFloor(container) {
  const title = h('div', { class: 'floor-title' });
  const sub = h('div', { class: 'floor-sub' });
  const ticket = h('div', { class: 'ticket' });
  // The run's title and ticket above, the kadhai in the middle, the whole crew below it at their
  // stations (kitchen.js): a row that wraps, so any number of agents fits.
  const pot = kadhai();
  const crew = stations({ onOpen: (id) => openAgent(id) });
  const hire = h('button', { class: 'btn sm hire-btn', type: 'button', title: 'Add your own specialist agent', onclick: () => openForm(null) }, '+ hire a specialist');
  container.replaceChildren(title, sub, ticket, h('div', { class: 'hob' }, pot.el), crew.el, hire);
  floor = { container, title, sub, ticket, pot, crew };
  renderFloor();
}

function renderFloor() {
  if (!floor?.container.isConnected) return;
  const run = state.run;
  const plan = run?.plan;
  const cooking = Boolean(run);

  floor.title.textContent = !cooking ? 'Ready when you are' : plan ? plan.objective : 'Reading your order…';
  floor.sub.textContent = !cooking
    ? 'Tell the crew what to cook in the chat on the right.'
    : plan
      ? progress(plan)
      : 'The Chef is planning';

  // The order ticket: each step, who has it, and how it went.
  floor.ticket.hidden = !plan;
  floor.ticket.replaceChildren(
    ...(plan?.subtasks ?? []).map((s, i) =>
      h('span', { class: 'step', dataset: { status: s.status }, title: s.summary || s.files.join(', ') }, `${STEP_MARK[s.status]} ${i + 1}. ${s.title}`, h('span', { class: 'step-cook tinted', style: tintOf(s.cookId ?? s.cook) }, state.agents[s.cookId]?.name ?? s.cook)),
    ),
  );
  floor.pot.cooking(cooking);
  floor.crew.render();
}

/** Where the run is: one step after another, or several cooks at once (high flame). */
function progress(plan) {
  const steps = plan.subtasks;
  const done = steps.filter((s) => s.status === 'done' || s.status === 'failed' || s.status === 'skipped').length;
  const working = steps.filter((s) => s.status === 'working').length;
  if (working > 1) return `${working} cooks at work - ${done} of ${steps.length} done`;
  return `Step ${Math.min(done + 1, steps.length)} of ${steps.length}`;
}


// ================================================================ agent tab

function setThought(text) {
  const pre = $('#insp-thought');
  pre.textContent = text;
  thoughtChars = text.length;
  pre.scrollTop = pre.scrollHeight;
}

/** Open an agent in a tab of its own (files.js owns the tabs and tells us which one is in front). */
function openAgent(id) {
  const agent = state.agents[id];
  if (agent) emit('agenttab', { id, name: agent.name });
}

/** The tab in front changed: fill the shared agent panel with that agent, or stop following anyone. */
function showAgent(id) {
  selected = state.agents[id] ? id : null;
  if (!selected) return;
  renderAgent();
  renderLessons();
  setThought(state.thoughts[selected] ?? '');
}

// ---------------------------------------------------------------- lessons

let lessons = []; // what has been learned in this folder, for every agent

/** Under an agent's numbers: what it will be told from earlier runs, each line removable. */
function renderLessons() {
  const box = $('#insp-lessons');
  const mine = selected ? [...lessons.filter((l) => l.for === selected), ...lessons.filter((l) => l.for === 'all')] : [];
  box.hidden = !mine.length;
  if (!mine.length) return;
  box.replaceChildren(
    h('div', { class: 'section-label' }, h('span', null, 'What it has learned here'), h('span', { class: 'spacer' }), h('span', { class: 'muted' }, 'a few of these go into each of its prompts')),
    h(
      'ul',
      { class: 'lesson-list' },
      ...mine.map((lesson) =>
        h(
          'li',
          null,
          h('span', { class: 'badge' }, lesson.for === 'all' ? 'this folder' : 'its own'),
          h('span', { class: 'lesson-text' }, lesson.text),
          h('button', { class: 'icon-btn', type: 'button', title: 'Forget this', ariaLabel: `Forget: ${lesson.text}`, onclick: () => api.forgetLesson(lesson.id).catch((err) => toast(err.message, 'err')) }, '×'),
        ),
      ),
    ),
  );
}

async function loadLessons() {
  try {
    ({ lessons } = await api.lessons());
  } catch {
    lessons = [];
  }
  renderLessons();
}

const metric = (label, value, hint = '') => h('div', { class: 'metric', title: hint }, h('b', null, String(value)), h('span', null, label));

function renderAgent() {
  if (!selected) return;
  const agent = state.agents[selected];
  if (!agent) {
    selected = null; // it was let go while its tab was open; files.js drops the tab
    return;
  }
  const st = shownState(agent);
  const m = agent.metrics;

  // Only when the agent changes: a fresh figure would restart its animation.
  const avatar = $('#insp-avatar');
  if (avatar.dataset.agent !== agent.id) {
    avatar.dataset.agent = agent.id;
    avatar.replaceChildren(figure(agent.id));
  }
  avatar.dataset.state = st;
  const head = avatar.closest('.agent-head');
  head.classList.add('tinted');
  head.style.cssText = tintOf(agent.id);
  $('#insp-name').textContent = agent.name;
  const badge = $('#insp-state');
  badge.textContent = LABEL[st];
  badge.dataset.state = st;
  $('#insp-task').replaceChildren(
    h('div', { class: 'muted' }, agent.blurb),
    ...(agent.task ? [h('div', { class: 'now' }, `Now: ${agent.task}`)] : []),
    ...(agent.pendingNotes ? [h('div', { class: 'now' }, `${agent.pendingNotes} note(s) waiting for its next step`)] : []),
    ...(agent.skills?.length ? [h('div', { class: 'muted' }, `Skills: ${agent.skills.map((id) => state.skills.find((s) => s.id === id)?.name ?? id).join(', ')}`)] : []),
    ...(agent.model ? [h('div', { class: 'muted' }, `Model: ${modelLabel(agent.model)}`)] : []),
    ...(agent.connections ? [h('div', { class: 'muted' }, `Connections: ${agent.connections.join(', ') || 'none'}`)] : []),
  );
  $('#insp-pause').textContent = agent.paused ? 'Resume' : 'Pause';
  $('#insp-duty').hidden = agent.role === 'manager';
  $('#insp-duty').textContent = agent.off ? 'Switch on' : 'Switch off';
  // Only a hired specialist can be removed; the house crew always stays.
  $('#insp-remove').hidden = !agent.custom;

  $('#insp-metrics').replaceChildren(
    metric('Calls', fmtNum(m.calls)),
    metric('Tokens', fmtNum(m.promptTokens + m.completionTokens), `${m.promptTokens} in, ${m.completionTokens} out`),
    metric('Swaps', fmtNum(m.swaps), 'Provider hot-swaps during calls by this agent'),
    metric('Latency', m.lastLatencyMs ? `${(m.lastLatencyMs / 1000).toFixed(1)}s` : '—'),
    metric('Model', agent.route ? agent.route.model : 'not used yet', agent.route ? agent.route.label : ''),
  );
}

// ========================================================= hire / edit form

/** The models there are keys for, once each: `{ value: "<provider>/<model>", label }`. */
function modelChoices() {
  const seen = new Map();
  for (const route of state.providers.routes) {
    const value = `${route.provider}/${route.model}`;
    if (!seen.has(value)) seen.set(value, `${route.label.replace(/#\d+$/, '')} · ${route.model}`);
  }
  return [...seen].map(([value, label]) => ({ value, label }));
}

/** An agent's model setting, in words. */
function modelLabel(model) {
  if (model === 'best') return 'best available first';
  if (model === 'light') return 'lighter models first';
  return `starts with ${modelChoices().find((c) => c.value === model)?.label ?? `${model} (no key for it right now)`}`;
}

function showHue() {
  const hue = pickedHue ?? (editing ? defaultHue(editing) : null);
  $('#agent-hue').value = hue ?? 0;
  // The whole row wears the colour being picked: the face and the slider.
  $('#agent-hue-row').style.cssText = hue === null ? '' : `--agent-h:${hue}`;
  $('#agent-hue-row').classList.toggle('tinted', hue !== null);
  $('#agent-hue-note').textContent = pickedHue !== null ? '(your own)' : editing ? '(its usual colour)' : '(picked from its name unless you choose one)';
  $('#agent-hue-reset').disabled = pickedHue === null;
}

/** The skills checklist. Your own skills come first and can be edited from here. */
function fillSkills(loaded) {
  const row = (skill) =>
    h(
      'label',
      { class: 'skill-row' },
      h('input', { type: 'checkbox', value: skill.id, checked: loaded.has(skill.id), onchange: showSkillCount }),
      h('b', null, skill.name, skill.own ? h('span', { class: 'badge' }, 'yours') : null),
      h('span', { class: 'muted' }, skill.description),
      skill.own ? h('button', { class: 'btn sm skill-edit', type: 'button', title: `Change or delete ${skill.name}`, onclick: (e) => (e.preventDefault(), openSkill(skill.id)) }, 'edit') : null,
    );
  const sorted = [...state.skills.filter((s) => s.own), ...state.skills.filter((s) => !s.own)];
  $('#agent-skills').replaceChildren(...(sorted.length ? sorted.map(row) : [h('div', { class: 'empty' }, 'No skills yet. Write one with "+ new skill".')]));
  showSkillCount();
}

// ------------------------------------------------------- a skill of your own

let skillId = null; // the skill in the skill form, or null for a new one
// How much of a skill reaches the model, per flame; the server holds the same numbers (flame.js).
const SKILL_USED = { low: 900, high: 3000 };

function countSkill() {
  const n = $('#skill-body').value.trim().length;
  const { low, high } = SKILL_USED;
  $('#skill-count').textContent =
    n <= low
      ? `(${n} characters - all of it is used on either flame)`
      : n <= high
        ? `(${n} characters - low flame uses the first ${low}, high flame all of it)`
        : `(${n} characters - low flame uses the first ${low}, high flame the first ${high})`;
  $('#skill-count').classList.toggle('over', n > high);
}

/** "Start from a link": fetch (and condense) on the server, then fill the form to check before saving. */
async function importSkill() {
  const url = $('#skill-url').value.trim();
  if (!url) return $('#skill-url').focus();
  const button = $('#skill-import');
  button.disabled = true;
  button.textContent = 'Importing…';
  try {
    const skill = await api.importSkill(url);
    $('#skill-name').value = skill.name;
    $('#skill-description').value = skill.description;
    $('#skill-body').value = skill.body;
    countSkill();
    toast(skill.condensed ? 'Condensed by the Chef - read it through, then save' : 'Imported - read it through, then save', 'ok');
    $('#skill-body').focus();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    button.disabled = false;
    button.textContent = 'Import';
  }
}

async function openSkill(id) {
  skillId = id;
  let skill = null;
  try {
    if (id) skill = await api.skill(id);
  } catch (err) {
    return toast(err.message, 'err');
  }
  $('#skill-title').textContent = skill ? `Edit ${skill.name}` : 'New skill';
  $('#skill-name').value = skill?.name ?? '';
  $('#skill-description').value = skill?.description ?? '';
  $('#skill-body').value = skill?.body ?? '';
  $('#skill-remove').hidden = !skill;
  // Importing starts a new skill; an existing one is edited by hand.
  $('#skill-import-row').hidden = Boolean(skill);
  $('#skill-url').value = '';
  if (!skill) fillGallery();
  countSkill();
  $('#skill-dialog').showModal();
  $('#skill-name').focus();
}

/** The hand-picked skills, grouped; one you already imported says so. */
async function fillGallery() {
  const select = $('#skill-gallery');
  select.replaceChildren(h('option', { value: '' }, 'or pick one: Python testing, React, SQL, sign-in…'));
  try {
    const { skills } = await api.skillGallery();
    const groups = [...new Set(skills.map((s) => s.group))];
    select.append(...groups.map((group) => h('optgroup', { label: group }, skills.filter((s) => s.group === group).map((s) => h('option', { value: s.url }, s.added ? `${s.name} (added)` : s.name)))));
  } catch {
    select.hidden = true; // the form still works with a link
  }
}

async function saveSkill(e) {
  e.preventDefault();
  // What is ticked in the agent form behind this one must survive the list being redrawn.
  const ticked = new Set([...$('#agent-skills').querySelectorAll('input:checked')].map((box) => box.value));
  try {
    const saved = await api.saveSkill({ name: $('#skill-name').value, description: $('#skill-description').value, body: $('#skill-body').value }, skillId);
    state.skills = await api.skills();
    // A skill just written is most likely wanted on the agent being edited: tick it if there is room.
    if (!skillId && ticked.size < MAX_SKILLS) ticked.add(saved.id);
    fillSkills(ticked);
    $('#skill-dialog').close();
    toast(skillId ? `${saved.name} updated` : `${saved.name} added to your skills`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function removeSkill() {
  const name = $('#skill-name').value;
  if (!skillId || !confirm(`Delete the skill "${name}"? Agents that have it loaded will lose it.`)) return;
  const ticked = new Set([...$('#agent-skills').querySelectorAll('input:checked')].map((box) => box.value));
  try {
    await api.removeSkill(skillId);
    state.skills = await api.skills();
    ticked.delete(skillId);
    fillSkills(ticked);
    $('#skill-dialog').close();
    toast(`${name} deleted`);
  } catch (err) {
    toast(err.message, 'err');
  }
}

function showSkillCount() {
  const boxes = [...$('#agent-skills').querySelectorAll('input')];
  const loaded = boxes.filter((box) => box.checked).length;
  $('#agent-skill-count').textContent = `(${loaded} of ${MAX_SKILLS} · low flame uses the first ${LOW_SKILLS}; each one makes prompts longer)`;
  // At the limit, the rest cannot be ticked until one is given up.
  for (const box of boxes) {
    box.disabled = !box.checked && loaded >= MAX_SKILLS;
    box.closest('.skill-row').classList.toggle('off', box.disabled);
  }
}

/** The checklist of connections: all of them (the default), or a chosen few. */
function showConnections(agent) {
  const all = !Array.isArray(agent?.connections);
  const allowed = new Set(agent?.connections ?? []);
  // One it was given earlier stays listed while it is disconnected, so saving does not drop it.
  const known = [...connections, ...[...allowed].filter((id) => !connections.some((c) => c.id === id)).map((id) => ({ id, about: 'not connected right now' }))];
  // Kept for other cooks (under "connect"): this agent cannot have it, whatever is ticked here.
  const others = (c) => {
    const only = state.access[c.id];
    return only && !only.includes(agent?.id) ? only : null;
  };
  const sync = () => {
    const everything = $('#agent-conn-all').checked;
    for (const box of $('#agent-connections').querySelectorAll('input[data-connection]')) {
      const barred = Boolean(box.dataset.barred);
      if (barred) box.checked = false;
      else if (everything) box.checked = true;
      box.disabled = everything || barred;
      box.closest('.skill-row').classList.toggle('off', box.disabled);
    }
  };
  $('#agent-connections').replaceChildren(
    h('label', { class: 'skill-row' }, h('input', { type: 'checkbox', id: 'agent-conn-all', checked: all, onchange: sync }), h('b', null, 'All connections'), h('span', { class: 'muted' }, 'Everything that is connected, and whatever you connect later.')),
    ...known.map((c) => {
      const only = others(c);
      const note = only ? `Kept for ${only.map((id) => state.agents[id]?.name ?? id).join(', ') || 'nobody'} - change that under "connect".` : c.about;
      return h('label', { class: 'skill-row' }, h('input', { type: 'checkbox', dataset: only ? { connection: c.id, barred: '1' } : { connection: c.id }, checked: !only && (all || allowed.has(c.id)) }), h('b', null, c.id), h('span', { class: 'muted' }, note));
    }),
    ...(known.length ? [] : [h('div', { class: 'empty' }, 'Nothing is connected yet. Add a service with "connect" in the taskbar.')]),
  );
  sync();
}

async function openForm(id) {
  editing = id;
  const agent = id ? state.agents[id] : null;
  connections = await api.connections().catch(() => connections);
  const house = Boolean(agent && !agent.custom);
  $('#agent-title').textContent = agent ? `Edit ${agent.name}` : 'Hire a specialist';

  // The house crew keeps its name and its job; only the settings below can change.
  $('#agent-identity').hidden = house;
  $('#agent-about').hidden = !house;
  $('#agent-about').textContent = house ? agent.blurb : '';
  for (const field of ['#agent-name', '#agent-specialty']) $(field).required = !house;
  $('#agent-name').value = agent?.name ?? '';
  $('#agent-specialty').value = agent?.blurb ?? '';
  $('#agent-instructions').value = agent?.instructions ?? '';
  $('#agent-gen-text').value = '';

  pickedHue = Number.isInteger(agent?.hue) ? agent.hue : null;
  $('#agent-swatch').textContent = id ? face(id) : '{o_o}';
  showHue();

  const choices = modelChoices();
  const current = house ? agent.model : agent?.model || agent?.tier || 'best';
  if (current && !['best', 'light'].includes(current) && !choices.some((c) => c.value === current)) {
    choices.push({ value: current, label: `${current} (no key for it right now)` });
  }
  $('#agent-model').replaceChildren(
    ...(house ? [h('option', { value: '' }, agent.id === 'commis' ? 'Its usual order (lighter models first)' : 'Its usual order (best available first)')] : []),
    h('option', { value: 'best' }, 'Best available first'),
    h('option', { value: 'light' }, 'Lighter models first (saves your best quota)'),
    ...choices.map((c) => h('option', { value: c.value }, `Start with: ${c.label}`)),
  );
  $('#agent-model').value = current;

  fillSkills(new Set(agent?.skills ?? []));

  // The Chef plans and the Taster reviews: neither ever calls a tool.
  const cooks = !agent || agent.role === 'coder';
  $('#agent-conn-field').hidden = !cooks;
  if (cooks) showConnections(agent);

  $('#agent-dismiss').hidden = !agent?.custom;
  $('#agent-save').textContent = agent ? 'Save changes' : 'Hire';
  $('#agent-dialog').showModal();
  (house ? $('#agent-hue') : agent ? $('#agent-name') : $('#agent-gen-text')).focus();
}

/** "Generate with AI": the Chef writes the name, the "good at" line, the instructions and picks skills; the form is filled to check. */
async function generateAgent() {
  const text = $('#agent-gen-text').value.trim();
  if (!text) return $('#agent-gen-text').focus();
  const button = $('#agent-gen');
  button.disabled = true;
  button.textContent = 'Writing…';
  try {
    const draft = await api.generateAgent(text);
    $('#agent-name').value = draft.name;
    $('#agent-specialty').value = draft.specialty;
    $('#agent-instructions').value = draft.instructions;
    for (const box of $('#agent-skills').querySelectorAll('input[type="checkbox"]')) box.checked = draft.skills.includes(box.value);
    showSkillCount();
    toast(`Written by the Chef${draft.skills.length ? `, with ${draft.skills.length} skill${draft.skills.length === 1 ? '' : 's'}` : ''} - read it through, then Hire`, 'ok');
    $('#agent-name').focus();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    button.disabled = false;
    button.textContent = 'Generate';
  }
}

async function submitForm(e) {
  e.preventDefault();
  const house = Boolean(editing && !state.agents[editing]?.custom);
  const choice = $('#agent-model').value;
  const order = choice === 'best' || choice === 'light';
  try {
    let id = editing;
    let agent = state.agents[editing];
    if (!house) {
      // A specialist's own order (best or lighter first) is part of who it is; a model to start with is a setting.
      const input = {
        name: $('#agent-name').value,
        specialty: $('#agent-specialty').value,
        instructions: $('#agent-instructions').value,
        tier: choice === 'light' ? 'light' : 'best',
      };
      agent = editing ? await api.retrain(editing, input) : await api.hire(input);
      id = agent.id;
    }
    agent = await api.configure(id, {
      hue: pickedHue,
      model: house ? choice : order ? '' : choice,
      skills: [...$('#agent-skills').querySelectorAll('input:checked')].map((box) => box.value),
      // Left out for the Chef and the Taster, who have no such setting.
      ...($('#agent-conn-field').hidden
        ? {}
        : { connections: $('#agent-conn-all').checked ? null : [...$('#agent-connections').querySelectorAll('input[data-connection]:checked')].map((box) => box.dataset.connection) }),
    });
    $('#agent-dialog').close();
    toast(editing ? `${agent.name} updated` : `${agent.name} joined the crew`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function dismiss(id) {
  const agent = state.agents[id];
  if (!agent || !confirm(`Remove ${agent.name} from the crew? This deletes the agent for good.`)) return;
  try {
    await api.dismiss(id);
    if ($('#agent-dialog').open) $('#agent-dialog').close();
    toast(`${agent.name} has left the crew`);
  } catch (err) {
    toast(err.message, 'err');
  }
}

const act = (fn, done) => async () => {
  try {
    await fn();
    if (done) toast(done, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
};

export function initCrew() {
  on('sync', () => {
    renderCrew();
    renderAgent();
  });
  on('agents', () => {
    renderCrew();
    renderAgent();
  });
  on('agentshow', showAgent);
  on('lessons', loadLessons);
  on('sync', loadLessons);
  on('run', renderFloor);
  // The stage hands over its Kitchen tab.
  on('floor', mountFloor);
  on('thought', ({ id, delta }) => {
    if (id !== selected) return;
    const pre = $('#insp-thought');
    // Only follow the stream if the reader has not scrolled up to look at something.
    const follow = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 48;
    thoughtChars += delta.length;
    if (thoughtChars > THOUGHT_DOM_CAP) pre.textContent = state.thoughts[id];
    else pre.append(delta);
    if (thoughtChars > THOUGHT_DOM_CAP) thoughtChars = state.thoughts[id].length;
    if (follow) pre.scrollTop = pre.scrollHeight;
  });

  $('#insp-edit').onclick = () => openForm(selected);
  $('#insp-duty').onclick = () => state.agents[selected] && setDuty(state.agents[selected], !state.agents[selected].off);
  $('#insp-clear').onclick = () => {
    state.thoughts[selected] = '';
    setThought('');
  };
  $('#insp-send').onclick = act(async () => {
    const input = $('#insp-note');
    const text = input.value.trim();
    if (!text) throw new Error('Write a note first');
    await api.note(selected, text);
    input.value = '';
  }, 'Note queued for its next step');
  $('#insp-pause').onclick = act(() => (state.agents[selected].paused ? api.resume(selected) : api.pause(selected)));
  $('#insp-swap').onclick = act(async () => {
    const { skipped } = await api.skipProvider();
    if (!skipped) throw new Error('No provider to swap away from');
  }, 'That provider is benched for 60 seconds');
  $('#insp-stop').onclick = act(async () => {
    const { stopped } = await api.stop();
    if (!stopped) throw new Error('Nothing is running');
  });

  const dialog = $('#agent-dialog');
  $('#agent-form').addEventListener('submit', submitForm);
  $('#agent-dismiss').onclick = () => dismiss(editing);
  $('#insp-remove').onclick = () => dismiss(selected);
  $('#agent-gen').onclick = generateAgent;
  // Enter in the describe box generates; it must not submit (hire) the form.
  $('#agent-gen-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      generateAgent();
    }
  });
  $('#skill-new').onclick = () => openSkill(null);
  $('#skill-form').addEventListener('submit', saveSkill);
  $('#skill-remove').onclick = removeSkill;
  $('#skill-body').oninput = countSkill;
  $('#skill-cancel').onclick = () => $('#skill-dialog').close();
  $('#skill-import').onclick = importSkill;
  $('#skill-gallery').onchange = (e) => {
    if (!e.target.value) return;
    $('#skill-url').value = e.target.value;
    e.target.value = '';
    importSkill();
  };
  $('#skill-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault(); // not a save: the form is not filled in yet
      importSkill();
    }
  });
  $('#skill-close').onclick = () => $('#skill-dialog').close();
  $('#agent-hue').oninput = () => {
    pickedHue = Number($('#agent-hue').value);
    showHue();
  };
  $('#agent-hue-reset').onclick = () => {
    pickedHue = null;
    showHue();
  };
  $('#agent-cancel').onclick = () => dialog.close();
  $('#agent-close').onclick = () => dialog.close();
  dialog.addEventListener('click', (e) => e.target === dialog && dialog.close());
}
