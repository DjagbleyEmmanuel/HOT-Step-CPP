import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RefreshCw } from 'lucide-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pollWhile } from '../../queries/contract';
import { localOptions } from '../../queries/global-models/options';
import { scopeOf, serverKey } from '../../queries/keys';
import { generationStatusOptions } from '../../queries/shell-queue/queue';
import { generateApi } from '../../services/api';
import { getSa3TrainingStatus, type Sa3Recipe, type Sa3TrainingStatus, type TrainingJobSummary } from '../../services/trainingApi';
import { useGlobalParamsStore } from '../../stores/globalParamsStore';
import { useTrainingStore } from '../../stores/trainingStore';
import type { GenerationJob, GenerationParams } from '../../types';
import { ParamLabel } from '../shared/ParamLabel';
import { StyledSelect } from '../shared/StyledSelect';
import { Toggle } from '../shared/Toggle';
import { TrainingChart } from './TrainingChart';

const CARD = 'rounded-xl border border-zinc-200 dark:border-white/5 bg-white dark:bg-suno-card p-4';
const INPUT = 'w-full rounded-lg border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-black/20 px-3 py-2 text-sm text-zinc-900 dark:text-white disabled:opacity-50';
const BUTTON = 'rounded-lg bg-amber-500/15 border border-amber-500/25 px-3 py-2 text-xs font-semibold text-amber-700 dark:text-amber-400 disabled:opacity-40';
const active = (job: TrainingJobSummary | null | undefined) => job?.status === 'queued' || job?.status === 'running';

const sa3StatusOptions = (worker: string | null, datasetId: string) => queryOptions({
  queryKey: serverKey('training-data/sa3-status', { worker, id: datasetId }),
  queryFn: ({ queryKey, signal }) => getSa3TrainingStatus(datasetId, { worker: scopeOf(queryKey)!.worker, signal }),
  staleTime: 0,
  refetchInterval: pollWhile<Sa3TrainingStatus>(data => active(data?.activeJob)),
});

const RECIPE_FIELDS: Array<{ key: keyof Sa3Recipe; min: number; max: number; step?: number }> = [
  { key: 'steps', min: 1, max: 1_000_000 },
  { key: 'rank', min: 1, max: 256 },
  { key: 'alpha', min: 0.001, max: 1024, step: 0.001 },
  { key: 'learningRate', min: 1e-8, max: 0.1, step: 0.00001 },
  { key: 'duration', min: 1, max: 384, step: 0.1 },
  { key: 'seed', min: 0, max: 0x7fffffff },
  { key: 'checkpointEvery', min: 1, max: 1_000_000 },
  { key: 'exportEvery', min: 0, max: 1_000_000 },
];

function AuditionResult({ jobId, label }: { jobId: string; label: string }) {
  const { t } = useTranslation();
  const query = useQuery({ ...generationStatusOptions(jobId),
    refetchInterval: pollWhile<GenerationJob>(data => !data || !['succeeded', 'failed', 'cancelled'].includes(data.status)),
  });
  const cancel = useMutation({ mutationFn: () => generateApi.cancel(jobId) });
  const job = query.data;
  return <div className="space-y-2 rounded-lg border border-zinc-200 dark:border-white/10 p-3">
    <p className="text-xs">{label} · {job ? t(`trainingStudio.sa3.render.${job.status}`) : t('trainingStudio.sa3.loading')}</p>
    {(query.error || job?.error || cancel.error) && <p role="alert" className="text-xs text-red-500">{query.error?.message || job?.error || cancel.error?.message}</p>}
    {job?.result?.audioUrls.map(url => <audio key={url} controls src={url} className="w-full" />)}
    {job && !['succeeded', 'failed', 'cancelled'].includes(job.status) && <button className={BUTTON} disabled={cancel.isPending || cancel.isSuccess} onClick={() => cancel.mutate()}>{t('trainingStudio.sa3.cancelAudition')}</button>}
  </div>;
}

export const Sa3TrainCard: React.FC<{ datasetId: string; slug: string }> = ({ datasetId, slug }) => {
  const { t } = useTranslation();
  const client = useQueryClient();
  const worker = useTrainingStore(s => s.trainingWorker);
  const storedJob = useTrainingStore(s => s.activeJob);
  const error = useTrainingStore(s => s.error);
  const start = useTrainingStore(s => s.startSa3Train);
  const cancel = useTrainingStore(s => s.cancelJob);
  const steps = useTrainingStore(s => s.trainStepSeries);
  const logs = useTrainingStore(s => s.jobLog);
  const statusQuery = useQuery(sa3StatusOptions(worker, datasetId));
  const status = statusQuery.data;
  const job = storedJob?.datasetId === datasetId ? storedJob : status?.activeJob;
  const busy = active(job) || active(status?.activeJob);
  const mine = job?.kind === 'sa3-train';
  const [adapterName, setAdapterName] = useState(slug);
  const [edits, setEdits] = useState<Partial<Sa3Recipe>>({});
  const [resumeRun, setResumeRun] = useState('');
  const [resumeSteps, setResumeSteps] = useState<number | null>(null);
  const run = status?.runs.find(r => r.run === resumeRun);
  const recipe = resumeRun ? run?.recipe : status ? { ...status.defaults, ...edits } : undefined;
  const targetSteps = resumeRun ? resumeSteps ?? run?.recipe.steps ?? 0 : recipe?.steps ?? 0;
  const invalidRecipe = !recipe || RECIPE_FIELDS.some(field => {
    const value = field.key === 'steps' ? targetSteps : recipe[field.key];
    return !Number.isFinite(value) || value < field.min || value > field.max || (!field.step && !Number.isInteger(value));
  });
  const startMutation = useMutation({ mutationFn: async () => {
    await start(resumeRun ? { resumeRun, steps: targetSteps } : { ...recipe, adapterName });
    await client.invalidateQueries({ queryKey: sa3StatusOptions(worker, datasetId).queryKey });
  } });
  const cancelMutation = useMutation({ mutationFn: cancel });
  const adaptersQuery = useQuery({ ...localOptions<{ adapters: Array<{ name: string; sizeMb: number }> }>(
    'sa3-adapters', '/models/stablestep/adapters'), enabled: worker === null });
  const adapters = adaptersQuery.data?.adapters ?? [];
  const [pickedAdapter, setPickedAdapter] = useState('');
  const selectedAdapter = pickedAdapter || status?.runs.find(r => r.published && adapters.some(a => a.name === r.published))?.published || '';
  const [useAdapter, setUseAdapter] = useState(true);
  const [strength, setStrength] = useState(1);
  const [caption, setCaption] = useState('');
  const [auditionSeed, setAuditionSeed] = useState(42);
  const [auditionSeconds, setAuditionSeconds] = useState(30);
  const [auditions, setAuditions] = useState<Array<{ jobId: string; label: string }>>([]);
  const auditionMutation = useMutation({ mutationFn: async () => {
    const params = useGlobalParamsStore.getState().getGlobalParams();
    const scale = useAdapter ? strength : 0;
    const res = await generateApi.submit({ ...params, backend: 'sa3', caption: caption.trim(), lyrics: '',
      instrumental: true, duration: auditionSeconds, seed: auditionSeed, randomSeed: false, batchSize: 1,
      postProcessingEnabled: false, samplerPluginsEnabled: false, sa3Steps: 8, sa3Sampler: 'md_pingpong_blend',
      sa3Adapters: scale === 0 ? [] : [{ name: selectedAdapter, scale }],
      sa3LufsEnabled: false,
      seedB: undefined, seedBlend: undefined,
    } as GenerationParams);
    return { jobId: res.jobId, label: t('trainingStudio.sa3.auditionLabel', { adapter: scale === 0 ? t('trainingStudio.sa3.base') : selectedAdapter, scale, seed: auditionSeed }) };
  }, onSuccess: result => setAuditions(current => [...current, result]) });

  return <div className="flex flex-col gap-4 text-zinc-700 dark:text-zinc-300">
    <section className={`${CARD} space-y-3`}>
      <h3 className="text-sm font-bold text-zinc-900 dark:text-white">{t('trainingStudio.sa3.title')}</h3>
      <p className="text-xs text-zinc-500">{t('trainingStudio.sa3.scope')}</p>
      <p className="text-xs">{t('trainingStudio.sa3.preparation')}</p>
      <p className="text-xs">{t('trainingStudio.sa3.enginePause')}</p>
      <div className="flex items-center gap-2 text-xs">
        {statusQuery.isPending && <Loader2 size={14} className="animate-spin" />}
        {status ? t(status.available ? 'trainingStudio.sa3.ready' : 'trainingStudio.sa3.unavailable', { backend: status.backend }) : t('trainingStudio.sa3.loading')}
        <button className={BUTTON} aria-label={t('trainingStudio.sa3.refresh')} disabled={statusQuery.isFetching} onClick={() => { void statusQuery.refetch(); if (worker === null) void adaptersQuery.refetch(); }}><RefreshCw size={12} /></button>
      </div>
      {!!status?.missing.length && <p role="alert" className="text-xs text-amber-700 dark:text-amber-400">{t('trainingStudio.sa3.missing', { files: status.missing.join(', ') })}</p>}
      {(statusQuery.error || error || startMutation.error || cancelMutation.error) && <p role="alert" className="text-xs text-red-500">{statusQuery.error?.message || error || startMutation.error?.message || cancelMutation.error?.message}</p>}
      {status && <>
        <div className="space-y-1">
          <ParamLabel label={t('trainingStudio.sa3.run')} info={t('trainingStudio.sa3.runInfo')} />
          <StyledSelect accent="amber" value={resumeRun} disabled={busy || startMutation.isPending} onChange={value => { setResumeRun(value); setResumeSteps(null); }} options={[
            { value: '', label: t('trainingStudio.sa3.newRun') },
            ...status.runs.filter(r => r.resumable).map(r => ({ value: r.run, label: r.run })),
          ]} />
        </div>
        {!resumeRun && <label className="block space-y-1">
          <ParamLabel label={t('trainingStudio.sa3.adapterName')} info={t('trainingStudio.sa3.adapterNameInfo')} />
          <input className={INPUT} value={adapterName} disabled={busy || startMutation.isPending} maxLength={64} onChange={e => setAdapterName(e.target.value)} />
        </label>}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {recipe && RECIPE_FIELDS.map(field => <label key={field.key} className="space-y-1">
            <ParamLabel label={t(`trainingStudio.sa3.fields.${field.key}`)} info={t(`trainingStudio.sa3.fields.${field.key}Info`)} />
            <input type="number" className={INPUT} value={field.key === 'steps' ? targetSteps : recipe[field.key]}
              min={field.key === 'steps' && run ? run.recipe.steps : field.min} max={field.max} step={field.step ?? 1}
              disabled={busy || startMutation.isPending || (!!resumeRun && field.key !== 'steps')}
              onChange={e => resumeRun ? setResumeSteps(e.target.valueAsNumber) : setEdits(current => ({ ...current, [field.key]: e.target.valueAsNumber }))} />
          </label>)}
        </div>
        <button className={BUTTON} onClick={() => startMutation.mutate()} disabled={!status.available || busy || startMutation.isPending || invalidRecipe
          || (resumeRun ? !run?.resumable || targetSteps < run.recipe.steps : !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(adapterName))}>
          {t(resumeRun ? 'trainingStudio.sa3.resume' : 'trainingStudio.sa3.start')}
        </button>
      </>}
    </section>
    {mine && job && <section className={`${CARD} space-y-3`} aria-live="polite">
      <p className="text-xs">{t(`trainingStudio.sa3.phase.${job.phase}`, { defaultValue: job.phase })} · {job.done}/{job.total} · {t(`trainingStudio.sa3.job.${job.status}`)}</p>
      <progress className="w-full accent-amber-500" max={Math.max(1, job.total)} value={job.done} />
      {job.error && <p role="alert" className="text-xs text-red-500">{job.error}</p>}
      {active(job) && <button className={BUTTON} disabled={cancelMutation.isPending} onClick={() => cancelMutation.mutate()}>{t('trainingStudio.sa3.cancel')}</button>}
      <TrainingChart epochs={[]} steps={steps} target={0} />
      <details><summary className="text-xs cursor-pointer">{t('trainingStudio.sa3.log')}</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-[11px]">{logs.map(line => `[${line.level}] ${line.message}`).join('\n')}</pre></details>
    </section>}
    <section className={`${CARD} space-y-3`}>
      <h3 className="text-sm font-bold">{t('trainingStudio.sa3.audition')}</h3>
      <p className="text-xs text-zinc-500">{t(worker ? 'trainingStudio.sa3.localAudition' : 'trainingStudio.sa3.auditionInfo')}</p>
      {adaptersQuery.error && <p role="alert" className="text-xs text-red-500">{adaptersQuery.error.message}</p>}
      {status?.runs.filter(r => r.published).map(r => <p key={r.run} className="text-xs break-all">{t('trainingStudio.sa3.published', { name: r.published })}</p>)}
      <ParamLabel label={t('trainingStudio.sa3.adapter')} info={t('trainingStudio.sa3.adapterInfo')} />
      <StyledSelect accent="amber" value={selectedAdapter} onChange={setPickedAdapter} disabled={worker !== null || busy || auditionMutation.isPending}
        placeholder={t('trainingStudio.sa3.noAdapters')} options={adapters.map(a => ({ value: a.name, label: a.name, hint: `${a.sizeMb} MB` }))} />
      <Toggle checked={useAdapter} onChange={setUseAdapter} label={t('trainingStudio.sa3.useAdapter')} info={t('trainingStudio.sa3.useAdapterInfo')} accent="amber" />
      <label className="block space-y-1"><ParamLabel label={t('trainingStudio.sa3.caption')} info={t('trainingStudio.sa3.captionInfo')} />
        <textarea className={INPUT} rows={2} value={caption} onChange={e => setCaption(e.target.value)} />
      </label>
      <div className="grid grid-cols-3 gap-3">
        {([{ key: 'strength', value: strength, set: setStrength, min: 0, max: 2, step: 0.1 },
          { key: 'auditionSeed', value: auditionSeed, set: setAuditionSeed, min: 0, max: 0x7fffffff, step: 1 },
          { key: 'auditionSeconds', value: auditionSeconds, set: setAuditionSeconds, min: 1, max: 384, step: 1 }]).map(field => <label key={field.key} className="space-y-1">
          <ParamLabel label={t(`trainingStudio.sa3.${field.key}`)} info={t(`trainingStudio.sa3.${field.key}Info`)} />
          <input className={INPUT} type="number" value={field.value} min={field.min} max={field.max} step={field.step} onChange={e => field.set(e.target.valueAsNumber)} />
        </label>)}
      </div>
      {auditionMutation.error && <p role="alert" className="text-xs text-red-500">{auditionMutation.error.message}</p>}
      <button className={BUTTON} disabled={worker !== null || busy || startMutation.isPending || auditionMutation.isPending || !caption.trim()
        || (useAdapter && strength !== 0 && !adapters.some(a => a.name === selectedAdapter)) || !Number.isFinite(strength) || strength < 0 || strength > 2
        || !Number.isInteger(auditionSeed) || auditionSeed < 0 || auditionSeed > 0x7fffffff
        || !Number.isFinite(auditionSeconds) || auditionSeconds < 1 || auditionSeconds > 384} onClick={() => auditionMutation.mutate()}>{t('trainingStudio.sa3.renderAudition')}</button>
      {auditions.map(a => <AuditionResult key={a.jobId} {...a} />)}
    </section>
  </div>;
}
