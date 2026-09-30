#!/usr/bin/env node
// Feature C2 test: classifier-free guidance on the YuE2 NAR plan conditioning
// (yue2:plan_cfg, plan_cfg_t1/t2).
//
// node server/scripts/test-yue2-plancfg.mjs --phase pre|post [--seed N] [--frames N]
//                                           [--base URL] [--timeout S]
// pre (old build): saves the plan_cfg=1 baseline and a plan_cfg=2 render.
// post (new build): all checks. Running post on the old build fails (b)/(d).
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const PHASE      = arg('--phase', 'post');
const BASE       = arg('--base', 'http://127.0.0.1:8085');
const SEED       = Number(arg('--seed', '1234'));
const FRAMES     = Number(arg('--frames', '500'));   // 20 s at 25 fps
const CHUNK      = 250;
const TIMEOUT_MS = Number(arg('--timeout', '400')) * 1000;

const REPO = path.resolve(import.meta.dirname, '../..');
const OUT_DIR = path.join(REPO, 'temp', 'plancfg-test');
fs.mkdirSync(OUT_DIR, { recursive: true });
const ABC_TEXT = fs.readFileSync(
  path.join(REPO, 'server/data/audio/0005ea93-ca4f-4c6f-8b15-784040165f22.score.abc'), 'utf8');

// ── engine log tail ─────────────────────────────────────────────────────────
const LOGS_DIR = path.join(REPO, 'logs');
function engineLog() {
  const dirs = fs.readdirSync(LOGS_DIR).filter(d => /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(d)).sort();
  return dirs.length ? path.join(LOGS_DIR, dirs[dirs.length - 1], 'ace_engine.log') : null;
}
const logSize = () => { const f = engineLog(); return f && fs.existsSync(f) ? fs.statSync(f).size : 0; };
function logSince(off) {
  const f = engineLog(); if (!f || !fs.existsSync(f)) return '';
  const size = fs.statSync(f).size; if (size <= off) return '';
  const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(size - off);
  fs.readSync(fd, b, 0, b.length, off); fs.closeSync(fd); return b.toString('utf8');
}

const tfetch = (url, opt = {}) => fetch(url, { ...opt, signal: AbortSignal.timeout(30000) });

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
      throw new Error(`unsupported wav fmt ${JSON.stringify(fmt)}`);
    }
    p += 8 + sz + (sz & 1);
  }
  throw new Error('no data chunk');
}

async function render(extra, label) {
  const body = {
    style: 'pop rock, female vocals, energetic', seed: SEED,
    lyrics: '[verse]\nWalking down the empty street tonight\nNeon signs are flickering bright\n[chorus]\nWe are alive, we are alive\nHold on tight and feel the drive\n',
    abc: ABC_TEXT, cot: 'melody',
    nar_chunk_frames: CHUNK, ode_steps: 16, preview_max_frames: FRAMES,
    ...extra,
  };
  const t0 = Date.now();
  const vram = startVram();
  const r = await tfetch(`${BASE}/yue2/synth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`synth ${r.status}: ${await r.text()}`);
  const sub = await r.json(); const id = sub.job_id ?? sub.id;
  for (;;) {
    if (Date.now() - t0 > TIMEOUT_MS) { await tfetch(`${BASE}/job?id=${id}&cancel=1`, { method: 'POST' }).catch(() => {}); throw new Error(`timeout: ${label}`); }
    await new Promise(res => setTimeout(res, 1000));
    const s = await (await tfetch(`${BASE}/job?id=${id}`)).json();
    const st = String(s.status ?? s.state ?? '').toLowerCase();
    if (['done', 'complete', 'completed', 'succeeded'].includes(st)) break;
    if (st === 'failed' || st === 'error' || st.startsWith('cancel')) throw new Error(`job ${st}: ${JSON.stringify(s)}`);
  }
  const res = await tfetch(`${BASE}/job?id=${id}&result=1`);
  const audio = decodeWav(Buffer.from(await res.arrayBuffer()), res.headers.get('content-type'));
  const secs = (Date.now() - t0) / 1000, peak = await vram.stop();
  console.error(`render ${label}: ${secs.toFixed(1)}s, peak VRAM ${peak} MiB, ${audio.length} samples`);
  audio.secs = secs; audio.peak = peak;
  return audio;
}

function relDb(a, b) {
  const n = Math.min(a.length, b.length); let num = 0, den = 0;
  for (let i = 0; i < n; i++) { const d = a[i] - b[i]; num += d * d; den += a[i] * a[i]; }
  if (a.length !== b.length) console.log(`  (length mismatch ${a.length} vs ${b.length})`);
  return num === 0 ? -Infinity : 20 * Math.log10(Math.sqrt(num) / Math.sqrt(den));
}
const f = d => (d === -Infinity ? '-inf' : d.toFixed(2));
const saveF32 = (name, a) => fs.writeFileSync(path.join(OUT_DIR, name), Buffer.from(a.buffer));
const loadF32 = name => { const b = fs.readFileSync(path.join(OUT_DIR, name)); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };



// peak GPU0 memory.used over the render (nvidia-smi polled every 250 ms)
function startVram() {
  let peak = 0, live = true;
  const poll = () => execFile('nvidia-smi', ['-i', '0', '--query-gpu=memory.used', '--format=csv,noheader,nounits'],
    (e, so) => { if (!e) peak = Math.max(peak, Number(String(so).trim()) || 0); if (live) setTimeout(poll, 250); });
  poll();
  return { stop: async () => { live = false; await new Promise(r => setTimeout(r, 300)); return peak; } };
}
function stats(a) {
  let nan = 0, pk = 0, ss = 0, clip = 0;
  for (const v of a) { if (!Number.isFinite(v)) { nan++; continue; } const x = Math.abs(v); if (x > pk) pk = x; if (x >= 0.999) clip++; ss += v * v; }
  const rms = Math.sqrt(ss / a.length);
  return { nan, peak: pk, clipPct: 100 * clip / a.length, rmsDb: 20 * Math.log10(rms + 1e-12) };
}
function saveWav(file, a) {
  const d = Buffer.from(a.buffer, a.byteOffset, a.byteLength), h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + d.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(3, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(48000, 24); h.writeUInt32LE(48000 * 8, 28);
  h.writeUInt16LE(8, 32); h.writeUInt16LE(32, 34); h.write('data', 36); h.writeUInt32LE(d.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, d]));
}
const AB_DIR = path.join(REPO, 'temp', 'plancfg_ab');
fs.mkdirSync(AB_DIR, { recursive: true });
const cfg = s => (s === 1 ? {} : { plugin_params: { 'yue2:plan_cfg': s } });
const cfg1 = { plugin_params: { 'yue2:plan_cfg': 1 } };

if (PHASE === 'pre') {
  const b = await render({}, 'baseline (pre-change build)');
  saveF32('baseline_pre.f32', b);
  fs.writeFileSync(path.join(OUT_DIR, 'baseline_pre.json'), JSON.stringify({ secs: b.secs, peak: b.peak }));
  console.log('pre phase saved to', OUT_DIR, `(${b.secs.toFixed(1)} s, peak ${b.peak} MiB)`);
} else {
  const rows = []; let pass = true;
  const pre = loadF32('baseline_pre.f32');
  const preMeta = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'baseline_pre.json'), 'utf8'));
  const r1 = await render(cfg1, 'plan_cfg 1.0');
  const a = relDb(pre, r1); const aOk = a < -90; pass &&= aOk;
  rows.push({ check: '(a) cfg=1 vs pre-change build', value: f(a) + ' dB', ok: aOk });
  rows.push({ check: '(a) time / peak VRAM pre vs cfg=1', value: `${preMeta.secs.toFixed(1)}s/${preMeta.peak} vs ${r1.secs.toFixed(1)}s/${r1.peak} MiB`, ok: '' });
  saveWav(path.join(AB_DIR, 'plancfg_1.0.wav'), r1);
  const s1 = stats(r1);
  rows.push({ check: '(stats) cfg=1', value: `rms ${s1.rmsDb.toFixed(1)} dB peak ${s1.peak.toFixed(3)} clip ${s1.clipPct.toFixed(3)}%`, ok: '' });
  const sw = {};
  for (const s of [1.5, 2, 3]) {
    const r = sw[s] = await render(cfg(s), `plan_cfg ${s}`);
    saveWav(path.join(AB_DIR, `plancfg_${s.toFixed(1)}.wav`), r);
    const d = relDb(r1, r); const dOk = d > -60; pass &&= dOk;
    rows.push({ check: `(b) cfg=${s} vs cfg=1`, value: f(d) + ' dB', ok: dOk });
    const st = stats(r);
    const sane = st.nan === 0 && st.clipPct < 1 && st.rmsDb > s1.rmsDb - 12 && st.rmsDb < s1.rmsDb + 12; pass &&= sane;
    rows.push({ check: `(sane) cfg=${s}`, value: `nan ${st.nan} rms ${st.rmsDb.toFixed(1)} dB peak ${st.peak.toFixed(3)} clip ${st.clipPct.toFixed(3)}%`, ok: sane });
  }
  const again = await render(cfg(2), 'plan_cfg 2 repeat');
  const c = relDb(sw[2], again); const cOk = c < -90; pass &&= cOk;
  rows.push({ check: '(c) cfg=2 same seed twice', value: f(c) + ' dB', ok: cOk });
  rows.push({ check: '(perf) cfg=1 vs cfg=2', value: `${r1.secs.toFixed(1)}s/${r1.peak} MiB vs ${sw[2].secs.toFixed(1)}s/${sw[2].peak} MiB`, ok: '' });
  console.table(rows);
  console.log('WAVs in', AB_DIR);
  console.log(pass ? 'OVERALL PASS' : 'OVERALL FAIL');
  process.exit(pass ? 0 : 1);
}
