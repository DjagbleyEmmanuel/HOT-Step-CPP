// Safety net for the YuE2 composer (semantic) stage: unlimited top-k (0) with
// temperature above 1.0 samples from the whole flattened tail and the song
// falls apart. Clamp temperature to 1.0 and leave a warning in the job notes.
// Pure (no DB/engine imports) so it can be checked in isolation.
export function clampYue2SemanticSampling(overrides: Record<string, number>, notes: string[]): void {
  if (overrides.semantic_top_k === 0 && (overrides.semantic_temperature ?? 1.0) > 1.0) {
    notes.push(`WARNING: semantic_top_k=0 (unlimited) with semantic_temperature=${overrides.semantic_temperature} breaks the composer stage; temperature clamped to 1.0`);
    overrides.semantic_temperature = 1.0;
  }
}
