import { useQuery } from '@tanstack/react-query';
import { queryClient } from '../../queries/client';
import { snapshotOptions } from '../../queries/cover-lyrics/reads';
import { pollWhile } from '../../queries/contract';
import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Loader2, MoreHorizontal, Pause, Pencil, Play, RotateCcw, Square, Trash2 } from 'lucide-react';
import { yue2CoverApi, type Yue2BuildSession, type Yue2BuildTake } from '../../services/yue2CoverApi';
import { lyricBlockRanges, sectionColours } from '../../utils/abcSections';
import { StyledSelect } from '../shared/StyledSelect';
import { CoverArStrength } from './Yue2CoverPanel';
import { persist, restore } from './coverStudioUtils';

const FPS = 25;
// A take plays from this long before its first section, so the join is heard.
const LEAD_IN = 4;
const clock = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const savedBuildListeners = new Set<(id: string) => void>();
/** Mounted Cover Studios subscribe here so a Save that finishes after they
 *  were rebuilt (the user left and came back) still clears the build. */
export function onBuildSaved(listener: (id: string) => void) {
  savedBuildListeners.add(listener);
  return () => { savedBuildListeners.delete(listener); };
}
/** A Save song finished: forget build `id`, unless a newer build has replaced it.
 *  Lives outside the component because the Save outlives it. */
export function finishSavedBuild(id: string): boolean {
  if (restore<string>('buildSessionId', '') !== id) return false;
  persist('buildSessionId', '');
  savedBuildListeners.forEach(l => l(id));
  return true;
}

/** The first section not yet built. */
export function buildNext(session: Yue2BuildSession | null): number {
  const spine = session?.takes.find(t => t.id === session.kept.at(-1));
  return spine ? spine.to + 1 : 0;
}

/** The build's own lyrics before a session exists: null follows Prepare. */
export interface BuildLyricsDraft { text: string | null; set: (text: string | null) => void }

/** A Build-by-section session kept on the server, polled while takes render.
 *  Every change names the revision the page saw, so a stale page is refused. */
export function useYue2Build(token: string | null, sessionId: string, setSessionId: (id: string) => void, draft: BuildLyricsDraft) {
  const options = snapshotOptions<Yue2BuildSession>('cover', `/yue2-cover/build/${sessionId}`, token ?? undefined);
  const snapshot = useQuery({ ...options, enabled: !!token && !!sessionId, refetchInterval: pollWhile<Yue2BuildSession>(s => !s || s.pending.length > 0) });
  const session = sessionId ? snapshot.data ?? null : null;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const call = async (fn: () => Promise<Yue2BuildSession>) => {
    setBusy(true);
    try { const next = await fn(); const key = snapshotOptions<Yue2BuildSession>('cover', `/yue2-cover/build/${next.id}`, token!).queryKey; queryClient.setQueryData([key[0], key[1], options.queryKey[2], key[3], key[4]], next); setError(''); return next; }
    catch (err: any) { setError(err.message); void snapshot.refetch(); return null; }
    finally { setBusy(false); }
  };
  const live = session && session.id === sessionId ? session : null;
  return {
    session: live, error: error || snapshot.error?.message || '', busy,
    /** Generates takes, starting the session from `params` if there is none. */
    generate: (params: Record<string, unknown>, to: number, count: number) => call(async () => {
      let started = live;
      if (!started) { started = await yue2CoverApi.buildStart(params, token!, draft.text ?? undefined); setSessionId(started.id); }
      return yue2CoverApi.buildGenerate(started.id, started.revision, to, count, token!);
    }),
    keep: (take: string) => call(() => yue2CoverApi.buildKeep(live!.id, live!.revision, take, token!)),
    undo: (section?: number) => call(() => yue2CoverApi.buildUndo(live!.id, live!.revision, token!, section)),
    remove: (take: string) => call(() => yue2CoverApi.buildDelete(live!.id, live!.revision, take, token!)),
    cancel: () => call(() => yue2CoverApi.buildCancel(live!.id, token!)),
    /** Applies the build's lyrics: to the session, or to the draft the first session starts from.
     *  True once the server (or, before a session, its validation) accepted them. */
    applyLyrics: async (text: string) => {
      if (live) return !!(await call(() => yue2CoverApi.buildLyrics(live.id, live.revision, text, token!)));
      setBusy(true);
      try { await yue2CoverApi.buildLyricsCheck(text, token!); draft.set(text); setError(''); return true; }
      catch (err: any) { setError(err.message); return false; }
      finally { setBusy(false); }
    },
    startOver: () => { setSessionId(''); setError(''); },
  };
}

/** Peak bars of a take's new part, with a playhead while it plays. */
function Waveform({ peaks, progress, colour, onSeek }: { peaks: number[]; progress: number | null; colour: string; onSeek: (fraction: number) => void }) {
  if (!peaks.length) return <div className="h-10 flex-1 rounded bg-zinc-200/50 dark:bg-white/5" />;
  const w = 100 / peaks.length;
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-10 flex-1 cursor-pointer"
      onClick={e => { const r = e.currentTarget.getBoundingClientRect(); if (r.width) onSeek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))); }}>
      {peaks.map((p, i) => <rect key={i} x={i * w + w * 0.15} width={w * 0.7} y={20 - Math.max(0.5, p * 19)} height={Math.max(1, p * 38)}
        fill={progress !== null && i / peaks.length <= progress ? colour : '#a1a1aa'} />)}
      {progress !== null && <line x1={progress * 100} x2={progress * 100} y1={0} y2={40} stroke={colour} strokeWidth={0.6} />}
    </svg>
  );
}

interface PageProps {
  session: Yue2BuildSession | null;
  /** The score's sections before a session exists; the session's after. */
  sections: Array<{ label: string; startBar: number }>;
  totalBars: number;
  /** The lyrics the build follows (the session's once it exists). */
  lyrics: string;
  /** The Prepare page's lyrics, which the build starts from until it is given its own. */
  prepareLyrics: string;
  /** Applies new lyrics to this build only; true when accepted. */
  onApplyLyrics: (text: string) => Promise<boolean>;
  summary: string;
  /** AR strength: the session's captured value once it exists, else the Cover setting. */
  arStrength: number;
  onArStrength: (value: number) => void;
  title: string;
  /** Why a build cannot start yet, or ''. */
  blocked: string;
  busy: boolean;
  error: string;
  onGenerate: (to: number, count: number) => void;
  onCancel: () => void;
  onKeep: (take: string) => void;
  onDelete: (take: string) => void;
  onUndo: (section?: number) => void;
  onStartOver: () => void;
  onSave: () => void;
  onBack: () => void;
}

/** Build by section: a song timeline, the next sections' lyrics, and their
 *  takes to compare, keep or delete. */
export const Yue2BuildPage: React.FC<PageProps> = p => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState<{ key: string; from: number; to: number } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [paused, setPaused] = useState(true);
  const generation = useRef(0);
  const [to, setTo] = useState<number | null>(null);
  const [count, setCount] = useState(3);
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const dragging = useRef(false);
  const s = p.session;
  const next = buildNext(s);
  const spine = s?.takes.find(t => t.id === s.kept.at(-1)) ?? null;
  const colours = sectionColours(p.sections.map(x => x.label));
  const range = to !== null && to >= next && to < p.sections.length ? to : null;
  const candidates = s?.takes.filter(t => t.from === next) ?? [];
  const waiting = s?.pending.reduce((n, x) => n + x.count, 0) ?? 0;
  const chunk = s?.pending[0];
  const chunkStage = ({ starting: 'Starting', semantic: 'Composing', plan: 'Planning', nar: 'Rendering', vae: 'Decoding audio', aligning: 'Aligning lyrics' } as Record<string, string>)[chunk?.phase ?? ''] ?? 'Rendering';
  const done = next >= p.sections.length;

  useEffect(() => { setTo(null); }, [next]);
  // An open editor belongs to the build it was opened on.
  useEffect(() => { setEditing(null); }, [s?.id]);
  const apply = async (text: string) => { if (await p.onApplyLyrics(text)) setEditing(null); };
  useEffect(() => {
    const up = () => { dragging.current = false; };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);

  /** Stops playback and releases the audio element. */
  const release = (audio: HTMLAudioElement | null) => {
    generation.current++;
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
  };
  const stop = () => { release(audioRef.current); setPlaying(null); setProgress(null); };
  /** Plays `url` from `at` seconds; the playhead covers [from, to]. */
  const start = (key: string, url: string, from: number, to: number, at = from) => {
    const audio = audioRef.current;
    if (!audio) return;
    const mine = ++generation.current;
    audio.src = url;
    audio.currentTime = Math.max(0, at);
    setPlaying({ key, from, to });
    setProgress(Math.min(1, Math.max(0, (at - from) / Math.max(0.1, to - from))));
    audio.play().catch(() => { if (generation.current === mine) stop(); });
  };
  /** Play, pause and resume for `key`; a different `key` starts it from the top. */
  const toggle = (key: string, url: string, from: number, to: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing?.key !== key) return start(key, url, from, to);
    if (!audio.paused) { generation.current++; audio.pause(); return; }
    const mine = ++generation.current;
    audio.play().catch(() => { if (generation.current === mine) stop(); });
  };
  /** Seeks within [from, to] of a take, keeping it paused if it is; starts it if idle. */
  const seek = (key: string, url: string, from: number, to: number, fraction: number) => {
    const audio = audioRef.current;
    const at = from + fraction * (to - from);
    if (!audio || playing?.key !== key) return start(key, url, from, to, at);
    audio.currentTime = at;
    setProgress(fraction);
  };
  // Playback ends with the build it belongs to: a session change or leaving the page.
  // React clears the ref before this cleanup runs on unmount, so hold the element.
  useEffect(() => {
    const audio = audioRef.current;
    return () => { release(audio); setPlaying(null); setProgress(null); };
  }, [s?.id]);
  const keep = (take: string) => { stop(); p.onKeep(take); };
  const undo = (section?: number) => { stop(); p.onUndo(section); };
  const remove = (take: string) => { if (playing?.key === take) stop(); p.onDelete(take); };
  const takeWindow = (take: Yue2BuildTake) => {
    const start = (take.starts[take.from] ?? 0) / FPS;
    return { from: Math.max(0, start - (take.from ? LEAD_IN : 0)), to: take.frames / FPS, newPart: take.frames / FPS - start };
  };

  // Lyrics of the chosen sections (block i pairs with section i).
  const blocks = lyricBlockRanges(p.lyrics);
  const shown = done ? [] : blocks.slice(next, (range ?? next) + 1).map(b => p.lyrics.slice(b.start, b.end).trim());
  const bars = (i: number) => (p.sections[i + 1]?.startBar ?? p.totalBars + 1) - p.sections[i].startBar;
  const rangeLabel = range === null ? '' : `${p.sections[next].label}${range > next ? ` → ${p.sections[range].label}` : ''}`;

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <audio ref={audioRef} className="hidden" onEnded={() => { setPlaying(null); setProgress(null); }}
        onPlay={() => setPaused(false)} onPause={() => setPaused(true)}
        onTimeUpdate={e => { if (playing) setProgress(Math.min(1, Math.max(0, (e.currentTarget.currentTime - playing.from) / Math.max(0.1, playing.to - playing.from)))); }} />
      {/* Top bar: what is being built and how. */}
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 dark:border-white/10 px-4 py-2">
        <button type="button" onClick={p.onBack} className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-300 hover:text-cyan-600">
          <ArrowLeft className="w-3.5 h-3.5" />Prepare</button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-zinc-900 dark:text-white">{p.title}</p>
          <p className="truncate text-xs text-zinc-500">{p.summary}</p>
        </div>
        <div className="relative">
          <button type="button" onClick={() => setMenu(m => !m)} disabled={!s} aria-label="Build actions"
            className="rounded p-1.5 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-white/10 disabled:opacity-40"><MoreHorizontal className="w-4 h-4" /></button>
          {menu && s && <div className="absolute right-0 top-8 z-20 w-44 rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-zinc-900 py-1 text-xs shadow-xl"
            onMouseLeave={() => setMenu(false)}>
            <button type="button" disabled={!s.kept.length} onClick={() => { setMenu(false); undo(); }}
              className="block w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-white/5 disabled:opacity-40">Undo last keep</button>
            <button type="button" onClick={() => { setMenu(false); p.onStartOver(); }}
              className="block w-full px-3 py-1.5 text-left text-red-500 hover:bg-zinc-100 dark:hover:bg-white/5">Start over</button>
          </div>}
        </div>
        <button type="button" onClick={p.onSave} disabled={!s?.kept.length}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
          title="Render everything kept so far as a library song">Save song</button>
      </div>

      <div className="border-b border-zinc-200 dark:border-white/10 px-4 py-2">
        <CoverArStrength value={p.arStrength} onChange={p.onArStrength} locked={!!s} />
      </div>

      {/* Song timeline. */}
      <div className="border-b border-zinc-200 dark:border-white/10 px-4 py-3 space-y-2">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className="font-semibold uppercase tracking-wide">Song</span>
          <button type="button" disabled={!spine} onClick={() => spine && toggle('build', spine.audioUrl, 0, spine.frames / FPS)}
            className="flex items-center gap-1 text-cyan-700 dark:text-cyan-300 disabled:opacity-40">
            {playing?.key === 'build' && !paused ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}Play build</button>
          <span className="ml-auto">{done ? 'Every section is built.' : `Click or drag across sections from ${p.sections[next]?.label} to choose what to build next.`}</span>
        </div>
        <div className="flex gap-1 select-none">
          {p.sections.map((section, i) => {
            const built = i < next, picked = range !== null && i >= next && i <= range;
            const start = spine?.starts[i];
            return <div key={i} style={{ flexGrow: Math.max(1, bars(i)), flexBasis: 0, borderColor: colours[i],
              backgroundColor: built ? `${colours[i]}55` : picked ? `${colours[i]}33` : `${colours[i]}12` }}
              onPointerDown={() => { if (!built) { dragging.current = true; setTo(Math.max(next, i)); } }}
              onPointerEnter={() => { if (dragging.current && !built) setTo(Math.max(next, i)); }}
              onClick={() => { if (built && spine && start != null) toggle(`s${i}`, spine.audioUrl, start / FPS, spine.frames / FPS); }}
              title={built ? `Play the build from ${section.label}` : `Build up to ${section.label}`}
              className={`group relative min-w-0 cursor-pointer rounded-md border-t-4 px-1.5 py-1 ${picked ? 'ring-2 ring-pink-500' : ''} ${i > next && !picked ? 'opacity-60' : ''}`}>
              <p className="truncate text-[11px] font-semibold text-zinc-800 dark:text-zinc-100">
                {built ? '✓ ' : i === next ? '→ ' : ''}{section.label}</p>
              <p className="truncate text-[10px] text-zinc-500">{built ? (start != null ? clock(start / FPS) : 'built') : i === next ? 'next' : `${bars(i)} bars`}</p>
              {built && <button type="button" onClick={e => { e.stopPropagation(); undo(i); }}
                title={`Undo back to ${section.label}, to build it again`}
                className="absolute right-1 top-1 hidden rounded p-0.5 text-zinc-500 hover:text-pink-500 group-hover:block"><RotateCcw className="w-3 h-3" /></button>}
            </div>;
          })}
        </div>
      </div>

      {/* The next sections: their lyrics, and their takes. */}
      <div className="flex-1 min-h-0 grid grid-cols-[minmax(240px,1fr)_minmax(320px,1.4fr)] overflow-hidden">
        <div className="min-h-0 overflow-y-auto border-r border-zinc-200 dark:border-white/10 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <p className="flex-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              {done ? 'Done' : `Building: ${rangeLabel || p.sections[next].label}`}</p>
            {editing === null && <>
              {p.lyrics !== p.prepareLyrics && <button type="button" onClick={() => void apply(p.prepareLyrics)} disabled={p.busy || waiting > 0}
                title="Replace this build's lyrics with the Prepare page's"
                className="text-xs text-zinc-500 hover:text-cyan-600 disabled:opacity-40">Use Prepare lyrics</button>}
              <button type="button" onClick={() => setEditing(p.lyrics)} disabled={p.busy || waiting > 0}
                title={waiting > 0 ? 'Wait for the pending takes, or cancel them, to edit the lyrics' : 'Edit the lyrics for this build only'}
                className="flex items-center gap-1 text-xs text-cyan-700 dark:text-cyan-300 disabled:opacity-40"><Pencil className="w-3 h-3" />Edit lyrics</button>
            </>}
          </div>
          {editing !== null ? <div className="space-y-2">
            <textarea value={editing} onChange={e => setEditing(e.target.value)} maxLength={20000} rows={16} spellCheck={false}
              aria-label="Build lyrics"
              className="w-full rounded-lg border border-zinc-300 dark:border-white/10 bg-white dark:bg-black/30 p-2 font-mono text-sm leading-relaxed text-zinc-800 dark:text-zinc-200" />
            <p className="text-xs text-zinc-500">
              For this build only: the Prepare page and the dataset keep theirs.
              {s?.kept.length ? ' Lyrics of built sections are locked.' : ''}
              {candidates.length ? ' Takes made with the old lyrics can no longer be kept.' : ''}
            </p>
            {p.error && <p role="alert" className="text-xs text-red-500">{p.error}</p>}
            <div className="flex gap-2">
              <button type="button" onClick={() => void apply(editing)} disabled={p.busy || waiting > 0 || !editing.trim() || editing === p.lyrics}
                className="rounded-lg bg-cyan-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-40">Apply</button>
              <button type="button" onClick={() => setEditing(null)} className="rounded-lg px-3 py-1 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Cancel</button>
            </div>
          </div> : shown.length ? shown.map((text, i) => <pre key={i} className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">{text}</pre>)
            : !done && <p className="text-xs text-zinc-500">No lyrics for this section.</p>}
        </div>
        <div className="min-h-0 flex flex-col p-4 gap-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Takes</p>
          <div className="flex-1 min-h-0 overflow-y-auto space-y-2">
            {candidates.map((take, i) => {
              const win = takeWindow(take);
              const colour = colours[take.from] ?? '#ec4899';
              return <div key={take.id} className="flex items-center gap-3 rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-black/20 px-3 py-2">
                <span className="w-12 text-xs font-semibold text-zinc-700 dark:text-zinc-200">Take {i + 1}</span>
                <button type="button" onClick={() => toggle(take.id, take.audioUrl, win.from, win.to)} aria-label={playing?.key === take.id && !paused ? `Pause take ${i + 1}` : `Play take ${i + 1}`}
                  className="rounded-full bg-zinc-100 dark:bg-white/10 p-2 text-zinc-700 dark:text-zinc-200 hover:text-pink-500">
                  {playing?.key === take.id && !paused ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}</button>
                {playing?.key === take.id && <button type="button" onClick={stop} aria-label={`Stop take ${i + 1}`}
                  className="rounded-full bg-zinc-100 dark:bg-white/10 p-2 text-zinc-700 dark:text-zinc-200 hover:text-pink-500"><Square className="w-3.5 h-3.5" /></button>}
                <Waveform peaks={take.peaks ?? []} progress={playing?.key === take.id ? progress : null} colour={colour} onSeek={f => seek(take.id, take.audioUrl, win.from, win.to, f)} />
                <span className="w-10 text-right font-mono text-xs text-zinc-500" title="Length of the new part">{clock(win.newPart)}</span>
                <button type="button" onClick={() => keep(take.id)} disabled={p.busy || take.revision !== s?.revision}
                  title={take.revision !== s?.revision ? 'Made with earlier lyrics; generate it again' : undefined}
                  className="rounded-lg bg-cyan-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-40">Keep</button>
                <button type="button" onClick={() => remove(take.id)} disabled={p.busy} aria-label={`Delete take ${i + 1}`}
                  className="rounded p-1 text-zinc-400 hover:text-red-500 disabled:opacity-40"><Trash2 className="w-4 h-4" /></button>
              </div>;
            })}
            {waiting > 0 && <div className="flex items-center gap-2 rounded-lg border border-dashed border-amber-500/50 px-3 py-3 text-xs text-amber-600">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span role="status" className="flex-1">
                {chunk?.activeCount ? `${chunkStage} ${chunk.activeCount} take${chunk.activeCount > 1 ? 's' : ''}: ${chunk.progress ?? 0}%` : 'Queued'}
                {` · ${waiting} take${waiting > 1 ? 's' : ''} remaining`}
              </span>
              <button type="button" onClick={p.onCancel} disabled={p.busy}
                className="rounded px-2 py-1 font-semibold hover:bg-amber-500/10 disabled:opacity-40">Cancel</button>
            </div>}
            {!candidates.length && !waiting && !done && <p className="text-xs text-zinc-500">No takes yet. Choose sections on the timeline, then generate.</p>}
            {s?.error && <p role="alert" className="text-xs text-red-500">Last take failed: {s.error}</p>}
          </div>
          {!done && <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="w-20 flex-shrink-0" title="Takes per run">
                <StyledSelect accent="pink" value={count} onChange={v => setCount(Number(v))}
                  options={Array.from({ length: 10 }, (_, k) => ({ value: k + 1, label: String(k + 1) }))} />
              </div>
              <button type="button" onClick={() => range !== null && p.onGenerate(range, count)} disabled={range === null || p.busy || waiting > 0 || !!p.blocked}
                className="flex-1 rounded-xl bg-gradient-to-r from-pink-600 to-purple-600 py-2.5 text-sm font-bold text-white disabled:opacity-40">
                {range === null ? 'Choose sections on the timeline' : `Generate ${count} take${count > 1 ? 's' : ''} of ${rangeLabel}`}</button>
            </div>
            {p.blocked && <p className="text-xs text-amber-600">{p.blocked}</p>}
            {p.error && <p role="alert" className="text-xs text-red-500">{p.error}</p>}
          </div>}
        </div>
      </div>
    </div>
  );
};
