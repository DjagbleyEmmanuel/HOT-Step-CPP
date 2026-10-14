// Disposable fixtures under the OS temp folder; nothing here reads the
// checkout's own data or profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { resolveRuntime } from './bootstrap.js';
import { dataLayout, initLayout, isInside, readPointer, rewritePath, writePointer, BUNDLED_DATA_NAMES, POINTER_FILE, LOCK_FILE } from './paths.js';
import { hooks, planOperation, rewriteDb, runPending } from './transfer.js';

const quiet = () => {};

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-runtime-'));
  const app = path.join(base, 'HOT-Step-v2');
  const prof = path.join(base, 'profile');
  fs.mkdirSync(path.join(app, 'server', 'data'), { recursive: true });
  for (const n of BUNDLED_DATA_NAMES) fs.writeFileSync(path.join(app, 'server', 'data', n), 'bundled');
  const env = { HOT_STEP_ROOT: app, HOT_STEP_PROFILE_DIR: prof } as NodeJS.ProcessEnv;
  return { base, app, prof, env, sibling: path.join(base, 'HOT-Step-Data'), ptrFile: path.join(prof, POINTER_FILE) };
}

function write(p: string, text = 'x') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function makeDb(file: string, rows: { adapter?: string; sourceDir?: string; params?: object }[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`CREATE TABLE songs (id INTEGER PRIMARY KEY, generation_params TEXT);
    CREATE TABLE album_presets (id INTEGER PRIMARY KEY, adapter_path TEXT, reference_track_path TEXT);
    CREATE TABLE training_datasets (id INTEGER PRIMARY KEY, source_dir TEXT NOT NULL, dataset_json_path TEXT NOT NULL DEFAULT '');
    CREATE UNIQUE INDEX idx_src ON training_datasets(source_dir);`);
  for (const r of rows) {
    if (r.adapter) db.prepare('INSERT INTO album_presets (adapter_path, reference_track_path) VALUES (?, ?)').run(r.adapter, 'https://example.com/a.flac');
    if (r.sourceDir) db.prepare('INSERT INTO training_datasets (source_dir) VALUES (?)').run(r.sourceDir);
    if (r.params) db.prepare('INSERT INTO songs (generation_params) VALUES (?)').run(JSON.stringify(r.params));
  }
  db.close();
}

test('dev: no HOT_STEP_ROOT means no data root, no profile, nothing created', async () => {
  const r = await resolveRuntime({ env: {}, log: quiet });
  assert.ok(r.ok);
  assert.equal(r.runtime.mode, 'dev');
  assert.equal(r.runtime.dataRoot, null);
  assert.equal(r.runtime.envPath, null);
});

test('path boundaries: sibling prefixes are outside, case is ignored on Windows', () => {
  assert.equal(isInside(path.resolve('/x/data'), path.resolve('/x/data2/a')), false);
  assert.equal(isInside(path.resolve('/x/data'), path.resolve('/x/data/a')), true);
  assert.equal(rewritePath('https://host/x/data/a', [{ from: '/x/data', to: '/y' }]), null);
  if (process.platform === 'win32') {
    assert.equal(rewritePath('d:\\Old\\Lib\\Song.wav', [{ from: 'D:\\old\\lib', to: 'E:\\new' }]), 'E:\\new\\Song.wav');
  }
});

test('fresh unzip, no legacy data: sibling layout created and pointer saved', async () => {
  const f = fixture();
  const r = await resolveRuntime({ env: f.env, log: quiet, skipEngineProbe: true });
  assert.ok(r.ok);
  assert.equal(r.runtime.dataRoot, f.sibling);
  assert.ok(fs.existsSync(path.join(f.sibling, 'hot-step-data.json')));
  assert.equal(readPointer(f.ptrFile)!.root, f.sibling);
  assert.equal(r.runtime.restartMarkerPath, path.join(f.prof, 'restart-requested'));
});

test('legacy bundle with no .env: <app>/data, models, adapters move by rename and the DB paths follow', async () => {
  const f = fixture();
  const data = path.join(f.app, 'data');
  write(path.join(data, 'audio', 'a.wav'), 'audio');
  write(path.join(f.app, 'models', 'm.gguf'), 'model');
  write(path.join(f.app, 'adapters', 'lm-4b', 'x', 'adapter.safetensors'), 'w');
  write(path.join(f.app, 'logs', '2026-01-01', 'node_console.log'), 'log');
  makeDb(path.join(data, 'hotstep.db'), [
    { adapter: path.join(f.app, 'adapters', 'lm-4b', 'x') },
    { adapter: path.join(f.base, 'external', 'y') },
    { params: { lmAdapter: path.join(f.app, 'adapters', 'lm-4b', 'x'), audio: '/audio/a.wav' } },
  ]);
  const inoBefore = fs.statSync(path.join(f.app, 'models', 'm.gguf')).ino;

  const r = await resolveRuntime({ env: f.env, log: quiet, skipEngineProbe: true });
  assert.ok(r.ok, !r.ok ? r.error : '');
  const l = dataLayout(f.sibling);
  assert.equal(fs.statSync(path.join(l.models, 'm.gguf')).ino, inoBefore, 'renamed, not copied');
  assert.ok(fs.existsSync(path.join(l.library, 'audio', 'a.wav')));
  assert.ok(fs.existsSync(path.join(l.logs, '2026-01-01', 'node_console.log')));
  assert.ok(!fs.existsSync(path.join(f.app, 'models')));
  for (const n of BUNDLED_DATA_NAMES) assert.ok(fs.existsSync(path.join(f.app, 'server', 'data', n)), 'bundled files stay');

  const db = new Database(path.join(l.library, 'hotstep.db'), { readonly: true });
  const presets = db.prepare('SELECT adapter_path, reference_track_path FROM album_presets ORDER BY id').all() as any[];
  assert.equal(presets[0].adapter_path, path.join(l.adapters, 'lm-4b', 'x'));
  assert.equal(presets[1].adapter_path, path.join(f.base, 'external', 'y'), 'external path untouched');
  assert.equal(presets[0].reference_track_path, 'https://example.com/a.flac', 'URL untouched');
  const params = JSON.parse((db.prepare('SELECT generation_params FROM songs').get() as any).generation_params);
  assert.equal(params.lmAdapter, path.join(l.adapters, 'lm-4b', 'x'));
  assert.equal(params.audio, '/audio/a.wav');
  db.close();
  assert.ok(fs.readdirSync(l.library).some(n => n.includes('.pre-transfer-')), 'DB backed up before rewrite');
  assert.equal(readPointer(f.ptrFile)!.pending, null);

  // A second start finds the pointer and moves nothing.
  const again = await resolveRuntime({ env: f.env, log: quiet, skipEngineProbe: true });
  assert.ok(again.ok);
  assert.equal(again.runtime.dataRoot, f.sibling);
});

test('legacy .env DATA_DIR=./server/data: user data leaves server/data, settings carried with secrets, app-binary keys dropped', async () => {
  const f = fixture();
  const sd = path.join(f.app, 'server', 'data');
  write(path.join(sd, 'hotstep.db'), '');
  fs.rmSync(path.join(sd, 'hotstep.db'));
  makeDb(path.join(sd, 'hotstep.db'), []);
  write(path.join(sd, 'references', 'r.flac'), 'r');
  write(path.join(sd, 'training', 'datasets', 'a', 'manifest.json'), JSON.stringify({ src: path.join(sd, 'references', 'r.flac') }));
  const external = path.join(f.base, 'ext-adapters');
  fs.mkdirSync(external);
  write(path.join(f.app, '.env'), [
    'DATA_DIR=./server/data', 'GEMINI_API_KEY=secret123', `ACESTEPCPP_ADAPTERS=${external}`,
    `ACESTEPCPP_EXE=${path.join(f.app, 'engine', 'ace-server.exe')}`, 'ACESTEPCPP_PORT=8085',
  ].join('\n'));

  const cwd = process.cwd();
  process.chdir(os.tmpdir()); // nothing may depend on where the process starts
  try {
    const r = await resolveRuntime({ env: f.env, log: quiet, skipEngineProbe: true });
    assert.ok(r.ok, !r.ok ? r.error : '');
  } finally { process.chdir(cwd); }
  const l = dataLayout(f.sibling);
  assert.ok(fs.existsSync(path.join(l.library, 'hotstep.db')));
  assert.ok(fs.existsSync(path.join(l.library, 'references', 'r.flac')));
  assert.deepEqual(fs.readdirSync(sd).sort(), [...BUNDLED_DATA_NAMES].sort());
  const env = fs.readFileSync(l.envPath, 'utf-8');
  assert.match(env, /GEMINI_API_KEY=secret123/);
  assert.match(env, /ACESTEPCPP_PORT=8085/);
  assert.ok(env.includes(`ACESTEPCPP_ADAPTERS=${external}`), 'external kept');
  assert.doesNotMatch(env, /DATA_DIR=/);
  assert.doesNotMatch(env, /ACESTEPCPP_EXE=/);
  assert.ok(fs.existsSync(path.join(f.app, '.env.migrated')) && !fs.existsSync(path.join(f.app, '.env')));
  const manifest = JSON.parse(fs.readFileSync(path.join(l.library, 'training', 'datasets', 'a', 'manifest.json'), 'utf-8'));
  assert.equal(manifest.src, path.join(l.library, 'references', 'r.flac'));
});

test('missing data folder or malformed pointer: refuses, keeps the pointer, creates nothing', async () => {
  const f = fixture();
  const gone = path.join(f.base, 'unplugged-drive', 'HOT-Step-Data');
  writePointer(f.ptrFile, { version: 1, root: gone, pending: null });
  const before = fs.readFileSync(f.ptrFile, 'utf-8');
  const r = await resolveRuntime({ env: f.env, log: quiet, skipEngineProbe: true });
  assert.equal(r.ok, false);
  assert.match((r as any).error, /missing/);
  assert.equal(fs.readFileSync(f.ptrFile, 'utf-8'), before);
  assert.ok(!fs.existsSync(gone));

  fs.writeFileSync(f.ptrFile, '{ not json');
  const bad = await resolveRuntime({ env: f.env, log: quiet, skipEngineProbe: true });
  assert.equal(bad.ok, false);
  assert.equal(fs.readFileSync(f.ptrFile, 'utf-8'), '{ not json');
});

test('legacy data next to a populated sibling refuses instead of choosing', async () => {
  const f = fixture();
  write(path.join(f.app, 'data', 'audio', 'a.wav'));
  write(path.join(f.sibling, 'library', 'hotstep.db'));
  const r = await resolveRuntime({ env: f.env, log: quiet, skipEngineProbe: true });
  assert.equal(r.ok, false);
  assert.ok(fs.existsSync(path.join(f.app, 'data', 'audio', 'a.wav')));
  assert.ok(!fs.existsSync(f.ptrFile));
});

test('crash between a rename and the journal write resumes; a real conflict stops without overwriting', () => {
  const f = fixture();
  const oldRoot = path.join(f.base, 'old-root');
  const newRoot = path.join(f.base, 'new-root');
  write(path.join(oldRoot, 'library', 'a.txt'), 'a');
  write(path.join(oldRoot, 'models', 'm.gguf'), 'm');
  const { op, errors } = planOperation('move', newRoot, { appRoot: f.app, currentRoot: oldRoot, currentDb: null });
  assert.deepEqual(errors, []);
  writePointer(f.ptrFile, { version: 1, root: oldRoot, pending: op });
  // Simulate the crash: "library" was renamed, the journal still says pending.
  fs.mkdirSync(newRoot, { recursive: true });
  fs.renameSync(path.join(oldRoot, 'library'), path.join(newRoot, 'library'));
  const ptr = readPointer(f.ptrFile)!;
  runPending(f.ptrFile, ptr, f.app, quiet);
  assert.equal(readPointer(f.ptrFile)!.root, newRoot);
  assert.ok(fs.existsSync(path.join(newRoot, 'library', 'a.txt')));
  assert.ok(fs.existsSync(path.join(newRoot, 'models', 'm.gguf')));

  // Both sides hold the same name: stop, keep both, record the error.
  write(path.join(oldRoot, 'models', 'dup.gguf'), 'old');
  const third = path.join(f.base, 'third-root');
  write(path.join(third, 'models', 'dup.gguf'), 'other');
  const p2 = { version: 1 as const, root: oldRoot, pending: { ...op, id: 'x2', destination: third, mappings: [{ name: 'data', from: oldRoot, to: third, state: 'pending' as const }] } };
  writePointer(f.ptrFile, p2);
  assert.throws(() => runPending(f.ptrFile, p2, f.app, quiet), /refusing to guess/);
  assert.equal(fs.readFileSync(path.join(oldRoot, 'models', 'dup.gguf'), 'utf-8'), 'old');
  assert.equal(fs.readFileSync(path.join(third, 'models', 'dup.gguf'), 'utf-8'), 'other');
  const kept = readPointer(f.ptrFile)!;
  assert.ok(kept.pending && kept.pending.error);
  assert.equal(kept.root, oldRoot);
});

test('cross-volume: copies, verifies sizes, keeps the source on failure, cleans only after success', () => {
  const f = fixture();
  const oldRoot = path.join(f.base, 'old-root');
  const newRoot = path.join(f.base, 'new-root');
  write(path.join(oldRoot, 'library', 'big.bin'), 'x'.repeat(4096));
  write(path.join(oldRoot, 'library', 'sub', 'b.txt'), 'b');
  const outside = path.join(f.base, 'outside-tree');
  write(path.join(outside, 'huge.bin'), 'not ours');
  fs.symlinkSync(outside, path.join(oldRoot, 'library', 'link'), 'junction');
  const { op } = planOperation('move', newRoot, { appRoot: f.app, currentRoot: oldRoot, currentDb: null });
  const ptr = { version: 1 as const, root: oldRoot, pending: op };
  writePointer(f.ptrFile, ptr);
  // An obstacle where a file must land makes the copy fail part way.
  fs.mkdirSync(path.join(newRoot, 'library', 'big.bin'), { recursive: true });
  const real = hooks.sameVolume;
  hooks.sameVolume = () => false;
  try {
    assert.throws(() => runPending(f.ptrFile, ptr, f.app, quiet));
    assert.ok(fs.existsSync(path.join(oldRoot, 'library', 'big.bin')), 'source kept after failure');
    assert.equal(readPointer(f.ptrFile)!.root, oldRoot);
    fs.rmSync(path.join(newRoot, 'library', 'big.bin'), { recursive: true });
    const resumed = readPointer(f.ptrFile)!;
    runPending(f.ptrFile, resumed, f.app, quiet);
  } finally { hooks.sameVolume = real; }
  assert.equal(fs.statSync(path.join(newRoot, 'library', 'big.bin')).size, 4096);
  assert.ok(fs.existsSync(path.join(newRoot, 'library', 'sub', 'b.txt')));
  assert.ok(fs.lstatSync(path.join(newRoot, 'library', 'link')).isSymbolicLink(), 'link recreated, not followed');
  assert.ok(!fs.existsSync(path.join(oldRoot, 'library')), 'source cleaned after success');
  assert.equal(fs.readFileSync(path.join(outside, 'huge.bin'), 'utf-8'), 'not ours', 'link target untouched');
  assert.equal(readPointer(f.ptrFile)!.root, newRoot);
});

test('DB rewrite: a unique-key collision rolls back everything', () => {
  const f = fixture();
  const from = path.join(f.base, 'old');
  const to = path.join(f.base, 'new');
  const db = path.join(f.base, 'lib', 'hotstep.db');
  makeDb(db, [
    { adapter: path.join(from, 'a') },
    { sourceDir: path.join(from, 'ds') },
    { sourceDir: path.join(to, 'ds') },
  ]);
  assert.throws(() => rewriteDb(db, [{ from, to }], 't1', quiet), /collides/);
  const conn = new Database(db, { readonly: true });
  assert.equal((conn.prepare('SELECT adapter_path FROM album_presets').get() as any).adapter_path, path.join(from, 'a'));
  conn.close();
});

test('lock: a stale lock is cleared, a live one blocks the transfer', async () => {
  const f = fixture();
  const oldRoot = path.join(f.base, 'old-root');
  write(path.join(oldRoot, 'library', 'a.txt'));
  const { op } = planOperation('move', path.join(f.base, 'new-root'), { appRoot: f.app, currentRoot: oldRoot, currentDb: null });
  writePointer(f.ptrFile, { version: 1, root: oldRoot, pending: op });
  fs.writeFileSync(path.join(f.prof, LOCK_FILE), String(process.pid));
  const blocked = await resolveRuntime({ env: f.env, log: quiet, skipEngineProbe: true });
  assert.equal(blocked.ok, false);
  assert.ok(fs.existsSync(path.join(oldRoot, 'library', 'a.txt')));
  fs.writeFileSync(path.join(f.prof, LOCK_FILE), '999999');
  const ok = await resolveRuntime({ env: f.env, log: quiet, skipEngineProbe: true });
  assert.ok(ok.ok, !ok.ok ? ok.error : '');
  assert.equal(ok.runtime.dataRoot, path.join(f.base, 'new-root'));
  assert.ok(!fs.existsSync(path.join(f.prof, LOCK_FILE)));
});

test('repoint needs an existing layout and moves nothing; move refuses targets inside the app', () => {
  const f = fixture();
  const cur = path.join(f.base, 'cur');
  initLayout(dataLayout(cur));
  assert.ok(planOperation('repoint', path.join(f.base, 'nothing'), { appRoot: f.app, currentRoot: cur, currentDb: null }).errors.length);
  assert.ok(planOperation('move', path.join(f.app, 'data2'), { appRoot: f.app, currentRoot: cur, currentDb: null }).errors.length);
  assert.ok(planOperation('move', path.join(cur, 'inner'), { appRoot: f.app, currentRoot: cur, currentDb: null }).errors.length);
  const other = path.join(f.base, 'other');
  initLayout(dataLayout(other));
  write(path.join(cur, 'library', 'keep.txt'));
  const { op, errors } = planOperation('repoint', other, { appRoot: f.app, currentRoot: cur, currentDb: null });
  assert.deepEqual(errors, []);
  const ptr = { version: 1 as const, root: cur, pending: op };
  writePointer(f.ptrFile, ptr);
  runPending(f.ptrFile, ptr, f.app, quiet);
  assert.equal(readPointer(f.ptrFile)!.root, other);
  assert.ok(fs.existsSync(path.join(cur, 'library', 'keep.txt')));
});

test('import from an older install: blank library set aside, data moved in, unshipped plugins copied', () => {
  const f = fixture();
  const cur = path.join(f.base, 'HOT-Step-Data');
  initLayout(dataLayout(cur));
  makeDb(path.join(cur, 'library', 'hotstep.db'), []);
  const oldApp = path.join(f.base, 'HOT-Step-v1');
  write(path.join(oldApp, 'data', 'audio', 'old.wav'));
  makeDb(path.join(oldApp, 'data', 'hotstep.db'), [{ params: { p: path.join(oldApp, 'data', 'audio', 'old.wav') } }]);
  write(path.join(oldApp, 'engine', 'plugins', 'solvers', 'mine.lua'), '-- user');
  write(path.join(oldApp, 'engine', 'plugins', 'solvers', 'euler.lua'), '-- shipped');
  write(path.join(f.app, 'engine', 'plugins', 'solvers', 'euler.lua'), '-- shipped');
  const { op, errors } = planOperation('import', oldApp, { appRoot: f.app, currentRoot: cur, currentDb: path.join(cur, 'library', 'hotstep.db') });
  assert.deepEqual(errors, []);
  const ptr = { version: 1 as const, root: cur, pending: op };
  writePointer(f.ptrFile, ptr);
  runPending(f.ptrFile, ptr, f.app, quiet);
  const l = dataLayout(cur);
  assert.ok(fs.existsSync(path.join(l.library, 'audio', 'old.wav')));
  assert.ok(fs.existsSync(path.join(l.plugins, 'solvers', 'mine.lua')));
  assert.ok(!fs.existsSync(path.join(l.plugins, 'solvers', 'euler.lua')));
  assert.ok(fs.readdirSync(cur).some(n => n.startsWith('library.blank-')));
  const conn = new Database(path.join(l.library, 'hotstep.db'), { readonly: true });
  assert.equal(JSON.parse((conn.prepare('SELECT generation_params FROM songs').get() as any).generation_params).p, path.join(l.library, 'audio', 'old.wav'));
  conn.close();
});

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// config.ts evaluated for real in a child, so the import-order gate is covered too.
function loadConfig(env: NodeJS.ProcessEnv): any {
  const script = `const m = await import(${JSON.stringify(new URL('../config.ts', import.meta.url).href)});
console.log('@@' + JSON.stringify({ data: m.config.data.dir, training: m.config.training.dir, models: m.config.aceServer.models,
  adapters: m.config.aceServer.adapters, env: m.ENV_FILE_PATH, logs: m.LOGS_DIR, marker: m.RESTART_MARKER_PATH,
  trt: m.config.aceServer.trtLibs, portable: m.PORTABLE_MODE, root: m.PROJECT_ROOT }));`;
  const clean = { ...process.env };
  for (const k of ['HOT_STEP_ROOT', 'HOT_STEP_DATA_ROOT', 'HOT_STEP_PROFILE_DIR', 'DATA_DIR', 'ACESTEPCPP_MODELS', 'ACESTEPCPP_ADAPTERS', 'TRAINING_DIR', 'TENSORRT_LIBS']) delete clean[k];
  const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    env: { ...clean, ...env }, cwd: SERVER_DIR, encoding: 'utf-8', timeout: 60_000,
  });
  return JSON.parse(out.split('\n').find(l => l.startsWith('@@'))!.slice(2));
}

test('config in dev keeps the checkout layout', () => {
  const serverDir = SERVER_DIR;
  const c = loadConfig({});
  assert.equal(c.portable, false);
  assert.equal(c.root, path.dirname(serverDir));
  assert.equal(c.env, path.join(path.dirname(serverDir), '.env'));
  assert.equal(c.logs, path.join(path.dirname(serverDir), 'logs'));
  assert.equal(c.marker, path.join(path.dirname(serverDir), '.restart-requested'));
});

test('config in a release puts every writable default under the data folder', () => {
  const f = fixture();
  write(path.join(f.app, '.env.example'), 'DATA_DIR=./server/data\nSERVER_PORT=3001\n');
  const c = loadConfig(f.env);
  const l = dataLayout(f.sibling);
  assert.equal(c.portable, true);
  assert.equal(c.root, f.app);
  assert.equal(c.data, l.library);
  assert.equal(c.training, path.join(l.library, 'training'));
  assert.equal(c.models, l.models);
  assert.equal(c.adapters, l.adapters);
  assert.equal(c.env, l.envPath);
  assert.equal(c.logs, l.logs);
  assert.equal(c.trt, l.runtimeLibDir);
  assert.equal(c.marker, path.join(f.prof, 'restart-requested'));
  assert.doesNotMatch(fs.readFileSync(l.envPath, 'utf-8'), /^DATA_DIR=/m, 'example DATA_DIR dropped');
  for (const p of [c.data, c.models, c.adapters, c.env, c.logs]) assert.ok(!isInside(f.app, p), `${p} outside the app`);
});

// ── Review regressions ───────────────────────────────────────────────

test('an unreachable source stops the move; a finished rename with no source left still completes', () => {
  const f = fixture();
  const oldRoot = path.join(f.base, 'old-root');
  const newRoot = path.join(f.base, 'new-root');
  write(path.join(oldRoot, 'library', 'a.txt'));
  const { op } = planOperation('move', newRoot, { appRoot: f.app, currentRoot: oldRoot, currentDb: null });
  const ptr = { version: 1 as const, root: oldRoot, pending: op };
  writePointer(f.ptrFile, ptr);
  fs.renameSync(oldRoot, oldRoot + '-unplugged');
  assert.throws(() => runPending(f.ptrFile, ptr, f.app, quiet), /not reachable/);
  const kept = readPointer(f.ptrFile)!;
  assert.equal(kept.root, oldRoot);
  assert.ok(kept.pending && kept.pending.mappings[0].state === 'pending');

  // A journaled rename that finished and removed the emptied source: that is landed data.
  kept.pending!.mappings[0].method = 'rename';
  fs.mkdirSync(newRoot, { recursive: true });
  fs.renameSync(path.join(oldRoot + '-unplugged', 'library'), path.join(newRoot, 'library'));
  runPending(f.ptrFile, kept, f.app, quiet);
  assert.equal(readPointer(f.ptrFile)!.root, newRoot);
});

test('a target reached through a junction into the app or the source is refused, at plan time and again before moving', () => {
  const f = fixture();
  const cur = path.join(f.base, 'cur');
  write(path.join(cur, 'library', 'a.txt'));
  const ctx = { appRoot: f.app, currentRoot: cur, currentDb: null };
  const intoApp = path.join(f.base, 'looks-outside');
  fs.symlinkSync(f.app, intoApp, 'junction');
  assert.ok(planOperation('move', path.join(intoApp, 'Data'), ctx).errors.some(e => /inside the app/.test(e)));
  const intoSource = path.join(f.base, 'alias-of-cur');
  fs.symlinkSync(cur, intoSource, 'junction');
  assert.ok(planOperation('move', path.join(intoSource, 'Data'), ctx).errors.some(e => /overlap/.test(e)));

  // Passes at plan time, then the parent is swapped for a junction into the app.
  const parent = path.join(f.base, 'later');
  fs.mkdirSync(parent);
  const { op, errors } = planOperation('move', path.join(parent, 'Data'), ctx);
  assert.deepEqual(errors, []);
  const ptr = { version: 1 as const, root: cur, pending: op };
  writePointer(f.ptrFile, ptr);
  fs.rmdirSync(parent);
  fs.symlinkSync(f.app, parent, 'junction');
  assert.throws(() => runPending(f.ptrFile, ptr, f.app, quiet), /inside the app/);
  assert.ok(fs.existsSync(path.join(cur, 'library', 'a.txt')));
  assert.ok(!fs.existsSync(path.join(f.app, 'Data')));
});

test('import into a configured root: old settings win, current ones are kept as a backup', () => {
  const f = fixture();
  const cur = path.join(f.base, 'HOT-Step-Data');
  initLayout(dataLayout(cur));
  write(dataLayout(cur).envPath, 'GEMINI_API_KEY=new-install\n');
  const oldApp = path.join(f.base, 'HOT-Step-v1');
  write(path.join(oldApp, 'data', 'audio', 'old.wav'));
  write(path.join(oldApp, '.env'), 'GEMINI_API_KEY=old-install\n');
  const { op, errors } = planOperation('import', oldApp, { appRoot: f.app, currentRoot: cur, currentDb: null });
  assert.deepEqual(errors, []);
  const ptr = { version: 1 as const, root: cur, pending: op };
  writePointer(f.ptrFile, ptr);
  runPending(f.ptrFile, ptr, f.app, quiet);
  const l = dataLayout(cur);
  assert.match(fs.readFileSync(l.envPath, 'utf-8'), /old-install/);
  const backup = fs.readdirSync(l.settingsDir).find(n => n.startsWith('.env.before-import-'))!;
  assert.match(fs.readFileSync(path.join(l.settingsDir, backup), 'utf-8'), /new-install/);
  assert.ok(fs.existsSync(path.join(l.library, 'audio', 'old.wav')));
});

test('migration that stops on a DB collision resumes once the collision is fixed', async () => {
  const f = fixture();
  const data = path.join(f.app, 'data');
  const lib = dataLayout(f.sibling).library;
  makeDb(path.join(data, 'hotstep.db'), [
    { sourceDir: path.join(data, 'training', 'x') },
    { sourceDir: path.join(lib, 'training', 'x') },
  ]);
  write(path.join(f.app, '.env'), 'GEMINI_API_KEY=secret123\n');
  const first = await resolveRuntime({ env: f.env, log: quiet, skipEngineProbe: true });
  assert.equal(first.ok, false);
  assert.match((first as any).error, /collides/);
  assert.ok(readPointer(f.ptrFile)!.pending, 'pending kept');

  const db = new Database(path.join(lib, 'hotstep.db'));
  db.prepare('DELETE FROM training_datasets WHERE source_dir = ?').run(path.join(lib, 'training', 'x'));
  db.close();
  const second = await resolveRuntime({ env: f.env, log: quiet, skipEngineProbe: true });
  assert.ok(second.ok, !second.ok ? second.error : '');
  assert.match(fs.readFileSync(dataLayout(f.sibling).envPath, 'utf-8'), /GEMINI_API_KEY=secret123/);
  const conn = new Database(path.join(lib, 'hotstep.db'), { readonly: true });
  assert.equal((conn.prepare('SELECT source_dir FROM training_datasets').get() as any).source_dir, path.join(lib, 'training', 'x'));
  conn.close();
});

test('a copy cut short whose source then goes missing keeps pending and stops', () => {
  const f = fixture();
  const oldRoot = path.join(f.base, 'old-root');
  const newRoot = path.join(f.base, 'new-root');
  write(path.join(oldRoot, 'library', 'a.wav'), 'a');
  write(path.join(oldRoot, 'library', 'b.wav'), 'b');
  const { op } = planOperation('move', newRoot, { appRoot: f.app, currentRoot: oldRoot, currentDb: null });
  const ptr = { version: 1 as const, root: oldRoot, pending: op };
  writePointer(f.ptrFile, ptr);
  // a.wav lands, b.wav hits an obstacle.
  fs.mkdirSync(path.join(newRoot, 'library', 'b.wav'), { recursive: true });
  const real = hooks.sameVolume;
  hooks.sameVolume = () => false;
  try {
    assert.throws(() => runPending(f.ptrFile, ptr, f.app, quiet));
    assert.ok(fs.existsSync(path.join(newRoot, 'library', 'a.wav')));
    assert.equal(readPointer(f.ptrFile)!.pending!.mappings[0].method, 'copy', 'method journaled');
    fs.renameSync(oldRoot, oldRoot + '-unplugged');
    const again = readPointer(f.ptrFile)!;
    assert.throws(() => runPending(f.ptrFile, again, f.app, quiet), /not known to be complete/);
  } finally { hooks.sameVolume = real; }
  const kept = readPointer(f.ptrFile)!;
  assert.equal(kept.root, oldRoot);
  assert.equal(kept.pending!.mappings[0].state, 'pending');
  assert.ok(fs.existsSync(path.join(oldRoot + '-unplugged', 'library', 'b.wav')));
});

test('job-map busy checks block until every job has finished', async () => {
  const { registerJobsBusyCheck, getBusyBlockers } = await import('./pointer.js');
  const jobs = new Map([['a', { status: 'running' }], ['b', { status: 'done' }]]);
  registerJobsBusyCheck('fixture', jobs);
  assert.ok(getBusyBlockers().includes('1 fixture job(s) running or queued'));
  jobs.get('a')!.status = 'succeeded';
  assert.ok(!getBusyBlockers().some(b => b.includes('fixture')));
});
