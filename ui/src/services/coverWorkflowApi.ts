import { changed, songsChanged } from '../queries/cover-lyrics/reads';
import { waitForSnapshot } from '../queries/cover-lyrics/wait';
import { workflowOptions } from '../queries/cover-lyrics/workflows';
import { apiClient } from './httpClient';
import type { WorkflowReplay } from '../../../server/src/contracts/workflow';
import { coverLyricWorkflowApi as workflowApi } from '../queries/cover-lyrics/workflows';
import type { WorkflowJob } from '../../../server/src/contracts/workflow';

const BASE = '/api/yue2-cover';

export interface CoverDraftResult {
  documentId: string;
  revision: number;
  metadata?: { artist: string; title: string; album: string; duration: number | null };
  analysis?: { bpm: number; key: string; scale?: string } | null;
  abc?: string;
  scoreSource?: string;
  caption?: string;
}

export async function waitForCoverJob(token: string, jobId: string, cancelled: () => boolean,
  progress?: (job: WorkflowJob) => void): Promise<WorkflowJob> {
  const result = await waitForSnapshot(workflowOptions(token, jobId).queryKey,
    signal => apiClient.get<WorkflowReplay>(`/workflows/jobs/${encodeURIComponent(jobId)}?after=0`, { token, signal }),
    data => !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(data.job.status),
    data => {
      if (cancelled()) {
        void workflowApi.cancel(token, jobId).catch(() => {});
        throw new Error('Cover operation cancelled');
      }
      progress?.(data.job);
    });
  if (result.job.status !== 'succeeded') throw new Error(result.job.error || `Cover operation ${result.job.status}`);
  if (result.job.kind === 'cover-render') await songsChanged();
  return result.job;
}

export const coverWorkflowApi = {
  open: (token: string, assetId: string, cached?: {
    metadata: { artist: string; title: string; album: string; duration: number | null };
    analysis: { bpm: number; key: string; scale?: string };
  }) => workflowApi.submit(token, 'cover-open', crypto.randomUUID(), { assetId, cached }),
  transcribe: (token: string, documentId: string, revision: number, force: boolean) =>
    workflowApi.submit(token, 'cover-transcribe', crypto.randomUUID(), { documentId, revision, force }),
  caption: (token: string, documentId: string, revision: number, artistId: number,
    provider: string, model: string, force: boolean) =>
    workflowApi.submit(token, 'cover-caption', crypto.randomUUID(),
      { documentId, revision, artistId, provider, model, force }),
  render: (token: string, input: Record<string, unknown>) =>
    workflowApi.submit(token, 'cover-render', crypto.randomUUID(), input),
  approveScore: async (token: string, documentId: string, revision: number, abc: string) => {
    const response = await fetch(`${BASE}/drafts/${encodeURIComponent(documentId)}/approve-score`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision, abc }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Score approval failed (${response.status})`);
    await Promise.all([changed('drafts'), changed('cover')]);
    return data as { document: { id: string; revision: number }; sourceId: string; sourceLabel: string; abc: string };
  },
  saveScoreDetails: async (token: string, documentId: string, revision: number,
    abc: string, factor: number) => {
    const response = await fetch(`${BASE}/drafts/${encodeURIComponent(documentId)}/save-score-details`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision, abc, factor }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Score details save failed (${response.status})`);
    await changed('cover');
    return data as { saved: true; bpm: number; key: string };
  },
};
