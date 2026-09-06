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
 * The characters a transcript key may be spelled with, and how many of them.
 *
 * Exactly the rule `transcriptKeyIsSafe` used to state as a regex — one
 * alphanumeric, then up to sixty-three more of those plus `_` and `-` — held
 * here as an alphabet so the key can be REBUILT from it rather than tested and
 * passed through.
 */
const KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const KEY_TAIL_ALPHABET = `${KEY_ALPHABET}_-`;
const MAX_KEY_CHARS = 64;

/**
 * The key a transcript path may be joined from, or null for anything else.
 *
 * A key must be a bare filename, because it becomes one: this is what stops
 * `../../openclaw.json` being a transcript name the moment a key arrives from
 * a request.
 *
 * Rather than testing the key and then joining the ORIGINAL string, the value
 * the store joins is assembled here one character at a time out of the
 * alphabet — whatever the caller sent, the filename is made of these
 * characters and no more than this many of them. The rule is exactly the regex
 * it replaces; it is written this way for the reason `safeAppId`,
 * `safeProjectId` and `safeSkillName` state in their own modules — a `.test()`
 * guard leaves the caller's string in play, and a static analyser rightly
 * keeps flagging every path built from it (`js/path-injection`, TASK-723).
 *
 * ITS OWN COPY, and this module has the strongest reason of the four to keep
 * one: nothing here imports anything, deliberately, so `ChatPopup` and the
 * other client components can share `DESKTOP_TRANSCRIPT_KEY` and this rule
 * without pulling the store in. `webapp-icon.ts` — where `safeAppId` lives —
 * imports `fs/promises`, `crypto` and the image client, so collapsing the two
 * would drag `fs` into the browser bundle. (`code-projects.ts` says the same
 * thing about its own copy, for its own reason.)
 *
 * Takes `unknown`, and refuses a non-string rather than coercing it: every
 * route door checks the type first, and each is one `as string` away from not
 * doing so — `/re/.test(7)` answers true and would have opened `7.jsonl`.
 *
 * The length bound is `key.length`, which counts UTF-16 code units, while the
 * loop below walks CODE POINTS. The two can only differ outside the BMP, and
 * every character this alphabet admits is ASCII — so an astral character is
 * refused by the loop before the difference could matter, and the bound stays
 * exactly the `{0,63}` the regex counted.
 */
export function safeTranscriptKey(key: unknown): string | null {
  if (typeof key !== "string" || key.length < 1 || key.length > MAX_KEY_CHARS) return null;
  let safe = "";
  for (const ch of key) {
    // The first character carries the narrower alphabet: a key may not start
    // with `_` or `-`.
    const alphabet = safe.length === 0 ? KEY_ALPHABET : KEY_TAIL_ALPHABET;
    const at = alphabet.indexOf(ch);
    if (at < 0) return null;
    safe += alphabet[at];
  }
  return safe;
}

/**
 * Whether a key may become a filename — the door the routes hold requests to.
 *
 * Asks the rebuild whether it produced anything rather than repeating the
 * rule, so the value a route admits and the value the store joins cannot
 * drift apart.
 */
export function transcriptKeyIsSafe(key: string): boolean {
  return safeTranscriptKey(key) !== null;
}
