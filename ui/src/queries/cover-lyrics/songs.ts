import { queryOptions } from '@tanstack/react-query';
import { songApi, normalizeSong } from '../../services/api';
import { apiClient } from '../../services/httpClient';
import type { Song } from '../../types';
import { serverKey } from '../keys';
import { queryClient } from '../client';
import { songsChanged } from './reads';

/** The filtered endpoint has its own key; it is not the shared full library. */
export const coverSongsOptions = (token: string) => queryOptions({
  queryKey: serverKey('cover-lyrics/cover-songs', { auth: true }),
  queryFn: async ({ signal }) => {
    const result = await apiClient.get<{ songs: unknown[] }>('/songs?source=cover-studio', { token, signal });
    return { songs: result.songs.map(normalizeSong) };
  },
});

export async function deleteCovers(token: string, ids: string[]) {
  const queryKey = coverSongsOptions(token).queryKey;
  await queryClient.cancelQueries({ queryKey });
  try {
    await songApi.bulkDelete(ids, token);
    await queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData<{ songs: Song[] }>(queryKey, old => old && ({ songs: old.songs.filter(s => !ids.includes(s.id)) }));
    await songsChanged();
  } finally { await queryClient.invalidateQueries({ queryKey }); }
}
