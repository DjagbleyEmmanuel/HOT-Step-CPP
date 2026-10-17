import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCoverStemCache } from './coverStemCache.js';
import { NoVocalsError } from './training/yue2Stems.js';

function wav(): Buffer {
  const b = Buffer.alloc(64);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(56, 4); b.write('WAVE', 8, 'ascii');
  return b;
}

function setup(mode: 'ok' | 'none' | 'bad' = 'ok') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stemcache-'));
  const root = path.join(dir, 'cache');
  let calls = 0;
  const separate = async (_src: string, out: string) => {
    calls++;
    await new Promise(r => setTimeout(r, 10));
    if (mode === 'none') throw new NoVocalsError('none');
    fs.writeFileSync(out, mode === 'bad' ? Buffer.from('junk') : wav());
  };
  const audio = (name: string, body: string) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };
  const make = (level = 4, version?: number) => createCoverStemCache({ root, level, separate, version });
  return { dir, root, audio, make, calls: () => calls };
}

test('identical bytes under a new path, a new mtime and a new cache instance are hits', async () => {
  const t = setup();
  const first = await t.make().vocalStem(t.audio('a.wav', 'same bytes'));
  const b = t.audio('b.wav', 'same bytes');
  fs.utimesSync(b, new Date(2000, 0, 1), new Date(2000, 0, 1));
  assert.equal(await t.make().vocalStem(b), first);  // new instance = restart
  assert.equal(t.calls(), 1);
});

test('changed bytes, level or version are misses; nothing is evicted', async () => {
  const t = setup();
  const a = t.audio('a.wav', 'one');
  await t.make().vocalStem(a);
  await t.make().vocalStem(t.audio('b.wav', 'two'));
  await t.make(0).vocalStem(a);
  await t.make(4, 2).vocalStem(a);
  assert.equal(t.calls(), 4);
  assert.equal(fs.readdirSync(t.root).filter(f => f.endsWith('.wav')).length, 4);
});

test('concurrent misses share one separation and leave no part files', async () => {
  const t = setup();
  const cache = t.make();
  const a = t.audio('a.wav', 'x');
  const paths = await Promise.all([cache.vocalStem(a), cache.vocalStem(t.audio('b.wav', 'x'))]);
  assert.equal(paths[0], paths[1]);
  assert.equal(t.calls(), 1);
  assert.deepEqual(fs.readdirSync(t.root).filter(f => f.endsWith('.part')), []);
});

test('a corrupt entry is rejected and rebuilt', async () => {
  const t = setup();
  const a = t.audio('a.wav', 'x');
  const out = await t.make().vocalStem(a);
  fs.writeFileSync(out, 'truncated');
  assert.equal(await t.make().vocalStem(a), out);
  assert.equal(t.calls(), 2);
  assert.ok(fs.readFileSync(out).equals(wav()));
});

test('a separator that writes a bad stem publishes nothing', async () => {
  const t = setup('bad');
  await assert.rejects(t.make().vocalStem(t.audio('a.wav', 'x')));
  assert.deepEqual(fs.readdirSync(t.root), []);
});

test('a no-vocals result is cached and replays as NoVocalsError', async () => {
  const t = setup('none');
  const a = t.audio('a.wav', 'x');
  await assert.rejects(t.make().vocalStem(a), NoVocalsError);
  await assert.rejects(t.make().vocalStem(t.audio('b.wav', 'x')), NoVocalsError);
  assert.equal(t.calls(), 1);
});
