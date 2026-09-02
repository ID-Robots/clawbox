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
  /** Shouted while the crab strikes its power stance. */
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

/**
 * A category is only kept if this many entries survive validation.
 *
 * One. This was four, from the era when a generated set REPLACED the pack: a
 * category with two lines made the crab repeat itself, so topping it up from
 * the pack was strictly better. Neither half of that is true any more —
 * `mergeWithPackSync` UNIONS the generated lines with the pack, so every
 * category the crab renders is pack-sized whatever generation contributed,
 * and `stripEchoes` now removes the pack copies before this count is taken,
 * so the number being compared is "NEW lines", not "lines".
 *
 * Four NEW lines per category is a bar the on-device model does not clear: a
 * measured English run on the reference box came back ~76% echo, leaving 1-16
 * new lines spread across nine categories, and demanding four of them in each
 * of three categories turned every real run into an error message. One new
 * line in a category is a real addition to the repertoire — it is exactly
 * what the owner sees when the crab says something it has never said before.
 * Zero is still zero, and still fails: that is `MIN_SURVIVING_CATEGORIES`
 * below doing its job.
 */
export const MIN_SURVIVORS_PER_CATEGORY = 1;

/**
 * A batch is only kept if this many categories survive.
 *
 * With the per-category bar at one, this is what stops a worthless run
 * passing: a batch that echoed the pack everywhere contributes zero
 * categories and is rejected. It is also a structural sanity check — the JSON
 * grammar makes a healthy run emit all nine categories, so a batch that lands
 * new lines in fewer than three of them is a truncated or malformed answer
 * rather than a thin one.
 */
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

/**
 * Fold a phrase to the form two entries are compared by when deciding whether
 * one is an echo of the other. Deliberately looser than the exact-string
 * dedupe `mergeWithPackSync` does, because "Bug? Feature." and "bug? feature."
 * are the same line as far as the crab's repertoire is concerned.
 *
 * Emoji and trailing punctuation come off too, because the decorated echo is
 * what the model actually produces: a measured run returned "I do all the work
 * here. 🙄", "Ship faster, humans. 💨" and "I need a raise. 💸" against pack
 * lines identical but for the emoji. Counting those as new lines is the same
 * untruth this module exists to stop telling, one notch finer — and keeping
 * both variants in the bag is exactly how the crab ends up saying the same
 * thing twice in a row.
 *
 * A line that is NOTHING but emoji (the idle pack is full of them) folds to
 * the empty string, which would make every such line an echo of every other.
 * Those fall back to the plain fold, so "🤔" and "😴" stay different lines.
 */
function echoKey(phrase: string): string {
  const folded = phrase.trim().toLowerCase().replace(/\s+/g, " ");
  const bare = folded
    // Variation selector-16 and ZWJ are written as escapes on purpose: both
    // are invisible in a source file, so a literal one is impossible to spot.
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D]/gu, "")
    .replace(/[.!?,;\u2026"'*]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return bare === "" ? folded : bare;
}

/**
 * Drop every generated entry the crab can already say.
 *
 * The prompt shows the model the locale's pack as a TONE REFERENCE, and the
 * model copies it: a measured English run came back 76% echo. Those echoes
 * used to count towards MIN_SURVIVORS_PER_CATEGORY, so a batch that added
 * almost nothing passed the gate, was cached, and was then deduped away again
 * by `mergeWithPackSync` on the way to the bubble — a whole 180-second model
 * run spent to store lines the pack already had.
 *
 * Stripping them here, BEFORE the survivor count, makes that count mean what
 * it says: how many NEW lines this run produced. A run that is nothing but
 * echo fails validation instead of masquerading as a success, which is the
 * honest outcome.
 *
 * `known` is variadic because "already said" has two sources, and using only
 * the first was a half-truth: the pack, and — in top-up mode — the lines a
 * previous run already put in the cache envelope. A line the model produced
 * again yesterday is not new either, and counting it as new would put the
 * survivor gate back to measuring something other than what it claims.
 *
 * Nothing is lost by dropping them — the pack and the envelope both supply
 * their own lines on every read anyway.
 */
export function stripEchoes(
  set: Partial<MascotPhraseSet> | null | undefined,
  ...known: Array<Partial<MascotPhraseSet> | null | undefined>
): Partial<MascotPhraseSet> {
  const out: Partial<MascotPhraseSet> = {};
  for (const category of PHRASE_CATEGORIES) {
    const incoming = set?.[category];
    if (!Array.isArray(incoming)) continue;
    const packKeys = new Set(
      known
        .flatMap((source) => {
          const entries = source?.[category];
          return Array.isArray(entries) ? entries : [];
        })
        .filter((entry): entry is string => typeof entry === "string")
        .map(echoKey),
    );
    // Non-strings are passed through untouched so `validateBatch` stays the
    // single place that decides what a usable phrase is — and keeps counting
    // them as dropped.
    out[category] = incoming.filter((entry) => typeof entry !== "string" || !packKeys.has(echoKey(entry)));
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
 * A category needs MIN_SURVIVORS_PER_CATEGORY survivors to be kept, and a
 * batch needs MIN_SURVIVING_CATEGORIES kept categories to be persisted at
 * all. Callers that have already run the entries through `stripEchoes` are
 * therefore counting NEW lines, which is the only count worth gating on: see
 * both constants for why the per-category bar is one rather than four.
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
