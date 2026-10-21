import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFactGroups } from './songFacts';
import type { Song } from '../../types';

function planStage(yue2: Record<string, unknown>, yue2Request?: Record<string, unknown>): string | undefined {
  const song = { backend: 'yue2', generationParams: { backend: 'yue2', yue2, yue2Request } } as unknown as Song;
  const outcome = buildFactGroups(song).find(g => g.title === 'Outcome');
  return outcome?.facts.find(f => f.label === 'Plan stage')?.value;
}

test('an app-planned score does not read as a plan stage that never ran (#271)', () => {
  const stage_end_reasons = { plan: 'skipped', semantic: 'eos' };
  assert.equal(planStage({ abc_supplied: false, abc_planned: true, stage_end_reasons }), 'Planned by the app');
  assert.equal(planStage({ abc_supplied: true, stage_end_reasons }), undefined, 'a supplied score drops the row');
  assert.equal(planStage({ abc_supplied: false, abc_planned: true, stage_end_reasons }, { abc: 'X:1', cot: 'full' }), 'Planned by the app',
    'the persisted request carries the planned abc; the flag still wins');
  assert.equal(planStage({ abc_supplied: false, stage_end_reasons }), 'Not run', 'cot off still reads Not run');
});
