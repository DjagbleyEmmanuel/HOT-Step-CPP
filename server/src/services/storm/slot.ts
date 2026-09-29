// services/storm/slot.ts -- per-slot wire-request builder for the Storm stream loop.
//
// Isolates the ACE and YuE2 request builds from routes/generate.ts so each
// branch is testable without spinning up the full route, and so a later
// Drifter pass can import this module without depending on Express.
//
// Called once per loop iteration by the /storm/stream handler.
// Reads ctrl but NEVER mutates it -- the route clears one-shot fields after
// calling this function.

import { translateParams } from '../generation/translateParams.js';
import { mapYue2Params } from '../backends/yue2/generate.js';
import { mapSa3SamplerPlugins, mapSa3Adapters } from '../backends/sa3/generate.js';
import { applyDrift } from './drift.js';
import type { DriftRuntime } from './drift.js';
import type { AceRequest } from '../aceClient.js';
import type { Yue2SynthRequest } from '../backends/yue2/client.js';

// Mirror of StreamControlState in routes/generate.ts.
// Kept in sync by hand; if you add a field to StreamControlState add it here.
export interface StreamControlSnapshot {
  guidanceScale: number;
  lssStrength: number;
  inferenceSteps: number;
  duration: number;
  bpm: number;
  seedLock: boolean;
  nextSeed: number | null;
  nextPrompt: string | null;
  nextLyrics: string | null;
  nextBpm: number | null;
  nextDuration: number | null;
  baseCaption: string | null;
  baseLyrics: string | null;
  baseInstrumental: boolean | null;
  streamPaused: boolean;
  extraPluginParams: Record<string, number | string>;
  inferMethod: string | null;
  scheduler: string | null;
  guidanceMode: string | null;
  /** Active drift runtime for this stream, or undefined if drift is not running. */
  drift?: DriftRuntime;
}

export interface AceSlotResult {
  kind: 'ace';
  aceReq: AceRequest;
}

export interface Yue2SlotResult {
  kind: 'yue2';
  yue2Req: Yue2SynthRequest;
}

/** Pre-tokenization SA3 slot params. The route tokenizes caption -> tokens
 *  before calling aceClient.submitSa3Synth, since tokenization is async and
 *  cannot happen inside this sync helper. */
export interface Sa3SlotResult {
  kind: 'sa3';
  caption: string;
  durationSec: number;
  steps: number;
  seed: number;
  sampler: 'pingpong' | 'euler';
  adapters: Array<{ name: string; scale: number }>;
  guidanceScale?: number;
  solver?: string;
  scheduler?: string;
  guidanceMode?: string;
  pluginParams?: Record<string, string | number>;
  postprocessPlugin?: string;
}

export type SlotResult = AceSlotResult | Yue2SlotResult | Sa3SlotResult;

/**
 * Build the wire request for one Storm slot.
 *
 * For the ACE backend the returned aceReq is byte-for-byte the same as the
 * inline logic in routes/generate.ts produced before this helper existed.
 *
 * For the YuE2 backend, the subset the plan defines is applied:
 *   - prompt/lyrics (one-shot and sticky)
 *   - seed lock/walk
 *   - cfg_scale  (mapped from ctrl.guidanceScale)
 *   - ode_steps  (from baseParams.yue2OdeSteps)
 *   - nar_cache_ratio  (from baseParams.yue2NarCacheRatio)
 *   - md_wasserstein_yue2 plugin params ("plugin:key")
 *   - postprocess_plugin (from baseParams.yue2PostprocessPlugin)
 * ACE-only fields (solver, scheduler, guidance mode, BPM, LSS) are ignored
 * by mapYue2Params even when present in slotReq.
 *
 * One-shot fields (nextPrompt, nextLyrics, nextSeed, nextBpm, nextDuration)
 * are READ here but NOT cleared -- the caller clears them after this returns
 * so it can log them first.
 *
 * Drift pressure (ctrl.drift) is applied before one-shot overrides so that
 * any user one-shot value still takes precedence.
 */
export function buildSlotRequest(
  baseParams: Record<string, unknown>,
  ctrl: StreamControlSnapshot,
  slotIndex: number,
  baseSeed: number,
  backend: string,
): SlotResult {
  const mergedPluginParams = {
    ...(typeof baseParams.pluginParams === 'object' && baseParams.pluginParams !== null
      ? baseParams.pluginParams as Record<string, unknown> : {}),
    ...ctrl.extraPluginParams,
  };

  // NOTE: keys here must match what translateParams reads (camelCase for
  // UI-facing params). An explicit per-slot seed also requires
  // randomSeed=false or translateParams re-randomizes it.
  //
  // One-shot fields (nextSeed, nextBpm, nextDuration) are intentionally
  // excluded from this initial build -- they are applied AFTER drift below so
  // they always take precedence over whatever drift sets.
  const slotReq: Record<string, unknown> = {
    ...baseParams,
    randomSeed: false,
    seed: ctrl.seedLock ? baseSeed : baseSeed + slotIndex,
    guidanceScale: ctrl.guidanceScale,
    ...(ctrl.lssStrength > 0 ? { lssStrength: ctrl.lssStrength } : {}),
    ...(ctrl.inferenceSteps > 0 ? { inferenceSteps: ctrl.inferenceSteps } : {}),
    ...(ctrl.bpm > 0 ? { bpm: ctrl.bpm } : {}),
    ...(ctrl.duration > 0 ? { duration: ctrl.duration } : {}),
    // Solver / scheduler / guidance live overrides -- null keeps the snapshot value
    ...(ctrl.inferMethod ? { inferMethod: ctrl.inferMethod } : {}),
    ...(ctrl.scheduler ? { scheduler: ctrl.scheduler } : {}),
    ...(ctrl.guidanceMode ? { guidanceMode: ctrl.guidanceMode } : {}),
    ...(Object.keys(mergedPluginParams).length > 0 ? { pluginParams: mergedPluginParams } : {}),
  };

  // Apply drift pressure first -- one-shot overrides below always win.
  if (ctrl.drift) {
    applyDrift(slotReq, ctrl.drift, backend);
  }

  // User one-shot overrides applied after drift so they always take precedence.
  // seedLock overrides drift seed; nextSeed overrides seedLock too.
  if (ctrl.seedLock) slotReq.seed = baseSeed;
  if (ctrl.nextSeed !== null) slotReq.seed = ctrl.nextSeed;
  if (ctrl.nextBpm !== null) slotReq.bpm = ctrl.nextBpm;
  if (ctrl.nextDuration !== null) slotReq.duration = ctrl.nextDuration;

  // One-shot caption/lyrics overrides (APPLIED, not cleared -- caller clears)
  if (ctrl.nextPrompt !== null) {
    slotReq.caption = ctrl.nextPrompt;
    slotReq.prompt = ctrl.nextPrompt;
  } else if (ctrl.baseCaption !== null) {
    slotReq.caption = ctrl.baseCaption;
    slotReq.prompt = ctrl.baseCaption;
  }
  if (ctrl.nextLyrics !== null) {
    slotReq.lyrics = ctrl.nextLyrics;
    slotReq.instrumental = false;
  } else if (ctrl.baseLyrics !== null) {
    slotReq.lyrics = ctrl.baseLyrics;
    slotReq.instrumental = false;
  } else if (ctrl.baseInstrumental === false) {
    slotReq.instrumental = false;
  }

  if (backend === 'yue2') {
    // YuE2 subset. Map guidanceScale -> yue2CfgScale so the live guidance
    // knob controls YuE2 cfg_scale (mapYue2Params reads yue2CfgScale, not the
    // generic guidanceScale key).
    slotReq.yue2CfgScale = ctrl.guidanceScale;

    const mapping = mapYue2Params(slotReq);
    return { kind: 'yue2', yue2Req: mapping.req };
  }

  if (backend === 'sa3') {
    // SA3 subset: caption, duration, steps, seed, adapters, and optional
    // sampler-plugin params. ACE-only fields (solver/scheduler/guidance on ACE,
    // BPM, LSS, inferMethod) are not forwarded. guidanceScale is passed through
    // mapSa3SamplerPlugins which gates it behind samplerPluginsEnabled.
    const caption = String(slotReq.caption ?? slotReq.prompt ?? '').trim();

    let durationSec = Number(slotReq.duration);
    if (!Number.isFinite(durationSec) || durationSec < 1) durationSec = 30;

    let steps = Number(slotReq.sa3Steps);
    if (!Number.isFinite(steps) || steps < 1) steps = 24;
    if (steps > 64) steps = 64;

    const sampler: 'pingpong' | 'euler' = slotReq.sa3Sampler === 'euler' ? 'euler' : 'pingpong';
    const seed = Math.floor(Number(slotReq.seed) || 0);

    const adapters = mapSa3Adapters(slotReq);
    const plugins  = mapSa3SamplerPlugins(slotReq);

    return { kind: 'sa3', caption, durationSec, steps, seed, sampler, adapters, ...plugins };
  }

  // ACE branch -- byte-for-byte the same request as the inline logic that
  // routes/generate.ts used before this helper was extracted.
  const aceReq = translateParams(slotReq);
  return { kind: 'ace', aceReq };
}
