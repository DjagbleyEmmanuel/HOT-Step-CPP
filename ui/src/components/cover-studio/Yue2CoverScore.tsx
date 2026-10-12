import React, { useEffect, useRef, useState } from 'react';
import abcjs from 'abcjs';
import 'abcjs/abcjs-audio.css';
import { followNoteInBox } from '../../utils/abcFollow';
import { abcSectionMarks, sectionAtChar, sectionColours } from '../../utils/abcSections';
import { withChoirVocal } from '../../utils/abcChoirVocal';
import { barAtChar, barRanges, moveSectionStart } from '../../utils/abcSectionMove';
import { AbcChart } from './AbcChart';
import { MusicXmlImport } from './MusicXmlImport';
import type { Yue2CoverJob, Yue2CoverReadiness } from '../../services/yue2CoverApi';

interface Props {
  height: number;
  /** ABC beside the rendered score instead of above it. */
  wide: boolean;
  sourceReady: boolean;
  sourceMode: 'audio' | 'musicxml';
  readiness: Yue2CoverReadiness | null;
  job: Yue2CoverJob | null;
  preparing: boolean;
  error: string;
  abc: string;
  sourceKey: string;
  scoreSource?: 'dataset' | null;
  approved: boolean;
  onAbcChange: (value: string) => void;
  onTranscribe: () => void;
  onCancel: () => void;
  onApprove: () => void;
  /** Play from this score section; a new object each click, so a repeat
   *  click on the same section plays it again. */
  seekSection?: { index: number } | null;
  /** The score section now playing or just picked. */
  onSection?: (index: number) => void;
}

type Tune = ReturnType<typeof abcjs.renderAbc>[number];
type TimingEvent = InstanceType<typeof abcjs.TimingCallbacks>['noteTimings'][number];

/** Colours each rendered note and bar by its score section and draws a
 *  labelled line where each section starts; clicking a label plays from it.
 *  Sections come from the ABC's `%Label` lines by character offset, the same
 *  offsets abcjs records on each element, so multi-bar rests (Z4) and the
 *  interleaved Vocal/Ins voices need no bar counting. Returns each section's
 *  first timed event, the seek target, or null for a section with no notes. */
function markSections(tune: Tune, abc: string, host: HTMLElement, onPick: (index: number) => void,
  onMove: (index: number, bar: number) => void): Array<TimingEvent | null> {
  const marks = abcSectionMarks(abc);
  if (!marks.length) return [];
  const colours = sectionColours(marks.map(mark => mark.label));
  type Item = { startChar?: number; abselem?: { elemset?: Array<SVGElement | null> } };
  for (const line of tune.lines ?? [])
    for (const staff of line.staff ?? [])
      for (const voice of (staff.voices ?? []) as unknown as Item[][])
        for (const item of voice) {
          if (typeof item.startChar !== 'number') continue;
          const index = sectionAtChar(marks, item.startChar);
          // An attribute, not a style: the playing note's highlight class must still win.
          if (index >= 0) item.abselem?.elemset?.forEach(node => node?.setAttribute('fill', colours[index]));
        }
  // Timings are sorted by time, so the first event to touch a section is its start.
  const starts: Array<TimingEvent | null> = marks.map(() => null);
  const events: TimingEvent[] = [];
  for (const event of new abcjs.TimingCallbacks(tune, {}).noteTimings) {
    if (event.type !== 'event' || event.left == null) continue;
    events.push(event);
    for (const char of event.startCharArray ?? []) {
      const index = sectionAtChar(marks, char);
      if (index >= 0 && !starts[index]) starts[index] = event;
    }
  }
  const svg = host.querySelector('svg');
  const ns = 'http://www.w3.org/2000/svg';
  starts.forEach((start, index) => {
    if (!svg || !start || start.left == null || start.top == null || start.height == null) return;
    const x = start.left - 3;
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('class', 'cursor-grab');
    // Click plays from the section; a drag drops its start on another bar.
    g.addEventListener('pointerdown', down => {
      const ctm = svg.getScreenCTM()?.inverse();
      if (!ctm || down.button !== 0) return;
      down.preventDefault();
      const toSvg = (e: PointerEvent) => new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm);
      const origin = toSvg(down);
      let dragging = false;
      const move = (e: PointerEvent) => {
        if (!dragging && Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 4) return;
        dragging = true;
        const at = toSvg(e);
        g.setAttribute('transform', `translate(${at.x - origin.x} ${at.y - origin.y})`);
      };
      const up = (e: PointerEvent) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        g.removeAttribute('transform');
        if (!dragging) { onPick(index); return; }
        const at = toSvg(e);
        const char = dropChar(events, x + at.x - origin.x, start.top! + start.height! / 2 + at.y - origin.y);
        const bar = char === null ? null : barAtChar(abc, char);
        if (bar !== null) onMove(index, bar);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    const rule = document.createElementNS(ns, 'line');
    Object.entries({ x1: x, x2: x, y1: start.top, y2: start.top + start.height, stroke: colours[index], 'stroke-width': 2 })
      .forEach(([key, value]) => rule.setAttribute(key, String(value)));
    const text = document.createElementNS(ns, 'text');
    Object.entries({ x: x + 3, y: Math.max(10, start.top - 2), fill: colours[index], 'font-size': 11, 'font-weight': 700 })
      .forEach(([key, value]) => text.setAttribute(key, String(value)));
    text.textContent = `▶ ${marks[index].label}`;
    const title = document.createElementNS(ns, 'title');
    title.textContent = `Click to play from ${marks[index].label}; drag onto a bar to move where it starts`;
    // A wide invisible stroke so the 2px rule is easy to grab.
    const grip = rule.cloneNode() as SVGLineElement;
    grip.setAttribute('stroke', 'transparent');
    grip.setAttribute('stroke-width', '10');
    g.append(title, grip, rule, text);
    svg.appendChild(g);
  });
  return starts;
}

/** The ABC offset of the first note at or right of `x` on the system nearest
 *  `y` (SVG units), or of the next system's first note past its end. */
function dropChar(events: TimingEvent[], x: number, y: number): number | null {
  const systems = [...new Set(events.map(event => event.line ?? 0))].sort((a, b) => a - b);
  const centre = (line: number) => {
    const first = events.find(event => (event.line ?? 0) === line)!;
    return (first.top ?? 0) + (first.height ?? 0) / 2;
  };
  const nearest = systems.reduce((best, line) => Math.abs(centre(line) - y) < Math.abs(centre(best) - y) ? line : best, systems[0]);
  const pick = (line: number, fromX: number) => events
    .filter(event => (event.line ?? 0) === line && (event.left ?? 0) >= fromX)
    .sort((a, b) => (a.left ?? 0) - (b.left ?? 0))[0];
  const after = systems[systems.indexOf(nearest) + 1];
  const hit = pick(nearest, x - 4) ?? (after === undefined ? undefined : pick(after, -Infinity));
  return hit?.startCharArray?.find(char => typeof char === 'number') ?? null;
}

export const Yue2CoverScore: React.FC<Props> = p => {
  const scoreRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLDivElement>(null);
  const [previewValid, setPreviewValid] = useState(false);
  const [moveError, setMoveError] = useState('');
  // The last section drag, undoable while the ABC is still its result.
  const [undoMove, setUndoMove] = useState<{ before: string; after: string } | null>(null);
  // Plays from score section i, or from score bar n; replaced on every render of the ABC.
  const playFromRef = useRef<(index: number) => Promise<void>>(async () => {});
  const playBarRef = useRef<(bar: number) => Promise<void>>(async () => {});
  // The left pane shows the raw ABC or the same score as a song chart.
  const [view, setView] = useState<'abc' | 'chart'>(() =>
    localStorage.getItem('cover-studio-abcView') === 'chart' ? 'chart' : 'abc');
  useEffect(() => { localStorage.setItem('cover-studio-abcView', view); }, [view]);
  const [playingBar, setPlayingBar] = useState<number | null>(null);
  const onSectionRef = useRef(p.onSection);
  const onAbcChangeRef = useRef(p.onAbcChange);
  useEffect(() => { onSectionRef.current = p.onSection; onAbcChangeRef.current = p.onAbcChange; });
  useEffect(() => {
    if (p.seekSection) void playFromRef.current(p.seekSection.index);
  }, [p.seekSection]);
  const busy = p.preparing || p.job?.status === 'queued' || p.job?.status === 'running';
  // Side by side, the ABC and the score share the panel's height, less its
  // heading, the import row and the approve button.
  const boxHeight = p.wide ? Math.max(128, p.height - 158) : undefined;
  const viewToggle = <div className="inline-flex rounded-md border border-zinc-300 dark:border-white/10 text-[11px]">
    {(['abc', 'chart'] as const).map(mode => <button key={mode} type="button" onClick={() => setView(mode)}
      className={`px-2 py-0.5 ${view === mode ? 'bg-cyan-500/20 text-cyan-700 dark:text-cyan-300' : 'text-zinc-500'}`}>
      {mode === 'abc' ? 'ABC' : 'Chart'}</button>)}
  </div>;
  const editor = view === 'chart' && p.abc.trim()
    ? <AbcChart abc={p.abc} disabled={busy} height={boxHeight ?? 320} playingBar={playingBar}
      onAbcChange={p.onAbcChange} onPlayBar={bar => void playBarRef.current(bar)} />
    : <textarea aria-label="Editable ABC score" value={p.abc} disabled={busy} onChange={e => p.onAbcChange(e.target.value)}
    placeholder="Paste an ABC score here to skip transcription" style={{ height: boxHeight }}
    className={`w-full ${p.wide ? 'resize-none' : 'h-28 resize-y'} rounded-lg border border-zinc-300 dark:border-white/10 bg-white dark:bg-black/20 p-2 text-xs font-mono text-zinc-900 dark:text-white`} />;
  const transcribe = <button onClick={p.onTranscribe} disabled={!p.sourceReady || busy || p.readiness?.ready === false}
    className="rounded-lg bg-cyan-500/20 px-3 py-1.5 text-xs text-cyan-700 dark:text-cyan-300 disabled:opacity-40">
    {p.abc ? 'Retry transcription' : 'Transcribe full score'}
  </button>;
  // The ABC and the score, under the import row so both start level. The
  // score scales to its column (responsive: 'resize'), so the half-width one
  // zooms out. Wrapping it in MusicXmlImport or not (and a new sourceKey)
  // remounts scoreRef's div, which is why the render effect keys on those too.
  const sheet = <div className={p.wide ? 'grid grid-cols-2 gap-3 items-start' : 'space-y-3'}>
    {/* Imported scores have no import row, so the toggle sits on the box. */}
    <div className="min-w-0">{p.sourceMode !== 'audio' && p.abc.trim() && <div className="mb-1 flex justify-end">{viewToggle}</div>}{editor}</div>
    <div className="min-w-0 space-y-3">
      <div className={`${p.abc.trim() ? '' : 'hidden'} bg-white rounded-lg border border-zinc-200 overflow-y-auto ${p.wide ? '' : 'max-h-48'}`}
        style={{ height: boxHeight }}>
        <div ref={scoreRef} className="text-black p-2 [&_svg]:fill-current [&_.abcjs-highlight]:fill-amber-500" />
      </div>
      <div className="flex items-center gap-2">
        <div ref={audioRef} className={`min-w-0 flex-1 text-xs ${previewValid ? '' : 'hidden'}`} />
        <button onClick={p.onApprove} disabled={!p.sourceReady || !previewValid || busy || p.approved}
          className="ml-auto flex-shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">
          {p.approved ? 'Score approved' : 'Approve score'}
        </button>
      </div>
    </div>
  </div>;

  useEffect(() => {
    if (!scoreRef.current) return;
    scoreRef.current.innerHTML = '';
    if (audioRef.current) audioRef.current.innerHTML = '';
    setPreviewValid(false);
    if (!p.abc.trim()) return;
    let tunes: ReturnType<typeof abcjs.renderAbc>;
    const abc = withChoirVocal(p.abc);
    try { tunes = abcjs.renderAbc(scoreRef.current, abc, { responsive: 'resize', add_classes: true }); }
    catch { return; }
    if (!tunes[0]) return;
    setPreviewValid(true);
    const box = scoreRef.current.parentElement;
    let control: InstanceType<typeof abcjs.synth.SynthController> | null = null;
    const starts = markSections(tunes[0], abc, scoreRef.current, index => void playFromRef.current(index), (index, bar) => {
      // Bars number the same in the preview copy, so the move edits the real ABC.
      const moved = moveSectionStart(p.abc, index, bar);
      if ('error' in moved) { setMoveError(moved.error); return; }
      setMoveError('');
      if (moved.abc === p.abc) return;
      setUndoMove({ before: p.abc, after: moved.abc });
      onAbcChangeRef.current(moved.abc);
    });
    // Bars by character offset in the preview copy, which abcjs's events index.
    const ranges = barRanges(abc);
    const barOf = (char: number | undefined) => char === undefined ? null
      : ranges.find(range => char >= range.start && char <= range.end)?.bar ?? null;
    const charOf = (event: { startCharArray?: number[] }) => event.startCharArray?.find(value => typeof value === 'number');
    const events = new abcjs.TimingCallbacks(tunes[0], {}).noteTimings.filter(event => event.type === 'event');
    playBarRef.current = async bar => {
      // The first event, in time, in this bar or the nearest one after it.
      const start = events.find(event => barOf(charOf(event)) === bar)
        ?? events.find(event => (barOf(charOf(event)) ?? 0) > bar);
      if (!start) return;
      setPlayingBar(bar);
      const index = sectionAtChar(abcSectionMarks(abc), charOf(start) ?? -1);
      await seekTo(start, index);
    };
    playFromRef.current = async index => {
      const start = starts[index];
      if (start) await seekTo(start, index);
    };
    const seekTo = async (start: TimingEvent, index: number) => {
      if (index >= 0) onSectionRef.current?.(index);
      followNoteInBox(start.elements?.[0]?.[0], box);
      if (!control) return;
      // seek() only moves a player that has started; play() toggles, so it
      // must not run on one that is already playing. Both seek and isStarted
      // exist at runtime (synth-controller.js) but not in abcjs's typings.
      const player = control as unknown as { isStarted: boolean; play(): Promise<unknown>; seek(position: number, units: 'seconds'): void };
      if (!player.isStarted) await player.play();
      player.seek(start.milliseconds / 1000, 'seconds');
    };
    if (!audioRef.current || !abcjs.synth.supportsAudio()) return;
    const synth = control = new abcjs.synth.SynthController();
    let lit: Element[] = [];
    // Report a section once, when playback crosses into it.
    const marks = abcSectionMarks(abc);
    let section = -1, playingNow: number | null = null;
    synth.load(audioRef.current, {
      onStart() { lit.forEach(el => el.classList.remove('abcjs-highlight')); lit = []; },
      onEvent(ev: { elements?: Element[][]; startCharArray?: number[] }) {
        const char = ev.startCharArray?.find(value => typeof value === 'number');
        const index = char === undefined ? -1 : sectionAtChar(marks, char);
        if (index >= 0 && index !== section) onSectionRef.current?.(section = index);
        const bar = barOf(char);
        if (bar !== null && bar !== playingNow) setPlayingBar(playingNow = bar);
        lit.forEach(el => el.classList.remove('abcjs-highlight'));
        lit = (ev.elements ?? []).flat();
        lit.forEach(el => el.classList.add('abcjs-highlight'));
        followNoteInBox(lit[0], box);
      },
      onFinished() { lit.forEach(el => el.classList.remove('abcjs-highlight')); lit = []; },
    }, { displayLoop: false, displayRestart: true, displayPlay: true, displayProgress: true, displayWarp: false });
    void synth.setTune(tunes[0], false).catch(() => {});
    return () => { try { synth.pause(); } catch {} };
  }, [p.abc, p.sourceMode, p.sourceKey]);

  return (
    <div className="min-h-0 flex-shrink-0 border-t border-zinc-200 dark:border-white/10 p-4 space-y-3 overflow-y-auto max-h-[calc(100%-160px)]" style={{ height: p.height }}>
      <div>
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">YuE2 lead sheet</h3>
        <p className="text-xs text-zinc-500">{p.sourceMode === 'audio'
          ? 'Transcribe the source melody and chords or paste ABC, then review and approve it.'
          : 'Review the imported ABC score, then approve it.'}</p>
      </div>
      {p.sourceMode === 'audio' && p.readiness?.message && <p className="text-xs text-amber-600 dark:text-amber-400">{p.readiness.message}</p>}
      {busy && (
        <div className="space-y-1 text-xs text-zinc-500">
          <p>{p.preparing ? 'Preparing source audio…' : `${p.job?.phase || 'Queued'}${p.job?.total ? ` · ${p.job.done}/${p.job.total}` : ''}`}</p>
          <button onClick={p.onCancel} className="text-red-500">Cancel transcription</button>
        </div>
      )}
      {p.error && <p role="alert" className="text-xs text-red-500">{p.error}</p>}
      {p.scoreSource && <p className="text-xs text-cyan-600 dark:text-cyan-300">Score from dataset · editable</p>}
      {p.abc.trim() && !previewValid && <p className="text-xs text-amber-500">The ABC could not be previewed. Check its notation before approval.</p>}
      {moveError && <p role="alert" className="text-xs text-amber-600 dark:text-amber-400">{moveError}</p>}
      {undoMove?.after === p.abc && <button type="button" onClick={() => { p.onAbcChange(undoMove.before); setUndoMove(null); }}
        className="text-xs text-cyan-700 dark:text-cyan-300">Undo section move</button>}
      {p.sourceMode === 'audio'
        ? <MusicXmlImport key={p.sourceKey} abc={p.abc} disabled={busy} onAbcChange={p.onAbcChange} action={transcribe}
          wide={p.wide} toggle={p.abc.trim() ? viewToggle : undefined}>{sheet}</MusicXmlImport>
        : sheet}
    </div>
  );
};
