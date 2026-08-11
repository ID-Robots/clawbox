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

const CLOSED_DOMAINS: Record<string, readonly string[]> = {
  ui_language: PREFERENCE_LANGUAGES,
  wp_fit: WALLPAPER_FITS,
};

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
  const domain = CLOSED_DOMAINS[key];
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
 * Drop every entry that would not be accepted on write. Used on the read path
 * so a value written before validation existed cannot reach a caller — most
 * importantly the agent, via the `preferences_get` tool.
 *
 * Dropping (rather than substituting a default) keeps the response honest: the
 * key reads as absent, which every consumer already handles, instead of
 * claiming a value the store does not hold.
 */
export function sanitizePreferences(entries: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue;
    if (validatePreference(key, value).ok) out[key] = value;
  }
  return out;
}
