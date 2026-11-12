/**
 * How many tokens a text may take, for sizing one request to a model with a
 * bounded window (the model on this box: `local-engine.ts`). Pure.
 *
 * A deliberately conservative characters-per-token: English prose runs near
 * four, but Cyrillic, code and JSON-escaped text run nearer two and a half on
 * the small models a box serves, and an estimate that runs short is a request
 * the server refuses after reading its whole prompt.
 */
export const CHARS_PER_TOKEN = 2.5;

/** Tokens `text` may take, rounded up: see {@link CHARS_PER_TOKEN}. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
