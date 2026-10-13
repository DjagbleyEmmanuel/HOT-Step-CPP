import { getDataset } from '../../training/datasetsRepo.js';
import { jointRunForAdapter, type Yue2AitkRunRecord } from '../../training/yue2AitkRuns.js';
import { readSafetensorsMeta } from '../../training/yue2Runs.js';

/** Older native joint exports lack trigger metadata. Recover the dataset's
 * configured tag for prompt composition, but report that it is inferred: the
 * prepared style text may not have contained it during training. Pass `runs`
 * when calling per adapter in a loop: each lookup otherwise rescans every run
 * folder on disk. */
export function yue2AdapterTrigger(ref: string, runs?: Yue2AitkRunRecord[]): { trigger: string; inferred: boolean } {
  if (!ref) return { trigger: '', inferred: false };
  const recorded = readSafetensorsMeta(ref)?.trigger?.normalize('NFC').trim() || '';
  if (recorded) return { trigger: recorded, inferred: false };
  const run = jointRunForAdapter(ref, runs);
  const dataset = run ? getDataset(run.datasetId) : undefined;
  return { trigger: dataset?.customTag?.normalize('NFC').trim() || '', inferred: !!dataset?.customTag };
}
