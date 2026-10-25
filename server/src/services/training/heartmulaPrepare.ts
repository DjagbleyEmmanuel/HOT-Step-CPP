// training/heartmulaPrepare.ts — what the dataset hands `ace-train heartmula-prepare`,
// and what the server reads back from its manifest.
//
// The engine owns the cache fingerprint (codes keyed on audio bytes, mtime and
// encoder hashes). The server only needs to know, without starting the engine,
// whether a prepared sample still matches its source: the contract's rule is
// "size or whole-second mtime of the audio, or tags or lyrics, differ".

import fs from 'node:fs';
import path from 'node:path';
import type {
  HeartmulaPrepareStatus, HeartmulaSkipReason, HeartmulaSkippedSample,
} from '../../contracts/heartmulaTraining.js';
import type { TrainingDatasetRow, TrainingSample } from './types.js';
import { heartmulaPrepareDir } from './heartmulaRuns.js';

export const HEARTMULA_PREPARE_MANIFEST = 'heartmula_prepare.json';
const SKIP_REASONS: readonly string[] = ['invalid', 'over-context', 'no-audio', 'encode-failed'];

export interface HeartmulaSampleInput { id: string; audio: string; tags: string; lyrics: string }

/** Samples that can train: not excluded, audio on disk. */
export const trainableSamples = (samples: TrainingSample[]): TrainingSample[] =>
  samples.filter(s => !s.excluded && !s.fileMissing);

/**
 * Tags are the caption and genre as comma-separated tags, led by the trigger
 * word (the sample's own, else the dataset's). Lyrics are empty for an
 * instrumental. The same text goes to prepare and to the stale check.
 */
export function heartmulaSampleInput(ds: Pick<TrainingDatasetRow, 'customTag'>, s: TrainingSample): HeartmulaSampleInput {
  const parts = [s.customTag || ds.customTag || '', s.caption, s.genre].map(p => p.trim()).filter(Boolean);
  const seen = new Set<string>();
  const tags = parts.filter(p => !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase())).join(', ');
  return { id: s.sampleId, audio: s.audioPath, tags, lyrics: s.isInstrumental ? '' : s.lyrics.trim() };
}

/** Write the sample list the engine reads; returns its path and the count. */
export function writeHeartmulaSamples(ds: TrainingDatasetRow, samples: TrainingSample[]): { file: string; count: number } {
  const dir = heartmulaPrepareDir(ds.slug);
  fs.mkdirSync(dir, { recursive: true });
  const list = trainableSamples(samples).map(s => heartmulaSampleInput(ds, s));
  const file = path.join(dir, 'samples.json');
  fs.writeFileSync(`${file}.part`, JSON.stringify({ samples: list }), 'utf8');
  fs.renameSync(`${file}.part`, file);
  return { file, count: list.length };
}

interface ManifestRow { id: string; audio: string; audio_bytes: number; audio_mtime_s: number; tags: string; lyrics: string }
interface Manifest {
  version: number; created_at?: string; context_limit?: number;
  samples: ManifestRow[]; skipped?: { id: string; reason: string; detail: string }[];
}

export function readHeartmulaManifest(slug: string): Manifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(heartmulaPrepareDir(slug), HEARTMULA_PREPARE_MANIFEST), 'utf8')) as Manifest;
    return Array.isArray(m.samples) ? m : null;
  } catch { return null; }
}

function sourceMatches(row: ManifestRow, input: HeartmulaSampleInput | undefined): boolean {
  if (!input || input.tags !== row.tags || input.lyrics !== row.lyrics) return false;
  try {
    const st = fs.statSync(input.audio);
    return st.size === row.audio_bytes && Math.floor(st.mtimeMs / 1000) === row.audio_mtime_s;
  } catch { return false; }
}

/**
 * Prepare state of a dataset, from the manifest and the live samples. Stale =
 * a prepared sample whose source changed or went away; a sample the dataset
 * has that the manifest lacks makes the cache invalid too. `cacheValid` needs
 * at least one prepared sample and nothing stale or missing.
 */
export function heartmulaPrepareStatus(ds: TrainingDatasetRow, samples: TrainingSample[]): HeartmulaPrepareStatus {
  const m = readHeartmulaManifest(ds.slug);
  if (!m) return { cacheValid: false, cacheVersion: null, preparedSamples: 0, staleSamples: 0, skipped: [], contextLimit: null, preparedAt: null };
  const live = new Map(trainableSamples(samples).map(s => [s.sampleId, heartmulaSampleInput(ds, s)]));
  const stale = m.samples.filter(r => !sourceMatches(r, live.get(r.id))).length;
  const skippedIds = new Set((m.skipped ?? []).map(s => s.id));
  const unseen = [...live.keys()].filter(id => !m.samples.some(r => r.id === id) && !skippedIds.has(id)).length;
  const skipped: HeartmulaSkippedSample[] = (m.skipped ?? []).map(s => ({
    sampleId: s.id, reason: (SKIP_REASONS.includes(s.reason) ? s.reason : 'invalid') as HeartmulaSkipReason, detail: s.detail,
  }));
  return {
    cacheValid: m.samples.length > 0 && stale === 0 && unseen === 0,
    cacheVersion: m.version, preparedSamples: m.samples.length, staleSamples: stale + unseen, skipped,
    contextLimit: m.context_limit ?? null, preparedAt: m.created_at ?? null,
  };
}
