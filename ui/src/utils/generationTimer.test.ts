// generationTimer.test.ts — the queue-aware timer and the settings it reads.
//   (cd server && node --import tsx --test ../ui/src/utils/generationTimer.test.ts)
//
// The clock itself is covered by the poll loops that use it; what matters here
// is which limit it enforces. A saved value the reader did not recognise used
// to fall back to the 30-minute default silently, so every job ended at 30
// minutes however Settings was set.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_GENERATION_TIMEOUT_MINUTES, createGenerationTimer, getGenerationTimeoutMinutes,
} from './generationTimer';

function withSettings(value: unknown, run: () => void): void {
  const store = new Map<string, string>();
  if (value !== undefined) store.set('ace-settings', JSON.stringify({ generationTimeoutMinutes: value }));
  const globals = globalThis as { localStorage?: unknown };
  const previous = globals.localStorage;
  globals.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: () => {} };
  try { run(); } finally { globals.localStorage = previous; }
}

test('the saved number is used as-is', () => {
  withSettings(90, () => assert.equal(getGenerationTimeoutMinutes(), 90));
});

test('a numeric string is read, not treated as unset', () => {
  withSettings('120', () => assert.equal(getGenerationTimeoutMinutes(), 120));
});

test('an out-of-range value is clamped to the offered range, not dropped', () => {
  withSettings(2, () => assert.equal(getGenerationTimeoutMinutes(), 10));
  withSettings(10_000, () => assert.equal(getGenerationTimeoutMinutes(), 360));
});

test('missing or unusable settings fall back to the default', () => {
  withSettings(undefined, () => assert.equal(getGenerationTimeoutMinutes(), DEFAULT_GENERATION_TIMEOUT_MINUTES));
  withSettings('sixty', () => assert.equal(getGenerationTimeoutMinutes(), DEFAULT_GENERATION_TIMEOUT_MINUTES));
});

test('the timer reports the limit it enforces', () => {
  const timer = createGenerationTimer({ timeoutMinutes: 45 });
  assert.equal(timer.timeoutMinutes, 45);
  // A settled job is started, and the clock is measured from that first status.
  assert.equal(timer.tick('pending').started, false);
  assert.equal(timer.tick('generating').started, true);
});

test('queue wait does not count against the limit', () => {
  let now = 0;
  const timer = createGenerationTimer({ timeoutMinutes: 10, now: () => now });
  now = 60 * 60_000;              // an hour in the queue
  assert.deepEqual(timer.tick('pending'), { started: false, elapsed: 0, timedOut: false });
  assert.equal(timer.tick('generating').elapsed, 0);
  now += 11 * 60_000;
  assert.equal(timer.tick('generating').timedOut, true);
});
