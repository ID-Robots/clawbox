// Each ClawBox user's own UI language. SERVER ONLY.
//
// The box has ONE persona — SOUL.md and USER.md, which every chat and every
// cron or automation run reads — and it used to have one UI language as well:
// `pref:ui_language`, which Settings → Language wrote for whoever was signed
// in and then wrote into that persona. So one user's pick changed the desktop
// and the agent's language for the owner, for every other user and for every
// scheduled run.
//
// Two values now:
//
//   `pref:ui_language`   the BOX DEFAULT, which is the owner's. What /login
//                        renders before anyone signs in, what an unsigned
//                        caller (the agent's bearer, the setup wizard, the
//                        e2e harness) reads and writes, what the persona
//                        carries (src/lib/language-persona.ts) and what a
//                        user who never picked one sees.
//   `ui_language_by_user` username → locale, one entry per ClawBox user OTHER
//                        than the owner who picked a language of their own.
//                        Never under `pref:`, so `preferences_get` and an
//                        `all=1` read do not serve one person's pick as the
//                        box's, and no caller can name another user's entry
//                        through the preferences route's key whitelist.
//
// A user's pick reaches the agent only in that user's own chat, as a per-turn
// instruction (scripts/openclaw-plugins/clawbox-user-language): never through
// the persona files, so no other chat and no cron run ever sees it.

import * as config from "@/lib/config-store";
import { createSerialLock } from "@/lib/serial-lock";
import { isPreferenceLanguage, PREFERENCE_KEY_PREFIX, type PreferenceLanguage } from "@/lib/preference-schema";
import type { SessionIdentity } from "@/lib/session-identity";
import { USERNAME_RE } from "@/lib/username-rules";

/** The box default: the owner's language, and everyone's until they pick one. */
export const BOX_LANGUAGE_KEY = `${PREFERENCE_KEY_PREFIX}ui_language`;

/**
 * Top-level device-store key: `{ [username]: locale }` for the users other
 * than the owner. scripts/openclaw-plugins/clawbox-user-language reads the
 * same key out of data/config.json.
 */
export const USER_LANGUAGES_KEY = "ui_language_by_user";

/**
 * The stored map, read defensively: an entry whose name is not a username or
 * whose value is not a locale the box ships is dropped, never served — the
 * value is interpolated into the agent's instructions for that user's chat.
 */
export function parseUserLanguages(raw: unknown): Map<string, PreferenceLanguage> {
  const out = new Map<string, PreferenceLanguage>();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [username, lang] of Object.entries(raw as Record<string, unknown>)) {
    if (USERNAME_RE.test(username) && isPreferenceLanguage(lang)) out.set(username, lang);
  }
  return out;
}

/** The box default out of a store already read, or null when none is set (or it is not one we ship). */
export function boxLanguage(store: Record<string, unknown>): PreferenceLanguage | null {
  const lang = store[BOX_LANGUAGE_KEY];
  return isPreferenceLanguage(lang) ? lang : null;
}

/**
 * The language `who` sees, out of a store already read: a signed-in user other
 * than the owner gets their own pick, else the box default. The owner, and a
 * caller that is no person (`null`), get the box default.
 */
export function languageFor(
  who: SessionIdentity | null,
  store: Record<string, unknown>,
): PreferenceLanguage | null {
  if (who && !who.isOwner) {
    const own = parseUserLanguages(store[USER_LANGUAGES_KEY]).get(who.username);
    if (own) return own;
  }
  return boxLanguage(store);
}

// One change to the map at a time: each is a read-modify-write of one key, and
// two users saving together must not each drop the other's pick.
const withMapLock = createSerialLock();

async function rewriteMap(change: (map: Map<string, PreferenceLanguage>) => boolean): Promise<void> {
  await withMapLock(async () => {
    const map = parseUserLanguages(await config.get(USER_LANGUAGES_KEY));
    if (!change(map)) return;
    // Null-prototype, like every object here that takes names from outside.
    const next: Record<string, string> = Object.create(null);
    for (const [username, lang] of map) next[username] = lang;
    await config.set(USER_LANGUAGES_KEY, map.size > 0 ? next : undefined);
  });
}

/**
 * Store `lang` as `username`'s own language. Never the owner's: their pick is
 * the box default and goes through `pref:ui_language`. Returns false, storing
 * nothing, for a name or a locale outside the rules.
 */
export async function setUserLanguage(username: string, lang: unknown): Promise<boolean> {
  if (!USERNAME_RE.test(username) || !isPreferenceLanguage(lang)) return false;
  await rewriteMap((map) => {
    if (map.get(username) === lang) return false;
    map.set(username, lang);
    return true;
  });
  return true;
}

/** Drop `username`'s pick — the user was removed, so the name starts on the box default again. */
export async function forgetUserLanguage(username: string): Promise<void> {
  await rewriteMap((map) => map.delete(username));
}
