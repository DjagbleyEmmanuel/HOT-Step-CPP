// exportZip.ts - plan the entries for a Library "Export as zip" download.
//
// Pure: takes song rows and a file-exists check, returns which files go in
// the archive and under what names. The route streams them with archiver.

import path from 'path';

export interface ExportSongRow {
  id: string;
  title?: string | null;
  audio_url?: string | null;
}

export interface ZipEntry {
  file: string;
  name: string;
}

function safeName(s: string): string {
  const cleaned = s.replace(/[\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 120) || 'untitled';
}

/** Build zip entries: one per song with an audio file on disk. Names are
 *  the song title plus the file extension, deduplicated with " (2)" etc.
 *  Files are always resolved by basename inside audioDir, so a crafted
 *  audio_url can never escape it. */
export function planZipEntries(
  songs: ExportSongRow[],
  audioDir: string,
  exists: (p: string) => boolean,
): ZipEntry[] {
  const used = new Map<string, number>();
  const out: ZipEntry[] = [];
  for (const s of songs) {
    if (!s.audio_url) continue;
    const base = path.basename(s.audio_url.split('?')[0]);
    if (!base) continue;
    const file = path.join(audioDir, base);
    if (!exists(file)) continue;
    const ext = path.extname(base) || '.wav';
    const stem = safeName(s.title || s.id);
    const key = (stem + ext).toLowerCase();
    const n = (used.get(key) ?? 0) + 1;
    used.set(key, n);
    out.push({ file, name: n === 1 ? `${stem}${ext}` : `${stem} (${n})${ext}` });
  }
  return out;
}
