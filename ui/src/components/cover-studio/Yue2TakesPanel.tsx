import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Play, Square, X } from 'lucide-react';
import { yue2CoverApi, type Yue2Take, type Yue2TakesSession } from '../../services/yue2CoverApi';
import { useAuth } from '../../context/AuthContext';
import { StyledSelect } from '../shared/StyledSelect';
import { Toggle } from '../shared/Toggle';

interface Props {
  songId: string;
  token: string;
  onClose: () => void;
}

/** Opens Section takes for a YuE2 render, from any song menu. */
export function openYue2Takes(songId: string): void {
  window.dispatchEvent(new CustomEvent<{ songId: string }>('open-yue2-takes', { detail: { songId } }));
}

/** Mounted once (App); shows the panel when a song menu asks for it. */
export const Yue2TakesHost: React.FC = () => {
  const { token } = useAuth();
  const [songId, setSongId] = useState<string | null>(null);
  useEffect(() => {
    const open = (e: Event) => setSongId((e as CustomEvent<{ songId: string }>).detail.songId);
    window.addEventListener('open-yue2-takes', open);
    return () => window.removeEventListener('open-yue2-takes', open);
  }, []);
  return songId && token ? <Yue2TakesPanel key={songId} songId={songId} token={token} onClose={() => setSongId(null)} /> : null;
};

const FPS = 25;
// A take plays from this long before its section, so the join is heard.
const LEAD_IN = 4;
const clock = (frames: number) => {
  const s = Math.max(0, Math.round(frames / FPS));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Section takes: rebuild a YuE2 render one section at a time. The current
 *  take is the one later sections resume from; each new take keeps it up to
 *  its section, composes the section again with a new seed, and stops a little
 *  past it. */
export const Yue2TakesPanel: React.FC<Props> = ({ songId, token, onClose }) => {
  const [session, setSession] = useState<Yue2TakesSession | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [count, setCount] = useState(3);
  const [toEnd, setToEnd] = useState(false);
  const [playing, setPlaying] = useState<{ take: string; section: number } | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    let live = true;
    yue2CoverApi.takesStart(songId, token).then(s => { if (live) setSession(s); })
      .catch(err => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [songId, token]);

  // Takes render in the background; poll until they are in.
  const pending = !!session?.pending.length;
  useEffect(() => {
    if (!session || !pending) return;
    const timer = setInterval(() => {
      yue2CoverApi.takesGet(session.id, token).then(setSession).catch(err => setError(err.message));
    }, 2000);
    return () => clearInterval(timer);
  }, [session?.id, pending, token]);

  const call = (fn: () => Promise<Yue2TakesSession>) => fn().then(s => { setSession(s); setError(''); })
    .catch(err => setError(err.message));
  const play = (take: Yue2Take, section: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing?.take === take.id && playing.section === section) { audio.pause(); setPlaying(null); return; }
    audio.src = take.audioUrl;
    audio.currentTime = Math.max(0, (take.starts[section] ?? 0) / FPS - (section ? LEAD_IN : 0));
    void audio.play();
    setPlaying({ take: take.id, section });
  };
  const save = (take: Yue2Take) => yue2CoverApi.takesSave(session!.id, take.id, token)
    .then(() => setNotice(`Saved to the library (${clock(take.frames)}). It is in Recent Songs.`)).catch(err => setError(err.message));

  const spine = session?.takes.find(t => t.id === session.spine);
  const takeName = (take: Yue2Take) => (take.id === 'base' ? 'Original' : `Take ${take.id.slice(0, 4)}`);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-3xl max-h-[85vh] overflow-y-auto rounded-xl bg-white dark:bg-zinc-900 p-4 space-y-3 shadow-xl"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">Section takes · {session?.title ?? '…'}</h3>
            <p className="text-xs text-zinc-500">Generate new takes of a section from the current take, play them in context, and use the best one.
              Later sections continue from the take you use. Sections are found by aligning the lyrics on each take's audio.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-zinc-500 hover:text-zinc-800 dark:hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <audio ref={audioRef} onEnded={() => setPlaying(null)} className="hidden" />
        {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
        {notice && <p role="status" className="text-xs text-emerald-600">{notice}</p>}
        {session?.error && <p role="alert" className="text-xs text-red-500">Last take failed: {session.error}</p>}
        {!session && !error && <p className="flex items-center gap-2 text-xs text-zinc-500"><Loader2 className="w-3 h-3 animate-spin" />Finding the sections in this render…</p>}
        {session && spine && <>
          <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-600 dark:text-zinc-300">
            <span>Current: <b>{takeName(spine)}</b> ({clock(spine.frames)})</span>
            <span className="flex items-center gap-1">Takes per run
              <StyledSelect accent="cyan" className="w-16" value={count} onChange={v => setCount(Number(v))}
                options={[1, 2, 3, 4, 5, 6].map(n => ({ value: n, label: String(n) }))} />
            </span>
            <span className="flex items-center gap-1" title="Let each take run to the end of the song instead of stopping after its section">
              <Toggle accent="cyan" checked={toEnd} onChange={setToEnd} aria-label="Run to the end" />Run to the end
            </span>
            <button type="button" onClick={() => save(spine)} className="ml-auto rounded bg-emerald-600 px-2 py-1 font-semibold text-white">
              Save current to library</button>
          </div>
          <ol className="space-y-2">
            {session.sections.map((section, i) => {
              const start = spine.starts[i];
              const takes = session.takes.filter(t => t.section === i && t.id !== 'base');
              const waiting = session.pending.filter(p => p.section === i).reduce((n, p) => n + p.count, 0);
              return <li key={i} className="rounded-lg border border-zinc-200 dark:border-white/10 p-2 space-y-1">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-semibold text-zinc-800 dark:text-zinc-100">{i + 1}. {section.label}</span>
                  <span className="text-zinc-500">{start === null ? 'not reached in the current take' : `at ${clock(start)}`}</span>
                  {start !== null && <button type="button" onClick={() => play(spine, i)} className="text-cyan-700 dark:text-cyan-300"
                    title="Play the current take from just before this section">
                    {playing?.take === spine.id && playing.section === i ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}</button>}
                  {waiting > 0 && <span className="flex items-center gap-1 text-amber-600"><Loader2 className="w-3 h-3 animate-spin" />{waiting} rendering…</span>}
                  <button type="button" disabled={start === null}
                    onClick={() => call(() => yue2CoverApi.takesGenerate(session.id, i, count, toEnd, token))}
                    title={start === null ? 'Use a take that reaches this section first' : `Keep everything before ${section.label} and compose it again`}
                    className="ml-auto rounded bg-cyan-600 px-2 py-0.5 font-semibold text-white disabled:opacity-40">
                    {count} new take{count > 1 ? 's' : ''}</button>
                </div>
                {takes.length > 0 && <ul className="flex flex-wrap gap-1">
                  {takes.map(take => <li key={take.id} className={`flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px] ${
                    take.id === session.spine ? 'border-emerald-500 bg-emerald-500/10' : 'border-zinc-300 dark:border-white/10'}`}>
                    <button type="button" onClick={() => play(take, i)} aria-label={`Play ${takeName(take)}`}>
                      {playing?.take === take.id && playing.section === i ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}</button>
                    <span>{takeName(take)} · {clock(take.frames)}{take.toEnd ? '' : ' (stops after this section)'}</span>
                    {take.id === session.spine ? <span className="text-emerald-600">current</span>
                      : <button type="button" onClick={() => call(() => yue2CoverApi.takesUse(session.id, take.id, token))}
                        className="text-cyan-700 dark:text-cyan-300">Use</button>}
                  </li>)}
                </ul>}
              </li>;
            })}
          </ol>
          <p className="text-[11px] text-zinc-500">Saving adds the current take as a new library song, without post-processing.
            A take that stops after its section is a partial song: continue from it with the next section, or tick Run to the end.</p>
        </>}
      </div>
    </div>
  );
};
