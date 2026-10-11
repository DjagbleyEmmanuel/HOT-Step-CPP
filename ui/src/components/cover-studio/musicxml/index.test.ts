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

test('melody, rests and first lyric verse produce a parseable native YuE2 score', async () => {
  const result = await importMusicXml(blob(melody), 'song.musicxml');
  assert.equal(result.partId, 'P1');
  assert.equal(result.title, 'Test song');
  assert.equal(result.abc, 'X:1\nT:\nM:4/4\nL:1/32\nQ:1/4=120\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\n'
    + 'V: Ins clef=treble name="Ins Melody" snm="Inst."\nK:C\n% verse\nV: Vocal\nC8D8z16|\nV: Ins\nZ|\n');
  assert.equal(result.lyrics, '[Verse]\nHello\n');
  assert.equal(abcjs.parseOnly(result.abc)[0].warnings?.length ?? 0, 0);
});

test('accidentals read the same per octave or per letter, and long notes split with ties', async () => {
  const note = (step: string, octave: number, alter: number, duration: number) =>
    `<note><pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch><duration>${duration}</duration></note>`;
  const score = `${header}</part-list><part id="P1"><measure number="1" implicit="yes"><attributes><divisions>4</divisions><key><fifths>2</fifths><mode>minor</mode></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>`
    + `${note('F', 4, 0, 4)}</measure><measure number="2">${note('F', 5, 1, 4)}${note('C', 4, 1, 5)}${note('C', 4, 1, 7)}</measure></part></score-partwise>`;
  const result = await importMusicXml(blob(score), 'keys.musicxml');
  assert.match(result.abc, /^K:Bm$/m);
  assert.match(result.abc, /\nz24=F8\|f8C8-C2C12-C2\|\n/);
  const tune = abcjs.parseOnly(result.abc)[0] as unknown as { setUpAudio(): { tracks: { cmd: string; pitch: number }[][] } };
  const pitches = tune.setUpAudio().tracks[0].filter(e => e.cmd === 'note').map(e => e.pitch);
  assert.deepEqual(pitches, [65, 78, 61, 61]);
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
  assert.match(result.abc, /\nC8z24\|\n/);
});

test('MXL follows container rootfile and rejects a missing rootfile', async () => {
  const container = '<container><rootfiles><rootfile full-path="scores/main.musicxml"/></rootfiles></container>';
  const good = zipSync({ 'META-INF/container.xml': strToU8(container), 'scores/main.musicxml': strToU8(melody) });
  assert.equal((await importMusicXml(new Blob([new Uint8Array(good)]), 'song.mxl')).partId, 'P1');
  const bad = zipSync({ 'META-INF/container.xml': strToU8(container) });
  await assert.rejects(importMusicXml(new Blob([new Uint8Array(bad)]), 'bad.mxl'), MusicXmlImportError);
});
