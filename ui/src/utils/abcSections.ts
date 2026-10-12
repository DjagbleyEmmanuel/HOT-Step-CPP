// Score sections as the ABC marks them: a whole-line `%Label` comment opens a
// section. The server's scoreSections.ts reads the same lines in the same
// order, so mark i here is score section i there. One known difference: the
// server would also count a `%%` directive line, which nothing in this repo
// writes into a score (a hand-pasted ABC could carry one).

export interface AbcSectionMark { label: string; offset: number }

/** Each section label with the character offset of its comment line, counted
 *  as abcjs counts its startChar: after turning CRLF and CR into LF. */
export function abcSectionMarks(abc: string): AbcSectionMark[] {
  const marks: AbcSectionMark[] = [];
  let offset = 0;
  for (const raw of abc.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    // %% lines are directives (the preview's own %%MIDI included), not labels.
    if (line.startsWith('%') && !line.startsWith('%%')) {
      const label = line.slice(1).trim();
      if (label) marks.push({ label, offset });
    }
    offset += raw.length + 1;
  }
  return marks;
}

/** Index of the section containing character `char`, or -1 before the first. */
export function sectionAtChar(marks: AbcSectionMark[], char: number): number {
  let index = -1;
  while (index + 1 < marks.length && marks[index + 1].offset <= char) index++;
  return index;
}

// Mid-tone hues that read on the score's white box and on the dark chips.
const PALETTE = ['#2563eb', '#db2777', '#16a34a', '#ea580c', '#7c3aed', '#0891b2', '#ca8a04', '#dc2626'];

/** One colour per section, shared by sections with the same label, so every
 *  chorus is the same colour and a repeat is easy to compare by eye. */
export function sectionColours(labels: string[]): string[] {
  const byLabel = new Map<string, string>();
  return labels.map(label => {
    const key = label.toLowerCase();
    if (!byLabel.has(key)) byLabel.set(key, PALETTE[byLabel.size % PALETTE.length]);
    return byLabel.get(key)!;
  });
}
