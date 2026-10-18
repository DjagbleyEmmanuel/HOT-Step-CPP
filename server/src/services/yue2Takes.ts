// YuE2 build by section: compose a cover a few sections at a time. A session
// holds the exact /yue2/synth request a one-shot render of the cover would
// send (built by the route from the same params), so every take is
// conditioned on the same prompt, score and lyrics. The "spine" is the last
// kept take. A take of sections [from, to] resumes the spine's codes up to
// where `from` starts in the spine's own audio (codec_ids +
// continue_codec_ids; the first takes resume nothing), composes with its own
// seed, and stops shortly after `to` (preview_max_frames). Keeping a take
// makes it the spine. Save song is an ordinary render job that prefills the
// spine's whole stream (generate.ts, params.yue2Build), so it gets the usual
// post-processing and library save. Section starts come from aligning the
// lyrics on each take's audio, because the score clock drifts from what the
// composer sings. Sessions are files under <audioDir>/takes/<id>/, so the
// /audio static route plays the takes. Sections are built in the
// arrangement's order (coverArrangement.ts): every take and Save song sends
// the score and lyrics written out in that order, and a take's from, to and
// starts index the arrangement's occurrences, never the score's sections.
// The spine can be cropped (cropBuildTake): the cut is a new take in its
// place, so the next take and Save song resume the cut stream and the
// original stays to be put back. A take may carry its own caption
// (generateBuildTakes): it changes what the AR composes for that take only.
// Every preview and Save song still decode the whole stream through NAR under
// one caption: the take's own for its preview, the session's for Save song.

import fs from 'node:fs';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { aceClient } from './aceClient.js';
import { runOnGpuLane, type LaneLease } from './generation/gpuLane.js';
import { yue2Align, yue2Synth, splitMultipartMixed, type Yue2SynthRequest, type Yue2TrackDetail } from './backends/yue2/client.js';
import { splitLyricBlocks } from './backends/yue2/sectionMatch.js';
import type { Yue2AlignWord } from './backends/yue2/align.js';
import { scoreSections } from './backends/yue2/scoreSections.js';
import { scoreBarClock } from './backends/yue2/scoreClock.js';
import {
  BUILD_SESSION_VERSION, composeArrangement, editPlan, generateRefusal, keepRefusal, migrateLegacySession, nextOccurrence,
  planSections, revisionRefusal, sourceSections, takeIdentity, type ArrangedSession, type ArrangedTake, type LegacySession,
} from './backends/yue2/coverArrangement.js';
import { buildYue2LyricSchedule } from './backends/yue2/lyricSchedule.js';
import { preparedParams } from '../contracts/yue2Prepare.js';

/** Codec frames per second (the composer's frame clock). */
export const YUE2_FPS = 25;
/** A take runs this much past its sections' score length before stopping. */
const TAKE_SLACK = 1.3;
const TAKE_SLACK_FRAMES = 4 * YUE2_FPS;
const MAX_TAKES = 10;
const MAX_LYRICS = 20_000;
const MAX_CAPTION = 4000;
/** Bars in a take's waveform, over its new part (from its lead-in). */
const PEAKS = 120;
const LEAD_IN_S = 4;

export class TakesError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** A mutation names the revision it was made against; refuse it once the build moved on. */
function checkRevision(stored: Stored, expected: unknown): void {
  const refusal = revisionRefusal(stored, expected);
  if (refusal) throw new TakesError(refusal, 409);
}

export interface Yue2Take {
  id: string;
  /** The occurrences it composed, plan indexes, 0-based and inclusive. */
  from: number;
  to: number;
  seed: number;
  /** Played through /audio. */
  audioUrl: string;
  frames: number;
  /** The frame each occurrence starts at in this take's audio, or null where
   *  the take does not reach it or no start was found. */
  starts: Array<number | null>;
  /** Loudness of its new part, 0..1, from LEAD_IN_S before `prefix` to its end. */
  peaks?: number[];
  /** Codec frames it resumed from its parent; its new part starts here.
   *  Missing on takes from older servers: starts[from] then. */
  prefix?: number;
  /** A crop (cropBuildTake): the take whose audio and codes it cuts short. */
  cropOf?: string;
  /** Where the next take resumes, when not at starts[to + 1]: a crop inside
   *  an occurrence that the next take composes again. */
  resume?: number;
  /** The style prompt it was sent, adapter trigger included. Missing on older takes. */
  style?: string;
  /** Its own caption, as typed; missing when it used the session's. */
  caption?: string;
}

/** Session file version 2 (coverArrangement.ts): revisions, take parents, the
 *  plan. `kept` is the kept takes, oldest first; the last is the spine. */
export interface Yue2BuildSession extends ArrangedSession {
  id: string;
  sections: Array<{ label: string; startBar: number }>;
  /** Takes still rendering. */
  pending: Array<{ from: number; to: number; count: number; activeCount?: number; phase?: string; progress?: number }>;
  error: string | null;
  /** The params a Save song render submits. Applying lyrics or settings
   *  replaces them and the stored request together. */
  params: Record<string, unknown>;
  /** The Prepare confirmations the session started from, when it started
   *  from a Prepare document (contracts/yue2Prepare.ts). */
  prepared?: { structureHash: string; lyricRevision: number };
}

/** `request` holds the score and lyrics in source order; arranged() writes them out in plan order. */
interface Stored extends Yue2BuildSession { userId: string; request: Yue2SynthRequest }

interface BuildRun { cancelled: boolean; jobId?: string }
const runs = new Map<string, BuildRun>();

const root = () => path.join(config.data.audioDir, 'takes');
const sessionDir = (id: string) => path.join(root(), id);
const sessionFile = (id: string) => path.join(sessionDir(id), 'session.json');
const codesFile = (id: string, take: string) => path.join(sessionDir(id), `${take}.codes.json`);

function load(id: string, userId: string): Stored {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new TakesError('Build session not found', 404);
  let stored: Stored | (LegacySession & Pick<Stored, 'id' | 'userId' | 'params' | 'pending' | 'error' | 'request'>);
  try { stored = JSON.parse(fs.readFileSync(sessionFile(id), 'utf8')); }
  catch { throw new TakesError('Build session not found', 404); }
  if (stored.userId !== userId) throw new TakesError('Build session not found', 404);
  if (stored.version === BUILD_SESSION_VERSION) return stored;
  // A session from before revisions: upgrade it once, on first open.
  let upgraded: Stored;
  try {
    upgraded = migrateLegacySession(stored as Exclude<typeof stored, Stored>, take =>
      JSON.parse(fs.readFileSync(codesFile(id, take), 'utf8')) as number[]) as unknown as Stored;
  } catch (err) { throw new TakesError(`This build session cannot be opened: ${(err as Error).message}`, 409); }
  save(upgraded);
  return upgraded;
}

function save(stored: Stored): void {
  const tmp = `${sessionFile(stored.id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stored));
  fs.renameSync(tmp, sessionFile(stored.id));
}

// Older session files also carry scoreStarts, which arranged() replaced.
const view = ({ request: _r, scoreStarts: _s, userId: _u, ...rest }: Stored & { scoreStarts?: unknown }): Yue2BuildSession => rest;

/** A lyric span per occurrence (code points in the composed lyrics), or null when unsung. */
type Spans = Array<[number, number] | null>;

/** What a take or Save song sends now: the session's request with its score
 *  and lyrics written out in plan order, plus each occurrence's lyric span
 *  and its frame on the score clock (and the end's). The source order sends
 *  the stored text unchanged, so sessions from before arrangements render as
 *  they did. A lyric schedule is rebuilt from the composed text, or dropped
 *  when that text would pair a block with the wrong occurrence. */
function arranged(stored: Pick<Stored, 'request' | 'arrangement'>): { request: Yue2SynthRequest; lyrics: string; spans: Spans; clock: number[] } {
  const abc = stored.request.abc ?? '', lyrics = stored.request.lyrics ?? '';
  const plan = planSections(stored.arrangement);
  const composed = composeArrangement(abc, lyrics, plan);
  const request = { ...stored.request };
  if (plan.length !== stored.arrangement.sections.length || plan.some((s, i) => s !== i)) {
    request.abc = composed.abc;
    if (request.lyrics) request.lyrics = composed.lyrics;
    const schedule = request.lyric_schedule;
    delete request.lyric_schedule;
    // ponytail: no schedule rather than a mispaired one; pairing the schedule
    // by occurrence would need lyricSchedule.ts to take the spans.
    if (schedule && request.lyrics && composed.textPairingMatches) {
      try {
        request.lyric_schedule = buildYue2LyricSchedule(composed.abc, composed.lyrics, { mode: schedule.mode,
          bias: schedule.bias ?? -4, abc: schedule.abc === true, leadSec: schedule.lead_sec ?? 0, behind: schedule.behind ?? -1 }).wire;
      } catch { /* renders unscheduled, as generate.ts does for a schedule it cannot build */ }
    }
  }
  const marks = scoreSections(request.abc!);
  if (marks.length !== plan.length) throw new TakesError('The arranged score lost a section label; edit the arrangement again.', 409);
  const bars = scoreBarClock(request.abc!);
  const clock = marks.map(m => Math.round((bars[m.startBar - 1]?.start ?? 0) * YUE2_FPS))
    .concat(Math.round((bars.at(-1)?.end ?? 0) * YUE2_FPS));
  return { request, lyrics: composed.lyrics, spans: composed.occurrences.map(o => o.lyric), clock };
}

/** Where each occurrence starts in a take, from the lyrics aligned on its
 *  audio: halfway through the gap before its first sung word. `spans` gives
 *  each occurrence its own lyric block (composeArrangement), so a repeated
 *  chorus is timed by its own copy. Occurrences with no sung block (intro,
 *  solo) start just after the previous block's last word. Occurrence 0
 *  starts at 0. Word times are read as the section matcher reads them
 *  (median of the first three starts; squashed words mean not sung there),
 *  not by the aligner's scores, which read near zero on a full mix. */
export function sectionStarts(spans: Spans, words: Yue2AlignWord[], frames: number): Array<number | null> {
  const timed = (block: { start: number; end: number }) => {
    const own = words.filter(word => word.char0 >= block.start && word.char0 < block.end &&
      Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start);
    if (!own.length) return null;
    const durations = own.map(word => word.end - word.start).sort((a, b) => a - b);
    if (durations[Math.floor(durations.length / 2)] < 0.04) return null;
    const firsts = own.slice(0, 3).map(word => word.start).sort((a, b) => a - b);
    return { start: firsts[Math.floor(firsts.length / 2)], end: Math.max(...own.map(word => word.end)) };
  };
  // The end of the last sung word before each section, unless a sung section
  // in between could not be placed (then what follows it is unknown too).
  let lastEnd: number | null = null;
  let lastStart = 0;
  return spans.map((at, i) => {
    const span = at === null ? null : timed({ start: at[0], end: at[1] });
    const seconds = i === 0 ? 0 : span ? (lastEnd !== null && lastEnd < span.start ? (lastEnd + span.start) / 2
      : Math.max(0, span.start - 0.5)) : at === null && lastEnd !== null ? lastEnd + 0.5 : null;
    if (span) lastEnd = span.end;
    else if (at !== null) lastEnd = null;
    // Sections run in order: a start at or before the last one is a misread
    // (words squashed into a take's tail), not a section.
    const frame = seconds === null ? null : Math.round(seconds * YUE2_FPS);
    if (frame === null || frame >= frames || (i > 0 && frame <= lastStart)) return null;
    lastStart = frame;
    return frame;
  });
}

/** The lyrics up to the end of the block of occurrence `through`. */
export function lyricsThrough(lyrics: string, spans: Spans, through: number): string {
  if (through >= spans.length - 1) return lyrics;
  const end = spans.slice(0, through + 1).filter(span => span !== null).at(-1)?.[1];
  return end === undefined ? lyrics : Array.from(lyrics).slice(0, end).join('');
}

// A take that stops early is aligned against the lyrics only up to the
// block of the occurrence after its own: words it never sang would be
// squashed into its tail and drag the earlier ones with them.
async function alignStarts(lyrics: string, spans: Spans, wav: Buffer, frames: number, through?: number): Promise<Array<number | null>> {
  if (!lyrics.trim()) return spans.map((_, i) => (i === 0 ? 0 : null));
  const text = through === undefined ? lyrics : lyricsThrough(lyrics, spans, through);
  const aligned = await yue2Align(wav, text);
  const starts = sectionStarts(spans, aligned.words, frames);
  // Past `through` the lyrics were cut, so those occurrences read as unsung.
  return spans.map((_, i) => (through !== undefined && i > through ? null : starts[i] ?? null));
}

async function waitJob(jobId: string, run: BuildRun, lease: LaneLease,
  progress: (phase: string, progress: number) => void): Promise<Yue2TrackDetail[]> {
  const started = Date.now();
  let cancelSent = false;
  for (;;) {
    if ((run.cancelled || !lease.isCurrent()) && !cancelSent) {
      run.cancelled = true;
      await aceClient.cancelJob(jobId);
      cancelSent = true;
    }
    const status = await aceClient.pollJob(jobId);
    if (status.status === 'done') {
      if (run.cancelled) throw new Error('YuE2 takes cancelled');
      return (status as { tracks?: Yue2TrackDetail[] }).tracks ?? [];
    }
    if (status.status === 'failed' || status.status === 'cancelled') {
      throw new Error(`YuE2 take ${status.status}${(status as { error?: string }).error ? `: ${(status as { error?: string }).error}` : ''}`);
    }
    if (Date.now() - started > 15 * 60_000) {
      await aceClient.cancelJob(jobId).catch(() => {});
      throw new Error('YuE2 take timed out after 15 minutes');
    }
    progress(status.phase ?? 'rendering', status.phase_total ? Math.round(100 * (status.phase_step ?? 0) / status.phase_total) : 0);
    await new Promise(r => setTimeout(r, 750));
  }
}

/** A waveform of a 16-bit PCM WAV between two times: PEAKS peak levels. */
export function wavPeaks(wav: Buffer, fromSec: number, toSec: number): number[] {
  // Walk the chunks to fmt and data; the engine writes plain 16-bit PCM.
  let off = 12, channels = 2, rate = 48000, dataOff = -1, dataLen = 0;
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4), len = wav.readUInt32LE(off + 4);
    if (id === 'fmt ') { channels = wav.readUInt16LE(off + 10); rate = wav.readUInt32LE(off + 12); }
    if (id === 'data') { dataOff = off + 8; dataLen = Math.min(len, wav.length - dataOff); break; }
    off += 8 + len + (len % 2);
  }
  if (dataOff < 0) return [];
  const frameBytes = 2 * channels, frames = Math.floor(dataLen / frameBytes);
  const a = Math.max(0, Math.floor(fromSec * rate)), b = Math.min(frames, Math.floor(toSec * rate));
  if (b <= a) return [];
  const peaks: number[] = [];
  for (let k = 0; k < PEAKS; k++) {
    const lo = a + Math.floor(((b - a) * k) / PEAKS), hi = a + Math.floor(((b - a) * (k + 1)) / PEAKS);
    let peak = 0;
    for (let f = lo; f < hi; f += 16) peak = Math.max(peak, Math.abs(wav.readInt16LE(dataOff + f * frameBytes)));
    peaks.push(Math.round((peak / 32768) * 100) / 100);
  }
  return peaks;
}

/** The take count controls songs; every song has exactly one noise variation. */
function plainRequest(request: Yue2SynthRequest): Yue2SynthRequest {
  request = { ...request };
  delete request.lm_batch_size;
  delete request.synth_batch_size;
  delete request.songs;
  delete request.seed;
  return request;
}

/** Starts a build session for a cover's request. With `params.yue2Prepare`
 *  (the Prepare document), the shared submission check runs once here: the
 *  score must be the confirmed one and the lyrics the ones it exports. The
 *  session keeps the checked pair and the confirmations, not the document. */
export function createBuildSession(params: Record<string, unknown>, request: Yue2SynthRequest, userId: string): Yue2BuildSession {
  let prepared: Yue2BuildSession['prepared'];
  if (params.yue2Prepare !== undefined) {
    const pair = preparedParams(params);
    if ('error' in pair) throw new TakesError(pair.error, 409);
    const { yue2Prepare: _, ...rest } = params;
    params = rest;
    prepared = { structureHash: pair.structureHash, lyricRevision: pair.lyricRevision };
  }
  if (!request.abc) throw new TakesError('Build by section needs an approved score.');
  const sections = scoreSections(request.abc).map(s => ({ label: s.label.trim(), startBar: s.startBar }));
  if (!sections.length) throw new TakesError('The score has no section labels.');
  request = plainRequest(request);
  const source = sourceSections(request.abc!, request.lyrics ?? '');
  const id = randomUUID();
  fs.mkdirSync(sessionDir(id), { recursive: true });
  const stored: Stored = {
    id, userId, sections, takes: [], kept: [], pending: [], error: null, params, request,
    version: BUILD_SESSION_VERSION, revision: 0,
    arrangement: { sections: source, plan: source.map((s, i) => ({ id: `o${i}`, section: s.id })), nextOccurrence: source.length, finished: true },
    ...(prepared ? { prepared } : {}),
  };
  save(stored);
  return view(stored);
}

export function getBuildSession(id: string, userId: string): Yue2BuildSession {
  return view(load(id, userId));
}

/** Queues `count` takes of occurrences [next, to], resumed from the spine
 *  under the arranged prompt. Returns at once; the session lists the takes
 *  as they finish. A non-empty `caption` replaces the session's for these
 *  takes only; `toStyle` composes the style prompt a render of params would
 *  send (adapter trigger and template included). Empty or missing inherits.
 *  It is not session state, so the revision stays. */
export function generateBuildTakes(id: string, userId: string, to: number, count: number, revision: unknown,
  caption?: unknown, toStyle?: (params: Record<string, unknown>) => string): Yue2BuildSession {
  const stored = load(id, userId);
  checkRevision(stored, revision);
  if (caption !== undefined && caption !== null && typeof caption !== 'string') throw new TakesError('caption must be text.');
  if (typeof caption === 'string' && caption.length > MAX_CAPTION) throw new TakesError(`A caption is limited to ${MAX_CAPTION.toLocaleString('en-US')} characters.`);
  const own = typeof caption === 'string' && caption.trim() ? caption.trim() : undefined;
  if (own && !toStyle) throw new TakesError('A take caption needs the style composer.', 500);
  const from = nextOccurrence(stored);
  const refusal = generateRefusal(stored, to);
  if (refusal) throw new TakesError(refusal);
  if (!Number.isInteger(count) || count < 1 || count > MAX_TAKES) throw new TakesError(`Generate 1 to ${MAX_TAKES} takes at a time.`);
  const spine = stored.takes.find(t => t.id === stored.kept.at(-1));
  // Where occurrence `from` starts, and where this take resumes: the same
  // place unless a crop cut into `from` (cropBuildTake).
  const sectionStart = spine ? spine.starts[from] : 0;
  const start = spine?.resume ?? sectionStart;
  if (start === null || start === undefined || sectionStart === null || sectionStart === undefined) {
    throw new TakesError('The kept take does not reach the next section. Undo the keep and try another take.');
  }
  const prefix = spine ? (JSON.parse(fs.readFileSync(codesFile(id, spine.id), 'utf8')) as number[]).slice(0, start) : [];
  const { request, lyrics, spans, clock } = arranged(stored);
  // prompt is the first caption field a render reads (generate.ts), so it wins.
  if (own) request.style = toStyle!({ ...stored.params, prompt: own });
  const occurrences = spans.length;
  const last = to + 1 >= occurrences;
  const length = clock[to + 1] - clock[from];
  const cap = last ? undefined : start + Math.round(Math.max(length, 1) * TAKE_SLACK) + TAKE_SLACK_FRAMES;
  const name = (i: number) => stored.arrangement.sections.find(s => s.id === stored.arrangement.plan[i].section)?.label ?? `#${i + 1}`;
  if (stored.pending.length) throw new TakesError('Wait for the pending takes or cancel them first.');
  const identity = takeIdentity(stored, to);
  const pending = { from, to, count, activeCount: 0, phase: 'queued', progress: 0 };
  stored.pending.push(pending);
  stored.error = null;
  save(stored);
  const run: BuildRun = { cancelled: false };
  runs.set(id, run);

  void (async () => {
    try {
      for (let n = 0; n < count; n += 4) {
        if (run.cancelled) throw new Error('YuE2 takes cancelled');
        const seeds = Array.from({ length: Math.min(4, count - n) }, () => randomInt(1, 2 ** 31 - 1));
        await runOnGpuLane(async lease => {
          const checkCancelled = () => {
            if (run.cancelled || !lease.isCurrent()) throw new Error('YuE2 takes cancelled');
          };
          checkCancelled();
          const update = (phase: string, progress: number) => {
            const fresh = load(id, userId);
            Object.assign(fresh.pending[0], { activeCount: seeds.length, phase, progress });
            save(fresh);
          };
          update('starting', 0);
          const req: Yue2SynthRequest = { ...request, synth_batch_size: 1,
            ...(prefix.length ? { codec_ids: prefix, continue_codec_ids: true } : {}),
            ...(cap ? { preview_max_frames: cap } : {}) };
          // Sessions saved by older servers may still carry batch fields.
          delete req.lm_batch_size;
          delete req.songs;
          if (seeds.length === 1) req.seed = seeds[0];
          else {
            delete req.seed;
            req.songs = seeds.map(seed => ({ style: request.style, lyrics: request.lyrics, abc: request.abc, seed }));
          }
          // Retry winners use a different seed, which breaks the take identity.
          delete req.semantic_retries;
          const sub = await yue2Synth(req);
          run.jobId = sub.job_id;
          try {
            const tracks = await waitJob(sub.job_id, run, lease, update);
            checkCancelled();
            const body = await aceClient.getJobResult(sub.job_id);
            if (!body.ok) throw new Error(`YuE2 take result fetch failed (${body.status})`);
            const audio = Buffer.from(await body.arrayBuffer());
            const contentType = body.headers.get('content-type') ?? 'audio/wav';
            const parts = contentType.startsWith('multipart/mixed') ? splitMultipartMixed(audio, contentType) : [audio];
            // Metadata and WAV parts share their order, but song indices may have
            // gaps. Validate the entire chunk before attaching any of its audio.
            const mapped = mapTakeTracks(seeds, tracks, parts);
            update('aligning', 100);
            const takes: ArrangedTake[] = [];
            for (const { seed, ids, wav } of mapped) {
              checkCancelled();
              const starts = await alignStarts(lyrics, spans, wav, ids.length, last ? undefined : to + 1);
              checkCancelled();
              for (let i = 0; i <= from; i++) starts[i] = spine ? spine.starts[i] : i === 0 ? 0 : null;
              for (let i = from + 1; i <= Math.min(to + 1, occurrences - 1); i++) {
                const estimate = sectionStart + clock[i] - clock[from];
                if (starts[i] === null && estimate < ids.length) starts[i] = estimate;
              }
              const takeId = randomUUID().slice(0, 8);
              const peaks = wavPeaks(wav, Math.max(0, start / YUE2_FPS - (start ? LEAD_IN_S : 0)), ids.length / YUE2_FPS);
              fs.writeFileSync(path.join(sessionDir(id), `${takeId}.wav`), wav);
              fs.writeFileSync(codesFile(id, takeId), JSON.stringify(ids));
              takes.push({ id: takeId, from, to, seed, audioUrl: `/audio/takes/${id}/${takeId}.wav`, frames: ids.length, starts, peaks, prefix: start, style: request.style, ...(own ? { caption: own } : {}), ...identity });
            }
            const fresh = load(id, userId);
            fresh.takes.push(...takes);
            Object.assign(fresh.pending[0], { count: count - n - seeds.length, activeCount: 0, phase: 'queued', progress: 0 });
            save(fresh);
          } catch (err) {
            await aceClient.cancelJob(sub.job_id).catch(() => {});
            throw err;
          } finally {
            run.jobId = undefined;
          }
        }, { label: `yue2 build: ${name(from)}–${name(to)}`, family: 'yue2' });
      }
    } catch (err) {
      const fresh = load(id, userId);
      fresh.error = (err as Error).message;
      save(fresh);
    } finally {
      runs.delete(id);
      const fresh = load(id, userId);
      fresh.pending = [];
      save(fresh);
    }
  })();
  return view(stored);
}

/** Validate every track before any take is saved. Parts follow track order. */
export function mapTakeTracks(seeds: number[], tracks: Yue2TrackDetail[], parts: Buffer[]): Array<{ seed: number; ids: number[]; wav: Buffer }> {
  if (tracks.length !== seeds.length || parts.length !== tracks.length) {
    throw new Error(`YuE2 take chunk expected ${seeds.length} tracks, received ${tracks.length} metadata rows and ${parts.length} audio parts. No takes saved.`);
  }
  const mapped: Array<{ seed: number; ids: number[]; wav: Buffer }> = [];
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    if (!Number.isInteger(track.song) || track.song < 0 || track.song >= seeds.length || mapped[track.song]
      || track.seed !== seeds[track.song] || track.variation !== 0) {
      throw new Error(`YuE2 take chunk has a missing, duplicate or mismatched song/seed at track ${i}. No takes saved.`);
    }
    if (!track.semantic_ids?.length || parts[i].length < 44
      || parts[i].toString('ascii', 0, 4) !== 'RIFF' || parts[i].toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error(`YuE2 take chunk song ${track.song} has no codec stream or valid WAV audio. No takes saved.`);
    }
    mapped[track.song] = { seed: track.seed, ids: track.semantic_ids, wav: parts[i] };
  }
  return mapped;
}

/** Stops this session's current chunk and prevents later chunks from starting. */
export async function cancelBuildTakes(id: string, userId: string): Promise<Yue2BuildSession> {
  load(id, userId);
  const run = runs.get(id);
  if (run) {
    run.cancelled = true;
    if (run.jobId) await aceClient.cancelJob(run.jobId);
  }
  return getBuildSession(id, userId);
}

/** Keeps a take of the next sections: it becomes the spine. */
export function keepBuildTake(id: string, userId: string, takeId: string, revision: unknown): Yue2BuildSession {
  const stored = load(id, userId);
  checkRevision(stored, revision);
  const take = stored.takes.find(t => t.id === takeId);
  if (!take) throw new TakesError('No such take.');
  const refusal = keepRefusal(stored, take);
  if (refusal) throw new TakesError(refusal, 409);
  stored.kept.push(take.id);
  save(stored);
  return view(stored);
}

/** Drops kept takes from the end: one, or until occurrence `section` is the
 *  next to build again. The revision stays, so a take made from an earlier
 *  spine is keepable again. */
export function undoBuildKeep(id: string, userId: string, section: number | undefined, revision: unknown): Yue2BuildSession {
  const stored = load(id, userId);
  checkRevision(stored, revision);
  if (section === undefined) stored.kept.pop();
  else {
    if (!Number.isInteger(section) || section < 0) throw new TakesError('No such section.');
    while (stored.kept.length && nextOccurrence(stored) > section) stored.kept.pop();
  }
  save(stored);
  return view(stored);
}

/** Deletes a take that is not part of the build, with its audio and codes. */
export function deleteBuildTake(id: string, userId: string, takeId: string, revision: unknown): Yue2BuildSession {
  const stored = load(id, userId);
  checkRevision(stored, revision);
  if (!stored.takes.some(t => t.id === takeId)) throw new TakesError('No such take.');
  if (stored.kept.includes(takeId)) throw new TakesError('That take is part of the build; undo back past it first.');
  if (stored.takes.some(t => t.cropOf === takeId && stored.kept.includes(t.id))) {
    throw new TakesError('A crop of that take is part of the build; undo the crop first.');
  }
  stored.takes = stored.takes.filter(t => t.id !== takeId);
  save(stored);
  for (const file of [`${takeId}.wav`, `${takeId}.codes.json`]) {
    try { fs.unlinkSync(path.join(sessionDir(id), file)); } catch { /* already gone */ }
  }
  return view(stored);
}

/** A 16-bit PCM WAV cut to its first `seconds`; chunks after the data are dropped. */
export function cropWav(wav: Buffer, seconds: number): Buffer {
  let off = 12, frameBytes = 4, rate = 48000;
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4), len = wav.readUInt32LE(off + 4);
    if (id === 'fmt ') { frameBytes = 2 * wav.readUInt16LE(off + 10); rate = wav.readUInt32LE(off + 12); }
    if (id === 'data') {
      const keep = Math.min(Math.round(seconds * rate) * frameBytes, Math.floor(Math.min(len, wav.length - off - 8) / frameBytes) * frameBytes);
      const out = Buffer.from(wav.subarray(0, off + 8 + keep));
      out.writeUInt32LE(keep, off + 4);
      out.writeUInt32LE(out.length - 8, 4);
      return out;
    }
    off += 8 + len + (len % 2);
  }
  throw new TakesError('The take\'s audio has no data chunk.', 409);
}

type CropMode = 'regenerate' | 'advance';

/** What a take cut at codec frame `frame` covers. The cut lies in the part the
 *  take composed. Cut inside an occurrence, `mode` says whether the next take
 *  composes that occurrence again from the cut ('regenerate') or starts the
 *  one after it there ('advance'); refused without one. A cut at an
 *  occurrence's start, or past the next one's start (the overrun the next
 *  take would replace anyway), needs no choice. */
export function cropPlan(take: Pick<Yue2Take, 'from' | 'to' | 'frames' | 'starts' | 'prefix'>, frame: unknown, mode: unknown,
  label: (occurrence: number) => string = i => `section ${i + 1}`): { to: number; starts: Array<number | null>; resume?: number; prefix: number } {
  const prefix = take.prefix ?? take.starts[take.from] ?? 0;
  if (typeof frame !== 'number' || !Number.isInteger(frame) || frame <= prefix || frame >= take.frames) {
    throw new TakesError(`Crop between ${(prefix / YUE2_FPS).toFixed(2)} s and ${(take.frames / YUE2_FPS).toFixed(2)} s: inside the part this take composed.`);
  }
  // The occurrence the cut falls in: the last one known to start at or before it.
  let k = take.from;
  for (let i = take.from + 1; i <= Math.min(take.to + 1, take.starts.length - 1); i++) {
    const s = take.starts[i];
    if (s !== null && s !== undefined && s <= frame) k = i;
  }
  let to = k - 1, resume: number | undefined;
  if (k <= take.to && take.starts[k] !== frame) {
    if (mode === 'advance') to = k;
    else if (mode === 'regenerate') resume = frame;
    else throw new TakesError(`The cut falls inside ${label(k)}: choose whether the next take composes it again or moves on.`);
  }
  if (k > take.to) to = take.to;
  const starts = take.starts.map((s, i) => (i > to + 1 ? null : s));
  if (to === k && k + 1 < starts.length) starts[k + 1] = frame;
  return { to, starts, resume, prefix };
}

/** Crops the last kept take at codec frame `frame` (cropPlan). The crop is a
 *  new take that replaces it as the spine, so the original keeps its audio
 *  and codes; `frame` null puts the original back. A later crop always cuts
 *  the original. Takes made from the replaced spine stop being keepable
 *  through their parent and come back with it. Crops leave the revision. */
export function cropBuildTake(id: string, userId: string, takeId: string, revision: unknown, frame: unknown, mode: unknown): Yue2BuildSession {
  const stored = load(id, userId);
  checkRevision(stored, revision);
  if (stored.pending.length) throw new TakesError('Wait for the pending takes or cancel them first.', 409);
  const spine = stored.takes.find(t => t.id === stored.kept.at(-1));
  if (!spine || spine.id !== takeId) throw new TakesError('Only the last kept take can be cropped.', 409);
  const base = stored.takes.find(t => t.id === spine.cropOf) ?? spine;
  // Reaching past the spine re-adds occurrences a regenerate crop reopened,
  // which the plan or lyrics may have changed since: keep's own rules apply.
  const refuseReach = (take: ArrangedTake) => {
    const refusal = take.to > spine.to ? keepRefusal({ ...stored, kept: stored.kept.slice(0, -1) }, take) : null;
    if (refusal) throw new TakesError(`${refusal} Its cut part no longer matches the build: crop within what is built, or generate that section again.`, 409);
  };
  let next: ArrangedTake;
  if (frame === null) {
    if (base === spine) throw new TakesError(spine.cropOf ? 'The uncropped take was deleted.' : 'That take is not cropped.', 409);
    refuseReach(base);
    next = base;
  } else {
    const name = (i: number) => stored.arrangement.sections.find(s => s.id === stored.arrangement.plan[i]?.section)?.label ?? `section ${i + 1}`;
    const plan = cropPlan(base, frame, mode, name);
    const cut = frame as number;
    const occurrences = base.occurrences.slice(0, Math.max(0, plan.to - base.from + 1));
    refuseReach({ ...base, to: plan.to, occurrences });
    const same = stored.takes.find(t => t.cropOf === base.id && t.frames === cut && t.to === plan.to && t.resume === plan.resume);
    if (same) next = same;
    else {
      const cropId = randomUUID().slice(0, 8);
      const wav = cropWav(fs.readFileSync(path.join(sessionDir(id), `${base.id}.wav`)), cut / YUE2_FPS);
      const codes = (JSON.parse(fs.readFileSync(codesFile(id, base.id), 'utf8')) as number[]).slice(0, cut);
      fs.writeFileSync(path.join(sessionDir(id), `${cropId}.wav`), wav);
      fs.writeFileSync(codesFile(id, cropId), JSON.stringify(codes));
      next = { ...base, id: cropId, audioUrl: `/audio/takes/${id}/${cropId}.wav`, frames: cut, to: plan.to, starts: plan.starts,
        prefix: plan.prefix, resume: plan.resume, cropOf: base.cropOf ?? base.id, occurrences,
        peaks: wavPeaks(wav, Math.max(0, plan.prefix / YUE2_FPS - (plan.prefix ? LEAD_IN_S : 0)), cut / YUE2_FPS) };
      stored.takes.push(next);
    }
  }
  stored.kept[stored.kept.length - 1] = next.id;
  // A replaced crop goes, unless takes were made from it.
  const drop = spine.cropOf && spine !== next && !stored.takes.some(t => t.parent === spine.id);
  if (drop) stored.takes = stored.takes.filter(t => t !== spine);
  save(stored);
  if (drop) for (const file of [`${spine.id}.wav`, `${spine.id}.codes.json`]) {
    try { fs.unlinkSync(path.join(sessionDir(id), file)); } catch { /* already gone */ }
  }
  return view(stored);
}

/** What the Save song render sends in place of the job's own score and
 *  lyrics: the spine's whole codec stream under the arranged prompt it was
 *  composed with. */
export function buildSessionRender(id: string, userId: string):
  Pick<Yue2SynthRequest, 'codec_ids' | 'abc' | 'lyrics' | 'lyric_schedule'> {
  const stored = load(id, userId);
  const spine = stored.kept.at(-1);
  if (!spine) throw new TakesError('Keep a take before saving the song.');
  const { request } = arranged(stored);
  return { codec_ids: JSON.parse(fs.readFileSync(codesFile(id, spine), 'utf8')) as number[],
    abc: request.abc, lyrics: request.lyrics, lyric_schedule: request.lyric_schedule };
}

const MAX_OCCURRENCES = 100;

/** Replaces the occurrences not yet built (coverArrangement's editPlan):
 *  `upcoming` lists source section ids (s0...) for new occurrences, or
 *  existing upcoming occurrence ids (o3...) to keep their identity, and
 *  `finished` says the plan ends the song. Kept occurrences stay. Every take
 *  not yet kept becomes ineligible through the revision. */
export function editBuildPlan(id: string, userId: string, revision: unknown, upcoming: unknown, finished: unknown): Yue2BuildSession {
  const stored = load(id, userId);
  checkRevision(stored, revision);
  if (stored.pending.length) throw new TakesError('Wait for the pending takes or cancel them first.', 409);
  if (!Array.isArray(upcoming) || upcoming.some(x => typeof x !== 'string') || typeof finished !== 'boolean') {
    throw new TakesError('upcoming must list section or occurrence ids, and finished must be true or false.');
  }
  let arrangement;
  try { arrangement = editPlan(stored, upcoming as string[], finished); }
  catch (err) { throw new TakesError((err as Error).message, 409); }
  if (arrangement.plan.length > MAX_OCCURRENCES) throw new TakesError(`An arrangement holds at most ${MAX_OCCURRENCES} sections.`);
  const same = (a: typeof arrangement) => JSON.stringify([a.plan, a.finished]);
  if (same(arrangement) === same(stored.arrangement)) return view(stored);
  arranged({ request: stored.request, arrangement });
  stored.arrangement = arrangement;
  stored.revision++;
  save(stored);
  return view(stored);
}

/** Why `lyrics` cannot be sung by a build, or null. Text above the first tag
 *  and malformed tag lines would be sung as words or dropped silently. */
export function lyricsProblem(lyrics: unknown): string | null {
  if (typeof lyrics !== 'string') return 'Lyrics must be text.';
  if (lyrics.length > MAX_LYRICS) return `Lyrics are limited to ${MAX_LYRICS.toLocaleString('en-US')} characters.`;
  if (!lyrics.trim()) return 'Lyrics cannot be empty.';
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(lyrics)) return 'Lyrics contain control characters.';
  const lines = lyrics.replace(/\r\n?/g, '\n').split('\n');
  const bad = lines.findIndex(line => { const t = line.trim(); return t.startsWith('[') && !/^\[[^\]\n]*\S[^\]\n]*\]$/.test(t); });
  if (bad >= 0) return `Line ${bad + 1} looks like a section tag but is not one; use [verse], [chorus] and so on.`;
  const blocks = splitLyricBlocks(lyrics);
  if (!blocks.some(b => b.tag)) return 'Lyrics need section tags such as [verse].';
  if (blocks[0].tag === null) return 'Put a section tag above the first line of lyrics.';
  if (blocks.some(b => (b.tag?.length ?? 0) > 40)) return 'A section tag is longer than 40 characters.';
  return null;
}

/** Why the lyrics of the sections already built cannot change, or null: the
 *  kept audio was composed under them. Later text is free. */
function builtLyricsRefusal(stored: Stored, lyrics: string): string | null {
  const built = nextOccurrence(stored);
  if (!built) return null;
  const abc = stored.request.abc ?? '', old = stored.request.lyrics ?? '';
  try {
    // The kept occurrences, in plan order: same text and same lyric spans.
    const plan = planSections(stored.arrangement).slice(0, built);
    const kept = (text: string) => { const c = composeArrangement(abc, text, plan); return JSON.stringify([c.lyrics, c.occurrences.map(o => o.lyric)]); };
    const same = kept(old) === kept(lyrics);
    return same ? null : 'The lyrics of built sections are locked; undo back to a section to change its lyrics.';
  } catch { return 'These lyrics do not fit the score; keep the section tags the score expects.'; }
}

/** Replaces the lyrics of the next takes. `toRequest` rebuilds the engine
 *  request from the new params the way a render would, so the stored params
 *  (what Save song submits) and the request agree. Kept audio stays; every
 *  take not yet kept becomes ineligible through the revision. Nothing here
 *  touches a dataset. */
export function applyBuildLyrics(id: string, userId: string, revision: unknown, lyrics: unknown,
  toRequest: (params: Record<string, unknown>) => Yue2SynthRequest): Yue2BuildSession {
  const stored = load(id, userId);
  checkRevision(stored, revision);
  if (stored.pending.length) throw new TakesError('Wait for the pending takes or cancel them first.', 409);
  if (stored.params.instrumental === true) throw new TakesError('An instrumental build has no lyrics.');
  const problem = lyricsProblem(lyrics);
  if (problem) throw new TakesError(problem);
  const text = (lyrics as string).replace(/\r\n?/g, '\n');
  const params = { ...stored.params, lyrics: text };
  const request = plainRequest(toRequest(params));
  if (request.abc !== stored.request.abc) throw new TakesError('The score changed; start a new build.', 409);
  if (request.lyrics === stored.request.lyrics && text === stored.params.lyrics) return view(stored);
  const locked = builtLyricsRefusal(stored, request.lyrics ?? '');
  if (locked) throw new TakesError(locked, 409);
  stored.params = params;
  stored.request = request;
  stored.revision++;
  stored.arrangement = { ...stored.arrangement, sections: sourceSections(request.abc!, request.lyrics ?? '') };
  save(stored);
  return view(stored);
}

/** Replaces a cover build's settings before its first keep: voices, tempo,
 *  key (with its keyShift), condition strength and AR strength, as the
 *  one-shot cover params carry them. `toRequest` rebuilds the request the way
 *  a render would and validates the params, so params (what Save song
 *  submits) and request agree. A rewritten score keeps the plan when its
 *  sections match, else the plan returns to the score's order. Every take not
 *  yet kept becomes ineligible through the revision. After a keep the kept
 *  audio was composed under these settings: a change needs a fresh build. */
export function applyBuildSettings(id: string, userId: string, revision: unknown, settings: unknown,
  toRequest: (params: Record<string, unknown>) => Yue2SynthRequest): Yue2BuildSession {
  const stored = load(id, userId);
  checkRevision(stored, revision);
  if (stored.pending.length) throw new TakesError('Wait for the pending takes or cancel them first.', 409);
  if (stored.kept.length) throw new TakesError('The kept sections were built with these settings; start a fresh build to change them.', 409);
  const cover = stored.params.yue2Cover;
  if (!cover || typeof cover !== 'object') throw new TakesError('Only a cover build has these settings.');
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new TakesError('settings are required.');
  const { voices, tempo, key, keyShift, cfgScale, arStrength } = settings as Record<string, unknown>;
  if (typeof arStrength !== 'number' || !Number.isFinite(arStrength) || arStrength < 0 || arStrength > 10) {
    throw new TakesError('AR strength must be a number from 0 to 10.');
  }
  const nextCover: Record<string, unknown> = { ...cover, voices, tempo, key, cfgScale };
  if (keyShift === undefined) delete nextCover.keyShift; else nextCover.keyShift = keyShift;
  const params = { ...stored.params, yue2Cover: nextCover, yue2CfgScale: cfgScale,
    yue2Pick: { ...(stored.params.yue2Pick as Record<string, unknown> | undefined), lmAdapterArScale: arStrength } };
  if (JSON.stringify(params) === JSON.stringify(stored.params)) return view(stored);
  const request = plainRequest(toRequest(params));
  const sections = scoreSections(request.abc ?? '').map(s => ({ label: s.label.trim(), startBar: s.startBar }));
  if (!sections.length) throw new TakesError('The score has no section labels.');
  const source = sourceSections(request.abc!, request.lyrics ?? '');
  let arrangement = stored.arrangement;
  if (JSON.stringify(source) !== JSON.stringify(arrangement.sections)) {
    const n = arrangement.nextOccurrence;
    arrangement = { sections: source, plan: source.map((s, i) => ({ id: `o${n + i}`, section: s.id })), nextOccurrence: n + source.length, finished: true };
  }
  arranged({ request, arrangement });
  Object.assign(stored, { params, request, sections, arrangement, revision: stored.revision + 1 });
  save(stored);
  return view(stored);
}
