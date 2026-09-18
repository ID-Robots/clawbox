// Shape rules for everything stored under `pref:*` in the config store.
//
// Preferences have TWO write doors — the `preferences_set` MCP tool and
// POST /setup-api/preferences — and only the tool validated. The route stored
// whatever it was handed, so the tool's per-key rules were a suggestion rather
// than an invariant: anything that could reach the route directly could park
// arbitrary text under a key the tool would have refused.
//
// That matters because preferences are not write-only. `preferences_get` is an
// agent-callable tool: stored values are read back into the model's context,
// and `ui_language` is additionally interpolated into the agent's persona
// files. A preference is a SETTING — a locale code, an opacity, a name, a list
// of app ids — never a document, so the rules below can be strict without
// costing anything real.
//
// Two layers, deliberately:
//
//   1. Closed domains. Keys with a finite, known set of legal values are
//      checked against that set. `ui_language` is the important one: it is the
//      only preference that gets interpolated into SOUL.md/USER.md, so it must
//      be a locale we ship and nothing else.
//
//   2. A general shape/length bound on EVERY other key. Enumerating a domain
//      per key would be the wrong answer for the rest — most of them hold live
//      desktop state (window geometry, icon grids, installed-app lists) whose
//      shape changes whenever the desktop grows a field, and a per-key table
//      would silently start rejecting valid state. What every preference DOES
//      share is that it is small, single-line, JSON-shaped data. Bounding that
//      catches the whole "stored blob is read back as prose" class for keys
//      that don't exist yet, which an allowlist of domains cannot do.
//
// The same rules run on read, so a value stored before these checks existed
// stops being served rather than lingering until something overwrites it.
//
// On read the rules are applied PER ENTRY. Several preferences hold a
// collection — installed-app metadata, an icon grid, a list of open windows —
// where each member is independent of the others. A member that does not pass
// costs only itself; the rest of the collection is still served.
//
// The doors do not all answer a bad value the same way, on purpose:
//
//   - The user door (POST /setup-api/preferences) REJECTS the request, so a
//     caller that sent an impossible name or value learns that. A name the
//     door does not own at all — one without a preference prefix — is skipped
//     instead: the caller was not asking it to store that.
//   - The machine doors — app install/uninstall, the webapp registry — write
//     on someone else's behalf and have no one to report a 400 to. They COERCE
//     the label fields they control (`boundPreferenceText`) and DROP entries
//     that still do not pass (`setPreferences` in src/lib/preference-store.ts),
//     so a stray character in an app-store listing cannot fail an install.

export const PREFERENCE_LANGUAGES = [
  "en",
  "bg",
  "de",
  "es",
  "fr",
  "it",
  "ja",
  "nl",
  "sv",
  "zh",
] as const;
export type PreferenceLanguage = (typeof PREFERENCE_LANGUAGES)[number];

export const WALLPAPER_FITS = ["fill", "fit", "center"] as const;

/** Longest single string allowed anywhere inside a preference value. */
export const MAX_PREFERENCE_STRING_LENGTH = 4096;
/** Largest serialized preference value, so one key can't bloat config.json. */
export const MAX_PREFERENCE_SERIALIZED_LENGTH = 64 * 1024;
/** Nesting cap — also what stops a hand-built cyclic object from recursing. */
const MAX_PREFERENCE_DEPTH = 12;

// C0 controls plus DEL. Newlines are the interesting ones: a setting that
// spans lines can be read back as separate paragraphs of prose, which is
// exactly how a locale code turned into a heading followed by a sentence.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

// The same class, global, so it can be used with replace() rather than test().
// Built from the pattern above so the two cannot drift. String.replace resets a
// global pattern's lastIndex, so it is stateless there; .test on this object
// would not be — use CONTROL_CHARACTERS for that.
const CONTROL_CHARACTERS_GLOBAL = new RegExp(CONTROL_CHARACTERS.source, "g");

/** How a preference is spelled in the config store. */
export const PREFERENCE_KEY_PREFIX = "pref:";

/**
 * Longest a preference NAME may be, and the alphabet it may be spelled with.
 *
 * The names are not a closed set — most of them hold live desktop state and a
 * new one appears whenever the desktop grows a field, and one is assembled at
 * runtime (`app_<appId>_settings`, src/components/InstalledAppSettings.tsx) —
 * so the rule on a name is a shape, the way `checkShape` is the rule on a
 * value. 128 leaves room for that runtime name at its widest: `app_` plus a
 * 64-character app id (APP_ID_RE) plus `_settings`, and headroom after it.
 */
export const MAX_PREFERENCE_KEY_LENGTH = 128;

/** Names that exist on every object literal, whatever the store holds. */
const INHERITED_NAMES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** The alphabet APP_ID_RE already uses — every name this product writes is in it. */
const PREFERENCE_KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";

/**
 * A preference name rebuilt character by character out of that alphabet, or
 * null for a name that does not survive the rebuild.
 *
 * REBUILT rather than merely tested, the way project ids are (`safeProjectId`
 * in src/lib/code-projects.ts) and for the same reason: both doors onto a
 * preference put the name on an object — `result[key]` on the read side and
 * `entries["pref:" + key]`, which lands in config.json, on the write side —
 * and a `.test()` guard leaves the CALLER's own string in play at the sink.
 * What reaches the object is made of these characters and no more than this
 * many of them.
 *
 * Until this existed the only rule on a name was the route's PREFIX check, so
 * everything after `ui_` was free: any length, any character, stored as sent.
 * A caller with a session could park unbounded arbitrary names in the owner's
 * config.json, and static analysis rightly flagged both writes
 * (CodeQL js/remote-property-injection, alerts #300 and #301).
 */
export function safePreferenceKey(key: unknown): string | null {
  if (typeof key !== "string" || key.length < 1 || key.length > MAX_PREFERENCE_KEY_LENGTH) {
    return null;
  }
  // The three names that are a property of every object literal. They are
  // spelled entirely from the alphabet below, so the rebuild alone would hand
  // them back, and none of them is a preference this box stores. Refusing them
  // here is belt to the accumulators' braces — every one of them is
  // null-prototype — not a licence to drop that.
  if (INHERITED_NAMES.has(key)) return null;
  let safe = "";
  for (const ch of key) {
    const at = PREFERENCE_KEY_ALPHABET.indexOf(ch);
    if (at < 0) return null;
    safe += PREFERENCE_KEY_ALPHABET[at];
  }
  return safe;
}

// A Map rather than an object literal: lookup is by own entry only, so a key
// named after something on Object.prototype (`constructor`, `toString`) reads
// as "no domain" instead of resolving to a value that is not a list.
const CLOSED_DOMAINS = new Map<string, readonly string[]>([
  ["ui_language", PREFERENCE_LANGUAGES],
  ["wp_fit", WALLPAPER_FITS],
]);

export function isPreferenceLanguage(value: unknown): value is PreferenceLanguage {
  return typeof value === "string" && (PREFERENCE_LANGUAGES as readonly string[]).includes(value);
}

export interface PreferenceCheck {
  ok: boolean;
  /** Operator-facing reason, safe to return in a 400 body. */
  reason?: string;
}

/** Recursively bound the scalars inside a value. Returns a reason, or null. */
function checkShape(value: unknown, depth: number): string | null {
  if (depth > MAX_PREFERENCE_DEPTH) return "value is nested too deeply";

  if (typeof value === "string") {
    if (value.length > MAX_PREFERENCE_STRING_LENGTH) {
      return `contains a string longer than ${MAX_PREFERENCE_STRING_LENGTH} characters`;
    }
    if (CONTROL_CHARACTERS.test(value)) return "contains control characters";
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? null : "contains a non-finite number";
  }
  if (typeof value === "boolean" || value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const reason = checkShape(item, depth + 1);
      if (reason) return reason;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const keyReason = checkShape(k, depth + 1);
      if (keyReason) return keyReason;
      const valueReason = checkShape(v, depth + 1);
      if (valueReason) return valueReason;
    }
    return null;
  }
  return "is not JSON data";
}

/**
 * Is this a legal value for this preference key? Applied on write (so junk
 * cannot be stored) and on read (so junk stored earlier is not served).
 */
export function validatePreference(key: string, value: unknown): PreferenceCheck {
  // The name first: a value cannot rescue a name this box does not store, and
  // every rule below is keyed by the name.
  //
  // Neither caller surfaces this particular reason today — the route checks the
  // name itself and answers its own 400, and `sanitizePreferenceValue` discards
  // the reason — so this branch is here for the next caller of the module's
  // "is this legal" answer rather than for a message anyone reads. It still
  // does not quote the name back: the day something does surface it, the name
  // will be caller-supplied and the message both returned and logged.
  if (safePreferenceKey(key) === null) {
    return { ok: false, reason: "is not a preference name this box stores" };
  }

  const domain = CLOSED_DOMAINS.get(key);
  if (domain) {
    if (typeof value === "string" && domain.includes(value)) return { ok: true };
    return { ok: false, reason: `${key} must be one of: ${domain.join(", ")}` };
  }

  const shapeReason = checkShape(value, 0);
  if (shapeReason) return { ok: false, reason: `${key} ${shapeReason}` };

  let serialized: string;
  try {
    serialized = JSON.stringify(value ?? null) ?? "null";
  } catch {
    return { ok: false, reason: `${key} is not serializable` };
  }
  if (serialized.length > MAX_PREFERENCE_SERIALIZED_LENGTH) {
    return { ok: false, reason: `${key} is larger than ${MAX_PREFERENCE_SERIALIZED_LENGTH} characters` };
  }
  return { ok: true };
}

/**
 * Rebuild a collection from the members that pass on their own, or return
 * undefined for a value that has no members to sort through.
 *
 * Members sit one level below the value itself, which is the depth `checkShape`
 * reaches them at when it walks the value whole — so they are checked at that
 * same depth here and the two agree on what passes.
 */
function keepPassingMembers(
  value: unknown,
): Record<string, unknown> | unknown[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((item) => checkShape(item, 1) === null);
  }
  if (value !== null && typeof value === "object") {
    // Null-prototype accumulator: the names come from stored data, so an
    // assignment here must define an own property and never reach an inherited
    // one such as `__proto__`.
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (checkShape(k, 1) === null && checkShape(v, 1) === null) out[k] = v;
    }
    return out;
  }
  return undefined;
}

/** The storable form of one preference value, or nothing. */
export type PreferenceOutcome = { ok: true; value: unknown } | { ok: false };

/**
 * Reduce one preference to what may be stored and served.
 *
 * A value that passes whole is kept whole. A collection that does not is
 * rebuilt from the members that pass on their own, so one unusable member
 * costs only itself and the rest of the collection survives. The rebuilt
 * collection is then checked again as a whole, so the caps that apply to the
 * key still hold for what comes back.
 *
 * A scalar has no members to keep part of, and neither does a key with a closed
 * domain: those are kept whole or not at all. Returning nothing (rather than
 * substituting a default) keeps the answer honest — the key reads as absent,
 * which every consumer already handles, instead of claiming a value the store
 * does not hold.
 */
export function sanitizePreferenceValue(key: string, value: unknown): PreferenceOutcome {
  if (validatePreference(key, value).ok) return { ok: true, value };
  // A name that does not pass has nothing to keep part of: pruning members
  // changes the value, never the name. Asked AFTER the whole-value check, not
  // before it, so the path every stored preference takes on a desktop mount
  // (`all=1`, every key passing) rebuilds the name once rather than twice.
  if (safePreferenceKey(key) === null) return { ok: false };

  const pruned = keepPassingMembers(value);
  if (pruned === undefined) return { ok: false };
  // A prune that dropped nothing cannot change the verdict, so don't pay for a
  // second walk to reach the answer the first one already gave. This is the
  // case where the value failed on a whole-value cap rather than on a member.
  if (memberCount(pruned) === memberCount(value)) return { ok: false };
  return validatePreference(key, pruned).ok ? { ok: true, value: pruned } : { ok: false };
}

/** How many members a collection holds. */
function memberCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  return Object.keys(value as Record<string, unknown>).length;
}

/**
 * Apply the rules to a whole set of entries. Used on the read path so a value
 * written before validation existed cannot reach a caller — most importantly
 * the agent, via the `preferences_get` tool.
 */
export function sanitizePreferences(entries: Record<string, unknown>): Record<string, unknown> {
  // Null-prototype accumulator: `key` comes from the caller's entries, so the
  // assignment below should always define an own property. This is the object
  // that actually reaches the response, so the rule has to hold here.
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue;
    const kept = sanitizePreferenceValue(key, value);
    if (kept.ok) out[key] = kept.value;
  }
  return out;
}

/**
 * Reduce a set of `pref:*` config-store updates to what may be stored.
 *
 * For the writers that reach the config store directly instead of going through
 * POST /setup-api/preferences. Those writes have to meet the same rules, and
 * they usually carry entries they just read back — so anything already stored
 * that no longer passes is dropped here rather than written out again.
 */
export function sanitizePreferenceWrites(
  updates: Record<string, unknown>,
): Record<string, unknown> {
  // Null-prototype accumulator, like every other one in this module. It matters
  // on the pass-through branch below, which is the only assignment here that
  // `safePreferenceKey` does not stand in front of: a config key literally
  // named `__proto__` would otherwise set this object's prototype instead of
  // defining an own property, `Object.keys` would read it as empty, and
  // `setPreferences` would return without writing — a silently dropped write.
  // No caller can send that name today; all three build `updates` from string
  // literals.
  const out: Record<string, unknown> = Object.create(null);
  for (const [storeKey, value] of Object.entries(updates)) {
    // Only `pref:*` keys are preferences. The config store holds other things
    // in the same namespace — tokens, setup flags, updater state — and the
    // rules below would be wrong for those, so they pass through untouched.
    if (!storeKey.startsWith(PREFERENCE_KEY_PREFIX)) {
      out[storeKey] = value;
      continue;
    }
    const kept = sanitizePreferenceValue(storeKey.slice(PREFERENCE_KEY_PREFIX.length), value);
    if (kept.ok) out[storeKey] = kept.value;
  }
  return out;
}

/**
 * Reduce a caller-supplied label to what a preference may hold: one line, no
 * longer than a stored string is allowed to be. Anything that is not a string,
 * or that this leaves empty, becomes `fallback`.
 */
export function boundPreferenceText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const bounded = value
    .replace(CONTROL_CHARACTERS_GLOBAL, " ")
    .trim()
    .slice(0, MAX_PREFERENCE_STRING_LENGTH);
  return bounded || fallback;
}
