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
 * The frenzy lines to cycle through for `locale`.
 *
 * `locale` may be empty while the UI has not resolved its language yet — that
 * matches nothing and falls through to `fallback`, which the caller seeds from
 * the (language-free) neutral pack until it knows better.
 */
export function frenzyQuotesFor(
  locale: string,
  fallback: MascotPhraseSet,
  neutralFallback: MascotPhraseSet,
): readonly string[] {
  const quotes = FRENZY_QUOTES[locale];
  if (quotes && quotes.length > 0) return quotes;
  if (fallback.power.length > 0) return fallback.power;
  return neutralFallback.power;
}
