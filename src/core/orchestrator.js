import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractJson, parseWorkerOutput, applyEdits } from './parse.js';
import * as prompts from './prompts.js';
import { clip, log } from './util.js';
import { COOK_FOR_LEVEL, ESCALATION_COOK, FIX_COOK } from './crew.js';
import { groupOf } from './connectors/google.js';

/** Run errors that come from the providers (limits, budget), not from the work: never a lesson. */
const PROVIDER_ERRORS = new Set(['BUDGET', 'EXHAUSTED', 'NO_PROVIDERS', 'RATE_LIMITED']);

/**
 * The circuit breaker: a cook whose answers go wrong round after round is steered (told what was
 * wrong), then given a narrower job, then stopped early; a run with two failed steps skips the rest.
 * It only ever saves model calls - every limit in config.limits still applies on top.
 */
const BREAKER = { narrowAfter: 2, stopAfter: 3, runFailures: 2 };

/** What makes a change worth high flame's security pass: its paths or its contents mention these. */
const SENSITIVE = /\b(auth\w*|log_?in|sign_?(in|up)|passw(or)?d|token|session|cookie|jwt|oauth|payment|checkout|stripe|paypal|credit.?card|billing|secret|api.?key|credential|personal.?data)\b/i;


const CHAT_CAP = 200;
const RUNS_CAP = 30;
const QUEUE_CAP = 10;
/** How a review's fix round ended, in the run report: only a change that was made counts as fixed. */
const fixResult = (found) => (found.fixed ? 'fixed by the Fixer' : found.unchanged ? `the Fixer changed nothing (it judged the code already right) - check: ${clip(found.issues.map((i) => i.problem).join('; '), 200)}` : 'fix attempt failed');

/** The longest task text accepted (about 5k tokens): longer text goes in as an attachment. */
const MAX_REQUEST_CHARS = 20000;
const LISTED_FILES = 80;
const MAX_TOOLS_IN_PROMPT = 40;
const MAX_ATTACHMENTS = 5;
const MAX_VERIFY = 1000; // characters of the plan's check command: a longer one is dropped, never cut

const fail = (message, status) => Object.assign(new Error(message), { status });

/**
 * The hub of the hub-and-spoke pattern.
 *
 *   Owner -> Chef (plan) -> cooks x N (in order) -> verify -> Taster -> Fixer (fixes) -> Owner
 *
 * Each sub-task goes to one cook by difficulty (Prep / Cook /
 * Senior Cook); a dish a junior cannot finish is escalated once.
 *
 * The control flow is plain code, not model choice: workers never address each
 * other, every hand-off passes through here, and each step is one bounded LLM
 * call. That is what keeps runs deterministic and cheap.
 */
export class Orchestrator {
  constructor({ config, bus, crew, workspace, memory, locks, mcp, runner, checkpoints, journal = null }) {
    this.journal = journal; // what was done before, and what was learned (see journal.js); may be absent
    this.limits = config.limits;
    this.bus = bus;
    this.crew = crew;
    this.workspace = workspace;
    this.memory = memory;
    this.locks = locks;
    this.mcp = mcp;
    this.runner = runner;
    this.checkpoints = checkpoints;
    this.chat = [];
    this.runs = []; // finished runs that changed files, oldest first
    this.queue = [];
    this.current = null;
  }

  get busy() {
    return this.current !== null;
  }

  // ------------------------------------------------------------ public state

  runView() {
    const run = this.current;
    return run && { id: run.id, request: run.request, startedAt: run.startedAt, plan: run.plan };
  }

  queueView() {
    return this.queue.map((run) => ({ id: run.id, request: run.request, source: run.source }));
  }

  #undoable() {
    return this.runs.findLast((run) => !run.undone && run.before && run.after) ?? null;
  }

  runsView() {
    const undoable = this.busy ? null : this.#undoable();
    return this.runs.map((run) => ({
      id: run.id,
      objective: run.objective,
      ok: run.ok,
      files: run.files,
      finishedAt: run.finishedAt,
      undone: run.undone,
      hasDiff: Boolean(run.before && run.after),
      canUndo: run === undoable,
    }));
  }

  /** Reload what a previous session saved. */
  restore(saved = {}) {
    if (Array.isArray(saved.chat)) this.chat = saved.chat.slice(-CHAT_CAP);
    if (Array.isArray(saved.runs)) this.runs = saved.runs.slice(-RUNS_CAP);
  }

  say(role, text, meta = {}) {
    const message = { id: crypto.randomUUID().slice(0, 8), role, text, ts: Date.now(), ...meta };
    this.remember(message);
    this.bus.publish('chat:message', { message });
    return message;
  }

  /** Add to the chat history without announcing it (the UI already saw it live). */
  remember(message) {
    this.chat.push({ ts: Date.now(), ...message });
    if (this.chat.length > CHAT_CAP) this.chat.shift();
  }

  // ------------------------------------------------------------ run control

  /**
   * Submit a task. It starts now, or joins the queue if the crew is busy.
   * `run.done` resolves with the result when the run eventually finishes; it never rejects.
   */
  start(request, { source = 'ui', attachments = [], cook, tools, shell = false } = {}) {
    if (request != null && typeof request !== 'string') throw fail('The task must be text', 400);
    const typed = String(request ?? '').trim();
    if (!typed) throw fail('The task is empty', 400);
    // The whole request goes into the Chef's first prompt and the chat history: past this, attach it as a file.
    if (typed.length > MAX_REQUEST_CHARS) throw fail(`The task is too long (${typed.length} characters, at most ${MAX_REQUEST_CHARS}). Attach long text as a file instead.`, 413);
    // Attached files are already in the workspace; the request says so, so the chat and the plan both show it.
    const attached = this.#paths(attachments, MAX_ATTACHMENTS);
    const text = attached.length ? `${typed}\n\nAttached: ${attached.join(', ')}` : typed;
    if (this.current && this.queue.length >= QUEUE_CAP) throw fail(`The queue is full (${QUEUE_CAP} tasks waiting)`, 409);

    const run = {
      id: crypto.randomUUID().slice(0, 8),
      request: text,
      source,
      attachments: attached,
      // A flow step may pin who cooks and which connections may be used; the plan is still the Chef's.
      pin: { cook: this.crew.agents.get(cook)?.role === 'coder' ? cook : null, tools: Array.isArray(tools) ? tools.map(String) : null },
      abort: new AbortController(),
      plan: null,
      queued: false,
      // High flame, typed in the dashboard only: CLI agents may run their own commands in their copy of the folder.
      shell: shell === true && source === 'ui',
    };
    run.done = new Promise((resolve) => {
      run.finish = resolve;
    });

    if (this.current) {
      run.queued = true;
      this.queue.push(run);
      this.#queueChanged();
    } else {
      this.#launch(run);
    }
    return run;
  }

  #queueChanged() {
    this.bus.publish('queue:update', { queue: this.queueView() });
  }

  #launch(run) {
    this.current = run;
    run.queued = false;
    run.startedAt = Date.now();
    // `done` always resolves, and the queue always moves on - even if reporting the run is what failed.
    this.#execute(run)
      .catch((err) => this.#recover(run, err))
      .then(run.finish);
  }

  /** The next waiting task gets its turn, in the order they arrived. */
  #advance() {
    const next = this.queue.shift();
    this.#queueChanged();
    if (next) this.#launch(next);
  }

  /** A fault outside the run itself (in wrapping it up) must not leave the crew marked busy for ever. */
  #recover(run, err) {
    log.warn(`Run ${run.id} could not be wrapped up: ${err.message}`);
    const result = { runId: run.id, ok: false, reply: `[!] ${err.message}`, changed: [], error: 'ERROR' };
    if (this.current === run) this.current = null;
    this.bus.publish('run:done', result);
    if (!this.current) this.#advance();
    return result;
  }

  /** Stop the run in progress. Queued tasks are untouched and start next. */
  stop() {
    if (!this.current) return false;
    this.current.abort.abort(new Error('Stopped by operator'));
    this.crew.resumeAll();
    return true;
  }

  /** Cancel a run by id, whether it is running or still queued. */
  cancel(runId) {
    if (this.current?.id === runId) return this.stop();
    const index = this.queue.findIndex((run) => run.id === runId);
    if (index < 0) return false;
    const [run] = this.queue.splice(index, 1);
    run.abort.abort(new Error('Removed from the queue'));
    run.finish({ runId: run.id, ok: false, reply: 'Removed from the queue.', changed: [], error: 'CANCELLED' });
    this.#queueChanged();
    return true;
  }

  async #execute(run) {
    const { signal } = run.abort;
    let result = { runId: run.id, ok: false, reply: '', changed: [] };
    this.say('user', run.request, { source: run.source });
    this.bus.publish('run:start', { runId: run.id, request: run.request });
    // For the journal: the commands this run made.
    const commands = [];
    const stopListening = this.bus.subscribe(({ type, data }) => type === 'exec:end' && commands.push({ owner: data.owner, command: data.command, code: data.code }));
    // What this run cost: one run at a time, so the crew's total before and after tells it.
    const spentBefore = this.crew.tokensUsed();

    try {
      const plan = await this.#plan(run, signal);
      result = plan.subtasks.length
        ? await this.#cook(run, plan, signal)
        : { ...result, ok: true, reply: plan.reply || 'Nothing to do for that request.' };
    } catch (err) {
      result.reply = signal.aborted ? 'Run stopped by operator.' : `[!] ${err.message}`;
      result.error = err.code ?? 'ERROR';
      result.changed = err.changed ?? [];
      await this.memory.set({ milestone: signal.aborted ? 'Run stopped by operator.' : `Run failed: ${err.message}` });
    }

    result.tokens = this.crew.tokensUsed() - spentBefore;
    result.flame = this.limits.flame ?? 'low';

    // Record every run that got as far as touching files - failed ones most of all,
    // since those are the ones worth undoing.
    if (run.before) await this.#record(run, result);
    stopListening();
    if (run.plan) await this.#remember(run, result, commands).catch((err) => log.warn(`The run could not be written to the journal: ${err.message}`));

    this.current = null;
    this.crew.settle();
    // What a run cost is kept in the journal; the chat shows usage live in the dashboard's usage bar instead.
    this.say('manager', result.reply, { runId: run.id, ok: result.ok });
    this.bus.publish('run:done', result);
    this.bus.publish('runs:update', { runs: this.runsView() });

    this.#advance();
    return result;
  }

  // ---------------------------------------------------------------- journal

  /** Write the run into the journal, and keep what it taught. Only runs that had a plan: a chat answer is not work. */
  async #remember(run, result, commands) {
    if (!this.journal?.enabled) return;
    const review = run.reviews?.at(-1) ?? null;
    await this.journal.add({
      id: run.id,
      // The journal's own clock, so "yesterday" in a question and the time of an entry are measured alike.
      at: this.journal.now(),
      startedAt: run.startedAt,
      source: run.source,
      request: clip(run.request, 600),
      objective: run.objective ?? run.plan.objective ?? '',
      ok: result.ok,
      error: result.error ?? null,
      reply: clip(result.reply, 800),
      steps: run.plan.subtasks.map((s) => ({ title: s.title, cook: s.cookId, cookName: s.cook, model: this.crew.agents.get(s.cookId)?.route?.model ?? null, files: s.files, status: s.status, summary: clip(s.summary, 200) })),
      files: result.changed ?? [],
      commands: commands.slice(0, 20),
      tokens: result.tokens ?? 0,
      flame: result.flame ?? 'low',
      review: review && { verdict: run.reviews.some((r) => r.verdict === 'revise') ? 'revised' : 'approved', issues: run.reviews.reduce((n, r) => n + r.issues.length, 0), summary: review.summary },
    });

    // Lessons. For the project: what the Taster said is worth keeping. For a cook: the defects found in
    // its own step, so it is told next time. At most two of each from one run.
    const learned = (run.reviews ?? []).flatMap((r) => r.lessons ?? []).slice(0, 2).map((text) => ({ text, for: 'all' }));
    const mistakes = (run.reviews ?? [])
      .filter((r) => r.verdict === 'revise')
      .flatMap((r) => r.issues)
      .filter((issue) => issue.file)
      .map((issue) => ({ issue, step: run.plan.subtasks.find((s) => !s.fix && s.files.includes(issue.file)) }))
      .filter(({ step }) => step)
      .slice(0, 2)
      .map(({ issue, step }) => ({ text: `In ${issue.file} a review found: ${issue.problem}`, for: step.cookId }));
    // Why a run failed, from what is already known (no extra model call): a step that failed even after
    // the retry tells its cook; a failed check tells the whole folder. A stopped run, or one the providers
    // ended (limits, budget), says nothing about the project and teaches nothing.
    const failures = [];
    if (!result.ok && !run.abort.signal.aborted && !PROVIDER_ERRORS.has(result.error)) {
      for (const step of run.plan.subtasks.filter((s) => s.status === 'failed' && s.summary).slice(0, 1)) {
        failures.push({ text: `"${clip(step.title, 60)}" failed before: ${clip(step.summary.split('\n')[0], 140)}`, for: step.cookId });
      }
      const check = run.verification;
      if (check?.ran && !check.ok) {
        const why = check.text.split('\n').slice(1).find((line) => line.trim()) ?? check.text.split('\n')[0];
        failures.push({ text: `The check \`${clip(check.command, 80)}\` failed before: ${clip(why.trim(), 120)}`, for: 'all' });
      }
    }
    await this.journal.learn([...learned, ...mistakes, ...failures], run.id);
  }

  // ------------------------------------------------------- checkpoints, undo

  async #record(run, result) {
    const after = await this.checkpoints.snapshot(`after: ${run.objective}`);
    this.runs.push({
      id: run.id,
      objective: run.objective,
      ok: result.ok,
      files: result.changed,
      finishedAt: Date.now(),
      before: run.before,
      after,
      undone: false,
    });
    if (this.runs.length > RUNS_CAP) this.runs.shift();
  }

  #findRun(runId) {
    const run = this.runs.find((r) => r.id === runId);
    if (!run) throw fail('Unknown run', 404);
    if (!run.before || !run.after) throw fail('No checkpoint was recorded for this run', 404);
    return run;
  }

  /** Unified diff of everything a run changed. */
  diff(runId) {
    const run = this.#findRun(runId);
    return this.checkpoints.diff(run.before, run.after);
  }

  /** Put the workspace back to how it was before the most recent run. */
  async undo(runId) {
    if (this.busy) throw fail('Wait for the current run to finish before undoing', 409);
    const run = this.#findRun(runId);
    if (run !== this.#undoable()) throw fail('Only the most recent run can be undone', 409);
    await this.checkpoints.restore(run.before);
    run.undone = true;
    await this.memory.set({ milestone: `Undid the run "${run.objective}"` });
    this.say('manager', `Undid **${run.objective}** — the workspace is back to how it was before that run.`);
    this.bus.publish('fs:change', { paths: [] });
    this.bus.publish('runs:update', { runs: this.runsView() });
    return { undone: run.id };
  }

  // ---------------------------------------------------------------- planning

  async #plan(run, signal) {
    // What the user attached is read once, up front: no round trip to ask for it.
    const attached = await this.#gather(run.attachments ?? []);
    let extra = [];
    let nudge = '';
    let history = ''; // filled once, if the Chef asks to look into the journal
    const hasJournal = Boolean(this.journal?.enabled && this.journal.size);
    for (let attempt = 0; ; attempt++) {
      const out = await this.crew.call('general-manager', {
        task: attempt ? 'Refining the plan' : 'Planning the task',
        system: prompts.managerSystem(this.limits.maxSubtasks, this.runner.enabled ? this.runner.shellName : false, this.crew.specialists(), this.mcp?.groups?.() ?? [], hasJournal, (this.limits.parallelCooks ?? 1) > 1),
        user: async () =>
          prompts.managerUser({
            memory: await this.memory.read(),
            files: await this.#fileList(),
            request: run.request,
            attached,
            extra,
            nudge,
            lessons: this.journal?.lessonsFor('general-manager') ?? [],
            history,
            pinned: run.pin?.tools ? (this.mcp?.groups?.() ?? []).filter((group) => run.pin.tools.includes(group.id)) : [],
          }),
        json: true,
        signal,
      });

      const raw = extractJson(out.text);
      if (!raw) {
        if (attempt === 0) {
          nudge = 'Your previous reply was not a valid JSON object. Reply with the JSON object only.';
          continue;
        }
        // Still prose: treat it as a direct answer rather than failing the run.
        return { objective: '', reply: out.text.trim(), subtasks: [], verify: '' };
      }

      const plan = this.#sanitizePlan(raw, run.pin);
      // A question about earlier work: look it up once, then let the Chef answer from what was found.
      if (hasJournal && !plan.subtasks.length && plan.needHistory && !history && attempt < 2) {
        history = this.journal.describe(this.journal.search(`${plan.needHistory} ${run.request}`));
        nudge = 'The journal entries you asked for are above. Answer the Owner from them in "reply", in plain words, with dates and names where they help. If they do not hold the answer, say so - do not guess.';
        continue;
      }
      if (!plan.subtasks.length && plan.needFiles.length && !extra.length && attempt < 2) {
        extra = await this.#gather(plan.needFiles.slice(0, 6));
        continue;
      }
      return plan;
    }
  }

  #validPath(file) {
    try {
      const { rel } = this.workspace.resolve(file);
      return this.workspace.isMemory(rel) ? null : rel;
    } catch {
      return null;
    }
  }

  #paths(value, max) {
    const list = Array.isArray(value) ? value : [];
    return [...new Set(list.map((f) => this.#validPath(f)).filter(Boolean))].slice(0, max);
  }

  #sanitizePlan(raw, pin = {}) {
    // A sub-task goes to a hired specialist only if the plan names one that exists.
    const specialists = new Set(this.crew.specialists().map((s) => s.id));
    const connections = new Set((this.mcp?.groups?.() ?? []).map((g) => g.id));
    const toolsOf = (value) => [...new Set((Array.isArray(value) ? value : []).map(String).filter((id) => connections.has(id)))].slice(0, this.limits.toolsPerSubtask ?? 3);
    // The Chef numbers its sub-tasks from 1, before any are dropped here: "needs" is translated to our positions.
    const kept = (Array.isArray(raw.subtasks) ? raw.subtasks : [])
      .map((s, number) => ({ s, number: number + 1 }))
      .filter(({ s }) => s && typeof s === 'object' && String(s.instructions ?? '').trim())
      .slice(0, this.limits.maxSubtasks);
    const position = new Map(kept.map(({ number }, i) => [number, i]));
    const subtasks = kept
      .map(({ s }) => s)
      .map((s, i) => ({
        title: clip(String(s.title ?? '').trim() || `Sub-task ${i + 1}`, 100),
        instructions: String(s.instructions).trim(),
        files: this.#paths(s.files, 8),
        // The plan lists the files a sub-task creates or edits: naming some and touching none is a failure, not a success.
        mustWrite: this.#paths(s.files, 8).length > 0,
        // A cook the user switched off hands the step to its stand-in (crew.cookFor); a switched-off specialist is not offered to the Chef at all.
        cook: this.crew.cookFor(pin.cook ?? (specialists.has(s.cook) ? s.cook : (COOK_FOR_LEVEL[s.level] ?? COOK_FOR_LEVEL.standard))),
        // Pinned connections replace the Chef's pick: the user said what this work may reach.
        tools: toolsOf(pin.tools ?? s.tools),
        // Who else may cook it when that cook is busy (high flame cooks several steps at once): only a
        // step the Chef sent by level - never a pinned cook or a hired specialist.
        level: !pin.cook && !specialists.has(s.cook) ? (COOK_FOR_LEVEL[s.level] ? s.level : 'standard') : null,
        // The steps it builds on, always earlier ones (so there is never a loop). Not said: the one before it.
        needs: Array.isArray(s.needs)
          ? [...new Set(s.needs.map((n) => position.get(Number(n))).filter((at) => at !== undefined && at < i))]
          : i > 0
            ? [i - 1]
            : [],
      }));
    const verify = typeof raw.verify === 'string' ? raw.verify.trim() : '';
    return {
      objective: clip(String(raw.objective ?? '').trim(), 200),
      reply: String(raw.reply ?? '').trim(),
      needFiles: this.#paths(raw.need_files, 6),
      needHistory: clip(String(raw.need_history ?? '').trim(), 200),
      subtasks,
      // One line only: a multi-line "command" is a script, and that is a cook's job.
      // A command is used whole or not at all: one cut short is broken (a real run failed on a check cut at 300 characters).
      verify: this.runner.enabled && verify && !/[\r\n]/.test(verify) && verify.length <= MAX_VERIFY ? verify : '',
    };
  }

  // --------------------------------------------------------------- execution

  async #cook(run, plan, signal) {
    const objective = plan.objective || clip(run.request, 200);
    run.objective = objective;
    await this.memory.set({ objective });
    // Checkpoint first, so everything this run does can be shown as a diff and undone.
    run.before = await this.checkpoints.snapshot(`before: ${objective}`);

    run.plan = {
      objective,
      // `cook` is the name to show, `cookId` is who it is (the dashboard colours the step by it).
      subtasks: plan.subtasks.map((s) => ({ title: s.title, files: s.files, cook: this.crew.get(s.cook).name, cookId: s.cook, status: 'pending', summary: '' })),
    };
    const publishPlan = () => this.bus.publish('run:plan', { runId: run.id, ...run.plan });
    const mark = (index, status, summary = '') => {
      Object.assign(run.plan.subtasks[index], { status, summary });
      publishPlan();
    };
    publishPlan();

    const changed = new Set();
    const runSubtask = async (index, subtask) => {
      signal.throwIfAborted();
      subtask.shell = run.shell;
      mark(index, 'working');
      let outcome = await this.#asCook(subtask.cook, () => this.#subtask(objective, subtask, subtask.cook, signal));
      // A dish a cook could not finish goes up the line - once (to the Senior Cook, or its stand-in when it is switched off).
      const senior = this.crew.cookFor(ESCALATION_COOK);
      if (!outcome.ok && !subtask.fix && subtask.cook !== senior) {
        Object.assign(run.plan.subtasks[index], { cook: this.crew.get(senior).name, cookId: senior });
        mark(index, 'working', `escalated: ${outcome.summary}`);
        // The Senior Cook may be busy with a step of its own: it takes this one when it is free.
        const second = await this.#asCook(senior, () => this.#subtask(objective, subtask, senior, signal));
        second.written = [...new Set([...outcome.written, ...second.written])];
        outcome = second;
      }
      outcome.written.forEach((f) => changed.add(f));
      outcome.deleted.forEach((f) => changed.delete(f));
      mark(index, outcome.ok ? 'done' : 'failed', outcome.summary);
      await this.memory.set({
        milestone: `${subtask.title} — ${outcome.ok ? '' : 'FAILED: '}${outcome.summary}`,
      });
      return outcome;
    };

    try {
      await this.#schedule(run, plan.subtasks, runSubtask, mark);

      // Ground truth before opinion: run the plan's check, then let the Taster read.
      const verify = () => (plan.verify && changed.size ? this.#verify(plan.verify, signal) : null);
      let verification = await verify();

      // Review loop: the Taster reports to the hub, the hub briefs the Fixer.
      let review = null;
      const fixFrom = async (found, title = 'Apply review fixes') => {
        const fixer = this.crew.cookFor(FIX_COOK);
        const files = this.#paths(found.issues.map((i) => i.file), 8);
        const fix = {
          title,
          instructions: `The Taster found these defects. Fix every one of them:\n${found.issues
            .map((i, n) => `${n + 1}. ${i.file ? `[${i.file}] ` : ''}${i.problem}${i.fix ? ` -> ${i.fix}` : ''}`)
            .join('\n')}${
            // Seen with a real model: a security fix changed a stored password hash and broke the plan's check.
            // The Fixer is told the check and may run it itself - no extra review call.
            plan.verify
              ? `\nAfter your changes this check must still pass: ${plan.verify}${this.runner.enabled ? ' - run it with a <<<RUN>>> block before you finish, and if a value has to be computed (a hash, say), compute it with a command instead of guessing it.' : ''}`
              : ''
          }`,
          // The files named in the issues first, then everything else this run changed: a real security fix
          // (a password hash) needed users.json as well as the login.js the Taster named.
          files: [...new Set([...files, ...changed])].slice(0, 8),
          cook: fixer,
          fix: true,
          // The fixer may need whatever the plan's cooks were given.
          tools: [...new Set(plan.subtasks.flatMap((s) => s.tools ?? []))].slice(0, this.limits.toolsPerSubtask ?? 3),
        };
        run.plan.subtasks.push({ title: fix.title, files: fix.files, cook: this.crew.get(fixer).name, cookId: fixer, fix: true, status: 'pending', summary: '' });
        // What the files held before: a Fixer that writes them back unchanged has not fixed anything
        // (seen: "no changes needed", reported as "fixed by the Fixer", with the defect still there).
        const read = (f) => this.workspace.readFile(f).then((r) => r.content, () => null);
        const before = new Map(await Promise.all(fix.files.map(async (f) => [f, await read(f)])));
        const outcome = await runSubtask(run.plan.subtasks.length - 1, fix);
        const altered = (outcome.deleted ?? []).length > 0 || (await Promise.all((outcome.written ?? []).map(async (f) => !before.has(f) || before.get(f) !== (await read(f))))).some(Boolean);
        found.fixed = outcome.ok && altered;
        found.unchanged = outcome.ok && !altered;
        verification = await verify();
      };
      // A Taster the user switched off means no review: fewer model calls, and the check command still runs.
      const tasting = this.crew.isOn('head-chef');
      for (let round = 0; tasting && round < this.limits.maxReviewRounds && changed.size; round++) {
        review = await this.#review(objective, [...changed], verification, signal);
        (run.reviews ??= []).push(review);
        if (review.verdict !== 'revise') break;
        await fixFrom(review);
      }

      // High flame only: a change that touches sign-in, payments or personal data gets one more look,
      // for security alone, and one round of fixes. One call (two with a fix), bounded, never on low flame.
      let security = null;
      if (tasting && this.limits.securityReview && changed.size && (await this.#sensitive([...changed]))) {
        security = await this.#review(objective, [...changed], null, signal, { focus: 'security' });
        security.lessons = [];
        (run.reviews ??= []).push(security);
        if (security.verdict === 'revise') await fixFrom(security, 'Apply security fixes');
      }

      run.verification = verification; // for the journal: a failed check is worth a lesson
      const done = run.plan.subtasks.filter((s) => s.status === 'done').length;
      const total = run.plan.subtasks.length;
      const files = [...changed].sort();
      const verified = !verification?.ran || verification.ok;
      const reviewLine = !review
        ? !tasting && changed.size
          ? 'skipped - the Taster is switched off'
          : ''
        : review.verdict === 'approve'
          ? `approved — ${review.summary}`
          : `${review.issues.length} issue(s) found — ${fixResult(review)}`;

      await this.memory.set({
        milestone: `Finished "${objective}": ${done}/${total} sub-tasks ok${verification?.ran ? `, verify ${verification.ok ? 'passed' : 'FAILED'}` : ''}${files.length ? `; files: ${files.join(', ')}` : ''}`,
      });

      const lines = [
        `**${objective}**`,
        ...run.plan.subtasks.map((s, i) => `${s.status === 'done' ? '[x]' : s.status === 'skipped' ? '[-]' : '[!]'} ${i + 1}. ${s.title} — ${s.summary}`),
      ];
      if (files.length) lines.push(`**Files:** ${files.map((f) => `\`${f}\``).join(', ')}`);
      if (verification) {
        lines.push(`**Verify:** \`${verification.command}\` — ${verification.ran ? (verification.ok ? 'passed' : 'FAILED') : verification.text}`);
      }
      if (reviewLine) lines.push(`**Review:** ${reviewLine}`);
      if (security) {
        lines.push(`**Security:** ${security.verdict === 'approve' ? 'no problems found' : `${security.issues.length} issue(s) found — ${fixResult(security)}`}`);
      }
      return { runId: run.id, ok: done === total && verified, reply: lines.join('\n'), changed: files };
    } catch (err) {
      // Let #execute report it, but keep the list of files already touched for the run record.
      err.changed = [...changed].sort();
      throw err;
    }
  }

  /** Each cook does one step at a time: a step for a busy cook waits for it. */
  #cooks = new Map();
  #asCook(cook, work) {
    const turn = (this.#cooks.get(cook) ?? Promise.resolve()).then(work);
    const settled = turn.catch(() => {});
    this.#cooks.set(cook, settled);
    settled.then(() => this.#cooks.get(cook) === settled && this.#cooks.delete(cook));
    return turn;
  }

  /**
   * Cook the plan's steps. A step starts when the steps it needs are finished, its cook is free and
   * no step at work shares a file with it - up to `parallelCooks` at a time (1 on low flame: the steps
   * go one by one, in order, exactly as before). The circuit breaker still skips the rest once two
   * steps have failed. A step that only needs "a cook" moves to a free one of the same grade or above.
   */
  async #schedule(run, steps, runSubtask, mark) {
    const limit = Math.max(1, this.limits.parallelCooks ?? 1);
    const finished = new Set();
    const started = new Set();
    const working = new Map(); // index -> its promise
    let fault = null;
    const busy = (cook) => [...working.keys()].some((j) => steps[j].cook === cook);
    const clash = (i) => [...working.keys()].some((j) => steps[j].files.some((f) => steps[i].files.includes(f)));
    const ready = (i) => !started.has(i) && steps[i].needs.every((n) => finished.has(n)) && !clash(i);

    for (;;) {
      const failed = run.plan.subtasks.filter((s) => s.status === 'failed').length;
      if (!fault && failed >= BREAKER.runFailures) {
        // Two steps failed (each after its retry): the rest usually builds on them, so skip it rather than burn calls.
        const left = steps.map((_, i) => i).filter((i) => !started.has(i));
        for (const i of left) {
          started.add(i);
          mark(i, 'skipped', `skipped: ${failed} steps before it failed`);
        }
        if (left.length) this.crew.think('general-manager', `\n[breaker] ${failed} steps failed - the remaining ${left.length} are skipped\n`);
      }
      while (!fault && working.size < limit) {
        const next = steps.findIndex((_, i) => ready(i) && (!busy(steps[i].cook) || this.#freeCook(steps[i], busy)));
        if (next < 0) break;
        const step = steps[next];
        if (busy(step.cook)) {
          step.cook = this.#freeCook(step, busy);
          Object.assign(run.plan.subtasks[next], { cook: this.crew.get(step.cook).name, cookId: step.cook });
        }
        started.add(next);
        working.set(
          next,
          runSubtask(next, step).then(
            () => null,
            (err) => err,
          ),
        );
      }
      if (!working.size) break;
      // One step finished: note it, and look again at what can start.
      const [index, err] = await Promise.race([...working].map(([i, p]) => p.then((e) => [i, e])));
      working.delete(index);
      finished.add(index);
      // An abort or the providers running out ends the run - once the steps already at work have stopped.
      fault ??= err;
    }
    if (fault) throw fault;
  }

  /** Another cook for a step whose own cook is busy: same grade or above, free right now. */
  #freeCook(step, busy) {
    if (!step.level) return null;
    const line = { simple: ['commis', 'chef-de-partie', 'executive-chef'], standard: ['chef-de-partie', 'executive-chef'], complex: ['executive-chef'] }[step.level] ?? [];
    return line.find((cook) => this.crew.agents.has(cook) && this.crew.isOn(cook) && !busy(cook)) ?? null;
  }

  /** Run the plan's verification command on behalf of the Taster. */
  async #verify(command, signal) {
    this.crew.setState('head-chef', 'working', `Verifying: ${clip(command, 70)}`);
    try {
      const run = await this.runner.run(command, { owner: 'head-chef', signal });
      const text = `exit code ${run.code}${run.timedOut ? ' (timed out)' : ''}\n${run.output || '(no output)'}`;
      this.crew.think('head-chef', `\n$ ${command}\n${clip(text, 600)}\n`);
      return { command, ran: true, ok: run.code === 0, text };
    } catch (err) {
      if (signal.aborted) throw err;
      return { command, ran: false, ok: false, text: `not run (${err.message})` };
    } finally {
      this.crew.setState('head-chef', 'standby', '');
    }
  }

  /**
   * High flame: the step is done by a subscription CLI working as an agent, in a private copy of
   * the folder (exported from a fresh checkpoint into a temp folder: no .git, not the workspace).
   * What it changed comes back through Workspace, under the cook's name, with its locks - and a
   * file that changed here meanwhile is merged three ways, never overwritten. Returns null when no
   * CLI can take the step (none set up, not in this mode, out of its limit): the ordinary cook does it.
   */
  async #subtaskAgent(objective, subtask, cook, signal) {
    if (!this.limits.cliAgents || !this.checkpoints?.available) return null;
    const outcome = { ok: false, summary: '', written: [], deleted: [], errors: [] };
    const lockOpts = { timeoutMs: this.limits.lockTimeoutMs };
    const handles = [];
    let scratch = null;
    try {
      for (const file of [...subtask.files].sort()) handles.push(await this.locks.acquire(file, cook, lockOpts));
      const base = await this.checkpoints.snapshot(`step: ${subtask.title}`);
      if (!base) return null;
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'kadhai-agent-'));
      const dir = path.join(scratch, 'work');
      const index = path.join(scratch, 'index');
      await this.checkpoints.exportTo(base, dir, index);

      const me = this.crew.get(cook);
      const out = await this.crew.act(cook, {
        task: subtask.title,
        system: prompts.agentSystem(me.name, me.instructions, subtask.shell),
        user: prompts.agentUser({ memory: await this.memory.read(), objective, subtask, lessons: this.journal?.lessonsFor(cook) ?? [], recall: this.journal?.recallFiles(subtask.files) ?? [] }),
        dir,
        shell: Boolean(subtask.shell),
        signal,
      });
      if (!out) return null;

      for (const change of await this.checkpoints.changesIn(dir, index, base)) {
        const rel = this.#validPath(change.path);
        if (!rel) continue; // memory.md, or a path the workspace refuses: never copied back
        try {
          await this.#takeBack(rel, change.status, { dir, base, scratch, cook, outcome, lockOpts });
        } catch (err) {
          outcome.errors.push(err.message);
        }
      }

      const summary = out.text.split('\n').reverse().find((line) => /^\s*SUMMARY:/i.test(line));
      // A failed turn's last words are not a summary; the reason is (below).
      if (!out.failed) outcome.summary = clip((summary ?? out.text.split('\n').filter((l) => l.trim()).at(-1) ?? '').replace(/^\s*SUMMARY:\s*/i, '').trim(), 300);
      if (out.failed) outcome.errors.push(`${out.route.label} stopped: ${out.why}`);
      const touched = outcome.written.length + outcome.deleted.length;
      if (subtask.mustWrite && !touched) outcome.errors.push(`none of its files were written (${subtask.files.join(', ')})`);
      outcome.ok = !outcome.errors.length && (touched > 0 || Boolean(outcome.summary));
      outcome.summary ||= touched ? `Wrote ${outcome.written.join(', ')}` : 'No output was produced';
      if (outcome.errors.length) outcome.summary = clip(`${outcome.summary} (${outcome.errors.join('; ')})`, 300);
      return outcome;
    } catch (err) {
      if (signal.aborted || err.name === 'DispatchError') throw err;
      log.warn(`Agent step "${subtask.title}" could not run: ${err.message}`);
      return null;
    } finally {
      for (const handle of handles.reverse()) await handle.release();
      if (scratch) await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** One file an agent changed in its copy, brought into the workspace. */
  async #takeBack(rel, status, { dir, base, scratch, cook, outcome, lockOpts }) {
    const then = await this.checkpoints.textAt(base, rel);
    const now = await this.workspace.readFile(rel).then(
      (f) => (f.binary || f.truncated ? Symbol('unreadable') : f.content),
      () => null,
    );
    const untouchedHere = now === then;
    if (status === 'D') {
      if (now === null) return;
      if (!untouchedHere) throw new Error(`${rel} was deleted in the copy but changed here meanwhile, so it was kept`);
      await this.workspace.deleteFile(rel, { owner: cook, ...lockOpts });
      outcome.deleted.push(rel);
      return;
    }
    const buffer = await fs.readFile(path.join(dir, rel));
    if (buffer.subarray(0, 8192).includes(0)) throw new Error(`${rel} is a binary file and was not copied back`);
    const theirs = buffer.toString('utf8');
    if (theirs === now) return;
    let content = theirs;
    if (!untouchedHere) {
      // Someone else wrote it since the copy was made (another cook, or you): merge, or refuse.
      if (typeof now !== 'string') throw new Error(`${rel} changed here meanwhile and cannot be merged`);
      const merged = await this.checkpoints.merge(now, then ?? '', theirs, scratch);
      if (!merged.clean) throw new Error(`${rel} changed here meanwhile and the two versions conflict, so the copy's version was not applied`);
      content = merged.text;
    }
    const { path: written } = await this.workspace.writeFile(rel, content, { owner: cook, ...lockOpts });
    if (!outcome.written.includes(written)) outcome.written.push(written);
  }

  /** One sub-task, cooked by one cook. Its declared files stay locked from first prompt to last write. */
  async #subtask(objective, subtask, cook, signal) {
    // High flame: a subscription CLI may do the whole step as an agent; if none can, the cook below does.
    const acted = await this.#subtaskAgent(objective, subtask, cook, signal);
    if (acted) return acted;
    const outcome = { ok: false, summary: '', written: [], deleted: [], errors: [] };
    const created = []; // files this step made that did not exist before
    let elsewhereTold = false;
    const handles = [];
    // Only the connections this sub-task was given: every tool description costs tokens.
    // ...and of those, only the ones the user lets this cook use.
    const wanted = subtask.tools ?? [];
    const allowed = wanted.filter((connection) => this.crew.mayUse(cook, connection));
    const tools = (this.mcp?.toolsFor?.(allowed) ?? []).slice(0, MAX_TOOLS_IN_PROMPT);
    if (allowed.length < wanted.length) {
      this.crew.think(cook, `\n[!] no access to: ${wanted.filter((c) => !allowed.includes(c)).join(', ')} (see this agent's connections)\n`);
    }
    const lockOpts = { timeoutMs: this.limits.lockTimeoutMs };
    const exec = this.runner.enabled ? { shell: this.runner.shellName, timeoutSeconds: Math.round(this.runner.timeoutMs / 1000) } : null;
    let writes = 0; // every file written or deleted in this step: a command run again after one is not a repeat
    const save = async (file, content) => {
      const fresh = !(await this.workspace.exists(file).catch(() => true));
      const { path: rel } = await this.workspace.writeFile(file, content, { owner: cook, ...lockOpts });
      if (fresh && !created.includes(rel)) created.push(rel);
      if (!outcome.written.includes(rel)) outcome.written.push(rel);
      writes += 1;
    };

    try {
      // Sorted acquisition order rules out lock-order deadlocks between processes.
      for (const file of [...subtask.files].sort()) {
        handles.push(await this.locks.acquire(file, cook, lockOpts));
      }

      let extra = '';
      let strikes = 0; // rounds in a row whose answer had mistakes
      let narrow = false; // whole files only, no look-ups: the breaker's second step
      const served = new Set(); // reads and tool calls already answered in this step
      for (let round = 0; round <= this.limits.maxToolRounds; round++) {
        const lastRound = round === this.limits.maxToolRounds;
        const out = await this.crew.call(cook, {
          task: subtask.title,
          system: prompts.coderSystem(tools, exec, this.crew.get(cook).name, this.crew.get(cook).instructions),
          user: async () =>
            prompts.coderUser({
              memory: await this.memory.read(),
              objective,
              subtask,
              current: await this.#gather(subtask.files),
              files: await this.#fileList(),
              extra,
              written: outcome.written,
              lessons: this.journal?.lessonsFor(cook) ?? [],
              recall: this.journal?.recallFiles(subtask.files) ?? [],
            }),
          signal,
        });

        // "length" means the provider cut the answer at the output limit; anything else, the model stopped by itself.
        const parsed = parseWorkerOutput(out.text, subtask.files, { complete: out.finishReason !== 'length' });
        const problems = []; // things the cook can correct if it gets another round

        // Some reasoning models (gpt-oss on Groq does this) write their request for a tool or a file into
        // their thinking and put only a summary in the answer. When the answer asks for nothing and does
        // nothing, the requests found in the thinking are honoured - only look-ups, never a write or a command.
        const idle = !parsed.files.length && !parsed.edits.length && !parsed.deletes.length && !parsed.reads.length && !parsed.tools.length && !parsed.runs.length;
        if (idle && out.reasoning) {
          const thought = parseWorkerOutput(out.reasoning);
          parsed.tools = thought.tools;
          parsed.reads = thought.reads;
        }
        // <<<READ some_tool>>> for something that is a tool, not a file: it meant to call it.
        for (const name of parsed.reads.filter((read) => tools.some((tool) => tool.name === read))) {
          if (!parsed.tools.some((call) => call.name === name)) parsed.tools.push({ name, args: {}, invalid: false });
        }
        parsed.reads = parsed.reads.filter((read) => !tools.some((tool) => tool.name === read));

        for (const file of parsed.files) {
          if (file.stray) {
            problems.push(`the FILE block for ${file.path} had a stray ">>>" on its ${file.stray}, so it was NOT saved. Send the whole file again: <<<FILE ${file.path}>>> on its own line, the content, then <<<END>>> on its own line, with nothing else on those lines.`);
            continue;
          }
          await save(file.path, file.content).catch((err) => outcome.errors.push(err.message));
        }
        for (const edit of parsed.edits) {
          try {
            const file = await this.workspace.readFile(edit.path);
            if (file.binary || file.truncated) throw new Error(`${file.path} is too large or binary and cannot be edited`);
            if (edit.stray) {
              throw new Error(
                `the EDIT block for ${file.path} had text outside its SEARCH/REPLACE hunks, so NONE of it was applied. Every change needs its own complete hunk (<<<<<<< SEARCH, =======, >>>>>>> REPLACE). To add code at the end of the file, use a hunk whose SEARCH part is empty.`,
              );
            }
            if (!edit.hunks.length) throw new Error(`the EDIT block for ${file.path} contained no SEARCH/REPLACE hunk`);
            const { content, failed } = applyEdits(file.content, edit.hunks);
            if (failed.length) {
              // All or nothing per file: a half-applied edit is worse than none.
              throw new Error(
                `the EDIT of ${file.path} was NOT applied: the SEARCH text of hunk ${failed.join(', ')} does not occur in the file. Copy the lines exactly from the current content.`,
              );
            }
            await save(file.path, content);
          } catch (err) {
            problems.push(err.message);
          }
        }
        for (const file of parsed.deletes) {
          try {
            const { path: rel } = await this.workspace.deleteFile(file, { owner: cook, ...lockOpts });
            outcome.deleted.push(rel);
            writes += 1;
            outcome.written = outcome.written.filter((f) => f !== rel);
          } catch (err) {
            outcome.errors.push(err.message);
          }
        }
        if (parsed.summary) outcome.summary = parsed.summary;
        if (parsed.truncated) {
          // Two different mistakes look alike here, and telling a model the wrong one sends it down the wrong path.
          problems.push(
            out.finishReason === 'length'
              ? 'your answer ran out of room in the middle of a block, so that block was NOT saved. Send it again in smaller pieces: a short FILE block with the start of the file, then EDIT blocks with an empty SEARCH to append the rest. End every block with <<<END>>>.'
              : 'one of your blocks was not written in the required form, so it was NOT saved. A block starts with <<<FILE path>>> or <<<EDIT path>>> on a line of its own (three < and three >), and ends with <<<END>>> on a line of its own. Send that block again, whole.',
          );
        }

        // Asking again for what was already answered is the same mistake again (seen with a real model: a Fixer
        // asked seven times for a package.json that does not exist). Repeats are not served, and count as a mistake.
        // A command is a repeat only when nothing was written since it last ran: running the tests again after a
        // change is fair, running them again unchanged is not (a real Fixer ran the same check five times).
        const readKey = (p) => `read:${p.toLowerCase()}`;
        const toolKey = (c) => `tool:${c.name}:${JSON.stringify(c.args ?? {})}`;
        const runKey = (c) => `run:${c}@${writes}`;
        const repeats = [
          ...parsed.reads.filter((p) => served.has(readKey(p))),
          ...parsed.tools.filter((c) => served.has(toolKey(c))).map((c) => c.name),
          ...(exec ? parsed.runs.filter((c) => served.has(runKey(c))).map((c) => `"${clip(c, 40)}" (nothing changed since it ran)`) : []),
        ];
        parsed.reads = parsed.reads.filter((p) => !served.has(readKey(p)));
        parsed.tools = parsed.tools.filter((c) => !served.has(toolKey(c)));
        if (exec) parsed.runs = parsed.runs.filter((c) => !served.has(runKey(c)));
        if (repeats.length) {
          problems.push(`you asked again for ${repeats.slice(0, 3).join(', ')}, which was already answered above (if the answer said it does not exist, it does not). Do not ask again: use what you have and write the files.`);
        }
        // On a narrowed job, look-ups and commands are not served: the files come first.
        const asked = parsed.reads.length + parsed.tools.length + (exec ? parsed.runs.length : 0);
        const requests = narrow ? 0 : asked;
        if (narrow && asked) problems.push('not now: no tools, reads or commands until the files are written');
        // A cook that answers with words only, when the sub-task exists to produce files, has not done it yet.
        if (!requests && !problems.length && subtask.mustWrite && !outcome.written.length && !outcome.deleted.length) {
          problems.push(`you wrote none of the files this sub-task must produce (${subtask.files.join(', ')}). Send them now, each as a complete <<<FILE path>>> block ending with <<<END>>>${tools.length ? '. If you need information first, call a tool with a <<<TOOL name>>>{...}<<<END>>> block' : ''}.`);
        }
        // New files at paths of its own instead of the ones it was given (seen: calc.js asked, src/calc.js written,
        // so the next step's import failed). Said once; editing an existing file elsewhere is a fair correction of the plan.
        const named = new Set(subtask.files.map((f) => f.toLowerCase()));
        if (!requests && !problems.length && subtask.mustWrite && !elsewhereTold && outcome.written.length && !outcome.written.some((w) => named.has(w.toLowerCase())) && outcome.written.every((w) => created.includes(w))) {
          elsewhereTold = true;
          problems.push(`this sub-task must produce ${subtask.files.join(', ')}, but you created ${outcome.written.join(', ')} instead. Other steps use the paths in the plan: write ${subtask.files.join(', ')} at exactly that path, as a complete <<<FILE path>>> block.`);
        }
        strikes = problems.length ? strikes + 1 : 0;
        if (strikes >= BREAKER.stopAfter && !lastRound) {
          outcome.errors.push(...problems, `stopped early after ${strikes} rounds in a row with mistakes`);
          this.crew.think(cook, `\n[breaker] ${strikes} rounds in a row went wrong - this step stops here\n`);
          break;
        }
        if (strikes >= BREAKER.narrowAfter && !narrow && subtask.files.length) {
          narrow = true;
          problems.push(`NARROWER JOB from now on: send only the files of this sub-task (${subtask.files.join(', ')}), each WHOLE as one <<<FILE path>>> block ending with <<<END>>>. No EDIT blocks, no tools, no commands, no reads.`);
          this.crew.think(cook, '\n[breaker] two rounds in a row went wrong - the job is narrowed to whole files\n');
        }
        if (lastRound || (!requests && !problems.length)) {
          outcome.errors.push(...problems);
          break;
        }
        if (problems.length) {
          this.crew.think(cook, `\n[!] ${problems.join('\n[!] ')}\n`);
          extra += `### Problems with your previous answer - fix them now\n${problems.map((p) => `- ${p}`).join('\n')}\n\n`;
        }
        if (requests) {
          extra += await this.#fulfil(parsed, cook, signal, exec);
          for (const p of parsed.reads) served.add(readKey(p));
          for (const c of parsed.tools) served.add(toolKey(c));
          if (exec) for (const c of parsed.runs) served.add(runKey(c));
        }
      }

      const touched = outcome.written.length + outcome.deleted.length;
      // However the rounds ended (out of rounds, or still asking for things): no file means the sub-task is not done.
      if (subtask.mustWrite && !touched && !outcome.errors.length) outcome.errors.push(`none of its files were written (${subtask.files.join(', ')})`);
      outcome.ok = !outcome.errors.length && (touched > 0 || Boolean(outcome.summary));
      outcome.summary ||= touched ? `Wrote ${outcome.written.join(', ')}` : 'No output was produced';
      if (outcome.errors.length) outcome.summary = clip(`${outcome.summary} (${outcome.errors.join('; ')})`, 300);
    } catch (err) {
      // Aborts and provider exhaustion end the whole run; anything else only this sub-task.
      if (signal.aborted || err.name === 'DispatchError') throw err;
      outcome.summary = err.message;
    } finally {
      for (const handle of handles.reverse()) await handle.release();
    }
    return outcome;
  }

  /** Serve a worker's <<<READ>>>, <<<RUN>>> and <<<TOOL>>> requests. */
  async #fulfil(parsed, cook, signal, exec) {
    const parts = [];
    const reads = this.#paths(parsed.reads, 6);
    if (reads.length) {
      parts.push(
        (await this.#gather(reads))
          .map((f) => (f.missing ? `### ${f.path}\n(does not exist)` : `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``))
          .join('\n\n'),
      );
    }
    for (const command of exec ? parsed.runs.slice(0, 3) : []) {
      let result;
      try {
        this.crew.setState(cook, 'working', `Command: ${clip(command, 70)}`);
        const run = await this.runner.run(command, { owner: cook, signal });
        result = `exit code ${run.code}${run.timedOut ? ' (timed out)' : ''}\n${run.output || '(no output)'}`;
      } catch (err) {
        if (signal.aborted) throw err;
        // Denied or blocked: the cook is told, and carries on without it.
        result = `NOT RUN: ${err.message}`;
      }
      this.crew.think(cook, `\n$ ${command}\n${clip(result, 600)}\n`);
      parts.push(`### $ ${command}\n\`\`\`\n${result}\n\`\`\``);
    }
    for (const call of parsed.tools.slice(0, 4)) {
      let result;
      try {
        if (call.invalid) throw new Error('arguments were not valid JSON');
        // Checked here too, not only in the prompt: a model can name a tool it was never shown.
        if (!this.crew.mayUse(cook, groupOf(call.name))) throw new Error(`${this.crew.get(cook).name} has no access to the "${groupOf(call.name)}" connection`);
        result = await this.mcp.call(call.name, call.args);
      } catch (err) {
        result = `ERROR: ${err.message}`;
      }
      this.crew.think(cook, `\n[tool] ${call.name} -> ${clip(result, 200)}\n`);
      parts.push(`### Tool ${call.name}\n${clip(result, 4000)}`);
    }
    return `${parts.join('\n\n')}\n\n`;
  }

  /** Does this change touch sign-in, payments or personal data? Its paths, then its contents. */
  async #sensitive(paths) {
    if (paths.some((p) => SENSITIVE.test(p))) return true;
    return (await this.#gather(paths)).some((f) => !f.missing && SENSITIVE.test(f.content ?? ''));
  }

  async #review(objective, files, verification, signal, { focus = '' } = {}) {
    const out = await this.crew.call('head-chef', {
      task: focus === 'security' ? `Security check of ${files.length} changed file(s)` : `Reviewing ${files.length} changed file(s)`,
      system: focus === 'security' ? prompts.reviewerSystem + prompts.securityFocus : prompts.reviewerSystem,
      user: async () =>
        prompts.reviewerUser({
          memory: await this.memory.read(),
          objective,
          changed: (await this.#gather(files)).filter((f) => !f.missing),
          verification: verification?.ran ? verification : null,
        }),
      json: true,
      signal,
    });
    const parsed = extractJson(out.text);
    const raw = parsed ?? {};
    const issues = (Array.isArray(raw.issues) ? raw.issues : [])
      .filter((i) => i && typeof i === 'object' && i.problem)
      .slice(0, 8)
      .map((i) => ({ file: String(i.file ?? ''), problem: String(i.problem), fix: String(i.fix ?? '') }));
    // A failing check outranks an approving opinion.
    if (verification?.ran && !verification.ok && !issues.length) {
      issues.push({
        file: '',
        problem: `the verification command "${verification.command}" fails`,
        fix: `make it pass. Its output:\n${clip(verification.text, 1500)}`,
      });
    }
    const revise = issues.length > 0 && (raw.verdict === 'revise' || (verification?.ran && !verification.ok));
    return {
      verdict: revise ? 'revise' : 'approve',
      issues,
      summary: clip(String(raw.summary ?? (parsed ? 'no defects found' : 'review was inconclusive')), 200),
      // Facts about the project the Taster thinks are worth keeping (see journal.js). At most two.
      lessons: (Array.isArray(raw.lessons) ? raw.lessons : []).filter((l) => typeof l === 'string' && l.trim().length >= 12).slice(0, 2),
    };
  }

  // ----------------------------------------------------------------- context

  async #fileList() {
    const files = (await this.workspace.tree({ maxEntries: 400 })).filter((e) => e.type === 'file');
    const lines = files.slice(0, LISTED_FILES).map((f) => `${f.path} (${f.size} B)`);
    if (files.length > LISTED_FILES) lines.push(`… and ${files.length - LISTED_FILES} more`);
    return lines;
  }

  /** Read files for a prompt, sharing one character budget between them. */
  async #gather(paths) {
    if (!paths.length) return [];
    const perFile = Math.max(2000, Math.floor(this.limits.fileContextChars / paths.length));
    const out = [];
    for (const file of paths) {
      try {
        const data = await this.workspace.readFile(file);
        if (data.binary) out.push({ path: data.path, content: '(binary file)', truncated: true });
        else {
          const truncated = data.truncated || data.content.length > perFile;
          out.push({ path: data.path, content: truncated ? data.content.slice(0, perFile) : data.content, truncated });
        }
      } catch {
        out.push({ path: file, missing: true });
      }
    }
    return out;
  }
}
