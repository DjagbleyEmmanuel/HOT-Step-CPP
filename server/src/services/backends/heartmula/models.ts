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
  if (relative.startsWith('..') || path.isAbsolute(relative) || !listHeartmulaAdapters().includes(target)) {
    throw new Error('heartmulaAdapter must be an installed HeartMuLa LoRA GGUF');
  }
  return target;
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
  return { buckets, meta, defaults: selection, lmAdapters: listHeartmulaAdapters() };
}

export async function selectHeartmulaModel(update: BackendModelSelection): Promise<{ changed: boolean }> {
  const previous = heartmulaSelection();
  for (const key of Object.keys(update)) {
    if (!(key in previous) || typeof update[key] !== 'string') throw new Error(`Unknown HeartMuLa model bucket: ${key}`);
  }
  const next = { ...previous, ...update };
  await heartmulaClient.select(heartmulaPick(next));
  setSetting(SETTING, JSON.stringify(next));
  return { changed: Object.keys(next).some(k => previous[k] !== next[k]) };
}
