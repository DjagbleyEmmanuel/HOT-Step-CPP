import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createYue2Prepare } from './useYue2Prepare';
import { PrepareLyrics } from './PrepareLyrics';
import { PrepareStructure } from './PrepareStructure';
import type { Prepare } from './prepareView';

const ABC = [
  'X:1', 'M:4/4', 'L:1/8', 'Q:1/4=120', 'K:C',
  '% intro', 'V:Vocal', 'Z4|', 'V:Ins', '"C"C8|"F"F8|"G"G8|"C"C8|',
  '% verse', 'V:Vocal', 'C2D2E2F2|G8|', 'V:Ins', '"C"C8|"G"G8|',
  '% chorus', 'V:Vocal', 'c8|B8|', 'V:Ins', '"F"F8|"G"G8|',
  '% chorus', 'V:Vocal', 'c8|B8|', 'V:Ins', '"F"F8|"G"G8|',
].join('\n');
const PASTE = '[Verse 1]\none two three\nfour five six\n\n[Chorus]\nseven eight\nnine ten\n';

// What useYue2Prepare hands a view, around the synchronous controller.
const view = (c: ReturnType<typeof createYue2Prepare>): Prepare => ({
  ...c.getSnapshot(), ...c, canUndo: c.canUndo, canRedo: c.canRedo,
  recordingSeekAvailable: false, recordingAlignmentAvailable: false, draftFields: {},
}) as unknown as Prepare;
const html = (c: ReturnType<typeof createYue2Prepare>, tab: 'structure' | 'lyrics') => renderToStaticMarkup(tab === 'structure'
  ? React.createElement(PrepareStructure, { prep: view(c), sourceAudioUrl: '', scorePlaying: false, onPlayScore: () => {}, onHighlight: () => {}, onConfirmed: () => {} })
  : React.createElement(PrepareLyrics, { prep: view(c), lyrics: PASTE, onLyricsText: () => {}, suggest: () => Promise.reject(new Error('no')),
    scorePlaying: false, onPlayScore: () => {}, activeSection: null, wide: true }));

test('the structure step shows every section with its bars, and the confirm button', () => {
  const c = createYue2Prepare({ sourceKey: 'k', abc: ABC, lyrics: PASTE });
  const out = html(c, 'structure');
  for (const label of ['intro', 'verse', 'chorus']) assert.match(out, new RegExp(label));
  assert.match(out, /cover\.prepare\.structure\.confirm/);
  assert.doesNotMatch(out, /cover\.prepare\.structure\.locked/);
});

test('a confirmed structure is shown locked, and its edit controls are disabled', () => {
  const c = createYue2Prepare({ sourceKey: 'k', abc: ABC, lyrics: PASTE });
  assert.ok(c.confirmStructure());
  c.showStep('structure');
  const out = html(c, 'structure');
  assert.match(out, /cover\.prepare\.structure\.locked/);
  assert.match(out, /<fieldset disabled=""/);
});

test('the lyrics step lists every pasted block and every section, and the Ready step the ordered pair', () => {
  const c = createYue2Prepare({ sourceKey: 'k', abc: ABC, lyrics: PASTE });
  assert.ok(c.confirmStructure());
  let out = html(c, 'lyrics');
  assert.match(out, /one two three/);
  assert.match(out, /seven eight/);
  assert.match(out, /chorus \(1\/2\)/);
  assert.match(out, /chorus \(2\/2\)/);
  assert.match(out, /cover\.prepare\.lyrics\.needsWords/);

  const [verse, chorus] = c.getSnapshot().doc.blocks;
  const ids = c.getSnapshot().doc.sectionIds;
  assert.ok(c.applyLyricOp({ kind: 'instrumental', sectionId: ids[0] }));
  assert.ok(c.applyLyricOp({ kind: 'assign', blockId: verse.id, sectionId: ids[1] }));
  assert.ok(c.applyLyricOp({ kind: 'assign', blockId: chorus.id, sectionId: ids[2] }));
  assert.ok(c.applyLyricOp({ kind: 'reuse', blockId: chorus.id, sectionIds: [ids[3]] }));
  out = html(c, 'lyrics');
  assert.match(out, /cover\.prepare\.lyrics\.copy/);
  assert.ok(c.confirmLyrics());
  assert.equal(c.getSnapshot().step, 'ready');
  out = html(c, 'lyrics');
  assert.match(out, /cover\.prepare\.ready\.title/);
  assert.match(out, /one two three/);
  assert.equal((out.match(/seven eight/g) ?? []).length, 2, 'both choruses are in the ready preview');
});

test('an editing structure locks the lyrics view', () => {
  const c = createYue2Prepare({ sourceKey: 'k', abc: ABC, lyrics: PASTE });
  assert.ok(c.confirmStructure());
  assert.ok(c.beginStructureEdit());
  const out = html(c, 'lyrics');
  assert.match(out, /cover\.prepare\.lyrics\.needStructure/);
});
