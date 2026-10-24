import { RpcError } from './jsonrpc.js';
import { MEMORY_FILE } from '../core/workspace.js';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MEMORY_URI = 'kadhai://memory';
const OWNER = 'mcp-client';

const pathArg = { type: 'string', description: 'Workspace-relative file path, e.g. "src/app.js"' };
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

/**
 * Kadhai as an MCP server: any MCP client (Claude Desktop, Claude Code,
 * Cursor, ...) can hand tasks to the crew or work in the workspace directly.
 * Writes go through the same mutex as the agents, so nobody corrupts anybody.
 */
function buildTools(engine) {
  const { workspace, memory, locks, dispatcher, orchestrator, runner } = engine;
  return [
    {
      name: 'kadhai_run_task',
      description:
        'Give a coding task to the Kadhai crew (Chef plans, the kitchen codes, the Taster reviews). Blocks until the run finishes and returns the report.',
      inputSchema: schema({ task: { type: 'string', description: 'What to build or change, in plain language' } }, ['task']),
      run: async ({ task }) => {
        const result = await orchestrator.start(task, { source: 'mcp' }).done;
        return { text: result.reply, isError: !result.ok };
      },
    },
    {
      name: 'workspace_list_files',
      description: 'List every file in the Kadhai workspace with its size in bytes.',
      inputSchema: schema(),
      run: async () => {
        const files = (await workspace.tree()).filter((e) => e.type === 'file');
        return { text: files.map((f) => `${f.path}\t${f.size}`).join('\n') || '(empty workspace)' };
      },
    },
    {
      name: 'workspace_read_file',
      description: 'Read a text file from the workspace.',
      inputSchema: schema({ path: pathArg }, ['path']),
      run: async ({ path }) => {
        const file = await workspace.readFile(path);
        if (file.binary) return { text: `${file.path} is a binary file (${file.size} bytes)`, isError: true };
        return { text: file.truncated ? `${file.content}\n[truncated at 512 KB]` : file.content };
      },
    },
    {
      name: 'workspace_write_file',
      description:
        'Create or overwrite a workspace file atomically. Fails if an agent currently holds the lock on that file.',
      inputSchema: schema({ path: pathArg, content: { type: 'string', description: 'The complete new file content' } }, ['path', 'content']),
      run: async ({ path, content }) => {
        const { path: rel } = await workspace.writeFile(path, String(content ?? ''), { owner: OWNER, timeoutMs: 5000 });
        return { text: `Wrote ${rel}` };
      },
    },
    {
      name: 'workspace_delete_file',
      description: 'Delete a workspace file. Fails if the file is locked by an agent.',
      inputSchema: schema({ path: pathArg }, ['path']),
      run: async ({ path }) => {
        const { path: rel } = await workspace.deleteFile(path, { owner: OWNER, timeoutMs: 5000 });
        return { text: `Deleted ${rel}` };
      },
    },
    {
      name: 'workspace_run_command',
      description:
        'Run a shell command in the workspace folder and return its exit code and output. Subject to the operator\'s execution policy: it may need approval in the dashboard, or be switched off.',
      inputSchema: schema({ command: { type: 'string', description: 'A non-interactive command that finishes on its own, e.g. "node test.js"' } }, ['command']),
      run: async ({ command }) => {
        const result = await runner.run(command, { owner: OWNER });
        return { text: `exit code ${result.code}${result.timedOut ? ' (timed out)' : ''}\n${result.output}`, isError: result.code !== 0 };
      },
    },
    {
      name: 'memory_read',
      description: 'Read memory.md: the current objective, active file locks and last completed milestone.',
      inputSchema: schema(),
      run: async () => ({ text: await memory.read() }),
    },
    {
      name: 'locks_list',
      description: 'List the file locks currently held, and by whom.',
      inputSchema: schema(),
      run: async () => {
        const held = await locks.list();
        return { text: held.map((l) => `${l.path}\t${l.owner}`).join('\n') || 'No active locks.' };
      },
    },
    {
      name: 'providers_status',
      description: 'Show every LLM provider route, its status (active/ready/cooling/disabled) and token usage.',
      inputSchema: schema(),
      run: async () => ({ text: JSON.stringify(dispatcher.status(), null, 2) }),
    },
  ];
}

/** Returns { methods, notifications } ready to plug into a JsonRpcPeer (stdio or HTTP). */
export function createMcpServer(engine) {
  const tools = buildTools(engine);

  const methods = {
    initialize: ({ protocolVersion }) => ({
      protocolVersion: SUPPORTED_VERSIONS.includes(protocolVersion) ? protocolVersion : SUPPORTED_VERSIONS[0],
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'kadhai', title: 'Kadhai', version: engine.config.version },
      instructions:
        'Kadhai is a local multi-agent coding workspace. Use kadhai_run_task to delegate a whole task to the crew, or the workspace_* tools to read and write files yourself. Read memory_read first to see what the crew is doing.',
    }),

    ping: () => ({}),

    'tools/list': () => ({
      tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    }),

    'tools/call': async ({ name, arguments: args }) => {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new RpcError(-32602, `Unknown tool: ${name}`);
      try {
        const { text, isError = false } = await tool.run(args ?? {});
        return { content: [{ type: 'text', text }], isError };
      } catch (err) {
        // Tool failures are results the model can react to, not protocol errors.
        return { content: [{ type: 'text', text: err.message }], isError: true };
      }
    },

    'resources/list': () => ({
      resources: [
        {
          uri: MEMORY_URI,
          name: MEMORY_FILE,
          description: 'Kadhai handoff state: objective, active locks, last milestone',
          mimeType: 'text/markdown',
        },
      ],
    }),

    'resources/read': async ({ uri }) => {
      if (uri !== MEMORY_URI) throw new RpcError(-32002, `Resource not found: ${uri}`);
      return { contents: [{ uri, mimeType: 'text/markdown', text: await engine.memory.read() }] };
    },
  };

  return { methods, notifications: {} };
}
