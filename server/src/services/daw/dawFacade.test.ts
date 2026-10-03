import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { __setCaller, __setConverter, __setPollMs, __test, cancelJob, convertOnce, getJob, isLoopback, sniffAudio, checkUploadMagic, submitGenerate, sweepTmp } from './dawFacade.js';
import { getFFmpegPath } from '../../config.js';
import { DawError } from './dawSchema.js';

test('sweep removes an old upload-less job', () => {
  const now = Date.now();
  __test.addJob({ id: 'old-no-upload', upstreamId: 'u1', seeds: [], createdAt: now - 7 * 3600_000 });
  __test.addJob({ id: 'fresh', upstreamId: 'u2', seeds: [], createdAt: now });
  __test.addJob({ id: 'failed-old', upstreamId: 'u3', seeds: [], createdAt: now - 20 * 60_000, finalState: 'failed', finishedAt: now - 15 * 60_000 });
  sweepTmp(now);
  const r = { old: __test.hasJob('old-no-upload'), fresh: __test.hasJob('fresh'), failedOld: __test.hasJob('failed-old') };
  console.log('sweep result:', JSON.stringify(r));
  assert.deepEqual(r, { old: false, fresh: true, failedOld: false });
});

test('cancel on a done job keeps done', async () => {
  __test.addJob({ id: 'done-job', upstreamId: 'u4', seeds: [], createdAt: Date.now(), finalState: 'done', finishedAt: Date.now() });
  const r = await cancelJob('done-job');
  console.log('cancel on done:', JSON.stringify(r));
  assert.equal(r.state, 'done');
});

test('two concurrent take requests trigger one conversion', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dawconv-'));
  const out = path.join(dir, 'take_0.wav');
  let calls = 0;
  const parts: string[] = [];
  const prev = __setConverter(async (_src, dst) => {
    calls++; parts.push(dst);
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(dst, 'x');
  });
  try {
    await Promise.all([convertOnce('src.flac', out), convertOnce('src.flac', out)]);
    console.log('conversions:', calls, 'part:', path.basename(parts[0]), 'out exists:', fs.existsSync(out));
    assert.equal(calls, 1);
    assert.ok(fs.existsSync(out));
    assert.notEqual(parts[0], `${out}.part.wav`);
    assert.deepEqual(fs.readdirSync(dir), ['take_0.wav']);
  } finally {
    __setConverter(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failed conversion cleans the part file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dawconv-'));
  const out = path.join(dir, 'take_0.wav');
  const prev = __setConverter(async (_src, dst) => { fs.writeFileSync(dst, 'half'); throw new Error('ffmpeg died'); });
  try {
    await assert.rejects(convertOnce('src.flac', out));
    const left = fs.readdirSync(dir);
    console.log('left after failure:', JSON.stringify(left));
    assert.deepEqual(left, []);
  } finally {
    __setConverter(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('IPv4-mapped loopback is loopback, mapped private is not', () => {
  const r = {
    mapped127: isLoopback('::ffff:127.0.0.1'), mapped127_5: isLoopback('::ffff:127.0.0.5'),
    plain127_2: isLoopback('127.0.0.2'), v6: isLoopback('::1'), mapped10: isLoopback('::ffff:10.0.0.1'),
  };
  console.log('loopback:', JSON.stringify(r));
  assert.deepEqual(r, { mapped127: true, mapped127_5: true, plain127_2: true, v6: true, mapped10: false });
});

test('magic-byte sniff rejects a .wav that is really text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dawsniff-'));
  try {
    const fake = path.join(dir, 'audio.wav');
    fs.writeFileSync(fake, 'hello, this is not audio at all');
    let code: number | null = null;
    try { checkUploadMagic(fake); } catch (e) { if (e instanceof DawError) code = e.status; }
    const real = path.join(dir, 'ok.wav');
    const hdr = Buffer.alloc(44); hdr.write('RIFF', 0, 'latin1'); hdr.write('WAVE', 8, 'latin1');
    fs.writeFileSync(real, hdr);
    checkUploadMagic(real);
    console.log('fake wav status:', code, 'sniff flac:', sniffAudio(Buffer.from('fLaC\0\0\0\0')), 'sniff aifc:', sniffAudio(Buffer.from('FORM\0\0\0\0AIFC')));
    assert.equal(code, 400);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── SA3 sequential takes / YuE2 trim ──────────────────────────────────────

/** Fake loopback server: each POST /api/generate is a job that succeeds after `ticks` status polls. */
function fakeUpstream(backend: string, ticks = 2) {
  const posts: any[] = [];
  const cancels: string[] = [];
  const polls = new Map<string, number>();
  const caller = async (method: string, route: string, body?: any) => {
    if (route === '/api/backends') return { status: 200, data: { activeId: backend } };
    if (method === 'POST' && route === '/api/generate') {
      posts.push(body);
      return { status: 200, data: { jobId: `up${posts.length - 1}` } };
    }
    const c = /^\/api\/generate\/cancel\/(.+)$/.exec(route);
    if (c) { cancels.push(c[1]); polls.set(c[1], -1); return { status: 200, data: {} }; }
    const s = /^\/api\/generate\/status\/(up\d+)$/.exec(route);
    if (s) {
      const k = s[1];
      const n = polls.get(k) ?? 0;
      if (n < 0) return { status: 200, data: { status: 'cancelled' } };
      polls.set(k, n + 1);
      if (n < ticks) return { status: 200, data: { status: 'running', progress: 50 } };
      return { status: 200, data: { status: 'succeeded', result: { audioUrls: [`/audio/${k}.flac`], durations: [backend === 'yue2' ? 63.2 : 10] } } };
    }
    return { status: 404, data: { error: route } };
  };
  return { caller, posts, cancels };
}

test('SA3 takes=4 runs 4 single-take jobs with distinct seeds under one facade id', async () => {
  const up = fakeUpstream('sa3');
  const prevC = __setCaller(up.caller); const prevP = __setPollMs(1);
  try {
    await submitGenerate('sa3-4', { mode: 'text2music', caption: 'x', takes: 4, seed: 100 } as any, { batchSize: 4, seed: 100 });
    await __test.getJob('sa3-4')!.seq?.done;
    const r = await getJob('sa3-4') as any;
    const seeds = up.posts.map((p) => p.seed);
    console.log('sa3 posts:', up.posts.length, 'seeds:', JSON.stringify(seeds), 'batchSizes:', JSON.stringify(up.posts.map((p) => p.batchSize)),
      'state:', r.state, 'take_count:', r.take_count, 'takes:', r.takes.length, 'job seeds:', JSON.stringify(r.takes.map((t: any) => t.seed)));
    assert.equal(up.posts.length, 4);
    assert.deepEqual(seeds, [100, 101, 102, 103]);
    assert.equal(new Set(seeds).size, 4);
    assert.ok(up.posts.every((p) => p.batchSize === 1 && p.randomSeed === false));
    assert.equal(r.state, 'done');
    assert.equal(r.take_count, 4);
    assert.equal(r.takes.length, 4);
    assert.deepEqual(r.takes.map((t: any) => t.seed), [100, 101, 102, 103]);
  } finally { __setCaller(prevC); __setPollMs(prevP); }
});

test('SA3 takes without a seed draw 4 distinct random seeds', async () => {
  const up = fakeUpstream('sa3', 0);
  const prevC = __setCaller(up.caller); const prevP = __setPollMs(1);
  try {
    await submitGenerate('sa3-rand', { mode: 'text2music', caption: 'x', takes: 4 } as any, {});
    await __test.getJob('sa3-rand')!.seq?.done;
    const seeds = up.posts.map((p) => p.seed);
    console.log('sa3 random seeds:', JSON.stringify(seeds));
    assert.equal(seeds.length, 4);
    assert.equal(new Set(seeds).size, 4);
  } finally { __setCaller(prevC); __setPollMs(prevP); }
});

test('SA3 cancel mid-run stops the current take and skips the rest', async () => {
  const up = fakeUpstream('sa3', 1000);
  const prevC = __setCaller(up.caller); const prevP = __setPollMs(1);
  try {
    await submitGenerate('sa3-cancel', { mode: 'text2music', caption: 'x', takes: 4, seed: 7 } as any, {});
    await new Promise((r) => setTimeout(r, 20));
    const mid = await getJob('sa3-cancel') as any;
    const c = await cancelJob('sa3-cancel');
    await __test.getJob('sa3-cancel')!.seq?.done;
    console.log('cancel: progress before', Number(mid.progress).toFixed(3), 'state', c.state, 'posts', up.posts.length, 'cancelled', JSON.stringify(up.cancels));
    assert.equal(c.state, 'cancelled');
    assert.equal(up.posts.length, 1);
    assert.deepEqual(up.cancels, ['up0']);
    assert.ok(mid.progress > 0.1 && mid.progress < 0.25, `progress ${mid.progress}`);
  } finally { __setCaller(prevC); __setPollMs(prevP); }
});

test('YuE2 duration_s marks takes trimmed_from_s and reports the requested length', async () => {
  const up = fakeUpstream('yue2', 0);
  const prevC = __setCaller(up.caller);
  try {
    await submitGenerate('yue-trim', { mode: 'text2music', caption: 'x', duration_s: 10 } as any, { duration: 10 });
    const r = await getJob('yue-trim') as any;
    console.log('yue2 take:', JSON.stringify(r.takes[0]));
    assert.equal(r.takes[0].trimmed_from_s, 63.2);
    assert.equal(r.takes[0].duration_s, 10);
  } finally { __setCaller(prevC); }
});

/** Data chunk length of a WAV file, in sample frames. */
function wavFrames(file: string): { frames: number; rate: number } {
  const b = fs.readFileSync(file);
  let off = 12, rate = 0, ch = 0, bits = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('latin1', off, off + 4); const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') { ch = b.readUInt16LE(off + 10); rate = b.readUInt32LE(off + 12); bits = b.readUInt16LE(off + 22); }
    if (id === 'data') return { frames: size / (ch * bits / 8), rate };
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

test('trim export cuts a 12 s render to 10.000 s at 48 kHz with a fade, and never pads', { skip: !getFFmpegPath() && 'ffmpeg not available' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dawtrim-'));
  try {
    const src = path.join(dir, 'src.wav');
    await new Promise<void>((res, rej) => execFile(getFFmpegPath()!, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=12', '-ac', '2', src], (e) => e ? rej(e) : res()));
    const out = path.join(dir, 'take_0.wav');
    await convertOnce(src, out, { trimS: 10 });
    const w = wavFrames(out);
    const b = fs.readFileSync(out);
    const lastAbs = Math.abs(b.readFloatLE(b.length - 8));
    const short = path.join(dir, 'take_1.wav');
    await convertOnce(src, short, { trimS: 20 });
    const s = wavFrames(short);
    console.log('trim: frames', w.frames, 'rate', w.rate, 'seconds', (w.frames / w.rate).toFixed(5), 'last sample', lastAbs.toExponential(2), '| no-pad frames', s.frames, (s.frames / s.rate).toFixed(5), 's');
    assert.equal(w.rate, 48000);
    assert.ok(Math.abs(w.frames - 480000) <= 48, `frames ${w.frames}`);
    assert.ok(lastAbs < 0.01, `last sample ${lastAbs}`);
    assert.ok(Math.abs(s.frames - 576000) <= 48, `no-pad frames ${s.frames}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
