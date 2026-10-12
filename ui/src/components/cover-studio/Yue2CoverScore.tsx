import React, { useEffect, useRef, useState } from 'react';
import abcjs from 'abcjs';
import 'abcjs/abcjs-audio.css';
import { followNoteInBox } from '../../utils/abcFollow';
import { abcSectionMarks, sectionAtChar, sectionColours } from '../../utils/abcSections';
import { withChoirVocal } from '../../utils/abcChoirVocal';
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
}

type Tune = ReturnType<typeof abcjs.renderAbc>[number];
type TimingEvent = InstanceType<typeof abcjs.TimingCallbacks>['noteTimings'][number];

/** Colours each rendered note and bar by its score section and draws a
 *  labelled line where each section starts; clicking a label plays from it.
 *  Sections come from the ABC's `%Label` lines by character offset, the same
 *  offsets abcjs records on each element, so multi-bar rests (Z4) and the
 *  interleaved Vocal/Ins voices need no bar counting. Returns each section's
 *  first timed event, the seek target, or null for a section with no notes. */
function markSections(tune: Tune, abc: string, host: HTMLElement, onPick: (index: number) => void): Array<TimingEvent | null> {
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
  for (const event of new abcjs.TimingCallbacks(tune, {}).noteTimings) {
    if (event.type !== 'event' || event.left == null) continue;
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
    g.setAttribute('class', 'cursor-pointer');
    g.addEventListener('click', () => onPick(index));
    const rule = document.createElementNS(ns, 'line');
    Object.entries({ x1: x, x2: x, y1: start.top, y2: start.top + start.height, stroke: colours[index], 'stroke-width': 2 })
      .forEach(([key, value]) => rule.setAttribute(key, String(value)));
    const text = document.createElementNS(ns, 'text');
    Object.entries({ x: x + 3, y: Math.max(10, start.top - 2), fill: colours[index], 'font-size': 11, 'font-weight': 700 })
      .forEach(([key, value]) => text.setAttribute(key, String(value)));
    text.textContent = `▶ ${marks[index].label}`;
    const title = document.createElementNS(ns, 'title');
    title.textContent = `Play from ${marks[index].label}`;
    g.append(title, rule, text);
    svg.appendChild(g);
  });
  return starts;
}

export const Yue2CoverScore: React.FC<Props> = p => {
  const scoreRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLDivElement>(null);
  const [previewValid, setPreviewValid] = useState(false);
  // Plays from score section i; replaced on every render of the ABC.
  const playFromRef = useRef<(index: number) => Promise<void>>(async () => {});
  useEffect(() => {
    if (p.seekSection) void playFromRef.current(p.seekSection.index);
  }, [p.seekSection]);
  const busy = p.preparing || p.job?.status === 'queued' || p.job?.status === 'running';
  // Side by side, the ABC and the score share the panel's height, less its
  // heading, the import row and the approve button.
  const boxHeight = p.wide ? Math.max(128, p.height - 170) : undefined;
  const editor = <textarea aria-label="Editable ABC score" value={p.abc} disabled={busy} onChange={e => p.onAbcChange(e.target.value)}
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
    <div className="min-w-0">{editor}</div>
    <div className="min-w-0 space-y-3">
      <div className={`${p.abc.trim() ? '' : 'hidden'} bg-white rounded-lg border border-zinc-200 overflow-y-auto ${p.wide ? '' : 'max-h-48'}`}
        style={{ height: boxHeight }}>
        <div ref={scoreRef} className="text-black p-2 [&_svg]:fill-current [&_.abcjs-highlight]:fill-amber-500" />
      </div>
      <div ref={audioRef} className={`text-xs ${previewValid ? '' : 'hidden'}`} />
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
    const starts = markSections(tunes[0], abc, scoreRef.current, index => void playFromRef.current(index));
    playFromRef.current = async index => {
      const start = starts[index];
      if (!start) return;
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
    synth.load(audioRef.current, {
      onStart() { lit.forEach(el => el.classList.remove('abcjs-highlight')); lit = []; },
      onEvent(ev: { elements?: Element[][] }) {
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
      {p.sourceMode === 'audio'
        ? <MusicXmlImport key={p.sourceKey} abc={p.abc} disabled={busy} onAbcChange={p.onAbcChange} action={transcribe}>{sheet}</MusicXmlImport>
        : sheet}
      <button onClick={p.onApprove} disabled={!p.sourceReady || !previewValid || busy || p.approved}
        className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">
        {p.approved ? 'Score approved' : 'Approve score'}
      </button>
    </div>
  );
};
