import type { MouseEvent } from 'react';

interface Props {
  label: string;
  direction: 'horizontal' | 'vertical';
  onMouseDown: (event: MouseEvent<HTMLDivElement>) => void;
}

export function CoverResizeHandle({ label, direction, onMouseDown }: Props) {
  return <div role="separator" aria-label={label}
    aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
    onMouseDown={onMouseDown}
    className={`${direction === 'horizontal' ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize'} flex-shrink-0 bg-zinc-200/60 dark:bg-white/5 hover:bg-cyan-500/30`} />;
}
