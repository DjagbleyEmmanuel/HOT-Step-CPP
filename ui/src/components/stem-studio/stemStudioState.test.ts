// stemStudioState.test.ts — the restore rules behind Stem Studio's state.
//   (cd server && node --import tsx --test ../ui/src/components/stem-studio/stemStudioState.test.ts)
//
// Switching studio unmounts Stem Studio while its separation keeps running, so
// the page has to come back to the same job, progress and mixer instead of
// resetting to defaults. These cover what is restored and what is not.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_STEM_TRACKS, STUDIO_STATE_KEY, isFinished, readStudioState,
  restoreStudioState, writeStudioState, type StudioState, type StemStudioStorage,
} from './stemStudioState';
import type { ExtractProgress } from '../../services/stemStudioApi';

function fakeStorage(initial: Record<string, string> = {}): StemStudioStorage & { entries: Map<string, string> } {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
  };
}

const running: ExtractProgress = {
  status: 'separating', progress: 42, currentTrack: '', completedStems: [], totalTracks: 4,
};

test('an empty install restores the documented defaults', () => {
  const state = restoreStudioState(readStudioState(fakeStorage()));
  assert.deepEqual(state.selectedTracks, DEFAULT_STEM_TRACKS);
  assert.equal(state.mode, 'supersep');
  assert.equal(state.activeJobId, null);
  assert.equal(state.extractProgress, null);
  assert.equal(state.mixerStems, null);
});

test('a half-finished separation comes back as it was left', () => {
  const storage = fakeStorage({
    [STUDIO_STATE_KEY]: JSON.stringify({
      mode: 'extract', selectedTracks: ['vocals', 'piano'], style: 'indie', lyrics: 'la la',
      activeJobId: 'job-7', extractProgress: running,
      mixerStems: [{ name: 'vocals', category: 'vocals', audioUrl: '/a.wav', index: 0 }],
      stemControls: [{ index: 0, volume: 0.5, muted: true }],
    }),
  });
  const state = restoreStudioState(readStudioState(storage));
  assert.equal(state.mode, 'extract');
  assert.deepEqual(state.selectedTracks, ['vocals', 'piano']);
  assert.equal(state.style, 'indie');
  assert.equal(state.activeJobId, 'job-7');
  assert.equal(state.extractProgress?.progress, 42);
  assert.equal(state.mixerStems?.length, 1);
  assert.equal(state.stemControls[0].muted, true);
});

test('a corrupt entry falls back instead of stopping the page', () => {
  assert.deepEqual(readStudioState(fakeStorage({ [STUDIO_STATE_KEY]: '{not json' })), {});
  assert.deepEqual(restoreStudioState(readStudioState(fakeStorage({ [STUDIO_STATE_KEY]: 'null' }))).selectedTracks,
    DEFAULT_STEM_TRACKS);
});

test('an empty track selection restores the default set', () => {
  assert.deepEqual(restoreStudioState({ selectedTracks: [] }).selectedTracks, DEFAULT_STEM_TRACKS);
  assert.deepEqual(restoreStudioState({ selectedTracks: ['drums'] as unknown as string[] }).selectedTracks, ['drums']);
});

test('writing then reading returns the same state', () => {
  const storage = fakeStorage();
  const state: StudioState = {
    mode: 'extract', selectedTracks: ['bass'], style: '', lyrics: '',
    activeJobId: 'job-1', extractProgress: running, mixerStems: null, stemControls: [],
  };
  writeStudioState(storage, state);
  assert.deepEqual(restoreStudioState(readStudioState(storage)), state);
});

test('only terminal statuses count as finished', () => {
  assert.equal(isFinished(null), false);
  assert.equal(isFinished(running), false);
  for (const status of ['done', 'failed', 'cancelled']) {
    assert.equal(isFinished({ ...running, status } as ExtractProgress), true);
  }
});
