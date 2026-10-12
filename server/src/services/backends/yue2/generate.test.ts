import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobCover, mapYue2Params, yue2PlanMode } from './generate.js';
import type { GenerationJob } from '../../generation/jobTypes.js';
import type { Yue2PersistedSelection } from './index.js';

// #S3: a cover job's source identity and approved ABC are captured into the
// envelope at submit (index.ts's resolveRequest) and read ONLY from there —
// never from job.params, the raw request body. These tests build a job whose
// envelope and params deliberately disagree, so a regression that reads the
// old params path instead shows up immediately.

function fakeJob(envelopeOptions: Record<string, unknown> | undefined, params: Record<string, unknown>): GenerationJob {
  return {
    envelope: { backendId: 'yue2', options: envelopeOptions ? { yue2: envelopeOptions } : {} },
    params,
  } as unknown as GenerationJob;
}

test('jobCover reads the ABC from the envelope, not from job.params', () => {
  const job = fakeJob(
    { yue2Cover: { sourceId: 'song-1' }, yue2Abc: 'X:1\nK:C\nENVELOPE\n' },
    { yue2Abc: 'X:1\nK:C\nSTALE PARAMS COPY\n' },
  );
  const captured = jobCover(job);
  assert.equal(captured?.abc, 'X:1\nK:C\nENVELOPE\n');
});

test('jobCover reads source identity from the envelope, not from job.params', () => {
  const job = fakeJob(
    { yue2Cover: { sourceId: 'envelope-id', sourceLabel: 'Envelope Label' }, yue2Abc: 'X:1\n' },
    { yue2Cover: { sourceId: 'stale-params-id', sourceLabel: 'Stale Params Label' }, yue2Abc: 'X:1\n' },
  );
  const captured = jobCover(job);
  assert.deepEqual(captured?.cover, { sourceId: 'envelope-id', sourceLabel: 'Envelope Label' });
});

test('jobCover reads full score, chord choice and rendered ABC from the envelope only', () => {
  const job = fakeJob(
    { yue2Cover: { sourceId: 'source', keepChords: false, fullScore: 'X:1\n"Am"C|' }, yue2Abc: 'X:1\nC|' },
    { yue2Cover: { sourceId: 'stale', keepChords: true, fullScore: 'wrong' }, yue2Abc: 'wrong' },
  );
  assert.deepEqual(jobCover(job), {
    cover: { sourceId: 'source', keepChords: false, fullScore: 'X:1\n"Am"C|' },
    abc: 'X:1\nC|',
  });
});

test('jobCover reads all five score choices from the captured envelope', () => {
  const cover = { sourceId: 'source', voices: 'vocal', keepChords: false,
    tempo: 'free', key: 'F#m', cfgScale: 1.25, fullScore: 'X:1\nK:Em\n"Em"E|' };
  const job = fakeJob(
    { yue2Cover: cover, yue2Abc: 'X:1\nK:F#m\nF|' },
    { yue2Cover: { ...cover, key: 'Bm', cfgScale: 2 }, yue2Abc: 'wrong' },
  );
  assert.deepEqual(jobCover(job), { cover, abc: 'X:1\nK:F#m\nF|' });
});

test('MusicXML cover reaches the YuE2 request from its captured score without source audio', () => {
  const score = 'X:1\nK:C\nC4|';
  const job = fakeJob(
    { yue2Cover: { sourceKind: 'musicxml' }, yue2Abc: score },
    { caption: 'quiet strings', yue2Abc: 'stale', sourceAudioUrl: '/audio/old.wav' },
  );
  const captured = jobCover(job);
  assert.deepEqual(captured, { cover: { sourceKind: 'musicxml' }, abc: score });
  const mapped = mapYue2Params({ ...job.params, yue2Abc: captured!.abc }, {
    lm: '', vae_variant: '', adapters: {
      ar: { path: '', scales: { global: 1, attn: 1, mlp: 1, early: 1, mid: 1, late: 1 } },
      nar: { path: '', scales: { global: 1, attn: 1, mlp: 1, early: 1, mid: 1, late: 1 } },
    },
  });
  assert.equal(mapped.req.abc, score);
  assert.equal('sourceAudioUrl' in mapped.req, false);
});

test('an ordinary (non-cover) job has no captured cover, regardless of job.params', () => {
  const job = fakeJob({ yue2Abc: 'X:1\n' }, { yue2Cover: { sourceId: 'ignored' } });
  assert.equal(jobCover(job), undefined);
});

test('a job with no envelope options for this backend has no captured cover', () => {
  const job = fakeJob(undefined, {});
  assert.equal(jobCover(job), undefined);
});

// Off by default (2026-10-12: condition strength 1 with the old
// soft-by-default ruined lyric adherence). Soft (bias) and hard (mask) both
// stay selectable, an explicit choice (current or saved) always wins, and a
// schedule that cannot be built must never fail the render.

const scales = { global: 1, attn: 1, mlp: 1, early: 1, mid: 1, late: 1 };
const pick: Yue2PersistedSelection = {
  lm: '', vae_variant: '',
  adapters: { ar: { path: '', scales }, nar: { path: '', scales } },
};
const abc = ['X:1', 'M:4/4', 'L:1/4', 'Q:1/4=60', 'K:C', '% verse', 'V: Vocal', 'C4|', ''].join('\n');
const lyrics = '[Verse]\nfirst line';

test('yue2LyricSchedule defaults to off when a score and lyrics are supplied', () => {
  const { req, notes } = mapYue2Params({ caption: 'folk', lyrics, yue2Abc: abc }, pick);
  assert.equal(req.lyric_schedule, undefined);
  assert.ok(!notes.some(n => n.startsWith('Lyric schedule')));
});

test('an explicit "bias" is honoured with a usable score', () => {
  const { req, notes } = mapYue2Params({ caption: 'folk', lyrics, yue2Abc: abc, yue2LyricSchedule: 'bias' }, pick);
  assert.equal(req.lyric_schedule?.mode, 'bias');
  assert.equal(req.lyric_schedule?.bias, -4);
  assert.ok(notes.some(n => n.startsWith('Lyric schedule: bias')));
});

test('an explicit "off" is honoured even with a usable score', () => {
  const { req, notes } = mapYue2Params({ caption: 'folk', lyrics, yue2Abc: abc, yue2LyricSchedule: 'off' }, pick);
  assert.equal(req.lyric_schedule, undefined);
  assert.ok(!notes.some(n => n.startsWith('Lyric schedule')));
});

test('hard mask stays selectable but is never the default', () => {
  const { req } = mapYue2Params({ caption: 'folk', lyrics, yue2Abc: abc, yue2LyricSchedule: 'mask' }, pick);
  assert.equal(req.lyric_schedule?.mode, 'mask');
});

test('an explicit CFG other than 1 skips an explicitly requested schedule instead of the engine rejecting the job', () => {
  // yue2-pipeline.h:596 refuses lyric_schedule outright once CFG is on
  // ("needs cfg_scale 1 (no rule for the guidance set)"); the mapper must
  // never emit a schedule the engine will reject.
  const { req, notes } = mapYue2Params(
    { caption: 'folk', lyrics, yue2Abc: abc, yue2LyricSchedule: 'bias', yue2CfgScale: '1.2' }, pick);
  assert.equal(req.lyric_schedule, undefined);
  assert.equal(req.cfg_scale, 1.2);
  assert.ok(notes.some(n => n.includes('skipped') && n.includes('CFG 1.2')));
});

test('an explicitly requested schedule that cannot be built falls back instead of failing the render', () => {
  // No "% section" label line: buildYue2LyricSchedule throws "needs a score
  // with labelled sections" — the render must still go ahead without C6.
  const unlabelled = ['X:1', 'M:4/4', 'L:1/4', 'Q:1/4=60', 'K:C', 'C4|', ''].join('\n');
  const { req, notes } = mapYue2Params(
    { caption: 'folk', lyrics, yue2Abc: unlabelled, yue2LyricSchedule: 'bias' }, pick);
  assert.equal(req.lyric_schedule, undefined);
  assert.ok(notes.some(n => n.includes('not built') && n.includes('rendering without it')));
});

test('no score or lyrics: an explicitly requested schedule never fires and never fails', () => {
  const { req } = mapYue2Params({ caption: 'folk', yue2LyricSchedule: 'bias' }, pick);
  assert.equal(req.lyric_schedule, undefined);
});

test('yue2PlanMode: every auto-replan, instrumental, cot and supplied-score combination', () => {
  for (const autoReplan of [undefined, true, false]) {
    for (const instrumental of [true, false]) {
      for (const cot of ['full', 'melody', 'off'] as const) {
        for (const supplied of [false, true]) {
          const params = { instrumental, ...(autoReplan === undefined ? {} : { yue2AutoReplan: autoReplan }) };
          const req = { cot, lyrics: instrumental ? '' : lyrics, ...(supplied ? { abc } : {}) };
          const want = cot === 'off' || supplied ? null : autoReplan !== false ? 'replan' : instrumental ? 'once' : null;
          assert.equal(yue2PlanMode(params, req), want, JSON.stringify({ autoReplan, instrumental, cot, supplied }));
        }
      }
    }
  }
  // Empty lyrics without the Instrumental switch is an instrumental too.
  assert.equal(yue2PlanMode({ yue2AutoReplan: false }, { cot: 'melody', lyrics: '' }), 'once');
});

test('a supplied score is moved for an instrumental whatever re-planning is, and left alone for a vocal cover', () => {
  const native = ['X:1', 'T:', 'M:4/4', 'L:1/32', 'Q:1/4=90', 'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"',
    'V: Ins clef=treble name="Ins Melody" snm="Inst."', 'K:C', '% verse', 'V: Vocal', '"C"c16"G"d16|', 'V: Ins', 'Z|', ''].join('\n');
  for (const yue2AutoReplan of [true, false]) {
    for (const cot of ['full', 'melody']) {
      const inst = mapYue2Params({ caption: 'piano', instrumental: true, yue2Abc: native, yue2Cot: cot, yue2AutoReplan }, pick).req;
      assert.match(inst.abc!, /\nV: Vocal\n"C"z16"G"z16\|\nV: Ins\nc16d16\|$/, `instrumental, autoReplan ${yue2AutoReplan}, cot ${cot}`);
      assert.equal(yue2PlanMode({ instrumental: true, yue2AutoReplan }, inst), null);
      const vocal = mapYue2Params({ caption: 'folk', lyrics, yue2Abc: native, yue2Cot: cot, yue2AutoReplan }, pick).req;
      assert.equal(vocal.abc, native.trim(), `vocal, autoReplan ${yue2AutoReplan}, cot ${cot}`);
    }
  }
});
