import { useQuery } from '@tanstack/react-query';
import { queryClient } from '../../queries/client';
import { snapshotOptions } from '../../queries/cover-lyrics/reads';
import { pollWhile } from '../../queries/contract';
import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Loader2, MoreHorizontal, Pause, Play, RotateCcw, Scissors, Square, Trash2, X } from 'lucide-react';
import { yue2CoverApi, type Yue2BuildSession, type Yue2BuildTake } from '../../services/yue2CoverApi';
import { lyricBlockRanges, sectionColours } from '../../utils/abcSections';
import { StyledSelect } from '../shared/StyledSelect';
import { Toggle } from '../shared/Toggle';
import { ParamLabel } from '../shared/ParamLabel';
import { CoverArStrength } from './Yue2CoverPanel';
import { persist, restore, transposeKey } from './coverStudioUtils';
import { EditableSlider } from '../shared/EditableSlider';

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

/** The build's own caption, read from its params the way a render reads it (yue2/generate.ts). */
export const buildCaption = (params: Record<string, unknown> | undefined) =>
  String(params?.prompt || params?.songDescription || params?.caption || params?.style || '');
/** The caption a Generate sends: none while the field still shows the build's, so the takes inherit it. */
export const submittedCaption = (shown: string, original: string) => (shown.trim() === original.trim() ? '' : shown.trim());

/** The cover settings the Build page's row edits: params.yue2Cover's voices,
 *  tempo, keyShift and cfgScale, and the Cover AR strength. */
export interface BuildSettings { voices: 'vocal' | 'both'; tempo: 'free' | 'source' | number; keyShift: number; cfgScale: number; arStrength: number }

/** The first section not yet built. */
export function buildNext(session: Yue2BuildSession | null): number {
  const spine = session?.takes.find(t => t.id === session.kept.at(-1));
  return spine ? spine.to + 1 : 0;
}

/** One occurrence of the output: a score section placed in the song. Kept ones are built and locked.
 *  `lyrics` is its own sung lines, when it has been given some. */
export interface PlanItem { id: string; section: number; kept: boolean; lyrics?: string }

/** The output in order. Before a session exists it is empty: the song is built up from the source bar. */
export function planItems(session: Yue2BuildSession | null): PlanItem[] {
  const built = buildNext(session);
  if (!session) return [];
  const { sections, plan } = session.arrangement;
  return plan.map((o, i) => ({ id: o.id, section: sections.findIndex(s => s.id === o.section), kept: i < built,
    ...(o.lyrics === undefined ? {} : { lyrics: o.lyrics }) }));
}

/** The ids `POST /build/:id/plan` takes for the unbuilt part of the output after `edit`. */
export function editedPlan(items: PlanItem[], next: number,
  edit: { add: number } | { remove: string } | { move: string; by: -1 | 1 }): string[] {
  const upcoming = items.slice(next).map(i => i.id);
  if ('add' in edit) return [...upcoming, `s${edit.add}`];
  if ('remove' in edit) return upcoming.filter(id => id !== edit.remove);
  const at = upcoming.indexOf(edit.move), to = at + edit.by;
  if (at < 0 || to < 0 || to >= upcoming.length) return upcoming;
  [upcoming[at], upcoming[to]] = [upcoming[to], upcoming[at]];
  return upcoming;
}

/** The lyric block an occurrence sings, as text. A session pairs sections with the sung (non-empty) blocks. */
export function occurrenceLyrics(lyrics: string, session: Yue2BuildSession | null, item: PlanItem): string {
  const ranges = lyricBlockRanges(lyrics);
  if (!session) { const r = ranges[item.section]; return r ? lyrics.slice(r.start, r.end).trim() : ''; }
  const sung = ranges.filter(r => lyrics.slice(r.start, r.end).replace(/^[^\n]*/, '').trim());
  const r = sung[session.arrangement.sections[item.section]?.lyricBlock ?? -1];
  return r ? lyrics.slice(r.start, r.end).trim() : '';
}

/** The lines an occurrence sings, without its tag: its own, else its block's. Null for an unsung section. */
export function occurrenceLines(lyrics: string, session: Yue2BuildSession | null, item: PlanItem): string | null {
  const block = occurrenceLyrics(lyrics, session, item);
  if (!block) return null;
  return item.lyrics ?? (/^\[[^\]\n]*\]/.test(block) ? block.replace(/^[^\n]*\n?/, '') : block).trim();
}

/** The lyric edits a Generate applies first: the drafts that differ from what their occurrence sings now. */
export function pendingLyrics(drafts: Record<string, string>, current: Record<string, string | null>): Record<string, string> {
  return Object.fromEntries(Object.entries(drafts).filter(([id, text]) => id in current && current[id] !== null && text.trim() !== current[id]!.trim()));
}

/** Whether a take can be kept now: it resumed the kept build, at the current revision, and composed the planned occurrences. */
export function keepable(session: Yue2BuildSession, take: Yue2BuildTake): boolean {
  const next = buildNext(session);
  const want = session.arrangement.plan.slice(next, take.to + 1).map(o => o.id);
  return take.revision === session.revision && take.parent === (session.kept.at(-1) ?? null) && take.from === next
    && want.length === take.occurrences.length && want.every((id, i) => id === take.occurrences[i]);
}

/** Codec frames a take resumed: its new part starts here. */
export const takePrefix = (take: Yue2BuildTake) => take.prefix ?? take.starts[take.from] ?? 0;

/** Where a cut at `frame` falls in `take` (as the server's cropPlan reads it): the occurrence,
 *  and whether it is inside it, so the user must say whether the next take composes it again. */
export function cropPoint(take: Yue2BuildTake, frame: number): { occurrence: number; inside: boolean } {
  let k = take.from;
  for (let i = take.from + 1; i <= Math.min(take.to + 1, take.starts.length - 1); i++) {
    const at = take.starts[i];
    if (at != null && at <= frame) k = i;
  }
  return { occurrence: k, inside: k <= take.to && take.starts[k] !== frame };
}

/** Where an Apply goes: the loaded session, a draft when there is no session at all, or
 *  nowhere while a saved session is still loading (or failed to), so it cannot be lost to a draft. */
export const lyricsTarget = (sessionId: string, live: unknown): 'session' | 'draft' | 'loading' =>
  live ? 'session' : sessionId ? 'loading' : 'draft';

/** A saved draft's text if it was written for `source`, else null (follow Prepare). */
export const draftText = (draft: { source: string; text: string } | null, source: string): string | null =>
  draft?.source === source ? draft.text : null;

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
    session: live, loading: lyricsTarget(sessionId, live) === 'loading', error: error || snapshot.error?.message || '', busy,
    /** Generates takes, starting the session from `params` if there is none. A non-empty
     *  `caption` is these takes' own; `lyrics` (occurrence id to lines) is applied first. */
    generate: (params: Record<string, unknown>, to: number, count: number, caption: string, lyrics: Record<string, string> = {}) => call(async () => {
      let started = live;
      if (!started) { started = await yue2CoverApi.buildStart(params, token!, draft.text ?? undefined); setSessionId(started.id); }
      if (Object.keys(lyrics).length) started = await yue2CoverApi.buildOccurrenceLyrics(started.id, started.revision, lyrics, token!);
      return yue2CoverApi.buildGenerate(started.id, started.revision, to, count, token!, caption || undefined);
    }),
    /** Gives unbuilt occurrences their own lines, or (null) the build's again. */
    occurrenceLyrics: (edits: Record<string, string | null>) => call(() => yue2CoverApi.buildOccurrenceLyrics(live!.id, live!.revision, edits, token!)),
    /** Applies new cover settings to the session (before its first keep). */
    settings: (settings: Record<string, unknown>) => call(() => yue2CoverApi.buildSettings(live!.id, live!.revision, settings, token!)),
    /** Replaces the unbuilt part of the output, starting the session from `params` if there is none. */
    plan: (params: Record<string, unknown>, upcoming: string[], finished: boolean) => call(async () => {
      let started = live;
      if (!started) { started = await yue2CoverApi.buildStart(params, token!, draft.text ?? undefined); setSessionId(started.id); }
      return yue2CoverApi.buildPlan(started.id, started.revision, upcoming, finished, token!);
    }),
    keep: (take: string) => call(() => yue2CoverApi.buildKeep(live!.id, live!.revision, take, token!)),
    undo: (section?: number) => call(() => yue2CoverApi.buildUndo(live!.id, live!.revision, token!, section)),
    remove: (take: string) => call(() => yue2CoverApi.buildDelete(live!.id, live!.revision, take, token!)),
    cancel: () => call(() => yue2CoverApi.buildCancel(live!.id, token!)),
    /** Cuts the last kept take at codec frame `frame`, or restores it (null). */
    crop: (take: string, frame: number | null, mode?: 'regenerate' | 'advance') =>
      call(() => yue2CoverApi.buildCrop(live!.id, live!.revision, take, frame, mode, token!)),
    /** Applies the build's lyrics: to the session, or to the draft the first session starts from.
     *  True once the server (or, before a session, its validation) accepted them. */
    applyLyrics: async (text: string) => {
      const target = lyricsTarget(sessionId, live);
      if (target === 'loading') { setError('This build is still loading; try again once it has.'); return false; }
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
function Waveform({ peaks, progress, colour, onSeek, marker = null }: { peaks: number[]; progress: number | null; colour: string; onSeek: (fraction: number) => void; marker?: number | null }) {
  if (!peaks.length) return <div className="h-10 flex-1 rounded bg-zinc-200/50 dark:bg-white/5" />;
  const w = 100 / peaks.length;
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-10 flex-1 cursor-pointer"
      onClick={e => { const r = e.currentTarget.getBoundingClientRect(); if (r.width) onSeek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))); }}>
      {peaks.map((p, i) => <rect key={i} x={i * w + w * 0.15} width={w * 0.7} y={20 - Math.max(0.5, p * 19)} height={Math.max(1, p * 38)}
        fill={progress !== null && i / peaks.length <= progress ? colour : '#a1a1aa'} />)}
      {progress !== null && <line x1={progress * 100} x2={progress * 100} y1={0} y2={40} stroke={colour} strokeWidth={0.6} />}
      {marker !== null && <line x1={marker * 100} x2={marker * 100} y1={0} y2={40} stroke="#ef4444" strokeWidth={0.8} />}
    </svg>
  );
}

/** The build's cover settings in one row. Before a build exists they are the
 *  Prepare page's and change at once. A build has its own: edits wait for
 *  Apply, which rebuilds the build's request before its first keep and starts
 *  a fresh build after it. */
function SettingsRow({ value, onApply, build, kept, disabled, keyLabel, sourceBpm }: {
  value: BuildSettings; onApply: (settings: BuildSettings) => void; build: boolean; kept: boolean; disabled: boolean; keyLabel: string; sourceBpm: number;
}) {
  const saved = JSON.stringify(value);
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(JSON.parse(saved)); }, [saved]);
  const shown = build ? draft : value;
  const set = (patch: Partial<BuildSettings>) => { const next = { ...shown, ...patch }; if (build) setDraft(next); else onApply(next); };
  const changed = build && JSON.stringify(draft) !== saved;
  const tempoMode = typeof shown.tempo === 'number' ? 'set' : shown.tempo;
  return (
    <fieldset disabled={disabled} className="border-b border-zinc-200 dark:border-white/10 px-4 py-2 space-y-2">
      <div className="flex flex-wrap items-start gap-x-5 gap-y-3 [&>*]:min-w-[150px] [&>*]:flex-1" aria-label="Build settings">
        <div className="space-y-2">
          <ParamLabel label="Voices" info="Vocal melody alone gives the new style room to choose its instruments. Both keeps the transcribed instrumental line too." />
          <StyledSelect accent="pink" value={shown.voices} disabled={disabled} onChange={v => set({ voices: v as BuildSettings['voices'] })}
            options={[{ value: 'vocal', label: 'Vocal melody only' }, { value: 'both', label: 'Vocal + instrumental line' }]} />
        </div>
        <div className="space-y-2">
          <ParamLabel label="Tempo" info="Free removes the score tempo; Source retains it; Set writes a target BPM using the score's beat unit." />
          <StyledSelect accent="pink" value={tempoMode} disabled={disabled}
            onChange={v => set({ tempo: v === 'set' ? (typeof shown.tempo === 'number' ? shown.tempo : Math.max(20, Math.min(300, sourceBpm))) : v as 'free' | 'source' })}
            options={[{ value: 'free', label: 'Free (style decides)' }, { value: 'source', label: 'Source tempo' }, { value: 'set', label: 'Set BPM' }]} />
        </div>
        {typeof shown.tempo === 'number' && <EditableSlider label="Target BPM" value={shown.tempo} min={20} max={300} step={1} disabled={disabled}
          onChange={v => set({ tempo: v })} helpText={`Source: ${sourceBpm} BPM`} />}
        <EditableSlider label="Pitch Shift" value={shown.keyShift} min={-12} max={12} step={1} defaultValue={0} disabled={disabled || !keyLabel}
          onChange={v => set({ keyShift: v })}
          formatDisplay={v => v === 0 ? 'Source key' : `${v > 0 ? '+' : ''}${v} st → ${transposeKey(keyLabel, v)}`}
          helpText={keyLabel ? `Source: ${keyLabel}.` : 'No supported score key found.'}
          tooltip="Moves the score up or down by whole semitones, within twelve." />
        <EditableSlider label="Condition strength" value={shown.cfgScale} min={0.1} max={2} step={0.05} defaultValue={1} disabled={disabled}
          onChange={v => set({ cfgScale: v })} tooltip="Tightens style, lyrics and score together." />
        <CoverArStrength value={shown.arStrength} onChange={v => set({ arStrength: v })} />
      </div>
      {build && (changed || kept) && <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        <span className="flex-1">{kept
          ? 'The kept sections were built with the settings above. Changing them starts a fresh build; this one is set aside.'
          : 'Applying rebuilds this build with the new settings. Takes made before it can no longer be kept.'}</span>
        {changed && <>
          <button type="button" onClick={() => setDraft(JSON.parse(saved))} className="rounded-lg px-3 py-1 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Discard</button>
          <button type="button" onClick={() => onApply(draft)}
            className="rounded-lg bg-cyan-600 px-3 py-1 font-semibold text-white disabled:opacity-40">{kept ? 'Start a fresh build with these' : 'Apply'}</button>
        </>}
      </div>}
    </fieldset>
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
  /** A saved build is still loading, so its lyrics cannot be edited yet. */
  loading: boolean;
  /** The settings the build uses: the session's once it exists, else the Prepare page's. */
  settings: BuildSettings;
  /** Sets them: on the Prepare page before a build exists, on the build before its
   *  first keep, and through a fresh build after it. */
  onSettings: (settings: BuildSettings) => void;
  /** The score's key ('' when it has none) and tempo, for the pitch and BPM readouts. */
  keyLabel: string;
  sourceBpm: number;
  title: string;
  /** Why a build cannot start yet, or ''. */
  blocked: string;
  busy: boolean;
  error: string;
  /** The build's caption, which the caption field starts from for each section. */
  caption: string;
  /** `caption`, when non-empty, is these takes' own; `lyrics` (occurrence id to lines) is applied first. True once queued. */
  onGenerate: (to: number, count: number, caption: string, lyrics: Record<string, string>) => Promise<boolean>;
  /** Gives unbuilt occurrences their own lines, or (null) the build's again. */
  onOccurrenceLyrics: (edits: Record<string, string | null>) => void;
  /** Sets what the unbuilt part of the output is: section ids (s0...) or upcoming occurrence ids (o3...). */
  onPlan: (upcoming: string[], finished: boolean) => void;
  onCancel: () => void;
  onKeep: (take: string) => void;
  onDelete: (take: string) => void;
  onUndo: (section?: number) => void;
  /** Cuts the last kept take at a codec frame, or restores it (null). The crop row shows only when given. */
  onCrop?: (take: string, frame: number | null, mode?: 'regenerate' | 'advance') => void;
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
  const [target, setTarget] = useState<string | null>(null);
  const [count, setCount] = useState(3);
  const [menu, setMenu] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [cropping, setCropping] = useState(false);
  const [cutAt, setCutAt] = useState<number | null>(null);
  const [cropMode, setCropMode] = useState<'regenerate' | 'advance' | null>(null);
  const [caption, setCaption] = useState(p.caption);
  const dragging = useRef(false);
  const s = p.session;
  const next = buildNext(s);
  const spine = s?.takes.find(t => t.id === s.kept.at(-1)) ?? null;
  const colours = sectionColours(p.sections.map(x => x.label));
  const items = planItems(s);
  const finished = s?.arrangement.finished ?? false;
  const targetAt = items.findIndex(i => i.id === target);
  const range = targetAt >= next ? targetAt : null;
  const candidates = s?.takes.filter(t => t.from === next && t.parent === (spine?.id ?? null)) ?? [];
  const waiting = s?.pending.reduce((n, x) => n + x.count, 0) ?? 0;
  const chunk = s?.pending[0];
  const chunkStage = ({ starting: 'Starting', semantic: 'Composing', plan: 'Planning', nar: 'Rendering', vae: 'Decoding audio', aligning: 'Aligning lyrics' } as Record<string, string>)[chunk?.phase ?? ''] ?? 'Rendering';
  const done = !!items.length && next >= items.length;
  const editable = !p.busy && waiting === 0 && !p.loading;
  const nameOf = (i: PlanItem) => p.sections[i.section]?.label ?? '?';

  // Each section starts from the build's caption.
  useEffect(() => { setTarget(null); setCaption(p.caption); }, [next, s?.id, p.caption]);
  // A cut belongs to the kept take it was set on; the choice belongs to the cut.
  useEffect(() => { setCutAt(null); setCropMode(null); }, [spine?.id]);
  useEffect(() => { setCropMode(null); }, [cutAt]);
  // Lyric drafts belong to the build they were typed in.
  useEffect(() => { setDrafts({}); }, [s?.id]);
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
    const start = takePrefix(take) / FPS;
    return { from: Math.max(0, start - (start ? LEAD_IN : 0)), to: take.frames / FPS, newPart: take.frames / FPS - start };
  };

  // Lyrics of the chosen sections (block i pairs with section i).
  const shown = done ? [] : items.slice(next, (range ?? next) + 1).map(i => ({ item: i, lines: occurrenceLines(p.lyrics, s, i) }));
  const current = Object.fromEntries(shown.map(x => [x.item.id, x.lines]));
  const generate = async () => {
    if (range === null) return;
    if (await p.onGenerate(range, count, submittedCaption(caption, p.caption), pendingLyrics(drafts, current))) setDrafts({});
  };
  const bars = (i: number) => s?.arrangement.sections[i]?.bars ?? (p.sections[i + 1]?.startBar ?? p.totalBars + 1) - p.sections[i].startBar;
  const rangeLabel = range === null ? '' : `${nameOf(items[next])}${range > next ? ` → ${nameOf(items[range])}` : ''}`;
  const edit = (change: Parameters<typeof editedPlan>[2], ends = finished) => p.onPlan(editedPlan(items, next, change), ends);
  // Cropping cuts the uncropped kept take, so a later cut can reach past an earlier one.
  const cropBase = spine ? s?.takes.find(t => t.id === spine.cropOf) ?? spine : null;
  const cropWin = cropBase ? takeWindow(cropBase) : null;
  const cutFrame = cutAt === null ? null : Math.round(cutAt * FPS);
  const cutValid = !!cropBase && cutFrame !== null && cutFrame > takePrefix(cropBase) && cutFrame < cropBase.frames;
  const cut = cropBase && cutValid ? cropPoint(cropBase, cutFrame!) : null;
  const cutItem = cut ? items[cut.occurrence] : undefined;
  /** ", ≈ bar 3 of 8": the cut's share of the time between the occurrence's start and the next one's. */
  const cutBar = (() => {
    if (!cut?.inside || !cropBase || !cutItem) return '';
    const a = cropBase.starts[cut.occurrence], b = cropBase.starts[cut.occurrence + 1];
    if (a == null || b == null || b <= a) return '';
    const n = bars(cutItem.section);
    return `, ≈ bar ${Math.min(n, Math.floor((n * (cutFrame! - a)) / (b - a)) + 1)} of ${n} (approximate)`;
  })();
  const crop = (frame: number | null, mode?: 'regenerate' | 'advance') => { stop(); if (spine) p.onCrop?.(spine.id, frame, mode); };

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <audio ref={audioRef} className="hidden" onEnded={() => { setPlaying(null); setProgress(null); }}
        onPlay={() => setPaused(false)} onPause={() => setPaused(true)}
        onTimeUpdate={e => { if (playing) setProgress(Math.min(1, Math.max(0, (e.currentTarget.currentTime - playing.from) / Math.max(0.1, playing.to - playing.from)))); }} />
      {/* Top bar: what is being built and how. */}
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 dark:border-white/10 px-4 py-2">
        <button type="button" onClick={p.onBack} className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-300 hover:text-cyan-600">
          <ArrowLeft className="w-3.5 h-3.5" />Prepare</button>
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-900 dark:text-white">{p.title}</p>
        <div className="relative">
          <button type="button" onClick={() => setMenu(m => !m)} disabled={!s} aria-label="Build actions"
            className="rounded p-1.5 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-white/10 disabled:opacity-40"><MoreHorizontal className="w-4 h-4" /></button>
          {menu && s && <div className="absolute right-0 top-8 z-20 w-44 rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-zinc-900 py-1 text-xs shadow-xl"
            onMouseLeave={() => setMenu(false)}>
            <button type="button" disabled={!s.kept.length} onClick={() => { setMenu(false); undo(); }}
              className="block w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-white/5 disabled:opacity-40">Undo last keep</button>
            <button type="button" disabled={!s.kept.length} onClick={() => { setMenu(false); p.onSave(); }}
              title="Render everything kept so far as a library song; this ends the build"
              className="block w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-white/5 disabled:opacity-40">Render the song so far</button>
            <button type="button" onClick={() => { setMenu(false); p.onStartOver(); }}
              className="block w-full px-3 py-1.5 text-left text-red-500 hover:bg-zinc-100 dark:hover:bg-white/5">Start over</button>
          </div>}
        </div>
      </div>

      <SettingsRow value={p.settings} onApply={p.onSettings} build={!!s} kept={!!s?.kept.length} disabled={!editable}
        keyLabel={p.keyLabel} sourceBpm={p.sourceBpm} />

      {/* Source bar: the score as it is. Song bar: what the output will be, kept occurrences first. */}
      <div className="border-b border-zinc-200 dark:border-white/10 px-4 py-3 space-y-2">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className="font-semibold uppercase tracking-wide">Source</span>
          <span className="ml-auto">Click a section to add it to the end of the song; repeat it as often as you like.</span>
        </div>
        <div className="flex gap-1 select-none" aria-label="Source sections">
          {p.sections.map((section, i) => {
            const uses = items.filter(x => x.section === i).length;
            return <button type="button" key={i} disabled={!editable}
              style={{ flexGrow: Math.max(1, bars(i)), flexBasis: 0, borderColor: colours[i], backgroundColor: `${colours[i]}22` }}
              onClick={() => p.onPlan(editedPlan(items, next, { add: i }), finished)}
              title={`Add ${section.label} to the end of the song`}
              className="min-w-0 rounded-md border-t-4 px-1.5 py-1 text-left disabled:opacity-40">
              <p className="truncate text-[11px] font-semibold text-zinc-800 dark:text-zinc-100">{section.label}</p>
              <p className="truncate text-[10px] text-zinc-500">{bars(i)} bars{uses > 1 ? ` · used ${uses}×` : ''}</p>
            </button>;
          })}
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className="font-semibold uppercase tracking-wide">Song</span>
          <button type="button" disabled={!spine} onClick={() => spine && toggle('build', spine.audioUrl, 0, spine.frames / FPS)}
            className="flex items-center gap-1 text-cyan-700 dark:text-cyan-300 disabled:opacity-40">
            {playing?.key === 'build' && !paused ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}Play build</button>
          <Toggle size="sm" accent="cyan" checked={finished} disabled={!editable} label="Ends the song"
            info="Tick it before building the last section: that take composes an ending. Until then each take runs a few seconds into the section that follows it in the source, so the next one has a seam to start from."
            onChange={ends => p.onPlan(items.slice(next).map(i => i.id), ends)} />
          <span className="ml-auto">{!items.length ? 'Add sections from the source bar above.' : done ? 'Every section is built.' : `Click a section to build up to it, starting from ${nameOf(items[next])}.`}</span>
        </div>
        <div className="flex gap-1 select-none" aria-label="Song sections">
          {items.map((item, i) => {
            const picked = range !== null && i >= next && i <= range;
            const start = spine?.starts[i];
            return <div key={item.id} style={{ flexGrow: Math.max(1, bars(item.section)), flexBasis: 0, borderColor: colours[item.section],
              backgroundColor: item.kept ? `${colours[item.section]}55` : picked ? `${colours[item.section]}33` : `${colours[item.section]}12` }}
              onClick={() => { if (item.kept) { if (spine && start != null) toggle(`s${item.id}`, spine.audioUrl, start / FPS, spine.frames / FPS); } else setTarget(item.id); }}
              title={item.kept ? `Play the build from ${nameOf(item)}` : `Build up to ${nameOf(item)}`}
              className={`group relative min-w-0 cursor-pointer rounded-md border-t-4 px-1.5 py-1 ${picked ? 'ring-2 ring-pink-500' : ''} ${!item.kept && i > next && !picked ? 'opacity-60' : ''}`}>
              <p className="truncate text-[11px] font-semibold text-zinc-800 dark:text-zinc-100">
                {item.kept ? '✓ ' : i === next ? '→ ' : ''}{nameOf(item)}</p>
              <p className="truncate text-[10px] text-zinc-500">{item.kept ? (start != null ? clock(start / FPS) : 'built') : i === next ? 'next' : `${bars(item.section)} bars`}</p>
              {item.kept && <button type="button" onClick={e => { e.stopPropagation(); undo(i); }}
                title={`Undo back to ${nameOf(item)}, to build it again`}
                className="absolute right-1 top-1 hidden rounded p-0.5 text-zinc-500 hover:text-pink-500 group-hover:block"><RotateCcw className="w-3 h-3" /></button>}
              {!item.kept && <div className="absolute right-0.5 top-0.5 hidden items-center group-hover:flex">
                <button type="button" disabled={!editable || i === next} onClick={e => { e.stopPropagation(); edit({ move: item.id, by: -1 }); }}
                  aria-label={`Move ${nameOf(item)} earlier`} className="rounded p-0.5 text-zinc-500 hover:text-pink-500 disabled:opacity-30"><ChevronLeft className="w-3 h-3" /></button>
                <button type="button" disabled={!editable || i === items.length - 1} onClick={e => { e.stopPropagation(); edit({ move: item.id, by: 1 }); }}
                  aria-label={`Move ${nameOf(item)} later`} className="rounded p-0.5 text-zinc-500 hover:text-pink-500 disabled:opacity-30"><ChevronRight className="w-3 h-3" /></button>
                <button type="button" disabled={!editable || items.length - next < 2} onClick={e => { e.stopPropagation(); edit({ remove: item.id }); }}
                  aria-label={`Remove ${nameOf(item)} from the song`} className="rounded p-0.5 text-zinc-500 hover:text-red-500 disabled:opacity-30"><X className="w-3 h-3" /></button>
              </div>}
            </div>;
          })}
        </div>
        {spine && p.onCrop && <div className="flex items-center gap-2 text-xs text-zinc-500">
          <button type="button" onClick={() => setCropping(c => !c)} disabled={!editable}
            className="flex items-center gap-1 text-cyan-700 dark:text-cyan-300 disabled:opacity-40"><Scissors className="w-3 h-3" />
            {cropping ? 'Close crop' : 'Crop the last kept take'}</button>
          {spine.cropOf && <>
            <span>Cropped at {clock(spine.frames / FPS)}.</span>
            <button type="button" onClick={() => crop(null)} disabled={!editable}
              className="text-cyan-700 dark:text-cyan-300 disabled:opacity-40">Undo crop</button>
          </>}
        </div>}
        {p.onCrop && cropping && cropBase && cropWin && <div className="space-y-2 rounded-lg border border-zinc-200 dark:border-white/10 p-2 text-xs text-zinc-500">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => toggle('crop', cropBase.audioUrl, cropWin.from, cropWin.to)}
              aria-label={playing?.key === 'crop' && !paused ? 'Pause the kept take' : 'Play the kept take'}
              className="rounded-full bg-zinc-100 dark:bg-white/10 p-2 text-zinc-700 dark:text-zinc-200 hover:text-pink-500">
              {playing?.key === 'crop' && !paused ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}</button>
            <Waveform peaks={cropBase.peaks ?? []} progress={playing?.key === 'crop' ? progress : null} colour="#06b6d4"
              marker={cutAt === null ? null : Math.min(1, Math.max(0, (cutAt - cropWin.from) / Math.max(0.1, cropWin.to - cropWin.from)))}
              onSeek={f => setCutAt(Math.round((cropWin.from + f * (cropWin.to - cropWin.from)) * FPS) / FPS)} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ParamLabel label="Cut at (s)" className="text-xs text-zinc-500"
              info="Where the build stops, in seconds from the start of the song, on the composer's clock of 25 frames per second. Only the part this take composed can be cut. Click the waveform, or use Cut at playhead while it plays. The original stays: Undo crop puts it back." />
            <input type="number" step={0.04} min={0} value={cutAt ?? ''} aria-label="Cut at, seconds"
              onChange={e => setCutAt(e.target.value === '' ? null : Number(e.target.value))}
              className="w-24 rounded border border-zinc-300 dark:border-white/10 bg-white dark:bg-black/30 px-2 py-0.5 font-mono text-xs text-zinc-800 dark:text-zinc-200" />
            <button type="button" disabled={playing?.key !== 'crop'}
              onClick={() => { const t = audioRef.current?.currentTime; if (t !== undefined) setCutAt(Math.round(t * FPS) / FPS); }}
              className="text-cyan-700 dark:text-cyan-300 disabled:opacity-40">Cut at playhead</button>
            <span>
              {cutAt === null ? `Between ${clock(takePrefix(cropBase) / FPS)} and ${clock(cropBase.frames / FPS)}.`
                : !cut ? `Outside the part this take composed (${clock(takePrefix(cropBase) / FPS)} to ${clock(cropBase.frames / FPS)}).`
                : cut.occurrence > cropBase.to ? 'After the next section starts: only the tail the final render plays is cut.'
                : `${cut.inside ? 'Inside' : 'At the start of'} ${cutItem ? nameOf(cutItem) : 'a section'}${cutBar}.`}
            </span>
          </div>
          {cut?.inside && cutItem && <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="What the next take does">
            <span>The next take:</span>
            {([['regenerate', `composes ${nameOf(cutItem)} again from the cut`],
              ['advance', items[cut.occurrence + 1] ? `moves on to ${nameOf(items[cut.occurrence + 1])}` : `keeps ${nameOf(cutItem)} cut short and ends the song`]] as const)
              .map(([mode, text]) => <button type="button" key={mode} role="radio" aria-checked={cropMode === mode} onClick={() => setCropMode(mode)}
                className={`rounded-lg border px-2 py-1 ${cropMode === mode ? 'border-cyan-500 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300' : 'border-zinc-300 dark:border-white/10'}`}>{text}</button>)}
          </div>}
          <button type="button" disabled={!editable || !cut || (cut.inside && !cropMode)}
            onClick={() => cutFrame !== null && crop(cutFrame, cut?.inside ? cropMode ?? undefined : undefined)}
            className="rounded-lg bg-cyan-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-40">Crop</button>
        </div>}
      </div>

      {/* The next sections: their lyrics, and their takes. */}
      <div className="flex-1 min-h-0 grid grid-cols-[minmax(240px,1fr)_minmax(320px,1.4fr)] overflow-hidden">
        <div className="min-h-0 overflow-y-auto border-r border-zinc-200 dark:border-white/10 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <p className="flex-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              {done ? 'Done' : items.length ? `Building: ${rangeLabel || nameOf(items[next])}` : 'Nothing to build yet'}</p>
            {p.lyrics !== p.prepareLyrics && <button type="button" onClick={() => void p.onApplyLyrics(p.prepareLyrics)} disabled={!editable}
              title="Replace this build's lyrics with the Prepare page's, for every section not yet built"
              className="text-xs text-zinc-500 hover:text-cyan-600 disabled:opacity-40">Use Prepare lyrics</button>}
          </div>
          {shown.map(({ item, lines }) => <div key={item.id} className="space-y-1">
            <div className="flex items-center gap-2">
              <p className="flex-1 text-xs font-semibold text-zinc-700 dark:text-zinc-200">{nameOf(item)}</p>
              {lines !== null && (item.lyrics !== undefined || item.id in drafts) && <button type="button" disabled={!editable}
                onClick={() => { setDrafts(d => Object.fromEntries(Object.entries(d).filter(([id]) => id !== item.id))); if (item.lyrics !== undefined) p.onOccurrenceLyrics({ [item.id]: null }); }}
                title="Sing this build's lyrics for this section again"
                className="flex items-center gap-1 text-xs text-zinc-500 hover:text-cyan-600 disabled:opacity-40"><RotateCcw className="w-3 h-3" />Reset</button>}
            </div>
            {lines === null ? <p className="text-xs text-zinc-500">Instrumental: no lyrics for this section.</p>
              : <textarea value={drafts[item.id] ?? lines} disabled={!editable} maxLength={20000} spellCheck={false}
                rows={Math.min(14, Math.max(3, (drafts[item.id] ?? lines).split('\n').length + 1))}
                aria-label={`Lyrics for ${nameOf(item)}`}
                onChange={e => { const text = e.target.value; setDrafts(d => ({ ...d, [item.id]: text })); }}
                className="w-full rounded-lg border border-zinc-300 dark:border-white/10 bg-white dark:bg-black/30 p-2 font-mono text-sm leading-relaxed text-zinc-800 dark:text-zinc-200" />}
          </div>)}
          {shown.length > 0 && <p className="text-xs text-zinc-500">
            Edits apply to this section only, when you generate. The Prepare page, the dataset and other copies of the section keep theirs.
            {candidates.length && Object.keys(pendingLyrics(drafts, current)).length ? ' Takes made with the old lyrics can no longer be kept.' : ''}
          </p>}
        </div>
        <div className="min-h-0 flex flex-col p-4 gap-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Takes</p>
          <div className="flex-1 min-h-0 overflow-y-auto space-y-2">
            {candidates.map((take, i) => {
              const win = takeWindow(take);
              const colour = colours[items[take.from]?.section ?? -1] ?? '#ec4899';
              return <div key={take.id} className="flex items-center gap-3 rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-black/20 px-3 py-2">
                <span className="w-12 text-xs font-semibold text-zinc-700 dark:text-zinc-200" title={take.style ? `Sent: ${take.style}` : take.cropOf ? 'A cropped copy of a take' : undefined}>
                  Take {i + 1}{take.cropOf ? ' ✂' : ''}{take.caption ? ' ✎' : ''}</span>
                <button type="button" onClick={() => toggle(take.id, take.audioUrl, win.from, win.to)} aria-label={playing?.key === take.id && !paused ? `Pause take ${i + 1}` : `Play take ${i + 1}`}
                  className="rounded-full bg-zinc-100 dark:bg-white/10 p-2 text-zinc-700 dark:text-zinc-200 hover:text-pink-500">
                  {playing?.key === take.id && !paused ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}</button>
                {playing?.key === take.id && <button type="button" onClick={stop} aria-label={`Stop take ${i + 1}`}
                  className="rounded-full bg-zinc-100 dark:bg-white/10 p-2 text-zinc-700 dark:text-zinc-200 hover:text-pink-500"><Square className="w-3.5 h-3.5" /></button>}
                <Waveform peaks={take.peaks ?? []} progress={playing?.key === take.id ? progress : null} colour={colour} onSeek={f => seek(take.id, take.audioUrl, win.from, win.to, f)} />
                <span className="w-10 text-right font-mono text-xs text-zinc-500" title="Length of the new part">{clock(win.newPart)}</span>
                <button type="button" onClick={() => keep(take.id)} disabled={p.busy || !s || !keepable(s, take)}
                  title={s && !keepable(s, take) ? 'Made before the lyrics or the arrangement changed; generate it again' : undefined}
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
            {!candidates.length && !waiting && !done && <p className="text-xs text-zinc-500">{items.length ? 'No takes yet. Choose sections on the song bar, then generate.' : 'No takes yet. Add the sections you want from the source bar, then generate.'}</p>}
            {s?.error && <p role="alert" className="text-xs text-red-500">Last take failed: {s.error}</p>}
          </div>
          {!done && <div className="space-y-1">
            <div className="flex items-center gap-2">
              <ParamLabel label="Caption" className="text-xs text-zinc-500"
                info="The caption for this section's takes, starting from the build's. Edit it to steer this section only; the next section starts from the build's again. It changes what is composed (the AR), and the adapter trigger is still added. The sound of the whole song is rendered (the NAR) with one caption: a take's preview uses its own for everything it plays, and Render Final Song uses the build's for the whole song. Hover a take's name to see the prompt it was sent; ✎ marks a take with its own caption." />
              <input type="text" value={caption} maxLength={4000} placeholder="The build's caption" aria-label="Caption for this section's takes"
                onChange={e => setCaption(e.target.value)}
                className="min-w-0 flex-1 rounded border border-zinc-300 dark:border-white/10 bg-white dark:bg-black/30 px-2 py-0.5 text-xs text-zinc-800 dark:text-zinc-200" />
              {caption !== p.caption && <button type="button" onClick={() => setCaption(p.caption)} title="Back to the build's caption"
                aria-label="Back to the build's caption" className="rounded p-1 text-zinc-500 hover:text-cyan-600"><RotateCcw className="w-3 h-3" /></button>}
            </div>
            <div className="flex items-center gap-2">
              <div className="w-20 flex-shrink-0" title="Takes per run">
                <StyledSelect accent="pink" value={count} onChange={v => setCount(Number(v))}
                  options={Array.from({ length: 10 }, (_, k) => ({ value: k + 1, label: String(k + 1) }))} />
              </div>
              <button type="button" onClick={() => void generate()} disabled={range === null || p.busy || waiting > 0 || !!p.blocked}
                className="flex-1 rounded-xl bg-gradient-to-r from-pink-600 to-purple-600 py-2.5 text-sm font-bold text-white disabled:opacity-40">
                {range === null ? 'Choose sections on the song bar' : `Generate ${count} take${count > 1 ? 's' : ''} of ${rangeLabel}`}</button>
            </div>
            {p.blocked && <p className="text-xs text-amber-600">{p.blocked}</p>}
            {p.error && <p role="alert" className="text-xs text-red-500">{p.error}</p>}
          </div>}
          {done && <button type="button" onClick={p.onSave} disabled={p.busy}
            title="Render every kept section as one library song, with the usual post-processing"
            className="w-full rounded-xl bg-gradient-to-r from-emerald-600 to-cyan-600 py-4 text-base font-bold text-white disabled:opacity-40">Render Final Song</button>}
        </div>
      </div>
    </div>
  );
};
