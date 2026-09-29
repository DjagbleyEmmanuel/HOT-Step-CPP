// What this guards: monitor control commands must not be dropped. A pause must
// keep a pending track, a seek must keep a pending pause, seq must increase on
// every write, and a seek must be tagged with its own seekSeq so the host can
// apply it exactly once.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createControlWriter, mergeControl } from './vstControl.js';

test('pause merges into state and keeps the track', () => {
  const s1 = mergeControl({}, { track: 'a.wav', action: 'play' }, 1, true);
  const s2 = mergeControl(s1, { action: 'pause' }, 2);
  assert.equal(s2.track, 'a.wav');
  assert.equal(s2.action, 'pause');
  assert.equal(s2.seq, 2);
});

test('seek keeps a pending pause and gets its own seekSeq', () => {
  const s1 = mergeControl({ track: 'a.wav', action: 'pause', seq: 5 }, { seek: 12.5 }, 6);
  assert.equal(s1.action, 'pause');
  assert.equal(s1.seek, 12.5);
  assert.equal(s1.seekSeq, 6);
  const s2 = mergeControl(s1, { action: 'play' }, 7);
  assert.equal(s2.seekSeq, 6, 'a later non-seek write must not re-arm the seek');
  assert.equal(s2.seq, 7);
});

test('writer produces increasing seq and a parseable file with no temp left', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vstctl-'));
  const file = path.join(dir, 'monitor_control.json');
  const w = createControlWriter(() => file);
  w.write({ track: 'a.wav', action: 'play' }, true);
  const first = JSON.parse(fs.readFileSync(file, 'utf-8'));
  for (let i = 0; i < 10; i++) w.write({ seek: i });
  w.write({ action: 'pause' });
  const last = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.ok(last.seq > first.seq);
  assert.equal(last.seq - first.seq, 11);
  assert.equal(last.track, 'a.wav');
  assert.equal(last.seek, 9);
  assert.equal(last.action, 'pause');
  assert.deepEqual(fs.readdirSync(dir), ['monitor_control.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});
