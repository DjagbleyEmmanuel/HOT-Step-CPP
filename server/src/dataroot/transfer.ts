// dataroot/transfer.ts — Run a pending data-folder operation at boot, before
// the DB, logger or engine open anything.
//
// Same volume: rename each top-level entry of a mapping into its destination.
// Across volumes: copy to *.hspart names, check counts and sizes, keep the
// source until every mapping is copied and the metadata is rewritten, then
// delete only the mapped source entries. Progress is journaled in the pointer
// (pending.mappings[].state) after every step, so a crash resumes. Existence
// on both sides decides what a half-done rename means; nothing is overwritten.

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import {
  dataLayout, initLayout, inspectLegacy, isDataLayout, isEmptyDir, isInside, legacyMappings, migrateEnvText, newPending,
  rewriteEnvText, rewritePath, samePath, writeJsonAtomic, writePointer,
  type Mapping, type OperationKind, type PathPair, type PendingOperation, type Pointer,
} from './paths.js';

const PART = '.hspart';
type Log = (msg: string) => void;

export class TransferError extends Error {}

function entriesOf(m: Mapping): string[] {
  if (!fs.existsSync(m.from)) return [];
  const skip = new Set((m.exclude ?? []).map(n => n.toLowerCase()));
  return fs.readdirSync(m.from).filter(n => !skip.has(n.toLowerCase()));
}

/** Nearest existing ancestor, for stat/statfs on a path not created yet. */
function existingAncestor(p: string): string {
  let cur = path.resolve(p);
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return cur;
}

export function sameVolume(a: string, b: string): boolean {
  return fs.statSync(existingAncestor(a)).dev === fs.statSync(existingAncestor(b)).dev;
}

/** Test seam: a fixture on one drive can force the cross-volume path. */
export const hooks = { sameVolume };

interface Tally { files: number; bytes: number }

/** Walk without following links; links are counted as entries, not trees. */
function tally(p: string, t: Tally = { files: 0, bytes: 0 }): Tally {
  const st = fs.lstatSync(p);
  if (st.isDirectory()) for (const n of fs.readdirSync(p)) tally(path.join(p, n), t);
  else { t.files++; t.bytes += st.isSymbolicLink() ? 0 : st.size; }
  return t;
}

export function mappingBytes(m: Mapping): number {
  return entriesOf(m).reduce((s, n) => s + tally(path.join(m.from, n)).bytes, 0);
}

function persist(file: string, ptr: Pointer): void { writePointer(file, ptr); }

// ── Same volume ──────────────────────────────────────────────────────

function moveByRename(m: Mapping, log: Log): void {
  fs.mkdirSync(m.to, { recursive: true });
  for (const n of entriesOf(m)) {
    const src = path.join(m.from, n);
    const dst = path.join(m.to, n);
    if (fs.existsSync(dst)) throw new TransferError(`${m.name}: both ${src} and ${dst} exist; refusing to guess which is current`);
    fs.renameSync(src, dst);
  }
  if (!m.exclude?.length) { try { fs.rmdirSync(m.from); } catch { /* not empty */ } }
  log(`[Data] Moved ${m.name}: ${m.from} -> ${m.to}`);
}

// ── Across volumes ───────────────────────────────────────────────────

function copyTree(src: string, dst: string, progress: (bytes: number) => void): void {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    if (!fs.existsSync(dst)) fs.symlinkSync(fs.readlinkSync(src), dst, st.isDirectory() ? 'junction' : undefined);
    return;
  }
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const n of fs.readdirSync(src)) copyTree(path.join(src, n), path.join(dst, n), progress);
    return;
  }
  // Resume: a finished file of the right size is kept.
  if (fs.existsSync(dst) && fs.statSync(dst).size === st.size) return;
  // ponytail: copyFileSync per file, so progress ticks per file, not mid-file.
  fs.copyFileSync(src, dst + PART);
  if (fs.statSync(dst + PART).size !== st.size) throw new TransferError(`size mismatch copying ${src}`);
  fs.renameSync(dst + PART, dst);
  progress(st.size);
}

/** Every source file exists at the destination with the same size. */
function verifyCopy(src: string, dst: string): void {
  const st = fs.lstatSync(src);
  if (!fs.existsSync(dst) && !st.isSymbolicLink()) throw new TransferError(`missing after copy: ${dst}`);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) { for (const n of fs.readdirSync(src)) verifyCopy(path.join(src, n), path.join(dst, n)); return; }
  if (fs.statSync(dst).size !== st.size) throw new TransferError(`size differs after copy: ${dst}`);
}

function copyMapping(m: Mapping, log: Log): void {
  fs.mkdirSync(m.to, { recursive: true });
  const names = entriesOf(m);
  const total = names.reduce((s, n) => s + tally(path.join(m.from, n)).bytes, 0);
  const free = fs.statfsSync(existingAncestor(m.to));
  if (free.bavail * free.bsize < total) {
    throw new TransferError(`${m.name}: needs ${gb(total)} at ${m.to}, ${gb(free.bavail * free.bsize)} free`);
  }
  let done = 0, last = 0;
  for (const n of names) {
    copyTree(path.join(m.from, n), path.join(m.to, n), b => {
      done += b;
      if (Date.now() - last > 2000) { last = Date.now(); log(`[Data] Copying ${m.name}: ${gb(done)} of ${gb(total)}`); }
    });
  }
  for (const n of names) verifyCopy(path.join(m.from, n), path.join(m.to, n));
  log(`[Data] Copied ${m.name}: ${gb(total)} verified`);
}

function cleanMapping(m: Mapping): void {
  for (const n of entriesOf(m)) fs.rmSync(path.join(m.from, n), { recursive: true, force: true });
  if (!m.exclude?.length) { try { fs.rmdirSync(m.from); } catch { /* not empty or gone */ } }
}

function gb(n: number): string { return `${(n / 1e9).toFixed(2)} GB`; }

// ── Metadata rewrite ─────────────────────────────────────────────────

const PLAIN_COLUMNS: Record<string, string[]> = {
  album_presets: ['adapter_path', 'lm_adapter_path', 'mm3_adapter_path', 'yue2_ar_adapter_path', 'yue2_nar_adapter_path', 'reference_track_path'],
  training_datasets: ['source_dir', 'dataset_json_path'],
  yue2_rung_scores: ['checkpoint_dir'],
  settings: ['value'],
};
const JSON_COLUMNS: Record<string, string[]> = {
  songs: ['generation_params'],
  audio_intents: ['request', 'meta'],
  workflow_jobs: ['input', 'result'],
  workflow_documents: ['data'],
};

/** Rewrite every string in a JSON value; returns the new value or undefined if unchanged. */
export function rewriteJson(v: unknown, pairs: PathPair[]): unknown | undefined {
  let changed = false;
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') { const r = rewritePath(x, pairs); if (r !== null) { changed = true; return r; } return x; }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  const out = walk(v);
  return changed ? out : undefined;
}

/** Rewrite path columns in one transaction. A unique-key clash throws and rolls back. */
export function rewriteDb(dbPath: string, pairs: PathPair[], backupTag: string, log: Log): number {
  if (!fs.existsSync(dbPath)) return 0;
  for (const ext of ['', '-wal', '-shm']) {
    const src = dbPath + ext;
    const bak = dbPath.replace(/\.db$/, '') + `.pre-transfer-${backupTag}.db${ext}`;
    if (fs.existsSync(src) && !fs.existsSync(bak)) fs.copyFileSync(src, bak);
  }
  const db = new Database(dbPath);
  let n = 0;
  try {
    const cols = (t: string) => new Set((db.prepare(`PRAGMA table_info("${t}")`).all() as any[]).map(c => c.name));
    db.transaction(() => {
      for (const [table, json] of [...Object.entries(PLAIN_COLUMNS).map(e => [e, false] as const), ...Object.entries(JSON_COLUMNS).map(e => [e, true] as const)]) {
        const [t, wanted] = table;
        const have = cols(t);
        for (const c of wanted.filter(c => have.has(c))) {
          const upd = db.prepare(`UPDATE "${t}" SET "${c}" = ? WHERE rowid = ?`);
          for (const row of db.prepare(`SELECT rowid AS id, "${c}" AS v FROM "${t}" WHERE "${c}" IS NOT NULL AND "${c}" != ''`).all() as any[]) {
            if (typeof row.v !== 'string') continue;
            let next: string | null = null;
            if (json) {
              try { const r = rewriteJson(JSON.parse(row.v), pairs); if (r !== undefined) next = JSON.stringify(r); } catch { /* not JSON */ }
            } else {
              next = rewritePath(row.v, pairs);
            }
            if (next !== null && next !== row.v) {
              try { upd.run(next, row.id); } catch (e: any) {
                throw new TransferError(`${t}.${c}: rewriting ${row.v} collides with an existing row (${e.message})`);
              }
              n++;
            }
          }
        }
      }
    })();
  } finally {
    db.close();
  }
  log(`[Data] Rewrote ${n} stored path(s) in ${dbPath}`);
  return n;
}

const SKIP_DIRS = new Set(['audio', 'references', 'stems', 'stem-cache', 'tensors', 'tmp', 'node_modules', 'venv', '.git', 'yue2-latents', 'logs', 'models']);

/** Rewrite path strings in .json files under `root` (depth-limited, big trees skipped). */
export function rewriteJsonFiles(root: string, pairs: PathPair[], depth = 6): number {
  let n = 0;
  const walk = (dir: string, d: number) => {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (d > 0 && !SKIP_DIRS.has(e.name) && !e.name.endsWith('_temp')) walk(p, d - 1); continue; }
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      try {
        if (fs.statSync(p).size > 8 * 1024 * 1024) continue;
        const r = rewriteJson(JSON.parse(fs.readFileSync(p, 'utf-8')), pairs);
        if (r !== undefined) { writeJsonAtomic(p, r); n++; }
      } catch { /* not JSON we can read: leave it */ }
    }
  };
  walk(root, depth);
  return n;
}

function rewriteAll(op: PendingOperation, log: Log): void {
  const l = dataLayout(op.destination);
  const pairs: PathPair[] = op.mappings.map(m => ({ from: m.from, to: m.to }));
  fs.mkdirSync(l.settingsDir, { recursive: true });
  if (op.envSource && fs.existsSync(op.envSource)) {
    if (fs.existsSync(l.envPath)) throw new TransferError(`${l.envPath} already exists; refusing to overwrite settings`);
    const text = migrateEnvText(fs.readFileSync(op.envSource, 'utf-8'), op.envBase ?? path.dirname(op.envSource), pairs, l, op.source);
    fs.writeFileSync(l.envPath, text, 'utf-8');
  } else if (fs.existsSync(l.envPath)) {
    fs.writeFileSync(l.envPath, rewriteEnvText(fs.readFileSync(l.envPath, 'utf-8'), pairs, l), 'utf-8');
  }
  if (op.dbPath) {
    const db = rewritePath(op.dbPath, pairs) ?? op.dbPath;
    rewriteDb(db, pairs, op.id.slice(0, 8), log);
  }
  let files = 0;
  for (const m of op.mappings) if (m.name !== 'logs' && m.name !== 'models') files += rewriteJsonFiles(m.to, pairs);
  if (files) log(`[Data] Rewrote paths in ${files} JSON file(s)`);
}

// ── Planning ─────────────────────────────────────────────────────────

/** A library a fresh install created on its own: only DB files and empty
 *  folders, and no songs in the DB. */
export function isBlankLibrary(dir: string): boolean {
  if (!fs.existsSync(dir)) return true;
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (/^hotstep\.db(-wal|-shm)?$/i.test(n)) continue;
    if (fs.statSync(p).isDirectory() && tally(p).files === 0) continue;
    return false;
  }
  const db = path.join(dir, 'hotstep.db');
  if (!fs.existsSync(db)) return true;
  const conn = new Database(db, { readonly: true, fileMustExist: true });
  try {
    const t = conn.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'songs'`).get();
    return !t || (conn.prepare('SELECT COUNT(*) AS n FROM songs').get() as any).n === 0;
  } finally { conn.close(); }
}

function registryRuntimeNames(appRoot: string): Set<string> {
  for (const f of [path.join(appRoot, 'server', 'data', 'model-registry.json'), path.join(appRoot, 'server', 'src', 'data', 'model-registry.json')]) {
    if (!fs.existsSync(f)) continue;
    const names = new Set<string>();
    try {
      JSON.stringify(JSON.parse(fs.readFileSync(f, 'utf-8')), (_k, v) => {
        if (v && v.role === 'runtime' && typeof v.filename === 'string') names.add(v.filename);
        return v;
      });
    } catch { /* unreadable registry: copy no runtime files */ }
    return names;
  }
  return new Set();
}

function listFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  let ents: fs.Dirent[];
  try { ents = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...listFiles(dir, r)); else if (e.isFile()) out.push(r);
  }
  return out;
}

/** Plugins and runtime DLLs an old install has that this app does not ship. */
export function importCopies(oldApp: string, appRoot: string, destRoot: string): PathPair[] {
  const l = dataLayout(destRoot);
  const out: PathPair[] = [];
  const shipped = (rel: string) => [path.join(appRoot, 'engine', 'plugins', rel), path.join(appRoot, 'plugins', rel)].some(p => fs.existsSync(p));
  for (const base of [path.join(oldApp, 'engine', 'plugins'), path.join(oldApp, 'plugins')]) {
    for (const rel of listFiles(base).filter(r => r.endsWith('.lua'))) {
      if (!shipped(rel)) out.push({ from: path.join(base, rel), to: path.join(l.plugins, rel) });
    }
  }
  const runtime = registryRuntimeNames(appRoot);
  const oldEngine = path.join(oldApp, 'engine');
  for (const n of fs.existsSync(oldEngine) ? fs.readdirSync(oldEngine) : []) {
    if (runtime.has(n) && !fs.existsSync(path.join(appRoot, 'engine', n))) {
      out.push({ from: path.join(oldEngine, n), to: path.join(l.runtimeLibDir, n) });
    }
  }
  return out;
}

export interface PlanContext {
  appRoot: string;
  /** Active data root (null while the first-run migration is being planned). */
  currentRoot: string | null;
  /** Active DB path, which may be external (DATA_DIR override). */
  currentDb: string | null;
}

/** Build a pending operation and the reasons it cannot run. Writes nothing.
 *  `target` is the new root (move/create/repoint/migrate) or the old app
 *  folder to import from (import). */
export function planOperation(kind: OperationKind, target: string, ctx: PlanContext): { op: PendingOperation; errors: string[] } {
  const dest = path.resolve(target);
  const errors: string[] = [];
  let op: PendingOperation;
  if (kind === 'move') {
    if (!ctx.currentRoot) errors.push('there is no current data folder to move');
    if (!isEmptyDir(dest)) errors.push(`${dest} is not empty`);
    op = newPending('move', ctx.currentRoot, dest, {
      mappings: ctx.currentRoot ? [{ name: 'data', from: ctx.currentRoot, to: dest, state: 'pending' }] : [],
      dbPath: ctx.currentDb,
    });
  } else if (kind === 'create') {
    if (!isEmptyDir(dest)) errors.push(`${dest} is not empty; use an existing data folder instead`);
    op = newPending('create', ctx.currentRoot, dest);
  } else if (kind === 'repoint') {
    if (!isDataLayout(dest)) errors.push(`${dest} is not a HOT-Step data folder`);
    op = newPending('repoint', ctx.currentRoot, dest);
  } else {
    // migrate: this app's own old layout into `dest`; import: the old install at `dest` into the current root.
    const legacyRoot = kind === 'migrate' ? ctx.appRoot : dest;
    const root = kind === 'migrate' ? dest : ctx.currentRoot;
    if (!root) errors.push('there is no current data folder to import into');
    const into = root ?? dest;
    const legacy = inspectLegacy(legacyRoot);
    const mappings = legacyMappings(legacy, into);
    const library = dataLayout(into).library;
    if (kind === 'import') {
      if (samePath(legacyRoot, ctx.appRoot)) errors.push('that is this app folder');
      if (!mappings.length && !legacy.envFile) errors.push(`no HOT-Step data found in ${legacyRoot}`);
      if (!isBlankLibrary(library)) errors.push(`${library} already has a library; import never merges libraries`);
    }
    for (const m of mappings) {
      if (m.name === 'library' && kind === 'import') continue; // the blank library is set aside first
      for (const n of entriesOf(m)) if (fs.existsSync(path.join(m.to, n))) errors.push(`${path.join(m.to, n)} already exists`);
    }
    op = newPending(kind, legacyRoot, into, {
      mappings,
      envSource: legacy.envFile,
      envBase: legacy.appRoot,
      dbPath: path.join(legacy.dataDir, 'hotstep.db'),
      copies: kind === 'import' ? importCopies(legacyRoot, ctx.appRoot, into) : [],
      setAside: kind === 'import' ? [library] : undefined,
    });
  }
  errors.push(...validateOperation(op, ctx.appRoot));
  if (kind !== 'migrate' && kind !== 'import' && ctx.currentRoot && samePath(ctx.currentRoot, dest)) {
    errors.push('that is already the data folder');
  }
  return { op, errors };
}

/** Bytes to move and whether any of it crosses volumes. */
export function sizeOperation(op: PendingOperation): { bytes: number; crossVolume: boolean; needBytes: number; freeBytes: number | null } {
  let bytes = 0, need = 0, cross = false;
  for (const m of op.mappings) {
    if (!fs.existsSync(m.from)) continue;
    const b = mappingBytes(m);
    bytes += b;
    if (!hooks.sameVolume(m.from, m.to)) { cross = true; need += b; }
  }
  let free: number | null = null;
  try { const s = fs.statfsSync(existingAncestor(op.destination)); free = s.bavail * s.bsize; } catch { /* unknown */ }
  return { bytes, crossVolume: cross, needBytes: need, freeBytes: free };
}

// ── Driver ───────────────────────────────────────────────────────────

/** Validate a pending operation before anything moves. Returns error strings. */
export function validateOperation(op: PendingOperation, appRoot: string): string[] {
  const errs: string[] = [];
  if (isInside(appRoot, op.destination)) errs.push(`the data folder cannot be inside the app folder (${appRoot})`);
  if (op.source && (isInside(op.source, op.destination) || isInside(op.destination, op.source))) {
    errs.push(`${op.source} and ${op.destination} overlap`);
  }
  for (const m of op.mappings) {
    if (isInside(m.from, m.to) || isInside(m.to, m.from)) errs.push(`${m.name}: ${m.from} and ${m.to} overlap`);
  }
  return errs;
}

/** Undo a same-volume move that has not activated: rename entries back. */
function abandon(ptrFile: string, ptr: Pointer, log: Log): void {
  const op = ptr.pending!;
  if (op.rewritten) throw new TransferError('metadata was already rewritten; this move can only be finished, not abandoned');
  for (const m of op.mappings) {
    if (m.state === 'moved' || m.state === 'pending') {
      if (!fs.existsSync(m.to)) continue;
      fs.mkdirSync(m.from, { recursive: true });
      const back: Mapping = { ...m, from: m.to, to: m.from, exclude: undefined };
      for (const n of entriesOf(back)) {
        const src = path.join(back.from, n), dst = path.join(back.to, n);
        if (fs.existsSync(dst)) throw new TransferError(`abandon: both ${src} and ${dst} exist`);
        if (hooks.sameVolume(src, back.to)) fs.renameSync(src, dst);
        else throw new TransferError(`abandon: ${m.name} is split across volumes; finish the move instead`);
      }
    } else if (m.state === 'copied') {
      for (const n of entriesOf(m)) fs.rmSync(path.join(m.to, n), { recursive: true, force: true });
    }
  }
  log(`[Data] Abandoned ${op.kind} to ${op.destination}`);
  ptr.pending = null;
  persist(ptrFile, ptr);
}

/** Run ptr.pending to completion, journaling into ptrFile. On success the
 *  pointer names the destination and pending is null. Throws on failure with
 *  pending (and its error) left in place. */
export function runPending(ptrFile: string, ptr: Pointer, appRoot: string, log: Log = console.log): void {
  const op = ptr.pending;
  if (!op) return;
  if (op.abandon) { abandon(ptrFile, ptr, log); return; }
  try {
    const errs = validateOperation(op, appRoot);
    if (errs.length) throw new TransferError(errs.join('; '));
    const l = dataLayout(op.destination);

    if (op.kind === 'repoint') {
      if (!fs.existsSync(l.root)) throw new TransferError(`${l.root} does not exist`);
    } else {
      fs.mkdirSync(l.root, { recursive: true });
    }

    if (op.setAside?.length && !op.setAsideDone) {
      for (const p of op.setAside) {
        if (!fs.existsSync(p)) continue;
        if (!isBlankLibrary(p)) throw new TransferError(`${p} has songs or files now; import only replaces a blank library`);
        fs.renameSync(p, `${p}.blank-${op.id.slice(0, 8)}`);
      }
      op.setAsideDone = true;
      persist(ptrFile, ptr);
    }

    for (const m of op.mappings) {
      if (m.state !== 'pending') continue;
      if (!fs.existsSync(m.from)) { m.state = 'cleaned'; persist(ptrFile, ptr); continue; }
      if (hooks.sameVolume(m.from, m.to)) { moveByRename(m, log); m.state = 'moved'; }
      else { copyMapping(m, log); m.state = 'copied'; }
      persist(ptrFile, ptr);
    }
    for (const c of op.copies) {
      if (fs.existsSync(c.from) && !fs.existsSync(c.to)) { fs.mkdirSync(path.dirname(c.to), { recursive: true }); fs.copyFileSync(c.from, c.to); }
    }

    if (!op.rewritten && op.kind !== 'repoint' && op.kind !== 'create') {
      rewriteAll(op, log);
      op.rewritten = true;
      persist(ptrFile, ptr);
    }
    if (op.envSource && fs.existsSync(op.envSource) && (op.kind === 'migrate' || op.kind === 'import')) {
      fs.renameSync(op.envSource, op.envSource + '.migrated');
    }

    for (const m of op.mappings) {
      if (m.state !== 'copied') continue;
      cleanMapping(m);
      m.state = 'cleaned';
      persist(ptrFile, ptr);
    }

    if (op.kind === 'repoint') {
      if (!fs.existsSync(l.marker) && !fs.existsSync(path.join(l.library, 'hotstep.db'))) {
        throw new TransferError(`${l.root} is not a HOT-Step data folder`);
      }
    }
    initLayout(l);
    ptr.root = l.root;
    ptr.pending = null;
    persist(ptrFile, ptr);
    log(`[Data] ${op.kind} complete; data folder is ${l.root}`);
  } catch (e: any) {
    op.error = String(e?.message ?? e);
    try { persist(ptrFile, ptr); } catch { /* report the original error */ }
    throw e;
  }
}
