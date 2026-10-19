import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SA3_LOADING_STAGE, sa3RenderStage } from './generate.js';

// Copied from the DAW facade (pr/29 dawFacade.ts:457): a stage matching this
// reports phase loading_model and eta_s null. pr/06 has no facade, so the
// regex is asserted directly here.
const FACADE_LOADING_RE = /^loading\b/i;

test('SA3 stage at submit reads as loading', () => {
  console.log('submit stage:', SA3_LOADING_STAGE);
  assert.match(SA3_LOADING_STAGE, FACADE_LOADING_RE);
});

test('SA3 stage once the render fetch is sent does not read as loading', () => {
  const s = sa3RenderStage(30.4, 8);
  console.log('render stage:', s);
  assert.doesNotMatch(s, FACADE_LOADING_RE);
  assert.ok(s.startsWith('SA3: rendering'));
  assert.ok(s.includes('30s') && s.includes('8 steps'));
});

test('real progress (saving audio) replaces the loading stage', () => {
  const saving = 'Stable Audio 3: saving audio...';
  assert.doesNotMatch(saving, FACADE_LOADING_RE);
});

test('an aborted SA3 render settles only after the engine worker drains', async () => {
  const { aceClient } = await import('../../aceClient.js');
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  let releaseDrain!: () => void;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path === '/worker-drain') {
      await new Promise<void>(r => { releaseDrain = r; });
      return new Response('{"status":"ok"}');
    }
    return new Promise<Response>((_, reject) => {
      init!.signal!.addEventListener('abort',
        () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  }) as typeof fetch;
  try {
    const ac = new AbortController();
    let settled = false;
    const p = aceClient.submitSa3Synth({ tokens: [1], nTokens: 1, durationSec: 1, signal: ac.signal })
      .catch((e: Error) => { settled = true; return e; });
    await new Promise(r => setImmediate(r));
    ac.abort();
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(calls, ['/sa3-synth', '/worker-drain']);
    assert.equal(settled, false, 'must not settle while the engine is still stopping');
    releaseDrain();
    assert.equal(((await p) as Error).name, 'AbortError');
  } finally {
    globalThis.fetch = realFetch;
  }
});
