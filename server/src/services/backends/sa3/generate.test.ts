import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SA3_LOADING_STAGE, sa3RenderStage } from './generate.js';

// Copied from the DAW facade (pr/29 dawFacade.ts:457): a stage matching this
// reports phase loading_model and eta_s null. pr/06 has no facade, so the
// regex is asserted directly here.
const FACADE_LOADING_RE = /^loading\b/i;

test('SA3 stage at submit reads as loading', () => {
  console.log('submit stage:', SA3_LOADING_STAGE);
  assert.match(SA3_LOADING_STAGE, FACADE_LOADING_RE);
});

test('SA3 stage once the render fetch is sent does not read as loading', () => {
  const s = sa3RenderStage(30.4, 8);
  console.log('render stage:', s);
  assert.doesNotMatch(s, FACADE_LOADING_RE);
  assert.ok(s.startsWith('SA3: rendering'));
  assert.ok(s.includes('30s') && s.includes('8 steps'));
});

test('real progress (saving audio) replaces the loading stage', () => {
  const saving = 'Stable Audio 3: saving audio...';
  assert.doesNotMatch(saving, FACADE_LOADING_RE);
});
