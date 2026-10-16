import assert from 'node:assert/strict';
import test from 'node:test';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
};
const { finishSavedBuild, onBuildSaved } = await import('./Yue2Build');
const saved = () => JSON.parse(store.get('cover-studio-buildSessionId') ?? '""');

test('a Save finishing after the studio was rebuilt clears its build and tells the mounted studio', () => {
  store.set('cover-studio-buildSessionId', '"a"');
  const seen: string[] = [];
  const off = onBuildSaved(id => seen.push(id));
  assert.equal(finishSavedBuild('a'), true);
  assert.equal(saved(), '');
  assert.deepEqual(seen, ['a']);
  off();
});

test('a Save finishing after a newer build began leaves the newer build', () => {
  store.set('cover-studio-buildSessionId', '"b"');
  const seen: string[] = [];
  const off = onBuildSaved(id => seen.push(id));
  assert.equal(finishSavedBuild('a'), false);
  assert.equal(saved(), 'b');
  assert.deepEqual(seen, []);
  off();
});
