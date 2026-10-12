// audioGenQueueStore.generationTime.test.ts — a completed row keeps showing
// real generation time next to the track duration. Moving the queue onto the
// server (a1997989) added refreshServerProjection/projectServerItem but never
// taught them to set `elapsed`, so every server-owned row lost its generation-
// time badge (InlineAudioQueue.tsx only renders it when elapsed > 0). Cover's
// Node workflow render (89ccc119) had the same gap in its own browser-owned
// follower, _followWorkflowRender. See audioGenQueueStore.progress.test.ts for
// why the store is imported this way and the shared test fixture shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createFakeIndexedDB, AudioQueueApiFake, MemoryStorage } from './audioQueueStoreTestFake.js';

register('./cssStubLoader.mjs', import.meta.url);
Object.assign(globalThis, {
  window: { addEventListener() {}, removeEventListener() {} },
  localStorage: new MemoryStorage(),
  indexedDB: createFakeIndexedDB().indexedDB,
});

const {
  OWNER_KEY, addManualQueueItem, updateManualQueueItem, resumeQueue,
  _queueItemsForTests, _resetAudioQueueForTests,
} = await import('./audioGenQueueStore.js');

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const settle = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms));

test('server-owned queue: a running row gets real elapsed time, frozen once it succeeds', async () => {
  localStorage.setItem(OWNER_KEY, 'server');
  const api = new AudioQueueApiFake();
  api.serverItems = [{ id: 'srv1', status: 'submitted', jobId: 'job1', request: { title: 'Cover' },
    meta: { source: 'cover-studio', workflowJobId: 'wf1' }, createdAt: 1 }];
  const uninstall = api.install();
  let jobStatus = 'running';
  const queue = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes('/generate/status/job1')) return ok({ jobId: 'job1', status: jobStatus, progress: 40 });
    return queue(url, init);
  }) as typeof fetch;
  _resetAudioQueueForTests([]);
  try {
    await resumeQueue('t');
    await settle();
    // Real wall-clock time so the per-item timer ticks past zero seconds.
    await settle(1700);
    const row = () => _queueItemsForTests().find(item => item.serverQueueId === 'srv1')!;
    assert.ok((row().elapsed ?? 0) >= 1, 'a running row should report a positive generation time');

    jobStatus = 'succeeded';
    api.serverItems[0].status = 'succeeded';
    api.serverItems[0].request = { title: 'Cover' };
    (api.serverItems[0] as any).result = { audioUrls: ['/audio/a.wav'], durations: [12] };
    await settle(1700);
    const frozen = row().elapsed!;
    await settle(1700);
    assert.equal(row().elapsed, frozen, 'elapsed must stop counting once the row has finished, not keep growing forever');
  } finally { _resetAudioQueueForTests(); uninstall(); }
});

test('browser-owned queue: a workflow-backed Cover row gets real elapsed time while running', async () => {
  localStorage.setItem(OWNER_KEY, 'browser');
  const api = new AudioQueueApiFake();
  const uninstall = api.install();
  const queue = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes('/generate/status/job1')) return ok({ jobId: 'job1', status: 'running', progress: 40 });
    if (String(url).includes('/workflows/jobs/wf1')) return ok({ job: { id: 'wf1', status: 'running', audioIntentIds: ['srv1'] }, events: [], gap: false });
    return queue(url, init);
  }) as typeof fetch;
  api.serverItems = [{ id: 'srv1', status: 'submitted', jobId: 'job1', request: {}, createdAt: 1 }];
  _resetAudioQueueForTests([]);
  try {
    const id = addManualQueueItem({ title: 'Cover' });
    updateManualQueueItem(id, { workflowJob: { id: 'wf1', token: 't' }, stage: 'Generating…' });
    await settle(1700);
    const row = _queueItemsForTests().find(item => item.id === id)!;
    assert.ok((row.elapsed ?? 0) >= 1, 'the workflow follower should report a positive generation time');
  } finally { _resetAudioQueueForTests(); uninstall(); }
});
