#!/usr/bin/env node
// Headless engine smoke test: renders a short fixed-seed clip with ace-synth
// --check (no UI, no server) and fails unless the raw output is finite,
// audible, free of DC offset and not clipping. See engine-dev-loop skill.
//
//   node tools/engine-smoke.mjs [--models <dir>] [--dit <file.gguf>] [--self-test]
//
// --self-test renders 5 tracks, corrupts 4 of them inside ace-synth
// (HOTSTEP_CHECK_INJECT) and passes only if each check catches its fault.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const selfTest = args.includes('--self-test');

const exe = ['engine/build/Release/ace-synth.exe', 'engine/build/ace-synth.exe', 'engine/build/ace-synth', 'engine/ace-synth.exe', 'engine/ace-synth']
  .map((p) => join(root, p)).find(existsSync);
if (!exe) { console.error('engine-smoke: no ace-synth binary under engine/build; build the engine first'); process.exit(1); }

let models = opt('--models');
if (!models) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/data-paths.ts'], { cwd: join(root, 'server'), encoding: 'utf8' });
  try { models = JSON.parse(r.stdout).children.models; } catch { /* reported below */ }
  if (!models) { console.error('engine-smoke: could not resolve the models folder; pass --models <dir>\n' + (r.stderr || '')); process.exit(1); }
}

const outDir = join(root, 'logs', 'engine-smoke');
mkdirSync(outDir, { recursive: true });
const request = join(outDir, 'smoke.json');
const tracks = selfTest ? 5 : 1;
writeFileSync(request, JSON.stringify({
  caption: 'upbeat electronic pop, synth bass, drums, bright lead',
  lyrics: '[Instrumental]',
  duration: 10,
  bpm: 120,
  seed: 42,
  inference_steps: 8,
  synth_batch_size: tracks,
  synth_model: opt('--dit') ?? 'acestep-v15-turbo-BF16.gguf',
  output_format: 'wav16',
}, null, 2));

const env = { ...process.env };
if (selfTest) env.HOTSTEP_CHECK_INJECT = 'none,nan,silence,dc,clip';
console.log(`engine-smoke: ${exe}\n  models  ${models}\n  request ${request}`);
const t0 = Date.now();
const r = spawnSync(exe, ['--models', models, '--request', request, '--check'], { env, encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 256 << 20 });
const secs = ((Date.now() - t0) / 1000).toFixed(1);
const log = (r.stdout ?? '') + (r.stderr ?? '');
writeFileSync(join(outDir, 'ace-synth.log'), log);
const lines = log.split(/\r?\n/).filter((l) => l.startsWith('[Check Batch'));
lines.forEach((l) => console.log('  ' + l));
console.log(`  exit ${r.status ?? r.error?.message} after ${secs}s; full log logs/engine-smoke/ace-synth.log`);

let ok;
if (selfTest) {
  const want = ['PASS', 'nonfinite=1 [FAIL]', '[FAIL silence]', '[FAIL dc]', '[FAIL clip]'];
  const verdicts = want.map((w, b) => lines.some((l) => l.startsWith(`[Check Batch${b}]`) && l.includes(w)));
  verdicts.forEach((v, b) => console.log(`  self-test track ${b} (${['clean', 'nan', 'silence', 'dc', 'clip'][b]}): ${v ? 'caught' : 'MISSED'}`));
  ok = r.status === 2 && verdicts.every(Boolean);
} else {
  ok = r.status === 0 && lines.length === 1 && lines[0].includes(' PASS ');
}
if (!ok && !lines.length) console.error(log.split(/\r?\n/).slice(-25).join('\n'));
console.log(ok ? 'ENGINE SMOKE: PASS' : 'ENGINE SMOKE: FAIL');
process.exit(ok ? 0 : 1);
