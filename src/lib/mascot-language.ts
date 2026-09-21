// ── Mascot phrase language validation ──
//
// Pure, dependency-free helpers that answer ONE question: "can this speech
// bubble string legitimately be shown to a user whose UI is in locale X?".
//
// Why this exists: the mascot used to ship a single English phrase bag that
// contained a Bulgarian greeting and a Portuguese nickname, so an English box
// greeted its owner with "Здрасти, {name}! 🇧🇬". Anything the mascot renders —
// packs, cached generations, hardcoded easter eggs — now passes through
// `isPhraseCompatible` first.
//
// The check is SCRIPT-based, not language-based: it can tell Cyrillic from
// Latin from Han from kana, which catches every cross-script leak. Two
// languages that share a script (English text inside the German pack) are not
// detectable here — that is what the batch-level stopword probe is for.
//
// Deliberately importable from both server and client code: no I/O, no Next,
// no React, no other project module.

/**
 * Bumped whenever the rules below change in a way that could re-classify an
 * already-cached phrase. Cache envelopes store the version they were written
 * with; a mismatch forces a re-filter on read instead of trusting old data.
 */
export const VALIDATOR_VERSION = 2;

/** Result of bucketing the letters left in a string after stripping noise. */
export type ScriptBucket =
  /** Nothing but emoji / punctuation / digits / whitespace — safe anywhere. */
  | "neutral"
  | "latin"
  | "cyrillic"
  | "han"
  | "kana"
  /** Kana + Han together — normal written Japanese, not a mix-up. */
  | "japanese"
  /** Letters from a script the device does not ship a locale for. */
  | "other"
  /** Two or more incompatible scripts in one string. */
  | "mixed";

/**
 * Which script buckets a phrase may use for each UI locale. A locale missing
 * from this map rejects every non-neutral phrase (fail closed).
 */
export const LOCALE_SCRIPTS: Readonly<Record<string, readonly ScriptBucket[]>> = {
  en: ["latin"],
  bg: ["cyrillic"],
  de: ["latin"],
  es: ["latin"],
  fr: ["latin"],
  it: ["latin"],
  // Japanese mixes kana and kanji freely; a kanji-only line is valid Japanese.
  ja: ["kana", "han", "japanese"],
  nl: ["latin"],
  sv: ["latin"],
  zh: ["han"],
};

/**
 * English technical terms that stay English in every locale — the crab says
 * "деплой-ът гръмна, bug 🐛" and that is correct Bulgarian usage, not a leak.
 * Matched case-insensitively on word boundaries and removed before the script
 * of the remaining text is judged.
 *
 * Keep this list SHORT and unambiguous: every entry here is a hole in the
 * cross-script check, and an entry that is also a common word in another
 * language (e.g. "die", "was") would punch a much bigger hole than it is
 * worth.
 */
export const TECH_ALLOWLIST: readonly string[] = [
  "ai",
  "api",
  "bug",
  "build",
  "clawbox",
  "cli",
  "commit",
  "cpu",
  "debug",
  "deploy",
  "docker",
  "git",
  "gpu",
  "http",
  "json",
  "linux",
  "merge",
  "npm",
  "pr",
  "push",
  "ram",
  "ssh",
  "sudo",
  "usb",
  "wifi",
  "wi-fi",
  "404",
  "500",
];

/**
 * English function words that almost never appear in the other Latin-script
 * locales the device ships (de/es/fr/it/nl/sv). Used only as a batch-level
 * probe: a generated German batch where a third of the lines contain "the",
 * "you" or "just" is English that slipped past the script check.
 *
 * Every entry was checked against the other six languages — words like "in",
 * "so", "man", "was", "die", "on", "a" are real words elsewhere and are
 * deliberately absent.
 */
export const ENGLISH_STOPWORDS: readonly string[] = [
  "about",
  "again",
  "always",
  "because",
  "every",
  "from",
  "gonna",
  "have",
  "just",
  "know",
  "let's",
  "make",
  "need",
  "never",
  "okay",
  "that",
  "the",
  "they",
  "this",
  "want",
  "what",
  "with",
  "yeah",
  "you",
  "your",
];

// Everything that carries no language: the {name} placeholder, emoji
// (Extended_Pictographic covers 🦀 💤 ⚡), flag sequences (regional indicators
// are NOT Extended_Pictographic, hence the separate class), emoji joiners and
// variation selectors, punctuation, symbols, digits and whitespace.
const NOISE_RE = new RegExp(
  [
    "\\{name\\}",
    "\\p{Extended_Pictographic}",
    "\\p{Regional_Indicator}",
    "[\\u200D\\uFE0E\\uFE0F]", // ZWJ + variation selectors
    "\\p{P}",
    "\\p{S}",
    "\\p{N}",
    "\\s",
  ].join("|"),
  "gu",
);

// Script tests use Script_Extensions, not Script: characters like the katakana
// prolonged sound mark ー (U+30FC) are Script=Common and would otherwise fall
// into "other" and make every Japanese phrase look "mixed".
const LATIN_RE = /\p{scx=Latin}/u;
const CYRILLIC_RE = /\p{scx=Cyrillic}/u;
const HAN_RE = /\p{scx=Han}/u;
const KANA_RE = /\p{scx=Hiragana}|\p{scx=Katakana}/u;

let techTermRe: RegExp | null = null;

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove allowlisted technical terms so an English word embedded in an
 * otherwise Bulgarian/Japanese phrase does not make it look "mixed".
 */
export function stripTechTerms(text: string): string {
  if (!techTermRe) {
    const alternatives = TECH_ALLOWLIST.map(escapeForRegExp).join("|");
    // \b works here even next to non-ASCII letters: \w is ASCII-only, so the
    // boundary between "й" and "b" in "Деплойни-bug" is a word boundary.
    techTermRe = new RegExp(`\\b(?:${alternatives})\\b`, "giu");
  }
  techTermRe.lastIndex = 0;
  return text.replace(techTermRe, " ");
}

/**
 * Bucket the letters of `text` by writing system.
 *
 * Noise (emoji, flags, punctuation, digits, the `{name}` token) is stripped
 * first, so "🦀 {name}! 🇧🇬" is `neutral` — a flag emoji is not a language.
 * Technical terms are NOT stripped here; use `isPhraseCompatible` (or
 * `stripTechTerms` first) when the allowlist should apply.
 */
export function classifyScript(text: string): ScriptBucket {
  if (typeof text !== "string" || text.length === 0) return "neutral";
  // Fold decomposed forms first (a base letter + a combining accent). Model
  // output can arrive as NFD, where the accent is its own code point that the
  // per-character script tests bucket as "other" — turning "Kapitän" into a
  // false "mixed". The hand-written packs are NFC, but generated text is not
  // guaranteed to be.
  const letters = text.normalize("NFC").replace(NOISE_RE, "");
  if (letters.length === 0) return "neutral";

  const buckets = new Set<ScriptBucket>();
  for (const ch of letters) {
    if (LATIN_RE.test(ch)) buckets.add("latin");
    else if (CYRILLIC_RE.test(ch)) buckets.add("cyrillic");
    else if (KANA_RE.test(ch)) buckets.add("kana");
    else if (HAN_RE.test(ch)) buckets.add("han");
    else buckets.add("other");
    // Three buckets already means "mixed" no matter what the third one is.
    if (buckets.size > 2) return "mixed";
  }

  if (buckets.size === 1) return [...buckets][0];
  if (buckets.has("kana") && buckets.has("han")) return "japanese";
  return "mixed";
}

/**
 * True when `phrase` may be rendered in a UI running `locale`.
 *
 * Call this on the TEMPLATE, before `{name}` is substituted: a Bulgarian user
 * name on an English box must not blank the bubble — the template is what has
 * to be English, not the name the owner typed.
 */
export function isPhraseCompatible(phrase: string, locale: string): boolean {
  if (typeof phrase !== "string") return false;
  const bucket = classifyScript(stripTechTerms(phrase));
  if (bucket === "neutral") return true;
  if (bucket === "mixed" || bucket === "other") return false;
  const allowed = LOCALE_SCRIPTS[locale];
  if (!allowed) return false; // unknown locale: fail closed
  return allowed.includes(bucket);
}

/** True for locales written in Latin script other than English. */
export function isNonEnglishLatinLocale(locale: string): boolean {
  return locale !== "en" && (LOCALE_SCRIPTS[locale] ?? []).includes("latin");
}

let stopwordRe: RegExp | null = null;

/**
 * Share of `phrases` that contain at least one English function word. Only
 * meaningful for Latin-script locales — the script check already covers the
 * rest.
 */
export function englishStopwordRatio(phrases: readonly string[]): number {
  if (phrases.length === 0) return 0;
  if (!stopwordRe) {
    const alternatives = ENGLISH_STOPWORDS.map(escapeForRegExp).join("|");
    stopwordRe = new RegExp(`\\b(?:${alternatives})\\b`, "iu");
  }
  let hits = 0;
  for (const phrase of phrases) {
    stopwordRe.lastIndex = 0;
    if (stopwordRe.test(phrase)) hits += 1;
  }
  return hits / phrases.length;
}
