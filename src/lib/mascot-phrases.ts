// ── Mascot phrase contract ──
//
// The shape of a phrase set, plus the validation that keeps every rendered
// speech bubble in the user's own language.
//
// The phrases themselves live in `mascot-packs/<locale>.ts` — one
// hand-written pack per locale. This file used to hold a single English array
// (`INSPIRATION_PHRASES`) that every locale fell back to, which is how English
// boxes ended up greeting their owners in Bulgarian. There is no cross-locale
// fallback any more: a category that cannot be filled from the locale's own
// pack is filled from the language-free `neutral` pack.

import { isPhraseCompatible, englishStopwordRatio, isNonEnglishLatinLocale } from "./mascot-language";
import { neutral } from "./mascot-packs/neutral";

export interface MascotPhraseSet {
  sass: string[];
  idle: string[];
  sleep: string[];
  jump: string[];
  dance: string[];
  facepalm: string[];
  /** Each entry must contain the literal `{name}` token. */
  nameGreetings: string[];
  /** Single-word friendly placeholders used when `ui_user_name` is unset. */
  nameFallbacks: string[];
  /** Shouted while the crab perches on top of the box in power stance. */
  power: string[];
}

/**
 * The categories every pack must define. Written out rather than derived from
 * a sample object: this list IS the contract the pack authors code against.
 */
export const PHRASE_CATEGORIES = [
  "sass",
  "idle",
  "sleep",
  "jump",
  "dance",
  "facepalm",
  "nameGreetings",
  "nameFallbacks",
  "power",
] as const satisfies readonly (keyof MascotPhraseSet)[];

export type PhraseCategory = (typeof PHRASE_CATEGORIES)[number];

/** A speech bubble is small. Anything longer is clipped on a phone. */
export const MAX_PHRASE_LENGTH = 60;

/** A generated category is only kept if this many entries survive validation. */
export const MIN_SURVIVORS_PER_CATEGORY = 4;

/** A generated batch is only kept if this many categories survive. */
export const MIN_SURVIVING_CATEGORIES = 3;

/**
 * Above this share of English function words, a batch generated for a
 * non-English Latin-script locale is treated as "the model answered in
 * English" and thrown away.
 */
export const MAX_ENGLISH_STOPWORD_RATIO = 0.35;

export const LANG_NAMES: Record<string, string> = {
  en: "English",
  bg: "Български",
  de: "Deutsch",
  es: "Español",
  fr: "Français",
  it: "Italiano",
  ja: "日本語",
  nl: "Nederlands",
  sv: "Svenska",
  zh: "中文",
};

/**
 * Is this single entry renderable, for this category, in this locale?
 *
 * `phrase` is a TEMPLATE — `{name}` has not been substituted yet, and must
 * not be: the user's name may legitimately be in another script.
 */
export function isValidPhrase(phrase: unknown, category: PhraseCategory, locale: string): phrase is string {
  if (typeof phrase !== "string") return false;
  const trimmed = phrase.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PHRASE_LENGTH) return false;
  if (category === "nameGreetings" && !trimmed.includes("{name}")) return false;
  if (category === "nameFallbacks" && /\s/.test(trimmed)) return false;
  // The only placeholder the renderer substitutes is `{name}`, and only in
  // nameGreetings. Any other `{...}` token — `{user}`, a stray `{name}` in a
  // non-greeting category — would reach the bubble as literal braces, so a
  // generated phrase carrying one is rejected. Removing the allowed token
  // first lets a legitimate greeting through.
  const withoutName = category === "nameGreetings" ? trimmed.replace(/\{name\}/g, "") : trimmed;
  if (/[{}]/.test(withoutName)) return false;
  return isPhraseCompatible(trimmed, locale);
}

/** Trim, validate and de-duplicate one category. Order is preserved. */
export function sanitizeCategory(
  entries: unknown,
  category: PhraseCategory,
  locale: string,
): string[] {
  if (!Array.isArray(entries)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    if (!isValidPhrase(entry, category, locale)) continue;
    const trimmed = entry.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export interface BatchValidation {
  /** Only the categories that passed — the rest are the pack's job. */
  categories: Partial<MascotPhraseSet>;
  /** False when the batch is too thin/wrong to be worth persisting. */
  ok: boolean;
  /** Machine-readable reason when `ok` is false. */
  reason?: "too-few-categories" | "wrong-language";
  /** How many incoming entries were thrown away. */
  dropped: number;
}

/**
 * Gate a freshly generated batch before it is written to the cache.
 *
 * A category needs MIN_SURVIVORS_PER_CATEGORY survivors to be kept at all —
 * a category with two usable lines makes the crab repeat itself, and topping
 * it up from the pack is strictly better. A batch needs
 * MIN_SURVIVING_CATEGORIES kept categories to be persisted at all.
 *
 * `stopwordProbe` catches the failure the script check structurally cannot:
 * a model asked for German that answered in English.
 */
export function validateBatch(
  set: Partial<MascotPhraseSet> | null | undefined,
  locale: string,
  options: { stopwordProbe?: boolean } = {},
): BatchValidation {
  const categories: Partial<MascotPhraseSet> = {};
  let dropped = 0;
  let kept = 0;
  const survivors: string[] = [];

  for (const category of PHRASE_CATEGORIES) {
    const incoming = set?.[category];
    const incomingCount = Array.isArray(incoming) ? incoming.length : 0;
    const clean = sanitizeCategory(incoming, category, locale);
    if (clean.length >= MIN_SURVIVORS_PER_CATEGORY) {
      categories[category] = clean;
      kept += 1;
      survivors.push(...clean);
      dropped += incomingCount - clean.length;
    } else {
      dropped += incomingCount;
    }
  }

  if (kept < MIN_SURVIVING_CATEGORIES) {
    return { categories: {}, ok: false, reason: "too-few-categories", dropped };
  }

  if (options.stopwordProbe !== false && isNonEnglishLatinLocale(locale)) {
    if (englishStopwordRatio(survivors) > MAX_ENGLISH_STOPWORD_RATIO) {
      return { categories: {}, ok: false, reason: "wrong-language", dropped };
    }
  }

  return { categories, ok: true, dropped };
}

/**
 * Validate `set` against `locale` and UNION it with `pack` — falling back to
 * the neutral pack for any category neither can supply.
 *
 * Union, not replace. A full regen used to substitute its output for the pack
 * entirely, which SHRANK the crab's repertoire: a measured English box went
 * from 102 hand-written lines to 72 generated ones, of which ~53 were near-
 * copies of the pack lines the prompt had shown the model as a tone reference.
 * Generation is meant to add variety on top of the pack, not trade it away.
 * Generated lines come first so they are not buried, and the cap on how many
 * are ever cached lives in `mascot-phrases-server.ts`.
 *
 * The result is always complete (INV-3: no empty category, ever) and always
 * locale-correct (INV-1/INV-2: nothing renderable in the wrong script).
 * Arrays are copies, so callers may shuffle or push without corrupting the
 * module-level packs.
 */
export function mergeWithPackSync(
  set: Partial<MascotPhraseSet> | null | undefined,
  pack: MascotPhraseSet,
  locale: string,
): MascotPhraseSet {
  const merged = {} as MascotPhraseSet;
  for (const category of PHRASE_CATEGORIES) {
    // The pack is hand-written, but it is still data: run it through the same
    // gate as generated entries so a bad pack entry cannot reach a bubble.
    const incoming = sanitizeCategory(set?.[category], category, locale);
    const fromPack = sanitizeCategory(pack[category], category, locale);
    const combined = dedupe([...incoming, ...fromPack]);
    merged[category] = combined.length > 0
      ? combined
      : sanitizeCategory(neutral[category], category, locale);
  }
  return merged;
}

/** First occurrence wins, order preserved. */
function dedupe(entries: string[]): string[] {
  return [...new Set(entries)];
}
