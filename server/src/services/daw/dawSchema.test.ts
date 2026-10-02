import test from 'node:test';
import assert from 'node:assert/strict';
import { barsToDurationS, mapJobStatus, parseDawRequest, toGenerateParams, DawError } from './dawSchema.js';

test('bars convert to duration_s from bpm and time signature', () => {
  assert.equal(barsToDurationS(4, 120, '4/4'), 8);
  assert.equal(barsToDurationS(2, 90, '3/4'), 4);
  assert.equal(barsToDurationS(4, 120, '6/8'), 6);
  const r = parseDawRequest({ mode: 'text2music', caption: 'x', bars: 8, bpm: 120, timesig: '4/4' });
  assert.equal(r.duration_s, 16);
});

test('every DAW field maps to the /api/generate name translateParams reads', () => {
  const req = parseDawRequest({
    mode: 'repaint', caption: 'warm keys', lyrics: 'la', negative: 'noise', duration_s: 12, bpm: 97,
    timesig: '7/8', key: 'C minor', seed: 42, seed_b: 7, seed_blend: 0.3, seed_blend_end: 0.8, takes: 2,
    region: { start_s: 2, end_s: 6 }, track: 'drums', cover_strength: 0.5, steps: 30, guidance: 4.5,
    solver: 'euler', scheduler: 'linear', guidance_mode: 'apg', dit_model: 'base.gguf', expected_backend: 'ace',
  });
  const p = toGenerateParams(req, '/tmp/src.wav');
  const expected: Record<string, unknown> = {
    taskType: 'repaint', caption: 'warm keys', skipLm: true, lyrics: 'la', negative_prompt: 'noise',
    duration: 12, bpm: 97, timeSignature: '7/8', keyScale: 'C minor', seed: 42, randomSeed: false,
    seedB: 7, seedBlend: 0.3, seedBlendEnd: 0.8, batchSize: 2, repaintingStart: 2, repaintingEnd: 6,
    trackName: 'drums', audioCoverStrength: 0.5, inferenceSteps: 30, guidanceScale: 4.5, inferMethod: 'euler',
    scheduler: 'linear', guidanceMode: 'apg', ditModel: 'base.gguf', expectedBackend: 'ace',
    sourceAudioUrl: '/tmp/src.wav',
  };
  console.log('mapped params:', JSON.stringify(p));
  assert.deepEqual(p, expected);
});

test('skip_lm defaults true for source modes, false for text2music, and is overridable', () => {
  assert.equal(toGenerateParams(parseDawRequest({ mode: 'lego', caption: '' })).skipLm, true);
  assert.equal(toGenerateParams(parseDawRequest({ mode: 'complete', caption: '' })).skipLm, true);
  assert.equal(toGenerateParams(parseDawRequest({ mode: 'text2music', caption: '' })).skipLm, false);
  assert.equal(toGenerateParams(parseDawRequest({ mode: 'lego', caption: '', skip_lm: false })).skipLm, false);
  assert.equal(toGenerateParams(parseDawRequest({ mode: 'text2music', caption: '' })).instrumental, true);
});

test('bad input is rejected with the envelope codes', () => {
  const code = (raw: unknown) => { try { parseDawRequest(raw); return null; } catch (e) { return (e as DawError).code; } };
  assert.equal(code({ mode: 'extract' }), 'unsupported_mode');
  assert.equal(code({ mode: 'repaint', caption: '' }), 'bad_request');
  assert.equal(code({ mode: 'lego', bars: 4 }), 'bad_request');
  assert.equal(code({ mode: 'lego', steps: 'many' }), 'bad_request');
});

test('upstream status maps to DAW job shape with progress 0..1', () => {
  const run = mapJobStatus('j', { status: 'synth_running', stage: 'DiT', progress: 40, ace_phase_progress: 'step 12/50' });
  assert.equal(run.state, 'running');
  assert.equal(run.progress, 0.4);
  assert.equal(run.step, 12);
  assert.equal(run.step_total, 50);
  assert.equal(mapJobStatus('j', { status: 'pending', progress: 0 }).state, 'queued');
  const done = mapJobStatus('j', { status: 'succeeded', progress: 90, result: { audioUrls: ['/audio/a.mp3', '/audio/b.mp3'], durations: [10, 11] } }, [5, 5]);
  console.log('done job:', JSON.stringify(done));
  assert.equal(done.state, 'done');
  assert.equal(done.progress, 1);
  assert.deepEqual(done.takes, [{ n: 0, seed: 5, duration_s: 10, ready: true }, { n: 1, seed: 5, duration_s: 11, ready: true }]);
  assert.equal(done.api, 1);
});
