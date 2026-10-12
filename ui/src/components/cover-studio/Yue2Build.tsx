import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Loader2, MoreHorizontal, Play, RotateCcw, Square, Trash2 } from 'lucide-react';
import { yue2CoverApi, type Yue2BuildSession, type Yue2BuildTake } from '../../services/yue2CoverApi';
import { lyricBlockRanges, sectionColours } from '../../utils/abcSections';
import { StyledSelect } from '../shared/StyledSelect';

const FPS = 25;
// A take plays from this long before its first section, so the join is heard.
const LEAD_IN = 4;
const clock = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** The first section not yet built. */
export function buildNext(session: Yue2BuildSession | null): number {
  const spine = session?.takes.find(t => t.id === session.kept.at(-1));
  return spine ? spine.to + 1 : 0;
}

/** A Build-by-section session kept on the server, polled while takes render. */
export function useYue2Build(token: string | null, sessionId: string, setSessionId: (id: string) => void) {
  const [session, setSession] = useState<Yue2BuildSession | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSession(null);
    if (!token || !sessionId) return;
    yue2CoverApi.buildGet(sessionId, token).then(setSession).catch(() => setSessionId(''));
  }, [sessionId, token]);
  const pending = !!session?.pending.length;
  useEffect(() => {
    if (!token || !session || !pending) return;
    const timer = setInterval(() => { yue2CoverApi.buildGet(session.id, token).then(setSession).catch(() => {}); }, 2000);
    return () => clearInterval(timer);
  }, [session?.id, pending, token]);

  const call = async (fn: () => Promise<Yue2BuildSession>) => {
    setBusy(true);
    try { const next = await fn(); setSession(next); setError(''); return next; }
    catch (err: any) { setError(err.message); return null; }
    finally { setBusy(false); }
  };
  const live = session && session.id === sessionId ? session : null;
  return {
    session: live, error, busy,
    /** Generates takes, starting the session from `params` if there is none. */
    generate: (params: Record<string, unknown>, to: number, count: number) => call(async () => {
      let id = live?.id;
      if (!id) { id = (await yue2CoverApi.buildStart(params, token!)).id; setSessionId(id); }
      return yue2CoverApi.buildGenerate(id, to, count, token!);
    }),
    keep: (take: string) => call(() => yue2CoverApi.buildKeep(live!.id, take, token!)),
    undo: (section?: number) => call(() => yue2CoverApi.buildUndo(live!.id, token!, section)),
    remove: (take: string) => call(() => yue2CoverApi.buildDelete(live!.id, take, token!)),
    startOver: () => { setSessionId(''); setSession(null); setError(''); },
  };
}

/** Peak bars of a take's new part, with a playhead while it plays. */
function Waveform({ peaks, progress, colour }: { peaks: number[]; progress: number | null; colour: string }) {
  if (!peaks.length) return <div className="h-10 flex-1 rounded bg-zinc-200/50 dark:bg-white/5" />;
  const w = 100 / peaks.length;
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-10 flex-1">
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
  summary: string;
  title: string;
  /** Why a build cannot start yet, or ''. */
  blocked: string;
  busy: boolean;
  error: string;
  onGenerate: (to: number, count: number) => void;
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
  const [to, setTo] = useState<number | null>(null);
  const [count, setCount] = useState(3);
  const [menu, setMenu] = useState(false);
  const dragging = useRef(false);
  const s = p.session;
  const next = buildNext(s);
  const spine = s?.takes.find(t => t.id === s.kept.at(-1)) ?? null;
  const colours = sectionColours(p.sections.map(x => x.label));
  const range = to !== null && to >= next && to < p.sections.length ? to : null;
  const candidates = s?.takes.filter(t => t.from === next) ?? [];
  const waiting = s?.pending.reduce((n, x) => n + x.count, 0) ?? 0;
  const done = next >= p.sections.length;

  useEffect(() => { setTo(null); }, [next]);
  useEffect(() => {
    const up = () => { dragging.current = false; };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);

  /** Plays `url` from `from` seconds; the playhead covers [from, to]. */
  const play = (key: string, url: string, from: number, to: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing?.key === key) { audio.pause(); setPlaying(null); setProgress(null); return; }
    audio.src = url;
    audio.currentTime = Math.max(0, from);
    void audio.play();
    setPlaying({ key, from, to });
  };
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
            <button type="button" disabled={!s.kept.length} onClick={() => { setMenu(false); p.onUndo(); }}
              className="block w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-white/5 disabled:opacity-40">Undo last keep</button>
            <button type="button" onClick={() => { setMenu(false); p.onStartOver(); }}
              className="block w-full px-3 py-1.5 text-left text-red-500 hover:bg-zinc-100 dark:hover:bg-white/5">Start over</button>
          </div>}
        </div>
        <button type="button" onClick={p.onSave} disabled={!s?.kept.length}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
          title="Render everything kept so far as a library song">Save song</button>
      </div>

      {/* Song timeline. */}
      <div className="border-b border-zinc-200 dark:border-white/10 px-4 py-3 space-y-2">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className="font-semibold uppercase tracking-wide">Song</span>
          <button type="button" disabled={!spine} onClick={() => spine && play('build', spine.audioUrl, 0, spine.frames / FPS)}
            className="flex items-center gap-1 text-cyan-700 dark:text-cyan-300 disabled:opacity-40">
            {playing?.key === 'build' ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}Play build</button>
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
              onClick={() => { if (built && spine && start != null) play(`s${i}`, spine.audioUrl, start / FPS, spine.frames / FPS); }}
              title={built ? `Play the build from ${section.label}` : `Build up to ${section.label}`}
              className={`group relative min-w-0 cursor-pointer rounded-md border-t-4 px-1.5 py-1 ${picked ? 'ring-2 ring-pink-500' : ''} ${i > next && !picked ? 'opacity-60' : ''}`}>
              <p className="truncate text-[11px] font-semibold text-zinc-800 dark:text-zinc-100">
                {built ? '✓ ' : i === next ? '→ ' : ''}{section.label}</p>
              <p className="truncate text-[10px] text-zinc-500">{built ? (start != null ? clock(start / FPS) : 'built') : i === next ? 'next' : `${bars(i)} bars`}</p>
              {built && <button type="button" onClick={e => { e.stopPropagation(); p.onUndo(i); }}
                title={`Undo back to ${section.label}, to build it again`}
                className="absolute right-1 top-1 hidden rounded p-0.5 text-zinc-500 hover:text-pink-500 group-hover:block"><RotateCcw className="w-3 h-3" /></button>}
            </div>;
          })}
        </div>
      </div>

      {/* The next sections: their lyrics, and their takes. */}
      <div className="flex-1 min-h-0 grid grid-cols-[minmax(240px,1fr)_minmax(320px,1.4fr)] overflow-hidden">
        <div className="min-h-0 overflow-y-auto border-r border-zinc-200 dark:border-white/10 p-4 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            {done ? 'Done' : `Building: ${rangeLabel || p.sections[next].label}`}</p>
          {shown.length ? shown.map((text, i) => <pre key={i} className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">{text}</pre>)
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
                <button type="button" onClick={() => play(take.id, take.audioUrl, win.from, win.to)} aria-label={`Play take ${i + 1}`}
                  className="rounded-full bg-zinc-100 dark:bg-white/10 p-2 text-zinc-700 dark:text-zinc-200 hover:text-pink-500">
                  {playing?.key === take.id ? <Square className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}</button>
                <Waveform peaks={take.peaks ?? []} progress={playing?.key === take.id ? progress : null} colour={colour} />
                <span className="w-10 text-right font-mono text-xs text-zinc-500" title="Length of the new part">{clock(win.newPart)}</span>
                <button type="button" onClick={() => p.onKeep(take.id)} disabled={p.busy}
                  className="rounded-lg bg-cyan-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-40">Keep</button>
                <button type="button" onClick={() => p.onDelete(take.id)} disabled={p.busy} aria-label={`Delete take ${i + 1}`}
                  className="rounded p-1 text-zinc-400 hover:text-red-500 disabled:opacity-40"><Trash2 className="w-4 h-4" /></button>
              </div>;
            })}
            {waiting > 0 && <div className="flex items-center gap-2 rounded-lg border border-dashed border-amber-500/50 px-3 py-3 text-xs text-amber-600">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />{waiting} take{waiting > 1 ? 's' : ''} rendering…</div>}
            {!candidates.length && !waiting && !done && <p className="text-xs text-zinc-500">No takes yet. Choose sections on the timeline, then generate.</p>}
            {s?.error && <p role="alert" className="text-xs text-red-500">Last take failed: {s.error}</p>}
          </div>
          {!done && <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="w-20 flex-shrink-0" title="Takes per run">
                <StyledSelect accent="pink" value={count} onChange={v => setCount(Number(v))}
                  options={Array.from({ length: 10 }, (_, k) => ({ value: k + 1, label: String(k + 1) }))} />
              </div>
              <button type="button" onClick={() => range !== null && p.onGenerate(range, count)} disabled={range === null || p.busy || !!p.blocked}
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
