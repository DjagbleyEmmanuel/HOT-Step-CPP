// dataroot/bootstrap.ts — Decide the data root before anything else loads.
//
// config.ts imports RUNTIME from here, so this module is evaluated before any
// module that opens SQLite, log files or the engine. In dev (no HOT_STEP_ROOT)
// it does nothing and every path keeps its checkout default. In a release it
// picks the root (HOT_STEP_DATA_ROOT, profile pointer, this app's old layout,
// then <parent of app>/HOT-Step-Data), runs a pending move/import/migration,
// and on any failure serves one plain page and never lets the app start.

import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';
import { parse as dotenvParse } from 'dotenv';
import {
  DEFAULT_DATA_FOLDER, LOCK_FILE, POINTER_FILE, RESTART_MARKER_FILE,
  dataLayout, initLayout, isDataLayout, isEmptyDir, legacyMappings, inspectLegacy, profileDir, readPointer, writePointer,
  type Pointer,
} from './paths.js';
import { planOperation, runPending } from './transfer.js';

export interface Runtime {
  mode: 'dev' | 'release';
  /** Release only: the unpacked app folder (HOT_STEP_ROOT). */
  appRoot: string | null;
  dataRoot: string | null;
  profileDir: string | null;
  pointerPath: string | null;
  /** Set when HOT_STEP_DATA_ROOT chose the root. */
  override: string | null;
  envPath: string | null;
  logsDir: string | null;
  restartMarkerPath: string | null;
  libraryDir: string | null;
  modelsDir: string | null;
  adaptersDir: string | null;
  whisperDir: string | null;
  runtimeLibDir: string | null;
  userPluginsDir: string | null;
}

const DEV: Runtime = {
  mode: 'dev', appRoot: null, dataRoot: null, profileDir: null, pointerPath: null, override: null, envPath: null,
  logsDir: null, restartMarkerPath: null, libraryDir: null, modelsDir: null, adaptersDir: null, whisperDir: null,
  runtimeLibDir: null, userPluginsDir: null,
};

export type Resolution = { ok: true; runtime: Runtime } | { ok: false; error: string; pointerPath: string | null };

function release(appRoot: string, root: string, prof: string, override: string | null): Runtime {
  const l = dataLayout(root);
  return {
    mode: 'release', appRoot, dataRoot: l.root, profileDir: prof, pointerPath: path.join(prof, POINTER_FILE), override,
    envPath: l.envPath, logsDir: l.logs, restartMarkerPath: path.join(prof, RESTART_MARKER_FILE), libraryDir: l.library,
    modelsDir: l.models, adaptersDir: l.adapters, whisperDir: l.whisperDir, runtimeLibDir: l.runtimeLibDir, userPluginsDir: l.plugins,
  };
}

/** Exclusive lock beside the pointer; a lock whose PID is gone is cleared. */
function withLock<T>(prof: string, fn: () => T): T {
  const lock = path.join(prof, LOCK_FILE);
  fs.mkdirSync(prof, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (e: any) {
      if (e.code !== 'EEXIST' || attempt > 0) throw new Error(`another HOT-Step is moving data (lock ${lock})`);
      const pid = parseInt(fs.readFileSync(lock, 'utf-8'), 10);
      let alive = false;
      try { if (pid) { process.kill(pid, 0); alive = true; } } catch (k: any) { alive = k.code === 'EPERM'; }
      if (alive) throw new Error(`another HOT-Step (PID ${pid}) is moving data`);
      fs.rmSync(lock, { force: true });
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}

function portInUse(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.connect({ port, host });
    s.setTimeout(500);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

/** The engine port of whichever .env the old or current layout uses. */
function enginePort(envFile: string | null): number {
  try { if (envFile && fs.existsSync(envFile)) return parseInt(dotenvParse(fs.readFileSync(envFile, 'utf-8')).ACESTEPCPP_PORT || '8085', 10); } catch { /* default */ }
  return 8085;
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
  /** Skip the "engine still running" probe (tests). */
  skipEngineProbe?: boolean;
}

/** Pick the data root and run whatever transfer is pending. */
export async function resolveRuntime(opts: ResolveOptions = {}): Promise<Resolution> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (m => console.log(m));
  if (!env.HOT_STEP_ROOT) return { ok: true, runtime: DEV };

  const appRoot = path.resolve(env.HOT_STEP_ROOT);
  const prof = profileDir(env);
  const ptrFile = path.join(prof, POINTER_FILE);
  const fail = (error: string): Resolution => ({ ok: false, error, pointerPath: ptrFile });

  try {
    if (env.HOT_STEP_DATA_ROOT) {
      const root = path.resolve(env.HOT_STEP_DATA_ROOT);
      if (!fs.existsSync(root)) return fail(`HOT_STEP_DATA_ROOT is ${root}, which does not exist.`);
      initLayout(dataLayout(root));
      log(`[Data] Using HOT_STEP_DATA_ROOT: ${root}`);
      return { ok: true, runtime: release(appRoot, root, prof, root) };
    }

    let ptr: Pointer | null;
    try { ptr = readPointer(ptrFile); } catch (e: any) { return fail(`${e.message}. Fix or delete it, then restart.`); }

    if (!ptr) {
      // First run of the new layout on this machine.
      const sibling = path.join(path.dirname(appRoot), DEFAULT_DATA_FOLDER);
      const legacy = inspectLegacy(appRoot);
      const hasLegacy = legacyMappings(legacy, sibling).length > 0 || !!legacy.envFile;
      if (hasLegacy) {
        if (!isEmptyDir(sibling)) {
          return fail(`This app folder still holds data from an older version, and ${sibling} already exists with other data. `
            + `Move one of them aside, then restart.`);
        }
        const { op, errors } = planOperation('migrate', sibling, { appRoot, currentRoot: null, currentDb: null });
        if (errors.length) return fail(`Could not plan moving this install's data to ${sibling}: ${errors.join('; ')}`);
        ptr = { version: 1, root: null, pending: op };
        writePointer(ptrFile, ptr);
        log(`[Data] Moving this install's data to ${sibling}`);
      } else if (fs.existsSync(sibling) && !isEmptyDir(sibling) && !isDataLayout(sibling)) {
        return fail(`${sibling} exists but is not a HOT-Step data folder. Rename it, or set HOT_STEP_DATA_ROOT, then restart.`);
      } else {
        initLayout(dataLayout(sibling));
        writePointer(ptrFile, { version: 1, root: sibling, pending: null });
        log(`[Data] Data folder: ${sibling}`);
        return { ok: true, runtime: release(appRoot, sibling, prof, null) };
      }
    }

    if (ptr.pending) {
      const op = ptr.pending;
      if (!opts.skipEngineProbe) {
        const envFile = op.envSource ?? (ptr.root ? dataLayout(ptr.root).envPath : null);
        const port = enginePort(envFile);
        if (await portInUse(port)) return fail(`Something is still listening on the engine port ${port}. Close every HOT-Step window, then restart.`);
      }
      try {
        withLock(prof, () => runPending(ptrFile, ptr!, appRoot, log));
      } catch (e: any) {
        return fail(`Moving data to ${op.destination} stopped: ${e.message}. Nothing was overwritten; restart to try again.`);
      }
    }

    const root = ptr.root;
    if (!root) return fail(`${ptrFile} names no data folder.`);
    try { fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK); } catch {
      return fail(`The data folder ${root} is missing or cannot be written. Reconnect the drive, or correct "root" in ${ptrFile}, then restart.`);
    }
    initLayout(dataLayout(root));
    return { ok: true, runtime: release(appRoot, root, prof, null) };
  } catch (e: any) {
    return fail(String(e?.message ?? e));
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

/** The only thing a broken data location serves. Never returns. */
async function serveErrorPage(error: string, pointerPath: string | null): Promise<never> {
  const port = parseInt(process.env.SERVER_PORT || '3001', 10);
  const host = process.env.SERVER_HOST || '0.0.0.0';
  console.error(`\n[Data] HOT-Step cannot start: ${error}\n`);
  const body = `<!doctype html><meta charset="utf-8"><title>HOT-Step: data folder problem</title>
<body style="font-family:sans-serif;max-width:46em;margin:3em auto;line-height:1.5">
<h1>HOT-Step cannot open its data folder</h1><p>${escapeHtml(error)}</p>
${pointerPath ? `<p>The data location is recorded in <code>${escapeHtml(pointerPath)}</code>. To undo an unfinished move on the same drive, set <code>"abandon": true</code> inside its <code>"pending"</code> entry and restart.</p>` : ''}
<p>Nothing has been deleted. Close this window and restart HOT-Step after fixing the problem.</p></body>`;
  http.createServer((_req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  }).listen(port, host);
  return new Promise<never>(() => { /* hold module evaluation forever */ });
}

const resolution = await resolveRuntime();
if (!resolution.ok) await serveErrorPage(resolution.error, resolution.pointerPath);

export const RUNTIME: Runtime = (resolution as { ok: true; runtime: Runtime }).runtime;
