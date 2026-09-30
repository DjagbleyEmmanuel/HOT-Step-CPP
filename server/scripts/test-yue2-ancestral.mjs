#!/usr/bin/env node
// A/B determinism test for the md_ancestral_yue2 NAR solver (churn).
// Talks to ace-server directly (default http://127.0.0.1:8085).
// Usage: node server/scripts/test-yue2-ancestral.mjs [--base URL] [--seed N] [--frames N]
// rel diff dB = 20*log10(||a-b|| / ||a||)
import { writeFileSync, mkdirSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('--base', 'http://127.0.0.1:8085');
const SEED = Number(arg('--seed', '1234'));
const FRAMES = Number(arg('--frames', '500')); // 25 frames/s -> 20 s
const OUT = arg('--out', '');

async function render(churn, solver = 'md_ancestral_yue2') {
  const body = {
    style: 'instrumental, lo-fi hip hop, mellow piano, soft drums',
    lyrics: '[instrumental]',
    cot: 'off',
    seed: SEED,
    ode_steps: 16,
    preview_max_frames: FRAMES,
    infer_method: solver,
    plugin_params: { [`${solver}:churn`]: churn },
  };
  const r = await fetch(`${BASE}/yue2/synth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`synth ${r.status}: ${await r.text()}`);
  const { job_id } = await r.json();
  for (;;) {
    await new Promise((res) => setTimeout(res, 1000));
    const s = await (await fetch(`${BASE}/job?id=${job_id}`)).json();
    if (s.status === 'done') break;
    if (s.status === 'failed' || s.status === 'cancelled') throw new Error(`job ${job_id} ${s.status}: ${JSON.stringify(s)}`);
  }
  const res = await fetch(`${BASE}/job?id=${job_id}&result=1`);
  const buf = Buffer.from(await res.arrayBuffer());
  return decodeWav(buf, res.headers.get('content-type'));
}

function decodeWav(buf, ct) {
  const off = buf.indexOf('RIFF');
  if (off < 0) throw new Error(`no RIFF in result (content-type ${ct}, ${buf.length} bytes)`);
  let p = off + 12, fmt = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4), sz = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { tag: buf.readUInt16LE(p + 8), bits: buf.readUInt16LE(p + 22) };
    if (id === 'data') {
      const d = buf.subarray(p + 8, p + 8 + sz);
      if (fmt.tag === 3 && fmt.bits === 32) return new Float32Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.length));
      if (fmt.bits === 16) { const o = new Float32Array(d.length >> 1); for (let i = 0; i < o.length; i++) o[i] = d.readInt16LE(i * 2) / 32768; return o; }
      if (fmt.bits === 32) { const o = new Float32Array(d.length >> 2); for (let i = 0; i < o.length; i++) o[i] = d.readInt32LE(i * 4) / 2147483648; return o; }
      throw new Error(`unsupported wav fmt ${JSON.stringify(fmt)}`);
    }
    p += 8 + sz + (sz & 1);
  }
  throw new Error('no data chunk');
}

function relDb(a, b) {
  const n = Math.min(a.length, b.length);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { const d = a[i] - b[i]; num += d * d; den += a[i] * a[i]; }
  if (num === 0) return -Infinity;
  return 20 * Math.log10(Math.sqrt(num) / Math.sqrt(den));
}

const rows = [];
const check = (name, a, b, pass) => {
  const db = relDb(a, b);
  const ok = pass(db);
  rows.push({ test: name, samples: `${a.length}/${b.length}`, rel_diff_db: db === -Infinity ? '-inf' : db.toFixed(2), result: ok ? 'PASS' : 'FAIL' });
};

const c0a = await render(0);
const c0b = await render(0);
const c5a = await render(0.5);
const c5b = await render(0.5);
check('(a) churn0 vs churn0', c0a, c0b, (d) => d < -90);
check('(b) churn0.5 vs churn0', c0a, c5a, (d) => d > -20);
check('(c) churn0.5 vs churn0.5', c5a, c5b, (d) => d < -90);
console.table(rows);
if (OUT) { mkdirSync(OUT, { recursive: true }); writeFileSync(`${OUT}/rows.json`, JSON.stringify(rows, null, 2)); }
process.exit(rows.every((r) => r.result === 'PASS') ? 0 : 1);
