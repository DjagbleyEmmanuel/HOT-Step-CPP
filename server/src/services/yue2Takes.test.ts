import assert from 'node:assert/strict';
import test from 'node:test';
import { lyricsThrough, sectionStarts, YUE2_FPS } from './yue2Takes.js';
import type { Yue2AlignWord } from './backends/yue2/align.js';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { createBuildSession, generateBuildTakes, getBuildSession, cancelBuildTakes, keepBuildTake, mapTakeTracks } from './yue2Takes.js';
import type { Yue2SynthRequest, Yue2TrackDetail } from './backends/yue2/client.js';
import { resetGpuLane, runOnGpuLane } from './generation/gpuLane.js';

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

function pcm(marker: number): Buffer {
  const wav = Buffer.alloc(44 + 1920);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(1920, 40);
  for (let i = 44; i < wav.length; i += 2) wav.writeInt16LE(marker * 1000, i);
  return wav;
}

test('section take chunks save every song with its own WAV, codes and seed', async t => {
  const previousDir = config.data.dir;
  const dir = fs.mkdtempSync(path.resolve('.test-yue2-takes-'));
  config.data.dir = dir;
  t.after(() => { config.data.dir = previousDir; fs.rmSync(dir, { recursive: true, force: true }); });
  const requests: Yue2SynthRequest[] = [];
  const results = new Map<string, { tracks: Yue2TrackDetail[]; parts: Buffer[] }>();
  let mode = 'done';
  let cancels = 0;
  let polls = 0;
  let aligns = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/yue2/synth') {
      const req = JSON.parse(String(init?.body)) as Yue2SynthRequest;
      requests.push(req);
      const seeds = req.songs?.map(s => s.seed!) ?? [req.seed!];
      const tracks = seeds.map((seed, song) => ({ song, seed, noise_seed: seed, variation: 0,
        semantic_ids: [...(req.codec_ids ?? []), ...Array<number>(400).fill(song + 1)], frames: (req.codec_ids?.length ?? 0) + 400 }));
      const parts = seeds.map((_, i) => pcm(i + 1));
      // Reversed response order must still map each WAV to its song and seed.
      tracks.reverse(); parts.reverse();
      if (mode === 'drop') { tracks.splice(1, 1); parts.splice(1, 1); }
      if (mode === 'mismatch') tracks[0].seed++;
      const id = String(requests.length);
      results.set(id, { tracks, parts });
      return Response.json({ id });
    }
    if (url.pathname === '/yue2/align') { aligns++; return Response.json({ words: [] }); }
    assert.equal(url.pathname, '/job');
    const result = results.get(url.searchParams.get('id')!)!;
    if (url.searchParams.has('cancel')) { cancels++; return Response.json({}); }
    if (url.searchParams.has('result')) {
      if (result.parts.length === 1) return new Response(new Uint8Array(result.parts[0]), { headers: { 'content-type': 'audio/wav' } });
      const body = Buffer.concat(result.parts.flatMap(part => [Buffer.from('--takes\r\nContent-Type: audio/wav\r\n\r\n'), part, Buffer.from('\r\n')])
        .concat(Buffer.from('--takes--\r\n')));
      return new Response(new Uint8Array(body), { headers: { 'content-type': 'multipart/mixed; boundary=takes' } });
    }
    polls++;
    if (mode === 'running' || mode === 'timeout') return Response.json({ status: cancels ? 'cancelled' : 'running', phase: 'semantic', phase_step: 2, phase_total: 4 });
    if (mode === 'failed') return Response.json({ status: 'failed', error: 'row failed' });
    return Response.json({ status: 'done', tracks: result.tracks });
  });
  const session = () => createBuildSession({}, { style: 'ambient', cot: 'off', abc: score, lyrics: 'test lyrics', lm_batch_size: 4, synth_batch_size: 3, semantic_retries: 2 }, 'user');
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, 'take worker finished within deadline');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  for (const [count, widths] of [[1, [1]], [4, [4]], [5, [4, 1]], [10, [4, 4, 2]]] as const) {
    await t.test(`${count} takes use ${widths.join('+')}`, async () => {
      const s = session();
      const first = requests.length;
      generateBuildTakes(s.id, 'user', 0, count);
      await until(() => getBuildSession(s.id, 'user').pending.length === 0);
      const done = getBuildSession(s.id, 'user');
      assert.equal(done.error, null);
      assert.equal(done.takes.length, count);
      const sent = requests.slice(first);
      assert.deepEqual(sent.map(r => r.songs?.length ?? 1), widths);
      for (const req of sent) {
        assert.equal(req.synth_batch_size, 1);
        assert.equal(req.lm_batch_size, undefined);
        assert.equal(req.semantic_retries, undefined);
        const seeds = req.songs?.map(s => s.seed!) ?? [req.seed!];
        for (let song = 0; song < seeds.length; song++) {
          const take = done.takes.find(take => take.seed === seeds[song])!;
          const file = path.join(config.data.audioDir, 'takes', s.id, `${take.id}.wav`);
          assert.deepEqual(fs.readFileSync(file), pcm(song + 1));
          assert.deepEqual(JSON.parse(fs.readFileSync(file.replace('.wav', '.codes.json'), 'utf8')), Array(400).fill(song + 1));
          assert.equal(take.starts[0], 0);
          assert.equal(take.peaks?.length, 120);
        }
      }
      if (count === 4) {
        keepBuildTake(s.id, 'user', done.takes[0].id);
        generateBuildTakes(s.id, 'user', 1, 4);
        await until(() => getBuildSession(s.id, 'user').pending.length === 0);
        const req = requests.at(-1)!;
        assert.equal(req.continue_codec_ids, true);
        assert.deepEqual(req.codec_ids, Array(150).fill(1));
        assert.equal(req.songs?.length, 4);
      }
    });
  }
  assert.ok(aligns > 0);
  for (const failure of ['drop', 'mismatch', 'failed']) {
    await t.test(`${failure} rejects the chunk and clears all pending takes`, async () => {
      mode = failure;
      const first = requests.length;
      const s = session();
      generateBuildTakes(s.id, 'user', 0, 10);
      await until(() => !getBuildSession(s.id, 'user').pending.length);
      const done = getBuildSession(s.id, 'user');
      assert.equal(done.takes.length, 0);
      assert.match(done.error!, /chunk|row failed/);
      assert.equal(requests.length - first, 1);
    });
  }
  await t.test('cancel shares chunk progress, stops its engine job and starts no later chunks', async () => {
    mode = 'running'; cancels = 0; polls = 0;
    const first = requests.length;
    const s = session();
    generateBuildTakes(s.id, 'user', 0, 10);
    await until(() => getBuildSession(s.id, 'user').pending[0]?.progress === 50);
    assert.equal(getBuildSession(s.id, 'user').pending[0].activeCount, 4);
    assert.throws(() => generateBuildTakes(s.id, 'user', 0, 1), /pending takes/);
    await assert.rejects(cancelBuildTakes(s.id, 'other-user'), /not found/);
    await cancelBuildTakes(s.id, 'user');
    await until(() => !getBuildSession(s.id, 'user').pending.length);
    assert.ok(cancels > 0);
    assert.equal(requests.length - first, 1);
    assert.equal(getBuildSession(s.id, 'user').takes.length, 0);
    assert.match(getBuildSession(s.id, 'user').error!, /cancelled/);
  });
  await t.test('timeout cancels the engine and clears pending counts', async st => {
    mode = 'timeout'; cancels = 0;
    let now = 0;
    st.mock.method(Date, 'now', () => now += 16 * 60_000);
    const s = session();
    generateBuildTakes(s.id, 'user', 0, 5);
    // Use the event loop rather than a clock that this test has replaced.
    while (getBuildSession(s.id, 'user').pending.length) await new Promise(resolve => setImmediate(resolve));
    assert.match(getBuildSession(s.id, 'user').error!, /timed out/);
    assert.ok(cancels > 0);
  });
  await t.test('queue reset before submission starts no takes', async () => {
    mode = 'done';
    let release!: () => void;
    const occupied = runOnGpuLane(() => new Promise<void>(resolve => { release = resolve; }));
    await new Promise(resolve => setImmediate(resolve));
    const s = session();
    const first = requests.length;
    generateBuildTakes(s.id, 'user', 0, 5);
    resetGpuLane(); release(); await occupied;
    await until(() => !getBuildSession(s.id, 'user').pending.length);
    assert.equal(requests.length, first);
  });
});

test('track mapping rejects duplicate indices, unknown indices, extra variations and missing audio', () => {
  const tracks = [0, 1].map(song => ({ song, seed: 10 + song, noise_seed: 10 + song, variation: 0, semantic_ids: [song] }));
  for (const bad of [{ song: 0 }, { song: 3 }, { variation: 1 }, { seed: 999 }, { semantic_ids: [] }]) {
    assert.throws(() => mapTakeTracks([10, 11], [tracks[0], { ...tracks[1], ...bad }], [pcm(1), pcm(2)]), /chunk/);
  }
  assert.throws(() => mapTakeTracks([10, 11], tracks, [pcm(1)]), /audio parts/);
  assert.throws(() => mapTakeTracks([10, 11], tracks, [pcm(1), Buffer.from('invalid audio')]), /valid WAV/);
});
