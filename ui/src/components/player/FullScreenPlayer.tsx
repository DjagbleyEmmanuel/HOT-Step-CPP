// FullScreenPlayer.tsx: expanded phone player opened by tapping the mini player.
// Desktop never renders it. Android back closes it: a history entry is pushed
// on open and popstate closes the view.

import React, { useEffect, useRef } from 'react';
import { ChevronDown, Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Song } from '../../types';
import { CoverImage } from '../shared/CoverImage';
import { Waveform } from './Waveform';
import { useDisguiseMode } from '../../hooks/useDisguiseMode';

interface Props {
  song: Song;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  onTogglePlay: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (t: number) => void;
  isShuffle: boolean;
  onToggleShuffle: () => void;
  repeatMode: 'none' | 'all' | 'one';
  onToggleRepeat: () => void;
  onClose: () => void;
}

const fmt = (s: number) => {
  if (!s || !isFinite(s)) return '0:00';
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
};

export const FullScreenPlayer: React.FC<Props> = ({
  song, isPlaying, currentTime, duration, onTogglePlay, onNext, onPrevious, onSeek,
  isShuffle, onToggleShuffle, repeatMode, onToggleRepeat, onClose,
}) => {
  const { t } = useTranslation();
  const { isDisguised, disguiseTitle } = useDisguiseMode();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const poppedRef = useRef(false);
  const touchY = useRef<number | null>(null);

  // Push a history entry so the Android back button closes the view.
  useEffect(() => {
    window.history.pushState({ hsFullPlayer: true }, '');
    const onPop = () => { poppedRef.current = true; closeRef.current(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('keydown', onKey);
      // Closed by chevron or swipe: drop our history entry.
      if (!poppedRef.current && window.history.state?.hsFullPlayer) window.history.back();
    };
  }, []);

  const backend = (song as { backend?: string }).backend
    || (song.generationParams as { backend?: string } | undefined)?.backend || '';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('player.fullScreen.title')}
      data-hotkeys-block
      className="fixed inset-0 z-[150] flex flex-col bg-white dark:bg-zinc-950 text-zinc-900 dark:text-white pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]"
      onTouchStart={(e) => { touchY.current = e.touches[0].clientY; }}
      onTouchEnd={(e) => {
        const y0 = touchY.current; touchY.current = null;
        if (y0 != null && e.changedTouches[0].clientY - y0 > 100) onClose();
      }}
    >
      <div className="flex items-center justify-between">
        <button onClick={onClose} className="p-3 rounded-full text-zinc-500" aria-label={t('player.fullScreen.close')}>
          <ChevronDown size={26} />
        </button>
        <span className="text-xs uppercase tracking-wide text-zinc-500">{t('player.fullScreen.nowPlaying')}</span>
        <span className="w-12" />
      </div>

      <div className="flex-1 min-h-0 flex items-center justify-center py-4">
        <div className="aspect-square w-full max-w-[min(80vw,50vh)] rounded-2xl overflow-hidden bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center shadow-lg">
          <CoverImage url={song.coverUrl} seed={song.id} iconSize={64} />
        </div>
      </div>

      <div className="min-w-0 mb-3">
        <div className="text-lg font-semibold truncate">{disguiseTitle(song.title || 'Untitled')}</div>
        {!isDisguised && backend && <div className="text-sm text-zinc-500 truncate">{backend}</div>}
      </div>

      <div onTouchStart={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()}>
        <Waveform height={88} />
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(currentTime, duration || 0)}
          onChange={(e) => onSeek(parseFloat(e.target.value))}
          aria-label={t('player.fullScreen.seek')}
          className="w-full h-10 accent-pink-500"
        />
        <div className="flex justify-between text-xs font-mono text-zinc-500">
          <span>{fmt(currentTime)}</span><span>{fmt(duration)}</span>
        </div>
      </div>

      <div className="flex items-center justify-between mt-4 px-2">
        <button onClick={onToggleShuffle} className={`p-3 rounded-full ${isShuffle ? 'text-pink-400' : 'text-zinc-500'}`} aria-label={t('player.shuffle')}>
          <Shuffle size={22} />
        </button>
        <button onClick={onPrevious} className="p-3 rounded-full" aria-label={t('player.fullScreen.previous')}>
          <SkipBack size={32} />
        </button>
        <button
          onClick={onTogglePlay}
          className="w-20 h-20 rounded-full bg-zinc-900 dark:bg-white flex items-center justify-center shadow-lg"
          aria-label={isPlaying ? t('player.fullScreen.pause') : t('player.fullScreen.play')}
        >
          {isPlaying
            ? <Pause size={34} className="text-white dark:text-black" fill="currentColor" />
            : <Play size={34} className="text-white dark:text-black ml-1" fill="currentColor" />}
        </button>
        <button onClick={onNext} className="p-3 rounded-full" aria-label={t('player.fullScreen.next')}>
          <SkipForward size={32} />
        </button>
        <button onClick={onToggleRepeat} className={`p-3 rounded-full ${repeatMode !== 'none' ? 'text-pink-400' : 'text-zinc-500'}`} aria-label={t('player.repeatAll')}>
          {repeatMode === 'one' ? <Repeat1 size={22} /> : <Repeat size={22} />}
        </button>
      </div>
    </div>
  );
};
