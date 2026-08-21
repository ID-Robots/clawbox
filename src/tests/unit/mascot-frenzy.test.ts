// The frenzy easter egg is hardcoded, so it is the one place where phrases are
// not covered by the pack contract. It gets the same two guarantees anyway:
// every line is in the language it is filed under, and a locale without an
// entry never borrows another language's.

import { describe, expect, it } from "vitest";
import { FRENZY_QUOTES, frenzyQuotesFor } from "@/lib/mascot-frenzy";
import { isPhraseCompatible, LOCALE_SCRIPTS } from "@/lib/mascot-language";
import { MAX_PHRASE_LENGTH } from "@/lib/mascot-phrases";
import { neutral } from "@/lib/mascot-packs/neutral";
import { de } from "@/lib/mascot-packs/de";

describe("frenzy quotes", () => {
  it("only exists for languages somebody actually wrote it in", () => {
    expect(Object.keys(FRENZY_QUOTES).sort()).toEqual(["bg", "en"]);
  });

  it("every line is renderable in the locale it is filed under", () => {
    // Not just "reads in that script": three Bulgarian lines used to mix Latin
    // words in ("BUILT DIFFERENT", "EASY", "SPACEX"), which `classifyScript`
    // calls "mixed" and the render gate drops everywhere — so they never once
    // reached a bubble, on any box.
    for (const [locale, quotes] of Object.entries(FRENZY_QUOTES)) {
      for (const quote of quotes) {
        expect(isPhraseCompatible(quote, locale), `${locale}: "${quote}"`).toBe(true);
        expect(quote.length, `${locale}: "${quote}"`).toBeLessThanOrEqual(MAX_PHRASE_LENGTH);
      }
    }
  });

  it("gives a locale with no easter egg its OWN power lines, never English", () => {
    // de/es/fr/it/nl/sv are Latin-script, so filtering one flat array by
    // SCRIPT handed every one of them the full English set. Every locale the
    // device ships must end up with lines it can actually read.
    for (const locale of Object.keys(LOCALE_SCRIPTS)) {
      if (locale in FRENZY_QUOTES) continue;
      const quotes = frenzyQuotesFor(locale, de, neutral);
      expect(quotes, locale).toEqual(de.power);
    }
  });

  it("falls back to the neutral pack while the UI locale is still unknown", () => {
    const empty = { ...neutral, power: [] };
    expect(frenzyQuotesFor("", empty, neutral)).toEqual(neutral.power);
  });

  it("never returns an empty cycle — `quotes[0]` is always a line", () => {
    for (const locale of ["en", "bg", "de", "ja", "zh", ""]) {
      const quotes = frenzyQuotesFor(locale, { ...neutral, power: [] }, neutral);
      expect(quotes.length, locale).toBeGreaterThan(0);
    }
  });
});
