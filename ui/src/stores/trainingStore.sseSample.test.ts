import assert from 'node:assert/strict';
import test from 'node:test';

Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const { useTrainingStore } = await import('./trainingStore');
const { queryClient } = await import('../queries/client');
const { trainingQueries: tq } = await import('../queries/training-data/queries');

test('a labelled sample from the job stream also lands in the cached dataset detail', () => {
  const key = tq.dataset(null, 'd1').queryKey;
  const before = { sampleId: 's1', labelStatus: 'pending' } as never;
  const after = { sampleId: 's1', labelStatus: 'done', caption: 'new' } as never;
  queryClient.setQueryData(key, { id: 'd1', samples: [before] } as never);
  useTrainingStore.setState({ trainingWorker: null, selectedDatasetId: 'd1', samplesById: {}, sampleOrder: [], pendingEdits: {} });

  useTrainingStore.getState().applyStreamEvent({ type: 'sample', sampleId: 's1', status: 'done', sample: after } as never);

  // A reopen within staleTime reads this entry, so it must not hold the pre-label row.
  assert.deepEqual((queryClient.getQueryData(key) as { samples: unknown[] }).samples, [after]);
  queryClient.clear();
});
