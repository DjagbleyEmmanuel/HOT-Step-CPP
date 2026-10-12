import assert from 'node:assert/strict';
import test from 'node:test';
import { lyricsThrough, sectionStarts, YUE2_FPS } from './yue2Takes.js';
import type { Yue2AlignWord } from './backends/yue2/align.js';

const score = [
  'X:1', 'M:3/4', 'L:1/8', 'Q:1/8=120', 'K:C',
  '% intro', 'V: Vocal', 'z6|z6|',
  '% verse', 'V: Vocal', 'C6|D6|',
  '% chorus', 'V: Vocal', 'E6|F6|',
  '% outro', 'V: Vocal', 'z6|z6|', '',
].join('\n');
const lyrics = '[intro]\n\n[verse]\nfirst line here\n\n[chorus]\nhook line now\n\n[outro]';

function words(times: Array<[string, number]>): Yue2AlignWord[] {
  return times.map(([text, start]) => {
    const char0 = Array.from(lyrics.slice(0, lyrics.indexOf(text))).length;
    return { char0, char1: char0 + text.length, start, end: start + 0.4, score: 0.05 };
  });
}

test('a section starts halfway through the gap before its first sung word, by the take\'s own timing', () => {
  // Sung later than the score clock says (verse at 6 s, chorus at 12 s). With
  // two words the median start is the second.
  const starts = sectionStarts(score, lyrics, words([['first', 8], ['line here', 8.5], ['hook', 15], ['line now', 15.5]]), 30 * YUE2_FPS);
  assert.deepEqual(starts.map(f => (f === null ? null : f / YUE2_FPS)), [0, 8, 12.2, 16.4]);
});

test('squashed words, or a section past the take\'s end, give no start', () => {
  const squashed = words([['first', 8], ['line here', 8.5]]).concat(
    words([['hook', 9.9], ['line now', 9.92]]).map(w => ({ ...w, end: w.start + 0.01 })));
  const starts = sectionStarts(score, lyrics, squashed, 11 * YUE2_FPS);
  assert.equal(starts[2], null);
  assert.equal(starts[3], null);
});

test('a take that stops early is aligned only against lyrics up to the next section', () => {
  assert.equal(lyricsThrough(score, lyrics, 1), '[intro]\n\n[verse]\nfirst line here\n\n');
  assert.equal(lyricsThrough(score, lyrics, 3), lyrics);
});

test('a start at or before the previous section\'s is dropped', () => {
  const starts = sectionStarts(score, lyrics, words([['first', 8], ['line here', 8.5], ['hook', 4], ['line now', 4.5]]), 30 * YUE2_FPS);
  assert.equal(starts[2], null);
});

test('a waveform reads the peak level of each slice of a PCM WAV', async () => {
  const { wavPeaks } = await import('./yue2Takes.js');
  const rate = 48000, seconds = 2, frames = rate * seconds;
  const wav = Buffer.alloc(44 + frames * 4);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + frames * 4, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(frames * 4, 40);
  // Silent first second, half scale in the second.
  for (let f = rate; f < frames; f++) wav.writeInt16LE(16384, 44 + f * 4);
  const peaks = wavPeaks(wav, 0, 2);
  assert.equal(peaks.length, 120);
  assert.equal(peaks[10], 0);
  assert.equal(peaks[100], 0.5);
});
