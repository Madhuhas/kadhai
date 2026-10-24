import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { JsonRpcPeer, readLines, lineWriter } from './jsonrpc.js';
import { clip, killTree, log } from '../core/util.js';
import { vaultFor } from '../core/vault.js';

const PROTOCOL_VERSION = '2025-06-18';
const SIGN_IN_WAITING = 'the sign-in was not finished - press Sign in to open it again';
const STARTUP_TIMEOUT_MS = 90000; // "npx -y ..." may have to download the server first
const NAME = /^[\w.-]{1,40}$/;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
// Quote one word for cmd.exe the way programs read it back (the C runtime's rules): a quote is escaped,
// and the backslashes in front of it or at the very end are doubled - C:\dir\ would otherwise eat the closing quote.
const quoteWin = (arg) => (/[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"` : arg);

/**
 * Split a typed command line into words. Quotes (single or double) group
 * words and may appear mid-word, as in --dir="C:\My Files". Backslashes are
 * left alone on purpose: on Windows they are path separators, not escapes.
 */
export function splitCommand(line) {
  const words = [];
  let word = '';
  let quote = null;
  let started = false; // lets "" count as an (empty) word
  for (const ch of String(line ?? '')) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (word || started) words.push(word);
      word = '';
      started = false;
    } else {
      word += ch;
    }
  }
  if (word || started) words.push(word);
  return words;
}

/**
 * MCP client hub: launches stdio MCP servers and offers their tools to the
 * cooks. Servers are listed in mcp.config.json (the same shape Claude Desktop
 * uses) and can be added, removed and restarted from the dashboard while the
 * app is running. A server that fails to start is reported, never fatal.
 */
export class McpHub {
  #servers = new Map();

  constructor({ configPath, bus, version }) {
    this.configPath = configPath;
    this.bus = bus;
    this.version = version;
  }

  async #readConfig() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.configPath, 'utf8'));
      const servers = parsed.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {};
      // Settings hold tokens, so their values are encrypted in the file; plain ones (typed by hand) are read as they are.
      const vault = vaultFor(this.configPath);
      for (const spec of Object.values(servers)) {
        if (spec?.env && !Array.isArray(spec.env)) spec.env = Object.fromEntries(Object.entries(spec.env).map(([name, value]) => [name, vault.decrypt(String(value))]));
      }
      return { ...parsed, mcpServers: servers };
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`mcp.config.json ignored: ${err.message}`);
      return { mcpServers: {} };
    }
  }

  async #writeConfig(config) {
    const vault = vaultFor(this.configPath);
    const sealed = Object.fromEntries(
      Object.entries(config.mcpServers).map(([name, spec]) => [
        name,
        spec?.env && !Array.isArray(spec.env) ? { ...spec, env: Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [key, vault.encrypt(String(value))])) } : spec,
      ]),
    );
    await fs.writeFile(this.configPath, `${JSON.stringify({ ...config, mcpServers: sealed }, null, 2)}\n`, { mode: 0o600 });
  }

  async loadConfig() {
    const { mcpServers } = await this.#readConfig();
    await Promise.all(
      Object.entries(mcpServers).map(([name, spec]) => {
        if (spec.disabled) {
          this.#servers.set(name, this.#entry(name, spec, { saved: true, status: 'off' }));
          return null;
        }
        // A sign-in that was never finished: starting it would open a browser tab on every start
        // (mcp-remote has no way to stop that). It waits for the user to press "Sign in".
        if (spec.needsSignIn) {
          this.#servers.set(name, { ...this.#entry(name, spec, { saved: true, status: 'signin' }), error: SIGN_IN_WAITING });
          return null;
        }
        return this.connect(name, spec, { saved: true });
      }),
    );
    this.#changed();
  }

  /** Remember (or forget) in mcp.config.json that this server's sign-in was not finished. */
  async #markSignIn(name, needed) {
    const config = await this.#readConfig();
    const spec = config.mcpServers[name];
    if (!spec || Boolean(spec.needsSignIn) === needed) return;
    if (needed) spec.needsSignIn = true;
    else delete spec.needsSignIn;
    await this.#writeConfig(config);
  }

  #entry(name, spec, { saved = false, status = 'connecting' } = {}) {
    return { name, spec, saved, status, error: null, tools: [], child: null, peer: null, lastLog: '', signInUrl: null };
  }

  /** spec: { command, args?, env? } - env as an object, or ACP's [{ name, value }] list. */
  async connect(name, spec, { saved = false } = {}) {
    const safeName = name.replace(/[^\w.-]/g, '_');
    if (this.#servers.get(safeName)?.status === 'ready') return;
    const server = this.#entry(safeName, spec, { saved });
    this.#servers.set(safeName, server);
    this.#changed();

    try {
      if (!spec.command) throw new Error('only stdio servers ("command") are supported');
      const extraEnv = Array.isArray(spec.env)
        ? Object.fromEntries(spec.env.map((e) => [e.name, e.value]))
        : (spec.env ?? {});
      const env = { ...process.env, ...extraEnv };
      const args = (spec.args ?? []).map(String);
      const stdio = ['pipe', 'pipe', 'pipe'];
      // On Windows launchers such as npx are .cmd shims and need a shell.
      const child =
        process.platform === 'win32'
          ? spawn([spec.command, ...args].map(quoteWin).join(' '), { env, stdio, shell: true, windowsHide: true })
          : spawn(spec.command, args, { env, stdio });
      server.child = child;
      // stderr is the server's log. Keep the last line (the likeliest reason for a failure), and the
      // sign-in page a bridged connector asks for, in case the browser did not open by itself.
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        const lines = chunk.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (lines.length) server.lastLog = clip(lines.at(-1), 200);
        const url = server.status === 'connecting' && /authoriz/i.test(chunk) && chunk.match(/https:\/\/[^\s"'<>]+/)?.[0];
        if (url && url !== server.signInUrl) {
          server.signInUrl = url;
          this.#changed();
        }
      });
      child.stderr.on('error', () => {});

      const peer = new JsonRpcPeer({ send: lineWriter(child.stdin), methods: { ping: () => ({}) } });
      server.peer = peer;
      readLines(child.stdout, (message) => {
        peer.receive(message);
      });
      const exited = new Promise((_, reject) => {
        child.once('error', (err) => reject(new Error(`could not start: ${err.message}`)));
        child.once('exit', (code) => {
          peer.close('MCP server exited');
          // Only a server that was up and then died is reported here; one we shut down ourselves is already gone.
          if (this.#servers.get(safeName) === server && server.status === 'ready') {
            server.status = 'error';
            server.error = `stopped unexpectedly (exit ${code})`;
            server.tools = [];
            this.#changed();
          }
          reject(new Error(`it stopped (exit ${code})${server.lastLog ? `: ${server.lastLog}` : ' — check the command'}`));
        });
      });
      exited.catch(() => {});
      child.stdin.on('error', () => {});

      await Promise.race([
        exited,
        (async () => {
          await peer.request(
            'initialize',
            { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'kadhai', version: this.version } },
            { timeoutMs: spec.startupTimeoutMs ?? STARTUP_TIMEOUT_MS },
          );
          peer.notify('notifications/initialized');
          const { tools = [] } = await peer.request('tools/list', {});
          server.tools = tools.map((tool) => ({
            name: `${safeName}__${tool.name}`,
            remoteName: tool.name,
            description: clip(String(tool.description ?? '').replace(/\s+/g, ' '), 140),
            params: Object.keys(tool.inputSchema?.properties ?? {}),
          }));
        })(),
      ]);
      server.status = 'ready';
      server.signInUrl = null;
      log.info(`MCP server "${safeName}" ready with ${server.tools.length} tool(s)`);
      if (saved && spec.needsSignIn) {
        delete spec.needsSignIn;
        await this.#markSignIn(safeName, false).catch((e) => log.warn(`mcp.config.json not updated: ${e.message}`));
      }
    } catch (err) {
      // If it was stopped or removed while starting, that is not a failure to report.
      if (this.#servers.get(safeName) === server && server.status === 'connecting') {
        // It asked for a sign-in and did not get one: from now on it waits for "Sign in" instead
        // of opening the browser by itself on every start.
        const askedToSignIn = Boolean(server.signInUrl);
        server.status = askedToSignIn ? 'signin' : 'error';
        const waitedForSignIn = askedToSignIn || spec.startupTimeoutMs > STARTUP_TIMEOUT_MS;
        server.error = waitedForSignIn ? SIGN_IN_WAITING : !/timed out/.test(err.message) ? err.message : 'no answer — is this really an MCP server?';
        server.signInUrl = null;
        log.warn(`MCP server "${safeName}" failed: ${server.error}`);
        if (askedToSignIn && saved) {
          spec.needsSignIn = true;
          await this.#markSignIn(safeName, true).catch((e) => log.warn(`mcp.config.json not updated: ${e.message}`));
        }
      }
      killTree(server.child);
    }
    this.#changed();
  }

  #stop(server) {
    server.status = 'off';
    server.tools = [];
    server.peer?.close('stopped');
    // The whole tree: on Windows the child is the shell that launched the server, not the server.
    killTree(server.child);
    server.child = null;
  }

  #get(name) {
    const server = this.#servers.get(name);
    if (!server) throw fail('No such MCP server', 404);
    return server;
  }

  // ------------------------------------------------- managed from the dashboard

  /** Add a server, remember it in mcp.config.json, and start it. */
  async add({ name, command, env, startupTimeoutMs, wait = true }) {
    const clean = String(name ?? '').trim();
    if (!NAME.test(clean)) throw fail('Give it a short name: letters, digits, dots, dashes or underscores');
    if (this.#servers.has(clean)) throw fail(`There is already a server called "${clean}"`, 409);
    const words = Array.isArray(command) ? command.map(String) : splitCommand(command);
    if (!words.length) throw fail('Type the command that starts the server, e.g. npx -y @modelcontextprotocol/server-memory');
    const spec = { command: words[0], args: words.slice(1) };
    if (startupTimeoutMs) spec.startupTimeoutMs = startupTimeoutMs;
    if (env && typeof env === 'object' && Object.keys(env).length) {
      spec.env = Object.fromEntries(Object.entries(env).map(([k, v]) => [String(k).trim(), String(v)]).filter(([k]) => k));
    }

    const config = await this.#readConfig();
    config.mcpServers[clean] = spec;
    await this.#writeConfig(config);
    // connect() never rejects: a failure ends up in the server's status.
    const started = this.connect(clean, spec, { saved: true });
    if (wait) await started;
    return this.status().find((s) => s.name === clean);
  }

  async remove(name) {
    const server = this.#get(name);
    this.#stop(server);
    this.#servers.delete(name);
    if (server.saved) {
      const config = await this.#readConfig();
      delete config.mcpServers[name];
      await this.#writeConfig(config);
    }
    this.#changed();
    return { removed: name };
  }

  async restart(name) {
    const server = this.#get(name);
    this.#stop(server);
    this.#servers.delete(name);
    await this.connect(name, server.spec, { saved: server.saved });
    return this.status().find((s) => s.name === name);
  }

  /** Switch a server off without forgetting it, or back on. */
  async setEnabled(name, enabled) {
    const server = this.#get(name);
    if (server.saved) {
      const config = await this.#readConfig();
      if (config.mcpServers[name]) {
        if (enabled) delete config.mcpServers[name].disabled;
        else config.mcpServers[name].disabled = true;
        await this.#writeConfig(config);
      }
    }
    if (!enabled) {
      this.#stop(server);
      this.#changed();
      return this.status().find((s) => s.name === name);
    }
    return this.restart(name);
  }

  #changed() {
    this.bus?.publish('mcp:update', { servers: this.status() });
  }

  status() {
    return [...this.#servers.values()].map((s) => ({
      name: s.name,
      status: s.status, // connecting | ready | error | off | signin (a sign-in to finish; not started until asked)
      error: s.error,
      signInUrl: s.status === 'connecting' ? s.signInUrl : null,
      saved: s.saved,
      // The command is shown so you can tell servers apart; env values may hold secrets and are never sent.
      command: [s.spec.command, ...(s.spec.args ?? [])].join(' '),
      envKeys: Array.isArray(s.spec.env) ? s.spec.env.map((e) => e.name) : Object.keys(s.spec.env ?? {}),
      tools: s.tools.map((t) => ({ name: t.name, description: t.description, params: t.params })),
    }));
  }

  tools() {
    return [...this.#servers.values()].filter((s) => s.status === 'ready').flatMap((s) => s.tools);
  }

  async call(qualifiedName, args = {}) {
    for (const server of this.#servers.values()) {
      const tool = server.tools.find((t) => t.name === qualifiedName);
      if (!tool) continue;
      const result = await server.peer.request(
        'tools/call',
        { name: tool.remoteName, arguments: args },
        { timeoutMs: 60000 },
      );
      const text = (result.content ?? [])
        .map((part) => (part.type === 'text' ? part.text : `[${part.type}]`))
        .join('\n');
      return result.isError ? `ERROR: ${text}` : text;
    }
    throw new Error(`unknown tool "${qualifiedName}"`);
  }

  close() {
    for (const server of this.#servers.values()) this.#stop(server);
    this.#servers.clear();
  }
}
