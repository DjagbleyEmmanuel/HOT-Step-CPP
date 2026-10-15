// lyrics.ts — a track's lyric sidecars (.lrc, .lyrics.json) for the player.
//
// Shared keys: every variant of a track (`_mastered`, `_noadapter`, `?_t=`)
// maps to one sidecar URL, so the lyrics bar and section markers share one
// read per track. A missing sidecar caches null; failures are not cached.
// A crop or retranscription rewrites them: invalidateSidecars (keys.ts).

import { queryOptions } from '@tanstack/react-query';
import { fetchLrc } from '../../utils/lrcUtils';
import { fetchLyricsJson, sidecarUrl } from '../../utils/wordLrcUtils';
import { sharedKeys } from '../keys';

export const lrcOptions = (audioUrl: string) => queryOptions({
  queryKey: sharedKeys.lrc(sidecarUrl(audioUrl, '.lrc')),
  queryFn: ({ signal }) => fetchLrc(audioUrl, { signal }),
  enabled: !!audioUrl,
});

export const lyricsJsonOptions = (audioUrl: string) => queryOptions({
  queryKey: sharedKeys.lyricsJson(sidecarUrl(audioUrl, '.lyrics.json')),
  queryFn: ({ signal }) => fetchLyricsJson(audioUrl, { signal }),
  enabled: !!audioUrl,
});

