import { unzipSync, strFromU8 } from 'fflate';

export interface MusicXmlPart { id: string; name: string; staves: number; voices: number; hasLyrics: boolean }
export interface MusicXmlResult { abc: string; parts: MusicXmlPart[]; partId: string | null; warnings: string[] }
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

function duration(n: number, divisions: number): string {
  const q = n / divisions;
  if (!Number.isFinite(q) || q <= 0) throw new MusicXmlImportError('Invalid note duration');
  const numerator = Math.round(q * 64);
  if (Math.abs(numerator / 64 - q) > 1e-5) throw new MusicXmlImportError('Duration cannot be represented in ABC');
  let a = numerator, b = 64;
  const gcd = (x: number, y: number): number => y ? gcd(y, x % y) : x;
  const g = gcd(a, b); a /= g; b /= g;
  return b === 1 ? (a === 1 ? '' : String(a)) : `${a === 1 ? '' : a}/${b}`;
}

const KEYS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
const FLATS = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'];
function pitch(note: Element): string {
  const p = child(note, 'pitch');
  if (!p) throw new MusicXmlImportError('Unpitched notes are unsupported');
  const step = value(p, 'step');
  const octave = Number(value(p, 'octave'));
  const alter = Number(value(p, 'alter') || 0);
  if (!/^[A-G]$/.test(step) || !Number.isInteger(octave) || ![-2, -1, 0, 1, 2].includes(alter)) throw new MusicXmlImportError('Unsupported pitch');
  const accidental = alter < 0 ? '_'.repeat(-alter) : alter > 0 ? '^'.repeat(alter) : child(note, 'accidental')?.textContent?.trim() === 'natural' ? '=' : '';
  return accidental + (octave >= 5 ? step.toLowerCase() + "'".repeat(octave - 5) : step + ','.repeat(Math.max(0, 4 - octave)));
}

function convert(part: Element, doc: Document, warnings: Set<string>): string {
  let divisions = 1, key = 'C', meter = '4/4', tempo = '120';
  const selectedVoice = descendants(part, 'voice')[0]?.textContent?.trim() ?? '1';
  const selectedVerse = descendants(part, 'lyric')[0]?.getAttribute('number') ?? '';
  let keySeen = false, meterSeen = false, tempoSeen = false;
  const measures: string[] = [];
  const lyricMeasures: string[] = [];
  for (const measure of children(part, 'measure')) {
    let cursor = 0, lastStart = 0;
    const events: { start: number; end: number; token: string; lyric: string }[] = [];
    for (const item of Array.from(measure.children)) {
      if (item.localName === 'attributes') {
        const d = Number(value(item, 'divisions'));
        if (d) divisions = d;
        const k = child(item, 'key');
        if (k) {
          const fifths = Number(value(k, 'fifths'));
          const next = fifths >= 0 ? KEYS[fifths] : FLATS[-fifths];
          if (!next || value(k, 'mode') && value(k, 'mode') !== 'major') warnings.add('Unsupported key mode or signature');
          else if (keySeen) warnings.add('Later key changes are omitted');
          else { key = next; keySeen = true; }
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
        const q = sound?.getAttribute('tempo') ?? descendants(item, 'per-minute')[0]?.textContent?.trim();
        if (q) { if (tempoSeen) warnings.add('Later tempo changes are omitted'); else { tempo = q; tempoSeen = true; } }
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
      if (child(item, 'time-modification')) { warnings.add('Tuplets are omitted'); continue; }
      if (child(item, 'chord')) { warnings.add('Chords are omitted'); continue; }
      const n = Number(value(item, 'duration'));
      const start = cursor;
      cursor = start + n;
      if (value(item, 'staff') && value(item, 'staff') !== '1') continue;
      if (value(item, 'voice') && value(item, 'voice') !== selectedVoice) continue;
      const token = (child(item, 'rest') ? 'z' : pitch(item)) + duration(n, divisions) + (children(item, 'tie').some(t => t.getAttribute('type') === 'start') ? '-' : '');
      const lyric = children(item, 'lyric').find(l => (l.getAttribute('number') ?? '') === selectedVerse);
      if (children(item, 'lyric').length > (lyric ? 1 : 0)) warnings.add('Additional lyric verses are omitted');
      const syllabic = lyric ? value(lyric, 'syllabic') : '';
      const word = lyric ? value(lyric, 'text').replace(/[\s\-_*|]/g, ' ') : '';
      const lyricToken = word ? word + (syllabic === 'begin' || syllabic === 'middle' ? '-' : '') : lyric && child(lyric, 'extend') ? '_' : '*';
      events.push({ start, end: start + n, token, lyric: lyricToken });
      lastStart = start;
    }
    events.sort((a, b) => a.start - b.start);
    let end = 0;
    const tokens: string[] = [], lyrics: string[] = [];
    for (const event of events) {
      if (event.start < end) { warnings.add('Overlapping notes are omitted'); continue; }
      if (event.start > end) { tokens.push('z' + duration(event.start - end, divisions)); lyrics.push('*'); }
      tokens.push(event.token); lyrics.push(event.lyric); end = event.end;
    }
    if (lastStart < 0) warnings.add('Invalid cursor movement');
    measures.push(tokens.join(' ')); lyricMeasures.push(lyrics.join(' '));
  }
  const title = clean(doc.querySelector('work-title, movement-title')?.textContent ?? 'Imported score');
  const composer = clean(doc.querySelector('creator[type="composer"]')?.textContent ?? '');
  const lines = ['X:1', `T:${title}`, ...(composer ? [`C:${composer}`] : []), `M:${meter}`, `L:1/4`, `Q:1/4=${tempo}`, `K:${key}`, measures.join(' | ') + ' |'];
  if (lyricMeasures.some(s => /[^*\s]/.test(s))) lines.push('w: ' + lyricMeasures.join(' | '));
  return lines.join('\n') + '\n';
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
  const selected = opts.partId ? nodes.find(p => p.getAttribute('id') === opts.partId) : nodes.length === 1 ? nodes[0] : undefined;
  if (opts.partId && !selected) throw new MusicXmlImportError('Selected part was not found');
  if (!selected) return { abc: '', parts, partId: null, warnings: [] };
  const warnings = new Set<string>();
  const info = parts.find(p => p.id === selected.getAttribute('id'))!;
  if (info.staves > 1) warnings.add('Multiple staves: only the first staff is imported');
  if (info.voices > 1) warnings.add('Multiple voices: only voice 1 is imported');
  return { abc: convert(selected, doc, warnings), parts, partId: info.id, warnings: [...warnings] };
}
