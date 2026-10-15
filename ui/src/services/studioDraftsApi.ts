import type { PlaylistBody, StudioDraftBody } from '../../../server/src/contracts/studioDrafts';
import type { DocumentImportReceipt, TypedDocument, WorkflowDocument } from '../../../server/src/contracts/workflow';
import { apiClient, type ReadOptions } from './httpClient';
import { readSnapshot, changed } from '../queries/cover-lyrics/reads';
import { getSessionEpoch } from '../queries/keys';

async function revisionedRequest<T>(token: string, url: string, method = 'GET', body?: unknown, options: ReadOptions = {}): Promise<T> {
  const target = { session: getSessionEpoch(), api: apiClient.baseUrl };
  const path = url.replace(/^\/api/, '');
  if (method === 'GET') return readSnapshot<T>('drafts', path, token, options);
  const opts = { token, ...options };
  const result = method === 'DELETE' ? await apiClient.delete<T>(path, opts)
    : method === 'PUT' ? await apiClient.put<T>(path, body, opts)
    : await apiClient.post<T>(path, body, opts);
  await changed('drafts', target);
  return result;
}

const path = '/api/studio-drafts';
const id = (value: string) => encodeURIComponent(value);
export type PlaylistDocument = TypedDocument<PlaylistBody>;
export type StudioDraftDocument = TypedDocument<StudioDraftBody>;

export const studioDraftsApi = {
  playlist: (token: string, options: ReadOptions = {}) => revisionedRequest<{ document: PlaylistDocument | null }>(token, `${path}/playlist`, 'GET', undefined, options),
  playlistCommand: (token: string, expectedRevision: number, command: unknown) =>
    revisionedRequest<{ document: PlaylistDocument }>(token, `${path}/playlist/commands`, 'POST', { expectedRevision, command }),
  handoff: (token: string, documentId: string, options: ReadOptions = {}) =>
    revisionedRequest<{ document: WorkflowDocument }>(token, `${path}/handoffs/${id(documentId)}`, 'GET', undefined, options),
  list: (token: string, studio?: StudioDraftBody['studio'], options: ReadOptions = {}) =>
    revisionedRequest<{ documents: StudioDraftDocument[] }>(token, `${path}/drafts${studio ? `?studio=${id(studio)}` : ''}`, 'GET', undefined, options),
  create: (token: string, body: StudioDraftBody) =>
    revisionedRequest<{ document: StudioDraftDocument }>(token, `${path}/drafts`, 'POST', { body }),
  get: (token: string, documentId: string, options: ReadOptions = {}) =>
    revisionedRequest<{ document: StudioDraftDocument; sourceError: string | null }>(token, `${path}/drafts/${id(documentId)}`, 'GET', undefined, options),
  update: (token: string, documentId: string, expectedRevision: number, body: StudioDraftBody) =>
    revisionedRequest<{ document: StudioDraftDocument }>(token, `${path}/drafts/${id(documentId)}`, 'PUT', { expectedRevision, body }),
  remove: (token: string, documentId: string, expectedRevision: number) =>
    revisionedRequest<{ removed: true }>(token, `${path}/drafts/${id(documentId)}?expectedRevision=${expectedRevision}`, 'DELETE'),
  importValue: (token: string, input: { storageKey: string; raw: string; sourceHash: string; schemaVersion: 1; expectedRevision: number; resolution?: 'keep-both' | 'replace' }) =>
    revisionedRequest<{ receipt: DocumentImportReceipt; document: PlaylistDocument | StudioDraftDocument | null; created: boolean }>(token, `${path}/import`, 'POST', input),
};
