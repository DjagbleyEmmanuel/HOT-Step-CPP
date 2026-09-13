// backends/sa3/index.ts — Stable Audio 3 as a PRIMARY generation backend
//
// HOT-Step (MDMAchine / A&E Concepts). SA3 already ships in HOT-Step-CPP as
// the StableStep post-processing refine (SDEdit: audio in → partial noise →
// denoise → audio out). This module exposes the model's PRIMARY use —
// text-to-audio from pure noise — as a third entry in the backend picker
// alongside ACE-Step and MiniMax-Music3.
//
// Shape mirrors backends/minimax/index.ts: same EngineBackend contract, same
// lifecycle story (no process of its own — a model family inside ace-server),
// same capabilities → generic-dropdown rendering. Deliberately smaller: SA3
// has no planner LM, no quant ladder, no LRC, no streaming, no multi-take.
//
// Engine side: hot-step-server.cpp /sa3/props + /sa3-synth, which is
// /sa3-refine minus the input (sa3-refine.h sa3_refine_run_backend with
// noise_only=true). Node side: backends/sa3/generate.ts.
//
// The StableStep refine is untouched. It stays the post-processing stage it
// always was, on every backend that declares `stableStep: true`.

import { engineReady } from '../../../engineState.js';
import { isEngineSuspended } from '../../aceEngineProcess.js';
import { aceClient } from '../../aceClient.js';
import type { Sa3Props } from '../../aceClient.js';
import type {
  EngineBackend,
  BackendCapabilities,
  BackendModels,
  BackendLifecycleStatus,
  BackendExtensionParam,
} from '../types.js';

/** Soft ceiling for the duration slider. The engine's tiled encode/decode
 *  handles any length (sa3_chunk_starts in sa3-refine.h); this bounds the UI
 *  and VRAM, not the model. Matches the engine's own clamp in /sa3-synth. */
export const SA3_MAX_DURATION_SEC = 600;

// ── Props (last-known-good cache, same discipline as mm3Props) ─────────────

let lastGoodProps: Sa3Props | null = null;
let lastGoodAt = 0;

async function sa3PropsCached(): Promise<{ props: Sa3Props | null; stale: boolean }> {
  const p = await aceClient.sa3Props();
  if (p) {
    lastGoodProps = p;
    lastGoodAt = Date.now();
    return { props: p, stale: false };
  }
  return { props: lastGoodProps, stale: true };
}

function status(): BackendLifecycleStatus {
  if (isEngineSuspended()) return 'suspended';
  if (!engineReady) return 'down';
  return 'ready';
}

// ── Capabilities ────────────────────────────────────────────────────────────

/** Backend-declared knobs, rendered by the generic dropdown. Keys are the
 *  `params.sa3*` fields backends/sa3/generate.ts reads. Same schema the Lua
 *  plugins use so PluginControls renders them. */
const SA3_EXTENSIONS: BackendExtensionParam[] = [
  {
    key: 'sa3Steps',
    label: 'Steps',
    type: 'slider',
    default: 24,
    min: 1,
    max: 64,
    step: 1,
    hint: 'Denoise steps from pure noise. StableStep refines with 8 because it '
        + 'only touches the top of the schedule; a full render from noise wants '
        + 'more. 24 is the default here, 32-48 for detail-heavy material.',
    group: 'generation',
  },
  {
    key: 'sa3Sampler',
    label: 'Sampler',
    type: 'select',
    default: 'pingpong',
    options: [
      { value: 'pingpong', label: 'PingPong (native)' },
      { value: 'euler',    label: 'Euler' },
    ],
    hint: 'Native SA3 sampler. Ignored when a Lua solver plugin is selected — '
        + 'a solver REPLACES the native step, they are alternatives not a stack.',
    group: 'generation',
  },
  // The opt-in gate for the shared Lua pickers. Same key MM3 declares — the
  // generic dropdown renders SamplerPluginControls when this is on, and
  // backends/sa3/generate.ts only forwards solver/scheduler/guidance when
  // it is (mapSa3SamplerPlugins). Off = native pingpong, parity-tested.
  {
    key: 'samplerPluginsEnabled',
    type: 'toggle',
    label: 'Sampler Plugins',
    hint: 'Drive the SA3 denoise with the shared Lua solver/scheduler/guidance '
        + 'plugins instead of the native pingpong loop. Full-loop (owns_loop) '
        + 'solvers are fine here — SA3 renders in one pass, no window seams. '
        + 'Guidance is mostly decorative: SA3 has no CFG uncond branch, so '
        + 'APG-family modes pass through unchanged.',
    default: false,
    group: 'generation',
  },
];

async function capabilities(): Promise<BackendCapabilities> {
  const { props, stale } = await sa3PropsCached();
  const synthReady = props?.synth_ready === true;
  const up = engineReady && !isEngineSuspended() && synthReady;

  // Honest "point the user at the model manager" signal: engine reachable,
  // props answered, weights genuinely absent. Fail open on a stale manifest.
  const modelsMissing = !stale && props != null && !synthReady;

  return {
    backend: 'sa3',
    up,
    core: {
      // auto: false — SA3 has no stop token. The requested duration IS the
      // output length (the engine trims to it exactly).
      duration: { max: SA3_MAX_DURATION_SEC, auto: false },
      bpm: false,
      keyscale: false,
      // No CFG uncond branch (trained at cfg=1) — see sa3-refine.h. A negative
      // prompt has nowhere to go.
      negativePrompt: false,
      batch: { max: 1 },
      seed: true,
      sampleRate: 44100,
      promptTokenLimit: props?.prompt_token_limit ?? 256,
      propsStale: stale,
      modelsMissing,
    },
    features: {
      // Single model set (onnx or gguf, engine picks); no ladder to show.
      models: false,
      lm: false,
      plugins: false,
      // The SA3 sampler loop runs the same Lua solvers/schedulers/guidance as
      // ACE and MM3 (sa3-refine.h Sa3PluginParams). Same gating pattern as
      // MM3: `plugins: false` picks the generic dropdown, `samplerPlugins:
      // true` renders the plugin controls beside the extensions.
      samplerPlugins: true,
      // SA3 medium is distilled for pingpong sampling and owns_loop solvers
      // bypass the per-step re-noise that distillation needs, so they are
      // filtered out of the dropdown like on MM3 (finding 2026-09-12). The
      // engine mirrors this at the C++ level (sa3-refine.h resolves owns_loop
      // solvers to native pingpong instead of dispatching them).
      samplerPluginsOwnsLoop: false,
      // DoRA adapters in models/sa3-adapters/*.gguf. These are the StableStep
      // adapters — the same files, the same merge-at-load path. `adapters`
      // rather than `lmAdapters` because there is no LM; the catalogue comes
      // back from models().
      adapters: props != null && props.adapters.length > 0,
      lmAdapters: false,
      // VST chain + mastering read the rate from the WAV; SA3 is 44.1k native.
      postProcess: true,
      // Refining SA3 output with SA3 is legal but a no-op in spirit. Off.
      stableStep: false,
      whisper: true,
      lyricTimestamps: false,
      cover: false,
      repaint: false,
      lego: false,
      extract: false,
      streaming: false,
      training: false,
      midi: false,
      stems: false,
      understand: false,
      conceptSteering: false,
    },
    extensions: SA3_EXTENSIONS,
  };
}

// ── Models ──────────────────────────────────────────────────────────────────

async function models(): Promise<BackendModels> {
  const { props } = await sa3PropsCached();
  return {
    buckets: {},
    adapters: props?.adapters ?? [],
    defaults: {},
  };
}

// ── Backend ─────────────────────────────────────────────────────────────────

export const sa3Backend: EngineBackend = {
  id: 'sa3',
  displayName: 'Stable Audio 3',
  resourcePool: 'gpu',
  lifecycle: {
    async start() { /* no separate process — ace-server owns the lifecycle */ },
    // The SA3 model store entry is small (~2 GB) and the ModelHandle in the
    // engine handler already releases it per request. Nothing to unload.
    async stop() { /* nothing resident between requests */ },
    status,
  },
  capabilities,
  models,
  // No selectModel: single model set, engine picks onnx/gguf by presence.
  // No releaseVram: nothing stays resident between /sa3-synth calls.
};
