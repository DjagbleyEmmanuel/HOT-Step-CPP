// backends/sa3/generate.ts — Stable Audio 3 primary-backend generation path
//
// HOT-Step (MDMAchine / A&E Concepts). Runs one text-to-audio render through
// the engine's POST /sa3-synth (hot-step-server.cpp) and lands the result in
// the library exactly the way backends/minimax/generate.ts does: WAV to
// data.audioDir, model-agnostic post-processing, optional Whisper, a songs row,
// job.result. Anything that pattern-matches MM3's file is deliberate — the
// library, the queue and the UI expect one completion contract.
//
// Deliberately SIMPLER than MM3's runner. /sa3-synth is synchronous (it
// returns the WAV in the response body) so there is no job polling, no
// progress stream, no takes, no LRC, no planner LM, no AR cache. The whole
// render is one awaited fetch.
//
// Prompt: the caption is tokenised with the same T5Gemma tokenizer StableStep
// uses (sa3Tokenizer.ts). NOT buildStableStepPrompt() — that strips vocal
// descriptors and appends "Instrumental only", which is right for a refine
// of an ACE instrumental bed and wrong for a primary render of whatever the
// user asked for. The caption goes through as written.

import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { v4 as uuidv4 } from 'uuid';

import { config } from '../../../config.js';
import { getDb } from '../../../db/database.js';
import { aceClient } from '../../aceClient.js';
import { wavDurationSec } from '../../audioCrop.js';
import { tokenizeForSa3 } from '../../sa3Tokenizer.js';
import { runPostProcessingChain } from '../../generation/postProcessing.js';
import type { PostProcessParams } from '../../generation/postProcessing.js';
import {
  startGenerationLog, logGeneration, logGenerationParams,
  finishGenerationLog, failGenerationLog,
} from '../../logger.js';
import type { GenerationJob, StageTiming } from '../../../routes/generate.js';
import { SA3_MAX_DURATION_SEC } from './index.js';

const TASK = 'sa3-text2music';

/** The wire request, as sent. Stored in generation_params so a reproduce
 *  re-submits the real inputs. */
interface Sa3SynthWire {
  caption: string;
  prompt: string;         // what was actually tokenised (== caption today)
  nTokens: number;
  durationSec: number;
  steps: number;
  sampler: 'pingpong' | 'euler';
  seed: number;
  adapters: Array<{ name: string; scale: number }>;
  solver?: string;
  scheduler?: string;
  guidanceMode?: string;
  guidanceScale?: number;
  pluginParams?: Record<string, string | number>;
  postprocessPlugin?: string;
}

/** Same pattern as minimax's mapMinimaxSamplerPlugins: the solver / scheduler /
 *  guidance pickers are SHARED global UI state, so they only reach the wire
 *  when the user has opted in (params.samplerPluginsEnabled). Otherwise the
 *  render stays on the parity-tested native pingpong path. */
function mapSa3SamplerPlugins(params: any): Pick<Sa3SynthWire,
  'solver' | 'scheduler' | 'guidanceMode' | 'guidanceScale' | 'pluginParams' | 'postprocessPlugin'> {
  if (!params.samplerPluginsEnabled) return {};
  const out: ReturnType<typeof mapSa3SamplerPlugins> = {};
  if (params.inferMethod)  out.solver       = params.inferMethod;
  if (params.scheduler)    out.scheduler    = params.scheduler;
  if (params.guidanceMode) out.guidanceMode = params.guidanceMode;
  // Postprocess plugin: replaces the built-in latent->audio decode. Same UI
  // key ACE's backend uses (params.postprocessPlugin), gated behind the same
  // opt-in toggle as solver/scheduler/guidance.
  if (params.postprocessPlugin) out.postprocessPlugin = params.postprocessPlugin;
  const gs = Number(params.guidanceScale);
  if (Number.isFinite(gs) && gs > 1) out.guidanceScale = gs;
  // The shared pluginParams store holds every "<plugin>:<key>" the user has
  // ever touched, across every plugin -- easily 150+ entries. /sa3-synth takes
  // them on the query string (same wire as /sa3-refine), so sending the lot
  // is an HTTP 414. Forward only the keys that belong to the plugins actually
  // selected; the rest can't reach anything on this render anyway.
  if (params.pluginParams && Object.keys(params.pluginParams).length > 0) {
    const wanted = [out.solver, out.scheduler, out.guidanceMode, out.postprocessPlugin]
      .filter(Boolean) as string[];
    const pp: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(params.pluginParams as Record<string, string | number>)) {
      const colon = k.indexOf(':');
      if (colon <= 0) continue;
      const plugin = k.slice(0, colon);
      if (wanted.includes(plugin)) pp[k] = v;
    }
    if (Object.keys(pp).length > 0) out.pluginParams = pp;
  }
  return out;
}

/** StableStep adapters, reused as-is: the same models/sa3-adapters/*.gguf,
 *  the same merge-at-load path. The UI stores them under the StableStep keys
 *  (stableStepAdapters: [{name, scale}]) — read those so one adapter picker
 *  serves both the refine and the primary render. */
function mapSa3Adapters(params: any): Array<{ name: string; scale: number }> {
  const raw = params.sa3Adapters ?? params.stableStepAdapters;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a: any) => a && typeof a.name === 'string' && a.name.trim())
    .map((a: any) => ({
      name: String(a.name).trim(),
      scale: Number.isFinite(Number(a.scale)) ? Number(a.scale) : 1.0,
    }));
}

export async function runSa3Generation(job: GenerationJob): Promise<void> {
  const log = (level: 'INFO' | 'DEBUG' | 'WARNING' | 'ERROR', msg: string) =>
    logGeneration(job.id, level, msg);
  const timing: StageTiming[] = [];
  const pipelineStart = performance.now();

  // ── Map params ────────────────────────────────────────────────────────
  const caption: string = String(job.params.caption ?? job.params.style ?? '').trim();
  if (!caption) {
    job.status = 'failed';
    job.error  = 'Stable Audio 3 needs a caption (Style Description)';
    job.stage  = 'Failed';
    return;
  }

  let durationSec = Number(job.params.duration);
  if (!Number.isFinite(durationSec) || durationSec < 1) durationSec = 30;
  if (durationSec > SA3_MAX_DURATION_SEC) durationSec = SA3_MAX_DURATION_SEC;

  let steps = Number(job.params.sa3Steps);
  if (!Number.isFinite(steps) || steps < 1) steps = 24;
  if (steps > 64) steps = 64;

  const sampler: 'pingpong' | 'euler' = job.params.sa3Sampler === 'euler' ? 'euler' : 'pingpong';

  // Seed: honour a fixed one, otherwise draw and WRITE IT BACK so the row is
  // reproducible — same discipline as the ACE and MM3 paths.
  let seed = Number(job.params.seed);
  if (job.params.randomSeed || !Number.isFinite(seed) || seed < 0) {
    seed = Math.floor(Math.random() * 0x7fffffff);
  }
  seed = Math.floor(seed);
  job.params.seed = seed;

  const adapters = mapSa3Adapters(job.params);
  const plugins  = mapSa3SamplerPlugins(job.params);

  // /sa3-synth is one long synchronous fetch — without an abort controller a
  // user cancel only flips job.status and the render keeps running to
  // completion server-side. Same pattern as backends/minimax/generate.ts.
  const abortController = new AbortController();
  (job as any)._abort = abortController;

  startGenerationLog(job.id, TASK);

  try {
    // ── Tokenise ──────────────────────────────────────────────────────────
    job.status   = 'synth_running';
    job.stage    = 'Stable Audio 3: tokenising caption...';
    job.progress = 2;
    const tokStart = performance.now();
    const { ids, nTokens } = await tokenizeForSa3(caption);
    timing.push({ name: 'Tokenise', ms: Math.round(performance.now() - tokStart) });
    log('INFO', `[SA3] Prompt: ${nTokens}/256 tokens`);

    const wire: Sa3SynthWire = {
      caption, prompt: caption, nTokens, durationSec, steps, sampler, seed, adapters, ...plugins,
    };
    logGenerationParams(job.id, wire as unknown as Record<string, unknown>);
    if (plugins.solver || plugins.scheduler || plugins.guidanceMode) {
      log('INFO', `[SA3] Plugins: solver=${plugins.solver ?? '(pingpong)'} `
        + `scheduler=${plugins.scheduler ?? '(sa3 logsnr)'} `
        + `guidance=${plugins.guidanceMode ?? '(none)'}`);
    }
    if (adapters.length > 0) {
      log('INFO', `[SA3] Adapters: ${adapters.map(a => `${a.name}:${a.scale}`).join(', ')}`);
    }

    // ── Synth (one synchronous call) ──────────────────────────────────────
    job.stage    = `Stable Audio 3: rendering ${Math.round(durationSec)}s (${steps} steps)...`;
    job.progress = 5;
    if ((job.status as string) === 'cancelled') throw new Error('Cancelled');
    const synthStart = performance.now();
    const wavBuf = await aceClient.submitSa3Synth({
      tokens: ids,
      nTokens,
      durationSec,
      steps,
      sampler,
      seed,
      adapters,
      outFmt: 'f32',   // keep peaks; the post chain owns the ceiling
      // Diagnostic. Set params.sa3DumpLatent to a bare filename to get the
      // final latent on disk + its RMS in the engine log.
      ...(job.params.sa3DumpLatent ? { dumpLatent: String(job.params.sa3DumpLatent) } : {}),
      ...plugins,
      signal: abortController.signal,
    });
    const synthMs = Math.round(performance.now() - synthStart);
    timing.push({ name: 'SA3 synth', ms: synthMs });
    if ((job.status as string) === 'cancelled') throw new Error('Cancelled');
    if (!wavBuf || wavBuf.length === 0) throw new Error('Stable Audio 3 returned an empty audio body');

    // ── Save ──────────────────────────────────────────────────────────────
    job.stage    = 'Stable Audio 3: saving audio...';
    job.progress = 95;
    const saveStart = performance.now();
    const filename = `${uuidv4()}.wav`;
    const filepath = path.join(config.data.audioDir, filename);
    fs.writeFileSync(filepath, wavBuf);
    const audioUrl = `/audio/${filename}`;
    const measured = wavDurationSec(filepath);
    const duration = measured > 0 ? Math.round(measured) : Math.round(durationSec);
    log('INFO', `[SA3] Rendered ${duration}s in ${synthMs} ms → ${filename} (${(wavBuf.length / 1024).toFixed(0)} KB)`);
    timing.push({ name: 'Save', ms: Math.round(performance.now() - saveStart) });

    // ── Persist params ────────────────────────────────────────────────────
    const captionLine = caption.split('\n').map(s => s.trim()).find(s => s.length > 0) || '';
    const title: string = job.params.title || captionLine.substring(0, 60) || 'Untitled';
    const trackParams = {
      ...job.params,
      backend: 'sa3',
      seed,
      duration: durationSec,
      sa3Request: wire,
      sa3: { steps, sampler, sample_rate: 44100, prompt_tokens: nTokens },
    };

    // ── Post-processing (model-agnostic subset, same as MM3) ─────────────
    // SA3 is natively 44.1 kHz. VST + mastering read the rate from the WAV.
    // PP-VAE and Spectral Lifter are ACE-coupled and stay off. StableStep
    // (refine with SA3) is off in this backend's manifest.
    let masteredUrl = '';
    try {
      const ppParams: PostProcessParams = {
        ...job.params,
        ppVaeReencode: false,
        spectralLifterEnabled: false,
        stableStepOn: false,
        stableStep: false,
        // No vocal stem to protect; SA3 renders whatever the caption asked for
        // and the post chain must not try to split it apart.
        instrumental: true,
      };
      if (ppParams.postProcessingEnabled !== false) {
        const ppStart = performance.now();
        const ppResult = await runPostProcessingChain(
          [audioUrl], ppParams, 1, job.id,
          log, (stage) => { job.stage = stage; },
        );
        masteredUrl = ppResult.masteredUrls?.[0] || '';
        const ppMs = Math.round(performance.now() - ppStart);
        if (masteredUrl) log('INFO', `[SA3] Post-processing produced ${masteredUrl} in ${ppMs} ms`);
        timing.push({ name: 'Post-processing', ms: ppMs });
      }
    } catch (ppErr: any) {
      log('WARNING', `[SA3] Post-processing chain failed (non-fatal): ${ppErr?.message || ppErr}`);
    }

    // ── Songs row ─────────────────────────────────────────────────────────
    const songId = uuidv4();
    getDb().prepare(`
      INSERT INTO songs (id, user_id, title, lyrics, style, caption, audio_url,
                         duration, bpm, key_scale, time_signature, tags, dit_model,
                         generation_params, mastered_audio_url, latent_url, quality_scores,
                         noadapter_audio_url, backend)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      songId, job.userId, title, '', caption, caption,
      audioUrl, duration, 0, '', '',
      JSON.stringify([]), 'sa3', JSON.stringify(trackParams),
      masteredUrl, '', '',
      '', 'sa3',
    );

    // ── Done ──────────────────────────────────────────────────────────────
    const totalMs = Math.round(performance.now() - pipelineStart);
    timing.push({ name: 'TOTAL', ms: totalMs });
    job.status   = 'succeeded';
    job.progress = 100;
    job.stage    = 'Complete!';
    job.result   = { audioUrls: [audioUrl], songIds: [songId], duration, timing, totalMs };

    log('INFO', `[Result] 1 audio file saved, 1 song created (backend=sa3)`);
    console.log(`[Generate] Job ${job.id} (sa3) completed in ${(totalMs / 1000).toFixed(1)}s`);
    finishGenerationLog(job.id, TASK);

  } catch (err: any) {
    if (err.message === 'Cancelled' || err?.name === 'AbortError' || (job.status as string) === 'cancelled') {
      job.status = 'cancelled';
      job.stage  = 'Cancelled';
      failGenerationLog(job.id, 'Cancelled by user', TASK);
    } else {
      job.status = 'failed';
      job.error  = err.message || 'Unknown error';
      job.stage  = 'Failed';
      console.error(`[Generate] Job ${job.id} (sa3) failed:`, err.message);
      failGenerationLog(job.id, err.message || 'Unknown error', TASK);
    }
  }
}
