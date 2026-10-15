import { queryOptions } from '@tanstack/react-query';
import { ApiError } from '../../services/httpClient';
import { sidecarUrl } from '../../utils/wordLrcUtils';
import { serverKey } from '../keys';

export const lyricsOptions = (audioUrl: string) => queryOptions({
  queryKey: serverKey('studios/lyrics', { id: audioUrl }),
  queryFn: async ({ signal }) => {
    const response = await fetch(sidecarUrl(audioUrl, '.lrc'), { signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new ApiError(response.status, `Lyrics fetch failed (${response.status})`, null);
    const text = await response.text();
    return text.includes('[') ? text : null;
  },
  enabled: !!audioUrl,
});
