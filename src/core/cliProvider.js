import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ProviderError, chatCompletion } from './providers.js';
import { anthropicCompletion } from './anthropic.js';
import { childEnv } from './runner.js';
import { estimateTokens, killTree } from './util.js';

/**
 * Subscription CLIs: coding agents the user already pays for and is signed in
 * to. Kadhai uses each one as a *model*, not as an agent: it is started for a
 * single answer, with its own tools switched off, in an empty temp folder, and
 * the prompt is fed on standard input. The reply comes back as text and goes
 * through the same parsers as any other model's, so the crew's rules (locks,
 * the Workspace sandbox, command approval) are untouched - the CLI never sees
 * the workspace and never edits a file itself.
 *
 *   args(ctx)  the fixed command line. Nothing a model or a file wrote goes in
 *              it: prompts travel on stdin (or in a temp file the CLI reads).
 *   input      'split'  the CLI takes the system prompt separately (a file)
 *              'joined' it has no such option, so system and user are one text
 *   terms      what the vendor's own terms say about a plan used this way, in one line, with
 *              the page it comes from (read 2026-10-21; these change, so re-read before
 *              relying on them). `risky` marks a vendor whose terms warn against it: the
 *              dashboard asks before switching it on.
 *   checked    how far each was verified, as in the connector catalog:
 *              'docs' = flags taken from the vendor's CLI reference, not yet
 *              run from Kadhai (none of the three was installed when written).
 */
export const CLI_AGENTS = {
  'claude-code': {
    label: 'Claude Code',
    command: ['claude'],
    plan: 'a Claude Pro or Max subscription',
    docs: 'https://code.claude.com/docs/en/cli-reference',
    signIn: 'claude auth login',
    terms: {
      text: 'Anthropic allows signing in to the unmodified Claude Code with your own plan. Plan limits assume ordinary, individual use.',
      url: 'https://code.claude.com/docs/en/legal-and-compliance',
    },
    input: 'split',
    checked: 'docs',
    // Print mode, our prompt instead of its own, no built-in or MCP tools, one turn, nothing saved.
    args: ({ systemFile, model }) => [
      '-p',
      '--system-prompt-file', systemFile,
      '--tools', '',
      '--strict-mcp-config',
      '--max-turns', '1',
      '--no-session-persistence',
      '--output-format', 'json',
      ...(model ? ['--model', model] : []),
    ],
    // { result, is_error, usage: { input_tokens, output_tokens } } - read tolerantly, in case the shape moves.
    read(stdout) {
      try {
        const data = JSON.parse(stdout);
        if (typeof data.result !== 'string') return null;
        const usage = data.usage && { prompt_tokens: data.usage.input_tokens, completion_tokens: data.usage.output_tokens };
        return { text: data.result, failed: data.is_error === true, usage: Number.isFinite(usage?.prompt_tokens) ? usage : null };
      } catch {
        return null;
      }
    },
  },
  codex: {
    label: 'Codex CLI',
    command: ['codex'],
    plan: 'a ChatGPT Plus or Pro subscription',
    docs: 'https://learn.chatgpt.com/docs/non-interactive-mode',
    signIn: 'codex login',
    terms: {
      text: "Your ChatGPT plan's terms apply to what Codex does for you. Read OpenAI's current Codex terms before relying on it.",
      url: 'https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan',
    },
    input: 'joined',
    checked: 'docs',
    // "exec -" reads the prompt from stdin, runs in its read-only sandbox by default, and prints only the final message.
    args: ({ model }) => ['exec', '--skip-git-repo-check', '--ephemeral', ...(model ? ['--model', model] : []), '-'],
  },
  'gemini-cli': {
    label: 'Gemini CLI',
    command: ['gemini'],
    plan: 'a Google account (it has a free allowance) or a Gemini subscription',
    docs: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md',
    signIn: 'gemini',
    terms: {
      text: "Google's Gemini CLI terms call using it through third-party tools a violation that can get the account suspended, and Gemini CLI was replaced for unpaid and Google One users on 18 June 2026. A Gemini API key (free tier) is the safe way to use Gemini here.",
      url: 'https://www.geminicli.com/docs/resources/tos-privacy',
      risky: true,
    },
    input: 'joined',
    checked: 'docs',
    // -p forces non-interactive mode and is appended to what arrives on stdin.
    args: ({ model }) => [...(model ? ['-m', model] : []), '--output-format', 'text', '-p', 'Answer the request above exactly as its instructions say.'],
  },
};

/** "Use whatever model the CLI is set to": the one default route of a subscription. */
export const CLI_DEFAULT_MODEL = 'default';
const MODEL_NAME = /^[\w.:/@-]{1,80}$/;
const MIN_TIMEOUT_MS = 5 * 60000; // a CLI answers in one piece, so there is no stream to keep the idle timer alive
const LIMIT_COOLDOWN_MS = 10 * 60000;

/** Is a program of this name on PATH? No process is started to find out. */
export function onPath(name) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      try {
        if (fs.statSync(path.join(dir, name + ext)).isFile()) return true;
      } catch {
        // Not here.
      }
    }
  }
  return false;
}

/**
 * What a failed CLI run means for its route. One place, like classify() for HTTP:
 *   rate_limit   the subscription's window is used up - cool down, use the next route
 *   unavailable  not installed or not signed in - off until the user fixes it
 *   server       anything else - a short cooldown
 */
export function classifyCli(output, spawnError = null) {
  if (spawnError) return 'unavailable';
  if (/usage limit|rate.?limit|quota|too many requests|limit (reached|exceeded)|\b429\b|overloaded/i.test(output)) return 'rate_limit';
  if (/not (logged|signed) in|please (log|sign) in|\/login\b|auth login|authenticat|unauthori[sz]ed|invalid.{0,20}(credential|api key|token)|\b401\b/i.test(output)) return 'unavailable';
  return 'server';
}

// Quote one word for cmd.exe the way programs read it back (the C runtime's rules): a quote is escaped,
// and the backslashes in front of it or at the very end are doubled - C:\dir\ would otherwise eat the closing quote.
const quoteWin = (arg) => (arg === '' || /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"` : arg);

export function launch(command, args, options) {
  // On Windows these CLIs are usually .cmd shims, which need a shell (as MCP servers do).
  if (process.platform === 'win32') return spawn([...command, ...args].map(quoteWin).join(' '), { ...options, shell: true, windowsHide: true });
  return spawn(command[0], [...command.slice(1), ...args], { ...options, detached: true });
}

/** One answer from a subscription CLI. Throws ProviderError, like chatCompletion. */
export async function cliCompletion(route, req, { signal, onDelta, timeoutMs = 60000 } = {}) {
  const agent = CLI_AGENTS[route.provider];
  if (!agent) throw new ProviderError(`${route.label} is not a known CLI`, { kind: 'unavailable' });
  const model = route.model === CLI_DEFAULT_MODEL ? '' : route.model;
  if (model && !MODEL_NAME.test(model)) throw new ProviderError(`"${model}" is not a model name ${agent.label} can be given`, { kind: 'not_found' });

  const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  let user = req.messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n\n');
  if (req.json) user += '\n\nReply with the JSON object only: no prose before or after it, no code fence.';

  // An empty folder of its own: whatever the CLI might try to read or write, the workspace is not there.
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kadhai-cli-'));
  try {
    const systemFile = path.join(dir, 'system.txt');
    if (agent.input === 'split') await fs.promises.writeFile(systemFile, system);
    const stdin = agent.input === 'split' ? user : `${system}\n\n---\n\n${user}`;

    const { code, stdout, stderr, spawnError, timedOut } = await new Promise((resolve) => {
      // Without the provider keys: a CLI that found ANTHROPIC_API_KEY or the like would bill the API, not the subscription.
      const child = launch(route.command ?? agent.command, agent.args({ systemFile, model }), { cwd: dir, env: childEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let late = false;
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        resolve({ stdout: out, stderr: err, timedOut: late, ...result });
      };
      const stop = () => killTree(child);
      const timer = setTimeout(() => {
        late = true;
        stop();
      }, Math.max(timeoutMs, MIN_TIMEOUT_MS));
      signal?.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (err = (err + chunk).slice(-4000)));
      child.once('error', (error) => finish({ code: -1, spawnError: error }));
      child.once('close', (exit) => finish({ code: exit ?? -1 }));
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    });

    signal?.throwIfAborted();
    if (timedOut) throw new ProviderError(`${route.label} did not answer in time`, { kind: 'timeout' });

    const parsed = code === 0 ? (agent.read?.(stdout) ?? { text: stdout, failed: false, usage: null }) : null;
    // cmd.exe reports a missing program in words, with exit code 1, rather than failing to start.
    const missing = Boolean(spawnError) || /is not recognized as an internal or external command|command not found|No such file or directory/i.test(stderr);
    if (!parsed || parsed.failed) {
      const said = `${parsed?.text ?? ''}\n${stderr}\n${stdout}`.trim();
      const kind = classifyCli(said, missing ? new Error('missing') : null);
      const why = missing
        ? `is not installed (the "${(route.command ?? agent.command)[0]}" command was not found)`
        : kind === 'unavailable'
          ? `is not signed in - run "${agent.signIn}" in a terminal`
          : kind === 'rate_limit'
            ? 'has reached its usage limit for now'
            : `failed (exit ${code}): ${said.replace(/\s+/g, ' ').slice(0, 200) || 'no output'}`;
      throw new ProviderError(`${route.label} ${why}`, { kind, retryAfterMs: kind === 'rate_limit' ? LIMIT_COOLDOWN_MS : null });
    }

    const text = parsed.text.trim();
    if (!text) throw new ProviderError(`${route.label} returned an empty answer`, { kind: 'empty' });
    // It arrives in one piece; the thought stream still gets to show it.
    onDelta?.({ type: 'text', text });
    return {
      text,
      reasoning: '',
      finishReason: 'stop',
      quota: null,
      usage: {
        promptTokens: parsed.usage?.prompt_tokens ?? estimateTokens(system + user),
        completionTokens: parsed.usage?.completion_tokens ?? estimateTokens(text),
        estimated: !parsed.usage,
      },
    };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The completion the dispatcher uses: a subscription CLI, the native Claude API, or the OpenAI dialect, per route. */
export const complete = (route, req, opts) =>
  route.kind === 'cli' ? cliCompletion(route, req, opts) : route.api === 'anthropic' ? anthropicCompletion(route, req, opts) : chatCompletion(route, req, opts);
