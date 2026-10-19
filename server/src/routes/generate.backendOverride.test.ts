// What this guards: the per-job `backendOverride` through the real route entry
// point (submitGeneration), not just buildEnvelope. Backends are stubbed so no
// engine or network is touched: `capabilities` and `generate` record calls.
// Run: npx tsx --test src/routes/generate.backendOverride.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'route-backend-override-'));
process.env.DATA_DIR = DATA_DIR;
const database = await import('../db/database.js');
database.initDb();
const { setEngineReady } = await import('../engineState.js');
const registry = await import('../services/backends/registry.js');
const { submitGeneration, getGenerationJob } = await import('./generate.js');

setEngineReady(true, 'test');
const capabilityCalls: string[] = [];
const generateCalls: string[] = [];
for (const id of ['ace', 'yue2']) {
  const backend = registry.getBackend(id) as any;
  assert.ok(backend, `backend ${id} must be registered`);
  const realCaps = backend.capabilities.bind(backend);
  backend.capabilities = async () => { capabilityCalls.push(id); try { return await realCaps(); } catch { return { extensions: [] }; } };
  backend.generate = async () => { generateCalls.push(id); throw new Error('stub backend: no engine in tests'); };
}

const logs: string[] = [];
const realLog = console.log;
console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
test.after(() => { console.log = realLog; database.closeDb(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

const flat = { caption: 'test', lyrics: '[Instrumental]', duration: 30 };
const intent = (extra: Record<string, unknown> = {}) => ({ contract: 'generation-intent/1', params: { caption: 'test', lyrics: '[Instrumental]', duration: 30 }, ...extra });

async function submit(raw: unknown) {
  const result = await submitGeneration(raw, 'user-1');
  realLog(`  submit -> ${JSON.stringify(result.ok ? { ok: true, backendId: getGenerationJob(result.jobId)?.envelope.backendId } : { ok: false, status: result.status, error: (result.body as any).error })}`);
  return result;
}
function queuedBackend(result: Awaited<ReturnType<typeof submitGeneration>>): string | undefined {
  assert.equal(result.ok, true, `expected a queued job, got ${JSON.stringify(result)}`);
  return result.ok ? getGenerationJob(result.jobId)?.envelope.backendId : undefined;
}

test('1. flat body with backendOverride queues on that non-active backend', async () => {
  assert.equal(registry.setActiveBackendId('ace'), true);
  const r = await submit({ ...flat, backendOverride: 'yue2' });
  assert.equal(queuedBackend(r), 'yue2');
  assert.equal(registry.getActiveBackendId(), 'ace', 'active backend must not change');
});

test('2. intent body with backendOverride resolves capabilities for the override backend', async () => {
  assert.equal(registry.setActiveBackendId('ace'), true);
  capabilityCalls.length = 0;
  const r = await submit(intent({ backendOverride: 'yue2' }));
  realLog(`  capabilities asked of: ${JSON.stringify(capabilityCalls)}`);
  assert.deepEqual(capabilityCalls, ['yue2']);
  assert.equal(queuedBackend(r), 'yue2');
});

test('3. unknown backendOverride returns 400 on the flat and intent paths', async () => {
  for (const raw of [{ ...flat, backendOverride: 'not-a-backend' }, intent({ backendOverride: 'not-a-backend' })]) {
    const r = await submit(raw);
    assert.equal(r.ok, false);
    if (!r.ok) { assert.equal(r.status, 400); assert.match(String((r.body as any).error), /Unknown backendOverride 'not-a-backend'/); }
  }
});

test('4. empty or non-string backendOverride returns 400', async () => {
  for (const bad of ['', 42, true, {}, [], null]) {
    for (const raw of [{ ...flat, backendOverride: bad }, intent({ backendOverride: bad })]) {
      const r = await submit(raw);
      assert.equal(r.ok, false, `backendOverride=${JSON.stringify(bad)} must be rejected`);
      if (!r.ok) { assert.equal(r.status, 400); assert.match(String((r.body as any).error), /backendOverride/); }
    }
  }
});

test('5. backend alone runs on the active backend and logs the mismatch', async () => {
  assert.equal(registry.setActiveBackendId('ace'), true);
  logs.length = 0;
  const r = await submit({ ...flat, backend: 'yue2' });
  assert.equal(queuedBackend(r), 'ace');
  const job = r.ok ? getGenerationJob(r.jobId) : undefined;
  assert.equal(job?.envelope.submittedBackendMismatch, 'yue2');
  assert.ok(logs.some(l => l.includes(`submitted for 'yue2' but runs on 'ace'`)), `mismatch log missing: ${JSON.stringify(logs)}`);
});

test('6. backend and backendOverride together: the override wins', async () => {
  assert.equal(registry.setActiveBackendId('ace'), true);
  const r = await submit({ ...flat, backend: 'ace', backendOverride: 'yue2' });
  assert.equal(queuedBackend(r), 'yue2');
});
