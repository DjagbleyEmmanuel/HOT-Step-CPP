import { useTranslation } from 'react-i18next';
import type { HeartmulaPreviewListResponse, HeartmulaPreviewRenderRequest } from '../../../../server/src/contracts/heartmulaTraining';
import { TrainingPreviewRung } from './TrainingPreviewPanel';

export interface HeartmulaPreviewCardProps {
  previews: HeartmulaPreviewListResponse | null;
  busy: boolean;
  error?: string | null;
  onRender?: (request: HeartmulaPreviewRenderRequest) => void;
}

/** Preview orchestration and retries belong to the server integration. */
export function HeartmulaPreviewCard({ previews, busy, error, onRender }: HeartmulaPreviewCardProps) {
  const { t } = useTranslation();
  return <section className="rounded-xl border border-zinc-200 dark:border-white/5 bg-white dark:bg-suno-card p-4 space-y-3">
    <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">{t('trainingStudio.heartmula.review', 'Review checkpoint previews')}</h3>
    <p className="text-xs text-zinc-500">{t('trainingStudio.heartmula.reviewInfo', 'Compare the base model, saved checkpoints and final adapter with the same tags, lyrics, seed and sampler. Training pauses while each preview renders.')}</p>
    {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
    {!previews?.previews.length && <p className="text-xs text-zinc-500">{t('trainingStudio.heartmula.noPreviews', 'No checkpoint previews yet.')}</p>}
    {previews?.previews.map((record, index) => {
      const label = record.kind === 'base' ? t('trainingStudio.heartmula.base', 'Base model')
        : record.kind === 'final' ? t('trainingStudio.heartmula.final', 'Final · step {{step}}', { step: record.step })
          : t('trainingStudio.heartmula.step', 'Step {{step}}', { step: record.step });
      const state = t(`trainingStudio.heartmula.previewState.${record.status}`, { defaultValue: record.status });
      return <TrainingPreviewRung key={`${record.run}:${record.kind}:${record.step}:${record.createdAt}:${index}`} title={label}
        takes={[{ id: String(index), label, src: record.status === 'done' ? record.audioUrl : null,
          sublabel: t('trainingStudio.heartmula.takeDetails', '{{seconds}} s · seed {{seed}} · temperature {{temperature}} · top-k {{topk}} · CFG {{cfg}} · codec {{codecSteps}} / {{codecGuidance}}', {
            seconds: record.settings.seconds, seed: record.settings.seed, temperature: record.settings.temperature,
            topk: record.settings.topk, cfg: record.settings.cfgScale, codecSteps: record.settings.codecSteps, codecGuidance: record.settings.codecGuidance,
          }), text: `${label} · ${state}${record.error ? ` · ${record.error}` : ''}` }]}
        actions={onRender && (record.status === 'failed' || record.status === 'skipped') && <button type="button"
          className="text-xs text-amber-600 dark:text-amber-400 disabled:opacity-40" disabled={busy}
          onClick={() => onRender({ run: record.run, step: record.step, settings: record.settings })}>
          {t('trainingStudio.heartmula.retryPreview', 'Retry preview')}
        </button>}>
        <details className="mt-2 text-xs text-zinc-500">
          <summary className="cursor-pointer">{t('trainingStudio.heartmula.conditioning', 'Tags and lyrics')}</summary>
          <p className="mt-1 whitespace-pre-wrap break-words">{record.settings.tags}</p>
          <p className="mt-1 whitespace-pre-wrap break-words">{record.settings.lyrics}</p>
        </details>
      </TrainingPreviewRung>;
    })}
  </section>;
}
