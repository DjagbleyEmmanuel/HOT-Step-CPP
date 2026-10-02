// daw/dawFacade.ts - Glue for the /api/v1/daw facade.
//
// Talks to the existing /api routes over loopback HTTP (so the generation
// queue, envelope and translation stay the single source of truth), owns the
// facade job map, the per-job temp dir and the float32 WAV export.

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { config, getFFmpegPath } from '../../config.js';
import { DawError, DAW_API_VERSION, ditKind, isBaseModel, mapJobStatus, type DawGenerateRequest } from './dawSchema.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const isLoopback = (addr: string | undefined) => LOOPBACK.has(addr ?? '');

/** Shared secret for non-loopback callers; unset = loopback only. */
export const dawKey = () => process.env.HOTSTEP_DAW_KEY || '';

export const dawTmpRoot = () => path.join(config.data.dir, 'daw_tmp');

const base = () => `http://127.0.0.1:${config.server.port}`;

// ── Loopback client ───────────────────────────────────────────────────────

let token: string | null = null;

async function getToken(): Promise<string> {
  if (token) return token;
  const r = await fetch(`${base()}/api/auth/auto`);
  if (!r.ok) throw new DawError(502, 'upstream_error', `auth/auto returned ${r.status}`);
  token = ((await r.json()) as any).token;
  return token!;
}

async function call(method: string, route: string, body?: unknown, retry = true): Promise<{ status: number; data: any }> {
  const r = await fetch(`${base()}${route}`, {
    method,
    headers: { Authorization: `Bearer ${await getToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  // Tokens live in memory upstream; mint a fresh one after a server restart.
  if (r.status === 401 && retry) { token = null; return call(method, route, body, false); }
  let data: any = null;
  try { data = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, data };
}

function upstreamError(status: number, data: any): DawError {
  const msg = String(data?.error ?? `upstream returned ${status}`);
  if (status === 503) return new DawError(503, /paused/i.test(msg) ? 'engine_suspended' : 'engine_not_ready', msg);
  if (status === 409) return new DawError(409, 'backend_mismatch', msg);
  if (status === 404) return new DawError(404, 'not_found', msg);
  if (status === 400) return new DawError(400, 'bad_request', msg);
  return new DawError(502, 'upstream_error', msg);
}

// ── Status ─────────────────────────────────────────────────────────────────

export async function getStatus() {
  const [health, models, caps] = await Promise.all([
    call('GET', '/api/health').catch(() => null),
    call('GET', '/api/models').catch(() => null),
    call('GET', '/api/capabilities').catch(() => null),
  ]);
  const dit: string[] = (models?.data?.models?.dit ?? []).map((m: any) => typeof m === 'string' ? m : (m?.name ?? String(m)));
  const ditModels = dit.map((name) => ({ name, kind: ditKind(name) }));
  const aceAlive = health?.data?.aceServer?.status === 'ok';
  return {
    api: DAW_API_VERSION,
    ace_server_alive: aceAlive,
    ready: aceAlive && health?.data?.engine?.ready === true,
    boot_status: health?.data?.engine?.bootStatus ?? null,
    version: health?.data?.version ?? null,
    loaded_model: models?.data?.defaults?.synth_model ?? models?.data?.config?.synth_model ?? null,
    dit_models: ditModels,
    non_turbo_available: ditModels.some((m) => m.kind !== 'turbo'),
    base_available: dit.some(isBaseModel),
    capabilities: caps?.data ?? null,
  };
}

/** Installed DiT names and the loaded one, for base-model gating. */
export async function getDitInfo(): Promise<{ dit: string[]; loaded: string | null }> {
  const { status, data } = await call('GET', '/api/models');
  if (status !== 200) throw upstreamError(status, data);
  const dit: string[] = (data?.models?.dit ?? []).map((m: any) => typeof m === 'string' ? m : (m?.name ?? String(m)));
  return { dit, loaded: data?.defaults?.synth_model ?? data?.config?.synth_model ?? null };
}

// ── Temp dirs ──────────────────────────────────────────────────────────────

export function newTmpDir(id: string): string {
  const dir = path.join(dawTmpRoot(), id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Remove one entry, only if it is a direct child of daw_tmp. */
function removeTmp(id: string): void {
  const root = path.resolve(dawTmpRoot());
  const dir = path.resolve(root, id);
  if (path.dirname(dir) !== root) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

const TTL_MS = 6 * 3600_000;
const FAILED_TTL_MS = 10 * 60_000;

export function sweepTmp(now = Date.now()): void {
  const root = dawTmpRoot();
  if (!fs.existsSync(root)) return;
  for (const name of fs.readdirSync(root)) {
    const job = jobs.get(name) ?? understands.get(name);
    let age: number;
    try { age = now - fs.statSync(path.join(root, name)).mtimeMs; } catch { continue; }
    const finishedBad = job && 'finalState' in job && (job.finalState === 'failed' || job.finalState === 'cancelled');
    if (age > TTL_MS || (finishedBad && age > FAILED_TTL_MS)) {
      removeTmp(name);
      jobs.delete(name);
      understands.delete(name);
    }
  }
}

let sweeper: NodeJS.Timeout | null = null;
export function startSweeper(): void {
  if (sweeper) return;
  try { sweepTmp(); } catch (e) { console.warn('[daw] startup sweep failed:', e); }
  sweeper = setInterval(() => { try { sweepTmp(); } catch { /* next round */ } }, 15 * 60_000);
  sweeper.unref();
}

// ── Generate / jobs ────────────────────────────────────────────────────────

interface FacadeJob { id: string; upstreamId: string; seeds: number[]; finalState?: string }
const jobs = new Map<string, FacadeJob>();

export async function submitGenerate(id: string, req: DawGenerateRequest, params: Record<string, unknown>): Promise<string> {
  const { status, data } = await call('POST', '/api/generate', params);
  if (status !== 200 || !data?.jobId) throw upstreamError(status, data);
  const seeds = req.seed !== undefined ? Array.from({ length: req.takes ?? 1 }, () => req.seed!) : [];
  jobs.set(id, { id, upstreamId: data.jobId, seeds });
  return id;
}

function requireJob(id: string): FacadeJob {
  const j = jobs.get(id);
  if (!j) throw new DawError(404, 'not_found', `unknown job ${id}`);
  return j;
}

async function upstreamStatus(j: FacadeJob): Promise<any> {
  const { status, data } = await call('GET', `/api/generate/status/${j.upstreamId}`);
  if (status !== 200) throw upstreamError(status, data);
  return data;
}

export async function getJob(id: string) {
  const j = requireJob(id);
  const out = mapJobStatus(id, await upstreamStatus(j), j.seeds);
  if (out.state === 'failed' || out.state === 'cancelled' || out.state === 'done') j.finalState = out.state;
  return out;
}

export async function cancelJob(id: string) {
  const j = requireJob(id);
  const { status, data } = await call('POST', `/api/generate/cancel/${j.upstreamId}`);
  if (status !== 200) throw upstreamError(status, data);
  j.finalState = 'cancelled';
  return { api: DAW_API_VERSION, id, state: 'cancelled' as const };
}

function runFfmpeg(args: string[]): Promise<void> {
  const ff = getFFmpegPath();
  if (!ff) return Promise.reject(new DawError(500, 'upstream_error', 'ffmpeg not available'));
  return new Promise((resolve, reject) => execFile(ff, args, { timeout: 120_000 }, (err) => err ? reject(err) : resolve()));
}

/** Path of a cached 48 kHz float32 stereo WAV for take n, converting on first use. */
export async function takeWavPath(id: string, n: number): Promise<string> {
  const j = requireJob(id);
  const up = await upstreamStatus(j);
  if (up.status !== 'succeeded') throw new DawError(409, 'bad_request', `job is ${up.status}, audio not ready`);
  const url: string | undefined = up.result?.audioUrls?.[n];
  if (!url) throw new DawError(404, 'not_found', `no take ${n}`);
  const rel = url.replace(/^\/audio\//, '').split('?')[0];
  const src = path.resolve(config.data.audioDir, rel);
  if (!src.startsWith(path.resolve(config.data.audioDir)) || !fs.existsSync(src)) {
    throw new DawError(404, 'not_found', `take ${n} audio file is missing`);
  }
  const out = path.join(newTmpDir(id), `take_${n}.wav`);
  if (!fs.existsSync(out)) {
    const part = `${out}.part.wav`;
    await runFfmpeg(['-y', '-i', src, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le', part]);
    fs.renameSync(part, out);
  }
  return out;
}

// ── Understand ─────────────────────────────────────────────────────────────

interface UnderstandJob { id: string; finalState?: 'done' | 'failed'; result?: any; error?: string }
const understands = new Map<string, UnderstandJob>();

/** Start analysis; resolves with the result if it finishes within waitMs, else null (poll). */
export async function startUnderstand(id: string, filePath: string, waitMs = 5000): Promise<{ id: string; result: any | null }> {
  const u: UnderstandJob = { id };
  understands.set(id, u);
  const work = call('POST', '/api/analyze', { audioUrl: filePath }).then(({ status, data }) => {
    if (status !== 200) throw upstreamError(status, data);
    u.result = {
      api: DAW_API_VERSION,
      id,
      state: 'done',
      bpm: data.bpm ?? null,
      key: [data.key, data.scale].filter(Boolean).join(' ') || null,
      timesig: data.timeSignature ?? data.time_signature ?? null,
      tags: data.tags ?? [],
    };
    u.finalState = 'done';
  }).catch((e: any) => { u.finalState = 'failed'; u.error = e?.message ?? String(e); });
  await Promise.race([work, new Promise((r) => setTimeout(r, waitMs))]);
  return { id, result: u.finalState ? getUnderstand(id) : null };
}

export function getUnderstand(id: string) {
  const u = understands.get(id);
  if (!u) throw new DawError(404, 'not_found', `unknown analysis ${id}`);
  if (u.finalState === 'done') return u.result;
  if (u.finalState === 'failed') return { api: DAW_API_VERSION, id, state: 'failed', error: u.error };
  return { api: DAW_API_VERSION, id, state: 'running' };
}

export const newId = () => uuidv4();
