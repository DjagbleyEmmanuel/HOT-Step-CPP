import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

// The card imports CSS, which the node loader cannot. Stub it for this file.
register('data:text/javascript,' + encodeURIComponent(
  'export async function load(url, ctx, next) { if (url.endsWith(".css")) return { format: "module", source: "export default {}", shortCircuit: true }; return next(url, ctx); }'));
const { createPresetLoadGate, baselineFor } = await import('./Yue2AitkTrainCard');

test('a delayed preset response cannot submit the old form through batch or exposed Start', async () => {
  const gate = createPresetLoadGate();
  let resolveResponse!: () => void;
  const response = new Promise<void>(resolve => { resolveResponse = resolve; });
  let commitForm!: () => void;
  const committed = new Promise<void>(resolve => { commitForm = resolve; });
  let form = { steps: 50 };
  const submitted: number[] = [];
  const startBatch = () => { if (!gate.pending) submitted.push(form.steps); };
  const exposedStart = async () => gate.capture(() => { submitted.push(form.steps); });

  const load = (async () => {
    assert.equal(gate.begin(), true);
    await response;
    form = { steps: 200 };
    await committed;
    gate.release();
  })();

  startBatch();
  await assert.rejects(exposedStart(), /Wait for the preset/);
  assert.deepEqual(submitted, []);

  resolveResponse();
  await response;
  startBatch();
  await assert.rejects(exposedStart(), /Wait for the preset/);
  assert.deepEqual(submitted, []);

  commitForm();
  await load;
  startBatch();
  await exposedStart();
  assert.deepEqual(submitted, [200, 200]);
});

test('DoRA and LoRA baselines carry their own alpha and KL stop, LoKr keeps the recipe defaults (#318)', () => {
  for (const adapterType of ['dora', 'lora'] as const) {
    const base = baselineFor({ adapterType, rank: 64 });
    assert.equal(base.alpha, 64);
    assert.equal(base.targetKl, 1.4);
    assert.equal(base.plannerLrScale, 0.3);
  }
  const lokr = baselineFor({ adapterType: 'lokr', rank: 64 });
  assert.equal(lokr.targetKl, 1.0);
  assert.equal(lokr.plannerLrScale, 0.6);
});
