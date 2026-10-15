// queue.ts — the generation queue's server reads.
//
// The queue executor (stores/audioGenQueueStore.ts) keeps its own sequencing,
// legacy owner/migration rules and completion effects; Query owns the reads
// it makes. Every read goes through fetchQuery, so two loops asking for the
// same thing at once share one request, and a loop that is happy with a
// recent answer takes the cache instead of asking again. Reads never retry
// here: each executor loop already decides what a failed read means.
// Submits, cancels and other commands stay direct transport calls.

import { queryOptions } from '@tanstack/react-query';
import { generateApi, songApi } from '../../services/api';
import { audioQueueApi } from '../../services/audioQueueApi';
import { workflowApi } from '../../services/workflowApi';
import { queryClient } from '../client';
import { ACTIVE_POLL_MS } from '../contract';
import { serverKey } from '../keys';
import { songOptions } from './songs';

export const audioQueueItemsOptions = (token: string) => queryOptions({
  queryKey: serverKey('shell-queue/audio-queue', { auth: true }),
  queryFn: ({ signal }) => audioQueueApi.list(token, { signal }),
  retry: false,
});

export const generationStatusOptions = (jobId: string) => queryOptions({
  queryKey: serverKey('shell-queue/generation-status', { id: jobId }),
  queryFn: ({ signal }) => generateApi.status(jobId, { signal }),
  retry: false,
});

export const workflowJobOptions = (token: string, jobId: string) => queryOptions({
  queryKey: serverKey('shell-queue/workflow-job', { auth: true, id: jobId }),
  queryFn: ({ signal }) => workflowApi.get(token, jobId, undefined, { signal }),
  retry: false,
});

export const songIdsOptions = (token: string) => queryOptions({
  queryKey: serverKey('shell-queue/song-ids', { auth: true }),
  queryFn: ({ signal }) => songApi.listIds(token, { signal }),
  retry: false,
});

export const selectedPathOptions = (token: string) => queryOptions({
  queryKey: serverKey('shell-queue/selected-path', { auth: true }),
  queryFn: ({ signal }) => generateApi.selectedPath(token, { signal }),
  retry: false,
});

/** The server queue's items. `maxAgeMs` 0 always asks the server (joining a
 *  request already in flight); a waiter that only needs "recent" passes the
 *  poll cadence and rides the projection's own reads. */
export const readAudioQueue = (token: string, maxAgeMs = 0) =>
  queryClient.fetchQuery({ ...audioQueueItemsOptions(token), staleTime: maxAgeMs });

/** One job's status. Every loop that follows a job polls at about the active
 *  cadence, so answers younger than a poll are shared rather than re-asked. */
export const readGenerationStatus = (jobId: string) =>
  queryClient.fetchQuery({ ...generationStatusOptions(jobId), staleTime: ACTIVE_POLL_MS - 500 });

export const readWorkflowJob = (token: string, jobId: string) =>
  queryClient.fetchQuery({ ...workflowJobOptions(token, jobId), staleTime: 0 });

/** A finished render's song row, fresh: the queue reads it the moment the
 *  render is saved. Shares the canonical song key with every other reader. */
export const readSong = (id: string) =>
  queryClient.fetchQuery({ ...songOptions(id), staleTime: 0 });

export const readSongIds = (token: string) =>
  queryClient.fetchQuery({ ...songIdsOptions(token), staleTime: 0 });

/** Which submit path the server runs. Asked fresh: Settings can switch it,
 *  and the next submit must follow. */
export const readSelectedPath = (token: string) =>
  queryClient.fetchQuery({ ...selectedPathOptions(token), staleTime: 0 });
