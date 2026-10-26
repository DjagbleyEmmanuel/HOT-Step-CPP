import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../../config.js';
import { getSetting, setSetting } from '../../../db/lireekDb.js';
import { HEARTMULA_ROLES, heartmulaClient } from './client.js';
import type { HeartmulaPick } from './client.js';
import type { BackendModels, BackendModelSelection } from '../types.js';

const SETTING = 'heartmula_models';
export function heartmulaSelection(): BackendModelSelection {
  let saved: BackendModelSelection = {};
  try { saved = JSON.parse(getSetting(SETTING, '{}')); } catch { /* use defaults */ }
  return Object.fromEntries(['variant', ...HEARTMULA_ROLES, 'lmAdapter'].map(k =>
    [k, typeof saved?.[k] === 'string' ? saved[k] : '']));
}

export function listHeartmulaAdapters(dir = path.join(config.aceServer.adapters, 'heartmula-lm-adapters')): string[] {
  const files: string[] = [];
  function scan(folder: string, depth: number): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory() && depth < 2) scan(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.gguf')) files.push(path.resolve(file));
    }
  }
  scan(dir, 0);
  return files.sort();
}

export function resolveHeartmulaAdapter(ref: unknown): string {
  if (ref === '' || ref === null || ref === undefined) return '';
  if (typeof ref !== 'string') throw new Error('heartmulaAdapter must be a GGUF path');
  const root = path.resolve(config.aceServer.adapters, 'heartmula-lm-adapters');
  const target = path.resolve(root, ref);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('heartmulaAdapter must be an installed HeartMuLa LoRA GGUF');
  }
  if (!listHeartmulaAdapters().includes(target)) {
    throw new Error(`The HeartMuLa adapter ${path.basename(target)} is no longer installed. Pick another in the Adapters tab.`);
  }
  return target;
}

/** What the picker shows about an adapter: whether it carries MLP factors (trained with
 *  --lora-mlp) and the variant it was trained on, which decides whether the engine
 *  re-bases it onto the loaded one. Both sit in the GGUF header, ahead of the tensor data. */
// ponytail: byte scan of the header, not a GGUF parser; read the KVs properly if the layout changes.
export function heartmulaAdapterInfo(file: string): { mlp: boolean; variant?: string } {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(512 * 1024);
    const head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0));
    // A GGUF string KV: u64 key length, key, u32 type (8 = string), u64 length, bytes.
    const key = Buffer.from('heartmula.variant');
    const at = head.indexOf(key);
    let variant: string | undefined;
    if (at >= 8 && head.readBigUInt64LE(at - 8) === BigInt(key.length) && head.readUInt32LE(at + key.length) === 8) {
      const len = Number(head.readBigUInt64LE(at + key.length + 4));
      if (len > 0 && len < 64) variant = head.toString('utf8', at + key.length + 12, at + key.length + 12 + len);
    }
    return { mlp: head.includes('.mlp.w1.weight'), variant };
  } catch { return { mlp: false }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function heartmulaPick(selection: BackendModelSelection, scale = 1): HeartmulaPick {
  return {
    variant: selection.variant || '',
    global_type: selection.global || '', local_type: selection.local || '',
    flow_type: selection.flow || '', scalar_decoder_type: selection.scalar_decoder || '',
    adapter: resolveHeartmulaAdapter(selection.lmAdapter), adapter_scale: scale,
  };
}

export async function heartmulaModels(): Promise<BackendModels> {
  const catalogue = await heartmulaClient.models();
  const selection = heartmulaSelection();
  const variant = selection.variant || '3B';
  const buckets: Record<string, string[]> = { variant: catalogue.variants };
  const meta: NonNullable<BackendModels['meta']> = {};
  for (const role of HEARTMULA_ROLES) {
    const files = (catalogue.components[role] ?? []).filter(f =>
      role !== 'global' && role !== 'local' || f.variant === variant);
    buckets[role] = [...new Set(files.map(f => f.type))];
    meta[role] = Object.fromEntries(files.map(f => [f.type, {
      label: f.type, bytes: f.bytes, ...(f.compatible ? {} : { disabledReason: f.error || 'Incompatible component' }),
    }]));
  }
  const lmAdapters = listHeartmulaAdapters();
  const lmAdapterMeta = Object.fromEntries(lmAdapters.map(file => {
    let bytes: number | undefined;
    try { bytes = fs.statSync(file).size; } catch { /* listed a moment ago */ }
    return [file, { label: path.basename(file, '.gguf'), bytes, ...heartmulaAdapterInfo(file) }];
  }));
  return { buckets, meta, defaults: selection, lmAdapters, lmAdapterMeta };
}

export async function selectHeartmulaModel(update: BackendModelSelection): Promise<{ changed: boolean }> {
  const previous = heartmulaSelection();
  for (const key of Object.keys(update)) {
    if (!(key in previous) || typeof update[key] !== 'string') throw new Error(`Unknown HeartMuLa model bucket: ${key}`);
  }
  const next = { ...previous, ...update };
  // A pick whose file was deleted must not block changing any other bucket.
  if (update.lmAdapter === undefined && next.lmAdapter) {
    try { resolveHeartmulaAdapter(next.lmAdapter); } catch { next.lmAdapter = ''; }
  }
  await heartmulaClient.select(heartmulaPick(next));
  setSetting(SETTING, JSON.stringify(next));
  return { changed: Object.keys(next).some(k => previous[k] !== next[k]) };
}
