// main.js - standalone desktop shell for HOT-Step CPP.
//
// The upstream app is a local web server: a Node process on 127.0.0.1:3001
// serving a prebuilt React UI and spawning the C++ engine on 127.0.0.1:8085.
// This shell is the desktop app around it: it owns the server's lifetime, so
// there is no separate "start the server first" step and nothing is left
// running when the window closes.
//
// Installed layout (all under the package prefix):
//   /opt/hot-step-cpp/desktop/app/src/main.js   this file
//   /opt/hot-step-cpp/runtime/bin/node         the bundled Node runtime
//   /opt/hot-step-cpp/server/boot.mjs          launcher-aware server entry
//   /opt/hot-step-cpp/server/server.mjs        the server itself
//   /opt/hot-step-cpp/ui/dist                  the UI
//
// So PREFIX is two levels up from this file's directory.

'use strict';

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

// ── Paths ───────────────────────────────────────────────────────────────
const APP_DIR = path.resolve(__dirname, '..', '..');   // .../desktop/app/src
const PREFIX = path.resolve(APP_DIR, '..');           // /opt/hot-step-cpp
const NODE_BIN = path.join(PREFIX, 'runtime', 'bin', 'node');
const SERVER_ENTRY = path.join(PREFIX, 'server', 'boot.mjs');
const SYSTEM_CONFIG = '/etc/hot-step-cpp/hot-step.env';

const DEFAULT_PORT = 3001;
let serverPort = DEFAULT_PORT;

// ── System configuration ────────────────────────────────────────────────
// /etc/hot-step-cpp/hot-step.env is parsed rather than sourced, so values may
// contain spaces (a models folder like "/media/…/AceStep Music Models") and
// the root-owned file cannot execute anything. Must match /usr/bin/hot-step-server.
function parseSystemConfig() {
  const values = {};
  let text;
  try {
    text = fs.readFileSync(SYSTEM_CONFIG, 'utf8');
  } catch {
    return values;   // not installed by the package, or no overrides: fine
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (val.length > 1 && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    else if (val.length > 1 && val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
    values[key] = val;
  }
  return values;
}

// ── Server process ──────────────────────────────────────────────────────
let serverProcess = null;
let shuttingDown = false;
/** Set when the port is held by a process that is not ours. */
let portHolder = null;

function serverEnv() {
  const env = { ...process.env, ...parseSystemConfig(), HOT_STEP_ROOT: PREFIX };

  // The data-root subsystem (server/src/dataroot) defaults the data folder to
  // <parent of app>/HOT-Step-Data. Under /opt that is read-only and the app
  // refuses to start, so pin it to the Debian state directory. Must agree with
  // /usr/bin/hot-step and /usr/bin/hot-step-server.
  env.HOT_STEP_DATA_ROOT  = env.HOT_STEP_DATA_ROOT || '/var/lib/hot-step-cpp';
  // Keep the pointer that records the data location beside the data rather
  // than in $HOME, so a backup of the state directory is self-contained.
  env.HOT_STEP_PROFILE_DIR = env.HOT_STEP_PROFILE_DIR || '/var/lib/hot-step-cpp/profile';

  const port = env.SERVER_PORT;
  if (port && /^\d+$/.test(port)) serverPort = Number(port);
  // The shell talks to the server over loopback only; never let the embedded
  // webview end up pointed at a LAN address.
  env.SERVER_HOST = env.SERVER_HOST || '127.0.0.1';
  return env;
}

function isServerUp(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: 1500 },
      (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 500); },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ── Who owns the port? ─────────────────────────────────────────────────
// "Something answers on 3001" is not the same as "my server answers on 3001".
// Two HOT-Step installs on one machine is the normal way this happens: the user
// already has a portable copy running, the packaged one starts, cannot bind,
// dies on EADDRINUSE, and the splash spins with no explanation. So resolve the
// listening socket to a PID via /proc (no external tools) and decide whether
// that PID is us — this process, a child of it, or our own server.

/** Socket inode of the LISTEN entry for 127.0.0.1:<port>, or null. */
function listenInode(port) {
  const target = port.toString(16).toUpperCase().padStart(4, '0');
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10) continue;
      const [, local, , st] = f;
      if (st !== '0A') continue;                       // TCP_LISTEN
      if (!local.endsWith(':' + target)) continue;
      return f[9];                                     // inode column
    }
  }
  return null;
}

/** PID holding a listening socket, by matching its /proc/<pid>/fd symlinks. */
function pidListeningOn(port) {
  const inode = listenInode(port);
  if (!inode) return null;
  const target = `socket:[${inode}]`;
  let pids;
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return null; }
  for (const pid of pids) {
    let fds;
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link;
      try { link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      if (link === target) return Number(pid);
    }
  }
  return null;
}

/** True when `pid` is us or a descendant of us. */
function isOurProcess(pid) {
  if (pid === process.pid) return true;
  let cur = pid;
  for (let hop = 0; hop < 12 && cur > 1; hop++) {
    let status;
    try { status = fs.readFileSync(`/proc/${cur}/status`, 'utf8'); } catch { return false; }
    const ppid = Number(/^PPid:\s*(\d+)/m.exec(status)?.[1] ?? 0);
    if (!ppid) return false;
    if (ppid === process.pid) return true;
    cur = ppid;
  }
  return false;
}

/** A short, human description of whoever holds the port. */
function describePortHolder(port) {
  const pid = pidListeningOn(port);
  if (!pid) return null;
  let cmd = '';
  try {
    cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch { /* unreadable, e.g. another user */ }
  // The install root is what tells the user *which* copy is squatting.
  const root = /HOT_STEP_ROOT=([^\0]*)/.exec(
    (() => { try { return fs.readFileSync(`/proc/${pid}/environ`, 'utf8'); } catch { return ''; } })(),
  )?.[1];
  const where = root ? ` (HOT_STEP_ROOT=${root})` : '';
  return `pid ${pid}${where}${cmd ? `\n    ${cmd}` : ''}`;
}

/**
 * Start the Node server, unless one of *ours* is already listening. Returns
 * 'already-running' | 'started' | 'port-taken' | 'failed'.
 */
async function ensureServer(env) {
  if (serverProcess) return 'already-running';

  if (await isServerUp(serverPort) || pidListeningOn(serverPort)) {
    const pid = pidListeningOn(serverPort);
    if (!pid || isOurProcess(pid)) return 'already-running';
    portHolder = describePortHolder(serverPort) || `another process (pid ${pid})`;
    return 'port-taken';
  }

  if (!fs.existsSync(NODE_BIN) || !fs.existsSync(SERVER_ENTRY)) {
    return 'failed';
  }

  serverProcess = spawn(NODE_BIN, [SERVER_ENTRY], {
    cwd: PREFIX,
    env,
    // 'inherit', not 'pipe': the server already tees its own output into
    // /var/lib/hot-step-cpp/logs/<session>/node_console.log, so relaying it
    // here would only duplicate every line in the terminal. With inherit, the
    // output reaches a terminal when there is one and is simply discarded when
    // the app was started from the desktop menu.
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  serverProcess.on('exit', (code, signal) => {
    serverProcess = null;
    if (shuttingDown) return;
    dialog.showErrorBox(
      'HOT-Step CPP',
      `The application server stopped unexpectedly (${signal || `exit code ${code}`}).\n\n` +
      'Check the log for details, then start the app again.',
    );
    app.quit();
  });

  // Wait for it to answer. The engine spawn and DB init take a few seconds on
  // a cold start, so allow generous headroom before showing the splash.
  for (let i = 0; i < 120; i++) {
    if (await isServerUp(serverPort)) return 'started';
    if (!serverProcess) return 'failed';   // it died on the way up
    await new Promise((r) => setTimeout(r, 500));
  }
  return 'failed';
}

function stopServer() {
  if (!serverProcess) return Promise.resolve();
  const proc = serverProcess;
  serverProcess = null;
  return new Promise((resolve) => {
    const kill = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 8000);
    proc.once('exit', () => { clearTimeout(kill); resolve(); });
    // SIGTERM lets the app close its SQLite handle and stop the engine cleanly.
    try { proc.kill('SIGTERM'); } catch { clearTimeout(kill); resolve(); }
  });
}

// ── Windows ─────────────────────────────────────────────────────────────
let mainWindow = null;

function splashWindow() {
  const win = new BrowserWindow({
    width: 560,
    height: 260,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    backgroundColor: '#0b0b10',
    icon: path.join(APP_DIR, 'icon', 'hot-step-cpp.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
    <!doctype html><meta charset="utf-8">
    <style>
      html,body{margin:0;height:100%;background:#0b0b10;color:#e8e6f0;
        font:14px/1.5 system-ui,"Ubuntu",sans-serif;
        display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px}
      .bar{width:220px;height:3px;background:#241f33;border-radius:2px;overflow:hidden}
      .bar i{display:block;width:40%;height:100%;border-radius:2px;
        background:linear-gradient(90deg,#f97316,#d946ef);animation:s 1.1s ease-in-out infinite}
      @keyframes s{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
      .t{font-size:17px;font-weight:600;letter-spacing:.02em}
      .s{color:#8b879b;font-size:12px}
    </style>
    <div class="t">HOT-Step CPP</div>
    <div class="bar"><i></i></div>
    <div class="s">Starting the local engine&hellip;</div>`));
  win.setMenuBarVisibility(false);
  return win;
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0b10',
    title: 'HOT-Step CPP',
    icon: path.join(APP_DIR, 'icon', 'hot-step-cpp.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadURL(`http://127.0.0.1:${serverPort}/`);

  // The app is a local tool; anything that wants a new window (external docs,
  // a Hugging Face model page) belongs in the user's real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Same for navigation away from our own origin.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${serverPort}`)) {
      event.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  win.on('closed', () => { mainWindow = null; });
  return win;
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Reload UI',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow?.reload(),
        },
        {
          label: 'Open in Browser',
          click: () => shell.openExternal(`http://127.0.0.1:${serverPort}/`),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: 'Quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Logs and Settings',
          click: () => shell.openPath('/var/lib/hot-step-cpp'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Lifecycle ───────────────────────────────────────────────────────────
// One instance only: a second copy would find the port taken and then fight
// over the same SQLite file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('org.hotstep.cpp');   // groups the window on Wayland
    buildMenu();

    // Resolve the config *before* anything looks at the port. serverEnv() is
    // what reads SERVER_PORT out of /etc/hot-step-cpp/hot-step.env, and the
    // port-conflict check below has to test the port the app will really use,
    // not the built-in default. Calling it once here also means the child
    // spawn gets the same environment object rather than rebuilding it.
    const env = serverEnv();

    const splash = splashWindow();
    const result = await ensureServer(env);

    if (result === 'port-taken') {
      const message =
        `Port ${serverPort} is already in use by another program, so this app cannot start.\n\n` +
        `Held by:\n    ${portHolder}\n\n` +
        'That is usually a second HOT-Step CPP — a portable copy, or another user on this ' +
        'machine. Stop it and try again, or give this install a different port:\n\n' +
        `    sudo nano ${SYSTEM_CONFIG}\n    SERVER_PORT=${serverPort + 1}\n\n` +
        'Then run hot-step again.';
      // Also to stderr: started from a terminal there may be no one to click
      // the dialog, and a silent exit is the worst possible diagnostic.
      console.error(`\n[HOT-Step CPP] ${message}\n`);
      dialog.showErrorBox('HOT-Step CPP', message);
      splash.destroy();
      app.quit();
      return;
    }

    if (result === 'failed') {
      const detail = !fs.existsSync(NODE_BIN)
        ? `The bundled Node runtime is missing from ${PREFIX}.\nThe package looks incomplete.`
        : `The application server did not come up on port ${serverPort}.\n\n` +
          'See /var/lib/hot-step-cpp/logs for the full output.';
      dialog.showErrorBox('HOT-Step CPP', detail);
      await stopServer();
      app.quit();
      return;
    }

    mainWindow = createMainWindow();
    splash.destroy();
    mainWindow.show();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', async (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    await stopServer();
    app.quit();
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { shuttingDown = true; stopServer().finally(() => process.exit(0)); });
  }
}