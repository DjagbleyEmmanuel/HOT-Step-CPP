import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Play, Square } from 'lucide-react';
import { yue2CoverApi, type Yue2BuildSession, type Yue2BuildTake } from '../../services/yue2CoverApi';

const FPS = 25;
// A take plays from this long before its first section, so the join is heard.
const LEAD_IN = 4;
const clock = (frames: number) => {
  const s = Math.max(0, Math.round(frames / FPS));
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
  return {
    session, error, busy, setError,
    /** Generates takes, starting the session from `params` if there is none. */
    generate: (params: Record<string, unknown>, to: number, count: number) => call(async () => {
      let id = session?.id;
      if (!id) { id = (await yue2CoverApi.buildStart(params, token!)).id; setSessionId(id); }
      return yue2CoverApi.buildGenerate(id, to, count, token!);
    }),
    keep: (take: string) => call(() => yue2CoverApi.buildKeep(session!.id, take, token!)),
    undo: () => call(() => yue2CoverApi.buildUndo(session!.id, token!)),
    startOver: () => { setSessionId(''); setSession(null); setError(''); },
  };
}

interface StripProps {
  session: Yue2BuildSession;
  onKeep: (take: string) => void;
  onUndo: () => void;
  busy: boolean;
}

/** The kept takes so far and the takes of the next sections to choose from. */
export const Yue2BuildStrip: React.FC<StripProps> = ({ session, onKeep, onUndo, busy }) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState('');
  const next = buildNext(session);
  const label = (from: number, to: number) => from === to ? session.sections[from].label
    : `${session.sections[from].label}–${session.sections[to].label}`;
  const kept = session.kept.map(id => session.takes.find(t => t.id === id)!).filter(Boolean);
  const candidates = session.takes.filter(t => t.from === next);
  const waiting = session.pending.reduce((n, p) => n + p.count, 0);
  const play = (take: Yue2BuildTake, key: string) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing === key) { audio.pause(); setPlaying(''); return; }
    audio.src = take.audioUrl;
    audio.currentTime = Math.max(0, (take.starts[take.from] ?? 0) / FPS - (take.from ? LEAD_IN : 0));
    void audio.play();
    setPlaying(key);
  };
  const icon = (key: string) => playing === key ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />;
  return (
    <div className="space-y-1 rounded-lg border border-pink-500/30 bg-pink-500/5 p-2 text-xs">
      <audio ref={audioRef} onEnded={() => setPlaying('')} className="hidden" />
      {kept.length > 0 && <div className="flex flex-wrap items-center gap-1 text-zinc-600 dark:text-zinc-300">
        <span className="font-medium">Built:</span>
        {kept.map((take, i) => <button key={take.id} type="button" onClick={() => play(take, `k${i}`)}
          className="flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-800 dark:text-emerald-300"
          title="Play from just before this part">{icon(`k${i}`)}{label(take.from, take.to)}</button>)}
        <button type="button" onClick={onUndo} disabled={busy} className="ml-1 text-cyan-700 dark:text-cyan-300 disabled:opacity-40">Undo keep</button>
      </div>}
      {next >= session.sections.length
        ? <p className="text-emerald-700 dark:text-emerald-300">Every section is built. Save the song, or undo a keep to redo a part.</p>
        : <p className="text-zinc-500">Next: <b>{session.sections[next].label}</b>. Pick how far to build on the section chips, then generate takes.</p>}
      {waiting > 0 && <p className="flex items-center gap-1 text-amber-600"><Loader2 className="w-3 h-3 animate-spin" />{waiting} take{waiting > 1 ? 's' : ''} rendering…</p>}
      {session.error && <p role="alert" className="text-red-500">Last take failed: {session.error}</p>}
      {candidates.length > 0 && <ul className="flex flex-wrap gap-1">
        {candidates.map((take, i) => <li key={take.id} className="flex items-center gap-1.5 rounded border border-zinc-300 dark:border-white/10 px-1.5 py-0.5">
          <button type="button" onClick={() => play(take, take.id)} aria-label={`Play take ${i + 1}`}>{icon(take.id)}</button>
          <span>Take {i + 1} · {label(take.from, take.to)} · {clock(take.frames)}</span>
          <button type="button" onClick={() => onKeep(take.id)} disabled={busy} className="font-semibold text-cyan-700 dark:text-cyan-300 disabled:opacity-40">Keep</button>
        </li>)}
      </ul>}
    </div>
  );
};
