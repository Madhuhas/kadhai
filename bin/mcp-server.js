#!/usr/bin/env node
// Kadhai as a Model Context Protocol server over stdio.
// Usage:  node bin/mcp-server.js [--workspace <dir>] [--mock]
import { createEngine } from '../src/core/engine.js';
import { createMcpServer } from '../src/protocols/mcpServer.js';
import { stdioPeer } from '../src/protocols/jsonrpc.js';
import { log } from '../src/core/util.js';

const args = process.argv.slice(2);
const workspaceAt = args.indexOf('--workspace');
const overrides = { mcp: false, sealSecrets: true };
if (workspaceAt >= 0 && args[workspaceAt + 1]) overrides.workspaceDir = args[workspaceAt + 1];
if (args.includes('--mock')) overrides.mock = true;

const engine = await createEngine(overrides);
stdioPeer({
  ...createMcpServer(engine),
  onClose: async () => {
    await engine.close();
    process.exit(0);
  },
});
log.info(`MCP server ready on stdio — workspace: ${engine.config.workspaceDir}`);
