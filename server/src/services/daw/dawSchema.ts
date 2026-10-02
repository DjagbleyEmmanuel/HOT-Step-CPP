// daw/dawSchema.ts - Pure request/response mapping for the /api/v1/daw facade.
//
// No I/O here: validation of the DAW-facing request, translation into the
// body POST /api/generate already accepts, and translation of the
// /api/generate/status payload back into the DAW job shape. Kept pure so the
// mapping is unit-testable without a running server.

export const DAW_API_VERSION = 1;

export const DAW_MODES = ['lego', 'repaint', 'complete', 'text2music'] as const;
export type DawMode = typeof DAW_MODES[number];

/** Modes that need a source clip and default to skipping the LM. */
const SOURCE_MODES: ReadonlySet<DawMode> = new Set(['lego', 'repaint', 'complete']);

export type DawErrorCode =
  | 'engine_not_ready' | 'engine_suspended' | 'bad_request' | 'not_found'
  | 'unsupported_mode' | 'backend_mismatch' | 'upstream_error' | 'unauthorized' | 'base_model_required';

export class DawError extends Error {
  constructor(public status: number, public code: DawErrorCode, message: string) { super(message); }
}

export function errorBody(code: DawErrorCode, message: string) {
  return { api: DAW_API_VERSION, error: { code, message } };
}

export interface DawGenerateRequest {
  mode: DawMode;
  caption: string;
  lyrics?: string;
  negative?: string;
  duration_s?: number;
  bars?: number;
  bpm?: number;
  timesig?: string;
  key?: string;
  seed?: number;
  seed_b?: number;
  seed_blend?: number;
  seed_blend_end?: number;
  takes?: number;
  region?: { start_s: number; end_s: number };
  track?: string;
  cover_strength?: number;
  steps?: number;
  guidance?: number;
  solver?: string;
  scheduler?: string;
  guidance_mode?: string;
  dit_model?: string;
  skip_lm?: boolean;
  expected_backend?: string;
}

/** Beats per bar from a "N/D" time signature; defaults to 4. */
export function beatsPerBar(timesig: string | undefined): number {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(timesig ?? '');
  if (!m) return 4;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!(num > 0) || !(den > 0)) return 4;
  // Beats counted in quarter notes so the host bpm (quarter-note based) applies.
  return num * (4 / den);
}

export function barsToDurationS(bars: number, bpm: number, timesig?: string): number {
  return (bars * beatsPerBar(timesig) * 60) / bpm;
}

const num = (v: unknown): number | undefined =>
  v === undefined || v === null || v === '' ? undefined : (Number.isFinite(Number(v)) ? Number(v) : NaN);

/** Validate and normalise the DAW request. Throws DawError(400/422) on bad input. */
export function parseDawRequest(raw: unknown): DawGenerateRequest {
  if (!raw || typeof raw !== 'object') throw new DawError(400, 'bad_request', 'request JSON object is required');
  const r = raw as Record<string, unknown>;
  const mode = r.mode as DawMode;
  if (!DAW_MODES.includes(mode)) {
    throw new DawError(400, 'unsupported_mode', `mode must be one of ${DAW_MODES.join(', ')}`);
  }
  if (mode === 'complete') {
    // The server's ACE path only loads sourceAudioUrl for cover/repaint/lego/extract,
    // and the app UI never submits 'complete', so the source would be dropped.
    throw new DawError(400, 'unsupported_mode', "mode 'complete' is not supported yet (the server does not pass the source clip for it)");
  }
  const out: DawGenerateRequest = { ...(r as object), mode, caption: typeof r.caption === 'string' ? r.caption : '' } as DawGenerateRequest;
  for (const k of ['duration_s', 'bars', 'bpm', 'seed', 'seed_b', 'seed_blend', 'seed_blend_end', 'takes', 'cover_strength', 'steps', 'guidance'] as const) {
    const v = num(r[k]);
    if (Number.isNaN(v)) throw new DawError(400, 'bad_request', `${k} must be a number`);
    (out as any)[k] = v;
  }
  if (out.duration_s === undefined && out.bars !== undefined) {
    if (!(out.bars > 0) || !(out.bpm && out.bpm > 0)) throw new DawError(400, 'bad_request', 'bars needs a positive bpm');
    out.duration_s = barsToDurationS(out.bars, out.bpm, out.timesig);
  }
  if (out.duration_s !== undefined && !(out.duration_s > 0)) throw new DawError(400, 'bad_request', 'duration_s must be positive');
  if (out.takes !== undefined && (!Number.isInteger(out.takes) || out.takes < 1 || out.takes > 8)) {
    throw new DawError(400, 'bad_request', 'takes must be an integer 1..8');
  }
  if (out.region !== undefined) {
    const s = Number(out.region?.start_s), e = Number(out.region?.end_s);
    if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s) {
      throw new DawError(400, 'bad_request', 'region needs 0 <= start_s < end_s');
    }
    out.region = { start_s: s, end_s: e };
  }
  if (mode === 'repaint' && !out.region) throw new DawError(400, 'bad_request', 'repaint needs a region');
  return out;
}

export function modeNeedsSource(mode: DawMode): boolean {
  return SOURCE_MODES.has(mode);
}

/** Translate a validated DAW request into a POST /api/generate body. */
export function toGenerateParams(req: DawGenerateRequest, sourceAudioPath?: string): Record<string, unknown> {
  const p: Record<string, unknown> = {
    taskType: req.mode,
    caption: req.caption,
    skipLm: req.skip_lm ?? modeNeedsSource(req.mode),
  };
  if (req.lyrics !== undefined) p.lyrics = req.lyrics;
  else p.instrumental = true;
  if (req.negative !== undefined) p.negative_prompt = req.negative;
  if (req.duration_s !== undefined) p.duration = req.duration_s;
  if (req.bpm !== undefined) p.bpm = req.bpm;
  if (req.timesig !== undefined) p.timeSignature = req.timesig;
  if (req.key !== undefined) p.keyScale = req.key;
  if (req.seed !== undefined) { p.seed = req.seed; p.randomSeed = false; }
  if (req.seed_b !== undefined) p.seedB = req.seed_b;
  if (req.seed_blend !== undefined) p.seedBlend = req.seed_blend;
  if (req.seed_blend_end !== undefined) p.seedBlendEnd = req.seed_blend_end;
  if (req.takes !== undefined) p.batchSize = req.takes;
  if (req.region) { p.repaintingStart = req.region.start_s; p.repaintingEnd = req.region.end_s; }
  if (req.track !== undefined) p.trackName = req.track;
  if (req.cover_strength !== undefined) p.audioCoverStrength = req.cover_strength;
  if (req.steps !== undefined) p.inferenceSteps = req.steps;
  if (req.guidance !== undefined) p.guidanceScale = req.guidance;
  if (req.solver !== undefined) p.inferMethod = req.solver;
  if (req.scheduler !== undefined) p.scheduler = req.scheduler;
  if (req.guidance_mode !== undefined) p.guidanceMode = req.guidance_mode;
  if (req.dit_model !== undefined) p.ditModel = req.dit_model;
  if (req.expected_backend !== undefined) p.expectedBackend = req.expected_backend;
  if (sourceAudioPath) p.sourceAudioUrl = sourceAudioPath;
  return p;
}

export type DawJobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export function mapState(status: string | undefined): DawJobState {
  switch (status) {
    case 'pending': return 'queued';
    case 'succeeded': return 'done';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    default: return 'running';
  }
}

/** Map a /api/generate/status/:id body to the DAW job shape. Upstream progress is 0..100. */
export function mapJobStatus(id: string, up: any, seeds: number[] = []) {
  const state = mapState(up?.status);
  const urls: string[] = up?.result?.audioUrls ?? [];
  const durations: number[] = up?.result?.durations ?? [];
  const step = /step\s+(\d+)\s*\/\s*(\d+)/i.exec(up?.ace_phase_progress ?? '');
  const progress = state === 'done' ? 1 : Math.min(1, Math.max(0, Number(up?.progress ?? 0) / 100));
  return {
    api: DAW_API_VERSION,
    id,
    state,
    stage: up?.stage ?? null,
    progress,
    step: step ? Number(step[1]) : null,
    step_total: step ? Number(step[2]) : null,
    takes: urls.map((_, n) => ({
      n,
      seed: seeds[n] ?? null,
      duration_s: durations[n] ?? up?.result?.duration ?? null,
      ready: state === 'done',
    })),
    error: up?.error ?? null,
  };
}

/** Pure base model, same rule as the UI's StemBuilder getBaseModels (SFT and merges excluded). */
export function isBaseModel(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith('acestep-v15-base-') || n.startsWith('acestep-v15-xl-base-');
}

/** Classify a DiT model file name. */
export function ditKind(name: string): 'turbo' | 'sft' | 'base' | 'other' {
  if (isBaseModel(name)) return 'base';
  const n = name.toLowerCase();
  if (n.includes('turbo')) return 'turbo';
  if (n.includes('sft')) return 'sft';
  return 'other';
}

/** Modes the engine runs only on a pure base model (lego warns "turbo output incoherent").
 *  Repaint is not gated: the engine has no base check for it and the UI's Repaint Studio
 *  submits it with whatever model is selected. */
const BASE_ONLY_MODES: ReadonlySet<DawMode> = new Set(['lego']);

const BASE_HINT = 'install acestep-v15-base or acestep-v15-xl-base from Model Manager';

/** The ditModel to send, or undefined to leave the request as is. Throws 422 base_model_required. */
export function resolveDitModel(req: DawGenerateRequest, ditModels: string[], loaded: string | null): string | undefined {
  if (!BASE_ONLY_MODES.has(req.mode)) return req.dit_model;
  if (req.dit_model !== undefined) {
    if (!isBaseModel(req.dit_model)) {
      throw new DawError(422, 'base_model_required', `${req.mode} needs a base DiT model, ${req.dit_model} is not one; ${BASE_HINT}`);
    }
    return req.dit_model;
  }
  if (loaded && isBaseModel(loaded) && ditModels.includes(loaded)) return loaded;
  const bases = ditModels.filter(isBaseModel);
  if (bases.length === 0) throw new DawError(422, 'base_model_required', `${req.mode} needs a base DiT model and none is installed; ${BASE_HINT}`);
  return bases[0];
}
