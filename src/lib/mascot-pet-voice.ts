// ── What a pet says ──
//
// Pets talk exactly like the crab does: same ten locale packs, same generated
// lines, same language gate. That is the whole point — the personality is
// ClawBox's, the body is Hermes'.
//
// What a pet must NOT do is speak as a crab. An earlier version of this file
// filtered only `power`, on the belief that the crab-literal strings were
// confined to the shout from on top of the box. They are not: eighty-odd
// entries across eight of the nine categories and all ten locales are
// crab-literal — "My claws are unionised." (sass), "Parkour, version crabe."
// (fr jump), "🦀 shuffle time" (dance), "yo {name} 🦀" (nameGreetings), and
// every emoji-only 🦀 line in the language-free neutral pack. A penguin saying
// any of them reads as a bug.
//
// The fix is structural rather than a filter per category:
//
//   * every pack tags its own crab-literal entries (`<locale>Crab`), so the
//     subtraction is exact and reviewable next to the lines themselves;
//   * `mascot-pet-voice.test.ts` re-derives those tags from a crab lexicon
//     (🦀 plus each locale's crab/claw words) and fails when they disagree, so
//     a new joke cannot quietly slip through untagged;
//   * the same lexicon runs at RUNTIME over everything served, which is what
//     covers the lines nobody hand-wrote: the on-device generator is prompted
//     for "a sarcastic crab mascot", so its output can be crab-literal too and
//     there is nothing to tag it in advance.
//
// A category that empties out is refilled from the language-free neutral pack
// (minus its own crab lines) rather than left blank — an empty category makes
// `say()` bail every time it is picked, which is a mute mascot, not a safe one.
//
// Explicitly NOT done: per-species voices. Thirteen pets x nine categories x
// ten locales is 1170 strings, all of which the parity test would then demand.

import { NEUTRAL_CRAB_LINES, NEUTRAL_PACK, crabLinesFor, crabLinesForSync } from "@/lib/mascot-packs";
import { PHRASE_CATEGORIES, type MascotPhraseSet } from "@/lib/mascot-phrases";

/**
 * Crab words, per locale, plus the emoji that needs no translation.
 *
 * The runtime net for untagged strings (generated lines, and anything a pack
 * author forgets). Deliberately blunt: a false positive costs one dropped
 * phrase out of eight, a false negative is a penguin calling itself a crab.
 *
 * `neutral` has no entry because it has no words — the emoji test covers it.
 */
export const CRAB_LEXICON: Readonly<Record<string, RegExp>> = {
  en: /claw|crab/iu,
  bg: /рак|щипк|щипц/iu,
  de: /krabbe|schere/iu,
  es: /cangrej|pinza/iu,
  fr: /crabe|pince/iu,
  it: /granchio|chel[ae]/iu,
  ja: /カニ|蟹|ハサミ|はさみ/u,
  nl: /krab|schaar|scharen/iu,
  sv: /krabba|klor|klo\b/iu,
  zh: /螃蟹|蟹|钳/u,
};

const CRAB_EMOJI = /🦀/u;

/** Does this single line read as crab-literal in `locale`? */
export function isCrabLine(line: string, locale: string): boolean {
  if (CRAB_EMOJI.test(line)) return true;
  const lexicon = Object.prototype.hasOwnProperty.call(CRAB_LEXICON, locale)
    ? CRAB_LEXICON[locale]
    : undefined;
  return lexicon ? lexicon.test(line) : false;
}

function keep(lines: readonly string[], tagged: ReadonlySet<string>, locale: string): string[] {
  return lines.filter((line) => !tagged.has(line) && !isCrabLine(line, locale));
}

/**
 * The neutral pack a pet may draw on: language-free AND crab-free, so it is
 * the refill source for any locale and any category.
 */
export const PET_NEUTRAL_PACK: MascotPhraseSet = (() => {
  const tagged = new Set(NEUTRAL_CRAB_LINES);
  const out = {} as MascotPhraseSet;
  for (const category of PHRASE_CATEGORIES) {
    const kept = keep(NEUTRAL_PACK[category], tagged, "neutral");
    // Every neutral category survives its own crab lines today (the thinnest,
    // `sleep`, keeps five of six). Falling back to the raw list would put a
    // 🦀 back in a pet's mouth, so an empty one stays empty and the caller's
    // category simply keeps whatever it already had.
    out[category] = kept;
  }
  return out;
})();

/**
 * The `power` lines a pet may shout. Kept as its own export because the mascot
 * picks power-stance lines outside the normal phrase path.
 */
export const PET_POWER_LINES: readonly string[] = PET_NEUTRAL_PACK.power;

/**
 * `set` as a pet may speak it: crab-literal entries removed in every category,
 * and any category emptied by that refilled from the neutral pack.
 *
 * Pure and synchronous — `crabLines` is passed in so the client can use the
 * already-loaded pack and the server can await its own.
 */
export function petSafeWithTags(
  set: MascotPhraseSet,
  locale: string,
  crabLines: readonly string[],
): MascotPhraseSet {
  const tagged = new Set(crabLines);
  const out = {} as MascotPhraseSet;
  for (const category of PHRASE_CATEGORIES) {
    const kept = keep(set[category] ?? [], tagged, locale);
    const refill = PET_NEUTRAL_PACK[category];
    out[category] = kept.length > 0 ? kept : [...refill];
  }
  return out;
}

/** Server/async form: resolves the locale's crab tags itself. */
export async function petSafePhrases(
  set: MascotPhraseSet,
  locale: string,
): Promise<MascotPhraseSet> {
  return petSafeWithTags(set, locale, await crabLinesFor(locale));
}

/** Client/sync form, for render paths that cannot await. */
export function petSafePhrasesSync(set: MascotPhraseSet, locale: string): MascotPhraseSet {
  return petSafeWithTags(set, locale, crabLinesForSync(locale));
}
