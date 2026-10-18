import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteEngineBackendLine, resetEngineDevice, backendFamily, engineDevice } from './engineState.js';

test('backend line sets the device; reset clears it', () => {
  assert.equal(noteEngineBackendLine('[Load] YuE2 backend: CUDA0 (CPU threads: 16)\r'), true);
  assert.equal(engineDevice, 'CUDA0');
  assert.equal(backendFamily(engineDevice), 'cuda');
  assert.equal(noteEngineBackendLine('[Load] DiT backend: CPU (shared)'), true);
  assert.equal(backendFamily(engineDevice), 'cpu');
  assert.equal(noteEngineBackendLine('[Load] WARNING: ggml-cuda.dll found'), false);
  resetEngineDevice();
  assert.equal(engineDevice, null);
  assert.equal(backendFamily(engineDevice), null);
});
