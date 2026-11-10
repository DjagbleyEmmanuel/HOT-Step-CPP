// stemStudioState.ts — the working state Stem Studio keeps between visits.
//
// Switching studio in the sidebar unmounts Stem Studio, while the separation it
// started keeps running server-side. Without this the mixer, the progress bar
// and the track selection all reset to their defaults on the way back, which
// looks like the page forgot the job even though the job is fine. Kept here as
// plain functions so the restore rules can be tested without React.

import type { ExtractProgress } from '../../services/stemStudioApi';
import type { MixerStemInfo, StemControl } from '../shared/StemMixer';

/** localStorage key. Separate from the `hs-stem-*` keys the source audio and
 *  model selection already use. */
export const STUDIO_STATE_KEY = 'hs-stem-studio';

export type StudioMode = 'extract' | 'supersep';

export interface StudioState {
  mode: StudioMode;
  selectedTracks: string[];
  style: string;
  lyrics: string;
  activeJobId: string | null;
  extractProgress: ExtractProgress | null;
  mixerStems: MixerStemInfo[] | null;
  stemControls: StemControl[];
}

/** Tracks selected before the user chooses any — the four the Extract path
 *  offers first. */
export const DEFAULT_STEM_TRACKS = ['vocals', 'drums', 'bass', 'guitar'];

/** Minimal storage surface, so tests can pass a Map-backed fake. */
export interface StemStudioStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The saved state, or an empty object when there is none or it is unreadable.
 *  A corrupt entry must not stop the page from opening. */
export function readStudioState(storage: StemStudioStorage | undefined): Partial<StudioState> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(STUDIO_STATE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Partial<StudioState>) : {};
  } catch {
    return {};
  }
}

/** Persist a snapshot. Storage being full is not an error worth surfacing. */
export function writeStudioState(storage: StemStudioStorage | undefined, state: StudioState): void {
  if (!storage) return;
  try {
    storage.setItem(STUDIO_STATE_KEY, JSON.stringify(state));
  } catch { /* quota or unavailable storage — the page still works */ }
}

/** A separation that has already stopped on the server needs no reattachment. */
export function isFinished(p: ExtractProgress | null | undefined): boolean {
  return !!p && ['done', 'failed', 'cancelled'].includes(p.status);
}

/** Initial state for the page's useState() calls, from whatever was saved. */
export function restoreStudioState(saved: Partial<StudioState>): StudioState {
  const tracks = Array.isArray(saved.selectedTracks)
    ? saved.selectedTracks.filter((t): t is string => typeof t === 'string')
    : [];
  return {
    // SuperSep is the default: it is the general-purpose separator.
    mode: saved.mode === 'extract' ? 'extract' : 'supersep',
    selectedTracks: tracks.length ? tracks : DEFAULT_STEM_TRACKS,
    style: typeof saved.style === 'string' ? saved.style : '',
    lyrics: typeof saved.lyrics === 'string' ? saved.lyrics : '',
    activeJobId: typeof saved.activeJobId === 'string' && saved.activeJobId ? saved.activeJobId : null,
    extractProgress: saved.extractProgress ?? null,
    mixerStems: Array.isArray(saved.mixerStems) ? saved.mixerStems : null,
    stemControls: Array.isArray(saved.stemControls) ? saved.stemControls : [],
  };
}
