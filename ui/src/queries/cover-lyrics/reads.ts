import { queryOptions } from '@tanstack/react-query';
import { apiClient, type ReadOptions } from '../../services/httpClient';
import { queryClient } from '../client';
import { serverKey, resourceKey, invalidateSongViews, type Resource } from '../keys';

export type Domain = 'lireek' | 'drafts' | 'cover' | 'workflow';
const resource = (domain: Domain): Resource => `cover-lyrics/${domain}`;

/** Raw wire snapshots; callers select or hydrate an editable working copy. */
export function snapshotOptions<T>(domain: Domain, path: string, token?: string, options: ReadOptions = {}, staleTime?: number) {
  const [pathname, search = ''] = path.split('?');
  const filters = Object.fromEntries(new URLSearchParams(search));
  const key = serverKey(resource(domain), { auth: !!token, id: pathname, filters });
  return queryOptions({
    queryKey: key,
    queryFn: ({ signal }) => apiClient.get<T>(path, {
      token, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal,
    }),
    ...(staleTime === undefined ? {} : { staleTime }),
  });
}

export function readSnapshot<T>(domain: Domain, path: string, token?: string, options: ReadOptions = {}, staleTime?: number): Promise<T> {
  return queryClient.query(snapshotOptions<T>(domain, path, token, options, staleTime));
}

/** Cancel before invalidating: an older read must never repopulate a changed document. */
export async function changed(domain: Domain, scope?: { session?: number; api?: string }) {
  const queryKey = resourceKey(resource(domain), scope);
  await queryClient.cancelQueries({ queryKey });
  await queryClient.invalidateQueries({ queryKey });
}

export async function songsChanged() {
  await invalidateSongViews(queryClient);
}
