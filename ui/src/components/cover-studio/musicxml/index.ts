import { unzipSync, strFromU8 } from 'fflate';

export interface MusicXmlPart { id: string; name: string; staves: number; voices: number; hasLyrics: boolean }
/** `chords`: where the score's chord symbols came from: its own <harmony>, inferred
 *  from the accompaniment, or none. */
export interface MusicXmlResult { abc: string; title: string; lyrics: string; chords: 'score' | 'inferred' | null; parts: MusicXmlPart[]; partId: string | null; warnings: string[] }
export class MusicXmlImportError extends Error {}

const MAX_FILE = 8 * 1024 * 1024;
const MAX_XML = 16 * 1024 * 1024;
const MAX_ENTRIES = 256;
const child = (node: Element, name: string) => Array.from(node.children).find(e => e.localName === name);
const children = (node: Element, name: string) => Array.from(node.children).filter(e => e.localName === name);
const value = (node: Element, name: string) => child(node, name)?.textContent?.trim() ?? '';
const descendants = (node: Element, name: string) => Array.from(node.getElementsByTagName(name));
const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/[:\\]/g, ' ').trim();

function xml(text: string): Document {
  if (text.length > MAX_XML) throw new MusicXmlImportError('MusicXML is too large');
  if (/<!ENTITY/i.test(text)) throw new MusicXmlImportError('DTD entities are not supported');
  const doctype = /<!DOCTYPE\s+score-partwise\s+PUBLIC\s+"-\/\/Recordare\/\/DTD MusicXML [\d.]+ Partwise\/\/EN"\s+"https?:\/\/www\.musicxml\.org\/dtds\/partwise\.dtd"\s*(?:\[\s*\])?\s*>/i;
  const withoutKnownDtd = text.replace(doctype, '');
  if (/<!DOCTYPE/i.test(withoutKnownDtd)) throw new MusicXmlImportError('Unsupported DTD');
  const doc = new DOMParser().parseFromString(withoutKnownDtd, 'application/xml');
  if (doc.querySelector('parsererror')) throw new MusicXmlImportError('Invalid MusicXML');
  return doc;
}

// YuE2's native score (upstream skills/yue2-music/instrumental/references/abc-repair.md):
// L:1/32, so a quarter note is 8 ticks; only these lengths, longer ones split with ties.
const TICKS_PER_QUARTER = 8;
const LENGTHS = [48, 32, 24, 16, 12, 8, 6, 4, 3, 2, 1];
function split(ticks: number): number[] {
  const out: number[] = [];
  while (ticks > 0) { const n = LENGTHS.find(l => l <= ticks)!; out.push(n); ticks -= n; }
  return out;
}
const len = (n: number) => n === 1 ? '' : String(n);

const MAJOR_SHARP = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
const MAJOR_FLAT = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'];
const MINOR_SHARP = ['A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#'];
const MINOR_FLAT = ['A', 'D', 'G', 'C', 'F', 'Bb', 'Eb', 'Ab'];
function keyAlters(fifths: number): Record<string, number> {
  const order = fifths >= 0 ? 'FCGDAEB' : 'BEADGCF';
  return Object.fromEntries(Array.from(order.slice(0, Math.abs(fifths)), l => [l, Math.sign(fifths)]));
}

interface Pitch { step: string; octave: number; alter: number }
function pitch(note: Element): Pitch {
  const p = child(note, 'pitch');
  if (!p) throw new MusicXmlImportError('Unpitched notes are unsupported');
  const step = value(p, 'step');
  const octave = Number(value(p, 'octave'));
  const alter = Number(value(p, 'alter') || 0);
  if (!/^[A-G]$/.test(step) || !Number.isInteger(octave) || ![-2, -1, 0, 1, 2].includes(alter)) throw new MusicXmlImportError('Unsupported pitch');
  return { step, octave, alter };
}

/** Writes accidentals so the pitch reads the same whether an accidental carries
 *  to every octave of its letter for the rest of the bar (YuE2's training
 *  convention) or only to its own octave (standard ABC, abcjs). */
function spell(p: Pitch, key: Record<string, number>, letter: Map<string, number>, exact: Map<string, number>): string {
  const inKey = key[p.step] ?? 0;
  const id = p.step + p.octave;
  const mark = (letter.get(p.step) ?? inKey) === p.alter && (exact.get(id) ?? inKey) === p.alter ? ''
    : p.alter < 0 ? '_'.repeat(-p.alter) : p.alter > 0 ? '^'.repeat(p.alter) : '=';
  if (mark) { letter.set(p.step, p.alter); exact.set(id, p.alter); }
  return mark + (p.octave >= 5 ? p.step.toLowerCase() + "'".repeat(p.octave - 5) : p.step + ','.repeat(Math.max(0, 4 - p.octave)));
}

interface Bar { body: string; rest: boolean }

// Chord symbols use YuE2's chord set (upstream abc_tools.QUALITIES); MusicXML
// kinds outside it map to the nearest member and are flagged as simplified.
const KINDS: Record<string, [string, boolean]> = {
  major: ['', true], minor: ['m', true], augmented: ['aug', true], diminished: ['dim', true],
  dominant: ['7', true], 'major-seventh': ['maj7', true], 'minor-seventh': ['m7', true],
  'diminished-seventh': ['dim7', true], 'half-diminished': ['m7b5', true], 'major-minor': ['m(maj7)', true],
  'major-sixth': ['6', true], 'minor-sixth': ['m6', true], 'suspended-fourth': ['sus4', true], 'suspended-second': ['sus2', true],
  'augmented-seventh': ['aug', false], 'dominant-ninth': ['7', false], 'dominant-11th': ['7', false], 'dominant-13th': ['7', false],
  'major-ninth': ['maj7', false], 'major-11th': ['maj7', false], 'major-13th': ['maj7', false],
  'minor-ninth': ['m7', false], 'minor-11th': ['m7', false], 'minor-13th': ['m7', false], power: ['', false], pedal: ['', false],
};
const NATURAL: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const accidental = (alter: number) => alter < 0 ? 'b'.repeat(-alter) : '#'.repeat(alter);

interface Chord { root: number; quality: string; bass: string }
// Each quality's tones as steps on the line of fifths from the root (dim7's 6th is a bb7).
const FIFTHS_FROM_ROOT: Record<string, number[]> = {
  '': [0, 4, 1], m: [0, -3, 1], aug: [0, 4, 8], dim: [0, -3, -6], sus4: [0, -1, 1], '7sus4': [0, -1, 1, -2], sus2: [0, 2, 1],
  '7': [0, 4, 1, -2], maj7: [0, 4, 1, 5], m7: [0, -3, 1, -2], 'm(maj7)': [0, -3, 1, 5], '6': [0, 4, 1, 3], m6: [0, -3, 1, 3],
  dim7: [0, -3, -6, -9], m7b5: [0, -3, -6, -2],
};
const LINE_OF_FIFTHS: Record<string, number> = { F: 0, C: 1, G: 2, D: 3, A: 4, E: 5, B: 6 };

/** The root's name as SheetSage2 spells chords (sheetsage-events.h correct_chord,
 *  after upstream correct_chord_spelling): the spelling whose tones sit closest to
 *  the key signature on the line of fifths, the root counting twice; ties go to C-B order. */
function rootName(chord: Chord, fifths: number): string {
  const window = fifths + 1 + 2;
  let best = { score: Infinity, name: '' };
  for (const step of 'CDEFGAB') {
    const alter = ((chord.root - NATURAL[step] + 6) % 12 + 12) % 12 - 6;
    const pos = LINE_OF_FIFTHS[step] + 7 * alter;
    const far = (off: number) => Math.max(Math.abs(pos + off - window) - 3, 0);
    const score = (FIFTHS_FROM_ROOT[chord.quality] ?? [0]).reduce((s, off) => s + far(off), 0) + far(0);
    if (score < best.score) best = { score, name: step + accidental(alter) };
  }
  return best.name;
}
const label = (chord: Chord, fifths: number) => rootName(chord, fifths) + chord.quality + chord.bass;

/** A <harmony> as a chord; null for N.C., undefined when unsupported. */
function harmony(item: Element, warnings: Set<string>): Chord | null | undefined {
  const kind = value(item, 'kind');
  if (kind === 'none') return null;
  const root = child(item, 'root'), bass = child(item, 'bass');
  const mapped = KINDS[kind];
  if (!root || !mapped || !(value(root, 'root-step') in NATURAL)) { warnings.add('Chord symbols of an unsupported type are omitted'); return undefined; }
  let [quality, exact] = mapped;
  const degrees = children(item, 'degree').map(d => value(d, 'degree-value'));
  if (quality === 'sus4' && degrees.length === 1 && degrees[0] === '7') quality = '7sus4';
  else if (degrees.length) exact = false;
  if (!exact) warnings.add("Chord symbols outside YuE2's chord set are simplified");
  const name = (node: Element, prefix: string) => value(node, `${prefix}-step`) + accidental(Math.round(Number(value(node, `${prefix}-alter`) || 0)));
  const alter = Math.round(Number(value(root, 'root-alter') || 0));
  return { root: ((NATURAL[value(root, 'root-step')] ?? NaN) + alter + 12) % 12, quality, bass: bass ? '/' + name(bass, 'bass') : '' };
}

interface Sounding { start: number; end: number; pc: number; midi: number; weight: number }

/** Every sounding note of a part per measure, in 32nd ticks, for chord inference.
 *  With `melodyVoice`, notes of the imported melody line weigh half. */
function soundingNotes(part: Element, melodyVoice: string | null): Sounding[][] {
  let divisions = 1;
  return children(part, 'measure').map(measure => {
    let cursor = 0, last = 0;
    const notes: Sounding[] = [];
    for (const item of Array.from(measure.children)) {
      if (item.localName === 'attributes') divisions = Number(value(item, 'divisions')) || divisions;
      if (item.localName === 'backup' || item.localName === 'forward') {
        const n = Number(value(item, 'duration')) || 0;
        cursor += item.localName === 'backup' ? -n : n;
      }
      if (item.localName !== 'note' || child(item, 'grace')) continue;
      const n = Number(value(item, 'duration')) || 0;
      const chord = !!child(item, 'chord');
      const start = chord ? last : cursor;
      if (!chord) { last = cursor; cursor += n; }
      const p = child(item, 'pitch');
      if (!p || child(item, 'rest')) continue;
      const step = value(p, 'step'), alter = Math.round(Number(value(p, 'alter') || 0)), octave = Number(value(p, 'octave'));
      if (!(step in NATURAL) || !Number.isFinite(octave)) continue;
      const melody = melodyVoice !== null && !chord && (value(item, 'staff') || '1') === '1' && (value(item, 'voice') || melodyVoice) === melodyVoice;
      const midi = 12 * (octave + 1) + NATURAL[step] + alter;
      notes.push({ start: start * TICKS_PER_QUARTER / divisions, end: (start + n) * TICKS_PER_QUARTER / divisions,
        pc: ((midi % 12) + 12) % 12, midi, weight: melody ? 0.5 : 1 });
    }
    return notes;
  });
}

const TEMPLATES: [string, number[]][] = [['', [0, 4, 7]], ['m', [0, 3, 7]], ['7', [0, 4, 7, 10]], ['m7', [0, 3, 7, 10]], ['maj7', [0, 4, 7, 11]], ['dim', [0, 3, 6]]];

/** The best-matching chord for the notes sounding in [from, to), or null if none sound.
 *  ponytail: duration-weighted pitch-class template match over six chord types,
 *  with a bonus for the lowest note as root; no voice leading, key context or
 *  slash chords. A real chord recogniser (or SheetSage on a render) if this misreads. */
function inferChord(notes: Sounding[], from: number, to: number): Chord | null {
  const chroma = new Array<number>(12).fill(0);
  let bass: Sounding | null = null;
  for (const n of notes) {
    const overlap = Math.min(n.end, to) - Math.max(n.start, from);
    if (overlap <= 0) continue;
    chroma[n.pc] += overlap * n.weight;
    if (n.weight === 1 && (!bass || n.midi < bass.midi)) bass = n;
  }
  const total = chroma.reduce((a, b) => a + b, 0);
  if (!total) return null;
  let best = { score: -Infinity, root: 0, quality: '' };
  for (let root = 0; root < 12; root++) {
    for (const [quality, intervals] of TEMPLATES) {
      const inside = intervals.reduce((s, i) => s + chroma[(root + i) % 12], 0);
      const score = 2 * inside - total - (intervals.length > 3 ? 0.15 * total : 0) + (bass?.pc === root ? 0.1 * total : 0);
      if (score > best.score) best = { score, root, quality };
    }
  }
  return { root: best.root, quality: best.quality, bass: '' };
}

function convert(part: Element, others: Element[], warnings: Set<string>): { abc: string; lyrics: string; chords: 'score' | 'inferred' | null } {
  let divisions = 1, keyName = 'C', key: Record<string, number> = {}, keyFifths = 0, meter = '4/4', tempo = 120;
  const selectedVoice = descendants(part, 'voice')[0]?.textContent?.trim() ?? '1';
  const selectedVerse = descendants(part, 'lyric')[0]?.getAttribute('number') ?? '';
  let keySeen = false, meterSeen = false, tempoSeen = false, quantised = false;
  const measures: { implicit: boolean; events: { start: number; end: number; pitch: Pitch | null; tie: boolean }[];
    chords: { at: number; chord: Chord | null }[] }[] = [];
  const words: string[] = [];
  for (const measure of children(part, 'measure')) {
    let cursor = 0;
    const events: (typeof measures)[number]['events'] = [];
    const chords: (typeof measures)[number]['chords'] = [];
    // Onsets and ends snap to the 32nd grid; a tuplet or 64th lands on its nearest tick.
    const tick = (n: number) => {
      const exact = n * TICKS_PER_QUARTER / divisions;
      if (Math.abs(exact - Math.round(exact)) > 1e-6) quantised = true;
      return Math.round(exact);
    };
    for (const item of Array.from(measure.children)) {
      if (item.localName === 'attributes') {
        const d = Number(value(item, 'divisions'));
        if (d) divisions = d;
        const k = child(item, 'key');
        if (k) {
          const fifths = Number(value(k, 'fifths'));
          const mode = value(k, 'mode') || 'major';
          const name = !Number.isInteger(fifths) || Math.abs(fifths) > 7 ? undefined
            : mode === 'minor' ? (fifths >= 0 ? MINOR_SHARP[fifths] : MINOR_FLAT[-fifths]) + 'm'
            : fifths >= 0 ? MAJOR_SHARP[fifths] : MAJOR_FLAT[-fifths];
          if (!name) warnings.add('Unsupported key signature: written in C with accidentals');
          else if (keySeen) warnings.add('Later key changes are written with accidentals');
          else {
            if (mode !== 'major' && mode !== 'minor') warnings.add(`Key mode ${mode} is written as its major signature`);
            keyName = name; key = keyAlters(fifths); keyFifths = fifths; keySeen = true;
          }
        }
        const t = child(item, 'time');
        if (t) {
          const next = `${value(t, 'beats')}/${value(t, 'beat-type')}`;
          if (!/^\d+\/\d+$/.test(next)) warnings.add('Unsupported meter');
          else if (meterSeen) warnings.add('Later meter changes are omitted');
          else { meter = next; meterSeen = true; }
        }
        if (child(item, 'transpose')) warnings.add('Transposition is not applied');
      }
      if (item.localName === 'direction') {
        const sound = child(item, 'sound');
        const q = Number(sound?.getAttribute('tempo') ?? descendants(item, 'per-minute')[0]?.textContent?.trim());
        if (q > 0) { if (tempoSeen) warnings.add('Later tempo changes are omitted'); else { tempo = q; tempoSeen = true; } }
      }
      if (item.localName === 'barline' && (descendants(item, 'repeat').length || descendants(item, 'ending').length)) warnings.add('Repeats and endings are omitted');
      if (item.localName === 'harmony') {
        const chord = harmony(item, warnings);
        if (chord !== undefined) chords.push({ at: Math.max(0, tick(cursor + (Number(value(item, 'offset')) || 0))), chord });
      }
      if (item.localName === 'backup' || item.localName === 'forward') {
        const n = Number(value(item, 'duration'));
        if (!Number.isFinite(n)) throw new MusicXmlImportError('Invalid cursor duration');
        cursor += item.localName === 'backup' ? -n : n;
      }
      if (item.localName !== 'note') continue;
      if (child(item, 'grace')) { warnings.add('Grace notes are omitted'); continue; }
      if (child(item, 'chord')) { warnings.add('Chords are omitted'); continue; }
      const n = Number(value(item, 'duration'));
      if (!Number.isFinite(n) || n <= 0) throw new MusicXmlImportError('Invalid note duration');
      const start = cursor;
      cursor = start + n;
      if (cursor < 0 || start < 0) throw new MusicXmlImportError('Invalid cursor movement');
      if (value(item, 'staff') && value(item, 'staff') !== '1') continue;
      if (value(item, 'voice') && value(item, 'voice') !== selectedVoice) continue;
      const lyric = children(item, 'lyric').find(l => (l.getAttribute('number') ?? '') === selectedVerse);
      if (children(item, 'lyric').length > (lyric ? 1 : 0)) warnings.add('Additional lyric verses are omitted');
      const word = lyric ? value(lyric, 'text').replace(/\s+/g, ' ').trim() : '';
      if (word) {
        const joined = words.length && /-$/.test(words[words.length - 1]);
        const syllabic = value(lyric!, 'syllabic');
        const piece = word + (syllabic === 'begin' || syllabic === 'middle' ? '-' : '');
        if (joined) words[words.length - 1] = words[words.length - 1].slice(0, -1) + piece; else words.push(piece);
      }
      events.push({ start: tick(start), end: tick(start + n), pitch: child(item, 'rest') ? null : pitch(item),
        tie: children(item, 'tie').some(t => t.getAttribute('type') === 'start') });
    }
    measures.push({ implicit: measure.getAttribute('implicit') === 'yes', events, chords });
  }
  if (quantised) warnings.add('Tuplets and notes shorter than a 32nd are rounded to the 32nd-note grid');

  const [beats, beatType] = meter.split('/').map(Number);
  const barTicks = 32 * beats / beatType;
  if (!Number.isInteger(barTicks)) throw new MusicXmlImportError(`Meter ${meter} cannot be written in 32nd notes`);
  // Chords: the score's own <harmony>, else inferred from the other staves and parts.
  let chordSource: 'score' | 'inferred' | null = measures.some(m => m.chords.length) ? 'score' : null;
  if (!chordSource) {
    const sounding = [soundingNotes(part, selectedVoice), ...others.map(o => soundingNotes(o, null))];
    if (sounding.some(p => p.some(m => m.some(n => n.weight === 1)))) {
      measures.forEach((m, i) => {
        const notes = sounding.flatMap(p => p[i] ?? []);
        // A pickup bar is read whole; any other bar by halves when the meter has an even beat count.
        const whole = m.implicit ? Math.max(0, ...m.events.map(e => e.end), ...notes.map(n => n.end)) : barTicks;
        const half = !m.implicit && beats % 2 === 0 ? whole / 2 : whole;
        const first = inferChord(notes, 0, half);
        const second = half < whole ? inferChord(notes, half, whole) : null;
        if (first ?? second) m.chords.push({ at: 0, chord: (first ?? second)! });
        if (first && second && label(second, keyFifths) !== label(first, keyFifths)) m.chords.push({ at: half, chord: second });
      });
      if (measures.some(m => m.chords.length)) {
        chordSource = 'inferred';
        warnings.add('Chords are inferred from the accompaniment (the score has no chord symbols): check them before approving');
      }
    }
  }

  // A tie holds only into the melody's next note at the same pitch; a tie into a
  // skipped chord tone, another voice or a rest would be invalid in the native score.
  let offset = 0;
  const timeline = measures.flatMap(m => {
    const at = offset;
    offset += m.implicit ? m.events.reduce((t, e) => Math.max(t, e.end), 0) : barTicks;
    return [...m.events].sort((a, b) => a.start - b.start).map(e => ({ e, start: at + e.start, end: at + e.end }));
  });
  timeline.forEach((x, i) => {
    const next = timeline[i + 1];
    const p = x.e.pitch, q = next?.e.pitch;
    if (x.e.tie && !(p && q && next.start === x.end && p.step === q.step && p.octave === q.octave && p.alter === q.alter)) x.e.tie = false;
  });

  let active: string | null = null;
  const bars: Bar[] = measures.map(({ implicit, events, chords }) => {
    events.sort((a, b) => a.start - b.start);
    const letter = new Map<string, number>(), exact = new Map<string, number>();
    const used = events.reduce((t, e) => Math.max(t, e.end), 0);
    // A pickup bar is padded before its notes, any other short bar after them.
    const lead = implicit && used < barTicks ? barTicks - used : 0;
    const notes: { start: number; end: number; name: string; tie: boolean }[] = [];
    let end = 0;
    for (const event of events) {
      if (event.end <= event.start) continue;
      if (event.start < end) { warnings.add('Overlapping notes are omitted'); continue; }
      if (event.pitch) notes.push({ start: lead + event.start, end: lead + event.end, name: spell(event.pitch, key, letter, exact), tie: event.tie });
      end = event.end;
    }
    if (lead + end > barTicks) warnings.add('Some bars are longer than the meter');
    // Only notes stretch a bar past the meter; trailing rests are cut to it.
    const barEnd = Math.max(barTicks, ...notes.map(n => n.end));
    // Chord changes in written ticks. As SheetSage writes it, the chord still
    // sounding at a bar line is repeated there, and a note a change falls inside
    // is split and tied.
    const changes = new Map<number, string | null>();
    if (active) changes.set(0, active);
    for (const c of [...chords].sort((a, b) => a.at - b.at)) changes.set(Math.min(lead + c.at, barEnd - 1), c.chord && label(c.chord, keyFifths));
    const points = [...new Set([0, barEnd, ...changes.keys(), ...notes.flatMap(n => [n.start, n.end])])].sort((a, b) => a - b);
    const tokens: string[] = [];
    // Adjacent rests merge into one before they are split into written lengths.
    let pending = 0;
    const flush = () => { for (const p of split(pending)) tokens.push('z' + len(p)); pending = 0; };
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i], b = points[i + 1];
      if (changes.has(a)) {
        flush();
        active = changes.get(a)!;
        if (active) tokens.push(`"${active}"`);
      }
      const note = notes.find(n => n.start <= a && a < n.end);
      if (!note) { pending += b - a; continue; }
      flush();
      const parts = split(b - a);
      parts.forEach((p, k) => tokens.push(note.name.replace(/^[_^=]+/, a === note.start && k === 0 ? '$&' : '') + len(p)
        + (k < parts.length - 1 || b < note.end || note.tie ? '-' : '')));
    }
    flush();
    return { body: tokens.join(''), rest: !notes.length && !tokens.some(t => t.startsWith('"')) };
  });

  // Up to four bars per group, Vocal then Ins; whole-bar rests are Z, runs of them Z2-Z4.
  const line = (group: Bar[]) => {
    const out: string[] = [];
    for (const bar of group) {
      const last = out[out.length - 1];
      if (!bar.rest) out.push(bar.body);
      else if (last?.startsWith('Z')) out[out.length - 1] = `Z${Number(last.slice(1) || 1) + 1}`;
      else out.push('Z');
    }
    return out.join('|') + '|';
  };
  const lines = ['X:1', 'T:', `M:${meter}`, 'L:1/32', `Q:1/4=${Math.round(tempo)}`,
    'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"', 'V: Ins clef=treble name="Ins Melody" snm="Inst."',
    `K:${keyName}`, '% verse'];
  for (let i = 0; i < bars.length; i += 4) {
    const group = bars.slice(i, i + 4);
    lines.push('V: Vocal', line(group), 'V: Ins', line(group.map(() => ({ body: '', rest: true }))));
  }
  return { abc: lines.join('\n') + '\n', lyrics: words.length ? `[Verse]\n${words.join(' ')}\n` : '', chords: chordSource };
}

export async function importMusicXml(file: Blob, fileName: string, opts: { partId?: string } = {}): Promise<MusicXmlResult> {
  if (!/\.(musicxml|xml|mxl)$/i.test(fileName)) throw new MusicXmlImportError('Choose a .musicxml, .xml or .mxl file');
  if (file.size > MAX_FILE) throw new MusicXmlImportError('MusicXML file is too large');
  let source: string;
  if (/\.mxl$/i.test(fileName)) {
    let entries: Record<string, Uint8Array>;
    let count = 0, totalSize = 0;
    try { entries = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: e => {
      totalSize += e.originalSize;
      if (++count > MAX_ENTRIES || e.originalSize > MAX_XML || totalSize > 32 * 1024 * 1024) throw new MusicXmlImportError('MXL archive exceeds limits');
      return e.name === 'META-INF/container.xml' || e.name.endsWith('.xml') || e.name.endsWith('.musicxml');
    } }); }
    catch { throw new MusicXmlImportError('Invalid MXL archive'); }
    if (Object.keys(entries).length > MAX_ENTRIES || Object.values(entries).some(e => e.length > MAX_XML)) throw new MusicXmlImportError('MXL archive exceeds limits');
    const container = entries['META-INF/container.xml'];
    if (!container) throw new MusicXmlImportError('MXL container.xml is missing');
    const root = xml(strFromU8(container)).querySelector('rootfile')?.getAttribute('full-path');
    if (!root || root.includes('..') || root.startsWith('/') || !entries[root]) throw new MusicXmlImportError('MXL rootfile is missing');
    source = strFromU8(entries[root]);
  } else source = await file.text();
  const doc = xml(source);
  if (doc.documentElement.localName !== 'score-partwise') throw new MusicXmlImportError('Only score-partwise MusicXML is supported');
  const nodes = descendants(doc.documentElement, 'part').filter(p => p.parentElement === doc.documentElement);
  const parts = nodes.map(p => {
    const id = p.getAttribute('id') ?? '';
    const info = descendants(doc.documentElement, 'score-part').find(x => x.getAttribute('id') === id);
    return { id, name: info ? value(info, 'part-name') : id, staves: Math.max(1, ...descendants(p, 'staves').map(x => Number(x.textContent) || 1), ...descendants(p, 'staff').map(x => Number(x.textContent) || 1)), voices: new Set(descendants(p, 'voice').map(x => x.textContent?.trim())).size || 1, hasLyrics: descendants(p, 'lyric').length > 0 };
  });
  if (!parts.length) throw new MusicXmlImportError('No parts found');
  const title = clean(doc.querySelector('work-title, movement-title')?.textContent ?? '');
  const selected = opts.partId ? nodes.find(p => p.getAttribute('id') === opts.partId) : nodes.length === 1 ? nodes[0] : undefined;
  if (opts.partId && !selected) throw new MusicXmlImportError('Selected part was not found');
  if (!selected) return { abc: '', title, lyrics: '', chords: null, parts, partId: null, warnings: [] };
  const warnings = new Set<string>();
  const info = parts.find(p => p.id === selected.getAttribute('id'))!;
  if (info.staves > 1) warnings.add('Multiple staves: only the first staff is imported');
  if (info.voices > 1) warnings.add('Multiple voices: only voice 1 is imported');
  return { ...convert(selected, nodes.filter(p => p !== selected), warnings), title, parts, partId: info.id, warnings: [...warnings] };
}
