import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { HEARTMULA_PREVIEW_DEFAULTS, HEARTMULA_RECIPE_DEFAULTS, type HeartmulaStatusResponse } from '../../../../server/src/contracts/heartmulaTraining';

register('data:text/javascript,' + encodeURIComponent(
  'export async function load(url, ctx, next) { if (url.endsWith(".css")) return { format: "module", source: "export default {}", shortCircuit: true }; return next(url, ctx); }'));
Object.assign(globalThis, { React: await import('react'), localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const { HeartmulaTrainCard } = await import('./HeartmulaTrainCard');
const { HeartmulaPrepareCard } = await import('./HeartmulaPrepareCard');
const { useTrainingStore } = await import('../../stores/trainingStore');
await i18n.use(initReactI18next).init({ lng: 'en', resources: {}, interpolation: { escapeValue: false } });

const status: HeartmulaStatusResponse = {
  ready: { available: true, backend: 'cuda', missingModels: [], deviceProblem: null, encoderMissing: false, encoderHelp: null },
  prepare: { cacheValid: true, cacheVersion: 1, preparedSamples: 4, staleSamples: 0, skipped: [], contextLimit: 8192, preparedAt: null },
  base: '3B', runs: [], run: null, adapter: null, defaults: HEARTMULA_RECIPE_DEFAULTS, previewDefaults: HEARTMULA_PREVIEW_DEFAULTS,
};

test('HeartMuLa recipe and start stay visible, with only optional settings folded', () => {
  const { document } = parseHTML(renderToStaticMarkup(createElement(HeartmulaTrainCard, {
    status, slug: 'example', busy: false, trainStarted: false, onTrain() {}, onCheckpoint() {}, onCancel() {},
  })));
  const fields = [...document.querySelectorAll('input')];
  assert.equal(fields.filter(field => !field.closest('details')).length, 7);
  assert.equal(fields.filter(field => field.closest('details')).length, 3);
  const start = [...document.querySelectorAll('button')].find(button => button.textContent.includes('Start training'))!;
  assert.ok(start);
  assert.equal(start.closest('details'), null);
  assert.equal(start.hasAttribute('disabled'), false);
});

test('HeartMuLa Prepare shows live per-track progress outside the settings fold and rejects another dataset job', () => {
  const initial = useTrainingStore.getInitialState();
  const saved = { ...initial };
  try {
    Object.assign(initial, {
      activeJob: { id: 'prepare', kind: 'heartmula-prepare', datasetId: 'one', status: 'running', phase: 'encode',
        done: 2, total: 4, failed: 0, currentSampleId: 'track-three.wav', engineQueueDepth: 0 },
      jobLog: [{ ts: 1, level: 'info', message: 'Encoding track three' }], samplesById: {},
    });
    const render = (datasetId: string) => renderToStaticMarkup(createElement(HeartmulaPrepareCard, {
      datasetId, status: status.prepare, busy: true, preparing: true, onPrepare() {},
    }));
    const html = render('one');
    assert.match(html, /track-three.wav/);
    assert.match(html, /2 \/ 4/);
    assert.match(html, /Encoding track three/);
    const { document } = parseHTML(html);
    const log = [...document.querySelectorAll('div')].find(node => node.textContent === 'Encoding track three')!;
    assert.equal(log.closest('details'), null);
    assert.doesNotMatch(render('two'), /track-three.wav|Encoding track three/);
  } finally { Object.assign(initial, saved); }
});
