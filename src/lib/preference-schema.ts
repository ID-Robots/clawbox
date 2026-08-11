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
// costs only itself; the rest of the collection is still served. Anything that
// writes straight to the config store rather than through
// POST /setup-api/preferences applies the same rules with
// `sanitizePreferenceWrites`, so every door agrees on what may be stored.

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

const CLOSED_DOMAINS: Record<string, readonly string[]> = {
  ui_language: PREFERENCE_LANGUAGES,
  wp_fit: WALLPAPER_FITS,
};

/**
 * The domain for a key, if it has one. Own properties only: the table is a
 * plain object literal, so a name such as `constructor` would otherwise resolve
 * to an inherited value that is not a list of legal strings.
 */
function closedDomainFor(key: string): readonly string[] | undefined {
  return Object.prototype.hasOwnProperty.call(CLOSED_DOMAINS, key)
    ? CLOSED_DOMAINS[key]
    : undefined;
}

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
  const domain = closedDomainFor(key);
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
function keepPassingMembers(value: unknown): unknown | undefined {
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
  if (closedDomainFor(key)) return { ok: false };

  const pruned = keepPassingMembers(value);
  if (pruned === undefined) return { ok: false };
  return validatePreference(key, pruned).ok ? { ok: true, value: pruned } : { ok: false };
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
  const out: Record<string, unknown> = {};
  for (const [storeKey, value] of Object.entries(updates)) {
    const key = storeKey.startsWith(PREFERENCE_KEY_PREFIX)
      ? storeKey.slice(PREFERENCE_KEY_PREFIX.length)
      : storeKey;
    const kept = sanitizePreferenceValue(key, value);
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
