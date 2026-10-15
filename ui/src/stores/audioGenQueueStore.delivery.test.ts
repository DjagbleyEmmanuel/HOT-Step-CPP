// audioGenQueueStore.delivery.test.ts — a server-owned Create render reaches
// the library once. The server projection and the enqueue's own waiter both
// see it finish; between the `song-created` event and onSongCreated (both end
// in App's handleSongCreated) the song must be delivered exactly once, from
// one submission. See audioGenQueueStore.migration.test.ts for why the store
// is imported this way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createFakeIndexedDB, MemoryStorage } from './audioQueueStoreTestFake.js';

register('./cssStubLoader.mjs', import.meta.url);
const songCreatedEvents: string[] = [];
Object.assign(globalThis, {
  window: {
    addEventListener() {}, removeEventListener() {},
    dispatchEvent(event: Event) {
      if (event.type === 'song-created') songCreatedEvents.push((event as CustomEvent).detail.song.id);
      return true;
    },
  },
  CustomEvent: class extends Event {
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) { super(type); this.detail = init?.detail; }
  },
  localStorage: new MemoryStorage(),
  indexedDB: createFakeIndexedDB().indexedDB,
});

const {
  OWNER_KEY, enqueueSimpleGen, resumeQueue, _queueItemsForTests, _resetAudioQueueForTests,
} = await import('./audioGenQueueStore.js');

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('server-owned render: one submission, and the finished song is delivered once', async () => {
  localStorage.setItem(OWNER_KEY, 'server');
  const server: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const saved = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = new URL(url, 'http://local').pathname;
    calls.push(`${method} ${path}`);
    if (path === '/api/audio-queue/items' && method === 'POST') {
      const { idempotencyKey, request, meta } = JSON.parse(String(init!.body));
      const item = { id: 'srv1', idempotencyKey, status: 'submitted', jobId: 'job1', request, meta, createdAt: 1 };
      server.push(item);
      return ok({ item, created: true });
    }
    if (path === '/api/audio-queue/items') return ok({ items: server });
    if (path === '/api/generate/status/job1') return ok({ jobId: 'job1', status: 'running', progress: 50 });
    if (path === '/api/songs/song1') return ok({ song: { id: 'song1', title: 'Done', audio_url: '/audio/s.wav' } });
    return new Response(JSON.stringify({ error: 'no route' }), { status: 404 });
  }) as typeof fetch;
  _resetAudioQueueForTests([]);
  const delivered: string[] = [];
  try {
    await resumeQueue('t');
    await enqueueSimpleGen({ title: 'Done' } as never, 't', song => delivered.push(song.id));
    Object.assign(server[0], { status: 'succeeded', result: { songIds: ['song1'], audioUrls: ['/audio/s.wav'] } });
    await new Promise(resolve => setTimeout(resolve, 4000));
    assert.equal(calls.filter(c => c === 'POST /api/audio-queue/items').length, 1, 'submitted once');
    assert.deepEqual([...delivered, ...songCreatedEvents], ['song1'], 'delivered once, by either path');
    // The enqueue raced the projection's first read; the projection must still
    // pick the row up at the active cadence, not wait out the idle one.
    assert.equal(_queueItemsForTests().find(item => item.serverQueueId === 'srv1')?.status, 'succeeded');
  } finally {
    _resetAudioQueueForTests();
    globalThis.fetch = saved;
  }
});
