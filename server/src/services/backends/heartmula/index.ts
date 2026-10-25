import { engineReady } from '../../../engineState.js';
import { isEngineSuspended } from '../../aceEngineProcess.js';
import { heartmulaClient } from './client.js';
import { heartmulaModels, heartmulaSelection, selectHeartmulaModel } from './models.js';
import { mapHeartmulaRequest, runHeartmulaGeneration } from './generate.js';
import type { EngineBackend, BackendExtensionParam } from '../types.js';

const extensions: BackendExtensionParam[] = [
  { key: 'heartmulaTemperature', label: 'Temperature', hint: 'Sampling temperature for all eight audio codebooks.', type: 'slider', min: 0.01, max: 4, step: 0.01, default: 1 },
  { key: 'heartmulaTopK', label: 'Top K', hint: 'Number of candidate tokens sampled for each codebook.', type: 'slider', min: 1, max: 8197, step: 1, default: 50 },
  { key: 'heartmulaCfgScale', label: 'CFG scale', hint: 'LM guidance. A value of 1 uses a single branch and less KV memory.', type: 'slider', min: 1, max: 10, step: 0.05, default: 1.5 },
  { key: 'heartmulaCodecSteps', label: 'Codec steps', hint: 'Euler steps for each HeartCodec audio chunk.', type: 'slider', min: 1, max: 100, step: 1, default: 10 },
  { key: 'heartmulaCodecGuidance', label: 'Codec guidance', hint: 'Guidance scale for HeartCodec flow decoding.', type: 'slider', min: 1, max: 10, step: 0.05, default: 1.25 },
  { key: 'heartmulaAdapterStrength', label: 'Adapter strength', hint: 'Strength of the selected HeartMuLa LoRA. Zero uses base logits.', type: 'slider', min: 0, max: 2, step: 0.05, default: 1 },
];

export const heartmulaBackend: EngineBackend = {
  id: 'heartmula', displayName: 'HeartMuLa', resourcePool: 'gpu',
  lifecycle: {
    async start() {}, async stop() { await heartmulaClient.unload(); },
    status() {
      return isEngineSuspended() ? 'suspended' : engineReady && heartmulaClient.cachedProps()?.synth_ready ? 'ready' : 'down';
    },
  },
  async capabilities() {
    const { props, stale } = await heartmulaClient.props();
    return {
      backend: 'heartmula', up: engineReady && !isEngineSuspended() && props?.synth_ready === true,
      core: {
        duration: { max: 240, auto: true }, bpm: false, keyscale: false, negativePrompt: false,
        batch: { max: 1 }, seed: true, sampleRate: 48000, captionSource: 'none',
        propsStale: stale, modelsMissing: !stale && props != null && !props.synth_ready,
      },
      features: {
        models: true, lm: false, plugins: false, samplerPlugins: false, adapters: false,
        lmAdapters: true, lmAdapterSelectable: true, postProcess: true, stableStep: true,
        whisper: false, lyricTimestamps: false, forcedAlignment: false, cover: false,
        repaint: false, lego: false, extract: false, streaming: false, training: false,
        midi: false, stems: false, understand: false, conceptSteering: false,
      },
      extensions,
    };
  },
  models: heartmulaModels, selectModel: selectHeartmulaModel,
  operations: ['text2music'],
  resolveRequest(submission) {
    const models = heartmulaSelection();
    for (const [key, target] of Object.entries({
      heartmulaVariant: 'variant', heartmulaGlobalModel: 'global', heartmulaLocalModel: 'local',
      heartmulaFlowModel: 'flow', heartmulaScalarDecoderModel: 'scalar_decoder', heartmulaAdapter: 'lmAdapter',
    })) {
      if (submission[key] !== undefined) {
        if (typeof submission[key] !== 'string') throw new Error(`${key} must be a string`);
        models[target] = submission[key];
      }
    }
    const wire = mapHeartmulaRequest(submission, models);
    return {
      operation: typeof submission.taskType === 'string' ? submission.taskType : 'text2music',
      common: { caption: wire.tags, lyrics: wire.lyrics, duration: wire.duration_s,
        ...(typeof wire.seed === 'number' ? { seed: wire.seed } : {}) },
      models, options: wire as unknown as Record<string, unknown>,
      policy: { retry: { maxAttempts: 1, reseedOnRetry: false } },
    };
  },
  generate: runHeartmulaGeneration,
  releaseVram: () => heartmulaClient.unload(),
};
