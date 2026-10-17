import test from 'node:test';
import assert from 'node:assert/strict';
import { runOnMidiLane } from './midiStudio.js';
import { runOnGpuLane } from '../services/generation/gpuLane.js';

test('a MIDI job waits behind a running GPU job (#227)', async () => {
  let releaseRender!: () => void;
  const order: string[] = [];
  const render = runOnGpuLane(() => new Promise<void>(resolve => {
    order.push('render start');
    releaseRender = () => { order.push('render end'); resolve(); };
  }), { label: 'render', family: 'yue2' });
  const midi = runOnMidiLane('job', async () => { order.push('midi'); });

  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(order, ['render start']);
  releaseRender();
  await Promise.all([render, midi]);
  assert.deepEqual(order, ['render start', 'render end', 'midi']);
});
