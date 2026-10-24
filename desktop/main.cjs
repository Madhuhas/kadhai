// Kadhai as a desktop app. The app is the same local server as `npm start`; this file only gives it
// a window of its own. It starts the server (or uses one that is already running), shows the
// dashboard, and shuts the server down cleanly when the app quits.
//
// Safety: the window loads only http://localhost:<port>. Every other address opens in the system
// browser (http and https only) or is refused; the page gets no Node.js and runs sandboxed; every
// permission request (camera, microphone, location...) is refused except copying to the clipboard.
const { app, BrowserWindow, Menu, dialog, session, shell } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 4747;
const ORIGIN = `http://localhost:${PORT}`;
// Packaged: the server ships in resources/kadhai and the user's files go in the app's data folder
// (an installed app's own folder is not writable). From the repository: both are the repository itself.
const CODE = app.isPackaged ? path.join(process.resourcesPath, 'kadhai') : path.resolve(__dirname, '..');
const DATA = process.env.KADHAI_DATA || (app.isPackaged ? app.getPath('userData') : '');
const ICON = app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(__dirname, 'build', 'icon.png');
const BETA = /-beta/.test(app.getVersion()) ? ' (beta)' : '';

let server = null; // the server we started, if we did
let win = null;
let quitting = false;

/** Is a Kadhai server answering on our port? */
async function alive() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/about`, { signal: AbortSignal.timeout(1000) });
    return res.ok && (await res.json()).name === 'Kadhai';
  } catch {
    return false;
  }
}

/** Start the server with Electron's own Node.js, unless one is already running. Resolves when it answers. */
async function startServer() {
  if (await alive()) return; // `npm start` is already running: use it, and leave it running when we quit
  const logFile = path.join(DATA || CODE, 'desktop-server.log');
  if (DATA) fs.mkdirSync(DATA, { recursive: true });
  const log = fs.createWriteStream(logFile, { flags: 'w' });
  server = spawn(process.execPath, [path.join(CODE, 'server.js')], {
    cwd: CODE,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', KADHAI_DESKTOP: '1', ...(DATA ? { KADHAI_DATA: DATA } : {}) },
    // stdin stays open: when we close it, the server shuts down cleanly (server.js watches it).
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  let exited = null;
  server.once('exit', (code) => {
    exited = code ?? 'signal';
    server = null;
    if (!quitting && win) {
      dialog.showErrorBox('Kadhai stopped', `The Kadhai server stopped (exit ${exited}). Details are in:\n${logFile}`);
      app.quit();
    }
  });
  for (let i = 0; i < 120; i++) {
    if (exited !== null) break;
    if (await alive()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-6).join('\n') : '';
  throw new Error(`Kadhai could not start${exited !== null ? ` (exit ${exited})` : ''}.\n\n${tail}\n\nFull log: ${logFile}`);
}

/** Ask the server to stop (by closing its stdin), and make sure it does. */
function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    const child = server;
    const force = setTimeout(() => {
      // On Windows a plain kill leaves grandchildren running: take the whole tree down.
      if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => resolve());
      else {
        child.kill('SIGKILL');
        resolve();
      }
    }, 6000);
    child.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    child.stdin.end();
  });
}

/** Is the crew in the middle of a run? (Asked before quitting, so a run is not cut off by accident.) */
async function cooking() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/state`, { signal: AbortSignal.timeout(1500) });
    const state = await res.json();
    return Boolean(state.run) || (state.agents ?? []).some((a) => a.state === 'working');
  } catch {
    return false;
  }
}

const isOurs = (url) => {
  try {
    return new URL(url).origin === ORIGIN;
  } catch {
    return false;
  }
};

/** Anything that is not the dashboard opens in the system browser - web addresses only. */
function openOutside(url) {
  try {
    if (['http:', 'https:'].includes(new URL(url).protocol)) shell.openExternal(url);
  } catch {
    // not an address: ignore it
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 760,
    minHeight: 520,
    title: `Kadhai${BETA}`,
    icon: ICON,
    backgroundColor: '#e6e6e6',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  win.once('ready-to-show', () => win.show());
  // Keep the title ours (the page sets its own) so the taskbar always says what this is.
  win.on('page-title-updated', (e) => e.preventDefault());

  win.webContents.on('will-navigate', (e, url) => {
    if (isOurs(url)) return;
    e.preventDefault();
    openOutside(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url); // the preview, a link in the chat, a sign-in page: the system browser
    return { action: 'deny' };
  });

  win.on('close', async (e) => {
    if (quitting || !server) return; // a server we did not start is not ours to worry about
    e.preventDefault();
    if (await cooking()) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Keep cooking', 'Quit anyway'],
        defaultId: 0,
        cancelId: 0,
        title: 'The crew is cooking',
        message: 'A run is still going.',
        detail: 'Quitting stops it halfway. Changes already made stay, and the run can be undone from its report.',
      });
      if (response === 0) return;
    }
    quitting = true;
    win.destroy();
  });

  win.loadURL(ORIGIN);
}

function menu() {
  // Hidden until Alt is pressed; it gives the usual shortcuts (copy, paste, zoom, reload).
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'fileMenu' },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
      },
      {
        label: 'Help',
        submenu: [
          { label: 'Open in your browser', click: () => shell.openExternal(ORIGIN) },
          { label: 'Show the data folder', enabled: Boolean(DATA), click: () => shell.openPath(DATA) },
        ],
      },
    ]),
  );
}

// One Kadhai window per computer: a second start brings the first one forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => done(permission === 'clipboard-sanitized-write'));
    menu();
    try {
      await startServer();
    } catch (err) {
      dialog.showErrorBox('Kadhai could not start', err.message);
      quitting = true;
      await stopServer();
      app.quit();
      return;
    }
    createWindow();
  });

  app.on('window-all-closed', async () => {
    quitting = true;
    await stopServer();
    app.quit();
  });
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', (e) => {
    if (!server) return;
    e.preventDefault();
    stopServer().then(() => app.quit());
  });
}
