import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanFixedRecipeLyrics, parseFixedRecipeCaption, prepareFixedRecipeCaption } from './fixedRecipeCaption.js';
import { fixedRecipeLegacyManifest } from './yue2AitkPrepareRunner.js';

test('Fixed-recipe lyric cleaning keeps known sections and words, removes cues and unsupported headings', () => {
  const input = '(quiet mood)\n[EXTENDED OUTRO]\n(wind)\nA word (whispered) stays\n[Unknown]\n[VERSE 2]\nNext line';
  assert.deepEqual(cleanFixedRecipeLyrics(input), {
    lyrics: '[Outro]\nA word stays\n[Verse]\nNext line', hints: ['quiet mood'],
  });
});

test('Fixed-recipe caption parser separates style and lyrics and normalizes section case', () => {
  assert.deepEqual(parseFixedRecipeCaption('A style\n[Lyrics]\n[pre-chorus]\nWords\n[Duration]\n120'),
    { style: 'A style', lyrics: '[Pre-Chorus]\nWords' });
  assert.deepEqual(prepareFixedRecipeCaption('A  style', '[VERSE]\nWords'),
    { style: 'A style', lyrics: '[Verse]\nWords' });
});

test('Fixed-recipe preparation cleans the legacy caption without changing cached audio paths', () => {
  const source = { latents: 'latents/track.f32', codec_ids: 'codes/track.i32',
    caption: 'A  style\n[Lyrics]\n[CHORUS]\nHey (echo)', lyrics: '' };
  const result = JSON.parse(fixedRecipeLegacyManifest(JSON.stringify({ caption_format: 'plain', sources: [source] })));
  assert.equal(result.caption_format, 'ace-sidecar');
  assert.deepEqual(result.sources[0], { ...source, caption: 'A style', lyrics: '[Chorus]\nHey' });
});
