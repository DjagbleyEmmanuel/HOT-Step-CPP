import assert from 'node:assert/strict';
import test from 'node:test';
import { instrumentalScore, instrumentalStyle } from './instrumentalScore.js';

const HEAD = 'X:1\nT:\nM:4/4\nL:1/32\nQ:1/4=82\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\n'
  + 'V: Ins clef=treble name="Ins Melody" snm="Inst."\nK:Bb\n';

test('sung bars move to Ins; Vocal keeps its chords on rests; silent bars keep Ins', () => {
  const abc = HEAD + '% intro\nV: Vocal\n"Bb"z32|"Gm"z32|\nV: Ins\nB,4F2B6f8B2c2d2c2B4|G4G2B6f8B2c2d2c2B4|\n'
    + '% verse\nV: Vocal\n"Bb"z4d2d2d4d4d2c2B2B6z4|"G"B8d8"D"f16|Z2|\nV: Ins\nZ4|\n';
  const result = instrumentalScore(abc);
  assert.equal(result.abc, HEAD + '% intro\nV: Vocal\n"Bb"z32|"Gm"z32|\nV: Ins\nB,4F2B6f8B2c2d2c2B4|G4G2B6f8B2c2d2c2B4|\n'
    + '% verse\nV: Vocal\n"Bb"z32|"G"z16"D"z16|Z2|\nV: Ins\nz4d2d2d4d4d2c2B2B6z4|B8d8f16|Z2|\n');
  assert.equal(result.movedBars, 2);
  assert.equal(result.replacedInsBars, 0);
  assert.deepEqual(instrumentalScore(result.abc), { abc: result.abc, movedBars: 0, replacedInsBars: 0 });
});

test('Vocal wins a bar both voices play in, and an unchorded sung bar becomes Z', () => {
  const abc = HEAD + 'V: Vocal\nc8d8e8-e8|\nV: Ins\nB,32|\n';
  const result = instrumentalScore(abc);
  assert.equal(result.abc, HEAD + 'V: Vocal\nZ|\nV: Ins\nc8d8e8-e8|\n');
  assert.equal(result.replacedInsBars, 1);
});

test('a melody-only score gains an Ins voice to carry the melody', () => {
  const head = 'X:1\nM:4/4\nL:1/32\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\nK:D\n';
  const result = instrumentalScore(head + '% verse\nV: Vocal\nf16B16|\n');
  assert.equal(result.abc, 'X:1\nM:4/4\nL:1/32\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\n'
    + 'V: Ins clef=treble name="Ins Melody" snm="Inst."\nK:D\n% verse\nV: Vocal\nZ|\nV: Ins\nf16B16|\n');
});

test('a score with no Vocal voice is left alone', () => {
  const abc = 'X:1\nL:1/4\nK:D\nf2 B c | d4 |\n';
  assert.deepEqual(instrumentalScore(abc), { abc, movedBars: 0, replacedInsBars: 0 });
});

test('instrumental style follows upstream wording and is idempotent', () => {
  const style = instrumentalStyle('gentle solo piano, slow and minimal.');
  assert.equal(style, 'Instrumental, gentle solo piano, slow and minimal, no vocals, no singing, no choir, no spoken words.');
  assert.equal(instrumentalStyle(style), style);
});
