// abPair.ts - pure state for the Compare A/B quick switch.
// A and B are two take ids. Before a second take is chosen, A = baseline and
// B = the next take. Choosing a take outside the pair replaces the slot that
// was not active, so the A/B button always flips between the current take and
// the previously active one.

export interface AbPair { a: string | null; b: string | null; }

export function initialPair(ids: string[], baselineId: string | null): AbPair {
  const a = baselineId && ids.includes(baselineId) ? baselineId : ids[0] ?? null;
  const b = ids.find(id => id !== a) ?? null;
  return { a, b };
}

/** Update the pair when the active take changes from prev to next. */
export function choosePair(pair: AbPair, prev: string | null, next: string): AbPair {
  if (next === pair.a || next === pair.b) return pair;
  if (prev === pair.a) return { a: pair.a, b: next };
  if (prev === pair.b) return { a: next, b: pair.b };
  return { a: prev, b: next };
}

/** Take to switch to when the A/B button is pressed. */
export function toggleTarget(pair: AbPair, current: string | null): string | null {
  if (current === pair.a) return pair.b;
  if (current === pair.b) return pair.a;
  return pair.a;
}

/** Drop the pair if a take in it was removed. */
export function prunePair(pair: AbPair, ids: string[], baselineId: string | null): AbPair {
  const ok = (id: string | null) => id === null || ids.includes(id);
  return ok(pair.a) && ok(pair.b) && pair.b !== null ? pair : initialPair(ids, baselineId);
}
