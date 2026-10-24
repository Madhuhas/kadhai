// `npm start`: open the desktop app from the repository. VS Code (itself an Electron app) sets
// ELECTRON_RUN_AS_NODE in its terminals, which would start Electron as plain Node.js - so clear it.
const { spawn } = require('node:child_process');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
spawn(require('electron'), ['.', ...process.argv.slice(2)], { cwd: __dirname, env, stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 0));
