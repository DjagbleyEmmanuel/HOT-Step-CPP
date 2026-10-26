import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertIdle, assertScratchEnv, inside } from './promote.mjs';
import { maintenanceHandler } from './runtime.mjs';

test('promotion fails closed for busy, unknown, or moving data', () => {
  assert.doesNotThrow(() => assertIdle({ blockers: [], pending: null }));
  for (const report of [{}, null, { blockers: ['training'] }, { blockers: [], pending: {} }]) {
    assert.throws(() => assertIdle(report));
  }
});
test('path boundary excludes a sibling with the same prefix', () => {
  assert.equal(inside('D:/app', 'D:/app/engine/a.exe'), true);
  assert.equal(inside('D:/app', 'D:/app-other/engine/a.exe'), false);
  assert.equal(inside('D:/app', 'D:/app'), false);
});
test('repeat promotion accepts generated relative paths and rejects escaped scratch writes', () => {
  const scratch = path.resolve('scratch-data');
  assert.doesNotThrow(() => assertScratchEnv('LYRICS_EXPORT_DIR=./data/lyrics\n', scratch));
  assert.throws(() => assertScratchEnv('LYRICS_EXPORT_DIR=../real-data\n', scratch));
  assert.throws(() => assertScratchEnv(`DATA_DIR="${path.resolve('real-data')}"\n`, scratch));
});
test('maintenance drains existing submissions and rejects new work until resumed', async () => {
  let release;
  const server = http.createServer(maintenanceHandler((req, res) => {
    if (req.url === '/slow') release = () => res.end('done');
    else res.end('ok');
  }, 'test-token'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const gate = action => fetch(`${base}/__prod/maintenance`, { method: 'POST', headers: { 'x-hotstep-prod-token': 'test-token', 'x-hotstep-prod-action': action } });
  try {
    const slow = fetch(`${base}/slow`, { method: 'POST' });
    while (!release) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await fetch(`${base}/__prod/maintenance`, { method: 'POST' })).status, 403);
    const paused = gate('pause');
    // Observe the gate, rather than assume timing of the control request.
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await fetch(`${base}/submit`, { method: 'POST' });
      if (response.status === 503) break;
      assert.ok(attempt < 99, 'gate did not pause');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal((await fetch(`${base}/audio`)).status, 200);
    release(); await slow;
    assert.deepEqual(await (await paused).json(), { paused: true, drained: true });
    await gate('resume');
    assert.equal((await fetch(`${base}/submit`, { method: 'POST' })).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
test('Windows rebuild dry run preserves an inert sibling engine and lock excludes rebuild', { skip: process.platform !== 'win32' }, () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const result = spawnSync('pwsh', ['-NoProfile', '-File', path.join(root, 'tools/prod/isolation-test.ps1')], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ISOLATION PASS/);
});
