// YuE2 section takes: rebuild a cover section by section from a render's
// codec stream. A session starts from a library render that saved its codes
// (<song>.semantic.json) and request (<song>.yue2-request.json). Its "current"
// take is the spine: a section's takes resume the spine's codes up to where
// that section starts in the spine's own audio (codec_ids +
// continue_codec_ids), each with its own seed, and stop shortly after the
// section ends. Using a take makes it the spine. Section starts come from
// aligning the lyrics on each take's audio, because the score clock drifts
// from what the composer actually sang. Takes are WAVs under
// <audioDir>/takes/<session>/, so the /audio static route plays them.

import fs from 'node:fs';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getDb } from '../db/database.js';
import { aceClient } from './aceClient.js';
import { runOnGpuLane } from './generation/gpuLane.js';
import { yue2Align, yue2Synth, type Yue2SynthRequest } from './backends/yue2/client.js';
import { sectionKind } from './backends/yue2/coverDrift.js';
import { splitLyricBlocks } from './backends/yue2/sectionMatch.js';
import type { Yue2AlignWord } from './backends/yue2/align.js';
import { scoreSections } from './backends/yue2/scoreSections.js';
import { scoreBarClock } from './backends/yue2/scoreClock.js';

/** Codec frames per second (the composer's frame clock). */
export const YUE2_FPS = 25;
/** A take runs this much past its section's score length before stopping. */
const TAKE_SLACK = 1.3;
const TAKE_SLACK_FRAMES = 4 * YUE2_FPS;
const MAX_TAKES = 6;

export class TakesError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export interface Yue2Take {
  id: string;
  /** Section the take was generated from (0 for the base render). */
  section: number;
  seed: number | null;
  /** Played through /audio. */
  audioUrl: string;
  frames: number;
  /** The frame each section starts at in this take's audio, or null where
   *  the take does not reach it or no start was found. */
  starts: Array<number | null>;
  /** Ran to the end of the song rather than stopping after its section. */
  toEnd: boolean;
}

export interface Yue2TakesSession {
  id: string;
  userId: string;
  songId: string;
  title: string;
  sections: Array<{ label: string; startBar: number }>;
  takes: Yue2Take[];
  spine: string;
  /** Takes still rendering, by section. */
  pending: Array<{ section: number; count: number }>;
  error: string | null;
}

interface Stored extends Yue2TakesSession { request: Yue2SynthRequest; scoreStarts: number[] }

const root = () => path.join(config.data.audioDir, 'takes');
const sessionDir = (id: string) => path.join(root(), id);
const sessionFile = (id: string) => path.join(sessionDir(id), 'session.json');
const codesFile = (id: string, take: string) => path.join(sessionDir(id), `${take}.codes.json`);

function load(id: string, userId: string): Stored {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new TakesError('Takes session not found', 404);
  let stored: Stored;
  try { stored = JSON.parse(fs.readFileSync(sessionFile(id), 'utf8')) as Stored; }
  catch { throw new TakesError('Takes session not found', 404); }
  if (stored.userId !== userId) throw new TakesError('Takes session not found', 404);
  return stored;
}

function save(stored: Stored): void {
  const tmp = `${sessionFile(stored.id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stored));
  fs.renameSync(tmp, sessionFile(stored.id));
}

const view = ({ request: _r, scoreStarts: _s, ...rest }: Stored): Yue2TakesSession => rest;

/** Where each section starts in a take, from the lyrics aligned on its audio:
 *  halfway through the gap before the section's first sung word. A section
 *  pairs with the next lyric block of its kind, in order. Sections with no
 *  sung block (intro, solo) start just after the previous block's last word.
 *  Section 0 starts at 0. Word times are read as the section matcher reads
 *  them (median of the first three starts; squashed words mean not sung
 *  there), not by the aligner's scores, which read near zero on a full mix. */
/** For each score section, the index of its lyric block (non-empty blocks,
 *  in order, the next one of the section's kind), or null. */
function pairBlocks(abc: string, lyrics: string): Array<number | null> {
  const blocks = splitLyricBlocks(lyrics).filter(block => block.body.trim());
  let next = 0;
  return scoreSections(abc).map(section => {
    const at = blocks.findIndex((block, i) => i >= next && !!block.tag && sectionKind(block.tag) === sectionKind(section.label));
    if (at < 0) return null;
    next = at + 1;
    return at;
  });
}

export function sectionStarts(abc: string, lyrics: string, words: Yue2AlignWord[], frames: number): Array<number | null> {
  const blocks = splitLyricBlocks(lyrics).filter(block => block.body.trim());
  const timed = (block: { start: number; end: number }) => {
    const own = words.filter(word => word.char0 >= block.start && word.char0 < block.end &&
      Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start);
    if (!own.length) return null;
    const durations = own.map(word => word.end - word.start).sort((a, b) => a - b);
    if (durations[Math.floor(durations.length / 2)] < 0.04) return null;
    const firsts = own.slice(0, 3).map(word => word.start).sort((a, b) => a - b);
    return { start: firsts[Math.floor(firsts.length / 2)], end: Math.max(...own.map(word => word.end)) };
  };
  const pairs = pairBlocks(abc, lyrics);
  // The end of the last sung word before each section, unless a sung section
  // in between could not be placed (then what follows it is unknown too).
  let lastEnd: number | null = null;
  let lastStart = 0;
  return pairs.map((at, i) => {
    const span = at === null ? null : timed(blocks[at]);
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

/** The lyrics up to the end of the block paired with section `through`. */
export function lyricsThrough(abc: string, lyrics: string, through: number): string {
  const blocks = splitLyricBlocks(lyrics).filter(block => block.body.trim());
  const pairs = pairBlocks(abc, lyrics);
  if (through >= pairs.length - 1) return lyrics;
  const at = pairs.slice(0, through + 1).filter(i => i !== null).at(-1);
  return at === undefined || at === null ? lyrics : Array.from(lyrics).slice(0, blocks[at].end).join('');
}

// A take that stops early is aligned against the lyrics only up to the
// block of the section after its own: words it never sang would be squashed
// into its tail and drag the earlier ones with them.
async function alignStarts(stored: Stored, wav: Buffer, frames: number, through?: number): Promise<Array<number | null>> {
  const lyrics = (stored.request.lyrics ?? '').replace(/\r\n?/g, '\n');
  if (!lyrics.trim()) return stored.sections.map((_, i) => (i === 0 ? 0 : null));
  const text = through === undefined ? lyrics : lyricsThrough(stored.request.abc ?? '', lyrics, through);
  const aligned = await yue2Align(wav, text);
  const starts = sectionStarts(stored.request.abc ?? '', text, aligned.words, frames);
  return stored.sections.map((_, i) => starts[i] ?? null);
}

async function waitJob(jobId: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    const status = await aceClient.pollJob(jobId);
    if (status.status === 'done') return;
    if (status.status === 'failed' || status.status === 'cancelled') {
      throw new Error(`YuE2 take ${status.status}${(status as { error?: string }).error ? `: ${(status as { error?: string }).error}` : ''}`);
    }
    if (Date.now() - started > 15 * 60_000) {
      await aceClient.cancelJob(jobId).catch(() => {});
      throw new Error('YuE2 take timed out after 15 minutes');
    }
    await new Promise(r => setTimeout(r, 750));
  }
}

/** Starts a session from a library YuE2 render that saved its codes. */
export async function createTakesSession(songId: string, userId: string): Promise<Yue2TakesSession> {
  const row = getDb().prepare('SELECT id, user_id, title, audio_url FROM songs WHERE id = ?').get(songId) as
    { id: string; user_id: string; title: string; audio_url: string } | undefined;
  if (!row || row.user_id !== userId) throw new TakesError('Song not found', 404);
  const file = path.basename(row.audio_url || '');
  if (row.audio_url !== `/audio/${file}` || !/^[\w-]+\.wav$/i.test(file)) throw new TakesError('This song has no local WAV.');
  const base = path.join(config.data.audioDir, file.replace(/\.wav$/i, ''));
  let request: Yue2SynthRequest, codes: number[];
  try {
    request = (JSON.parse(fs.readFileSync(`${base}.yue2-request.json`, 'utf8')) as { request: Yue2SynthRequest }).request;
    codes = JSON.parse(fs.readFileSync(`${base}.semantic.json`, 'utf8')) as number[];
  } catch {
    throw new TakesError('This render has no saved codec stream. Render the cover again to use section takes.', 409);
  }
  if (!request.abc || !codes.length) throw new TakesError('This render has no score or codec stream to resume.', 409);
  const sections = scoreSections(request.abc).map(s => ({ label: s.label.trim(), startBar: s.startBar }));
  if (sections.length < 2) throw new TakesError('The score needs at least two sections for section takes.');
  const bars = scoreBarClock(request.abc);
  const id = randomUUID();
  fs.mkdirSync(sessionDir(id), { recursive: true });
  const wav = fs.readFileSync(`${base}.wav`);
  fs.copyFileSync(`${base}.wav`, path.join(sessionDir(id), 'base.wav'));
  fs.writeFileSync(codesFile(id, 'base'), JSON.stringify(codes));
  const stored: Stored = {
    id, userId, songId, title: row.title, sections, takes: [], spine: 'base', pending: [], error: null,
    request, scoreStarts: sections.map(s => Math.round((bars[s.startBar - 1]?.start ?? 0) * YUE2_FPS)),
  };
  const starts = await runOnGpuLane(() => alignStarts(stored, wav, codes.length),
    { label: 'yue2 takes: find sections', family: 'yue2' });
  stored.takes.push({ id: 'base', section: 0, seed: null, audioUrl: `/audio/takes/${id}/base.wav`,
    frames: codes.length, starts, toEnd: true });
  save(stored);
  return view(stored);
}

export function getTakesSession(id: string, userId: string): Yue2TakesSession {
  return view(load(id, userId));
}

/** Queues `count` takes of `section`, resumed from the spine. Returns at
 *  once; the session lists them as they finish. */
export function generateTakes(id: string, userId: string, section: number, count: number, toEnd: boolean): Yue2TakesSession {
  const stored = load(id, userId);
  if (!Number.isInteger(section) || section < 0 || section >= stored.sections.length) throw new TakesError('No such section.');
  if (!Number.isInteger(count) || count < 1 || count > MAX_TAKES) throw new TakesError(`Generate 1 to ${MAX_TAKES} takes at a time.`);
  const spine = stored.takes.find(t => t.id === stored.spine)!;
  const from = spine.starts[section];
  if (from === null || from === undefined) throw new TakesError('The current take does not reach this section yet.');
  const codes = JSON.parse(fs.readFileSync(codesFile(id, spine.id), 'utf8')) as number[];
  const prefix = codes.slice(0, from);
  const last = section + 1 >= stored.sections.length;
  const scoreLength = last ? 0 : stored.scoreStarts[section + 1] - stored.scoreStarts[section];
  const cap = toEnd || last ? undefined : from + Math.round(Math.max(scoreLength, 1) * TAKE_SLACK) + TAKE_SLACK_FRAMES;
  stored.pending.push({ section, count });
  stored.error = null;
  save(stored);

  void (async () => {
    for (let n = 0; n < count; n++) {
      const seed = randomInt(1, 2 ** 31 - 1);
      try {
        await runOnGpuLane(async () => {
          const req: Yue2SynthRequest = { ...stored.request, seed, codec_ids: prefix, continue_codec_ids: true,
            ...(cap ? { preview_max_frames: cap } : {}) } as Yue2SynthRequest;
          delete (req as { semantic_retries?: number }).semantic_retries;
          const sub = await yue2Synth(req);
          await waitJob(sub.job_id);
          const status = await aceClient.pollJob(sub.job_id) as { tracks?: Array<{ semantic_ids?: number[] }> };
          const ids = status.tracks?.[0]?.semantic_ids ?? [];
          const body = await aceClient.getJobResult(sub.job_id);
          if (!body.ok) throw new Error(`YuE2 take result fetch failed (${body.status})`);
          const wav = Buffer.from(await body.arrayBuffer());
          const takeId = randomUUID().slice(0, 8);
          fs.writeFileSync(path.join(sessionDir(id), `${takeId}.wav`), wav);
          fs.writeFileSync(codesFile(id, takeId), JSON.stringify(ids));
          const starts = await alignStarts(stored, wav, ids.length, toEnd || last ? undefined : section + 1);
          // The kept frames are the spine's; only sections from here are new.
          for (let i = 0; i <= section; i++) starts[i] = spine.starts[i];
          const fresh = load(id, userId);
          fresh.takes.push({ id: takeId, section, seed, audioUrl: `/audio/takes/${id}/${takeId}.wav`,
            frames: ids.length, starts, toEnd: toEnd || last });
          save(fresh);
        }, { label: `yue2 take: ${stored.sections[section].label}`, family: 'yue2' });
      } catch (err) {
        const fresh = load(id, userId);
        fresh.error = (err as Error).message;
        save(fresh);
      }
    }
    const fresh = load(id, userId);
    const at = fresh.pending.findIndex(p => p.section === section && p.count === count);
    if (at >= 0) fresh.pending.splice(at, 1);
    save(fresh);
  })();
  return view(stored);
}

/** Makes a take the spine that later sections resume from. */
export function useTake(id: string, userId: string, takeId: string): Yue2TakesSession {
  const stored = load(id, userId);
  if (!stored.takes.some(t => t.id === takeId)) throw new TakesError('No such take.');
  stored.spine = takeId;
  save(stored);
  return view(stored);
}

/** Adds a take to the library as a new song, copying the source render's
 *  details. Post-processing is not rerun. */
export function saveTakeToLibrary(id: string, userId: string, takeId: string): { songId: string; audioUrl: string } {
  const stored = load(id, userId);
  const take = stored.takes.find(t => t.id === takeId);
  if (!take) throw new TakesError('No such take.');
  const db = getDb();
  const src = db.prepare('SELECT * FROM songs WHERE id = ?').get(stored.songId) as Record<string, unknown> | undefined;
  if (!src) throw new TakesError('The source song is gone.', 404);
  const filename = `${randomUUID()}.wav`;
  fs.copyFileSync(path.join(sessionDir(id), `${take.id}.wav`), path.join(config.data.audioDir, filename));
  fs.copyFileSync(codesFile(id, take.id), path.join(config.data.audioDir, filename.replace(/\.wav$/, '.semantic.json')));
  fs.writeFileSync(path.join(config.data.audioDir, filename.replace(/\.wav$/, '.yue2-request.json')),
    JSON.stringify({ request: stored.request, seed: take.seed }));
  const songId = randomUUID();
  const params = (() => { try { return JSON.parse(String(src.generation_params || '{}')); } catch { return {}; } })();
  params.yue2Takes = { session: id, take: take.id, fromSong: stored.songId };
  const title = `${String(src.title || 'Cover')} (takes)`;
  db.prepare(`INSERT INTO songs (id, user_id, title, lyrics, style, caption, audio_url, duration, bpm, key_scale,
      time_signature, tags, dit_model, generation_params, mastered_audio_url, latent_url, quality_scores,
      noadapter_audio_url, backend) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    songId, userId, title, src.lyrics ?? '', src.style ?? '', src.caption ?? '', `/audio/${filename}`,
    Math.round((take.frames / YUE2_FPS) * 10) / 10, src.bpm ?? 0, src.key_scale ?? '', src.time_signature ?? '',
    src.tags ?? '[]', src.dit_model ?? 'yue2', JSON.stringify(params), '', '', '', '', 'yue2');
  return { songId, audioUrl: `/audio/${filename}` };
}
