import { apiClient, type ReadOptions } from './httpClient';
// midiStudioApi.ts — API client for MIDI Studio (audio → MIDI transcription)
//
// Communicates with Node server /api/midi-studio endpoints, which run
// MuScriptor (Kyutai & Mirelo) in a server-managed Python venv.

const API_BASE = '/api/midi-studio';
/** Path prefix for apiClient calls (the client already adds `/api`). */
const P = '/midi-studio';

// ── Types ────────────────────────────────────────────────────────────────

export type MuscriptorModel = 'small' | 'medium' | 'large';

export interface ModelState {
  downloaded: boolean;
  sizeBytes: number;
  downloading: boolean;
  receivedBytes: number;
  totalBytes: number;
  error?: string;
  gated?: boolean;
}

export interface MidiStudioStatus {
  /** ace-midi engine binary present next to ace-server */
  engineAvailable: boolean;
  hfTokenSet: boolean;
  models: Record<MuscriptorModel, ModelState>;
}

export interface MidiJobProgress {
  status: 'queued' | 'transcribing' | 'done' | 'failed' | 'cancelled';
  chunksDone?: number;
  chunksTotal?: number;
  noteCount?: number;
  error?: string;
  gated?: boolean;
  partial?: boolean;
}

export interface MidiJobSummary {
  id: string;
  status: 'queued' | 'transcribing' | 'done' | 'failed' | 'cancelled';
  sourceFileName: string;
  /** URL of the original audio (for synced playback in the player) */
  sourceAudioUrl?: string;
  songId?: string;
  model: MuscriptorModel;
  noteCount: number;
  durationSec: number;
  createdAt: string;
  error?: string;
  /** Failure looks like gated-model / HF auth trouble */
  gated?: boolean;
  /** Failed, but the notes decoded before the failure were saved as a .mid */
  partial?: boolean;
  /** chunk progress — present on in-flight jobs */
  chunksDone?: number;
  chunksTotal?: number;
}

/**
 * The MuScriptor weights are GATED on Hugging Face — each user must request
 * access on the model page (free, instant after accepting the conditions)
 * and provide a read token before the first download.
 */
export const HF_MODEL_URLS: Record<MuscriptorModel, string> = {
  small: 'https://huggingface.co/MuScriptor/muscriptor-small',
  medium: 'https://huggingface.co/MuScriptor/muscriptor-medium',
  large: 'https://huggingface.co/MuScriptor/muscriptor-large',
};

export const HF_TOKEN_SETTINGS_URL = 'https://huggingface.co/settings/tokens';

export interface MidiNote {
  pitch: number;
  velocity: number;
  channel: number;
  start: number;
  duration: number;
}

export interface MidiChannelInfo {
  channel: number;
  program: number;
  isDrums: boolean;
  noteCount: number;
}

export interface ParsedMidi {
  durationSec: number;
  noteCount: number;
  channels: MidiChannelInfo[];
  notes: MidiNote[];
}

export interface TranscribeParams {
  sourceAudioUrl: string;
  sourceFileName: string;
  songId?: string;
  model: MuscriptorModel;
}

// ── API Functions ────────────────────────────────────────────────────────

/** Get MuScriptor install/environment status. */
export async function getMidiStatus(opts?: ReadOptions): Promise<MidiStudioStatus> {
  return apiClient.get<MidiStudioStatus>(`${P}/status`, opts);
}

/** Save (or clear, with '') the Hugging Face read token for gated weights. */
export async function saveHfToken(token: string): Promise<void> {
  await apiClient.post(`${P}/hf-token`, { token });
}

/** Begin downloading a model's gated weights. Poll getMidiStatus() for progress. */
export async function startModelDownload(model: MuscriptorModel): Promise<void> {
  await apiClient.post(`${P}/models/${model}/download`);
}

/** Poll a transcription job's progress. */
export async function getMidiProgress(jobId: string, opts?: ReadOptions): Promise<MidiJobProgress> {
  return apiClient.get<MidiJobProgress>(`${P}/${jobId}/progress`, opts);
}

/** SSE URL streaming live note events for an in-flight job (Phase 6 UI). */
export function getMidiStreamUrl(jobId: string): string {
  return `${API_BASE}/${jobId}/stream`;
}

/** Queue a transcription job. Returns the job ID. */
export async function submitTranscription(params: TranscribeParams): Promise<string> {
  const data = await apiClient.post<{ id: string }>(`${P}/transcribe`, params);
  return data.id;
}

/** Fetch the parsed note data for the piano-roll preview. */
export async function getMidiNotes(jobId: string, opts?: ReadOptions): Promise<ParsedMidi> {
  return apiClient.get<ParsedMidi>(`${P}/${jobId}/notes`, opts);
}

/** List all transcription jobs (newest first). */
export async function listMidiJobs(opts?: ReadOptions): Promise<MidiJobSummary[]> {
  return apiClient.get<MidiJobSummary[]>(`${P}/jobs`, opts);
}

/** Cancel and/or delete a job. */
export async function deleteMidiJob(jobId: string): Promise<void> {
  await apiClient.delete(`${P}/${jobId}`);
}

/** Direct URL for downloading the .mid file of a completed job. */
export function getMidiFileUrl(jobId: string): string {
  return `${API_BASE}/${jobId}/file`;
}

// ── GM instrument names (for channel legend) ─────────────────────────────

const GM_FAMILIES = [
  'Piano', 'Chromatic Perc.', 'Organ', 'Guitar', 'Bass', 'Strings',
  'Ensemble', 'Brass', 'Reed', 'Pipe', 'Synth Lead', 'Synth Pad',
  'Synth FX', 'Ethnic', 'Percussive', 'Sound FX',
];

/** Coarse GM name for a channel (family-level; channel 9 = drums). */
export function channelLabel(ch: MidiChannelInfo): string {
  if (ch.isDrums) return 'Drums';
  return GM_FAMILIES[Math.floor(ch.program / 8)] || `Program ${ch.program}`;
}
