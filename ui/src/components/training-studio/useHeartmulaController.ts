// useHeartmulaController.ts — the one state owner behind the HeartMuLa cards.
//
// The cards (Heartmula{Prepare,Train,Preview}Card) are pure: this hook reads
// the status route, starts and cancels jobs through the training store, and
// hands them props. Checkpoint previews are read from the run being shown; the
// server renders them between trainer segments, a retry is a command here.

import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HeartmulaPreviewListResponse, HeartmulaPreviewRenderRequest, HeartmulaStatusResponse } from '../../../../server/src/contracts/heartmulaTraining';
import { pollWhile } from '../../queries/contract';
import { scopeOf, serverKey } from '../../queries/keys';
import { getHeartmulaPreviews, getHeartmulaStatus, renderHeartmulaPreview, type TrainingJobSummary } from '../../services/trainingApi';
import { useTrainingStore } from '../../stores/trainingStore';
import type { HeartmulaTrainingView } from './plugins/heartmula';
import type { TrainingRenderContext } from './trainingPluginTypes';

const live = (job: TrainingJobSummary | null | undefined) => job?.status === 'queued' || job?.status === 'running';

export const heartmulaStatusOptions = (worker: string | null, datasetId: string, busy: boolean) => queryOptions({
  queryKey: serverKey('training-data/heartmula-status', { worker, id: datasetId }),
  queryFn: ({ queryKey, signal }) => getHeartmulaStatus(datasetId, { worker: scopeOf(queryKey)!.worker, signal }),
  staleTime: 0,
  refetchInterval: pollWhile<HeartmulaStatusResponse>(() => busy),
});

/** Takes of one run; polls while the job runs or a take is still moving. */
export const heartmulaPreviewOptions = (worker: string | null, datasetId: string, run: string, busy: boolean) => queryOptions({
  queryKey: serverKey('training-data/heartmula-previews', { worker, id: datasetId, filters: { run } }),
  queryFn: ({ queryKey, signal }) => getHeartmulaPreviews(datasetId, run, { worker: scopeOf(queryKey)!.worker, signal }),
  refetchInterval: pollWhile<HeartmulaPreviewListResponse>(data => busy || !!data?.previews.some(p => p.status === 'queued' || p.status === 'rendering')),
});

export function useHeartmulaController({ datasetId }: TrainingRenderContext): HeartmulaTrainingView {
  const { t } = useTranslation();
  const client = useQueryClient();
  const worker = useTrainingStore(s => s.trainingWorker);
  const job = useTrainingStore(s => s.activeJob);
  const storeError = useTrainingStore(s => s.error);
  const startPrepare = useTrainingStore(s => s.startHeartmulaPrepare);
  const startTrain = useTrainingStore(s => s.startHeartmulaTrain);
  const checkpoint = useTrainingStore(s => s.requestHeartmulaCheckpoint);
  const cancel = useTrainingStore(s => s.cancelJob);
  const mine = job?.datasetId === datasetId ? job : null;
  const busy = live(mine);
  const query = useQuery(heartmulaStatusOptions(worker, datasetId, busy));
  const status = query.data ?? null;
  const runId = status?.run?.run ?? null;
  const previewQuery = useQuery({ ...heartmulaPreviewOptions(worker, datasetId, runId ?? '', busy), enabled: runId !== null });
  const [rendering, setRendering] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // The last poll can predate the job's final state: read once more when it ends.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) void client.invalidateQueries({ queryKey: heartmulaStatusOptions(worker, datasetId, false).queryKey });
    wasBusy.current = busy;
  }, [busy, client, worker, datasetId]);

  const onRenderPreview = (request: HeartmulaPreviewRenderRequest) => {
    setRendering(true); setPreviewError(null);
    // A retry carries no form values: the server renders with the run's own saved fixture unless the take's settings are sent back, as they are here.
    void renderHeartmulaPreview(datasetId, request, { worker })
      .catch(err => setPreviewError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        setRendering(false);
        void client.invalidateQueries({ queryKey: heartmulaPreviewOptions(worker, datasetId, request.run, false).queryKey });
      });
  };
  const refresh = () => client.invalidateQueries({ queryKey: heartmulaStatusOptions(worker, datasetId, false).queryKey });
  const ready = status?.ready;
  const blocked = ready && !ready.available
    ? ready.backend !== 'cuda'
      ? t('trainingStudio.heartmula.needsCuda', 'HeartMuLa training needs a CUDA engine build.')
      : ready.deviceProblem ? ready.deviceProblem
      : ready.missingModels.length
        ? t('trainingStudio.heartmula.missingModels', 'HeartMuLa models are missing: {{files}}.', { files: ready.missingModels.join(', ') })
        : t('trainingStudio.heartmula.noTrainer', 'ace-train was not found next to the engine. Rebuild the engine.')
    : undefined;
  const prepareBlockedReason = blocked ?? (ready?.encoderMissing ? ready.encoderHelp ?? undefined : undefined);

  return {
    scopeKey: `${worker ?? ''}:${datasetId}`,
    status,
    loading: query.isPending,
    error: query.error?.message ?? storeError,
    busy,
    preparing: busy && mine?.kind === 'heartmula-prepare',
    trainStarted: busy && mine?.kind === 'heartmula-train' && status?.run?.state === 'running',
    prepareBlockedReason,
    trainBlockedReason: blocked,
    onPrepare: request => { void startPrepare(request).then(refresh); },
    onTrain: request => { void startTrain(request).then(refresh); },
    onCheckpoint: run => { void checkpoint(run); },
    onCancel: () => { void cancel().then(refresh); },
    previews: runId !== null ? previewQuery.data ?? null : null,
    previewError: previewError ?? (previewQuery.error?.message ?? null),
    previewBusy: rendering,
    onRenderPreview,
  };
}
