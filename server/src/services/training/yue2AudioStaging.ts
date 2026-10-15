// YuE2 scans a flat folder. Keep the dataset's included audio and its sidecars
// under the preprocess output: later stages reopen the manifest's source paths.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { TrainingSample } from './types.js';

type AudioSample = Pick<TrainingSample, 'audioPath' | 'relPath' | 'excluded' | 'fileMissing'>;
export const YUE2_AUDIO_EXTS = new Set(['.wav', '.flac', '.mp3', '.ogg', '.m4a']);

export function selectYue2Audio<T extends AudioSample>(samples: T[]) {
  const included = samples.filter(s => !s.excluded && !s.fileMissing);
  const files = included.filter(s => YUE2_AUDIO_EXTS.has(path.extname(s.audioPath).toLowerCase()));
  return {
    files,
    unsupported: included.length - files.length,
    needFfmpeg: files.filter(s => !['.wav', '.mp3'].includes(path.extname(s.audioPath).toLowerCase())).length,
  };
}

const stem = (name: string) => name.slice(0, -path.extname(name).length);

/** Keep unique basenames; flatten colliding paths and protect sidecar stems too.
 * A hash resolves collisions with literal `__` names or flattened paths. */
export function yue2StagedNames(samples: AudioSample[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const s of samples) {
    const key = stem(path.basename(s.audioPath)).toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const result = new Map<string, string>();
  const used = new Set<string>();
  // Reserve unique names before assigning flattened ones.
  for (const s of samples) {
    const name = path.basename(s.audioPath);
    if (counts.get(stem(name).toLowerCase()) === 1) {
      result.set(s.relPath, name);
      used.add(stem(name).toLowerCase());
    }
  }
  for (const s of [...samples].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    if (result.has(s.relPath)) continue;
    const flat = s.relPath.replace(/[/\\]/g, '__');
    let name = flat;
    let attempt = 0;
    while (used.has(stem(name).toLowerCase())) {
      const hash = createHash('sha256').update(`${s.relPath}:${attempt++}`).digest('hex').slice(0, 12);
      name = `${stem(flat)}__${hash}${path.extname(flat)}`;
    }
    used.add(stem(name).toLowerCase());
    result.set(s.relPath, name);
  }
  return result;
}

/** Rebuild only our staging directory. Hardlinks avoid copying large audio;
 * cross-volume or unsupported links fall back to a copy preserving mtime so
 * the engine's source cache stays reusable. Never remove this on job finish. */
export function stageYue2Audio(
  samples: AudioSample[], outDir: string,
  link: (source: string, destination: string) => void = fs.linkSync,
): string {
  const output = path.resolve(outDir);
  const dir = path.resolve(output, '_staged_audio');
  if (path.dirname(dir) !== output) throw new Error('Invalid YuE2 staging directory');
  const files = selectYue2Audio(samples).files;
  if (files.length === 0) throw new Error('Dataset has no included YuE2 audio files');
  for (const s of files) {
    const relative = path.relative(dir, path.resolve(s.audioPath));
    if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
      throw new Error('YuE2 staging cannot contain its own source audio');
    }
  }
  const names = yue2StagedNames(files);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const put = (source: string, destination: string) => {
    try { link(source, destination); }
    catch {
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      const st = fs.statSync(source);
      fs.utimesSync(destination, st.atime, st.mtime);
    }
  };
  for (const s of files) {
    const name = names.get(s.relPath)!;
    put(s.audioPath, path.join(dir, name));
    for (const suffix of ['.txt', '.yue2.txt', '.mm3.txt']) {
      const source = `${stem(s.audioPath)}${suffix}`;
      if (fs.existsSync(source)) put(source, path.join(dir, `${stem(name)}${suffix}`));
    }
  }
  return dir;
}
