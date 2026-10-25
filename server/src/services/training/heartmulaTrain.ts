// training/heartmulaTrain.ts — recipe validation, model discovery and argv for
// `ace-train heartmula-prepare` / `heartmula-train`.
//
// The CLI contract is engine/docs/HEARTMULA_TRAINING_CONTRACT.md and the header
// of engine/src/train/heartmula-train-run.h. Recipe defaults live in
// contracts/heartmulaTraining.ts and nowhere else.

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import {
  HEARTMULA_RECIPE_DEFAULTS, type HeartmulaRecipe,
} from '../../contracts/heartmulaTraining.js';

export const HEARTMULA_RECIPE_KEYS = Object.keys(HEARTMULA_RECIPE_DEFAULTS) as (keyof HeartmulaRecipe)[];

const MODEL_FILES = [
  /^heartmula-3b-global-F16\.gguf$/i, /^heartmula-3b-local-F16\.gguf$/i, /^heartmula-tokenizer\.gguf$/i,
  /^heartcodec-rvq-.+\.gguf$/i,
];
const ENCODER_FILES = ['muencoder', 'wavlm', 'whisper', 'query'].map(role => `heartcodec-${role}-F16.gguf`);

/** Where the engine looks for models: `<models>/heartmula`, then `<models>`. */
export function heartmulaModelDirs(modelsDir = config.aceServer.models): string[] {
  return [path.join(modelsDir, 'heartmula'), modelsDir];
}

function namesIn(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/** Human names of the base-model files that are not installed (empty = ready). */
export function missingHeartmulaModels(modelsDir = config.aceServer.models): string[] {
  const names = heartmulaModelDirs(modelsDir).flatMap(namesIn);
  return ['heartmula-3b-global-F16.gguf', 'heartmula-3b-local-F16.gguf', 'heartmula-tokenizer.gguf', 'heartcodec-rvq-<quant>.gguf']
    .filter((_, i) => !names.some(n => MODEL_FILES[i].test(n)));
}

/**
 * The directory holding the HeartCodec encoder pack (all four F16 files), or
 * null. Only the models folder is searched: the oracle checkout is never a
 * source. Nothing downloads the pack today (the model registry has no
 * HeartMuLa entries), so a missing pack is reported with the file names.
 */
export function findHeartmulaEncoderDir(modelsDir = config.aceServer.models): string | null {
  for (const dir of heartmulaModelDirs(modelsDir)) {
    const names = new Set(namesIn(dir).map(n => n.toLowerCase()));
    if (ENCODER_FILES.every(f => names.has(f.toLowerCase()))) return dir;
  }
  return null;
}

export const missingEncoderMessage = (modelsDir = config.aceServer.models): string =>
  `The HeartCodec encoder pack is not installed. Put ${ENCODER_FILES.join(', ')} in ${path.join(modelsDir, 'heartmula')}.`;

// ── Recipe ───────────────────────────────────────────────────────────────

function int(v: unknown, key: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${key} must be a whole number from ${min} to ${max}`);
  return n;
}

/** Defaults under any given keys; unknown keys and out-of-range values throw. */
export function resolveHeartmulaRecipe(input: Record<string, unknown> | undefined): HeartmulaRecipe {
  const src = input ?? {};
  for (const key of Object.keys(src)) {
    if (!(HEARTMULA_RECIPE_KEYS as string[]).includes(key)) throw new Error(`Unsupported HeartMuLa recipe key: ${key}`);
  }
  const r: HeartmulaRecipe = { ...HEARTMULA_RECIPE_DEFAULTS };
  if (src.rank !== undefined) r.rank = int(src.rank, 'rank', 1, 256);
  if (src.steps !== undefined) r.steps = int(src.steps, 'steps', 1, 100_000);
  if (src.gradAccum !== undefined) r.gradAccum = int(src.gradAccum, 'gradAccum', 1, 64);
  if (src.seed !== undefined) r.seed = int(src.seed, 'seed', 0, Number.MAX_SAFE_INTEGER);
  if (src.checkpointEvery !== undefined) r.checkpointEvery = int(src.checkpointEvery, 'checkpointEvery', 0, 100_000);
  for (const key of ['alpha', 'learningRate'] as const) {
    if (src[key] === undefined) continue;
    const n = Number(src[key]);
    if (!Number.isFinite(n) || n <= 0 || n > (key === 'learningRate' ? 1 : 1024)) throw new Error(`${key} is out of range`);
    r[key] = n;
  }
  return r;
}

// ── argv ─────────────────────────────────────────────────────────────────

export function buildHeartmulaPrepareArgs(o: {
  samplesJson: string; outDir: string; modelsDir: string; encoderDir: string; ffmpeg?: string; force?: boolean;
}): string[] {
  return ['heartmula-prepare', '--dataset', o.samplesJson, '--out', o.outDir, '--models', o.modelsDir,
    '--encoder', o.encoderDir, ...(o.ffmpeg ? ['--ffmpeg', o.ffmpeg] : []), ...(o.force ? ['--force'] : [])];
}

export function buildHeartmulaTrainArgs(o: {
  dataDir: string; runDir: string; modelsDir: string; recipe: HeartmulaRecipe; name: string; resume: boolean;
}): string[] {
  const r = o.recipe;
  return ['heartmula-train', '--data', o.dataDir, '--out', o.runDir, '--models', o.modelsDir,
    '--steps', String(r.steps), '--rank', String(r.rank), '--alpha', String(r.alpha), '--lr', String(r.learningRate),
    '--grad-accum', String(r.gradAccum), '--seed', String(r.seed), '--save-every', String(r.checkpointEvery),
    '--name', o.name, ...(o.resume ? ['--resume'] : [])];
}
