import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueryClient, queryClient } from '../client';
import { projectOptions, inspirePromptOptions } from './resources';
import { lyricsOptions } from './lyrics';
import { waitForSnapshot } from './wait';
import { serverKey } from '../keys';
import { saveInstagenPrompt } from '../../services/inspireApi';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('late project A response cannot replace project B, and project reads consume abort', async () => {
  const original = globalThis.fetch;
  const client = createQueryClient();
  let resolveA!: (value: Response) => void;
  const heldA = new Promise<Response>(resolve => { resolveA = resolve; });
  let signal: AbortSignal | undefined;
  globalThis.fetch = async (url, opts) => {
    if (String(url).endsWith('/A')) { signal = opts?.signal ?? undefined; return heldA; }
    return json({ project: { id: 'B' }, sections: [] });
  };
  try {
    const first = client.fetchQuery(projectOptions('test-token', 'A')).catch(error => error);
    await tick();
    await client.cancelQueries({ queryKey: projectOptions('test-token', 'A').queryKey });
    assert.equal(signal?.aborted, true);
    await client.fetchQuery(projectOptions('test-token', 'B'));
    resolveA(json({ project: { id: 'A' }, sections: [] }));
    await first;
    assert.equal(client.getQueryData(projectOptions('test-token', 'B').queryKey)?.project.id, 'B');
    assert.equal(client.getQueryData(projectOptions('test-token', 'A').queryKey), undefined);
  } finally { globalThis.fetch = original; client.clear(); }
});

test('prompt mutation invalidation refreshes the cached server value', async () => {
  const original = globalThis.fetch;
  const client = createQueryClient();
  let content = 'Before';
  let writes = 0;
  globalThis.fetch = async (_url, opts) => {
    if (opts?.method === 'PUT') { content = JSON.parse(String(opts.body)).value; writes++; return json({}); }
    return json({ name: 'test', custom: content, default_content: 'Default' });
  };
  try {
    const options = inspirePromptOptions();
    assert.equal((await client.fetchQuery(options)).custom, 'Before');
    await saveInstagenPrompt('After');
    await client.invalidateQueries({ queryKey: options.queryKey });
    assert.equal((await client.fetchQuery(options)).custom, 'After');
    assert.equal(writes, 1);
  } finally { globalThis.fetch = original; client.clear(); }
});

test('lyrics follow the selected source and distinguish missing sidecars from errors', async () => {
  const original = globalThis.fetch;
  const client = createQueryClient();
  globalThis.fetch = async url => String(url).includes('missing') ? json({}, 404) : new Response('[00:01] Words');
  try {
    assert.equal(await client.fetchQuery(lyricsOptions('/audio/missing.wav')), null);
    assert.equal(await client.fetchQuery(lyricsOptions('/audio/present.wav')), '[00:01] Words');
    globalThis.fetch = async () => json({}, 403);
    await assert.rejects(client.fetchQuery(lyricsOptions('/audio/forbidden.wav')), /403/);
  } finally { globalThis.fetch = original; client.clear(); }
});

test('imperative workflow wait uses one shared query and detaches observers at terminal status', async () => {
  queryClient.clear();
  const key = serverKey('studios/test-wait', { id: 'test-job' });
  let calls = 0;
  let status = 'running';
  const read = async (_signal: AbortSignal) => { calls++; return { status }; };
  const active = (value: { status: string }) => value.status === 'running';
  try {
    const first = waitForSnapshot(key, read, active);
    const second = waitForSnapshot(key, read, active);
    await tick();
    assert.equal(calls, 1);
    assert.equal(queryClient.getQueryCache().find({ queryKey: key })?.getObserversCount(), 2);
    status = 'done';
    await queryClient.refetchQueries({ queryKey: key });
    assert.deepEqual(await first, { status: 'done' });
    assert.deepEqual(await second, { status: 'done' });
    await tick();
    assert.equal(calls, 2);
    assert.equal(queryClient.getQueryCache().find({ queryKey: key })?.getObserversCount(), 0);
  } finally { queryClient.clear(); }
});
