// training/heartmulaStatus.ts — GET /datasets/:id/heartmula-status, and the
// HeartMuLa block of the dataset asset chips.

import fs from 'node:fs';
import path from 'node:path';
import {
  HEARTMULA_PREVIEW_DEFAULTS, HEARTMULA_RECIPE_DEFAULTS,
  type HeartmulaDatasetAssets, type HeartmulaReadiness, type HeartmulaStatusResponse,
} from '../../contracts/heartmulaTraining.js';
import { aceTrainExe, engineGpuBackend } from './aceTrain.js';
import { listGpusSync, selectedGpuMemoryMB, type NvidiaGpu } from '../gpuDevices.js';
import { buildSamples } from './datasetScan.js';
import { activeJobForDataset } from './labelingQueue.js';
import { findHeartmulaEncoderDir, missingEncoderMessage, missingHeartmulaModels } from './heartmulaTrain.js';
import { heartmulaPrepareStatus, readHeartmulaManifest } from './heartmulaPrepare.js';
import {
  heartmulaRunStatus, latestHeartmulaAdapter, listHeartmulaRuns,
} from './heartmulaRuns.js';
import type { HeartmulaTrainJobOpts } from './heartmulaRunner.js';
import type { TrainingDatasetRow } from './types.js';

/** The 3B trainer's measured peak is about 18 GiB allocated; below this a step cannot fit. */
export const HEARTMULA_MIN_VRAM_MB = 20 * 1024;

/**
 * Why the card training would run on cannot train, or null. Gated per device:
 * the selected GPU (Settings, else the only one) must be known and have enough
 * memory. An unidentified card is refused rather than trusted.
 */
export function heartmulaDeviceProblem(gpus: NvidiaGpu[] = listGpusSync()): string | null {
  let mb: number | null;
  try { mb = selectedGpuMemoryMB(undefined, gpus); } catch (err: any) { return err.message; }
  if (mb === null) return 'The selected GPU could not be identified, so HeartMuLa training cannot check that it fits.';
  return mb >= HEARTMULA_MIN_VRAM_MB ? null
    : `The selected GPU has ${Math.round(mb / 1024)} GB; HeartMuLa training needs at least ${HEARTMULA_MIN_VRAM_MB / 1024} GB.`;
}

/** CUDA builds on a big enough card only: the trainer is validated nowhere else. */
export function heartmulaReadiness(gpus?: NvidiaGpu[]): HeartmulaReadiness {
  const backend = engineGpuBackend();
  const missingModels = missingHeartmulaModels();
  const deviceProblem = backend === 'cuda' ? heartmulaDeviceProblem(gpus) : null;
  const encoderMissing = findHeartmulaEncoderDir() === null;
  return {
    available: backend === 'cuda' && deviceProblem === null && missingModels.length === 0 && !!aceTrainExe(),
    backend, missingModels, deviceProblem, encoderMissing, encoderHelp: encoderMissing ? missingEncoderMessage() : null,
  };
}

/** The id of the run the dataset's live heartmula-train job is working on, if any. */
function liveRunId(ds: TrainingDatasetRow): string | null {
  const job = activeJobForDataset(ds.id);
  return job?.kind === 'heartmula-train' ? (job.opts as HeartmulaTrainJobOpts | undefined)?.runId ?? null : null;
}

export async function heartmulaStatus(ds: TrainingDatasetRow): Promise<HeartmulaStatusResponse> {
  const live = liveRunId(ds);
  const runs = listHeartmulaRuns(ds.id, ds.slug);
  const summaries = runs.map(r => {
    const status = heartmulaRunStatus(r, r.id === live);
    return {
      run: r.id, adapterName: r.record.adapterName, recipe: r.record.recipe, state: status.state, step: status.step,
      resumable: !r.record.published && fs.existsSync(path.join(r.dir, 'hm_train_state.bin')), published: r.record.published ?? null,
    };
  });
  const current = runs.find(r => r.id === live) ?? runs[0];
  return {
    ready: heartmulaReadiness(), runs: summaries, base: '3B',
    prepare: heartmulaPrepareStatus(ds, await buildSamples(ds)),
    run: current ? heartmulaRunStatus(current, current.id === live) : null,
    adapter: latestHeartmulaAdapter(ds.id, ds.slug),
    defaults: HEARTMULA_RECIPE_DEFAULTS, previewDefaults: HEARTMULA_PREVIEW_DEFAULTS,
  };
}

/**
 * The chips' block. Cheap on purpose (no source scan, it runs for every row of
 * the dataset list): `prepared` means a manifest with samples exists; whether it
 * still matches the sources is the status route's `cacheValid`.
 */
export function readHeartmulaDatasetAssets(ds: TrainingDatasetRow): HeartmulaDatasetAssets {
  const manifest = readHeartmulaManifest(ds.slug);
  const preparedSamples = manifest?.samples.length ?? 0;
  return {
    prepared: preparedSamples > 0, preparedSamples, adapter: latestHeartmulaAdapter(ds.id, ds.slug),
  };
}
