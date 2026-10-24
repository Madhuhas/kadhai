# Kadhai desktop app (beta)

Kadhai in a window of its own, with an installer, a Start-menu entry and an icon. Inside it is exactly the app you get with `npm start`: the same local server, the same dashboard, the same safety rules. Electron only provides the window.

This folder is separate on purpose. Electron is about 150 MB, and Kadhai itself stays small: `npm start` in the main folder never downloads it, and the main app keeps `express` as its only dependency.

## Try it from the repository

```bash
npm install            # in the main Kadhai folder, once
cd desktop
npm install            # downloads Electron and electron-builder (only needed for the desktop app)
npm start              # opens Kadhai in its own window
```

Started from the repository, the app uses the files in the main folder (`keys.local.json`, `settings.local.json` and the rest), so it shows the same keys, crew and flows as `npm start`. If a Kadhai server is already running on port 4747, the window simply connects to it and leaves it running when you close the window.

## Build the installer

```bash
cd desktop
npm run build          # writes dist/Kadhai-Beta-Setup-<version>.exe
npm run build:dir      # just the unpacked app in dist/win-unpacked, quicker for a test
```

The installer is not code-signed, so Windows SmartScreen warns about an unknown publisher the first time (*More info*, then *Run anyway*). Signing needs a paid certificate; it can be added later.

## How it works

- **The server** is the main folder's `server.js`, copied into the app (`resources/kadhai`) and run with Electron's own Node.js (`ELECTRON_RUN_AS_NODE`), so nothing else needs installing.
- **Your files** go in the app's data folder, `%APPDATA%\Kadhai Beta`: keys, settings, agents, flows, credentials, your skills and the default workspace. The server learns where through `KADHAI_DATA`. The app's own folder is never written to. *Help > Show the data folder* opens it.
- **Quitting** closes the server's stdin, and the server shuts down cleanly, as a kitchen does when the first server goes. If a run is still going, you are asked first.
- **One window per computer:** starting it again brings the open window forward.

## Safety

- The window loads only `http://localhost:4747`. A link anywhere else opens in your normal browser (web addresses only), and so does the preview of what the crew built.
- The page has no access to Node.js and runs sandboxed. Every permission request (camera, microphone, location, notifications) is refused, except copying to the clipboard.
- Everything the browser version promises still holds, because it is the same server: local only, one folder, commands wait for you, secrets encrypted.

## The icon

`build/icon.png` is drawn from `build/icon.html`: the `\___/` mark with steam, in text like the rest of Kadhai. It is the one picture Kadhai has, used only for the window, the taskbar and the installer, never inside the app. To redraw it after changing the HTML:

```bash
chrome --headless=new --default-background-color=00000000 --window-size=512,512 --screenshot=build/icon.png build/icon.html
```
