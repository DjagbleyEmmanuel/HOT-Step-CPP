// muscriptor.ts — MuScriptor (audio→MIDI) shared helpers
//
// MuScriptor is developed by Kyutai & Mirelo (Rouard, Krause, Roebel,
// Simon-Gabriel, Défossez — arXiv:2607.08168). Code MIT; model weights
// CC BY-NC 4.0 and GATED on Hugging Face (users request access + read token).
//
// NOTE (2026-07-16): the original integration ran the upstream Python CLI in
// a managed venv. That approach was removed — transcription is being ported
// to a native GGML binary (`ace-midi`). Design: docs/plans/muscriptor-cpp-port.md.
// What remains here is the part the C++ path also needs: the Hugging Face
// token store used to download the gated weights.
//
// Rob's local venv at data/muscriptor/venv is intentionally NOT deleted —
// it is the numerics-validation oracle for the port (see design doc §6).

import path from 'path';
import fs from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { config } from '../config.js';
import { registerBusyCheck } from '../dataroot/pointer.js';

export const MUSCRIPTOR_DIR = path.join(config.data.dir, 'muscriptor');

export const MUSCRIPTOR_MODELS = ['small', 'medium', 'large'] as const;
export type MuscriptorModel = typeof MUSCRIPTOR_MODELS[number];

export const HF_MODEL_REPOS: Record<MuscriptorModel, string> = {
  small: 'MuScriptor/muscriptor-small',
  medium: 'MuScriptor/muscriptor-medium',
  large: 'MuScriptor/muscriptor-large',
};

// ── Hugging Face access token ────────────────────────────────────────────

const HF_TOKEN_PATH = path.join(MUSCRIPTOR_DIR, 'hf_token');

export function getHfToken(): string | null {
  try {
    const t = fs.readFileSync(HF_TOKEN_PATH, 'utf-8').trim();
    return t || null;
  } catch { return null; }
}

export function setHfToken(token: string): void {
  fs.mkdirSync(MUSCRIPTOR_DIR, { recursive: true });
  const t = (token || '').trim();
  if (!t) {
    fs.rmSync(HF_TOKEN_PATH, { force: true });
  } else {
    // A token that is not a plain hf_ string surfaces later as a gated-repo
    // 401 that looks like an access problem (#183). Refuse it here instead.
    if (!/^hf_[A-Za-z0-9]{10,}$/.test(t)) {
      const err = new Error('That does not look like a Hugging Face token: it should start with hf_ and contain only letters and digits.');
      (err as any).status = 400;
      throw err;
    }
    fs.writeFileSync(HF_TOKEN_PATH, t, { encoding: 'utf-8' });
  }
}

/** Heuristic: does this failure look like a gated-model / auth problem? */
export function looksLikeGatedError(text: string): boolean {
  return /gated|401|403|unauthorized|forbidden|restricted|access to model|awaiting a review|accept the conditions|not authenticated|invalid (user )?token|authentication/i.test(text);
}

// ── ace-midi engine binary ───────────────────────────────────────────────

/** Absolute path to ace-midi, or null if not built/shipped. Lives next to
 *  ace-server (same build output / portable layout). */
export function aceMidiExe(): string | null {
  const dir = path.dirname(config.aceServer.exe);
  const exe = path.join(dir, process.platform === 'win32' ? 'ace-midi.exe' : 'ace-midi');
  return fs.existsSync(exe) ? exe : null;
}

// ── Model weights (gated on HF — downloaded with the user's read token) ──

// MUSCRIPTOR_MODELS_DIR (Settings > Environment) mirrors ACESTEPCPP_MODELS so
// the gated weights can live outside the install (#86). Read at import, so a
// change needs a restart.
export const MODELS_DIR = process.env.MUSCRIPTOR_MODELS_DIR || path.join(config.data.dir, 'models', 'muscriptor');

export function modelDir(m: MuscriptorModel): string {
  return path.join(MODELS_DIR, m);
}

export function isModelDownloaded(m: MuscriptorModel): boolean {
  return fs.existsSync(path.join(modelDir(m), 'model.safetensors'))
      && fs.existsSync(path.join(modelDir(m), 'config.json'));
}

export interface ModelDownloadState {
  downloading: boolean;
  receivedBytes: number;
  totalBytes: number;
  error?: string;
  gated?: boolean;
}

const downloads = new Map<MuscriptorModel, ModelDownloadState>();

export function getModelStates(): Record<string, ModelDownloadState & { downloaded: boolean; sizeBytes: number }> {
  const out: Record<string, any> = {};
  for (const m of MUSCRIPTOR_MODELS) {
    const dl = downloads.get(m);
    let sizeBytes = 0;
    const downloaded = isModelDownloaded(m);
    if (downloaded) {
      try { sizeBytes = fs.statSync(path.join(modelDir(m), 'model.safetensors')).size; } catch { /* ignore */ }
    }
    out[m] = {
      downloaded,
      sizeBytes,
      downloading: dl?.downloading ?? false,
      receivedBytes: dl?.receivedBytes ?? 0,
      totalBytes: dl?.totalBytes ?? 0,
      error: dl?.error,
      gated: dl?.gated,
    };
  }
  return out;
}

async function fetchToFile(url: string, token: string | null, dest: string,
                           onProgress?: (received: number, total: number) => void): Promise<void> {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} fetching ${url}: ${body.slice(0, 300)}`);
  }
  const total = parseInt(res.headers.get('content-length') || '0', 10);
  let received = 0;
  const src = Readable.fromWeb(res.body as any);
  src.on('data', (chunk: Buffer) => {
    received += chunk.length;
    onProgress?.(received, total);
  });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  await pipeline(src, fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
}

/**
 * Begin downloading a model's config.json + model.safetensors from its gated
 * HF repo. Fire-and-poll: progress via getModelStates(). Single-flight.
 */
export function startModelDownload(m: MuscriptorModel): { started: boolean; error?: string } {
  if (downloads.get(m)?.downloading) return { started: false, error: 'Download already in progress' };
  if (isModelDownloaded(m)) return { started: false, error: 'Already downloaded' };

  const state: ModelDownloadState = { downloading: true, receivedBytes: 0, totalBytes: 0 };
  downloads.set(m, state);
  const token = getHfToken();
  const base = `https://huggingface.co/${HF_MODEL_REPOS[m]}/resolve/main`;

  (async () => {
    try {
      console.log(`[MidiStudio] Downloading ${m} weights from ${HF_MODEL_REPOS[m]}`);
      await fetchToFile(`${base}/config.json`, token, path.join(modelDir(m), 'config.json'));
      await fetchToFile(`${base}/model.safetensors`, token, path.join(modelDir(m), 'model.safetensors'),
        (received, total) => { state.receivedBytes = received; state.totalBytes = total; });
      console.log(`[MidiStudio] ${m} weights downloaded (${(state.receivedBytes / 1e9).toFixed(2)} GB)`);
    } catch (err: any) {
      state.error = err.message || 'Download failed';
      state.gated = looksLikeGatedError(state.error ?? '');
      console.error(`[MidiStudio] ${m} download FAILED: ${state.error}`);
    } finally {
      state.downloading = false;
    }
  })();

  return { started: true };
}

registerBusyCheck('muscriptor-downloads', () => [...downloads.entries()]
  .filter(([, s]) => s.downloading)
  .map(([m]) => `downloading MuScriptor ${m}`));

// ── Partial MIDI from the streamed events ────────────────────────────────

// ace-midi's instrument names (instrument_for_program in engine/tools/ace-midi.cpp)
// back to their GM programs; names it formats as program_<n> parse below.
const INSTRUMENT_PROGRAMS: Record<string, number> = {
  acoustic_piano: 0, electric_piano: 2, chromatic_percussion: 8, organ: 16,
  acoustic_guitar: 24, clean_electric_guitar: 26, distorted_electric_guitar: 29,
  acoustic_bass: 32, electric_bass: 33, violin: 40, viola: 41, cello: 42,
  contrabass: 43, orchestral_harp: 46, timpani: 47, string_ensemble: 48,
  synth_strings: 50, voice: 52, orchestra_hit: 55, trumpet: 56, trombone: 57,
  tuba: 58, french_horn: 60, brass_section: 61, soprano_and_alto_sax: 64,
  tenor_sax: 66, baritone_sax: 67, oboe: 68, english_horn: 69, bassoon: 70,
  clarinet: 71, flutes: 72, synth_lead: 80, synth_pad: 88,
};

function varLen(n: number): number[] {
  const out = [n & 0x7f];
  while ((n >>= 7) > 0) out.unshift((n & 0x7f) | 0x80);
  return out;
}

/**
 * Build a type-0 SMF (480 tpb, 120 bpm, velocity 100) from ace-midi's JSONL
 * note events, so a run that dies before writing out.mid still leaves the
 * notes it decoded. Notes still open at the cut are dropped. Null when no
 * note completed. Notes are fixed up as the engine's writer does
 * (validate_notes_fix, trim_overlapping in engine/tools/ace-midi.cpp).
 */
export function partialMidiFromEvents(events: any[]): Buffer | null {
  const open = new Map<number, { pitch: number; time: number; instrument: string }>();
  const notes: { pitch: number; on: number; off: number; instrument: string }[] = [];
  for (const ev of events) {
    if (ev?.type === 'note_start') open.set(ev.index, ev);
    else if (ev?.type === 'note_end' && open.has(ev.index)) {
      const s = open.get(ev.index)!;
      open.delete(ev.index);
      // A too-short note gets the engine's 0.01 s minimum, so its off never sorts before its on.
      const off = ev.time - s.time < 0.01 ? s.time + 0.01 : ev.time;
      notes.push({ pitch: s.pitch, on: s.time, off, instrument: s.instrument });
    }
  }
  // A note of the same pitch and instrument ends where the next one starts.
  notes.sort((a, b) => a.on - b.on);
  const lastOf = new Map<string, (typeof notes)[number]>();
  for (const n of notes) {
    const key = `${n.instrument}:${n.pitch}`;
    const prev = lastOf.get(key);
    if (prev && prev.off > n.on) prev.off = n.on;
    lastOf.set(key, n);
  }
  const kept = notes.filter(n => n.on < n.off);
  if (!kept.length) return null;

  // Channels by first appearance: 0-8, 10-15 (overflow shares 15), drums on 9.
  const channels = new Map<string, number>();
  const free = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];
  const setup: number[] = [];
  const chanFor = (instrument: string): number => {
    let ch = channels.get(instrument);
    if (ch !== undefined) return ch;
    if (instrument === 'drums') ch = 9;
    else {
      ch = free.shift() ?? 15;
      const program = INSTRUMENT_PROGRAMS[instrument] ?? (parseInt(instrument.replace(/^program_/, ''), 10) || 0);
      setup.push(0, 0xc0 | ch, program & 0x7f);
    }
    channels.set(instrument, ch);
    return ch;
  };

  const tick = (sec: number) => Math.round(sec * 960); // 480 tpb at 120 bpm
  const evs: { tick: number; status: number; pitch: number; vel: number }[] = [];
  for (const n of kept) {
    const ch = chanFor(n.instrument);
    evs.push({ tick: tick(n.on), status: 0x90 | ch, pitch: n.pitch, vel: 100 });
    evs.push({ tick: tick(n.off), status: 0x80 | ch, pitch: n.pitch, vel: 0 });
  }
  // Offs before ons at the same tick, so a repeated pitch is not cut short.
  evs.sort((a, b) => a.tick - b.tick || (a.status & 0xf0) - (b.status & 0xf0));

  const body: number[] = [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20, ...setup];
  let last = 0;
  for (const e of evs) {
    body.push(...varLen(e.tick - last), e.status, e.pitch & 0x7f, e.vel);
    last = e.tick;
  }
  body.push(0, 0xff, 0x2f, 0);

  const header = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0]);
  const trackHead = Buffer.alloc(8);
  trackHead.write('MTrk', 0, 'ascii');
  trackHead.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, trackHead, Buffer.from(body)]);
}
