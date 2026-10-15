import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { QueryObserver } from '@tanstack/react-query';
import { createQueryClient, queryClient } from '../client';
import { resourceKey, serverKey, sharedKeys, startAuthSession } from '../keys';
import {
  invalidateSongs, patchSong, postProcessStatusOptions, recentSongsOptions, removeSongs, songsOptions,
} from './songs';
import { readAudioQueue, readGenerationStatus } from './queue';
import { queriedPresetsApi, queriedSettingsApi } from './preferences';

const clients: ReturnType<typeof createQueryClient>[] = [];
const client = () => { const c = createQueryClient(); clients.push(c); return c; };
const originalFetch = globalThis.fetch;
afterEach(() => { clients.splice(0).forEach(c => c.clear()); queryClient.clear(); globalThis.fetch = originalFetch; });
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const song = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, audio_url: `/audio/${id}.wav`, ...extra });

test('library and recent consumers share one request per key; sources and sessions stay apart', async () => {
  const c = client();
  const requests: string[] = [];
  globalThis.fetch = async input => { requests.push(String(input)); await tick(); return json({ songs: [song('a')] }); };
  await Promise.all([c.fetchQuery(songsOptions('t')), c.fetchQuery(songsOptions('t')), c.fetchQuery(songsOptions('t'))]);
  await Promise.all([c.fetchQuery(recentSongsOptions('t', 'create')), c.fetchQuery(recentSongsOptions('t', 'create'))]);
  await c.fetchQuery(recentSongsOptions('t', 'all'));
  assert.deepEqual(requests, ['/api/songs', '/api/songs/recent?limit=50&source=create', '/api/songs/recent?limit=50']);
  // The token never enters a key, and a new session gets its own entries.
  assert.ok(!JSON.stringify(songsOptions('secret-token').queryKey).includes('secret-token'));
  const before = sharedKeys.songs();
  startAuthSession(c, 'another-token');
  assert.notDeepEqual(sharedKeys.songs(), before);
});

test('a song write refetches every song view, studios recent feed included', async () => {
  const c = client();
  let version = 0;
  globalThis.fetch = async input => {
    await tick();
    return String(input).includes('/recent') ? json({ songs: [song(`r${version}`)] }) : json({ songs: [song(`s${version}`)] });
  };
  const library = new QueryObserver(c, songsOptions('t'));
  const recent = new QueryObserver(c, recentSongsOptions('t'));
  const stops = [library.subscribe(() => {}), recent.subscribe(() => {})];
  const studios = serverKey('studios/recent-songs', { auth: true, filters: { limit: 50 } });
  c.setQueryData(studios, { songs: [] });
  try {
    await c.fetchQuery(songsOptions('t'));
    await c.fetchQuery(recentSongsOptions('t'));
    version = 1;
    await invalidateSongs(c);
    assert.equal(library.getCurrentResult().data?.songs[0].id, 's1');
    assert.equal(recent.getCurrentResult().data?.songs[0].id, 'r1');
    assert.equal(c.getQueryState(studios)?.isInvalidated, true, 'studios feed is invalidated, not edited');
  } finally { stops.forEach(stop => stop()); }
});

test('a deleted row is gone at once and a list read already in flight cannot bring it back', async () => {
  const c = client();
  let release: (() => void) | undefined;
  let deleted = false;
  globalThis.fetch = async () => {
    // The first read is the slow one, started before the delete succeeds.
    if (!deleted) { await new Promise<void>(resolve => { release = resolve; }); return json({ songs: [song('a'), song('b')] }); }
    return json({ songs: [song('b')] });
  };
  c.setQueryData(songsOptions('t').queryKey, { songs: [song('a'), song('b')] as never[] });
  const observer = new QueryObserver(c, { ...songsOptions('t'), staleTime: 0 });
  const stop = observer.subscribe(() => {});
  try {
    while (!release) await tick();
    deleted = true;
    const refetched = removeSongs(c, ['a']);
    assert.deepEqual(observer.getCurrentResult().data?.songs.map(s => s.id), ['b']);
    release!();
    await refetched;
    await tick();
    assert.deepEqual(observer.getCurrentResult().data?.songs.map(s => s.id), ['b']);
  } finally { stop(); }
});

test('patchSong edits the library, the detail and the recent feed in place', () => {
  const c = client();
  c.setQueryData(songsOptions('t').queryKey, { songs: [song('a'), song('b')] as never[] });
  c.setQueryData(sharedKeys.song('a'), { song: song('a') });
  c.setQueryData(recentSongsOptions('t', 'create').queryKey, { songs: [song('a')] as never[] });
  void patchSong(c, 'a', { mastered_audio_url: '/audio/a_m.wav' });
  const lib = c.getQueryData<{ songs: Record<string, unknown>[] }>(songsOptions('t').queryKey)!;
  assert.equal(lib.songs[0].mastered_audio_url, '/audio/a_m.wav');
  assert.equal(lib.songs[1].mastered_audio_url, undefined);
  assert.equal(c.getQueryData<{ song: Record<string, unknown> }>(sharedKeys.song('a'))!.song.mastered_audio_url, '/audio/a_m.wav');
  assert.equal(c.getQueryData<{ songs: Record<string, unknown>[] }>(recentSongsOptions('t', 'create').queryKey)!.songs[0].mastered_audio_url, '/audio/a_m.wav');
});

test('a completion patch reconciles every song view; an older read in flight cannot undo it', async () => {
  const c = client();
  let release: (() => void) | undefined;
  let served = 0;
  globalThis.fetch = async () => {
    // The first library read predates the post-processing pass and is slow.
    if (served++ === 0) { await new Promise<void>(resolve => { release = resolve; }); return json({ songs: [song('a')] }); }
    return json({ songs: [song('a', { mastered_audio_url: '/audio/a_m.wav' })] });
  };
  c.setQueryData(songsOptions('t').queryKey, { songs: [song('a')] as never[] });
  const studios = serverKey('studios/recent-songs', { auth: true, filters: { limit: 50 } });
  c.setQueryData(studios, { songs: [song('a')] });
  const library = new QueryObserver(c, { ...songsOptions('t'), staleTime: 0 });
  const stop = library.subscribe(() => {});
  try {
    while (!release) await tick();
    const reconciled = patchSong(c, 'a', { mastered_audio_url: '/audio/a_m.wav' });
    assert.equal(c.getQueryState(studios)?.isInvalidated, true, 'studios feed is reconciled too');
    release!();
    await reconciled;
    await tick();
    const row = library.getCurrentResult().data!.songs[0] as unknown as Record<string, unknown>;
    assert.equal(row.mastered_audio_url, '/audio/a_m.wav');
  } finally { stop(); }
});

test('queue status reads: concurrent loops share one request, and failures are not retried', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; await tick(); return json({ jobId: 'j', status: 'running', progress: 0.4 }); };
  const [a, b, c] = await Promise.all([readGenerationStatus('j'), readGenerationStatus('j'), readGenerationStatus('j')]);
  assert.equal(calls, 1);
  assert.equal(a.status, 'running'); assert.equal(b, a); assert.equal(c, a);

  calls = 0;
  globalThis.fetch = async () => { calls++; return json({ error: 'down' }, 503); };
  await assert.rejects(readGenerationStatus('other'));
  await assert.rejects(readAudioQueue('t'));
  assert.equal(calls, 2, 'one request per read: the executor owns what a failure means');
});

test('a waiter that accepts a recent list rides the projection read instead of asking again', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json({ items: [{ id: 'x', status: 'pending' }] }); };
  await readAudioQueue('t');           // the projection: always asks
  await readAudioQueue('t', 1500);     // the enqueue waiter: a list under one poll old is enough
  assert.equal(calls, 1);
  await readAudioQueue('t');
  assert.equal(calls, 2);
});

test('post-processing polls while running and stops for good at a terminal status', () => {
  const interval = postProcessStatusOptions('s', 'j').refetchInterval as (q: { state: Record<string, unknown> }) => number | false;
  const state = (data: unknown) => ({ state: { data, status: 'success', errorUpdateCount: 0 } });
  assert.equal(interval(state(undefined)), 1500);
  assert.equal(interval(state(null)), 1500, 'an aged-out job keeps the last state and keeps polling');
  assert.equal(interval(state({ status: 'running' })), 1500);
  assert.equal(interval(state({ status: 'succeeded' })), false);
  assert.equal(interval(state({ status: 'failed' })), false);
});

test('preference reads are fresh and shared; a write runs once and the next read sees it', async () => {
  const requests: string[] = [];
  let revision = 1;
  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${String(input)}`);
    await tick();
    if (method === 'PUT') { revision++; return json({ error: 'conflict', currentRevision: revision }, 409); }
    return json({ documents: [{ id: 'p', revision }] });
  };
  await Promise.all([queriedPresetsApi.list('vst-chain'), queriedPresetsApi.list('vst-chain')]);
  assert.equal(requests.length, 1);
  await assert.rejects(queriedPresetsApi.update('vst-chain', 'p', 1, {}));
  const after = await queriedPresetsApi.list<{ id: string; revision: number }>('vst-chain');
  assert.deepEqual(requests, [
    'GET /api/preferences/presets/vst-chain',
    'PUT /api/preferences/presets/vst-chain/p',
    'GET /api/preferences/presets/vst-chain',
  ]);
  assert.equal(after.documents[0].revision, 2, 'conflict read-back sees the current revision');

  requests.length = 0;
  globalThis.fetch = async (input, init) => { requests.push(`${init?.method ?? 'GET'} ${String(input)}`); return json({ document: null }); };
  await queriedSettingsApi.get('storm-tuning');
  assert.deepEqual(requests, ['GET /api/preferences/settings/storm-tuning']);
  assert.deepEqual(resourceKey('shell-queue/presets').slice(0, 2), ['hs', 'shell-queue/presets']);
});
