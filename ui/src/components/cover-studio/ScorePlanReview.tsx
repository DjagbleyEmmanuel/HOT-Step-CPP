import React from 'react';
import type { Yue2ScorePlan } from '../../services/yue2CoverApi';
import { lineDiff } from './SectionMatchReview';

interface Props {
  /** The score's sections and the lyrics the plan was made from. */
  beforeSections: Array<{ label: string; startBar: number }>;
  beforeLyrics: string;
  plan: Yue2ScorePlan;
  /** The score or the lyrics changed after planning. */
  stale: boolean;
  onApply: () => void;
  onDiscard: () => void;
}

function Diff({ label, before, after }: { label: string; before: string; after: string }) {
  return <pre aria-label={label} className="max-h-48 overflow-y-auto rounded bg-white dark:bg-black/30 p-2 text-[11px] font-mono leading-snug whitespace-pre-wrap">
    {lineDiff(before, after).map((row, index) => (
      <div key={index} className={row.kind === 'add' ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300'
        : row.kind === 'del' ? 'bg-red-500/15 text-red-700 dark:text-red-300 line-through' : 'text-zinc-600 dark:text-zinc-400'}>
        {row.kind === 'add' ? '+ ' : row.kind === 'del' ? '- ' : '  '}{row.text || ' '}
      </div>
    ))}
  </pre>;
}

/** Match score to lyrics: the score's section changes and the retagged
 *  lyrics, applied together to this cover's copies only. */
export const ScorePlanReview: React.FC<Props> = ({ beforeSections, beforeLyrics, plan, stale, onApply, onDiscard }) => {
  const sections = (list: Array<{ label: string; bar: number }>) => list.map(s => `${s.label} · bar ${s.bar}`).join('\n');
  return (
    <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-2 space-y-2">
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        {plan.unchanged ? 'The score’s sections already match the lyrics.'
          : 'Proposed score sections from where the source vocal sings each lyric block. Notes and words are unchanged; only this cover’s score and lyrics change.'}
      </p>
      {plan.unsure.length > 0 && <p role="status" className="text-xs text-amber-700 dark:text-amber-300">
        No clear start, so joined to the section before: {plan.unsure.map(b => b.tag ? `[${b.tag}]` : `block ${b.block}`).join(', ')}. Check these by hand.
      </p>}
      {!plan.unchanged && <>
        <Diff label="Score section changes" before={sections(beforeSections.map(s => ({ label: s.label, bar: s.startBar })))}
          after={sections(plan.sections)} />
        <Diff label="Lyric tag changes" before={beforeLyrics} after={plan.lyrics} />
      </>}
      {stale && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">
        The score or the lyrics changed after matching. Match again before applying.
      </p>}
      <div className="flex flex-wrap gap-2">
        {!plan.unchanged && <button type="button" onClick={onApply} disabled={stale}
          className="disabled:opacity-40 rounded bg-cyan-600 px-2 py-1 text-xs font-semibold text-white">Apply</button>}
        <button type="button" onClick={onDiscard} className="rounded px-2 py-1 text-xs text-zinc-600 dark:text-zinc-400">Discard</button>
      </div>
    </div>
  );
};
