import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { killTree } from './util.js';

export const EXEC_MODES = ['ask', 'auto', 'off'];

export class ExecError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ExecError';
    this.status = status;
  }
}

const CAPTURE_CAP = 200000;
const APPROVAL_TIMEOUT_MS = 5 * 60000;
const OUTPUT_FLUSH_MS = 100;
const MAX_COMMAND_CHARS = 2000;

/**
 * A seatbelt, not a sandbox: obviously catastrophic commands are refused when
 * they come from an agent. Real protection is the approval step (EXEC_MODE=ask).
 */
const BLOCKED = [
  /\brm\s+-[a-z]*[rf][a-z]*\s+(-[a-z]+\s+)*["']?(\/|~|\$HOME|[a-z]:[\\/]?)["']?(\s|$)/i,
  /\b(mkfs|diskpart|shutdown|reboot|halt|poweroff)\b/i,
  /\bformat\s+[a-z]:/i,
  /\b(rd|rmdir|del|erase)\b.*\s\/s\b.*\s["']?([a-z]:[\\/]|[\\/]|%\w+%)/i,
  /\breg(\.exe)?\s+(delete|add)\b/i,
  /:\(\)\s*\{.*\}\s*;\s*:/,
  /\b(curl|wget|iwr|invoke-webrequest)\b[^|]*\|\s*(sh|bash|zsh|iex|powershell|pwsh|cmd)\b/i,
];

// Child processes never inherit the provider keys (or other obvious secrets).
const SECRET_ENV = /(^|_)(API_?KEYS?|KEYS?|TOKENS?|SECRETS?|PASSWORD|PASSWD|PAT|CREDENTIALS?)$/i;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})(\/[^\s'"<>)]*)?/i;

/**
 * The first address on this computer a program printed ("Local: http://localhost:5173/"),
 * as http(s)://localhost:<port>/..., or null. Colour codes are removed first: dev servers
 * print the port in bold.
 */
export function findLocalUrl(text) {
  const match = LOCAL_URL.exec(String(text).replace(ANSI, ''));
  if (!match) return null;
  const port = Number(match[1]);
  if (port < 1 || port > 65535) return null;
  const scheme = match[0].toLowerCase().startsWith('https') ? 'https' : 'http';
  return `${scheme}://localhost:${port}${match[2] ?? '/'}`;
}

// Commands the shell itself answers, so they are never "not installed".
const BUILTINS = new Set([
  'cd', 'echo', 'set', 'exit', 'type', 'dir', 'cls', 'copy', 'del', 'erase', 'move', 'ren', 'rename', 'md', 'mkdir', 'rd', 'rmdir',
  'pushd', 'popd', 'start', 'call', 'title', 'ver', 'vol', 'path', 'prompt', 'mklink', 'assoc', 'if', 'for', 'rem', 'pause', 'clear',
  'export', 'source', 'alias', 'unset', 'pwd', 'true', 'false', 'test', 'read', 'eval', 'exec', 'which', 'command',
]);
const pathCache = new Map(); // name -> { found, at }
const PATH_CACHE_MS = 60000;

/**
 * Is this program installed? Looks for it in the PATH folders (with PATHEXT on Windows)
 * and never runs anything. Names with anything but letters, digits and ._+- are refused.
 */
export function onPath(name, env = process.env) {
  const text = String(name ?? '').toLowerCase();
  if (!/^[\w.+-]{1,64}$/.test(text)) return false;
  if (BUILTINS.has(text)) return true;
  const cached = pathCache.get(text);
  if (cached && Date.now() - cached.at < PATH_CACHE_MS) return cached.found;
  const windows = process.platform === 'win32';
  const exts = windows ? ['', ...String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(Boolean)] : [''];
  const dirs = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  let found = false;
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        if (fs.statSync(path.join(dir, text + ext)).isFile()) found = true;
      } catch {
        // not here
      }
      if (found) break;
    }
    if (found) break;
  }
  pathCache.set(text, { found, at: Date.now() });
  return found;
}

function clipMiddle(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max / 3);
  const tail = max - head;
  return `${text.slice(0, head)}\n… [${text.length - max} characters omitted] …\n${text.slice(-tail)}`;
}

/**
 * How a command is actually launched.
 *   none   - through the host shell, with the operator's own permissions
 *   docker - inside a throwaway container that can see only the workspace
 *            (mounted at /workspace), with no network by default and capped
 *            memory, CPU and process count
 */
/** The environment a command runs in. */
export const childEnv = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => !SECRET_ENV.test(key)));

export function spawnSpec({ sandbox, command, cwd, id, image, network, dir = '' }) {
  if (sandbox !== 'docker') return { file: command, args: [], shell: true };
  return {
    file: 'docker',
    args: [
      'run', '--rm', '--name', `kadhai-${id}`,
      '--network', network,
      '--memory', '1g', '--cpus', '1', '--pids-limit', '256',
      '--security-opt', 'no-new-privileges',
      '-v', `${cwd}:/workspace`, '-w', dir ? `/workspace/${dir}` : '/workspace',
      image, 'sh', '-c', command,
    ],
    shell: false,
  };
}

/**
 * Runs shell commands inside the workspace folder.
 *
 * Modes: "ask"  - agent commands wait for the operator to approve them
 *        "auto" - agent commands run immediately (blocklist still applies)
 *        "off"  - nothing runs
 * Commands typed by the operator themselves ("trusted") skip approval.
 * Every command has a hard timeout and its whole process tree is killed on
 * timeout, on stop, or when the run is aborted.
 */
export class Runner {
  #pending = new Map();
  #running = new Map();

  constructor({ cwd, bus, limits, interactive = false }) {
    this.cwd = cwd;
    this.bus = bus;
    this.mode = EXEC_MODES.includes(limits.execMode) ? limits.execMode : 'ask';
    this.timeoutMs = limits.execTimeoutMs;
    this.keepMax = limits.keepRunning ?? 3;
    this.outputChars = limits.execOutputChars;
    this.sandbox = limits.execSandbox === 'docker' ? 'docker' : 'none';
    this.image = limits.execDockerImage;
    this.network = limits.execDockerNetwork;
    this.sandboxReady = this.sandbox === 'none';
    // interactive: a dashboard is attached that can answer approval requests.
    this.interactive = interactive;
    // Optional async (request, signal) => boolean; lets ACP ask the editor instead.
    this.approver = null;
  }

  /** With EXEC_SANDBOX=docker, confirm the Docker daemon is actually reachable. */
  async init() {
    if (this.sandbox !== 'docker') return;
    this.sandboxReady = await new Promise((resolve) => {
      execFile('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 8000, windowsHide: true }, (err) => resolve(!err));
    });
  }

  /** What a cook is told it is typing into. */
  get shellName() {
    if (this.sandbox === 'docker') return `sh inside a Linux container (${this.image}); the workspace is the current folder`;
    return process.platform === 'win32' ? 'Windows cmd.exe' : 'sh';
  }

  get enabled() {
    return this.mode !== 'off';
  }

  view() {
    return {
      mode: this.mode,
      sandbox: this.sandbox,
      sandboxReady: this.sandboxReady,
      timeoutMs: this.timeoutMs,
      pending: [...this.#pending.values()].map((p) => p.request),
      running: [...this.#running.values()].map((r) => r.info),
    };
  }

  setMode(mode) {
    if (!EXEC_MODES.includes(mode)) throw new ExecError(`Mode must be one of: ${EXEC_MODES.join(', ')}`);
    this.mode = mode;
    this.bus?.publish('exec:mode', { mode });
    // Switching to auto answers whatever is waiting; switching off refuses it.
    if (mode !== 'ask') for (const id of [...this.#pending.keys()]) this.#settle(id, mode === 'auto');
  }

  /** Throws if this command may not run at all. Cheap and synchronous. */
  check(command, { trusted = false } = {}) {
    const text = String(command ?? '').trim();
    if (!text) throw new ExecError('The command is empty');
    if (text.length > MAX_COMMAND_CHARS) throw new ExecError('The command is too long');
    if (!this.enabled) throw new ExecError('Command execution is switched off (EXEC_MODE=off)', 403);
    // Never fall back to the host silently: the operator asked for isolation.
    if (!this.sandboxReady) {
      throw new ExecError('EXEC_SANDBOX=docker is set, but Docker is not running. Start Docker, or set EXEC_SANDBOX=none.', 503);
    }
    if (!trusted && BLOCKED.some((pattern) => pattern.test(text))) {
      throw new ExecError('Blocked: this command looks destructive to the system', 403);
    }
    return text;
  }

  async #approve(request, signal) {
    if (this.approver) return this.approver(request, signal);
    if (!this.interactive) {
      throw new ExecError('This command needs operator approval, but no dashboard is attached. Set EXEC_MODE=auto to allow it.', 403);
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.#settle(request.id, false);
        reject(signal.reason);
      };
      const timer = setTimeout(() => this.#settle(request.id, false), APPROVAL_TIMEOUT_MS);
      this.#pending.set(request.id, {
        request,
        finish: (approved) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(approved);
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.bus?.publish('exec:request', request);
    });
  }

  #settle(id, approved) {
    const pending = this.#pending.get(id);
    if (!pending) return false;
    this.#pending.delete(id);
    this.bus?.publish('exec:resolved', { ...pending.request, approved });
    pending.finish(approved);
    return true;
  }

  approve(id) {
    return this.#settle(id, true);
  }

  deny(id) {
    return this.#settle(id, false);
  }

  #stop(job) {
    // Killing the docker client does not stop the container, so stop that first.
    if (job.container) spawn('docker', ['kill', job.container], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    killTree(job.child);
  }

  kill(id) {
    const job = this.#running.get(id);
    if (!job) return false;
    job.killed = true;
    this.#stop(job);
    return true;
  }

  killAll() {
    for (const id of [...this.#pending.keys()]) this.#settle(id, false);
    for (const id of [...this.#running.keys()]) this.kill(id);
  }

  /** Throws if a command may not keep running: only the operator's, a few at a time, not in the sandbox. */
  checkKeep({ trusted = false } = {}) {
    if (!trusted) throw new ExecError('Only a command you type yourself can keep running', 403);
    // The container has no network and no published ports, so a server in it could not be reached.
    if (this.sandbox === 'docker') throw new ExecError('Commands cannot keep running inside the Docker sandbox', 400);
    const kept = [...this.#running.values()].filter((job) => job.info.keep).length;
    if (kept >= this.keepMax) throw new ExecError(`${kept} commands are already kept running - stop one first`, 429);
  }

  /**
   * Run one command to completion.
   * Resolves with { id, command, code, output, timedOut, killed, durationMs };
   * rejects with ExecError if it was refused, denied, or could not start.
   *
   * keep: a dev server or a watcher - no time limit, output kept as a rolling tail,
   * and the first address on this computer it prints is announced (exec:port).
   * It still stops on "stop", when the engine closes, or when the run is aborted.
   */
  async run(command, { owner = 'user', trusted = false, signal, dir = '', keep = false } = {}) {
    const text = this.check(command, { trusted });
    if (keep) this.checkKeep({ trusted });
    signal?.throwIfAborted();
    // "dir" is a folder inside the workspace (already checked by the caller), '' for the workspace itself.
    const info = { id: crypto.randomUUID().slice(0, 8), command: text, owner, dir, ...(keep ? { keep: true } : {}) };

    if (!trusted && this.mode === 'ask') {
      const approved = await this.#approve(info, signal);
      if (!approved) throw new ExecError('The operator denied this command', 403);
    }

    return new Promise((resolve, reject) => {
      const started = Date.now();
      const env = childEnv(process.env);
      const spec = spawnSpec({ sandbox: this.sandbox, command: text, cwd: this.cwd, id: info.id, image: this.image, network: this.network, dir });
      const child = spawn(spec.file, spec.args, {
        // In the sandbox the container is told where to work; on the host the process starts there.
        cwd: this.sandbox === 'docker' || !dir ? this.cwd : path.join(this.cwd, dir),
        env,
        shell: spec.shell,
        windowsHide: true,
        detached: process.platform !== 'win32', // own process group, so the tree can be killed
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const job = { child, info: { ...info, startedAt: started }, killed: false, container: this.sandbox === 'docker' ? `kadhai-${info.id}` : null };
      this.#running.set(info.id, job);
      this.bus?.publish('exec:start', job.info);

      let output = '';
      let buffer = '';
      let flushTimer = null;
      let timedOut = false;
      const flush = () => {
        flushTimer = null;
        if (buffer) this.bus?.publish('exec:output', { id: info.id, chunk: buffer });
        buffer = '';
      };
      let tail = ''; // the last bit of output, so an address split across two chunks is still found
      const onData = (data) => {
        let chunk = data.toString('utf8');
        if (keep) {
          // A server talks for hours: keep streaming, and keep only the newest output.
          output = (output + chunk).slice(-CAPTURE_CAP);
          if (!job.info.url) {
            tail = (tail + chunk).slice(-600);
            const url = findLocalUrl(tail);
            if (url) {
              job.info.url = url;
              this.bus?.publish('exec:port', { id: info.id, owner, command: text, url });
            }
          }
        } else {
          if (output.length >= CAPTURE_CAP) return;
          chunk = chunk.slice(0, CAPTURE_CAP - output.length);
          output += chunk;
        }
        buffer += chunk;
        flushTimer ??= setTimeout(flush, OUTPUT_FLUSH_MS);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);

      const timer = keep
        ? null
        : setTimeout(() => {
            timedOut = true;
            this.#stop(job);
          }, this.timeoutMs);
      const onAbort = () => {
        job.killed = true;
        this.#stop(job);
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      let finished = false;
      const finish = (code, failure) => {
        // A process that fails to start can report both "error" and "close".
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(flushTimer);
        flush();
        signal?.removeEventListener('abort', onAbort);
        this.#running.delete(info.id);
        if (timedOut) output += `\n[killed: exceeded the ${Math.round(this.timeoutMs / 1000)}s time limit]`;
        else if (job.killed) output += '\n[killed by operator]';
        const result = {
          ...info,
          code,
          timedOut,
          killed: job.killed,
          durationMs: Date.now() - started,
          output: clipMiddle(output.replace(/\r\n/g, '\n').trimEnd(), this.outputChars),
        };
        this.bus?.publish('exec:end', result);
        if (failure) reject(failure);
        else resolve(result);
      };
      child.once('error', (err) => {
        output += `could not start: ${err.message}`;
        finish(-1, new ExecError(`Could not start the command: ${err.message}`, 500));
      });
      child.once('close', (code) => finish(code ?? -1));
    });
  }
}
