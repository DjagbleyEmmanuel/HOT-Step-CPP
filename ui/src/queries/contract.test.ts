// contract.test.ts — retry policy, poll helper and client defaults.
// Run with the ui suite: node --import ../server/node_modules/tsx/dist/loader.mjs --test "src/**/*.test.ts"
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { ApiError } from '../services/httpClient';
import {
  ERROR_POLL_MAX_MS, isRetryableError, pollWhile, retryDelay, retryQuery,
} from './contract';
import { createQueryClient as makeClient } from './client';

// gcTime keeps a 5 min timer per query; clear every client so node can exit.
const made: ReturnType<typeof makeClient>[] = [];
const createQueryClient = () => { const c = makeClient(); made.push(c); return c; };
after(() => made.forEach(c => c.clear()));

test('only network errors and 5xx are retryable', () => {
  assert.equal(isRetryableError(new TypeError('Failed to fetch')), true);
  assert.equal(isRetryableError(new ApiError(0, 'closed', null)), true);
  assert.equal(isRetryableError(new ApiError(503, 'busy', null)), true);
  assert.equal(isRetryableError(new ApiError(404, 'gone', null)), false);
  assert.equal(isRetryableError(new ApiError(409, 'stale', null)), false);
  assert.equal(isRetryableError(new DOMException('Aborted', 'AbortError')), false);
  assert.equal(isRetryableError(new Error('plain')), false);
});

test('at most two retries, with a capped exponential delay', () => {
  const err = new ApiError(500, 'x', null);
  assert.equal(retryQuery(0, err), true);
  assert.equal(retryQuery(1, err), true);
  assert.equal(retryQuery(2, err), false);
  assert.deepEqual([0, 1, 2, 3, 10].map(retryDelay), [500, 1000, 2000, 4000, 4000]);
});

test('pollWhile stops at a terminal state and backs off while failing', () => {
  const poll = pollWhile<{ status: string }>(d => d?.status === 'running', 1500);
  const q = (data: { status: string } | undefined, fetchFailureCount = 0) =>
    ({ state: { data, fetchFailureCount } }) as Parameters<typeof poll>[0];
  assert.equal(poll(q({ status: 'running' })), 1500);
  assert.equal(poll(q({ status: 'done' })), false);
  assert.equal(poll(q({ status: 'running' }, 1)), 3000);
  assert.equal(poll(q({ status: 'running' }, 2)), 6000);
  assert.equal(poll(q({ status: 'running' }, 9)), ERROR_POLL_MAX_MS);
});

test('client: a 5xx read is retried twice, then fails without caching data', async () => {
  const client = createQueryClient();
  let calls = 0;
  const key = ['hs', 'test/a'];
  await assert.rejects(client.fetchQuery({
    queryKey: key,
    queryFn: async () => { calls++; throw new ApiError(500, 'boom', null); },
    retryDelay: 1,
  }));
  assert.equal(calls, 3);
  assert.equal(client.getQueryData(key), undefined);
  assert.equal(client.getQueryState(key)?.status, 'error');
  client.clear();
});

test('client: a 4xx read is not retried', async () => {
  const client = createQueryClient();
  let calls = 0;
  await assert.rejects(client.fetchQuery({
    queryKey: ['hs', 'test/b'],
    queryFn: async () => { calls++; throw new ApiError(404, 'missing', null); },
  }));
  assert.equal(calls, 1);
  client.clear();
});

test('client: mutations never retry, even on a 5xx', async () => {
  const client = createQueryClient();
  let calls = 0;
  const mutation = client.getMutationCache().build(client, {
    mutationFn: async () => { calls++; throw new ApiError(503, 'busy', null); },
  });
  await assert.rejects(mutation.execute(undefined));
  assert.equal(calls, 1);
  client.clear();
});

test('client: project defaults are applied', () => {
  const d = createQueryClient().getDefaultOptions();
  assert.equal(d.queries?.staleTime, 30_000);
  assert.equal(d.queries?.gcTime, 300_000);
  assert.equal(d.queries?.refetchOnWindowFocus, false);
  assert.equal(d.queries?.refetchOnReconnect, true);
  assert.equal(d.mutations?.retry, false);
});
