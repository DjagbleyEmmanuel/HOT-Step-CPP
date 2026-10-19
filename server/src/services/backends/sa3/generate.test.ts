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

// The lane must stay held until the engine's worker has provably finished the
// SA3 call. Each test scripts the engine: the render POST, then the replies to
// successive /worker-drain calls ('fail' = socket error, '404' = an engine
// without the route, 'ok' = held until released by the test).
type DrainReply = 'fail' | '404' | 'ok';
async function withScriptedEngine(
  post: 'hang' | 'socket-error',
  drains: DrainReply[],
  body: (h: { calls: string[]; releaseDrain: () => void }) => Promise<void>,
) {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  let releaseDrain: () => void = () => {};
  const socketError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path === '/worker-drain') {
      const reply = drains.shift() ?? 'ok';
      if (reply === 'fail') throw socketError();
      if (reply === '404') return new Response('Not Found', { status: 404 });
      await new Promise<void>(r => { releaseDrain = r; });
      return new Response('{"status":"ok"}');
    }
    if (post === 'socket-error') throw socketError();
    return new Promise<Response>((_, reject) => {
      init!.signal!.addEventListener('abort',
        () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  }) as typeof fetch;
  try {
    await body({ calls, releaseDrain: () => releaseDrain() });
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function startSynth(signal?: AbortSignal) {
  const { aceClient } = await import('../../aceClient.js');
  const state = { settled: false };
  const p = aceClient.submitSa3Synth({ tokens: [1], nTokens: 1, durationSec: 1, signal })
    .catch((e: Error) => { state.settled = true; return e; });
  return { p, state };
}

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

test('an aborted SA3 render settles only after the engine worker drains', async () => {
  await withScriptedEngine('hang', ['ok'], async ({ calls, releaseDrain }) => {
    const ac = new AbortController();
    const { p, state } = await startSynth(ac.signal);
    await tick(0);
    ac.abort();
    await tick();
    assert.deepEqual(calls, ['/sa3-synth', '/worker-drain']);
    assert.equal(state.settled, false, 'must not settle while the engine is still stopping');
    releaseDrain();
    assert.equal(((await p) as Error).name, 'AbortError');
  });
});

test('a failed drain is retried, not taken as proof the engine stopped', async () => {
  await withScriptedEngine('hang', ['fail', 'ok'], async ({ calls, releaseDrain }) => {
    const ac = new AbortController();
    const { p, state } = await startSynth(ac.signal);
    await tick(0);
    ac.abort();
    await tick(1300);  // past the 1 s retry delay
    assert.deepEqual(calls, ['/sa3-synth', '/worker-drain', '/worker-drain']);
    assert.equal(state.settled, false, 'a socket error on the drain must keep the lane held');
    releaseDrain();
    assert.equal(((await p) as Error).name, 'AbortError');
  });
});

test('a render POST that dies on a socket error drains before it rejects', async () => {
  await withScriptedEngine('socket-error', ['ok'], async ({ calls, releaseDrain }) => {
    const { p, state } = await startSynth();
    await tick();
    assert.deepEqual(calls, ['/sa3-synth', '/worker-drain']);
    assert.equal(state.settled, false);
    releaseDrain();
    assert.equal(((await p) as Error).message, 'fetch failed');
  });
});

test('a 404 from /worker-drain keeps the lane held', async () => {
  await withScriptedEngine('hang', ['404', 'ok'], async ({ calls, releaseDrain }) => {
    const ac = new AbortController();
    const { p, state } = await startSynth(ac.signal);
    await tick(0);
    ac.abort();
    await tick(1300);  // past the 1 s retry delay
    assert.deepEqual(calls, ['/sa3-synth', '/worker-drain', '/worker-drain']);
    assert.equal(state.settled, false, 'a 404 proves nothing about the render');
    releaseDrain();
    assert.equal(((await p) as Error).name, 'AbortError');
  });
});
