// training/heartmulaRunner.ts — runs one `ace-train heartmula-prepare` or
// `heartmula-train` job.
//
// The spawn, engine stop/restore and idle watchdog are runYue2AceTrain's (one
// implementation for every ace-train subcommand). What differs is the output:
// heartmula-train speaks `HMTRAIN {json}` events on stdout (the contract is
// engine/docs/HEARTMULA_TRAINING_CONTRACT.md), and exit codes carry meaning:
// 0 done, 3 paused at a checkpoint, 4 cancelled, anything else a failure.
//
// Previews are not here: checkpoint previews are orchestrated by the preview
// slice on top of --stop-after / --resume.

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { getDataset } from './datasetsRepo.js';
import { buildSamples } from './datasetScan.js';
import {
  buildHeartmulaPrepareArgs, buildHeartmulaTrainArgs, findHeartmulaEncoderDir, missingEncoderMessage, missingHeartmulaModels,
} from './heartmulaTrain.js';
import { HEARTMULA_PREPARE_MANIFEST, snapshotSources, writeHeartmulaSamples, writeSkippedFingerprints } from './heartmulaPrepare.js';
import {
  appendLoss, blankStatus, heartmulaAdapterFile, heartmulaPrepareDir, publishHeartmulaAdapter,
  readStoredStatus, saveHeartmulaRunRecord, writeStoredStatus, type HeartmulaRunRecord,
} from './heartmulaRuns.js';
import type { HeartmulaRecipe, HeartmulaRunState } from '../../contracts/heartmulaTraining.js';
import { log, runYue2AceTrain, YUE2_IDLE_MS, type RelayState } from './yue2TrainRunner.js';
import {
  emitProgress, finishJob, isCancelled, killJobChild, pushEvent, releaseJobCleanup, type TrainingJob,
} from './labelingQueue.js';

// ── prepare ──────────────────────────────────────────────────────────────

/** `[HeartMuLa-Prepare] %zu/%zu <id>: …` and `… skip <id>: <reason> (<detail>)`, heartmula-prepare.h. */
const RE_PREP_FILE = /^\[HeartMuLa-Prepare\]\s+(\d+)\/(\d+)\s/;
const RE_PREP_SKIP = /^\[HeartMuLa-Prepare\]\s+skip\s+(\S+):\s+(.+)$/;
/** The tool's own fatal sentences: `heartmula-prepare: <message>`. */
const RE_FATAL = /^(?:heartmula-prepare|heartmula-train):\s+(.+)$/;

export interface HeartmulaPrepareJobOpts { force?: boolean }

export async function runHeartmulaPrepareJob(job: TrainingJob): Promise<void> {
  const opts = (job.opts ?? {}) as HeartmulaPrepareJobOpts;
  const st: RelayState = { fatalMessage: '', doneSeen: false, lastStep: 0, totalSteps: 0 };
  try {
    const ds = getDataset(job.datasetId);
    if (!ds) throw new Error('Dataset not found');
    const missing = missingHeartmulaModels();
    if (missing.length) throw new Error(`HeartMuLa models are missing: ${missing.join(', ')}`);
    // No fallback: without the encoder pack the codes cannot be made.
    const encoderDir = findHeartmulaEncoderDir();
    if (!encoderDir) throw new Error(missingEncoderMessage());
    const samples = await buildSamples(ds);
    if (isCancelled(job)) return;
    const before = snapshotSources(ds, samples);
    const list = writeHeartmulaSamples(ds, samples);
    if (list.count === 0) throw new Error('The dataset has no usable audio to prepare');
    const outDir = heartmulaPrepareDir(ds.slug);
    const args = buildHeartmulaPrepareArgs({
      samplesJson: list.file, outDir, modelsDir: config.aceServer.models, encoderDir, force: opts.force,
    });
    job.total = list.count;
    log(job, 'info', `Encoding ${list.count} sample(s) to HeartCodec codes.`);
    await runYue2AceTrain(job, 'heartmula-prepare', args, YUE2_IDLE_MS, () =>
      fs.existsSync(path.join(outDir, HEARTMULA_PREPARE_MANIFEST)) ? null : 'heartmula-prepare finished but wrote no manifest',
    (line, state) => {
      let m: RegExpExecArray | null;
      if ((m = RE_PREP_SKIP.exec(line))) { log(job, 'warn', `Skipped ${m[1]}: ${m[2]}`); return; }
      if ((m = RE_PREP_FILE.exec(line))) {
        job.done = Number(m[1]); job.total = Number(m[2]) || job.total; job.phase = 'encoding'; emitProgress(job);
        return;
      }
      if ((m = RE_FATAL.exec(line))) state.fatalMessage ||= m[1];
    }, st);
    if (!isCancelled(job)) {
      writeSkippedFingerprints(ds.slug, before);
      finishJob(job, 'done');
    }
  } catch (err: any) {
    if (!isCancelled(job)) finishJob(job, 'failed', err?.message || String(err));
  }
}

// ── train ────────────────────────────────────────────────────────────────

export interface HeartmulaTrainJobOpts {
  runId: string;
  runDir: string;
  record: HeartmulaRunRecord;
  resume: boolean;
}

interface HmState extends RelayState {
  started: boolean;
  checkpointStep: number | null;
  stepMsSum: number;
  stepMsCount: number;
}

/** Jobs whose trainer has printed `start`; control files before that are deleted by the engine. */
const started = new Set<string>();

function touch(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x\n');
}

/** Ask the running trainer to checkpoint and exit (paused, resumable). False if it is not running yet. */
export function requestHeartmulaCheckpoint(job: TrainingJob): boolean {
  const opts = job.opts as HeartmulaTrainJobOpts | undefined;
  if (!opts || !started.has(job.id)) return false;
  touch(path.join(opts.runDir, 'control', 'checkpoint-now'));
  return true;
}

function setStatus(opts: HeartmulaTrainJobOpts, patch: Partial<ReturnType<typeof blankStatus>>): void {
  const cur = readStoredStatus(opts.runDir) ?? blankStatus(opts.record.recipe.steps);
  writeStoredStatus(opts.runDir, { ...cur, ...patch });
}

function relayTrainLine(job: TrainingJob, opts: HeartmulaTrainJobOpts, line: string, st: HmState): void {
  if (!line.startsWith('HMTRAIN ')) {
    const m = RE_FATAL.exec(line);
    if (m) st.fatalMessage ||= m[1];
    return;
  }
  const ev = JSON.parse(line.slice('HMTRAIN '.length)) as Record<string, any>;
  const cur = readStoredStatus(opts.runDir) ?? blankStatus(opts.record.recipe.steps);
  switch (ev.event) {
    case 'start':
      st.started = true;
      started.add(job.id);
      st.totalSteps = Number(ev.total) || opts.record.recipe.steps;
      job.phase = 'training'; job.total = st.totalSteps; job.done = Number(ev.step) || 0; emitProgress(job);
      setStatus(opts, { state: 'running', step: Number(ev.step) || 0, totalSteps: st.totalSteps, startedAt: cur.startedAt ?? Date.now() });
      pushEvent(job, { type: 'metric', metric: 'data', ts: Date.now(), samples: Number(ev.samples) || undefined, totalSteps: st.totalSteps });
      log(job, 'info', `Training ${ev.samples ?? '?'} sample(s), ${st.totalSteps} steps.`);
      break;
    case 'step': {
      const step = Number(ev.step), loss = Number(ev.loss), ms = Number(ev.ms_step);
      if (!Number.isFinite(loss)) { st.fatalMessage ||= 'The trainer reported a non-finite loss'; break; }
      st.lastStep = step; st.lastLoss = loss;
      if (Number.isFinite(ms)) { st.stepMsSum += ms; st.stepMsCount++; }
      const peak = Number(ev.peak_alloc_mib);
      pushEvent(job, { type: 'metric', metric: 'step', ts: Date.now(), step, totalSteps: st.totalSteps, loss,
        stepMs: Number.isFinite(ms) ? ms : undefined, gradNorm: Number.isFinite(Number(ev.grad_norm)) ? Number(ev.grad_norm) : undefined,
        usedMb: Number.isFinite(Number(ev.device_used_mib)) ? Number(ev.device_used_mib) : undefined });
      job.done = step; emitProgress(job);
      setStatus(opts, {
        state: 'running', step, totalSteps: st.totalSteps, loss, lossHistory: appendLoss(cur.lossHistory, step, loss),
        msPerStep: st.stepMsCount ? st.stepMsSum / st.stepMsCount : cur.msPerStep,
        peakVramMiB: Number.isFinite(peak) ? Math.max(peak, cur.peakVramMiB ?? 0) : cur.peakVramMiB,
      });
      break;
    }
    case 'skip':
      log(job, 'warn', `Step ${ev.step} skipped: ${ev.reason}`);
      break;
    case 'checkpoint':
      st.checkpointStep = Number(ev.step);
      setStatus(opts, { checkpointStep: st.checkpointStep });
      pushEvent(job, { type: 'metric', metric: 'milestone', ts: Date.now(), step: st.checkpointStep, loss: st.lastLoss });
      log(job, 'info', `Checkpoint at step ${ev.step} (${ev.reason}).`);
      break;
    case 'done':
      st.doneSeen = true; st.lastStep = Number(ev.step) || st.lastStep;
      break;
    case 'error':
      st.fatalMessage ||= String(ev.message || 'The trainer reported an error');
      break;
  }
}

export async function runHeartmulaTrainJob(job: TrainingJob): Promise<void> {
  const opts = job.opts as HeartmulaTrainJobOpts | undefined;
  if (!opts?.runDir || !opts.record) { finishJob(job, 'failed', 'heartmula-train job is missing its run'); return; }
  const recipe: HeartmulaRecipe = opts.record.recipe;
  const state = (s: HeartmulaRunState, extra: Partial<ReturnType<typeof blankStatus>> = {}) => setStatus(opts, { state: s, ...extra });
  const st: HmState = {
    fatalMessage: '', doneSeen: false, lastStep: 0, totalSteps: recipe.steps, started: false,
    checkpointStep: null, stepMsSum: 0, stepMsCount: 0,
  };
  job.total = recipe.steps; job.done = 0; job.cleanupPending = true;
  // Cancel is graceful once the trainer is up: control/cancel, then a bounded kill.
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  job.cancelChild = () => {
    if (!started.has(job.id)) { killJobChild(job); return; }
    try { touch(path.join(opts.runDir, 'control', 'cancel')); } catch { killJobChild(job); return; }
    cancelTimer ??= setTimeout(() => killJobChild(job), 30_000);
  };
  try {
    const missing = missingHeartmulaModels();
    if (missing.length) throw new Error(`HeartMuLa models are missing: ${missing.join(', ')}`);
    const dataDir = heartmulaPrepareDir(getDataset(job.datasetId)?.slug ?? '');
    if (!fs.existsSync(path.join(dataDir, HEARTMULA_PREPARE_MANIFEST))) {
      throw new Error('The HeartMuLa prepare cache is gone — run Prepare again');
    }
    state('queued');
    const args = buildHeartmulaTrainArgs({
      dataDir, runDir: opts.runDir, modelsDir: config.aceServer.models, recipe, name: opts.record.adapterName, resume: opts.resume,
    });
    log(job, 'info', `${opts.resume ? 'Resuming' : 'Starting'}: ${recipe.steps} steps at rank ${recipe.rank}/alpha ${recipe.alpha}.`);
    await runYue2AceTrain(job, 'heartmula-train', args, YUE2_IDLE_MS, () => null,
      (line, s) => relayTrainLine(job, opts, line, s), st, undefined, true, [0, 3]);

    if (isCancelled(job)) { state('cancelled'); return; }
    if (st.exitCode === 3) {
      // Paused at a checkpoint by checkpoint-now: resumable, not finished.
      state('cancelled', { checkpointStep: st.checkpointStep ?? readStoredStatus(opts.runDir)?.checkpointStep ?? null });
      log(job, 'info', `Paused at step ${st.lastStep}. Resume the run to continue.`);
      job.phase = 'paused';
      finishJob(job, 'done');
      return;
    }
    // Exit 0 is finished; a resume of a finished run prints no steps, so fall back to the stored one.
    const finalStep = st.lastStep || readStoredStatus(opts.runDir)?.step || recipe.steps;
    const final = heartmulaAdapterFile(opts.runDir, finalStep);
    if (!fs.existsSync(final)) throw new Error('The trainer finished but wrote no adapter');
    const published = publishHeartmulaAdapter(final, `${opts.record.adapterName}-${path.basename(opts.runDir)}`);
    saveHeartmulaRunRecord(opts.runDir, { ...opts.record, published });
    state('done', { step: finalStep, adapterFile: published, error: null });
    log(job, 'info', `Published HeartMuLa adapter: ${published}`);
    finishJob(job, 'done');
  } catch (err: any) {
    const message = err?.message || String(err);
    if (isCancelled(job)) state('cancelled'); else state('failed', { error: message });
    if (!isCancelled(job)) finishJob(job, 'failed', message);
  } finally {
    clearTimeout(cancelTimer);
    started.delete(job.id);
    job.cancelChild = undefined;
    releaseJobCleanup(job);
  }
}
