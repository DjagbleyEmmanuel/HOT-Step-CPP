// An empty models folder makes ace-server exit 1 after "ERROR: no models found".
// That is a first run, not a crash: no restart budget burnt, no respawn, and a
// later restartAceServer() (a finished download) clears the state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

function fakeChild(): any {
  const c: any = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.pid = 4243;
  c.exitCode = null;
  c.signalCode = null;
  c.kill = () => true;
  return c;
}

test('no-models exit is classified, spends no crash budget and does not respawn', async () => {
  process.env.ACESTEPCPP_EXE = process.execPath;   // only needs to exist
  const proc = await import('./aceEngineProcess.js');
  const state = await import('../engineState.js');
  const kids: any[] = [];
  proc.testHooks.spawn = (() => { const c = fakeChild(); kids.push(c); return c; }) as any;

  try {
    proc.startAceServer();
    const k = kids[0];
    const seq = proc.engineCrashSeq();
    k.stderr.emit('data', Buffer.from('[Server] ERROR: no models found in C:\data\models\n'));
    k.exitCode = 1;
    k.emit('exit', 1, null);

    assert.equal(state.engineNoModels, true);
    assert.equal(state.engineReady, false);
    assert.match(state.engineBootStatus, /Model Manager/);
    assert.equal(proc.engineCrashSeq(), seq, 'not counted as a crash');
    await new Promise(r => setTimeout(r, 3300));
    assert.equal(kids.length, 1, 'no respawn timer was armed');

    // A download finishing brings it back; the flag clears.
    proc.retryIfGaveUp();
    assert.equal(kids.length, 2);
    assert.equal(state.engineNoModels, false);

    // A plain exit 1 without the stderr line is still a crash.
    const k2 = kids[1];
    k2.exitCode = 1;
    k2.emit('exit', 1, null);
    assert.equal(state.engineNoModels, false);
    assert.equal(proc.engineCrashSeq(), seq + 1);
  } finally {
    for (const k of kids) k.exitCode = 0;
    await proc.stopAceServer('test over', 100).catch(() => {});
  }
});
