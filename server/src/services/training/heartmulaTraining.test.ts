import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(process.cwd(), '.test-heartmula-train-'));
process.env.TRAINING_DIR = path.join(root, 'training');
process.env.DATA_DIR = path.join(root, 'library');
const { config } = await import('../../config.js');
config.aceServer.adapters = path.join(root, 'adapters');
config.aceServer.models = path.join(root, 'models');
const train = await import('./heartmulaTrain.js');
const runs = await import('./heartmulaRuns.js');
const prep = await import('./heartmulaPrepare.js');
const { HEARTMULA_RECIPE_DEFAULTS } = await import('../../contracts/heartmulaTraining.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));

const ds = { id: 'ds1', slug: 'demo', customTag: 'trig' };

test('recipe: defaults are the proven recipe, bad values and unknown keys throw', () => {
  assert.equal(HEARTMULA_RECIPE_DEFAULTS.gradAccum, 4);
  assert.deepEqual(train.resolveHeartmulaRecipe({}), HEARTMULA_RECIPE_DEFAULTS);
  assert.equal(train.resolveHeartmulaRecipe({ steps: 50, learningRate: 2e-4 }).steps, 50);
  assert.throws(() => train.resolveHeartmulaRecipe({ steps: 0 }), /steps/);
  assert.throws(() => train.resolveHeartmulaRecipe({ rank: 1.5 }), /rank/);
  assert.throws(() => train.resolveHeartmulaRecipe({ learningRate: -1 }), /learningRate/);
  assert.throws(() => train.resolveHeartmulaRecipe({ nope: 1 }), /Unsupported/);
});

test('argv matches the trainer CLI contract', () => {
  const args = train.buildHeartmulaTrainArgs({
    dataDir: 'D', runDir: 'R', modelsDir: 'M', recipe: HEARTMULA_RECIPE_DEFAULTS, name: 'a', resume: true,
  });
  assert.deepEqual(args.slice(0, 7), ['heartmula-train', '--data', 'D', '--out', 'R', '--models', 'M']);
  assert.ok(args.join(' ').includes('--grad-accum 4 --seed 0 --save-every 100 --name a --resume'));
  const prepare = train.buildHeartmulaPrepareArgs({ samplesJson: 'S', outDir: 'O', modelsDir: 'M', encoderDir: 'E', force: true });
  assert.deepEqual(prepare, ['heartmula-prepare', '--dataset', 'S', '--out', 'O', '--models', 'M', '--encoder', 'E', '--force']);
});

test('models and encoder pack are found under the models folder only', () => {
  const models = config.aceServer.models;
  assert.equal(train.missingHeartmulaModels(models).length, 4);
  assert.equal(train.findHeartmulaEncoderDir(models), null);
  const dir = path.join(models, 'heartmula');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['heartmula-3b-global-F16', 'heartmula-3b-local-F16', 'heartmula-tokenizer', 'heartcodec-rvq-F32']) {
    fs.writeFileSync(path.join(dir, `${f}.gguf`), 'x');
  }
  assert.deepEqual(train.missingHeartmulaModels(models), []);
  assert.equal(train.findHeartmulaEncoderDir(models), null);
  for (const r of ['muencoder', 'wavlm', 'whisper', 'query']) fs.writeFileSync(path.join(dir, `heartcodec-${r}-F16.gguf`), 'x');
  assert.equal(train.findHeartmulaEncoderDir(models), dir);
});

test('runs: new run, resume rules, foreign dataset refused', () => {
  const first = runs.resolveHeartmulaRun(ds, { recipe: { steps: 20 } });
  assert.equal(first.resume, false);
  assert.match(first.id, runs.HEARTMULA_RUN_ID);
  assert.equal(first.record.recipe.steps, 20);
  assert.throws(() => runs.resolveHeartmulaRun(ds, { resumeRun: first.id }), /no checkpoint/);
  fs.writeFileSync(path.join(first.dir, 'hm_train_state.bin'), 'x');
  assert.throws(() => runs.resolveHeartmulaRun(ds, { resumeRun: first.id, recipe: { steps: 30 } }), /cannot change steps/);
  const again = runs.resolveHeartmulaRun(ds, { resumeRun: first.id, recipe: { steps: 20 } });
  assert.equal(again.resume, true);
  assert.equal(again.dir, first.dir);
  assert.throws(() => runs.resolveHeartmulaRun({ id: 'other', slug: 'demo' }, { resumeRun: first.id }), /another dataset/);
  assert.throws(() => runs.resolveHeartmulaRun(ds, { resumeRun: '../../x/1' }), /Invalid/);
  assert.throws(() => runs.resolveHeartmulaRun(ds, { adapterName: '../x' }), /adapterName/);
  assert.throws(() => runs.resolveHeartmulaRun(ds, { bogus: 1 }), /Unsupported/);
  assert.equal(runs.listHeartmulaRuns(ds.id, ds.slug).length, 1);
});

test('status: a stored live state with no job behind it reads as failed and resumable', () => {
  const run = runs.listHeartmulaRuns(ds.id, ds.slug)[0];
  runs.writeStoredStatus(run.dir, { ...runs.blankStatus(20), state: 'running', step: 7 });
  assert.equal(runs.heartmulaRunStatus(run, true).state, 'running');
  const orphan = runs.heartmulaRunStatus(run, false);
  assert.equal(orphan.state, 'failed');
  assert.equal(orphan.step, 7);
});

test('publish copies a valid GGUF once and never overwrites', () => {
  const run = runs.listHeartmulaRuns(ds.id, ds.slug)[0];
  const file = runs.heartmulaAdapterFile(run.dir, 20);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = Buffer.alloc(24);
  header.write('GGUF'); header.writeUInt32LE(3, 4); header.writeBigUInt64LE(2n, 8);
  fs.writeFileSync(file, header);
  assert.deepEqual(runs.heartmulaCheckpointSteps(run.dir), [20]);
  assert.equal(runs.publishHeartmulaAdapter(file, 'demo-1'), 'demo-1.gguf');
  assert.equal(runs.publishHeartmulaAdapter(file, 'demo-1'), 'demo-1-2.gguf');
  fs.writeFileSync(file, 'nope');
  assert.throws(() => runs.publishHeartmulaAdapter(file, 'demo-2'), /invalid adapter/);
  runs.saveHeartmulaRunRecord(run.dir, { ...run.record, published: 'demo-1.gguf' });
  assert.equal(runs.latestHeartmulaAdapter(ds.id, ds.slug)?.name, 'demo-1');
});

test('prepare status: stale when audio or text changed, valid otherwise', () => {
  const audio = path.join(root, 'a.wav');
  fs.writeFileSync(audio, 'abcd');
  const st = fs.statSync(audio);
  const sample = {
    sampleId: 's1', audioPath: audio, caption: 'rock', genre: 'Rock', lyrics: 'la la', isInstrumental: false,
    customTag: '', excluded: false, fileMissing: false,
  } as never;
  const input = prep.heartmulaSampleInput(ds as never, sample);
  assert.equal(input.tags, 'trig, rock');
  const dir = path.join(root, 'training', 'datasets', 'demo', 'heartmula', 'prepare');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    version: 1, created_at: 'now', context_limit: 8192, skipped: [{ id: 'x', reason: 'over-context', detail: 'long' }],
    samples: [{ id: 's1', audio, audio_bytes: st.size, audio_mtime_s: Math.floor(st.mtimeMs / 1000), tags: input.tags, lyrics: input.lyrics }],
  };
  fs.writeFileSync(path.join(dir, 'heartmula_prepare.json'), JSON.stringify(manifest));
  const ok = prep.heartmulaPrepareStatus(ds as never, [sample]);
  assert.equal(ok.cacheValid, true);
  assert.equal(ok.preparedSamples, 1);
  assert.equal(ok.skipped[0].reason, 'over-context');
  assert.equal(prep.heartmulaPrepareStatus(ds as never, [{ ...(sample as object), lyrics: 'changed' } as never]).staleSamples, 1);
  const added = prep.heartmulaPrepareStatus(ds as never, [sample, { ...(sample as object), sampleId: 's2' } as never]);
  assert.equal(added.cacheValid, false);
  assert.equal(added.staleSamples, 1);
});
