// Instrumental YuE2 renders, after upstream's yue2-music instrumental skill
// (multimodal-art-projection/YuE 72272f9, skills/yue2-music/instrumental):
// every Vocal note moves to Ins, Vocal keeps only rests and chord symbols, and
// the style says plainly that nothing is sung. Empty lyrics alone leave the
// melody on the Vocal voice, and YuE2 sings it as wordless oohs.

const LENGTHS = [48, 32, 24, 16, 12, 8, 6, 4, 3, 2, 1];
const TOKEN = /"[^"]*"|\[[^\]]*\]|[_^=]*[A-Ga-g][,']*\d*(?:\/\d*)?-?|[zx]\d*(?:\/\d*)?|Z\d*|\S/g;
const NOTE = /^[_^=]*[A-Ga-g]/;

function length(token: string): number {
  const m = token.match(/(\d*)(?:\/(\d*))?-?$/)!;
  const num = m[1] ? Number(m[1]) : 1;
  return m[0].includes('/') ? num / (m[2] ? Number(m[2]) : 2) : num;
}

function rests(ticks: number): string {
  let out = '';
  while (ticks > 0) {
    const n = LENGTHS.find(l => l <= ticks) ?? ticks;
    out += n === 1 ? 'z' : `z${n}`;
    ticks -= n;
  }
  return out;
}

/** One line's bars, with Z2-Z4 expanded to single whole-bar rests. */
function bars(line: string): string[] {
  return line.replace(/\|\s*$/, '').split('|').flatMap(bar => {
    const multi = bar.trim().match(/^Z(\d+)$/);
    return multi ? Array<string>(Number(multi[1])).fill('Z') : [bar.trim()];
  });
}

/** Runs of bare whole-bar rests fold back into Z2-Z4 within the group. */
function line(barList: string[]): string {
  const out: string[] = [];
  for (const bar of barList) {
    const last = out[out.length - 1];
    const run = last?.match(/^Z(\d*)$/);
    if (bar === 'Z' && run && Number(run[1] || 1) < 4) out[out.length - 1] = `Z${Number(run[1] || 1) + 1}`;
    else out.push(bar);
  }
  return out.join('|') + '|';
}

/** Vocal bar -> [what Vocal keeps, the notes Ins takes], or null when nothing sounds. */
function moveBar(bar: string): [string, string] | null {
  const tokens = bar.match(TOKEN) ?? [];
  if (!tokens.some(t => NOTE.test(t))) return null;
  let at = 0, kept = '', last = 0;
  const fields = tokens.filter(t => t.startsWith('['));
  for (const t of tokens) {
    if (t.startsWith('"')) { kept += rests(at - last) + t; last = at; }
    else if (NOTE.test(t) || /^[zx]/.test(t)) at += length(t);
  }
  const vocal = kept ? fields.join('') + kept + rests(at - last) : 'Z';
  const ins = tokens.filter(t => !t.startsWith('"')).join('');
  return [vocal, ins];
}

export interface InstrumentalScore { abc: string; movedBars: number; replacedInsBars: number }

/** Moves the Vocal melody of a native YuE2 score onto Ins, bar by bar. A bar
 *  where Vocal sounds takes Vocal's notes on Ins outright; Ins keeps its own
 *  notes only in bars where Vocal is silent (intros, interludes, fills). */
// ponytail: bar-level Vocal priority. Upstream keeps the non-overlapping parts
// of Ins notes inside a sung bar; do that if dropped fills are audible.
export function instrumentalScore(abc: string): InstrumentalScore {
  const nl = abc.includes('\r\n') ? '\r\n' : '\n';
  const lines = abc.split(/\r?\n/);
  const out: string[] = [];
  let header = true, voice = '';
  // The group being read: Vocal's bars and Ins's, each with any field lines (M:, K:) it carried.
  let group: { vocal: string[]; vocalFields: string[]; ins: string[] | null; insFields: string[] } | null = null;
  let movedBars = 0, replacedInsBars = 0;
  const keyLine = lines.findIndex(l => /^K:/.test(l));
  const hasInsDeclaration = lines.some((l, i) => /^V:\s*Ins\b/i.test(l) && i < keyLine);
  // A group is rewritten once its Ins line arrives, or when the next group or
  // a section starts; a Vocal line with no Ins partner (a melody-only cover
  // score) gets one.
  const flush = () => {
    if (!group) return;
    const ins = group.ins ?? group.vocal.map(() => 'Z');
    const vocal = group.vocal.map((bar, i) => {
      const moved = moveBar(bar);
      if (!moved) return bar;
      movedBars++;
      if (ins[i] !== undefined && (ins[i].match(TOKEN) ?? []).some(t => NOTE.test(t))) replacedInsBars++;
      ins[i] = moved[1];
      return moved[0];
    });
    out.push('V: Vocal', ...group.vocalFields, line(vocal), 'V: Ins', ...group.insFields, line(ins));
    group = null;
  };
  for (const raw of lines) {
    if (header) {
      out.push(raw);
      if (!hasInsDeclaration && /^V:\s*Vocal\b/i.test(raw)) out.push('V: Ins clef=treble name="Ins Melody" snm="Inst."');
      if (/^K:/.test(raw)) header = false;
      continue;
    }
    const text = raw.trim();
    if (/^V:/.test(text)) {
      voice = /^V:\s*Vocal\b/i.test(text) ? 'vocal' : /^V:\s*Ins\b/i.test(text) ? 'ins' : 'other';
      if (voice === 'vocal' && group?.vocal.length) flush();
      if (voice === 'other') { flush(); out.push(raw); }
      continue;
    }
    if (voice === 'vocal') {
      if (/^[A-Za-z]:/.test(text)) { (group ??= { vocal: [], vocalFields: [], ins: null, insFields: [] }).vocalFields.push(raw); continue; }
      if (text && !text.startsWith('%')) { (group ??= { vocal: [], vocalFields: [], ins: null, insFields: [] }).vocal.push(...bars(text)); continue; }
    }
    if (voice === 'ins' && group && group.ins === null) {
      if (/^[A-Za-z]:/.test(text)) { group.insFields.push(raw); continue; }
      if (text && !text.startsWith('%')) { group.ins = bars(text); flush(); continue; }
    }
    // Blank lines, section comments, other voices, or Ins with no Vocal before it.
    if (text && !text.startsWith('%') && !/^[A-Za-z]:/.test(text) && voice === 'ins') { out.push('V: Ins', raw); continue; }
    flush();
    out.push(raw);
  }
  flush();
  return { abc: out.join(nl), movedBars, replacedInsBars };
}

/** Upstream's instrumental style wording: lead with "Instrumental", and say
 *  no vocals, singing, choir or speech. Idempotent. */
export function instrumentalStyle(style: string): string {
  let s = style.trim().replace(/[.,]+$/, '');
  if (!/^instrumental\b/i.test(s)) s = s ? `Instrumental, ${s}` : 'Instrumental';
  for (const condition of ['no vocals', 'no singing', 'no choir', 'no spoken words']) {
    if (!s.toLowerCase().includes(condition)) s += `, ${condition}`;
  }
  return `${s}.`;
}
