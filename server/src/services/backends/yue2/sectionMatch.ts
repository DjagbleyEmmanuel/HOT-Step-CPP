// backends/yue2/sectionMatch.ts — "Match sections to score": retag a song's
// lyric blocks with the ABC score's section labels, using where each block is
// actually sung in the SOURCE vocal stem (MMS_FA word times, POST /yue2/align).
//
// Words are never edited. Every placed block gets the score's label exactly
// as written ([verse], not [Verse 1]), so the result passes the section
// check; a block the aligner is unsure of keeps its tag and its place and is
// flagged, and so does a block that seems to start in a section with no
// Vocal note. A sung chorus-type section (chorus, refrain,
// hook) with no block gets a copy of the last block of that kind, a chorus the
// lyrics wrote once, but only when no unsure block sits in that gap, since
// that block may be the one sung there. Verses are never copied: each has its
// own words. Sections with no Vocal note get an empty tag, and the lyrics' own
// empty tags are dropped in their favour. A section's first bar does not count
// as sung: it often holds the previous section's last note. Placement is an
// in-order best fit, not "which section holds this second" (see PICKUP_BARS).

import type { Yue2AlignWord } from './align.js';
import { sectionKind } from './coverDrift.js';
import { scoreSections } from './scoreSections.js';
import { scoreBarClock, scoreVocalNoteOnsets } from './scoreClock.js';

const MIN_WORD_SECONDS = 0.04;
// A first word up to a bar before a section start is a pickup into it.
const PICKUP_BARS = 1;
// SheetSage writes one tempo for the whole song and the record drifts
// against it, so a section's start can be several bars off by the second
// half. Blocks are therefore not placed by the section their first word falls
// in: an in-order best fit gives each block the sung section whose start it is
// nearest, measured in that section's lengths. A pickup into it costs nothing.
// Costs, in section lengths: going on under the previous block's section,
// a lyric tag whose kind differs from the section's, and leaving a block unsure.
const MERGE_COST = 0.2;
const KIND_COST = 0.1;
const UNSURE_COST = 0.5;
// Kinds whose words repeat, so a missing one can be copied from the last.
const REPEATS = /^(chorus|refrain|hook)\b/;
const TAG_LINE = /^\s*\[([^\]\n]+)\]\s*$/;

export interface SectionMatchBlock {
  /** 1-based index of the block in the original lyrics. */
  index: number;
  tag: string | null;
  newTag: string | null;
  /** 1-based score section, or null when the block was left as it was. */
  section: number | null;
  firstWordSeconds: number | null;
  status: 'kept' | 'renamed' | 'merged' | 'unsure' | 'dropped';
}

export interface SectionMatchResult {
  lyrics: string;
  blocks: SectionMatchBlock[];
  /** Score sections filled with a copy of an earlier block, or an empty tag. */
  filled: Array<{ section: number; label: string; copiedFrom: number | null }>;
  unchanged: boolean;
}

interface Block { tag: string | null; body: string; start: number; end: number }

/** Split on tag lines, in codepoints (MMS_FA's char0 is a codepoint offset).
 *  Text before the first tag is a block with no tag. */
export function splitLyricBlocks(lyrics: string): Block[] {
  const lines = lyrics.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let offset = 0;
  let current: Block | null = null;
  for (const line of lines) {
    const length = Array.from(line).length + 1;
    const tag = TAG_LINE.exec(line)?.[1].trim();
    if (tag !== undefined) {
      if (current) current.end = offset;
      current = { tag, body: '', start: offset, end: offset };
      blocks.push(current);
    } else {
      if (!current) { current = { tag: null, body: '', start: offset, end: offset }; blocks.push(current); }
      current.body += (current.body ? '\n' : '') + line;
    }
    offset += length;
  }
  if (current) current.end = offset;
  for (const block of blocks) block.body = block.body.replace(/^\n+|\n+$/g, '');
  return blocks.filter(block => block.tag !== null || block.body.trim());
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Where a block starts: the median of its first three aligned word starts,
 *  so one stray early word cannot move it. Null when it has no words or the
 *  aligner crushed them together (lyrics that are not sung there). MMS_FA's
 *  per-word scores are not used: on dense source mixes they read near zero
 *  while the times still land where the block is sung. */
function firstWord(block: Block, words: Yue2AlignWord[]): number | null {
  const timed = words.filter(word => word.char0 >= block.start && word.char0 < block.end &&
    Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start);
  if (!timed.length || median(timed.map(word => word.end - word.start)) < MIN_WORD_SECONDS) return null;
  return median(timed.slice(0, 3).map(word => word.start));
}

interface Span { label: string; start: number; sung: boolean }

/** The score section each block opens or goes on under, or null when unsure:
 *  the in-order assignment of least total cost (see the costs above). A block
 *  under the same section as the last placed one is a merge; the caller still
 *  flags it unsure when an unsure block sits between them. */
function bestFit(blocks: Block[], timed: Array<number | null>, spans: Span[], songEnd: number, pickup: number) {
  const length = (s: number) => (s + 1 < spans.length ? spans[s + 1].start : songEnd) - spans[s].start;
  const open = (i: number, s: number) => {
    const t = timed[i]!, start = spans[s].start, len = length(s);
    const off = t < start - pickup ? start - pickup - t : Math.max(0, t - start);
    const kind = blocks[i].tag ? sectionKind(blocks[i].tag!) : null;
    return off / len + (kind && /^(verse|chorus|bridge|intro|outro|interlude|pre-chorus)$/.test(kind) &&
      kind !== sectionKind(spans[s].label) ? KIND_COST : 0);
  };
  const merge = (i: number, s: number) =>
    MERGE_COST + Math.max(0, timed[i]! - (spans[s].start + length(s) - pickup)) / length(s);
  // Ad-libs over an instrumental ([Interlude] na-nas) have no Vocal note, so
  // a section with none takes only a block tagged as its own kind.
  const fits = (i: number, s: number) =>
    spans[s].sung || (!!blocks[i].tag && sectionKind(blocks[i].tag!) === sectionKind(spans[s].label));
  // cost[j]: least cost so far with section j - 1 the last placed (0: none yet).
  let cost = spans.map(() => Infinity).concat(Infinity);
  cost[0] = 0;
  const choices: Array<Array<{ from: number; section: number | null }>> = [];
  timed.forEach((t, i) => {
    const next = cost.map(c => c + UNSURE_COST);
    const choice = cost.map((_, j) => ({ from: j, section: null as number | null }));
    if (t !== null) {
      cost.forEach((c, j) => {
        if (c === Infinity) return;
        if (j > 0 && fits(i, j - 1) && c + merge(i, j - 1) < next[j]) { next[j] = c + merge(i, j - 1); choice[j] = { from: j, section: j - 1 }; }
        for (let s = j; s < spans.length; s++) {
          if (!fits(i, s)) continue;
          const total = c + open(i, s);
          if (total < next[s + 1]) { next[s + 1] = total; choice[s + 1] = { from: j, section: s }; }
        }
      });
    }
    choices.push(choice);
    cost = next;
  });
  const sections: Array<number | null> = [];
  let j = cost.indexOf(Math.min(...cost));
  for (let i = timed.length - 1; i >= 0; i--) {
    sections[i] = choices[i][j].section;
    j = choices[i][j].from;
  }
  return sections;
}

export function matchSectionsToScore(abc: string, lyrics: string, words: Yue2AlignWord[]): SectionMatchResult {
  const sections = scoreSections(abc);
  if (!sections.length) throw new Error('The score has no section labels.');
  const bars = scoreBarClock(abc);
  const onsets = scoreVocalNoteOnsets(abc, bars);
  const spans = sections.map((section, i) => {
    const endBar = i + 1 < sections.length ? sections[i + 1].startBar - 1 : bars.length;
    const firstSungBar = endBar > section.startBar ? section.startBar : section.startBar - 1;
    return { label: section.label.trim(), start: bars[section.startBar - 1]?.start ?? 0,
      sung: onsets.slice(firstSungBar, endBar).some(onset => onset !== null) };
  });
  const barSeconds = bars[0].end - bars[0].start;
  const blocks = splitLyricBlocks(lyrics);
  const label = (i: number) => spans[i].label;
  const songEnd = bars[bars.length - 1].end;
  // Index of the section a time falls in.
  const containing = (seconds: number) => {
    let found = 0;
    spans.forEach((span, i) => { if (span.start <= seconds) found = i; });
    return found;
  };

  const timed = blocks.map(block => block.body.trim() ? firstWord(block, words) : null);
  const placed = bestFit(blocks, timed, spans, songEnd, PICKUP_BARS * barSeconds)
    .map((section, i) => ({ block: blocks[i], sung: timed[i], section }));

  const out: string[] = [];
  const report: SectionMatchBlock[] = [];
  const filled: SectionMatchResult['filled'] = [];
  const lastOfKind = new Map<string, number>();  // kind -> block index
  let current = -1;
  let unsureSince = false;
  let lastWasPlaced = false;  // out's last entry is current's own block
  const emitted = new Set<number>();
  const fill = (upTo: number, instrumentalOnly = false) => {
    for (let s = current + 1; s < upTo; s++) {
      if (emitted.has(s) || (instrumentalOnly && spans[s].sung)) continue;
      const kind = sectionKind(spans[s].label);
      const source = spans[s].sung && !unsureSince && REPEATS.test(kind) ? lastOfKind.get(kind) : undefined;
      if (spans[s].sung && source === undefined) continue;  // leave it; nothing safe to copy
      const body = source === undefined ? '' : blocks[source].body;
      out.push(`[${label(s)}]${body ? `\n${body}` : ''}`);
      emitted.add(s);
      lastWasPlaced = false;
      filled.push({ section: s + 1, label: label(s), copiedFrom: source === undefined ? null : source + 1 });
    }
  };
  placed.forEach((p, i) => {
    const { block } = p;
    if (!block.body.trim()) {
      // An empty tag ([Intro], [Solo]): the score's own sections replace it.
      report.push({ index: i + 1, tag: block.tag, newTag: null, section: null, firstWordSeconds: null, status: 'dropped' });
      return;
    }
    // A block sung in the section the previous block opened shares its tag,
    // but only straight after it: never under an unsure block or a filler.
    const mergeable = p.section !== null && p.section === current && lastWasPlaced;
    if (p.section === null || (p.section === current && !mergeable)) {
      // Instrumental sections up to where it seems to start, including the
      // one it lands in, come first.
      if (p.sung !== null) fill(containing(p.sung + PICKUP_BARS * barSeconds) + 1, true);
      out.push(block.tag ? `[${block.tag}]\n${block.body}` : block.body);
      report.push({ index: i + 1, tag: block.tag, newTag: block.tag, section: null, firstWordSeconds: p.sung,
        status: 'unsure' });
      unsureSince = true;
      lastWasPlaced = false;
      return;
    }
    const s = p.section;
    if (mergeable) {
      out[out.length - 1] += `\n\n${block.body}`;
      report.push({ index: i + 1, tag: block.tag, newTag: null, section: s + 1, firstWordSeconds: p.sung, status: 'merged' });
      return;
    }
    fill(s);
    const newTag = label(s);
    const keep = block.tag === newTag;
    out.push(`[${newTag}]\n${block.body}`);
    report.push({ index: i + 1, tag: block.tag, newTag, section: s + 1, firstWordSeconds: p.sung,
      status: keep ? 'kept' : 'renamed' });
    lastOfKind.set(sectionKind(spans[s].label), i);
    current = s;
    unsureSince = false;
    lastWasPlaced = true;
  });
  fill(spans.length);
  const result = out.join('\n\n');
  const normalized = lyrics.replace(/\r\n?/g, '\n').trim();
  return { lyrics: result, blocks: report, filled, unchanged: result === normalized };
}
