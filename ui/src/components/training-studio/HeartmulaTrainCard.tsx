import { Loader2, Play } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { HeartmulaRecipe, HeartmulaStatusResponse, HeartmulaTrainRequest } from '../../../../server/src/contracts/heartmulaTraining';
import { useTrainingStore } from '../../stores/trainingStore';
import { TrainingChart } from './TrainingChart';
import { PreviewField, TrainingPreviewSettings, TrainingRunPicker } from './TrainingPreviewPanel';
import { TrainingRunPanel } from './Yue2StageCard';

export interface HeartmulaTrainCardProps {
  children?: ReactNode;
  datasetId?: string;
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

const BUTTON = 'px-4 py-2 rounded-lg text-xs font-semibold bg-amber-500 text-black hover:bg-amber-400 disabled:opacity-40 flex items-center gap-2';
const INPUT = 'w-full px-3 py-2 rounded-xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-white/10 text-sm text-zinc-800 dark:text-zinc-200 outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/20 disabled:opacity-50';
const FIELDS: Array<{ key: keyof HeartmulaRecipe; label: string; info: string; min: number; max: number; step: number }> = [
  { key: 'steps', label: 'Updates', info: 'Number of optimizer updates. More steps take longer and can overfit the dataset.', min: 1, max: 1_000_000, step: 1 },
  { key: 'rank', label: 'Rank', info: 'Adapter capacity. Higher ranks use more memory. The starting recipe uses rank 64.', min: 1, max: 256, step: 1 },
  { key: 'alpha', label: 'Alpha', info: 'Adapter scaling relative to rank. The starting recipe pairs alpha 64 with rank 64.', min: 0.001, max: 1024, step: 0.001 },
  { key: 'learningRate', label: 'Learning rate', info: 'Size of each weight update. Larger values learn faster but can make training unstable.', min: 1e-8, max: 0.1, step: 0.00001 },
  { key: 'gradAccum', label: 'Songs per update', info: 'Micro-batches per optimizer update. Higher values do more work per step without increasing the micro-batch size.', min: 1, max: 1024, step: 1 },
  { key: 'seed', label: 'Training seed', info: 'Seed for training randomness. Keep it fixed when comparing recipes.', min: 0, max: 0x7fffffff, step: 1 },
  { key: 'loraDropout', label: 'LoRA dropout', info: 'Randomly drops adapter inputs while training, which can reduce overfitting on a small dataset. 0 is off; 0.05 is a proven value that adds about 8% to each step and 1.3 GiB of memory.', min: 0, max: 0.9, step: 0.01 },
  { key: 'checkpointEvery', label: 'Save every', info: 'Save resumable state every this many steps. Zero saves only when stopping or finishing. Preview cadence is separate.', min: 0, max: 1_000_000, step: 1 },
];

export function HeartmulaTrainCard({ children, datasetId, status, slug, busy, trainStarted, blockedReason, onTrain, onCheckpoint, onCancel }: HeartmulaTrainCardProps) {
  const { t } = useTranslation();
  const [edits, setEdits] = useState<Partial<HeartmulaRecipe>>({});
  const [name, setName] = useState(slug);
  const [resumeRun, setResumeRun] = useState<string | null>(null);
  const [previewEvery, setPreviewEvery] = useState<number | null>(null);
  const recipe = resumeRun ? status.runs.find(run => run.run === resumeRun)?.recipe ?? status.defaults : { ...status.defaults, ...edits };
  const cadence = previewEvery ?? status.previewDefaults.everySteps;
  const run = status.run;
  const ready = status.prepare.cacheValid && status.prepare.staleSamples === 0 && status.prepare.preparedSamples > 0;
  const resume = resumeRun !== null;
  const resumable = status.runs.some(item => item.run === resumeRun && item.resumable) && !busy;
  const jobLog = useTrainingStore(s => s.jobLog);
  const job = useTrainingStore(s => s.activeJob);
  const ownLog = job?.kind === 'heartmula-train' && job.datasetId === datasetId ? jobLog : [];
  const locked = busy || resume;
  const valid = FIELDS.every(field => Number.isFinite(recipe[field.key]) && recipe[field.key] >= field.min
    && recipe[field.key] <= field.max && (field.step !== 1 || Number.isInteger(recipe[field.key])))
    && Number.isInteger(cadence) && cadence >= 0 && cadence <= 1_000_000
    && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name);
  const numberField = (field: typeof FIELDS[number]) => <PreviewField key={field.key}
    label={t(`trainingStudio.heartmula.field.${field.key}`, field.label)}
    info={t(`trainingStudio.heartmula.field.${field.key}Info`, field.info)}
    onReset={!locked && edits[field.key] !== undefined && edits[field.key] !== status.defaults[field.key] ? () => setEdits(previous => {
      const next = { ...previous }; delete next[field.key]; return next;
    }) : undefined}>
    <input className={INPUT} type="number" min={field.min} max={field.max} step={field.step}
      value={Number.isFinite(recipe[field.key]) ? recipe[field.key] : ''} disabled={locked}
      onChange={event => setEdits(previous => ({ ...previous, [field.key]: event.target.valueAsNumber }))} />
  </PreviewField>;
  return <TrainingRunPanel title={t('trainingStudio.heartmula.train', 'Train HeartMuLa adapter')}
    description={t('trainingStudio.heartmula.trainHint', 'Train a backbone LoRA on the prepared dataset with the HeartMuLa recipe. Saved checkpoints use the same fixed preview fixture.')}>
    <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
      <div className="flex flex-col gap-1"><TrainingRunPicker label={t('trainingStudio.yue2.method.resumePrevious', 'Resume a previous run')}
        info={t('trainingStudio.heartmula.resumeInfo', 'Continue a saved run with its recipe, preview settings and optimizer state. Recipe edits apply only to a new run.')}
        value={resumeRun ?? ''} disabled={busy} onChange={value => setResumeRun(value || null)}
        options={[{ value: '', label: t('trainingStudio.yue2.method.resumeStartNew', 'Start a new run') },
          ...status.runs.map(item => ({ value: item.run, label: `${item.run} · ${item.step} · ${item.state}`, disabled: !item.resumable }))]} /></div>
      <PreviewField label={t('trainingStudio.heartmula.adapterName', 'Adapter name')}
        info={t('trainingStudio.heartmula.adapterNameInfo', 'Name for the saved adapter. Use letters, numbers, underscores or hyphens, up to 64 characters.')}>
        <input className={INPUT} value={name} maxLength={64} disabled={locked} onChange={event => setName(event.target.value)} />
      </PreviewField>
    </div>
    <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mt-3">
      {[FIELDS[0], FIELDS[7], FIELDS[3], FIELDS[4], FIELDS[1], FIELDS[2]].map(numberField)}
    </div>
    <details className="mt-4 rounded-lg border border-zinc-300/70 dark:border-white/10 bg-white/50 dark:bg-black/10 p-3">
      <summary className="cursor-pointer text-xs font-semibold text-zinc-700 dark:text-zinc-300">{t('trainingStudio.heartmula.advanced', 'Advanced training controls')}</summary>
      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">{[FIELDS[5], FIELDS[6]].map(numberField)}</div>
    </details>
    <TrainingPreviewSettings title={t('trainingStudio.heartmula.previewSettings', 'Checkpoint previews')}
      enabled={cadence > 0} disabled={locked} onEnabledChange={enabled => setPreviewEvery(enabled ? status.previewDefaults.everySteps || 100 : 0)}
      enableLabel={t('trainingStudio.heartmula.enablePreviews', 'Render 30-second checkpoint previews')}
      enableInfo={t('trainingStudio.heartmula.enablePreviewsInfo', 'The server pauses training, renders the fixed fixture, then resumes. Keep previews enabled to hear how the adapter changes.')}>
      <PreviewField label={t('trainingStudio.heartmula.previewEvery', 'Preview every, steps')}
        info={t('trainingStudio.heartmula.previewEveryInfo', 'Steps between audible previews. More frequent previews add more pauses.')}
        onReset={!locked && previewEvery !== null && cadence !== status.previewDefaults.everySteps ? () => setPreviewEvery(null) : undefined}>
        <input className={INPUT} type="number" min={1} max={1_000_000} step={1} value={Number.isFinite(cadence) ? cadence : ''}
          disabled={locked} onChange={event => setPreviewEvery(event.target.valueAsNumber)} />
      </PreviewField>
      <p className="text-xs text-zinc-500 whitespace-pre-wrap break-words">{t('trainingStudio.heartmula.fixedFixture', 'Fixed fixture · seed {{seed}}\n{{tags}}\n{{lyrics}}', { ...status.previewDefaults })}</p>
    </TrainingPreviewSettings>
    <p className="text-[11px] text-zinc-500 mt-2">{resume
      ? t('trainingStudio.heartmula.resumeSummary', 'Resume {{run}} with its saved recipe and preview settings.', { run: resumeRun })
      : t('trainingStudio.heartmula.recipeSummary', '3B backbone LoRA · rank {{rank}} · alpha {{alpha}} · {{steps}} steps', { ...recipe })}</p>
    {!ready && <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">{t('trainingStudio.heartmula.prepareRequired', 'Prepare a non-empty dataset with no stale samples before training.')}</p>}
    {blockedReason && <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">{blockedReason}</p>}
    <div className="mt-4 flex items-center gap-3 flex-wrap">
      <button type="button" className={BUTTON} disabled={busy || !ready || !!blockedReason || (resume ? !resumable : !valid)}
        onClick={() => onTrain(resumeRun ? { resumeRun } : { adapterName: name, recipe, preview: { everySteps: cadence, seconds: 30 } })}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
        {resume ? t('trainingStudio.heartmula.resume', 'Resume run') : t('trainingStudio.heartmula.start', 'Start training')}
      </button>
      {busy && run && trainStarted && run.state === 'running' && <button type="button" className="text-xs text-amber-600 dark:text-amber-400 hover:underline" onClick={() => onCheckpoint(run.run)}>
        {t('trainingStudio.heartmula.checkpoint', 'Save and pause')}
      </button>}
      {busy && <button type="button" className="text-xs text-red-600 dark:text-red-400 hover:underline" onClick={onCancel}>{t('trainingStudio.heartmula.cancel', 'Cancel')}</button>}
      {run && <span className="text-[11px] text-zinc-600 dark:text-zinc-400">{run.state} · {run.step}/{run.totalSteps}</span>}
    </div>
    {run && <div className="mt-3" aria-live="polite">
      {run.error && <p role="alert" className="text-xs text-red-500">{run.error}</p>}
      {run.lossHistory.length > 0 && <TrainingChart epochs={[]} steps={run.lossHistory.map(point => ({ ...point, ep: point.step }))} target={0}
        config={{ series: ['loss'], defaults: ['loss'], xMax: run.totalSteps }} />}
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] tabular-nums text-zinc-500">
        <span>{t('trainingStudio.heartmula.loss', 'Loss')}: {run.loss?.toFixed(4) ?? '—'}</span>
        <span>{t('trainingStudio.heartmula.msPerStep', 'ms/step')}: {run.msPerStep?.toFixed(1) ?? '—'}</span>
        <span>{t('trainingStudio.heartmula.vram', 'Peak VRAM, MiB')}: {run.peakVramMiB?.toFixed(0) ?? '—'}</span>
      </div>
    </div>}
    {ownLog.length > 0 && <details className="mt-2">
      <summary className="cursor-pointer text-[11px] text-zinc-600 dark:text-zinc-400">{t('trainingStudio.yue2.method.showLogs', 'Show training log (last 100 lines)')}</summary>
      <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-zinc-950 p-2 text-[10px] leading-4 text-zinc-300 whitespace-pre-wrap">{ownLog.slice(-100).map(line => line.message).join('\n')}</pre>
    </details>}
    {children}
  </TrainingRunPanel>;
}
