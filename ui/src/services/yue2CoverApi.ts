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
}

/** Match score to lyrics: the score's new sections (1-based bars) and the
 *  lyrics retagged to them. */
export interface Yue2ScorePlan {
  sections: Array<{ label: string; bar: number; block: number | null }>;
  lyrics: string;
  unsure: Array<{ block: number; tag: string | null }>;
  unchanged: boolean;
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
  from: number;
  to: number;
  seed: number;
  audioUrl: string;
  frames: number;
  starts: Array<number | null>;
  /** Loudness 0..1 of its new part, from 4 s before its first section. */
  peaks?: number[];
}
export interface Yue2BuildSession {
  id: string;
  sections: Array<{ label: string; startBar: number }>;
  takes: Yue2BuildTake[];
  kept: string[];
  pending: Array<{ from: number; to: number; count: number }>;
  error: string | null;
  params: Record<string, unknown>;
}

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || `Cover transcription failed (${response.status})`);
  return result;
}

export const yue2CoverApi = {
  readiness: (token: string) => request<Yue2CoverReadiness>('/readiness', token),
  reviewSections: (abc: string, lyrics: string, token: string) => request<Yue2SectionReview>('/sections/review', token, {
    method: 'POST', body: JSON.stringify({ abc, lyrics }),
  }),
  matchSections: (input: Yue2CoverSourceInput & { abc: string; lyrics: string }, token: string) =>
    request<Yue2SectionMatch>('/sections/match', token, { method: 'POST', body: JSON.stringify(input) }),
  buildStart: (params: Record<string, unknown>, token: string) =>
    request<Yue2BuildSession>('/build', token, { method: 'POST', body: JSON.stringify({ params }) }),
  buildGet: (id: string, token: string) => request<Yue2BuildSession>(`/build/${id}`, token),
  buildGenerate: (id: string, to: number, count: number, token: string) =>
    request<Yue2BuildSession>(`/build/${id}/generate`, token, { method: 'POST', body: JSON.stringify({ to, count }) }),
  buildKeep: (id: string, take: string, token: string) =>
    request<Yue2BuildSession>(`/build/${id}/keep`, token, { method: 'POST', body: JSON.stringify({ take }) }),
  /** Drops the last kept take, or every kept take from `section` on. */
  buildUndo: (id: string, token: string, section?: number) =>
    request<Yue2BuildSession>(`/build/${id}/undo`, token, { method: 'POST', body: JSON.stringify(section === undefined ? {} : { section }) }),
  buildDelete: (id: string, take: string, token: string) =>
    request<Yue2BuildSession>(`/build/${id}/takes/${take}`, token, { method: 'DELETE' }),
  planScoreSections: (input: Yue2CoverSourceInput & { abc: string; lyrics: string }, token: string) =>
    request<Yue2ScorePlan>('/sections/plan-score', token, { method: 'POST', body: JSON.stringify(input) }),
  /** Lyrics, or the score's tempo and key, into the dataset song's .txt. */
  saveDatasetDetails: (input: Yue2CoverSourceInput & ({ lyrics: string } | { bpm: number; key: string }), token: string) =>
    request<{ saved: true; file: string }>('/sections/save-dataset', token, { method: 'POST', body: JSON.stringify(input) }),
  sourceMetadata: (input: Yue2CoverSourceInput, token: string) => request<Yue2CoverDatasetMetadata>('/source-metadata', token, {
    method: 'POST', body: JSON.stringify(input),
  }),
  start: (input: Yue2CoverSourceInput, token: string) => request<Yue2CoverResult>('/transcriptions', token, {
    method: 'POST', body: JSON.stringify(input),
  }),
  status: (jobId: string, token: string) => request<Yue2CoverResult>(`/transcriptions/${encodeURIComponent(jobId)}`, token),
  cancel: (jobId: string, token: string) => request<Yue2CoverResult>(`/transcriptions/${encodeURIComponent(jobId)}`, token, { method: 'DELETE' }),
  measureDrift: (songId: string, token: string) => request<Yue2CoverDriftResult>(
    `/drift/${encodeURIComponent(songId)}`, token, { method: 'POST' }),
};
