import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { cleanRuachLyrics, parseRuachCaption, prepareRuachCaption } from './ruachCaption.js';
import { ruachLegacyManifest } from './yue2AitkPrepareRunner.js';

test('Ruach lyric cleaning keeps known sections and words, removes cues and unsupported headings', () => {
  const input = '(quiet mood)\n[EXTENDED OUTRO]\n(wind)\nA word (whispered) stays\n[Unknown]\n[VERSE 2]\nNext line';
  assert.deepEqual(cleanRuachLyrics(input), {
    lyrics: '[Outro]\nA word stays\n[Verse]\nNext line', hints: ['quiet mood'],
  });
});

test('Ruach caption parser separates style and lyrics and normalizes section case', () => {
  assert.deepEqual(parseRuachCaption('A style\n[Lyrics]\n[pre-chorus]\nWords\n[Duration]\n120'),
    { style: 'A style', lyrics: '[Pre-Chorus]\nWords' });
  assert.deepEqual(prepareRuachCaption('A  style', '[VERSE]\nWords'),
    { style: 'A style', lyrics: '[Verse]\nWords' });
});

test('Ruach preparation cleans the legacy caption without changing cached audio paths', () => {
  const source = { latents: 'latents/track.f32', codec_ids: 'codes/track.i32',
    caption: 'A  style\n[Lyrics]\n[CHORUS]\nHey (echo)', lyrics: '' };
  const result = JSON.parse(ruachLegacyManifest(JSON.stringify({ caption_format: 'plain', sources: [source] })));
  assert.equal(result.caption_format, 'ace-sidecar');
  assert.deepEqual(result.sources[0], { ...source, caption: 'A style', lyrics: '[Chorus]\nHey' });
});

const fixtures = path.resolve(import.meta.dirname, '../../../../.scratch/ruach-parity');
test('three private caption fixtures retain Ruach Direct-mode prefix IDs', { skip: !fs.existsSync(path.join(fixtures, 'fixtures/onestep.json')) }, () => {
  const source = JSON.parse(ruachLegacyManifest(fs.readFileSync(path.join(fixtures, 'prep0/yue2_preprocess.json'), 'utf8')));
  const prepared = JSON.parse(fs.readFileSync(path.join(fixtures, 'a1_dataset/dataset.json'), 'utf8'));
  const reference = JSON.parse(fs.readFileSync(path.join(fixtures, 'fixtures/onestep.json'), 'utf8'));
  for (const entry of source.sources) {
    const id = String(entry.name).slice(0, 3);
    const item = prepared.items.find((candidate: { id: string }) => candidate.id === entry.name);
    assert.ok(item, `missing prepared fixture ${id}`);
    assert.deepEqual({ style: entry.caption, lyrics: entry.lyrics }, { style: item.style, lyrics: item.lyrics }, id);
    assert.deepEqual(item.prefix_off_ids, reference.prompt_ids[id].prefix_head_ids, id);
  }
});
