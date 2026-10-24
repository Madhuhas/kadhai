import { createEngine } from './src/core/engine.js';
import path from 'node:path';
import { createApp, createPreviewApp } from './src/http/app.js';
import { Host } from './src/http/host.js';
import { DATA, ROOT } from './src/config.js';
import { Rooms, RoomsProxy } from './src/http/rooms.js';
import { fileURLToPath } from 'node:url';

// Started by the desktop app, this runs on Electron's own Node.js (ELECTRON_RUN_AS_NODE). Nothing we start
// should inherit that: a command the crew runs is ordinary, and a room asks for it itself (rooms.js).
delete process.env.ELECTRON_RUN_AS_NODE;

const mock = process.argv.includes('--mock') ? true : undefined;
// An extra room is this same program, started by the first one with "--room <id>" (see src/http/rooms.js).
const roomAt = process.argv.indexOf('--room');
const roomId = roomAt >= 0 ? process.argv[roomAt + 1] : null;
const roomsDir = process.env.KADHAI_ROOMS_DIR || path.join(DATA, 'rooms.local');
const roomFile = (suffix = '') => path.join(roomsDir, `${roomId}${suffix}.json`);
// The host owns "the engine in use"; opening another folder in the dashboard swaps it.
const host = await new Host({
  createEngine,
  options: {
    mock,
    watch: true,
    interactive: true,
    persist: true,
    triggers: true,
    flows: true,
    sealSecrets: true,
    watchKeys: true,
    // KADHAI_MCP=off: start none of the saved MCP servers (a throwaway copy for testing must not
    // start the user's connections - a sign-in one opens their browser).
    ...(process.env.KADHAI_MCP === 'off' ? { mcp: false } : {}),
    // A room's crew, flows and triggers are its own; keys, skills and MCP settings are shared with the first room.
    ...(roomId ? { agentsFile: roomFile('.agents'), flowsFile: roomFile('.flows'), triggersFile: roomFile('.triggers') } : {}),
  },
  settingsFile: roomId ? roomFile() : path.join(DATA, 'settings.local.json'),
  // Low or high flame is one choice for all rooms, kept here; a room may override it in its own file.
  globalSettingsFile: path.join(DATA, 'settings.local.json'),
}).start();
const { config } = host.engine;
host.roomId = roomId ?? 'main';
host.rooms = roomId
  ? new RoomsProxy({ lobby: process.env.KADHAI_LOBBY, id: roomId })
  : new Rooms({ root: ROOT, data: DATA, host, port: config.port, serverFile: fileURLToPath(import.meta.url), dir: roomsDir, mock: Boolean(mock) });

// Preview of the workspace on the next port: a separate origin from the dashboard.
const previewPort = config.port + 1;
const preview = createPreviewApp(host).listen(previewPort, config.host, () => {
  host.setPreviewUrl(`http://localhost:${previewPort}`);
});
preview.on('error', (err) => {
  console.error(`Preview disabled: port ${previewPort} is not available (${err.code}).`);
});

// "localhost" means ::1 to some clients (Node itself, for one) and 127.0.0.1 to others.
// Both are loopback-only, so listen on both; a machine without IPv6 simply skips the second.
const alsoOnIPv6 = (app, port) => app.listen(port, '::1').on('error', () => {});

const app = createApp(host);
const extraListeners = [alsoOnIPv6(app, config.port), alsoOnIPv6(createPreviewApp(host), previewPort)];
const server = app.listen(config.port, config.host, () => {
  const url = `http://localhost:${config.port}`;
  const { engine } = host;
  const routes = engine.dispatcher.routes;
  console.log(`
  \\___/  Kadhai v${config.version} is cooking

      Dashboard   ${url}
      MCP (HTTP)  ${url}/mcp
      Preview     http://localhost:${previewPort}
      Commands    EXEC_MODE=${engine.runner.mode}, sandbox: ${engine.runner.sandbox}${engine.runner.sandboxReady ? '' : ' (Docker NOT reachable - commands will be refused)'}
      Checkpoints ${engine.checkpoints.available ? 'on (undo and diff per run)' : 'off - git not found'}
      Workspace   ${engine.config.workspaceDir}
      Providers   ${
        config.mock
          ? 'MOCK MODE: simulated providers, no API calls'
          : routes.length
            ? `${routes.length} route(s): ${[...new Set(routes.map((r) => r.provider))].join(', ')}`
            : 'none yet. Add a free API key in the dashboard (the keys button)'
      }
`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Set PORT in .env to pick another one.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

// A local tool should survive an unexpected error in one request or event handler.
process.on('unhandledRejection', (reason) => console.error('[kadhai] unhandled rejection:', reason));

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.closeAllConnections?.();
  server.close();
  preview.close();
  for (const listener of extraListeners) listener.close();
  await host.close();
  process.exit(0);
}
// A room lives as long as the server that opened it: when that one goes, the pipe it holds to us closes.
// The desktop app holds the first server the same way, so quitting it shuts Kadhai down cleanly.
if (roomId || process.env.KADHAI_DESKTOP === '1') {
  process.stdin.on('end', shutdown).on('close', shutdown).on('error', shutdown);
  process.stdin.resume();
}
// The rooms that were open last time come back, each in its own process.
if (!roomId) host.rooms.start().catch((err) => console.error('[kadhai] rooms:', err.message));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
