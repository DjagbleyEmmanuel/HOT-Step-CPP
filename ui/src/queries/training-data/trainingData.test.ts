// trainingData.test.ts — worker scoping, cancellation and stale-response
// guards for the training-data store and its query options.
// Run with the ui suite: node --import ../server/node_modules/tsx/dist/loader.mjs --test "src/**/*.test.ts"
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { queryClient } from '../client';
import { scopeOf } from '../keys';
import { trainingQueries } from './queries';
import { useTrainingStore } from '../../stores/trainingStore';
import { setTrainingWorker } from '../../services/trainingApi';

const initial = useTrainingStore.getState();
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  setTrainingWorker(null);
  useTrainingStore.setState(initial, true);
  queryClient.clear();
});

type Reply = { body: unknown; status?: number };
/** A fake server. `routes` maps a URL to its reply; a reply held with
 *  `hold(url)` waits until `release(url)`. Aborts reject like fetch does. */
function fakeServer(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const aborted: string[] = [];
  const held = new Map<string, () => void>();
  const holds = new Set<string>();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (holds.has(url)) {
      await new Promise<void>((resolve, reject) => {
        held.set(url, resolve);
        init?.signal?.addEventListener('abort', () => {
          aborted.push(url);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    if (!(url in routes)) return new Response(JSON.stringify({ error: 'nope' }), { status: 404 });
    const reply = routes[url] as Reply;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return {
    calls, aborted,
    hold: (url: string) => { holds.add(url); },
    release: (url: string) => { holds.delete(url); held.get(url)?.(); },
  };
}

const A = '/api/workers/A/api/training';
const B = '/api/workers/B/api/training';
const LOCAL = '/api/training';
const ds = (id: string) => ({ id, name: id, labeledCount: 0, samples: [], activeJobId: null });
const tick = () => new Promise(r => setTimeout(r, 0));

test('local and worker reads route by the worker in their key', async () => {
  const srv = fakeServer({
    [`${LOCAL}/datasets`]: { body: { datasets: [ds('here')] } },
    [`${A}/datasets`]: { body: { datasets: [ds('there')] } },
  });
  const local = await queryClient.fetchQuery(trainingQueries.datasets(null));
  const remote = await queryClient.fetchQuery(trainingQueries.datasets('A'));
  assert.deepEqual(srv.calls, [`${LOCAL}/datasets`, `${A}/datasets`]);
  assert.equal(local[0].id, 'here');
  assert.equal(remote[0].id, 'there');
  assert.equal(scopeOf(trainingQueries.datasets('A').queryKey)?.worker, 'A');
  assert.equal(scopeOf(trainingQueries.datasets(null).queryKey)?.worker, null);
});

test('a read captures its worker: switching the global after scheduling does not move it', async () => {
  const srv = fakeServer({ [`${A}/datasets`]: { body: { datasets: [] } } });
  srv.hold(`${A}/datasets`);
  const read = queryClient.fetchQuery(trainingQueries.datasets('A'));
  await tick();
  setTrainingWorker('B');
  srv.release(`${A}/datasets`);
  await read;
  assert.deepEqual(srv.calls, [`${A}/datasets`]);
});

test('a slow dataset list from worker A never lands after switching to B', async () => {
  const srv = fakeServer({
    [`${A}/datasets`]: { body: { datasets: [ds('a1')] } },
    [`${B}/datasets`]: { body: { datasets: [ds('b1')] } },
    [`${B}/capabilities`]: { body: {} },
    [`${B}/yue2-batch`]: { body: { batches: [] } },
  });
  setTrainingWorker('A');
  useTrainingStore.setState({ trainingWorker: 'A' });
  srv.hold(`${A}/datasets`);
  const loadA = useTrainingStore.getState().loadDatasets();
  await tick();
  await useTrainingStore.getState().setTrainingWorker('B');
  srv.release(`${A}/datasets`);
  await loadA;
  const s = useTrainingStore.getState();
  assert.equal(s.trainingWorker, 'B');
  assert.deepEqual(s.datasets.map(d => d.id), ['b1']);
  assert.equal(s.error, null, 'the cancelled read must not surface as an error');
  // The switch cancelled the read it no longer wanted.
  assert.deepEqual(srv.aborted, [`${A}/datasets`]);
});

test('a slow dataset open from worker A does not open on B', async () => {
  const srv = fakeServer({
    [`${A}/datasets/x`]: { body: ds('x') },
    [`${B}/datasets`]: { body: { datasets: [] } },
    [`${B}/capabilities`]: { body: {} },
  });
  setTrainingWorker('A');
  useTrainingStore.setState({ trainingWorker: 'A' });
  srv.hold(`${A}/datasets/x`);
  const open = useTrainingStore.getState().openDataset('x');
  await tick();
  await useTrainingStore.getState().setTrainingWorker('B');
  srv.release(`${A}/datasets/x`);
  await open;
  const s = useTrainingStore.getState();
  assert.equal(s.selectedDatasetId, null);
  assert.equal(s.detail, null);
});

test('the newest open wins, and a close beats an open still in flight', async () => {
  const srv = fakeServer({
    [`${LOCAL}/datasets/slow`]: { body: ds('slow') },
    [`${LOCAL}/datasets/fast`]: { body: ds('fast') },
  });
  srv.hold(`${LOCAL}/datasets/slow`);
  const slow = useTrainingStore.getState().openDataset('slow');
  await tick();
  await useTrainingStore.getState().openDataset('fast');
  srv.release(`${LOCAL}/datasets/slow`);
  await slow;
  assert.equal(useTrainingStore.getState().selectedDatasetId, 'fast');

  srv.hold(`${LOCAL}/datasets/slow`);
  const again = useTrainingStore.getState().openDataset('slow');
  await tick();
  useTrainingStore.getState().closeDataset();
  srv.release(`${LOCAL}/datasets/slow`);
  await again;
  assert.equal(useTrainingStore.getState().selectedDatasetId, null);
});

test('concurrent loads of one list share a request', async () => {
  const srv = fakeServer({ [`${LOCAL}/datasets`]: { body: { datasets: [] } } });
  srv.hold(`${LOCAL}/datasets`);
  const a = useTrainingStore.getState().loadDatasets();
  const b = useTrainingStore.getState().loadDatasets();
  await tick();
  srv.release(`${LOCAL}/datasets`);
  await Promise.all([a, b]);
  assert.equal(srv.calls.filter(u => u === `${LOCAL}/datasets`).length, 1);
});

test('a status read for the previous dataset does not land on the next', async () => {
  const srv = fakeServer({
    [`${LOCAL}/datasets/one/preprocess`]: { body: { variants: [{ key: 'one' }] } },
  });
  useTrainingStore.setState({ selectedDatasetId: 'one' });
  srv.hold(`${LOCAL}/datasets/one/preprocess`);
  const read = useTrainingStore.getState().loadPreprocessStatus();
  await tick();
  useTrainingStore.setState({ selectedDatasetId: 'two' });
  srv.release(`${LOCAL}/datasets/one/preprocess`);
  await read;
  assert.deepEqual(srv.calls, [`${LOCAL}/datasets/one/preprocess`]);
  const s = useTrainingStore.getState();
  assert.equal(s.preprocessStatus, null);
  assert.equal(s.preprocessLoading, false);
});

test('a terminal stream event invalidates the worker scope once, replay included', async () => {
  const srv = fakeServer({
    [`${A}/datasets/d`]: { body: ds('d') },
    [`${A}/datasets`]: { body: { datasets: [ds('d')] } },
    [`${A}/datasets/d/ls-generations`]: { body: { lyricsSetId: 0, artist: '', album: '', generations: [] } },
    [`${B}/datasets/d/ls-generations`]: { body: { lyricsSetId: 0, artist: '', album: '', generations: [] } },
  });
  setTrainingWorker('A');
  useTrainingStore.setState({
    trainingWorker: 'A', selectedDatasetId: 'd',
    activeJob: { id: 'job-term', kind: 'label', status: 'running' } as never,
  });
  await queryClient.fetchQuery(trainingQueries.lsGenerations('A', 'd'));
  await queryClient.fetchQuery(trainingQueries.lsGenerations('B', 'd'));
  const apply = useTrainingStore.getState().applyStreamEvent;
  apply({ type: 'status', status: 'done' });
  apply({ type: 'status', status: 'done' }); // replayed on reconnect
  await tick(); await tick();
  const stateOf = (w: string) => queryClient.getQueryState(trainingQueries.lsGenerations(w, 'd').queryKey);
  assert.equal(stateOf('A')?.isInvalidated, true);
  assert.equal(stateOf('B')?.isInvalidated, false, 'another worker is untouched');
  assert.equal(srv.calls.filter(u => u === `${A}/datasets/d`).length, 1, 'one refresh per job');
});

test('a job started on A is not adopted once the studio is on B', async () => {
  const srv = fakeServer({
    [`${A}/datasets/d/label`]: { body: { jobId: 'j1' } },
    [`${A}/jobs/j1`]: { body: { id: 'j1', kind: 'label', status: 'running' } },
  });
  setTrainingWorker('A');
  useTrainingStore.setState({ trainingWorker: 'A', selectedDatasetId: 'd' });
  srv.hold(`${A}/datasets/d/label`);
  const start = useTrainingStore.getState().startLabel({} as never);
  await tick();
  setTrainingWorker('B');
  useTrainingStore.setState({ trainingWorker: 'B', selectedDatasetId: null });
  srv.release(`${A}/datasets/d/label`);
  await start;
  assert.equal(useTrainingStore.getState().activeJob, null);
  assert.ok(!srv.calls.includes(`${A}/jobs/j1`), 'no adoption read for a scope that is gone');
});
