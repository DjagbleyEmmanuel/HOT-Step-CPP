import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { listBackends } from './backends/registry.js';
import { createBuildSession, generateBuildTakes, getBuildSession, keepBuildTake, renderBuildPreview } from './yue2Takes.js';
import type { Yue2SynthRequest, Yue2TrackDetail } from './backends/yue2/client.js';

function pcm(): Buffer {
  const wav = Buffer.alloc(44 + 1920);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(1920, 40);
  return wav;
}

test('YuE2 takes and the build preview free every other family before calling YuE2', async t => {
  const previousDir = config.data.dir;
  const dir = fs.mkdtempSync(path.resolve('.test-yue2-evict-'));
  config.data.dir = dir;
  t.after(() => { config.data.dir = previousDir; fs.rmSync(dir, { recursive: true, force: true }); });
  const calls: string[] = [];
  const others = listBackends().filter(b => b.id !== 'yue2' && b.releaseVram);
  assert.ok(others.length > 0, 'at least one other family is registered');
  for (const b of others) {
    // A slow release: an eviction that is not awaited lands after the synth call.
    t.mock.method(b as Required<typeof b>, 'releaseVram', async () => {
      calls.push(`release-start:${b.id}`);
      await new Promise(r => setTimeout(r, 30));
      calls.push(`released:${b.id}`);
    });
  }
  const results = new Map<string, Yue2TrackDetail[]>();
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/yue2/synth') {
      calls.push('yue2-synth');
      const req = JSON.parse(String(init?.body)) as Yue2SynthRequest;
      const seeds = req.songs?.map(s => s.seed!) ?? [req.seed!];
      const id = String(results.size + 1);
      results.set(id, seeds.map((seed, song) => ({ song, seed: String(seed), noise_seed: String(seed), variation: 0,
        semantic_ids: [...(req.codec_ids ?? []), ...Array<number>(400).fill(1)], frames: (req.codec_ids?.length ?? 0) + 400 })));
      return Response.json({ id });
    }
    if (url.pathname === '/yue2/align') return Response.json({ words: [] });
    const tracks = results.get(url.searchParams.get('id')!)!;
    if (url.searchParams.has('result')) return new Response(new Uint8Array(pcm()), { headers: { 'content-type': 'audio/wav' } });
    return Response.json({ status: 'done', tracks });
  });
  const until = async (cond: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!cond()) {
      assert.ok(Date.now() < deadline, 'worker finished within deadline');
      await new Promise(r => setTimeout(r, 5));
    }
  };
  const checkOrder = (label: string) => {
    console.log(`[${label}] recorded calls: ${calls.join(', ')}`);
    const synth = calls.indexOf('yue2-synth');
    assert.ok(synth >= 0, `${label}: YuE2 was called`);
    for (const b of others) {
      const done = calls.indexOf(`released:${b.id}`);
      assert.ok(done >= 0 && done < synth, `${label}: '${b.id}' release awaited before YuE2 (released at ${done}, synth at ${synth})`);
    }
  };

  const abc = ['X:1', 'M:3/4', 'L:1/8', 'Q:1/8=120', 'K:C', '% verse', 'V: Vocal', 'C6|D6|', ''].join('\n');
  const s = createBuildSession({}, { style: 'ambient', cot: 'off', abc, lyrics: '[verse]\nfirst line here', lm_batch_size: 1, synth_batch_size: 1 }, 'user');
  generateBuildTakes(s.id, 'user', 0, 1, 0);
  await until(() => getBuildSession(s.id, 'user').pending.length === 0);
  const session = getBuildSession(s.id, 'user');
  assert.equal(session.error, null);
  checkOrder('takes');

  calls.length = 0;
  keepBuildTake(s.id, 'user', session.takes[0].id, 0);
  renderBuildPreview(s.id, 'user');
  await until(() => getBuildSession(s.id, 'user').preview?.status !== 'rendering');
  assert.equal(getBuildSession(s.id, 'user').preview?.status, 'done');
  checkOrder('preview');
});
