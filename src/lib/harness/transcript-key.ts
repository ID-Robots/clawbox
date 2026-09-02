/**
 * The name of one on-disk transcript.
 *
 * Client-safe on purpose (no `fs`): the chat surface mints these keys for the
 * conversations it opens, the routes validate them on the way in, and only the
 * store (`transcript-store.ts`, server-only) turns one into a filename. Keeping
 * the constant and its validator here is what lets all three agree without a
 * client component importing the store.
 */

/**
 * The desktop chat's own conversation — the one thread this surface had before
 * it grew tabs, and still the one every other tab is opened beside.
 */
export const DESKTOP_TRANSCRIPT_KEY = "desktop";

/**
 * A key must be a bare filename, because it becomes one.
 *
 * This is the guard that stops `../../openclaw.json` being a transcript name
 * the moment a key arrives from a request. Exported so its test can hold it
 * to that.
 */
export function transcriptKeyIsSafe(key: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(key);
}
