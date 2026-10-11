import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DOMParser } from 'linkedom';
import abcjs from 'abcjs';
import { zipSync, strToU8 } from 'fflate';
import { importMusicXml, MusicXmlImportError } from './index';

Object.assign(globalThis, { DOMParser });
const header = '<score-partwise version="4.0"><work><work-title>Test song</work-title></work><identification><creator type="composer">Composer</creator></identification><part-list><score-part id="P1"><part-name>Voice</part-name></score-part>';
const notes = '<attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>' +
  '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><lyric number="1"><syllabic>begin</syllabic><text>Hel</text></lyric></note>' +
  '<note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><lyric number="1"><syllabic>end</syllabic><text>lo</text></lyric></note>' +
  '<note><rest/><duration>8</duration></note>';
const melody = `${header}</part-list><part id="P1"><measure number="1">${notes}</measure></part></score-partwise>`;
const blob = (s: string) => new Blob([s]);

test('melody, rests and first lyric verse produce parseable ABC', async () => {
  const result = await importMusicXml(blob(melody), 'song.musicxml');
  assert.equal(result.partId, 'P1');
  assert.match(result.abc, /C D z2/);
  assert.match(result.abc, /w: Hel- lo \*/);
  assert.equal(abcjs.parseOnly(result.abc)[0].warnings?.length ?? 0, 0);
});

test('two parts require a part choice', async () => {
  const score = `${header}<score-part id="P2"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1">${notes}</measure></part><part id="P2"><measure number="1">${notes}</measure></part></score-partwise>`;
  const result = await importMusicXml(blob(score), 'song.xml');
  assert.equal(result.abc, '');
  assert.equal(result.partId, null);
  assert.deepEqual(result.parts.map(p => p.id), ['P1', 'P2']);
  assert.equal((await importMusicXml(blob(score), 'song.xml', { partId: 'P2' })).partId, 'P2');
});

test('grand staff reports lossy conversion', async () => {
  const score = `${header}</part-list><part id="P1"><measure number="1"><attributes><divisions>4</divisions><staves>2</staves></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><staff>1</staff></note><backup><duration>4</duration></backup><note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><staff>2</staff></note></measure></part></score-partwise>`;
  const result = await importMusicXml(blob(score), 'piano.musicxml');
  assert.equal(result.parts[0].staves, 2);
  assert.match(result.warnings.join(' '), /Multiple staves/);
  assert.match(result.abc, /C \|/);
});

test('MXL follows container rootfile and rejects a missing rootfile', async () => {
  const container = '<container><rootfiles><rootfile full-path="scores/main.musicxml"/></rootfiles></container>';
  const good = zipSync({ 'META-INF/container.xml': strToU8(container), 'scores/main.musicxml': strToU8(melody) });
  assert.equal((await importMusicXml(new Blob([new Uint8Array(good)]), 'song.mxl')).partId, 'P1');
  const bad = zipSync({ 'META-INF/container.xml': strToU8(container) });
  await assert.rejects(importMusicXml(new Blob([new Uint8Array(bad)]), 'bad.mxl'), MusicXmlImportError);
});
