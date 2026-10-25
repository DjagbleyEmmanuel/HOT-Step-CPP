// HeartMuLa backbone-LoRA training contracts shared by the Node server and the
// React UI (types and constants only). Slice 2 of HOTSTEP-767.
//
// Owned by the HeartMuLa training batch. The server slices (prepare, train,
// runner, preview) and the UI leaves build on these read-only; a change goes
// back to the owner of this file. The FROZEN SA3 shapes in ./training.ts are
// untouched.
//
// Routes these types describe (all scoped by the dataset, never by a path the
// browser supplies):
//   POST /datasets/:id/heartmula-prepare          <- HeartmulaPrepareRequest
//   POST /datasets/:id/heartmula-train            <- HeartmulaTrainRequest
//   POST /datasets/:id/heartmula-checkpoint       <- HeartmulaCheckpointNowRequest
//   GET  /datasets/:id/heartmula-status           -> HeartmulaStatusResponse
//   GET  /datasets/:id/heartmula-previews?run=    -> HeartmulaPreviewListResponse
//   POST /datasets/:id/heartmula-previews/render  <- HeartmulaPreviewRenderRequest, -> HeartmulaPreviewListResponse
//   GET  /datasets/:id/heartmula-previews/audio?run=&file= -> audio bytes

/**
 * Training target id. Not yet a member of TRAINING_TARGET_IDS in ./training.ts:
 * widening that union breaks the exhaustive Record<TrainingTargetId, ...> maps
 * in the UI registry, so slice 5 adds it together with those entries.
 */
export const HEARTMULA_TARGET_ID = 'heartmula' as const;
export type HeartmulaTargetId = typeof HEARTMULA_TARGET_ID;

/** Job kinds the HeartMuLa pipeline submits (already members of TrainingJobKind). */
export const HEARTMULA_JOB_KINDS = ['heartmula-prepare', 'heartmula-train'] as const;
export type HeartmulaJobKind = typeof HEARTMULA_JOB_KINDS[number];

/** `<adapterName>/<timestamp>`, the same shape as Sa3RunId. */
export type HeartmulaRunId = string;

/** Base model sizes the trainer targets. v1 is the 3B base only. */
export type HeartmulaBase = '3B';

// ── Recipe ───────────────────────────────────────────────────────────────

/** Backbone LoRA recipe. Every key is optional on the wire; omitted means the default below. */
export interface HeartmulaRecipe {
  rank: number;
  alpha: number;
  learningRate: number;
  steps: number;
  /** Micro-batches accumulated per optimizer step. */
  gradAccum: number;
  seed: number;
  /** Write a resumable checkpoint every N steps; 0 = only on stop/finish. */
  checkpointEvery: number;
}

/** r64/alpha64 as decided. The other numbers follow the Python oracle run until slice 1 pins them. */
export const HEARTMULA_RECIPE_DEFAULTS: HeartmulaRecipe = {
  rank: 64,
  alpha: 64,
  learningRate: 1e-4,
  steps: 480,
  gradAccum: 1,
  seed: 0,
  checkpointEvery: 100,
};

// ── Prepare ──────────────────────────────────────────────────────────────

/** Why a sample was left out of the prepared set. */
export type HeartmulaSkipReason = 'invalid' | 'over-context' | 'no-audio' | 'encode-failed';

export interface HeartmulaPrepareRequest {
  /** Rebuild every sample even when the cache fingerprint validates. */
  force?: boolean;
}

export interface HeartmulaSkippedSample {
  sampleId: string;
  reason: HeartmulaSkipReason;
  detail: string;
}

/** What the prepare stage has on disk for a dataset. */
export interface HeartmulaPrepareStatus {
  /** True only when the versioned cache fingerprint validates. */
  cacheValid: boolean;
  /** Cache fingerprint version the engine wrote; null when none. */
  cacheVersion: number | null;
  preparedSamples: number;
  /** Samples whose source changed since they were prepared. */
  staleSamples: number;
  skipped: HeartmulaSkippedSample[];
  /** Model context limit in tokens the over-context check used; null when unknown. */
  contextLimit: number | null;
  /** ISO timestamp of the last successful prepare, null when never. */
  preparedAt: string | null;
}

// ── Train ────────────────────────────────────────────────────────────────

export interface HeartmulaPreviewSettings {
  /** Render every N training steps; 0 turns checkpoint previews off. */
  everySteps: number;
  /** One fixed fixture so takes are comparable across steps. */
  tags: string;
  lyrics: string;
  /** Seconds of audio per render (v1 default 30). */
  seconds: number;
  seed: number;
}

export interface HeartmulaTrainRequest {
  /** Adapter name; omitted = the dataset slug. */
  adapterName?: string;
  recipe?: Partial<HeartmulaRecipe>;
  preview?: Partial<HeartmulaPreviewSettings>;
  /** Continue this run from its latest checkpoint. Omitted = a new run. */
  resumeRun?: HeartmulaRunId;
}

/** Ask the running trainer to checkpoint atomically, then exit (resumable). */
export interface HeartmulaCheckpointNowRequest {
  run: HeartmulaRunId;
}

export type HeartmulaRunState =
  | 'idle'
  | 'queued'
  | 'running'
  | 'previewing'
  | 'checkpointing'
  | 'done'
  | 'failed'
  | 'cancelled';

/** One loss sample on the curve. */
export interface HeartmulaLossPoint {
  step: number;
  /** Mean of the eight per-codebook mean CEs. */
  loss: number;
}

/** Live and final numbers for a run. Step time and memory are first-class: they are the batch's targets. */
export interface HeartmulaRunStatus {
  run: HeartmulaRunId;
  state: HeartmulaRunState;
  step: number;
  totalSteps: number;
  /** Latest loss, null before the first step. */
  loss: number | null;
  lossHistory: HeartmulaLossPoint[];
  /** Mean wall time per optimizer step so far; null before the first step. */
  msPerStep: number | null;
  /** Peak VRAM the trainer has used, MiB; null when the device does not report it. */
  peakVramMiB: number | null;
  /** Step of the newest resumable checkpoint, null when none. */
  checkpointStep: number | null;
  /** The published GGUF adapter, relative to the adapter root; null until exported. */
  adapterFile: string | null;
  /** Failure text when state is 'failed'. */
  error: string | null;
  /** Epoch ms. */
  startedAt: number | null;
  updatedAt: number;
}

// ── Dataset asset block (chips) ──────────────────────────────────────────

/** A published HeartMuLa adapter, or null when none exists. */
export interface HeartmulaAdapterAsset {
  name: string;
  /** ISO timestamp of the publish. */
  trainedAt: string;
  run: HeartmulaRunId | null;
}

/** Everything the status route returns for one dataset; every flag is a verified fact. */
export interface HeartmulaStatusResponse {
  base: HeartmulaBase;
  prepare: HeartmulaPrepareStatus;
  /** The active or newest run, null when the dataset has none. */
  run: HeartmulaRunStatus | null;
  adapter: HeartmulaAdapterAsset | null;
  /** Recipe the next run uses when the request omits keys. */
  defaults: HeartmulaRecipe;
  previewDefaults: HeartmulaPreviewSettings;
}

// ── Checkpoint previews ──────────────────────────────────────────────────

/** `base` renders the unadapted model; `step` a mid-run checkpoint; `final` the finished adapter. */
export type HeartmulaPreviewKind = 'base' | 'step' | 'final';

export type HeartmulaPreviewStatus = 'queued' | 'rendering' | 'done' | 'failed' | 'skipped';

export interface HeartmulaPreviewRecord {
  run: HeartmulaRunId;
  kind: HeartmulaPreviewKind;
  /** Completed training step the snapshot was taken at; 0 for 'base'. */
  step: number;
  seed: number;
  seconds: number;
  status: HeartmulaPreviewStatus;
  /** Server-validated URL under the audio route; null until `status` is 'done'. */
  audioUrl: string | null;
  error: string | null;
  /** Epoch ms. */
  createdAt: number;
}

export interface HeartmulaPreviewListResponse {
  /** Echo of the resolved run, or null when the dataset has none. */
  run: HeartmulaRunId | null;
  settings: HeartmulaPreviewSettings;
  previews: HeartmulaPreviewRecord[];
}

/** Ask for a render (or a retry) at one saved step; omitted settings use the run's. */
export interface HeartmulaPreviewRenderRequest {
  run: HeartmulaRunId;
  step: number;
  settings?: Partial<HeartmulaPreviewSettings>;
}
