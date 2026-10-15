// api.test.ts — read entrypoints take a signal and keep their error shape.
// Run with the ui suite: node --import ../server/node_modules/tsx/dist/loader.mjs --test "src/**/*.test.ts"
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateApi, getSongPostProcessingStatus, songApi } from './api';
import { ApiError } from './httpClient';

function mockFetch(respond: (url: string) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return respond(String(url)); }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

test('reads pass the signal through; positional callers are unchanged', async () => {
  const { calls, restore } = mockFetch(url =>
    url.endsWith('/songs') ? json(200, { songs: [{ id: 's1', audio_url: '/audio/s1.wav' }] }) : json(200, { depth: 0 }));
  try {
    const ctl = new AbortController();
    const { songs } = await songApi.list('tok', { signal: ctl.signal });
    assert.equal(songs[0].audioUrl, '/audio/s1.wav');  // still normalized
    assert.equal(calls[0].init?.signal, ctl.signal);
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer tok');
    await generateApi.queueStatus();
    assert.equal(calls[1].init?.signal, undefined);
  } finally { restore(); }
});

test('an aborted read rejects with AbortError', async () => {
  const { restore } = mockFetch(() => json(200, {}));
  const real = globalThis.fetch;
  globalThis.fetch = ((_u: string, init?: RequestInit) => new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  })) as typeof fetch;
  try {
    const ctl = new AbortController();
    const pending = songApi.get('s1', { signal: ctl.signal });
    ctl.abort();
    await assert.rejects(pending, (e: unknown) => e instanceof DOMException && e.name === 'AbortError');
  } finally { globalThis.fetch = real; restore(); }
});

test('errors keep ApiError, status and the server message', async () => {
  const { restore } = mockFetch(() => json(500, { error: 'engine down' }));
  try {
    await assert.rejects(songApi.list('tok'), (e: unknown) => e instanceof ApiError && e.status === 500 && e.message === 'engine down');
    await assert.rejects(getSongPostProcessingStatus('s1'), (e: unknown) => e instanceof ApiError && e.status === 500);
  } finally { restore(); }
});
