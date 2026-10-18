import assert from 'node:assert/strict';
import test from 'node:test';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
};
const { buildCaption, finishSavedBuild, onBuildSaved, submittedCaption } = await import('./Yue2Build');
const saved = () => JSON.parse(store.get('cover-studio-buildSessionId') ?? '""');

test('a Save finishing after the studio was rebuilt clears its build and tells the mounted studio', () => {
  store.set('cover-studio-buildSessionId', '"a"');
  const seen: string[] = [];
  const off = onBuildSaved(id => seen.push(id));
  assert.equal(finishSavedBuild('a'), true);
  assert.equal(saved(), '');
  assert.deepEqual(seen, ['a']);
  off();
});

test('a Save finishing after a newer build began leaves the newer build', () => {
  store.set('cover-studio-buildSessionId', '"b"');
  const seen: string[] = [];
  const off = onBuildSaved(id => seen.push(id));
  assert.equal(finishSavedBuild('a'), false);
  assert.equal(saved(), 'b');
  assert.deepEqual(seen, []);
  off();
});

test('lyrics edits wait for a saved build to load instead of becoming a draft', async () => {
  const { lyricsTarget } = await import('./Yue2Build');
  assert.equal(lyricsTarget('saved-id', null), 'loading');
  assert.equal(lyricsTarget('saved-id', { id: 'saved-id' }), 'session');
  assert.equal(lyricsTarget('', null), 'draft');
});

test('a draft belongs to the source and score it was written for', async () => {
  const { draftText } = await import('./Yue2Build');
  const first = JSON.stringify(['musicxml', '', '', '', 'X:1 first score']);
  const second = JSON.stringify(['musicxml', '', '', '', 'X:1 other score']);
  const draft = { source: first, text: '[verse]\nmine' };
  assert.equal(draftText(draft, first), '[verse]\nmine');
  assert.equal(draftText(draft, second), null);
  assert.equal(draftText(null, first), null);
});

const arranged = (plan: string[], kept = 0, lyricBlocks: Array<number | null> = [0, 1, null]) => ({
  id: 'x', revision: 3, kept: kept ? ['t'] : [], pending: [], error: null, params: {}, sections: [],
  takes: kept ? [{ id: 't', to: kept - 1, parent: null, occurrences: [], revision: 3 }] : [],
  arrangement: { finished: true, plan: plan.map((s, i) => ({ id: `o${i}`, section: s })),
    sections: lyricBlocks.map((lyricBlock, i) => ({ id: `s${i}`, label: `S${i}`, startBar: 1, bars: 4, lyricBlock })) },
}) as any;

test('the output bar lists occurrences in plan order, kept ones locked, a repeat with its own id', async () => {
  const { planItems } = await import('./Yue2Build');
  const items = planItems(arranged(['s0', 's1', 's1', 's0'], 2));
  assert.deepEqual(items.map(i => [i.id, i.section, i.kept]), [['o0', 0, true], ['o1', 1, true], ['o2', 1, false], ['o3', 0, false]]);
  // Before a build exists the song is empty: it is built up from the source bar.
  assert.deepEqual(planItems(null), []);
});

test('plan edits send only the unbuilt part: add a source section, remove, move', async () => {
  const { planItems, editedPlan } = await import('./Yue2Build');
  const items = planItems(arranged(['s0', 's1', 's2'], 1));
  assert.deepEqual(editedPlan(items, 1, { add: 1 }), ['o1', 'o2', 's1']);
  assert.deepEqual(editedPlan(items, 1, { remove: 'o1' }), ['o2']);
  assert.deepEqual(editedPlan(items, 1, { move: 'o2', by: -1 }), ['o2', 'o1']);
  assert.deepEqual(editedPlan(items, 1, { move: 'o1', by: -1 }), ['o1', 'o2']);
});

test('a repeated chorus shows its lyrics under each occurrence; an unsung section shows none', async () => {
  const { planItems, occurrenceLyrics } = await import('./Yue2Build');
  const lyrics = '[verse]\none\n\n[chorus]\nsing\n';
  const session = arranged(['s0', 's1', 's1', 's2']);
  const text = planItems(session).map(i => occurrenceLyrics(lyrics, session, i));
  assert.deepEqual(text, ['[verse]\none', '[chorus]\nsing', '[chorus]\nsing', '']);
});

test('a take is keepable only if it follows the spine at this revision and composed the planned occurrences', async () => {
  const { keepable } = await import('./Yue2Build');
  const session = arranged(['s0', 's1', 's2'], 1);
  const take = (over = {}) => ({ id: 'n', from: 1, to: 2, revision: 3, parent: 't', occurrences: ['o1', 'o2'], ...over }) as any;
  assert.equal(keepable(session, take()), true);
  assert.equal(keepable(session, take({ revision: 2 })), false);
  assert.equal(keepable(session, take({ occurrences: ['o2', 'o1'] })), false);
  assert.equal(keepable(session, take({ parent: null })), false);
});

test('Generate sends a caption only when the field differs from the build\'s', () => {
  assert.equal(submittedCaption('  bright pop ', 'bright pop'), '');
  assert.equal(submittedCaption('quiet, acoustic guitar, whispers ', 'bright pop'), 'quiet, acoustic guitar, whispers');
  assert.equal(buildCaption({ caption: 'c', style: 's' }), 'c');
  assert.equal(buildCaption({ prompt: 'p', caption: 'c' }), 'p');
});

test('the lyrics pane edits lines without the tag; Generate applies only the changed ones', async () => {
  const { planItems, occurrenceLines, pendingLyrics } = await import('./Yue2Build');
  const lyrics = '[verse]\none\ntwo\n\n[chorus]\nsing\n';
  const session = arranged(['s0', 's1', 's1', 's2']);
  session.arrangement.plan[2].lyrics = 'sing again';
  assert.deepEqual(planItems(session).map(i => occurrenceLines(lyrics, session, i)), ['one\ntwo', 'sing', 'sing again', null]);
  assert.deepEqual(pendingLyrics({ o0: 'one\ntwo ', o1: 'louder', o3: 'x', o9: 'y' }, { o0: 'one\ntwo', o1: 'sing', o3: null }), { o1: 'louder' });
});

