// queries.ts — training-data server snapshots, keyed by the worker they came from.
//
// Every key carries `worker` (null = this PC), and every queryFn reads the
// target back from its own key, so a request scheduled for worker A lands in
// A's entry whatever "Train on" says by the time it answers. Local-only reads
// (the worker list, dispatch lines) carry no worker.
//
// trainingStore's loaders fetch through these options and project the result
// into the store only while (worker, dataset) still match the selection. That
// projection is the compatibility surface for training-runs until it moves to
// Query; nothing else fetches these snapshots.

import { queryOptions, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { scopeOf, serverKey, type Resource } from '../keys';
import * as api from '../../services/trainingApi';
import { adapterApi } from '../../services/api';
import type { LmSize } from '../../services/trainingApi';

export const TD = {
  capabilities: 'training-data/capabilities',
  datasets: 'training-data/datasets',
  dataset: 'training-data/dataset',
  job: 'training-data/job',
  preprocessStatus: 'training-data/preprocess-status',
  trainLmStatus: 'training-data/train-lm-status',
  trainDitStatus: 'training-data/train-dit-status',
  auditions: 'training-data/auditions',
  lsGenerations: 'training-data/ls-generations',
  preparedData: 'training-data/prepared-data',
  pipelines: 'training-data/pipelines',
  yue2Batches: 'training-data/yue2-batches',
  workers: 'training-data/workers',
  workerDispatch: 'training-data/worker-dispatch',
  lmAdapters: 'training-data/lm-adapters',
} as const satisfies Record<string, Resource>;

type Worker = string | null;
/** The worker captured in a key; reads never consult the live selection. */
const workerOf = (key: QueryKey): Worker => scopeOf(key)?.worker ?? null;

export const trainingQueries = {
  capabilities: (worker: Worker) => queryOptions({
    queryKey: serverKey(TD.capabilities, { worker }),
    queryFn: ({ queryKey, signal }) => api.getCapabilities({ worker: workerOf(queryKey), signal }),
  }),
  datasets: (worker: Worker) => queryOptions({
    queryKey: serverKey(TD.datasets, { worker }),
    queryFn: ({ queryKey, signal }) => api.listDatasets({ worker: workerOf(queryKey), signal }),
  }),
  dataset: (worker: Worker, id: string) => queryOptions({
    queryKey: serverKey(TD.dataset, { worker, id }),
    queryFn: ({ queryKey, signal }) => api.getDataset(id, { worker: workerOf(queryKey), signal }),
  }),
  job: (worker: Worker, jobId: string) => queryOptions({
    queryKey: serverKey(TD.job, { worker, id: jobId }),
    queryFn: ({ queryKey, signal }) => api.getJob(jobId, { worker: workerOf(queryKey), signal }),
  }),
  preprocessStatus: (worker: Worker, id: string) => queryOptions({
    queryKey: serverKey(TD.preprocessStatus, { worker, id }),
    queryFn: ({ queryKey, signal }) => api.getPreprocessStatus(id, { worker: workerOf(queryKey), signal }),
  }),
  trainLmStatus: (worker: Worker, id: string, q: { variantKey?: string; adapterName?: string; lmSize?: LmSize } = {}) => queryOptions({
    queryKey: serverKey(TD.trainLmStatus, { worker, id, filters: q }),
    queryFn: ({ queryKey, signal }) => api.getTrainLmStatus(id, q, { worker: workerOf(queryKey), signal }),
  }),
  trainDitStatus: (worker: Worker, id: string, q: { variantKey?: string; adapterName?: string } = {}) => queryOptions({
    queryKey: serverKey(TD.trainDitStatus, { worker, id, filters: q }),
    queryFn: ({ queryKey, signal }) => api.getTrainDitStatus(id, q, { worker: workerOf(queryKey), signal }),
  }),
  auditions: (worker: Worker, id: string) => queryOptions({
    queryKey: serverKey(TD.auditions, { worker, id }),
    queryFn: ({ queryKey, signal }) => api.getAuditions(id, 20, { worker: workerOf(queryKey), signal }),
  }),
  lsGenerations: (worker: Worker, id: string) => queryOptions({
    queryKey: serverKey(TD.lsGenerations, { worker, id }),
    queryFn: ({ queryKey, signal }) => api.getLsGenerations(id, { worker: workerOf(queryKey), signal }),
  }),
  preparedData: (worker: Worker, id: string) => queryOptions({
    queryKey: serverKey(TD.preparedData, { worker, id }),
    queryFn: ({ queryKey, signal }) => api.getPreparedData(id, { worker: workerOf(queryKey), signal }),
  }),
  pipelines: (worker: Worker) => queryOptions({
    queryKey: serverKey(TD.pipelines, { worker }),
    queryFn: ({ queryKey, signal }) => api.listPipelines({ worker: workerOf(queryKey), signal }),
  }),
  yue2Batches: (worker: Worker) => queryOptions({
    queryKey: serverKey(TD.yue2Batches, { worker }),
    queryFn: ({ queryKey, signal }) => api.listYue2Batches({ worker: workerOf(queryKey), signal }),
  }),
  /** Settings' worker list, as this PC sees it. Local. */
  workers: () => queryOptions({
    queryKey: serverKey(TD.workers),
    queryFn: ({ signal }) => api.listTrainingWorkers({ signal }),
  }),
  /** Every LM adapter under adapters/lm on this PC, for the pickers. Local. */
  lmAdapters: () => queryOptions({
    queryKey: serverKey(TD.lmAdapters),
    queryFn: ({ signal }) => adapterApi.lmList(undefined, { signal }),
  }),
  workerDispatch: (name: string) => queryOptions({
    queryKey: serverKey(TD.workerDispatch, { id: name }),
    queryFn: ({ signal }) => api.getWorkerDispatch(name, { signal }),
  }),
};

/** Every training-data entry scoped to one worker (null = this PC), for
 *  invalidation after a job or cancellation after a "Train on" switch. */
export function workerReads(worker: Worker) {
  return {
    queryKey: ['hs'] as const,
    predicate: (q: { queryKey: QueryKey }) => String(q.queryKey[1]).startsWith('training-data/')
      && scopeOf(q.queryKey)?.worker !== undefined && workerOf(q.queryKey) === worker,
  };
}

/** Cancel every training-data read still in flight for a worker. Its answers
 *  would be dropped anyway once "Train on" has moved away from it. */
export function cancelWorkerReads(client: QueryClient, worker: Worker): Promise<void> {
  return client.cancelQueries(workerReads(worker));
}
