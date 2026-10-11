import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DOMParser } from 'linkedom';
import abcjs from 'abcjs';
import { importMusicXml } from './index';

Object.assign(globalThis, { DOMParser });
const fixture = (name: string) => {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return new Blob([new Uint8Array(readFileSync(path))]);
};
const parseable = (abc: string) => {
  const tune = abcjs.parseOnly(abc)[0];
  assert.ok(tune);
  assert.deepEqual(tune.warnings ?? [], []);
};

test('MuseScore MXL follows its container and offers voice and piano parts', async () => {
  const name = 'openscore_nun_seh_ich_wohl.mxl';
  const first = await importMusicXml(fixture(name), name);
  assert.equal(first.abc, '');
  assert.equal(first.parts.length, 2);
  assert.ok(first.parts[0].hasLyrics);
  const chosen = await importMusicXml(fixture(name), name, { partId: first.parts[0].id });
  assert.ok(chosen.abc.includes('w: '));
  assert.ok(chosen.warnings.some(w => w.includes('Multiple voices')));
  parseable(chosen.abc);
});

test('Sibelius choir excerpt offers five parts and a lyric-bearing part parses', async () => {
  const name = 'kyrie_excerpt.xml';
  const first = await importMusicXml(fixture(name), name);
  assert.equal(first.abc, '');
  assert.equal(first.parts.length, 5);
  const chosen = await importMusicXml(fixture(name), name, { partId: 'P2' });
  assert.ok(chosen.abc.includes('w: '));
  parseable(chosen.abc);
});

test('Finale tablature offers part choice and warns about transposition', async () => {
  const name = 'w3c_tutorial-tablature.musicxml';
  const first = await importMusicXml(fixture(name), name);
  assert.equal(first.abc, '');
  assert.equal(first.parts.length, 2);
  const chosen = await importMusicXml(fixture(name), name, { partId: 'P1' });
  assert.ok(chosen.warnings.some(w => w.includes('Transposition')));
  parseable(chosen.abc);
});

test('Finale chord symbols warn that harmony is omitted', async () => {
  const name = 'w3c_tutorial-chord-symbols.musicxml';
  const chosen = await importMusicXml(fixture(name), name);
  assert.equal(chosen.parts.length, 1);
  assert.ok(chosen.warnings.some(w => w.includes('Chord symbols')));
  parseable(chosen.abc);
});
