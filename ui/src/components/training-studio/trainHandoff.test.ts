// Shell-to-card handoff and submitted requests, per backend, against 863bd20b.
//
// What the shell owns is (a) the props it gives each card and (b) the ACE
// recipe request TrainPanel submits itself. Both are captured here: (a) by
// asking each plug-in for its Train page and reading the element it returns,
// (b) by running the real resolveTrainingRecipe against a recording fetch.
// YuE2 and MM3 build their requests inside their own cards, so for those the
// proof is that every file on the request path is byte-identical to the
// baseline commit, plus (a): same inputs, same code, same request.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { register } from 'node:module';
import { test } from 'node:test';
import type { ReactElement } from 'react';

const BASELINE = '863bd20b';
// The last P1 commit: later slices may change these files on purpose, so the proof ends here.
const P1_END = 'a130eeff';

// The cards import CSS, which the node loader cannot. Stub it for this file.
register('data:text/javascript,' + encodeURIComponent(
  'export async function load(url, ctx, next) { if (url.endsWith(".css")) return { format: "module", source: "export default {}", shortCircuit: true }; return next(url, ctx); }'));
const mem = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) },
});

// tsx compiles JSX with the classic runtime; Vite uses the automatic one.
Object.assign(globalThis, { React: await import('react') });

const { TRAINING_PLUGINS } = await import('./trainingPlugins');
const { Mm3TrainCard } = await import('./Mm3TrainCard');
const { Sa3TrainCard } = await import('./Sa3TrainCard');
const { Yue2TrainStages } = await import('./Yue2TrainStages');
const { Yue2OptimisePanel } = await import('./Yue2OptimisePanel');
const { TRAIN_LM_DEFAULTS } = await import('./TrainLmForm');
const { TRAIN_DIT_LOKR_DEFAULTS } = await import('./TrainDitForm');
const { aceDitRecipeInput, aceLmRecipeInput } = await import('./trainGates');
const { resolveTrainingRecipe } = await import('../../services/trainingRecipesApi');

const ctx = (section: 'prepare' | 'optimise' | 'train') => ({ datasetId: 'ds-1', slug: 'my-set', trigger: 'tag', section });
const el = (n: unknown) => n as ReactElement<Record<string, unknown>>;

// ── (a) props handed to each card ──
test('MM3 gets <Mm3TrainCard datasetId trigger>', () => {
  const e = el(TRAINING_PLUGINS['minimax-m3'].renderTrain!(ctx('train')));
  assert.equal(e.type, Mm3TrainCard);
  assert.deepEqual(e.props, { datasetId: 'ds-1', trigger: 'tag' });
});

test('YuE2 gets <Yue2TrainStages datasetId trigger section> and <Yue2OptimisePanel datasetId>', () => {
  const p = TRAINING_PLUGINS.yue2;
  const train = el(p.renderTrain!(ctx('train')));
  assert.equal(train.type, Yue2TrainStages);
  assert.deepEqual(train.props, { datasetId: 'ds-1', trigger: 'tag', section: 'train' });
  const prepare = el(p.renderPrepare!(ctx('prepare')));
  assert.equal(prepare.type, Yue2TrainStages);
  assert.deepEqual(prepare.props, { datasetId: 'ds-1', trigger: 'tag', section: 'prepare' });
  const optimise = el(p.renderOptimise!(ctx('optimise')));
  assert.equal(optimise.type, Yue2OptimisePanel);
  assert.deepEqual(optimise.props, { datasetId: 'ds-1' });
});

test('SA3 gets <Sa3TrainCard datasetId slug>; ACE renders from TrainPanel itself', () => {
  const e = el(TRAINING_PLUGINS.sa3.renderTrain!(ctx('train')));
  assert.equal(e.type, Sa3TrainCard);
  assert.deepEqual(e.props, { datasetId: 'ds-1', slug: 'my-set' });
  assert.equal(TRAINING_PLUGINS.ace.renderTrain, undefined);
});

// ── (b) the ACE requests TrainPanel submits ──
interface Sent { family: string; overrides: Record<string, unknown>; preset?: string }

async function capture(call: () => Promise<unknown>): Promise<Sent> {
  const sent: Sent[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    sent.push(body.payload ?? body);
    return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try { await call().catch(() => undefined); } finally { globalThis.fetch = realFetch; }
  assert.equal(sent.length, 1, 'exactly one recipe request');
  return sent[0];
}

// The pre-shell handleStart / handleStartDit spread, verbatim.
const legacy = (form: Record<string, unknown>, variantKey?: string) => ({ ...form, ...(variantKey ? { variantKey } : {}) });

test('ACE LM: the submitted recipe request equals the pre-shell one', async () => {
  for (const variantKey of ['v1', '', undefined]) {
    const form = { ...TRAIN_LM_DEFAULTS, adapterName: 'my-set' } as Record<string, unknown>;
    const now = await capture(() => resolveTrainingRecipe('ace-lm', aceLmRecipeInput(form, variantKey)));
    const before = await capture(() => resolveTrainingRecipe('ace-lm', legacy(form, variantKey)));
    assert.deepEqual(now, before);
    assert.equal(now.family, 'ace-lm');
    assert.deepEqual(now.overrides, legacy(form, variantKey));
  }
});

test('ACE DiT: the submitted recipe request equals the pre-shell one, preset included', async () => {
  const form = { ...TRAIN_DIT_LOKR_DEFAULTS, adapterName: 'my-set' } as Record<string, unknown>;
  const preset = String(form.adapterType);
  const now = await capture(() => resolveTrainingRecipe('ace-dit', aceDitRecipeInput(form, 'v2'), preset));
  const before = await capture(() => resolveTrainingRecipe('ace-dit', legacy(form, 'v2'), preset));
  assert.deepEqual(now, before);
  assert.equal(now.family, 'ace-dit');
  assert.equal(now.preset, preset);
});

// ── YuE2 and MM3 requests: the code that builds them is the baseline's ──
const REQUEST_PATH = [
  'Mm3TrainCard.tsx', 'Mm3CodesCard.tsx', 'Yue2TrainCard.tsx', 'Yue2ArTrainCard.tsx', 'Yue2AitkTrainCard.tsx',
  'Yue2TrainStages.tsx', 'Yue2OptimisePanel.tsx', 'Yue2OptimizerFields.tsx', 'Sa3TrainCard.tsx', 'TrainLmForm.tsx',
  'TrainDitForm.tsx', 'yue2JointCommand.ts', 'yue2JointPresets.ts',
].map(f => `ui/src/components/training-studio/${f}`).concat([
  'ui/src/services/trainingRecipesApi.ts', 'ui/src/services/trainingOperations.ts', 'ui/src/services/trainingApi.ts',
  'server/src/contracts/trainingRecipes.ts',
]);

let root = '';
try {
  root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  for (const c of [BASELINE, P1_END]) execFileSync('git', ['cat-file', '-e', `${c}^{commit}`], { cwd: root, stdio: 'ignore' });
} catch { root = ''; }

test('YuE2 / MM3 request builders are byte-identical from the baseline through P1', { skip: !root && 'baseline or P1 commit not in this clone' }, () => {
  for (const f of REQUEST_PATH) {
    const changed = execFileSync('git', ['diff', '--name-only', BASELINE, P1_END, '--', f], { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(changed, '', `${f} differs between ${BASELINE} and ${P1_END}`);
  }
});
