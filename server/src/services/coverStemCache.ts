// Persistent vocal-stem cache for Cover Studio matching. Keyed on audio
// content, separation level and implementation version, so a byte-identical
// re-upload (new path, new mtime) is a hit. Nothing here is ever evicted.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NoVocalsError } from './training/yue2Stems.js';

/** Bump when separation changes what a stem sounds like; old entries become misses. */
export const COVER_STEM_VERSION = 1;

export type StemSeparator = (audioPath: string, outPath: string, level: number) => Promise<void>;

/** A complete PCM WAV: RIFF/WAVE header whose declared size matches the file. */
function isCompleteWav(file: string): boolean {
  try {
    const head = Buffer.alloc(12);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, head, 0, 12, 0); } finally { fs.closeSync(fd); }
    const size = fs.statSync(file).size;
    return size > 44 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE'
      && head.readUInt32LE(4) + 8 === size;
  } catch { return false; }
}

export function createCoverStemCache(opts: { root: string; level: number; separate: StemSeparator; version?: number }) {
  const version = opts.version ?? COVER_STEM_VERSION;
  const inflight = new Map<string, Promise<string>>();

  async function produce(audioPath: string, base: string): Promise<string> {
    const wav = `${base}.wav`;
    const none = `${base}.no-vocals`;
    // A no-vocals result is cached as a marker and replayed as the same error.
    if (fs.existsSync(none)) throw new NoVocalsError('separation found no vocals');
    if (fs.existsSync(wav)) {
      if (isCompleteWav(wav)) return wav;
      fs.rmSync(wav, { force: true });  // corrupt entry: redo it
    }
    fs.mkdirSync(opts.root, { recursive: true });
    // Unique part name, renamed into place: a cut-short separation is never published.
    const part = `${base}.${process.pid}.${crypto.randomUUID()}.part`;
    try {
      await opts.separate(audioPath, part, opts.level);
      if (!isCompleteWav(part)) throw new Error('separation wrote an incomplete stem');
      fs.renameSync(part, wav);
    } catch (err) {
      fs.rmSync(part, { force: true });
      if (err instanceof NoVocalsError) fs.writeFileSync(none, 'No vocals in this audio.\n');
      throw err;
    }
    return wav;
  }

  return {
    /** The cached vocal stem for this audio; throws NoVocalsError for a silent source. */
    async vocalStem(audioPath: string): Promise<string> {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(audioPath)).digest('hex');
      const base = path.join(opts.root, `${hash}-L${opts.level}-v${version}`);
      let run = inflight.get(base);
      if (!run) {
        run = produce(audioPath, base).finally(() => inflight.delete(base));
        inflight.set(base, run);
      }
      return run;
    },
  };
}
