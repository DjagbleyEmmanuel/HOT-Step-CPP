// Yue2StageCard.tsx — the shell every YuE2 preparation stage renders in.
//
// The header folds the stage's explanation, status and params away (always
// collapsed on arrival); the run button (`action`) and live progress
// (`footer`) stay outside the fold so a stage can be run without opening it.

import React, { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

const CARD = 'rounded-xl border border-zinc-200 dark:border-white/5 bg-white dark:bg-suno-card p-4';

/** YuE2's training form stays visible; only its optional settings fold away. */
export function TrainingRunPanel({ title, description, children }: {
  title: React.ReactNode; description: React.ReactNode; children: React.ReactNode;
}) {
  return <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-5">
    <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-300">{title}</h3>
    <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-2 leading-relaxed">{description}</p>
    {children}
  </div>;
}

export const Yue2StageCard: React.FC<{
  icon: React.ReactNode;
  title: string;
  done: boolean;
  action: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}> = ({ icon, title, done, action, footer, children }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className={CARD}>
      <button type="button" onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 text-left group">
        <ChevronDown size={14} className={`text-zinc-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
        {icon}
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-white group-hover:underline">{title}</h3>
        {done && <span className="flex items-center gap-1 text-[11px] text-emerald-500"><Check size={12} />done</span>}
      </button>
      {open && <div className="mt-3">{children}</div>}
      <div className="mt-3">{action}</div>
      {footer}
    </div>
  );
};
