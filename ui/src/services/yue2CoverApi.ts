import { queryClient } from '../queries/client';
import { serverKey } from '../queries/keys';
import { apiClient, type ReadOptions } from './httpClient';
import { readSnapshot, changed } from '../queries/cover-lyrics/reads';
import { getSessionEpoch } from '../queries/keys';
// Authenticated YuE2 cover transcription endpoints.
const BASE = '/api/yue2-cover';

export interface Yue2CoverSourceInput {
  sourceAudioUrl?: string;
  songId?: string;
  sourceLabel?: string;
  abc?: string;
  force?: boolean;
}

export interface Yue2CoverReadiness {
  ready: boolean;
  model: string | null;
  message: string | null;
}

export interface Yue2CoverJob {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  phase: string;
  done: number;
  total: number;
  error: string | null;
}

export interface Yue2CoverResult {
  status?: 'queued' | 'done';
  jobId?: string;
  job?: Yue2CoverJob;
  abc?: string;
  sourceId: string;
  sourceLabel: string;
  scoreSource?: 'dataset';
  sections?: Yue2ScoreSection[];
}

export interface Yue2ScoreSection { label: string; startBar: number }
export interface Yue2SectionReview {
  sections: Yue2ScoreSection[];
  lint: { ok: boolean; scoreCount: number; lyricCount: number; message: string };
}

/** POST /sections/match: lyrics retagged from where the source vocal sings each block. */
export interface Yue2SectionMatch {
  lyrics: string;
  blocks: Array<{ index: number; tag: string | null; newTag: string | null; section: number | null;
    firstWordSeconds: number | null; status: 'kept' | 'renamed' | 'merged' | 'unsure' | 'dropped' }>;
  filled: Array<{ section: number; label: string; copiedFrom: number | null }>;
  unchanged: boolean;
  datasetSong: boolean;
  /** For a dataset song: what the proposal was made against; a save sends it back. */
  revision?: string;
}

/** Match score to lyrics: the score's new sections (1-based bars) and the
 *  lyrics retagged to them. */
export interface Yue2ScorePlan {
  sections: Array<{ label: string; bar: number; block: number | null }>;
  lyrics: string;
  unsure: Array<{ block: number; tag: string | null }>;
  unchanged: boolean;
  datasetSong: boolean;
  revision?: string;
}

export interface Yue2CoverDatasetMetadata {
  matched: boolean;
  metadataAvailable?: boolean;
  datasetId?: string;
  sampleId?: string;
  lyrics?: string;
  bpm?: number;
  key?: string;
  isInstrumental?: boolean;
  abc?: string;
  sections?: Yue2ScoreSection[];
  lyricsSource?: 'dataset-sidecar';
}

export interface Yue2CoverDriftResult {
  metricVersion: number;
  tempoBpm: number;
  meter: string;
  secondsPerBar: number;
  tempoSource: 'rendered-score' | 'source-score-fallback';
  stemChecked: boolean;
  sectionWarning: string | null;
  sungLyricBlocks: number;
  unmatchedLyricBlocks: Array<{ index: number; label: string }>;
  sections: Array<{
    scoreLabel: string;
    lyricTag: string | null;
    startBar: number;
    endBar: number;
    expected: { start: number | null; end: number };
    boundary: { start: number; end: number };
    sung: { start: number; end: number } | null;
    offsetBars: number | null;
    unscoredReason: 'no_matching_lyric_tag' | 'no_vocal_note' | 'no_aligned_words' | 'low_word_confidence' |
      'mix_stem_disagreement' | 'whisper_transcript_unreliable' | 'no_whisper_match' |
      'whisper_disagreement' | null;
    disagreementBars: number | null;
  }>;
  meanAbsoluteOffsetBars: number | null;
  firstOverOneBar: { index: number; label: string; offsetBars: number } | null;
  inputHash?: string;
}

/** A Build-by-section session (server/src/services/yue2Takes.ts). Frames
 *  are codec frames, 25 per second; sections are 0-based. */
export interface Yue2BuildTake {
  id: string;
  /** The build revision it was made at; a take of an older one cannot be kept. */
  revision: number;
  from: number;
  to: number;
  seed: number;
  audioUrl: string;
  frames: number;
  starts: Array<number | null>;
  /** Loudness 0..1 of its new part, from 4 s before its first section. */
  peaks?: number[];
  /** The kept take it resumed (null: it starts the song). */
  parent: string | null;
  /** Ids of the occurrences it composed, from..to. */
  occurrences: string[];
}
/** A section of the score, as the arrangement names it (s0, s1, ... in score order). */
export interface Yue2SourceSection { id: string; label: string; startBar: number; bars: number; lyricBlock: number | null }
/** The output: which source section each occurrence (o0, o1, ...) sings. Kept ones come first. */
export interface Yue2Arrangement {
  sections: Yue2SourceSection[];
  plan: Array<{ id: string; section: string }>;
  /** The plan ends the song; until then its last occurrence cannot be built. */
  finished: boolean;
}
export interface Yue2BuildSession {
  id: string;
  /** Counts changes to what the next take is sent (lyrics); mutations name the one they saw. */
  revision: number;
  sections: Array<{ label: string; startBar: number }>;
  takes: Yue2BuildTake[];
  kept: string[];
  pending: Array<{ from: number; to: number; count: number; activeCount?: number; phase?: string; progress?: number }>;
  error: string | null;
  params: Record<string, unknown>;
  arrangement: Yue2Arrangement;
}

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const target = { session: getSessionEpoch(), api: apiClient.baseUrl };
  const url = `${BASE}${path}`.replace(/^\/api/, '');
  if (!init?.method || init.method === 'GET') return readSnapshot<T>('cover', url, token, { signal: init?.signal ?? undefined }, /\/(build|transcriptions)\//.test(path) ? 0 : undefined);
  const opts = { token, signal: init.signal ?? undefined };
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  if (path === '/source-metadata' || path === '/sections/review') {
    return queryClient.fetchQuery({
      queryKey: serverKey('cover-lyrics/cover', { auth: true, id: path, filters: body }),
      queryFn: ({ signal }) => apiClient.post<T>(url, body, { token, signal: opts.signal ? AbortSignal.any([signal, opts.signal]) : signal }),
    });
  }
  const result = init.method === 'DELETE' ? await apiClient.delete<T>(url, opts) : await apiClient.post<T>(url, body, opts);
  await changed('cover', target);
  return result;
}

export const yue2CoverApi = {
  readiness: (token: string, options: ReadOptions = {}) => request<Yue2CoverReadiness>('/readiness', token, options),
  reviewSections: (abc: string, lyrics: string, token: string, options: ReadOptions = {}) => request<Yue2SectionReview>('/sections/review', token, {
    ...options, method: 'POST', body: JSON.stringify({ abc, lyrics }),
  }),
  matchSections: (input: Yue2CoverSourceInput & { abc: string; lyrics: string }, token: string) =>
    request<Yue2SectionMatch>('/sections/match', token, { method: 'POST', body: JSON.stringify(input) }),
  /** `lyrics` is the build's own text; without it the session follows params.lyrics. */
  buildStart: (params: Record<string, unknown>, token: string, lyrics?: string) =>
    request<Yue2BuildSession>('/build', token, { method: 'POST', body: JSON.stringify({ params, ...(lyrics === undefined ? {} : { lyrics }) }) }),
  buildLyricsCheck: (lyrics: string, token: string) =>
    request<{ ok: true }>('/build/lyrics-check', token, { method: 'POST', body: JSON.stringify({ lyrics }) }),
  buildLyrics: (id: string, revision: number, lyrics: string, token: string) =>
    request<Yue2BuildSession>(`/build/${id}/lyrics`, token, { method: 'POST', body: JSON.stringify({ revision, lyrics }) }),
  /** Replaces the unbuilt part of the plan: `upcoming` lists source section ids (s0...) for new
   *  occurrences, or ids of upcoming occurrences (o3...) to keep them, in the order to build. */
  buildPlan: (id: string, revision: number, upcoming: string[], finished: boolean, token: string) =>
    request<Yue2BuildSession>(`/build/${id}/plan`, token, { method: 'POST', body: JSON.stringify({ revision, upcoming, finished }) }),
  buildGet: (id: string, token: string, options: ReadOptions = {}) => request<Yue2BuildSession>(`/build/${id}`, token, options),
  buildGenerate: (id: string, revision: number, to: number, count: number, token: string) =>
    request<Yue2BuildSession>(`/build/${id}/generate`, token, { method: 'POST', body: JSON.stringify({ revision, to, count }) }),
  buildCancel: (id: string, token: string) =>
    request<Yue2BuildSession>(`/build/${id}/cancel`, token, { method: 'POST' }),
  buildKeep: (id: string, revision: number, take: string, token: string) =>
    request<Yue2BuildSession>(`/build/${id}/keep`, token, { method: 'POST', body: JSON.stringify({ revision, take }) }),
  /** Drops the last kept take, or every kept take from `section` on. */
  buildUndo: (id: string, revision: number, token: string, section?: number) =>
    request<Yue2BuildSession>(`/build/${id}/undo`, token, { method: 'POST', body: JSON.stringify(section === undefined ? { revision } : { revision, section }) }),
  buildDelete: (id: string, revision: number, take: string, token: string) =>
    request<Yue2BuildSession>(`/build/${id}/takes/${take}?revision=${revision}`, token, { method: 'DELETE' }),
  planScoreSections: (input: Yue2CoverSourceInput & { abc: string; lyrics: string }, token: string) =>
    request<Yue2ScorePlan>('/sections/plan-score', token, { method: 'POST', body: JSON.stringify(input) }),
  /** Lyrics (.txt) and/or the revised score (.abc) of a matched proposal, with the
   *  `revision` it returned; or the score's tempo and key into the .txt. The two
   *  files are separate writes: `abcSaved: false` means the lyrics went in and the score did not. */
  saveDatasetDetails: (input: Yue2CoverSourceInput & ({ lyrics?: string; abc?: string; revision: string } | { bpm: number; key: string }), token: string) =>
    request<{ saved: true; file: string; abcSaved?: boolean; abcError?: string }>('/sections/save-dataset', token, { method: 'POST', body: JSON.stringify(input) }),
  sourceMetadata: (input: Yue2CoverSourceInput, token: string, options: ReadOptions = {}) => request<Yue2CoverDatasetMetadata>('/source-metadata', token, {
    ...options, method: 'POST', body: JSON.stringify(input),
  }),
  start: (input: Yue2CoverSourceInput, token: string) => request<Yue2CoverResult>('/transcriptions', token, {
    method: 'POST', body: JSON.stringify(input),
  }),
  status: (jobId: string, token: string, options: ReadOptions = {}) => request<Yue2CoverResult>(`/transcriptions/${encodeURIComponent(jobId)}`, token, options),
  cancel: (jobId: string, token: string) => request<Yue2CoverResult>(`/transcriptions/${encodeURIComponent(jobId)}`, token, { method: 'DELETE' }),
  measureDrift: (songId: string, token: string) => request<Yue2CoverDriftResult>(
    `/drift/${encodeURIComponent(songId)}`, token, { method: 'POST' }),
};
