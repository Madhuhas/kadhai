import fs from 'node:fs';
import path from 'node:path';
import { ProviderError } from './providers.js';
import { CLI_AGENTS, CLI_DEFAULT_MODEL, classifyCli, launch } from './cliProvider.js';
import { childEnv } from './runner.js';
import { estimateTokens, killTree } from './util.js';

/**
 * High flame only: a subscription CLI as a real agent, not as a model. It works with its own
 * tools on, in a throwaway copy of the folder (see Orchestrator#subtaskAgent) - never in the
 * workspace itself. What it changed there is written back by the orchestrator through
 * Workspace, with the locks, the checkpoints and the review that every other change gets.
 *
 * `shell` is the operator's choice for that one run. Without it only a CLI that can switch its
 * own shell off acts as an agent (Claude Code: --tools leaves Bash out, and a -p run denies
 * anything that would ask); the others stay models, as on low flame. With it, the CLI runs
 * commands itself inside the copy, under its own permission system instead of Kadhai's
 * approval card. That is not a sandbox: a command can reach outside the copy.
 *
 *   args(ctx)  fixed flags only. The prompt goes on stdin; the system prompt in a temp file.
 *   events(o)  one parsed line of its JSON stream -> [{ kind: 'text' | 'tool' | 'result', ... }]
 *   checked    'docs': taken from the vendor's CLI reference; not yet run from Kadhai.
 */
export const AGENT_MODES = {
  'claude-code': {
    editsOnly: true,
    input: 'split',
    checked: 'docs',
    args: ({ systemFile, model, shell, maxTurns }) => [
      '-p',
      '--output-format', 'stream-json',
      '--verbose', // stream-json in print mode wants it
      // Its own system prompt stays (it carries the tool guidance); ours is added after it.
      '--append-system-prompt-file', systemFile,
      '--tools', shell ? 'Bash,Read,Edit,Write,Glob,Grep' : 'Read,Edit,Write,Glob,Grep',
      '--permission-mode', 'acceptEdits',
      ...(shell ? ['--allowedTools', 'Bash'] : []),
      // Nothing the folder brought may run: no project settings (hooks), no project MCP servers.
      '--setting-sources', 'user',
      '--strict-mcp-config',
      '--max-turns', String(maxTurns),
      '--no-session-persistence',
      ...(model ? ['--model', model] : []),
    ],
    events(o) {
      if (o.type === 'assistant') {
        return (o.message?.content ?? []).flatMap((block) =>
          block?.type === 'text' && block.text ? [{ kind: 'text', text: block.text }] : block?.type === 'tool_use' ? [{ kind: 'tool', name: String(block.name ?? 'tool'), detail: detailOf(block.input) }] : [],
        );
      }
      if (o.type === 'result') {
        const u = o.usage ?? {};
        return [
          {
            kind: 'result',
            text: typeof o.result === 'string' ? o.result : '',
            failed: o.is_error === true || (o.subtype && o.subtype !== 'success'),
            why: o.subtype === 'error_max_turns' ? 'it used up its turns' : null,
            usage: Number.isFinite(u.input_tokens) ? { promptTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0), completionTokens: u.output_tokens ?? 0 } : null,
          },
        ];
      }
      return [];
    },
  },
  codex: {
    editsOnly: false, // its shell is its main tool; there is no switch for edits alone
    input: 'joined',
    checked: 'docs',
    // The copy is not a git repository; workspace-write keeps its writes (and commands) to it.
    args: ({ model }) => ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--ephemeral', ...(model ? ['--model', model] : []), '-'],
    events(o) {
      const item = o.item ?? {};
      if (o.type === 'item.completed' && item.type === 'agent_message' && item.text) return [{ kind: 'text', text: item.text, final: true }];
      if (o.type === 'item.completed' && item.type === 'command_execution') return [{ kind: 'tool', name: 'shell', detail: String(item.command ?? '') }];
      if (o.type === 'item.completed' && item.type === 'file_change') return [{ kind: 'tool', name: 'edit', detail: (item.changes ?? []).map((c) => c?.path).filter(Boolean).join(', ') }];
      if (o.type === 'turn.completed') {
        const u = o.usage ?? {};
        return [{ kind: 'result', usage: Number.isFinite(u.input_tokens) ? { promptTokens: u.input_tokens, completionTokens: u.output_tokens ?? 0 } : null }];
      }
      if (o.type === 'turn.failed' || o.type === 'error') return [{ kind: 'error', text: String(o.error?.message ?? o.message ?? 'failed') }];
      return [];
    },
  },
  'gemini-cli': {
    editsOnly: false, // what auto_edit does with the shell tool without a terminal is not documented
    input: 'joined',
    checked: 'docs',
    args: ({ model }) => ['--output-format', 'stream-json', '--approval-mode', 'yolo', ...(model ? ['-m', model] : []), '-p', 'Do the task above in this folder, exactly as its instructions say.'],
    events(o) {
      if (o.type === 'message' && o.role === 'assistant' && o.content) return [{ kind: 'text', text: String(o.content), delta: Boolean(o.delta) }];
      if (o.type === 'tool_use') return [{ kind: 'tool', name: String(o.tool_name ?? 'tool'), detail: detailOf(o.parameters) }];
      if (o.type === 'result') {
        const s = o.stats ?? {};
        return [
          {
            kind: 'result',
            failed: o.status === 'error',
            text: '',
            usage: Number.isFinite(s.input_tokens) ? { promptTokens: s.input_tokens, completionTokens: s.output_tokens ?? 0 } : null,
          },
        ];
      }
      if (o.type === 'error') return [{ kind: 'error', text: String(o.message ?? 'error') }];
      return [];
    },
  },
};

const MODEL_NAME = /^[\w.:/@-]{1,80}$/;

/** The one line worth showing for a tool call: a path, a command or a pattern. */
function detailOf(input) {
  if (!input || typeof input !== 'object') return '';
  const value = input.file_path ?? input.path ?? input.absolute_path ?? input.command ?? input.pattern ?? input.query ?? '';
  return String(value).replace(/\s+/g, ' ').slice(0, 160);
}

/** Can this CLI act as an agent in this mode (edits only, or with its shell)? */
export const canAct = (provider, shell) => Boolean(AGENT_MODES[provider] && (shell || AGENT_MODES[provider].editsOnly));

/**
 * One step done by a CLI agent in `dir`. Resolves with what it said; throws ProviderError when
 * the CLI itself could not be used (not installed, not signed in, out of its limit), so the
 * caller can fall back to the ordinary cooks.
 *   onEvent({ kind: 'text' | 'tool', ... })  for the thought stream
 */
export async function runCliAgent(route, { system, user, dir, shell = false, signal, timeoutMs, maxTurns = 30, onEvent } = {}) {
  const agent = CLI_AGENTS[route.provider];
  const mode = AGENT_MODES[route.provider];
  if (!agent || !mode) throw new ProviderError(`${route.label} cannot work as an agent`, { kind: 'unavailable' });
  const model = route.model === CLI_DEFAULT_MODEL ? '' : route.model;
  if (model && !MODEL_NAME.test(model)) throw new ProviderError(`"${model}" is not a model name ${agent.label} can be given`, { kind: 'not_found' });

  // The system prompt sits beside the copy, not in it: the agent's file tools stay inside `dir`.
  const systemFile = path.join(path.dirname(dir), 'system.txt');
  if (mode.input === 'split') await fs.promises.writeFile(systemFile, system);
  const stdin = mode.input === 'split' ? user : `${system}\n\n---\n\n${user}`;

  const said = []; // what it wrote, in order: the answer when no result event carries one
  let result = null;
  let failure = '';
  const handle = (line) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // progress text between JSON lines
    }
    for (const event of mode.events(parsed) ?? []) {
      if (event.kind === 'result') result = { ...result, ...event, usage: event.usage ?? result?.usage ?? null };
      else if (event.kind === 'error') failure = event.text;
      else {
        // Streamed pieces of one message join up; whole messages are separate lines.
        if (event.kind === 'text' && event.delta && said.length) said[said.length - 1] += event.text;
        else if (event.kind === 'text') said.push(event.text);
        onEvent?.(event);
      }
    }
  };

  const { code, stderr, spawnError, timedOut } = await new Promise((resolve) => {
    const child = launch(route.command ?? agent.command, mode.args({ systemFile, model, shell, maxTurns }), { cwd: dir, env: childEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'] });
    let pending = '';
    let err = '';
    let late = false;
    let done = false;
    const finish = (outcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (pending.trim()) handle(pending.trim());
      resolve({ stderr: err, timedOut: late, ...outcome });
    };
    const stop = () => killTree(child);
    const timer = setTimeout(() => {
      late = true;
      stop();
    }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) if (line.trim()) handle(line.trim());
    });
    child.stderr.on('data', (chunk) => (err = (err + chunk).slice(-4000)));
    child.once('error', (error) => finish({ code: -1, spawnError: error }));
    child.once('close', (exit) => finish({ code: exit ?? -1 }));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });

  signal?.throwIfAborted();
  // Took too long: that is this step's failure, not the subscription's.
  if (timedOut) return { text: said.join('\n'), failed: true, why: `it did not finish within ${Math.round(timeoutMs / 60000)} minutes`, usage: usageOf(result, system, user, said) };

  const missing = Boolean(spawnError) || /is not recognized as an internal or external command|command not found|No such file or directory/i.test(stderr);
  // No result at all: the CLI never got to work (not installed, signed out, out of its limit, bad flag).
  if (missing || (!result && code !== 0)) {
    const text = `${failure}\n${stderr}`.trim();
    const kind = classifyCli(text, missing ? new Error('missing') : null);
    const why = missing
      ? `is not installed (the "${(route.command ?? agent.command)[0]}" command was not found)`
      : kind === 'unavailable'
        ? `is not signed in - run "${agent.signIn}" in a terminal`
        : kind === 'rate_limit'
          ? 'has reached its usage limit for now'
          : `failed (exit ${code}): ${text.replace(/\s+/g, ' ').slice(0, 200) || 'no output'}`;
    throw new ProviderError(`${route.label} ${why}`, { kind, retryAfterMs: kind === 'rate_limit' ? 10 * 60000 : null });
  }
  // It ran, but its turn ended badly: the work failed, the CLI is fine.
  const failed = Boolean(result?.failed) || Boolean(failure) || code !== 0;
  const text = (result?.text || said.join('\n')).trim();
  return { text, failed, why: failed ? (result?.why ?? (failure || `exit ${code}`)) : null, usage: usageOf(result, system, user, said) };
}

/** Its own count when it gave one; an estimate otherwise. */
function usageOf(result, system, user, said) {
  if (result?.usage) return { ...result.usage, estimated: false };
  return { promptTokens: estimateTokens(system + user), completionTokens: estimateTokens(said.join('\n')), estimated: true };
}
