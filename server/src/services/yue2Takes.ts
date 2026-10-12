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
// /audio static route plays the takes.

import fs from 'node:fs';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { config } from '../config.js';
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
/** A take runs this much past its sections' score length before stopping. */
const TAKE_SLACK = 1.3;
const TAKE_SLACK_FRAMES = 4 * YUE2_FPS;
const MAX_TAKES = 6;

export class TakesError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export interface Yue2Take {
  id: string;
  /** The sections it composed, 0-based and inclusive. */
  from: number;
  to: number;
  seed: number;
  /** Played through /audio. */
  audioUrl: string;
  frames: number;
  /** The frame each section starts at in this take's audio, or null where
   *  the take does not reach it or no start was found. */
  starts: Array<number | null>;
}

export interface Yue2BuildSession {
  id: string;
  sections: Array<{ label: string; startBar: number }>;
  takes: Yue2Take[];
  /** Kept takes, oldest first; the last is the spine. */
  kept: string[];
  /** Takes still rendering. */
  pending: Array<{ from: number; to: number; count: number }>;
  error: string | null;
  /** The params a Save song render submits, as the session was started. */
  params: Record<string, unknown>;
}

interface Stored extends Yue2BuildSession { userId: string; request: Yue2SynthRequest; scoreStarts: number[] }

const root = () => path.join(config.data.audioDir, 'takes');
const sessionDir = (id: string) => path.join(root(), id);
const sessionFile = (id: string) => path.join(sessionDir(id), 'session.json');
const codesFile = (id: string, take: string) => path.join(sessionDir(id), `${take}.codes.json`);

function load(id: string, userId: string): Stored {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new TakesError('Build session not found', 404);
  let stored: Stored;
  try { stored = JSON.parse(fs.readFileSync(sessionFile(id), 'utf8')) as Stored; }
  catch { throw new TakesError('Build session not found', 404); }
  if (stored.userId !== userId) throw new TakesError('Build session not found', 404);
  return stored;
}

function save(stored: Stored): void {
  const tmp = `${sessionFile(stored.id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stored));
  fs.renameSync(tmp, sessionFile(stored.id));
}

const view = ({ request: _r, scoreStarts: _s, userId: _u, ...rest }: Stored): Yue2BuildSession => rest;

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

/** Where each section starts in a take, from the lyrics aligned on its audio:
 *  halfway through the gap before the section's first sung word. A section
 *  pairs with the next lyric block of its kind, in order. Sections with no
 *  sung block (intro, solo) start just after the previous block's last word.
 *  Section 0 starts at 0. Word times are read as the section matcher reads
 *  them (median of the first three starts; squashed words mean not sung
 *  there), not by the aligner's scores, which read near zero on a full mix. */
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
  // Past `through` the lyrics were cut, so those sections read as unsung.
  return stored.sections.map((_, i) => (through !== undefined && i > through ? null : starts[i] ?? null));
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

/** Starts a build session for a cover's request. */
export function createBuildSession(params: Record<string, unknown>, request: Yue2SynthRequest, userId: string): Yue2BuildSession {
  if (!request.abc) throw new TakesError('Build by section needs an approved score.');
  if ((request.cfg_scale ?? 1) !== 1) throw new TakesError('Build by section needs CFG 1 for now; set the cover CFG to 1.');
  const sections = scoreSections(request.abc).map(s => ({ label: s.label.trim(), startBar: s.startBar }));
  if (!sections.length) throw new TakesError('The score has no section labels.');
  // One song per take: the composer cannot resume a prefix across a batch.
  request = { ...request };
  delete request.lm_batch_size;
  delete request.synth_batch_size;
  delete request.songs;
  delete request.seed;
  const bars = scoreBarClock(request.abc!);
  const id = randomUUID();
  fs.mkdirSync(sessionDir(id), { recursive: true });
  const stored: Stored = {
    id, userId, sections, takes: [], kept: [], pending: [], error: null, params, request,
    scoreStarts: sections.map(s => Math.round((bars[s.startBar - 1]?.start ?? 0) * YUE2_FPS))
      .concat(Math.round((bars.at(-1)?.end ?? 0) * YUE2_FPS)),
  };
  save(stored);
  return view(stored);
}

export function getBuildSession(id: string, userId: string): Yue2BuildSession {
  return view(load(id, userId));
}

/** The first section not yet built: the one after the spine's last. */
function nextSection(stored: Stored): number {
  const spine = stored.takes.find(t => t.id === stored.kept.at(-1));
  return spine ? spine.to + 1 : 0;
}

/** Queues `count` takes of sections [next, to], resumed from the spine.
 *  Returns at once; the session lists the takes as they finish. */
export function generateBuildTakes(id: string, userId: string, to: number, count: number): Yue2BuildSession {
  const stored = load(id, userId);
  const from = nextSection(stored);
  if (!Number.isInteger(to) || to < from || to >= stored.sections.length) throw new TakesError('Pick a section from the next one to build onward.');
  if (!Number.isInteger(count) || count < 1 || count > MAX_TAKES) throw new TakesError(`Generate 1 to ${MAX_TAKES} takes at a time.`);
  const spine = stored.takes.find(t => t.id === stored.kept.at(-1));
  const start = spine ? spine.starts[from] : 0;
  if (start === null || start === undefined) throw new TakesError('The kept take does not reach the next section. Undo the keep and try another take.');
  const prefix = spine ? (JSON.parse(fs.readFileSync(codesFile(id, spine.id), 'utf8')) as number[]).slice(0, start) : [];
  const last = to + 1 >= stored.sections.length;
  const length = stored.scoreStarts[to + 1] - stored.scoreStarts[from];
  const cap = last ? undefined : start + Math.round(Math.max(length, 1) * TAKE_SLACK) + TAKE_SLACK_FRAMES;
  stored.pending.push({ from, to, count });
  stored.error = null;
  save(stored);

  void (async () => {
    for (let n = 0; n < count; n++) {
      const seed = randomInt(1, 2 ** 31 - 1);
      try {
        await runOnGpuLane(async () => {
          const req: Yue2SynthRequest = { ...stored.request, seed,
            ...(prefix.length ? { codec_ids: prefix, continue_codec_ids: true } : {}),
            ...(cap ? { preview_max_frames: cap } : {}) };
          if (prefix.length) delete req.semantic_retries;
          const sub = await yue2Synth(req);
          await waitJob(sub.job_id);
          const status = await aceClient.pollJob(sub.job_id) as { tracks?: Array<{ semantic_ids?: number[] }> };
          const ids = status.tracks?.[0]?.semantic_ids ?? [];
          if (!ids.length) throw new Error('The engine returned no codec stream for the take.');
          const body = await aceClient.getJobResult(sub.job_id);
          if (!body.ok) throw new Error(`YuE2 take result fetch failed (${body.status})`);
          const wav = Buffer.from(await body.arrayBuffer());
          const takeId = randomUUID().slice(0, 8);
          fs.writeFileSync(path.join(sessionDir(id), `${takeId}.wav`), wav);
          fs.writeFileSync(codesFile(id, takeId), JSON.stringify(ids));
          const starts = await alignStarts(stored, wav, ids.length, last ? undefined : to + 1);
          // Before `from` the frames are the spine's own.
          for (let i = 0; i <= from; i++) starts[i] = spine ? spine.starts[i] : i === 0 ? 0 : null;
          // A section the aligner missed inside the take: the score's length on.
          for (let i = from + 1; i <= Math.min(to + 1, stored.sections.length - 1); i++) {
            const estimate = start + stored.scoreStarts[i] - stored.scoreStarts[from];
            if (starts[i] === null && estimate < ids.length) starts[i] = estimate;
          }
          const fresh = load(id, userId);
          fresh.takes.push({ id: takeId, from, to, seed, audioUrl: `/audio/takes/${id}/${takeId}.wav`, frames: ids.length, starts });
          save(fresh);
        }, { label: `yue2 build: ${stored.sections[from].label}–${stored.sections[to].label}`, family: 'yue2' });
      } catch (err) {
        const fresh = load(id, userId);
        fresh.error = (err as Error).message;
        save(fresh);
      }
    }
    const fresh = load(id, userId);
    const at = fresh.pending.findIndex(p => p.from === from && p.to === to && p.count === count);
    if (at >= 0) fresh.pending.splice(at, 1);
    save(fresh);
  })();
  return view(stored);
}

/** Keeps a take of the next sections: it becomes the spine. */
export function keepBuildTake(id: string, userId: string, takeId: string): Yue2BuildSession {
  const stored = load(id, userId);
  const take = stored.takes.find(t => t.id === takeId);
  if (!take) throw new TakesError('No such take.');
  if (take.from !== nextSection(stored)) throw new TakesError('That take is for sections already built; undo back to it first.');
  stored.kept.push(take.id);
  save(stored);
  return view(stored);
}

/** Drops the last kept take, so its sections can be built again. */
export function undoBuildKeep(id: string, userId: string): Yue2BuildSession {
  const stored = load(id, userId);
  stored.kept.pop();
  save(stored);
  return view(stored);
}

/** The spine's whole codec stream, for the Save song render. */
export function buildSessionCodes(id: string, userId: string): number[] {
  const stored = load(id, userId);
  const spine = stored.kept.at(-1);
  if (!spine) throw new TakesError('Keep a take before saving the song.');
  return JSON.parse(fs.readFileSync(codesFile(id, spine), 'utf8')) as number[];
}
