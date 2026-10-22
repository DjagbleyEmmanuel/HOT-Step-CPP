import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';

// Import the queue only after isolating its startup recovery and persistence.
const root = fs.mkdtempSync(path.join(process.cwd(), '.test-sa3-runner-'));
process.env.TRAINING_DIR = path.join(root, 'training');
process.env.DATA_DIR = path.join(root, 'library');
const { config } = await import('../../config.js');
config.aceServer.adapters = path.join(root, 'adapters');
config.aceServer.models = path.join(root, 'models');
config.aceServer.exe = path.join(root, 'bin', process.platform === 'win32' ? 'ace-server.exe' : 'ace-server');
fs.mkdirSync(path.dirname(config.aceServer.exe), { recursive: true });
fs.writeFileSync(config.aceServer.exe, 'mock');
const trainExe = path.join(path.dirname(config.aceServer.exe), process.platform === 'win32' ? 'ace-train.exe' : 'ace-train');
fs.writeFileSync(trainExe, 'mock');
for (const file of ['sa3-dit-base-BF16.gguf', 'sa3-dit-BF16.gguf', 'sa3-same-enc-F16.gguf', 'sa3-text-enc-BF16.gguf',
  'onnx/sa3/tokenizer.json', 'onnx/sa3/tokenizer_config.json', 'supersep/bs_leap_xe_voc-F32.gguf', 'supersep/bs_leap_xe_inst-F32.gguf']) {
  const full = path.join(config.aceServer.models, file);
  fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, 'mock');
}
const layout = await import('./adapterLayout.js');
const cli = await import('./aceTrain.js');
const runner = await import('./trainSa3Runner.js');
const queue = await import('./labelingQueue.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));
const hash = 'a'.repeat(64), identity = `stabilityai/stable-audio-3-medium sha256:${hash}`;

function gguf(file: string, base = identity) {
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
  const kv = (k: string, v: string) => Buffer.concat([str(k), u32(8), str(v)]);
  const tensor = (name: string, dims: number[], off: number) => Buffer.concat([str(`model.preprocess_conv.weight.${name}`),
    u32(dims.length), ...dims.map(u64), u32(0), u64(off)]);
  const header = Buffer.concat([Buffer.from('GGUF'), u32(3), u64(3), u64(3),
    kv('general.architecture', 'sa3-adapter'), kv('sa3.adapter_format', 'dora-rows-v1'), kv('sa3.inference_base_id', base),
    tensor('lora_a', [2, 1], 0), tensor('lora_b', [1, 2], 32), tensor('row_scale', [2], 64)]);
  const data = Buffer.alloc(72); data.writeFloatLE(1, 64); data.writeFloatLE(1, 68);
  fs.writeFileSync(file, Buffer.concat([header, Buffer.alloc((32 - header.length % 32) % 32), data]));
}

function fixture(name: string) {
  const run = runner.resolveSa3Run(`dataset-${name}`, name, { adapterName: 'adapter', steps: 2 });
  const job = queue.createJob('sa3-train', run.datasetId, [], run);
  fs.writeFileSync(run.manifest, '{"samples":[]}');
  const result = { done: true, stopped: false, error: '', baseSha256: hash, inferenceSha256: hash };
  const artifacts = () => {
    gguf(path.join(run.runDir, 'adapter.gguf'));
    for (const file of ['state.gguf', 'adapter-raw.gguf']) gguf(path.join(run.runDir, file));
  };
  return { job, run, result, artifacts };
}

test('SA3 options reject invalid values and unsupported backends before reserving runs', () => {
  for (const input of [{ steps: 0 }, { seed: -1 }, { rank: 1.5 }, { duration: Infinity }, { duration: 385 },
    { learningRate: '0.1' }, { checkpointEvery: 0 }]) assert.throws(() => cli.resolveSa3Recipe(input));
  assert.throws(() => runner.resolveSa3Run('dataset', 'invalid', { trainSeconds: true }), /Unsupported/);
  assert.throws(() => runner.resolveSa3Run('dataset', 'invalid', { adapterName: '../escape' }), /adapterName/);
  assert.equal(runner.sa3Readiness(config.aceServer.models, 'metal').available, false);
  assert.equal(runner.sa3Readiness(config.aceServer.models, 'vulkan').available, false);
  assert.equal(runner.sa3Readiness(config.aceServer.models, 'cpu').available, true);
  const a = runner.resolveSa3Run('dataset', 'versioned', {}), b = runner.resolveSa3Run('dataset', 'versioned', {});
  assert.notEqual(a.runDir, b.runDir);
  const args = cli.buildSa3TrainArgs(a);
  assert.equal(args[0], 'sa3-train'); assert.equal(args.includes('--train-seconds'), false);
  assert.equal(args.includes('--resume'), false);
});

test('SA3 publication validates finite tensors/provenance, hides partials and never overwrites', () => {
  const file = path.join(root, 'export.gguf'); gguf(file);
  assert.equal(layout.validateSa3Export(file, identity), identity);
  const name = layout.publishSa3Export(file, 'unit', identity);
  const second = layout.publishSa3Export(file, 'unit', identity);
  assert.equal(name, 'unit'); assert.equal(second, 'unit-2');
  const catalogue = path.join(config.aceServer.models, 'sa3-adapters');
  fs.writeFileSync(path.join(catalogue, '.incomplete.part'), 'partial');
  assert.deepEqual(layout.listSa3Adapters().map(a => a.name), ['unit', 'unit-2']);
  assert.throws(() => layout.publishSa3Export(file, 'bad-base', identity.replace(hash, 'b'.repeat(64))), /provenance/);
  const data = fs.readFileSync(file); data.writeFloatLE(NaN, data.length - 4); fs.writeFileSync(file, data);
  assert.throws(() => layout.publishSa3Export(file, 'bad', identity), /Non-finite/);
  fs.writeFileSync(file, data.subarray(0, -8));
  assert.throws(() => layout.validateSa3Export(file), /Truncated/);
  assert.deepEqual(layout.listSa3Adapters().map(a => a.name), ['unit', 'unit-2']);
});

test('SA3 success publishes, persists provenance and waits for engine restart', async () => {
  const f = fixture('success'); let restarted = false;
  await runner.runSa3TrainJob(f.job, { prepare: async () => {}, stop: async () => true,
    execute: async () => { f.artifacts(); return f.result; }, restart: async () => { restarted = true; return true; } });
  assert.equal(restarted, true); assert.equal(f.job.status, 'done');
  assert.equal(f.job.cleanupPending, false);
  assert.ok(layout.listSa3Adapters().some(a => a.name === f.run.published));
  const runs = runner.listSa3Runs(f.run.datasetId, 'success');
  assert.equal(runs[0].inferenceSha256, hash); assert.equal(runs[0].resumable, true);
  assert.equal(runs[0].published, f.run.published);
  const resumed = runner.resolveSa3Run(f.run.datasetId, 'success', { resumeRun: runs[0].run, steps: 4 });
  assert.equal(resumed.runDir, f.run.runDir); assert.equal(resumed.resume, true);
  assert.ok(cli.buildSa3TrainArgs(resumed).includes('--resume'));
  assert.throws(() => runner.resolveSa3Run(f.run.datasetId, 'success', { resumeRun: runs[0].run, rank: 32 }), /cannot change rank/);
  assert.throws(() => runner.resolveSa3Run('other-dataset', 'success', { resumeRun: runs[0].run }), /another dataset/);
  assert.throws(() => runner.resolveSa3Run(f.run.datasetId, 'success', { resumeRun: '../escape' }), /resumeRun/);
});

test('SA3 failures and malformed success restore the engine without publishing', async () => {
  for (const mode of ['prepare', 'stop', 'spawn', 'missing-done', 'artifact', 'restart']) {
    const f = fixture(`failure-${mode}`); let restarts = 0, publications = 0;
    await runner.runSa3TrainJob(f.job, {
      prepare: async () => { if (mode === 'prepare') throw new Error('prep failed'); },
      stop: async () => { if (mode === 'stop') throw new Error('stop failed'); return true; },
      execute: async () => { if (mode === 'spawn') throw new Error('spawn failed');
        if (mode !== 'artifact') f.artifacts(); return { ...f.result, done: mode !== 'missing-done' }; },
      restart: async () => { restarts++; return mode !== 'restart'; },
      publish: () => { publications++; return 'mock'; },
    });
    assert.equal(f.job.status, 'failed', mode);
    assert.equal(restarts, mode === 'prepare' ? 0 : 1, mode);
    assert.equal(publications, mode === 'restart' ? 1 : 0, mode);
  }
});

test('SA3 cancellation holds dataset admission and GPU queue through restart', async () => {
  const f = fixture('cancel'); let release!: () => void, entered!: () => void, next = false;
  const started = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { release = r; });
  let completed!: () => void;
  const finished = new Promise<void>(r => { completed = r; });
  queue.enqueue(f.job, async job => {
    await runner.runSa3TrainJob(job, { prepare: async () => {}, stop: async () => true,
      execute: async () => { queue.cancelJob(job.id); return { ...f.result, done: false, stopped: true }; },
      restart: async () => { entered(); await gate; return true; } });
    completed();
  });
  const second = queue.createJob('preprocess', 'next-dataset', [], {});
  queue.enqueue(second, async job => { next = true; queue.finishJob(job, 'done'); });
  await started;
  assert.equal(queue.activeJobForDataset(f.run.datasetId)?.id, f.job.id);
  assert.equal(next, false); assert.equal(f.run.published, undefined);
  release(); await finished;
  await new Promise(r => setImmediate(r));
  assert.equal(queue.activeJobForDataset(f.run.datasetId), undefined);
  assert.equal(queue.getJob(f.job.id), undefined);
  assert.equal(next, true); assert.equal(f.job.status, 'cancelled');
});

test('SA3 mocked child relays step metrics and refuses error/partial completion', async () => {
  for (const mode of ['ok', 'error', 'exit', 'spawn']) {
    const f = fixture(`child-${mode}`);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null, signalCode: null });
    const launch = (() => {
      setImmediate(() => {
        if (mode === 'spawn') { child.emit('error', new Error('mock spawn failure')); return; }
        child.stdout.write(JSON.stringify({ type: 'start', backend: 'CPU', trainSeconds: false, baseSha256: hash, inferenceSha256: hash }) + '\n');
        child.stdout.write('{"type":"step","step":1,"loss":0.5,"ms":10}\n');
        child.stdout.write(mode === 'error' ? '{"type":"error","message":"mock trainer failure"}\n' : '{"type":"done"}\n');
        child.stdout.end(); child.emit('close', mode === 'exit' ? 1 : 0);
      });
      return child as unknown as ChildProcess;
    }) as typeof spawn;
    if (mode === 'ok') {
      const result = await runner.executeSa3Train(f.job, f.run, launch);
      assert.equal(result.done, true); assert.equal(f.job.done, 1);
      assert.ok(f.job.events.some(e => e.type === 'metric' && e.metric === 'step' && e.loss === 0.5));
    } else await assert.rejects(runner.executeSa3Train(f.job, f.run, launch), /mock|exited/);
    assert.equal(f.job.child, undefined);
  }
});

test('SA3 real cancellation hook writes STOP and waits for child close', async () => {
  const f = fixture('child-cancel');
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null });
  const running = runner.executeSa3Train(f.job, f.run, (() => child as unknown as ChildProcess) as typeof spawn);
  assert.equal(queue.cancelJob(f.job.id), true);
  assert.equal(fs.readFileSync(path.join(f.run.runDir, 'STOP'), 'utf8'), 'stop\n');
  let finished = false; void running.then(() => { finished = true; });
  await new Promise(r => setImmediate(r)); assert.equal(finished, false);
  child.stdout.end(); child.emit('close', 0); await running;
  assert.equal(f.job.child, undefined); assert.equal(f.job.cancelChild, undefined);
});

test('SA3 HTTP admission, status, cancellation and picker discovery use the shared queue', async t => {
  const { initDb, closeDb } = await import('../../db/database.js');
  assert.ok(config.data.dbPath.startsWith(root + path.sep));
  fs.mkdirSync(config.data.dir, { recursive: true }); initDb();
  t.after(() => closeDb());
  const { insertDataset } = await import('./datasetsRepo.js');
  insertDataset({ id: 'http-dataset', slug: 'http-dataset', name: 'Fixture', sourceDir: root, recursive: false,
    customTag: '', tagPosition: 'prepend', genreRatio: 0, defaultArtist: '', defaultAlbum: '', defaultGenre: '',
    defaultLanguage: '', sampleCount: 1, labeledCount: 1, excludedCount: 0, status: 'labeled', builtAt: '',
    datasetJsonPath: '', albumName: '', createdAt: '', updatedAt: '' });
  const { default: express } = await import('express');
  const { default: trainingRoutes } = await import('../../routes/training.js');
  const { default: modelsRoutes } = await import('../../routes/models.js');
  const app = express(); app.use(express.json()); app.use('/api/training', trainingRoutes); app.use('/api/models', modelsRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  t.after(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const url = `${base}/api/training/datasets/http-dataset/sa3-train`;
  let release!: () => void, started!: () => void, done!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const entered = new Promise<void>(r => { started = r; });
  const finished = new Promise<void>(r => { done = r; });
  queue.overrideTrainingRunner('sa3-train', async job => {
    job.cleanupPending = true; job.status = 'running'; started(); await gate;
    job.cleanupPending = false; queue.finishJob(job, 'done'); done();
  });
  t.after(() => queue.overrideTrainingRunner('sa3-train', null));
  const post = (body: object) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ steps: -1 })).status, 400);
  assert.equal((await fetch(`${base}/api/training/datasets/unknown/sa3-train`)).status, 404);
  const accepted = await post({ steps: 2 }); assert.equal(accepted.status, 202);
  const { jobId } = await accepted.json() as { jobId: string }; await entered;
  assert.equal((await post({ steps: 2 })).status, 409);
  const status = await (await fetch(url)).json() as { activeJob: { id: string }; runs: unknown[] };
  assert.equal(status.activeJob.id, jobId); assert.equal(status.runs.length, 1);
  assert.equal(queue.cancelJob(jobId), true);
  assert.equal((await post({ steps: 2 })).status, 409);
  release(); await finished;
  const picker = await (await fetch(`${base}/api/models/stablestep/adapters`)).json() as { adapters: Array<{ name: string }> };
  assert.ok(picker.adapters.some(a => a.name === 'unit'));
  assert.ok(picker.adapters.every(a => !a.name.includes('.part')));
});
