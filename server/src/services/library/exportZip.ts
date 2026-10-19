// exportZip.ts - plan and stream a Library "Export as zip" download.
//
// planZipEntries is a pure-ish planner: song rows in, the files that go in the
// archive and their names out. streamZip pipes them to the response and tears
// the archive down if the client goes away.

import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import type { Writable } from 'stream';

export const MAX_ZIP_IDS = 500;
/** Total size of the source files in one export. Checked before any header is sent. */
export const MAX_ZIP_BYTES = 256 * 1024 * 1024;

export interface ExportSongRow {
  id: string;
  title?: string | null;
  audio_url?: string | null;
}

export interface ZipEntry {
  file: string;
  name: string;
  size: number;
}

export interface ZipPlan {
  entries: ZipEntry[];
  totalBytes: number;
}

/** Every id must be a nonempty string before it reaches SQLite. */
export function parseZipIds(ids: unknown): string[] | null {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_ZIP_IDS) return null;
  if (!ids.every(id => typeof id === 'string' && id.length > 0)) return null;
  return ids as string[];
}

function safeName(s: string): string {
  const cleaned = s.replace(/[\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 120) || 'untitled';
}

/** Resolve a stored audio_url to a regular file that really lives inside the
 *  audio directory (symlinks and junctions followed), or null. */
function resolveAudioFile(audioRoot: string, audioUrl: string): { file: string; size: number } | null {
  const base = path.basename(audioUrl.split('?')[0]);
  if (!base) return null;
  try {
    const real = fs.realpathSync(path.join(audioRoot, base));
    const rel = path.relative(audioRoot, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const st = fs.statSync(real);
    return st.isFile() ? { file: real, size: st.size } : null;
  } catch {
    return null;
  }
}

/** Build zip entries: one per song with an audio file on disk. Names are the
 *  song title plus the file extension; every final name is reserved
 *  case-folded, so "Track", "track" and an explicit "Track (2)" never collide. */
export function planZipEntries(songs: ExportSongRow[], audioDir: string): ZipPlan {
  let audioRoot: string;
  try { audioRoot = fs.realpathSync(audioDir); } catch { return { entries: [], totalBytes: 0 }; }
  const used = new Set<string>();
  const entries: ZipEntry[] = [];
  let totalBytes = 0;
  for (const s of songs) {
    if (!s.audio_url) continue;
    const found = resolveAudioFile(audioRoot, s.audio_url);
    if (!found) continue;
    const ext = path.extname(found.file) || '.wav';
    const stem = safeName(s.title || s.id);
    let n = 1;
    let name = `${stem}${ext}`;
    while (used.has(name.toLowerCase())) name = `${stem} (${++n})${ext}`;
    used.add(name.toLowerCase());
    entries.push({ file: found.file, name, size: found.size });
    totalBytes += found.size;
  }
  return { entries, totalBytes };
}

/** Pipe the entries into `res` as a zip. If the client disconnects before the
 *  archive ends, abort it so the open file streams are released. */
export function streamZip(
  res: Writable & { destroy(err?: Error): unknown },
  entries: ZipEntry[],
  onError: (err: Error) => void,
): archiver.Archiver {
  const archive = archiver('zip', { zlib: { level: 1 } });
  archive.on('error', err => { onError(err); res.destroy(err); });
  res.on('close', () => { if (!res.writableFinished) archive.abort(); });
  archive.pipe(res);
  for (const e of entries) archive.file(e.file, { name: e.name });
  void archive.finalize();
  return archive;
}
