import { Activity } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HeartmulaRecipe, HeartmulaStatusResponse, HeartmulaTrainRequest } from '../../../../server/src/contracts/heartmulaTraining';
import { ParamLabel } from '../shared/ParamLabel';
import { Toggle } from '../shared/Toggle';
import { TrainingChart } from './TrainingChart';
import { PREVIEW_INPUT, PreviewField, TrainingPreviewSettings } from './TrainingPreviewPanel';
import { Yue2StageCard } from './Yue2StageCard';

export interface HeartmulaTrainCardProps {
  status: HeartmulaStatusResponse;
  slug: string;
  busy: boolean;
  /** True after the trainer's start event, when control files are accepted. */
  trainStarted: boolean;
  blockedReason?: string;
  onTrain: (request: HeartmulaTrainRequest) => void;
  onCheckpoint: (run: string) => void;
  onCancel: () => void;
}

const BUTTON = 'px-3 py-2 rounded-lg bg-amber-500 text-black text-xs font-semibold disabled:opacity-40';
const FIELDS: Array<{ key: keyof HeartmulaRecipe; label: string; info: string; min: number; max: number; step: number }> = [
  { key: 'steps', label: 'Training steps', info: 'Number of optimizer updates. More steps take longer and can overfit the dataset.', min: 1, max: 1_000_000, step: 1 },
  { key: 'rank', label: 'Rank', info: 'Adapter capacity. Higher ranks use more memory. The starting recipe uses rank 64.', min: 1, max: 256, step: 1 },
  { key: 'alpha', label: 'Alpha', info: 'Adapter scaling relative to rank. The starting recipe pairs alpha 64 with rank 64.', min: 0.001, max: 1024, step: 0.001 },
  { key: 'learningRate', label: 'Learning rate', info: 'Size of each weight update. Larger values learn faster but can make training unstable.', min: 1e-8, max: 0.1, step: 0.00001 },
  { key: 'gradAccum', label: 'Gradient accumulation', info: 'Micro-batches per optimizer update. Higher values do more work per step without increasing the micro-batch size.', min: 1, max: 1024, step: 1 },
  { key: 'seed', label: 'Training seed', info: 'Seed for training randomness. Keep it fixed when comparing recipes.', min: 0, max: 0x7fffffff, step: 1 },
  { key: 'checkpointEvery', label: 'Save every, steps', info: 'Save resumable state every this many steps. Zero saves only when stopping or finishing. Preview cadence is separate.', min: 0, max: 1_000_000, step: 1 },
];

export function HeartmulaTrainCard({ status, slug, busy, trainStarted, blockedReason, onTrain, onCheckpoint, onCancel }: HeartmulaTrainCardProps) {
  const { t } = useTranslation();
  const [edits, setEdits] = useState<Partial<HeartmulaRecipe>>({});
  const [name, setName] = useState(slug);
  const [resumeRun, setResumeRun] = useState<string | null>(null);
  const [previewEvery, setPreviewEvery] = useState<number | null>(null);
  const recipe = { ...status.defaults, ...edits };
  const cadence = previewEvery ?? status.previewDefaults.everySteps;
  const run = status.run;
  const ready = status.prepare.cacheValid && status.prepare.staleSamples === 0 && status.prepare.preparedSamples > 0;
  const resume = resumeRun !== null;
  const resumable = !!run && run.run === resumeRun && run.checkpointStep !== null && !busy && run.state !== 'done';
  const locked = busy || resume;
  const valid = FIELDS.every(field => Number.isFinite(recipe[field.key]) && recipe[field.key] >= field.min
    && recipe[field.key] <= field.max && (field.step !== 1 || Number.isInteger(recipe[field.key])))
    && Number.isInteger(cadence) && cadence >= 0 && cadence <= 1_000_000
    && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name);
  const numberField = (field: typeof FIELDS[number]) => <label key={field.key} className="flex flex-col gap-1">
    <ParamLabel label={t(`trainingStudio.heartmula.field.${field.key}`, field.label)}
      info={t(`trainingStudio.heartmula.field.${field.key}Info`, field.info)}
      onReset={!locked && edits[field.key] !== undefined && edits[field.key] !== status.defaults[field.key] ? () => setEdits(previous => {
        const next = { ...previous }; delete next[field.key]; return next;
      }) : undefined} />
    <input className={PREVIEW_INPUT} type="number" min={field.min} max={field.max} step={field.step}
      value={Number.isFinite(recipe[field.key]) ? recipe[field.key] : ''} disabled={locked}
      onChange={event => setEdits(previous => ({ ...previous, [field.key]: event.target.valueAsNumber }))} />
  </label>;
  return <Yue2StageCard icon={<Activity size={16} className="text-amber-500" />}
    title={t('trainingStudio.heartmula.train', 'Train HeartMuLa adapter')} done={run?.state === 'done'}
    action={<div className="space-y-3">
      <p className="text-xs text-zinc-500 break-words">{resume
        ? t('trainingStudio.heartmula.resumeSummary', 'Resume {{run}} with its saved recipe and preview settings.', { run: resumeRun })
        : t('trainingStudio.heartmula.recipeSummary', '3B backbone LoRA · rank {{rank}} · alpha {{alpha}} · {{steps}} steps', recipe)}</p>
      {!ready && <p className="text-xs text-amber-600 dark:text-amber-400">{t('trainingStudio.heartmula.prepareRequired', 'Prepare a non-empty dataset with no stale samples before training.')}</p>}
      {blockedReason && <p className="text-xs text-amber-600 dark:text-amber-400">{blockedReason}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BUTTON} disabled={busy || !ready || !!blockedReason || (resume ? !resumable : !valid)}
          onClick={() => onTrain(resumeRun ? { resumeRun } : { adapterName: name, recipe, preview: { everySteps: cadence, seconds: 30 } })}>
          {resume ? t('trainingStudio.heartmula.resume', 'Resume run') : t('trainingStudio.heartmula.start', 'Start training')}
        </button>
        {busy && run && trainStarted && run.state === 'running' && <button type="button" className={BUTTON} onClick={() => onCheckpoint(run.run)}>
          {t('trainingStudio.heartmula.checkpoint', 'Save and pause')}
        </button>}
        {busy && <button type="button" className={BUTTON} onClick={onCancel}>{t('trainingStudio.heartmula.cancel', 'Cancel')}</button>}
      </div>
    </div>}
    footer={run && <div className="mt-4 space-y-2" aria-live="polite">
      <p className="text-xs text-zinc-500 break-all">{run.run} · {t(`trainingStudio.heartmula.runState.${run.state}`, { defaultValue: run.state })} · {run.step}/{run.totalSteps}</p>
      <progress className="w-full accent-amber-500" max={Math.max(1, run.totalSteps)} value={run.step} />
      <div className="flex flex-wrap gap-4 text-xs text-zinc-600 dark:text-zinc-300">
        <span>{t('trainingStudio.heartmula.loss', 'Loss')}: {run.loss?.toFixed(4) ?? '—'}</span>
        <span>{t('trainingStudio.heartmula.msPerStep', 'ms/step')}: {run.msPerStep?.toFixed(1) ?? '—'}</span>
        <span>{t('trainingStudio.heartmula.vram', 'Peak VRAM, MiB')}: {run.peakVramMiB?.toFixed(0) ?? '—'}</span>
      </div>
      {run.error && <p role="alert" className="text-xs text-red-500">{run.error}</p>}
      <TrainingChart epochs={[]} steps={run.lossHistory.map(point => ({ ...point, ep: point.step }))} target={0}
        config={{ series: ['loss'], defaults: ['loss'], xMax: run.totalSteps }} />
    </div>}>
    <div className="space-y-3">
      <label className="flex flex-col gap-1">
        <ParamLabel label={t('trainingStudio.heartmula.adapterName', 'Adapter name')}
          info={t('trainingStudio.heartmula.adapterNameInfo', 'Name for the saved adapter. Use letters, numbers, underscores or hyphens, up to 64 characters.')} />
        <input className={PREVIEW_INPUT} value={name} maxLength={64} disabled={locked} onChange={event => setName(event.target.value)} />
      </label>
      {numberField(FIELDS[0])}
      {(resume || (run && run.checkpointStep !== null && run.state !== 'done')) && <Toggle accent="amber" checked={resume} disabled={busy} onChange={enabled => setResumeRun(enabled && run ? run.run : null)}
        label={t('trainingStudio.heartmula.resumeLatest', 'Resume the latest checkpoint')}
        info={t('trainingStudio.heartmula.resumeInfo', 'Continue the displayed run with its saved recipe, preview settings and optimizer state. Recipe edits apply only to a new run.')} />}
      <details>
        <summary className="text-xs font-semibold cursor-pointer">{t('trainingStudio.heartmula.advanced', 'Advanced training controls')}</summary>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">{FIELDS.slice(1).map(numberField)}</div>
      </details>
      <TrainingPreviewSettings title={t('trainingStudio.heartmula.previewSettings', 'Checkpoint previews')}
        enabled={cadence > 0} disabled={locked} onEnabledChange={enabled => setPreviewEvery(enabled ? status.previewDefaults.everySteps || 100 : 0)}
        enableLabel={t('trainingStudio.heartmula.enablePreviews', 'Render 30-second checkpoint previews')}
        enableInfo={t('trainingStudio.heartmula.enablePreviewsInfo', 'The server pauses training, renders the fixed fixture, then resumes. Keep previews enabled to hear how the adapter changes.')}>
        <PreviewField label={t('trainingStudio.heartmula.previewEvery', 'Preview every, steps')}
          info={t('trainingStudio.heartmula.previewEveryInfo', 'Steps between audible previews. More frequent previews add more pauses.')}
          onReset={!locked && previewEvery !== null && cadence !== status.previewDefaults.everySteps ? () => setPreviewEvery(null) : undefined}>
          <input className={PREVIEW_INPUT} type="number" min={1} max={1_000_000} step={1} value={Number.isFinite(cadence) ? cadence : ''}
            disabled={locked} onChange={event => setPreviewEvery(event.target.valueAsNumber)} />
        </PreviewField>
        <p className="text-xs text-zinc-500 whitespace-pre-wrap break-words">{t('trainingStudio.heartmula.fixedFixture', 'Fixed fixture · seed {{seed}}\n{{tags}}\n{{lyrics}}', { ...status.previewDefaults })}</p>
      </TrainingPreviewSettings>
    </div>
  </Yue2StageCard>;
}
