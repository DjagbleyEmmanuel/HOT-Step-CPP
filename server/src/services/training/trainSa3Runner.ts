import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { config } from '../../config.js';
import { buildGpuEnv } from '../gpuDevices.js';
import { restartAceServer, stopAceServer } from '../aceEngineProcess.js';
import { tokenizeForSa3 } from '../sa3Tokenizer.js';
import { aceTrainExe, buildSa3TrainArgs, engineGpuBackend, resolveSa3Recipe, type Sa3Recipe } from './aceTrain.js';
import { newRunDir, publishSa3Export, sa3RunsRoot } from './adapterLayout.js';
import { getDataset } from './datasetsRepo.js';
import { buildSamples } from './datasetScan.js';
import { prepareSa3Dataset } from './sa3Dataset.js';
import { emitJob, emitProgress, finishJob, isCancelled, killJobChild, pushEvent, releaseJobCleanup, trainerLine, type TrainingJob } from './labelingQueue.js';

export interface Sa3Run extends Sa3Recipe {
  datasetId: string; adapterName: string; runDir: string; modelsDir: string;
  baseDit: string; inferenceDit: string; manifest: string; resume: boolean;
  published?: string; baseSha256?: string; inferenceSha256?: string;
}

const RECIPE_KEYS = ['steps', 'rank', 'alpha', 'learningRate', 'duration', 'seed', 'checkpointEvery', 'exportEvery'];
const MODEL_FILES = ['sa3-dit-base-BF16.gguf', 'sa3-dit-BF16.gguf', 'sa3-same-enc-F16.gguf', 'sa3-text-enc-BF16.gguf',
  'onnx/sa3/tokenizer.json', 'onnx/sa3/tokenizer_config.json', 'supersep/bs_leap_xe_voc-F32.gguf', 'supersep/bs_leap_xe_inst-F32.gguf'];

export function sa3Readiness(modelsDir = config.aceServer.models, backend = engineGpuBackend()) {
  const missing = MODEL_FILES.filter(f => !fs.existsSync(path.join(modelsDir, f)));
  return { available: (backend === 'cuda' || backend === 'cpu') && missing.length === 0 && !!aceTrainExe(), backend, missing,
    defaults: resolveSa3Recipe({}) };
}

function readRun(dir: string): Sa3Run {
  return JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) as Sa3Run;
}

function saveRun(run: Sa3Run): void {
  const target = path.join(run.runDir, 'run.json');
  fs.writeFileSync(`${target}.part`, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  fs.renameSync(`${target}.part`, target);
}

/** Admission is synchronous: reserve the output before another POST can see
 * the same timestamp. Caller checks per-dataset queue/pipeline exclusivity. */
export function resolveSa3Run(datasetId: string, slug: string, input: Record<string, unknown>): Sa3Run {
  for (const key of Object.keys(input)) {
    if (![...RECIPE_KEYS, 'adapterName', 'resumeRun'].includes(key)) throw new Error(`Unsupported SA3 option: ${key}`);
  }
  const ready = sa3Readiness();
  if (!ready.available) throw new Error(`SA3 training requires CUDA or CPU, ace-train and all models (backend: ${ready.backend}; missing: ${ready.missing.join(', ')})`);
  const root = sa3RunsRoot(slug);
  if (input.resumeRun !== undefined) {
    if (typeof input.resumeRun !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}\/[0-9][0-9_-]*$/i.test(input.resumeRun)) throw new Error('Invalid SA3 resumeRun');
    const dir = path.join(root, ...input.resumeRun.split('/'));
    const realRoot = fs.realpathSync(root), realDir = fs.realpathSync(dir);
    if (!realDir.startsWith(realRoot + path.sep)) throw new Error('SA3 resume is outside the dataset runs');
    const saved = readRun(dir);
    if (saved.datasetId !== datasetId) throw new Error('SA3 resume belongs to another dataset');
    for (const key of [...RECIPE_KEYS.filter(k => k !== 'steps'), 'adapterName']) {
      if (input[key] !== undefined && input[key] !== saved[key as keyof Sa3Run]) throw new Error(`SA3 resume cannot change ${key}`);
    }
    const recipe = resolveSa3Recipe({ ...saved, ...(input.steps === undefined ? {} : { steps: input.steps }) });
    if (recipe.steps < saved.steps) throw new Error('SA3 resume cannot reduce steps');
    if (!fs.existsSync(path.join(dir, 'state.gguf')) || !fs.existsSync(path.join(dir, 'train-manifest.json'))) throw new Error('SA3 resume has no checkpoint or manifest');
    // Rebind managed paths after a data-folder move. The engine verifies model,
    // text and timing fingerprints against the saved optimizer state.
    const run: Sa3Run = { ...saved, ...recipe, ...modelPaths(), runDir: dir,
      manifest: path.join(dir, 'train-manifest.json'), resume: true, published: undefined };
    saveRun(run);
    return run;
  }
  const adapterName = input.adapterName ?? slug;
  if (typeof adapterName !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(adapterName)) throw new Error('Invalid SA3 adapterName');
  const recipe = resolveSa3Recipe(input);
  const runDir = newRunDir(path.join(root, adapterName));
  fs.mkdirSync(runDir, { recursive: true });
  const run: Sa3Run = { ...recipe, ...modelPaths(), datasetId, adapterName, runDir,
    manifest: path.join(runDir, 'train-manifest.json'), resume: false };
  saveRun(run);
  return run;
}

function modelPaths() {
  const modelsDir = config.aceServer.models;
  return { modelsDir, baseDit: path.join(modelsDir, 'sa3-dit-base-BF16.gguf'), inferenceDit: path.join(modelsDir, 'sa3-dit-BF16.gguf') };
}

export function listSa3Runs(datasetId: string, slug: string) {
  const root = sa3RunsRoot(slug);
  if (!fs.existsSync(root)) return [];
  const runs = [];
  for (const name of fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory())) {
    for (const stamp of fs.readdirSync(path.join(root, name.name), { withFileTypes: true }).filter(e => e.isDirectory())) {
      try {
        const dir = path.join(root, name.name, stamp.name), run = readRun(dir);
        if (run.datasetId !== datasetId) continue;
        runs.push({ run: `${name.name}/${stamp.name}`, adapterName: run.adapterName,
          recipe: resolveSa3Recipe(run as unknown as Record<string, unknown>),
          resumable: fs.existsSync(path.join(dir, 'state.gguf')), published: run.published ?? null,
          baseSha256: run.baseSha256, inferenceSha256: run.inferenceSha256 });
      } catch { /* incomplete/corrupt run record */ }
    }
  }
  return runs.sort((a, b) => b.run.localeCompare(a.run));
}

async function prepare(job: TrainingJob, run: Sa3Run): Promise<void> {
  if (run.resume) return; // resume the immutable prepared snapshot
  const ds = getDataset(job.datasetId);
  if (!ds) throw new Error('Dataset not found');
  const samples = (await buildSamples(ds)).filter(s => !s.excluded && !s.fileMissing);
  const exportDir = path.join(run.runDir, 'dataset');
  const manifest = await prepareSa3Dataset({
    samples: samples.map(s => ({ audio_path: s.audioPath, metadata: {
      caption: s.caption, genre: s.genre, bpm: s.bpm, key: s.key, signature: s.signature,
    } })), exportDir, cacheDir: path.join(config.aceServer.adapters, 'sa3-cache'),
    modelFiles: ['bs_leap_xe_voc-F32.gguf', 'bs_leap_xe_inst-F32.gguf'].map(f => path.join(run.modelsDir, 'supersep', f)),
    engineUrl: `http://${config.aceServer.host}:${config.aceServer.port}`, signal: job.controller.signal,
    onProgress: (done, total) => { job.done = done; job.total = total; emitProgress(job); },
  });
  const tokenized = [];
  for (const sample of manifest.samples) {
    job.controller.signal.throwIfAborted();
    const tokens = await tokenizeForSa3(sample.prompt);
    // Relative paths survive moving the adapter root to another drive.
    tokenized.push({ ...sample, audio_path: `dataset/${sample.audio_path}`, token_ids: tokens.ids, n_tokens: tokens.nTokens });
  }
  fs.writeFileSync(run.manifest, `${JSON.stringify({ samples: tokenized }, null, 2)}\n`, 'utf8');
}

interface Execution { done: boolean; stopped: boolean; error: string; baseSha256: string; inferenceSha256: string }
export async function executeSa3Train(job: TrainingJob, run: Sa3Run, launch = spawn): Promise<Execution> {
  const exe = aceTrainExe();
  if (!exe) throw new Error('ace-train was not found');
  const args = buildSa3TrainArgs(run);
  trainerLine(job, `$ ${exe} ${args.join(' ')}`);
  const child = launch(exe, args, { windowsHide: true, env: buildGpuEnv().env });
  job.child = child;
  const state: Execution = { done: false, stopped: false, error: '', baseSha256: '', inferenceSha256: '' };
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  job.cancelChild = () => {
    try { fs.writeFileSync(path.join(run.runDir, 'STOP'), 'stop\n'); }
    catch { killJobChild(job); }
    // Encoding/startup does not observe STOP. Bound cancellation even there.
    cancelTimer ??= setTimeout(() => killJobChild(job), 30_000);
  };
  const timer = setTimeout(() => { timedOut = true; killJobChild(job); }, 24 * 60 * 60 * 1000);
  const stderr: string[] = [];
  child.stderr?.on('data', (buf: Buffer) => {
    for (const line of buf.toString('utf8').split(/[\r\n]+/).filter(Boolean)) {
      trainerLine(job, line); stderr.push(line); if (stderr.length > 10) stderr.shift();
    }
  });
  const rl = readline.createInterface({ input: child.stdout! });
  rl.on('line', line => {
    trainerLine(job, line);
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'error') state.error = String(ev.message || 'SA3 trainer error');
      if (ev.type === 'done') state.done = true;
      if (ev.type === 'stopped') state.stopped = true;
      if (ev.type === 'start') {
        state.baseSha256 = String(ev.baseSha256 ?? ''); state.inferenceSha256 = String(ev.inferenceSha256 ?? '');
        if (!/^(CUDA\d*|CPU)$/i.test(String(ev.backend))) state.error = `Unsupported SA3 trainer backend: ${ev.backend}`;
        if (ev.trainSeconds !== false) state.error = 'SA3 seconds adapter cannot be published';
      }
      if (ev.type === 'progress') {
        job.phase = 'encode'; job.done = Number(ev.completed) || 0; job.total = Number(ev.total) || 0; emitProgress(job);
      }
      if (ev.type === 'step' && Number.isFinite(ev.loss) && Number.isSafeInteger(ev.step)) {
        job.phase = 'train'; job.done = ev.step; job.total = run.steps; emitProgress(job);
        pushEvent(job, { type: 'metric', metric: 'step', ts: Date.now(), step: ev.step,
          totalSteps: run.steps, loss: ev.loss, stepMs: Number.isFinite(ev.ms) ? ev.ms : undefined });
      }
      if (ev.type === 'step' && !Number.isFinite(ev.loss)) state.error = 'SA3 trainer reported a non-finite loss';
    } catch { /* non-JSON diagnostic output */ }
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
    });
    if (isCancelled(job)) return state;
    if (timedOut) throw new Error('SA3 training exceeded its 24 hour budget');
    if (state.error) throw new Error(state.error);
    if (code !== 0) throw new Error(`SA3 trainer exited with code ${code}: ${stderr.join(' | ')}`);
    return state;
  } finally {
    clearTimeout(timer); clearTimeout(cancelTimer); rl.close(); job.child = undefined; job.cancelChild = undefined;
  }
}

export interface Sa3RunnerDependencies {
  prepare: typeof prepare; execute: (job: TrainingJob, run: Sa3Run) => Promise<Execution>;
  stop: typeof stopAceServer; restart: typeof restartAceServer;
  publish: typeof publishSa3Export;
}

export async function runSa3TrainJob(job: TrainingJob, injected: Partial<Sa3RunnerDependencies> = {}): Promise<void> {
  if (isCancelled(job)) return;
  const deps = { prepare, execute: executeSa3Train, stop: stopAceServer, restart: restartAceServer, publish: publishSa3Export, ...injected };
  const run = job.opts as Sa3Run;
  let stopped = false, error: string | undefined;
  job.status = 'running'; job.startedAt = Date.now(); job.cleanupPending = true; job.phase = 'prepare'; emitJob(job);
  try {
    await deps.prepare(job, run);
    if (isCancelled(job)) return;
    // Include a throwing/unsuccessful stop in the restoration scope.
    job.phase = 'engine-stop'; emitProgress(job); stopped = true;
    if (!await deps.stop('Paused for SA3 training')) throw new Error('Engine did not shut down for SA3 training');
    if (isCancelled(job)) return;
    job.phase = 'loading-models'; job.total = run.steps; job.done = 0; emitProgress(job);
    const result = await deps.execute(job, run);
    if (isCancelled(job)) return;
    if (!result.done || result.stopped || result.error) throw new Error(result.error || 'SA3 trainer stopped without a completed export');
    if (![result.baseSha256, result.inferenceSha256].every(s => /^[a-f0-9]{64}$/.test(s))) throw new Error('SA3 trainer omitted base provenance');
    for (const name of ['state.gguf', 'adapter-raw.gguf']) {
      const file = path.join(run.runDir, name), fd = fs.openSync(file, 'r');
      try {
        const header = Buffer.alloc(24);
        if (fs.readSync(fd, header, 0, 24, 0) !== 24 || header.toString('ascii', 0, 4) !== 'GGUF'
          || header.readUInt32LE(4) !== 3 || header.readBigUInt64LE(8) === 0n) throw new Error(`SA3 trainer wrote invalid ${name}`);
      } finally { fs.closeSync(fd); }
    }
    job.phase = 'export'; emitProgress(job);
    run.baseSha256 = result.baseSha256; run.inferenceSha256 = result.inferenceSha256;
    run.published = deps.publish(path.join(run.runDir, 'adapter.gguf'),
      `${run.adapterName}-${path.basename(run.runDir)}`, `stabilityai/stable-audio-3-medium sha256:${result.inferenceSha256}`, run.modelsDir);
    saveRun(run);
    pushEvent(job, { type: 'log', level: 'info', ts: Date.now(), message: `Published SA3 adapter: ${run.published}` });
  } catch (err: any) { error = err.message || String(err); }
  finally {
    if (stopped) {
      job.phase = 'engine-restart'; emitProgress(job);
      try { if (!await deps.restart()) throw new Error('Engine did not restart after SA3 training'); }
      catch (err: any) {
        error = [error, err.message].filter(Boolean).join('; ');
        pushEvent(job, { type: 'log', level: 'error', ts: Date.now(), message: err.message });
      }
    }
    releaseJobCleanup(job);
    if (!isCancelled(job)) { job.phase = error ? 'failed' : 'done'; finishJob(job, error ? 'failed' : 'done', error); }
  }
}
