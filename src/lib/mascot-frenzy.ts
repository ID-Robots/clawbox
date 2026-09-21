// ── Frenzy easter egg quotes ──
//
// A hardcoded celebration set for the `clawbox-new-order` event. It only
// exists in the two languages somebody actually wrote it in, so it is keyed BY
// LANGUAGE, not by script.
//
// The previous version filtered one flat array with `isPhraseCompatible`,
// which is a script test: de, es, fr, it, nl and sv are Latin-script, so every
// English line passed and a Swedish box shouted "SHOW ME THE MONEY!". Script
// compatibility says a string *can be read* in a locale, never that it is *in*
// that locale — the two are only the same thing for Cyrillic vs Latin.
//
// A locale without an entry here uses its own pack's `power` lines instead.

import type { MascotPhraseSet } from "./mascot-phrases";
import { isCrabLine } from "./mascot-pet-voice";

export const FRENZY_QUOTES: Readonly<Record<string, readonly string[]>> = {
  en: [
    "💰💰💰 MONEY RAIN!!!",
    "🤑 SHOW ME THE MONEY!",
    "🎰 JACKPOT BABY!!!",
    "🔥🔥🔥 ON FIRE!!!",
    "💰 CHING CHING CHING!",
    "🦀💸 CRAB GOT PAID!",
    "🚀 REVENUE GO BRRR!!!",
    "💎 DIAMOND CLAWS!",
    "💰 €549 IN THE BAG!",
    "💸 MAKE IT RAIN!",
    "🏆 UNSTOPPABLE!!!",
    "🦀 CRAB GOES BRRRRRR!!!",
    "🔥 SOMEBODY STOP ME!!!",
    "🚀 TO THE MOOOOON!!!",
    "🤑 ANOTHER ONE! DJ KHALED!",
    "💸 CTRL+P money.exe!!!",
    "🦀💰 CRAB MANSION INCOMING!",
    "🏆 MVP! MVP! MVP!",
    "💰 STONKS ONLY GO UP!!!",
  ],
  bg: [
    "💸 ПАРИ ПАРИ ПАРИ!!!",
    "🤑 НОВА ПОРЪЧКА БЕЕЕЕ!",
    "🎉 КОЙ Е ШЕФЪТ?! АЗ!",
    "🐯 ООО ТИГРЕ ТИГРЕ ИМАШ ЛИ ПАРИ!",
    "💸 БЕРЕМ ПАРИТЕ С ЛОПАТА!!!",
    "🤑 КЕШЪТ ТЕЧЕ КАТО РЕКА!",
    "💰 ПАРИ НА ВОЛЯ!!! СВОБОДА!!!",
    "🔥 ОГЪН!!! ЧИЛ!!! ПАРИ!!!",
    "🏆 МВП! МВП! МВП!",
    // These three used to mix Latin words into Cyrillic lines ("BUILT
    // DIFFERENT", "EASY", "SPACEX"), which `classifyScript` calls "mixed" —
    // rejected in every locale, Bulgarian included. They never once reached a
    // bubble; rewritten so they can.
    "💎 НИЕ СМЕ ДРУГА КЛАСА!",
    "🤑 ПЕНСИЯ НА 30! ФАСУЛ!",
    "🚀 И КОСМОСЪТ ДА СЕ УЧИ ОТ НАС!",
  ],
};

/**
 * The crab-literal frenzy lines.
 *
 * Frenzy is not one of the nine phrase categories, so it is not reached by the
 * pack-level crab tags — but it is still the mascot talking, and a penguin
 * shouting "CRAB GOT PAID!" is the same bug. Tagged the same way the packs are,
 * and cross-checked against the crab lexicon by `mascot-pet-voice.test.ts`.
 */
export const FRENZY_CRAB_LINES: readonly string[] = [
  "🦀💸 CRAB GOT PAID!",
  "💎 DIAMOND CLAWS!",
  "🦀 CRAB GOES BRRRRRR!!!",
  "🦀💰 CRAB MANSION INCOMING!",
];

/**
 * The frenzy lines to cycle through for `locale`.
 *
 * `locale` may be empty while the UI has not resolved its language yet — that
 * matches nothing and falls through to `fallback`, which the caller seeds from
 * the (language-free) neutral pack until it knows better.
 *
 * `petVoice` drops the crab-literal entries. The remaining fifteen English
 * lines are about money, not crustaceans, so a pet still gets a full set
 * rather than being pushed onto the neutral `power` floor.
 */
export function frenzyQuotesFor(
  locale: string,
  fallback: MascotPhraseSet,
  neutralFallback: MascotPhraseSet,
  petVoice = false,
): readonly string[] {
  const quotes = FRENZY_QUOTES[locale];
  if (quotes && quotes.length > 0) {
    const kept = petVoice
      ? quotes.filter((line) => !FRENZY_CRAB_LINES.includes(line) && !isCrabLine(line, locale))
      : quotes;
    if (kept.length > 0) return kept;
  }
  if (fallback.power.length > 0) return fallback.power;
  return neutralFallback.power;
}
