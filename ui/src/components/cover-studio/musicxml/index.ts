import { unzipSync, strFromU8 } from 'fflate';

export interface MusicXmlPart { id: string; name: string; staves: number; voices: number; hasLyrics: boolean }
export interface MusicXmlResult { abc: string; title: string; lyrics: string; parts: MusicXmlPart[]; partId: string | null; warnings: string[] }
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

function convert(part: Element, warnings: Set<string>): { abc: string; lyrics: string } {
  let divisions = 1, keyName = 'C', key: Record<string, number> = {}, meter = '4/4', tempo = 120;
  const selectedVoice = descendants(part, 'voice')[0]?.textContent?.trim() ?? '1';
  const selectedVerse = descendants(part, 'lyric')[0]?.getAttribute('number') ?? '';
  let keySeen = false, meterSeen = false, tempoSeen = false, quantised = false;
  const measures: { implicit: boolean; events: { start: number; end: number; pitch: Pitch | null; tie: boolean }[] }[] = [];
  const words: string[] = [];
  for (const measure of children(part, 'measure')) {
    let cursor = 0;
    const events: (typeof measures)[number]['events'] = [];
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
            keyName = name; key = keyAlters(fifths); keySeen = true;
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
      if (item.localName === 'harmony') warnings.add('Chord symbols are omitted');
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
    measures.push({ implicit: measure.getAttribute('implicit') === 'yes', events });
  }
  if (quantised) warnings.add('Tuplets and notes shorter than a 32nd are rounded to the 32nd-note grid');

  const [beats, beatType] = meter.split('/').map(Number);
  const barTicks = 32 * beats / beatType;
  if (!Number.isInteger(barTicks)) throw new MusicXmlImportError(`Meter ${meter} cannot be written in 32nd notes`);
  const bars: Bar[] = measures.map(({ implicit, events }) => {
    events.sort((a, b) => a.start - b.start);
    const letter = new Map<string, number>(), exact = new Map<string, number>();
    const tokens: string[] = [];
    let end = 0, sounding = false;
    const used = events.reduce((t, e) => Math.max(t, e.end), 0);
    // A pickup bar is padded before its notes, any other short bar after them.
    const lead = implicit && used < barTicks ? barTicks - used : 0;
    // Adjacent rests merge into one before they are split into written lengths.
    let pending = 0;
    const rest = (n: number) => { pending += n; };
    const flush = () => { for (const p of split(pending)) tokens.push('z' + len(p)); pending = 0; };
    rest(lead);
    for (const event of events) {
      if (event.end <= event.start) continue;
      if (event.start < end) { warnings.add('Overlapping notes are omitted'); continue; }
      rest(event.start - end);
      if (event.pitch) {
        flush();
        const name = spell(event.pitch, key, letter, exact);
        const parts = split(event.end - event.start);
        parts.forEach((p, i) => tokens.push(name.replace(/^[_^=]+/, i ? '' : '$&') + len(p) + (i < parts.length - 1 || event.tie ? '-' : '')));
        sounding = true;
      } else rest(event.end - event.start);
      end = event.end;
    }
    if (lead + end > barTicks) warnings.add('Some bars are longer than the meter');
    rest(barTicks - lead - end);
    flush();
    return { body: tokens.join(''), rest: !sounding };
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
  return { abc: lines.join('\n') + '\n', lyrics: words.length ? `[Verse]\n${words.join(' ')}\n` : '' };
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
  if (!selected) return { abc: '', title, lyrics: '', parts, partId: null, warnings: [] };
  const warnings = new Set<string>();
  const info = parts.find(p => p.id === selected.getAttribute('id'))!;
  if (info.staves > 1) warnings.add('Multiple staves: only the first staff is imported');
  if (info.voices > 1) warnings.add('Multiple voices: only voice 1 is imported');
  return { ...convert(selected, warnings), title, parts, partId: info.id, warnings: [...warnings] };
}
