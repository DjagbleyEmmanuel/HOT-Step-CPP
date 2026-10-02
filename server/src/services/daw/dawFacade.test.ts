import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { __setConverter, __test, cancelJob, convertOnce, isLoopback, sniffAudio, checkUploadMagic, sweepTmp } from './dawFacade.js';
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
