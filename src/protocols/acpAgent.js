import path from 'node:path';
import crypto from 'node:crypto';
import { RpcError, stdioPeer } from './jsonrpc.js';
import { VERSION } from '../config.js';
import { log } from '../core/util.js';

const PROTOCOL_VERSION = 1;
const PLAN_STATUS = { pending: 'pending', working: 'in_progress', done: 'completed', failed: 'completed', skipped: 'completed' };

/** Flatten ACP content blocks into the plain-text task the Chef expects. */
function promptText(blocks = []) {
  return blocks
    .map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'resource' && block.resource?.text != null) {
        return `\n[Attached ${block.resource.uri}]\n${block.resource.text}`;
      }
      if (block.type === 'resource_link') return `[Referenced file: ${block.uri}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Kadhai as an Agent Client Protocol agent: ACP-capable editors (Zed and
 * friends) launch this over stdio and drive the crew from their own agent
 * panel. Each session works in the folder the editor passes as `cwd`.
 */
export function startAcpAgent({ createEngine, input, output, engineOptions = {} }) {
  const sessions = new Map();
  const engines = new Map(); // one engine per folder, shared by its sessions

  async function engineFor(cwd) {
    const key = path.resolve(cwd);
    if (!engines.has(key)) {
      const starting = createEngine({ ...engineOptions, workspaceDir: key, mcp: false });
      engines.set(key, starting);
      // A folder that failed to open may work next time (a lock went away, git was installed).
      starting.catch(() => engines.delete(key));
    }
    return engines.get(key);
  }

  const session = (id) => {
    const found = sessions.get(id);
    if (!found) throw new RpcError(-32602, `Unknown session: ${id}`);
    return found;
  };

  const methods = {
    initialize: () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
      },
      agentInfo: { name: 'kadhai', title: 'Kadhai', version: VERSION },
      authMethods: [],
    }),

    authenticate: () => ({}),

    'session/new': async ({ cwd, mcpServers = [] }) => {
      if (!cwd || !path.isAbsolute(cwd)) throw new RpcError(-32602, 'session/new requires an absolute "cwd"');
      const engine = await engineFor(cwd);
      // Editor-provided MCP servers become tools for the cooks.
      for (const server of mcpServers) {
        if (server.command) engine.mcp.connect(server.name ?? 'mcp', server);
      }
      const sessionId = `sess_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      sessions.set(sessionId, { engine, cwd: path.resolve(cwd), run: null });
      return { sessionId };
    },

    'session/prompt': async ({ sessionId, prompt }) => {
      const current = session(sessionId);
      const { engine } = current;
      const task = promptText(prompt);
      if (!task) throw new RpcError(-32602, 'The prompt has no text content');

      const update = (body) => peer.notify('session/update', { sessionId, update: body });
      const text = (value) => ({ type: 'text', text: value });

      // Translate engine events into ACP session updates for the editor UI.
      const unsubscribe = engine.bus.subscribe(({ type, data }) => {
        if (type === 'agent:thought') {
          update({ sessionUpdate: 'agent_thought_chunk', content: text(data.delta) });
        } else if (type === 'run:plan') {
          update({
            sessionUpdate: 'plan',
            entries: data.subtasks.map((s) => ({
              content: s.title,
              priority: 'medium',
              status: PLAN_STATUS[s.status] ?? 'pending',
            })),
          });
        } else if (type === 'fs:write') {
          update({
            sessionUpdate: 'tool_call',
            toolCallId: `call_${crypto.randomUUID().slice(0, 8)}`,
            title: `${data.deleted ? 'Delete' : 'Write'} ${data.path}`,
            kind: data.deleted ? 'delete' : 'edit',
            status: 'completed',
            locations: [{ path: path.join(current.cwd, data.path) }],
          });
        } else if (type === 'exec:start') {
          update({ sessionUpdate: 'tool_call', toolCallId: `exec_${data.id}`, title: `Run ${data.command}`, kind: 'execute', status: 'in_progress' });
        } else if (type === 'exec:end') {
          update({
            sessionUpdate: 'tool_call_update',
            toolCallId: `exec_${data.id}`,
            status: data.code === 0 ? 'completed' : 'failed',
            content: [{ type: 'content', content: text(`exit code ${data.code}\n${data.output}`) }],
          });
        } else if (type === 'provider:swap') {
          update({ sessionUpdate: 'agent_thought_chunk', content: text(`\n[hot-swap ${data.from} -> ${data.to}]\n`) });
        }
      });

      // In an editor the approval question goes to the editor, not the dashboard.
      engine.runner.approver = async (request) => {
        const answer = await peer.request(
          'session/request_permission',
          {
            sessionId,
            toolCall: { toolCallId: `exec_${request.id}`, title: `Run ${request.command}`, kind: 'execute', status: 'pending', rawInput: { command: request.command } },
            options: [
              { optionId: 'allow', name: 'Run it', kind: 'allow_once' },
              { optionId: 'reject', name: 'Do not run', kind: 'reject_once' },
            ],
          },
          { timeoutMs: 5 * 60000 },
        );
        return answer?.outcome?.outcome === 'selected' && answer.outcome.optionId === 'allow';
      };

      try {
        let run;
        try {
          run = engine.orchestrator.start(task, { source: 'acp' });
        } catch (err) {
          throw new RpcError(-32603, err.message);
        }
        current.run = run;
        const result = await run.done;
        if (result.error !== 'CANCELLED') update({ sessionUpdate: 'agent_message_chunk', content: text(result.reply) });
        return { stopReason: run.abort.signal.aborted || result.error === 'CANCELLED' ? 'cancelled' : 'end_turn' };
      } finally {
        current.run = null;
        engine.runner.approver = null;
        unsubscribe();
      }
    },
  };

  const notifications = {
    'session/cancel': ({ sessionId }) => {
      const current = sessions.get(sessionId);
      // cancel() handles both cases: stop it if it is running, drop it if it is still queued.
      if (current?.run) current.engine.orchestrator.cancel(current.run.id);
    },
  };

  const peer = stdioPeer({
    methods,
    notifications,
    input,
    output,
    onClose: async () => {
      for (const pending of engines.values()) {
        await pending.then((engine) => engine.close()).catch(() => {});
      }
      process.exit(0);
    },
  });

  log.info(`ACP agent ready (protocol v${PROTOCOL_VERSION})`);
  return peer;
}
