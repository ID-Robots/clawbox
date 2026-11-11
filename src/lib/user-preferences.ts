// A member of staff's own desktop preferences on an organisation box. SERVER ONLY.
//
// The desktop's preferences (`pref:*` — the wallpaper, the icon grid, the
// desktop's app list, the shelf's pins, the chat panel's width) are ONE set
// for the whole box: on a home box every signed-in user arranges the same
// desktop. On an organisation box (src/lib/org-mode.ts) that cannot hold. A
// member of staff sees three apps, and their desktop saving its icon grid and
// its app list for those three would rearrange the owner's; their wallpaper
// would be everyone's. So there, a member of staff's writes land in a map of
// their own and their reads are the box's preferences with theirs on top:
//
//   `prefs_by_user`   username → { name → value }, one entry per member of
//                     staff who changed anything. Never under `pref:`, so
//                     `preferences_get`, an `all=1` read and every other user
//                     see only the box's own values, and no caller can name
//                     another user's entry through the preferences route's
//                     key whitelist (the names are the route's own, rebuilt
//                     by `safePreferenceKey`).
//
// Their UI language keeps its own map (src/lib/user-language.ts), which the
// agent reads for their chat. A removed user's entry goes with the account
// (src/lib/clawbox-users.ts), so the same name later starts on the box's look.

import * as config from "@/lib/config-store";
import { safePreferenceKey, validatePreference } from "@/lib/preference-schema";
import { createSerialLock } from "@/lib/serial-lock";
import { USERNAME_RE } from "@/lib/username-rules";

/** Top-level device-store key: `{ [username]: { [name]: value } }`. */
export const USER_PREFERENCES_KEY = "prefs_by_user";

/** The most names one member of staff may hold — the box's own bound is 500 for everyone together. */
export const MAX_USER_PREFERENCES = 200;

type Prefs = Record<string, unknown>;

/** One user's stored names, read defensively: a name outside the alphabet or a value the schema refuses is dropped. */
function parseOne(raw: unknown): Prefs {
  const out: Prefs = Object.create(null);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = safePreferenceKey(name);
    if (key === null || value === undefined || !validatePreference(key, value).ok) continue;
    out[key] = value;
  }
  return out;
}

/** The whole stored map; an entry whose name is not a username is dropped. */
export function parseUserPreferences(raw: unknown): Map<string, Prefs> {
  const out = new Map<string, Prefs>();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [username, prefs] of Object.entries(raw as Record<string, unknown>)) {
    if (!USERNAME_RE.test(username)) continue;
    const parsed = parseOne(prefs);
    if (Object.keys(parsed).length > 0) out.set(username, parsed);
  }
  return out;
}

/** `username`'s own preferences out of a store already read (empty when they changed nothing). */
export function userPreferencesFor(username: string, store: Record<string, unknown>): Prefs {
  return parseUserPreferences(store[USER_PREFERENCES_KEY]).get(username) ?? Object.create(null);
}

const withMapLock = createSerialLock();

async function rewriteMap(change: (map: Map<string, Prefs>) => boolean): Promise<void> {
  await withMapLock(async () => {
    const map = parseUserPreferences(await config.get(USER_PREFERENCES_KEY));
    if (!change(map)) return;
    const next: Record<string, Prefs> = Object.create(null);
    for (const [username, prefs] of map) next[username] = prefs;
    await config.set(USER_PREFERENCES_KEY, map.size > 0 ? next : undefined);
  });
}

export type SetUserPreferencesResult = "ok" | "full" | "invalid";

/**
 * Store `entries` (names already rebuilt and values already validated by the
 * preferences route) as `username`'s own. `full` stores nothing when the
 * write would take them past `MAX_USER_PREFERENCES`.
 */
export async function setUserPreferences(username: string, entries: Prefs): Promise<SetUserPreferencesResult> {
  if (!USERNAME_RE.test(username)) return "invalid";
  let result: SetUserPreferencesResult = "ok";
  await rewriteMap((map) => {
    const own: Prefs = Object.assign(Object.create(null), map.get(username) ?? {});
    let changed = false;
    for (const [name, value] of Object.entries(entries)) {
      const key = safePreferenceKey(name);
      if (key === null || !validatePreference(key, value).ok) continue;
      if (Object.is(own[key], value) && typeof value !== "object") continue;
      own[key] = value;
      changed = true;
    }
    if (!changed) return false;
    if (Object.keys(own).length > MAX_USER_PREFERENCES) {
      result = "full";
      return false;
    }
    map.set(username, own);
    return true;
  });
  return result;
}

/** Drop `username`'s preferences — the user was removed. */
export async function forgetUserPreferences(username: string): Promise<void> {
  await rewriteMap((map) => map.delete(username));
}
