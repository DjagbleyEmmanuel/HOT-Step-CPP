#!/usr/bin/env node
// HeartMuLa quant ladder: builds the global and local LM files at every level from the
// F16 pair, each with its own importance matrix, and scores them against the F16 pair.
//
//   node tools/heartmula-quant-ladder.mjs build --models <dir> --variant <3B|3B-rl|...>
//        --imatrix <dir> [--quantize <exe>] [--levels Q8_0,Q4_K_M,...] [--parts global,local]
//   node tools/heartmula-quant-ladder.mjs eval  --models <dir> --variant <V> --ref-dir <dir>
//        [--exe <heartmula-quant>] [--levels ...] [--out report.json]
//
// build: <dir>/heartmula/heartmula-<v>-<part>-<LEVEL>.gguf from heartmula-<v>-<part>-F16.gguf,
//   imatrix <imatrix>/heartmula-<v>-<part>.imatrix.gguf (collect it with heartmula-quant
//   --mode collect). Existing outputs are kept. Every rung uses the imatrix: the engine
//   reads the level from the last dash segment of the name, so there is no -imat twin.
//   The metadata keys quantize.imatrix / quantize.imatrix_file record it.
//   Writes heartmula-<v>-quant-manifest.json next to the files (level, bytes, seconds).
// eval: runs heartmula-quant --mode eval for each level on the held-out prompts, scoring
//   the quantized part alone (other part F16) and both together, against the --ref-dir
//   tracks written by --mode ref on the F16 pair. Prints one JSON line per run.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, ...rest] = process.argv.slice(2);
const opt = (name, dflt) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : dflt; };

// The existing ladder (engine/quantize.sh), minus the F16 source.
const ALL = ['Q8_0', 'Q6_K', 'Q5_K_M', 'Q5_K_S', 'Q4_K_M', 'Q4_K_S', 'Q3_K_L', 'Q3_K_M', 'Q3_K_S', 'Q2_K',
  'IQ4_XS', 'IQ3_XXS', 'IQ2_XS', 'IQ2_XXS', 'IQ1_M', 'IQ1_S', 'MXFP4', 'NVFP4'];
const levels = (opt('--levels') ?? ALL.join(',')).split(',');
const parts = (opt('--parts') ?? 'global,local').split(',');
const models = opt('--models');
const variant = opt('--variant');
if (!['build', 'eval'].includes(cmd) || !models || !variant) {
  console.error(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 20).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(2);
}
const dir = existsSync(join(models, 'heartmula')) ? join(models, 'heartmula') : models;
const v = variant.toLowerCase();
const name = (part, level) => join(dir, `heartmula-${v}-${part}-${level}.gguf`);
const sha = (p) => new Promise((ok, no) => {
  const h = createHash('sha256');
  createReadStream(p).on('data', (d) => h.update(d)).on('error', no).on('end', () => ok(h.digest('hex')));
});
const mb = (p) => (statSync(p).size / 1048576).toFixed(1);

if (cmd === 'build') {
  const imdir = opt('--imatrix');
  const exe = opt('--quantize') ?? ['engine/build/Release/quantize.exe', 'engine/build/quantize'].map((p) => join(root, p)).find(existsSync);
  if (!imdir || !exe) { console.error('build needs --imatrix <dir> and a quantize binary (--quantize)'); process.exit(2); }
  const manifest = { variant, quantize: exe, rungs: [] };
  for (const part of parts) {
    const src = name(part, 'F16');
    const im = join(imdir, `heartmula-${v}-${part}.imatrix.gguf`);
    for (const f of [src, im]) if (!existsSync(f)) { console.error(`missing ${f}`); process.exit(1); }
    // quantize does not write the heartmula.quant.* hashes yet, so the manifest carries them.
    const source_sha256 = await sha(src), imatrix_sha256 = await sha(im);
    manifest.rungs.push({ part, level: 'F16', bytes: statSync(src).size, source_sha256 });
    for (const level of levels) {
      const out = name(part, level);
      if (!existsSync(out)) {
        const t0 = Date.now();
        const r = spawnSync(exe, [src, `${out}.partial`, level, '--imatrix', im], { stdio: ['ignore', 'ignore', 'inherit'] });
        if (r.status !== 0) { console.error(`FAILED ${part} ${level} (exit ${r.status})`); process.exit(1); }
        renameSync(`${out}.partial`, out);
        console.log(`${part} ${level}: ${mb(out)} MB in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      } else console.log(`${part} ${level}: kept ${mb(out)} MB`);
      manifest.rungs.push({ part, level, bytes: statSync(out).size, imatrix: im, imatrix_sha256 });
    }
  }
  writeFileSync(join(dir, `heartmula-${v}-quant-manifest.json`), JSON.stringify(manifest, null, 1));
} else {
  const exe = opt('--exe') ?? ['engine/build/Release/heartmula-quant.exe', 'engine/build/heartmula-quant'].map((p) => join(root, p)).find(existsSync);
  const refDir = opt('--ref-dir');
  const prompts = opt('--prompts') ?? join(root, 'engine/tools/heartmula-quant-prompts.json');
  if (!exe || !refDir) { console.error('eval needs --ref-dir and a heartmula-quant binary (--exe)'); process.exit(2); }
  const rows = [];
  for (const level of levels) {
    for (const [g, l] of [[level, 'F16'], ['F16', level], [level, level]]) {
      const r = spawnSync(exe, ['--mode', 'eval', '--models', models, '--prompts', prompts, '--set', 'heldout', '--variant', variant,
        '--global', g, '--local', l, '--ref-dir', refDir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
      if (r.status !== 0) { rows.push({ global: g, local: l, error: `exit ${r.status}` }); console.log(JSON.stringify(rows.at(-1))); continue; }
      rows.push(JSON.parse(r.stdout.trim().split('\n').at(-1)));
      console.log(JSON.stringify(rows.at(-1)));
    }
  }
  if (opt('--out')) writeFileSync(opt('--out'), JSON.stringify(rows, null, 1));
}
