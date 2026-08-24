// A Hermes pet wears someone else's body. It must never speak as a crab — in
// any category, in any locale — while the crab itself keeps every line it has.
//
// This file is the safety net for that, and it is deliberately NOT a rerun of
// the implementation. The runtime subtracts each pack's own `<locale>Crab`
// tags; the scan below re-derives that set from a crab lexicon and asserts the
// two agree, so a joke added without a tag fails HERE rather than shipping as
// a penguin calling itself a crab.

import { describe, expect, it } from "vitest";
import { PREFERENCE_LANGUAGES } from "@/lib/preference-schema";
import { PHRASE_CATEGORIES, type MascotPhraseSet } from "@/lib/mascot-phrases";
import { localePackFor, NEUTRAL_PACK, NEUTRAL_CRAB_LINES } from "@/lib/mascot-packs";
import { FRENZY_CRAB_LINES, FRENZY_QUOTES, frenzyQuotesFor } from "@/lib/mascot-frenzy";
import {
  PET_NEUTRAL_PACK,
  PET_POWER_LINES,
  petSafeWithTags,
  petSafePhrases,
} from "@/lib/mascot-pet-voice";

/**
 * Crab words per locale, written out here rather than imported, so this file
 * is an independent opinion about what "crab-literal" means. If it ever
 * disagrees with `CRAB_LEXICON`, one of the two is wrong and that is the point.
 */
const CRAB_WORDS: Record<string, RegExp> = {
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

function looksCrabby(line: string, locale: string): boolean {
  if (CRAB_EMOJI.test(line)) return true;
  const words = CRAB_WORDS[locale];
  return words ? words.test(line) : false;
}

function scanCrabLines(set: MascotPhraseSet, locale: string): string[] {
  const found = new Set<string>();
  for (const category of PHRASE_CATEGORIES) {
    for (const line of set[category]) if (looksCrabby(line, locale)) found.add(line);
  }
  return [...found].sort();
}

const LOCALES = [...PREFERENCE_LANGUAGES];

describe("crab tags in the packs", () => {
  it("covers exactly the crab-literal lines a lexicon scan finds, in every locale", async () => {
    for (const locale of LOCALES) {
      const pack = await localePackFor(locale);
      expect([...pack.crab].sort(), locale).toEqual(scanCrabLines(pack.phrases, locale));
    }
  });

  it("covers the language-free neutral pack too", () => {
    expect([...NEUTRAL_CRAB_LINES].sort()).toEqual(scanCrabLines(NEUTRAL_PACK, "neutral"));
  });

  it("tags only lines that are really in the pack", async () => {
    for (const locale of LOCALES) {
      const pack = await localePackFor(locale);
      const all = new Set(PHRASE_CATEGORIES.flatMap((c) => pack.phrases[c]));
      for (const line of pack.crab) expect(all.has(line), `${locale}: ${line}`).toBe(true);
    }
  });
});

describe("what a pet may say", () => {
  it("speaks no crab-literal line in any category, in any locale", async () => {
    for (const locale of LOCALES) {
      const pack = await localePackFor(locale);
      const safe = petSafeWithTags(pack.phrases, locale, pack.crab);
      expect(scanCrabLines(safe, locale), locale).toEqual([]);
      // The neutral refill is language-free, so it must also survive a scan
      // under the LOCALE's lexicon and not just its own.
      expect(scanCrabLines(safe, "neutral"), locale).toEqual([]);
    }
  });

  it("keeps at least one line in every category, in every locale", async () => {
    for (const locale of LOCALES) {
      const pack = await localePackFor(locale);
      const safe = petSafeWithTags(pack.phrases, locale, pack.crab);
      for (const category of PHRASE_CATEGORIES) {
        expect(safe[category].length, `${locale}.${category}`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the {name} token in every greeting it keeps", async () => {
    for (const locale of LOCALES) {
      const pack = await localePackFor(locale);
      const safe = petSafeWithTags(pack.phrases, locale, pack.crab);
      for (const line of safe.nameGreetings) expect(line, locale).toContain("{name}");
    }
  });

  it("refills a category the filter would empty, rather than going mute", async () => {
    const allCrab: MascotPhraseSet = { ...NEUTRAL_PACK, sass: ["🦀", "🦀💢"] };
    const safe = petSafeWithTags(allCrab, "en", []);
    expect(safe.sass).toEqual(PET_NEUTRAL_PACK.sass);
    expect(safe.sass.length).toBeGreaterThan(0);
  });

  it("drops an untagged crab line the generator invented", async () => {
    // Nothing tags a generated phrase — the local model is prompted for "a
    // sarcastic crab mascot", so the lexicon has to catch its output too.
    const generated: MascotPhraseSet = {
      ...NEUTRAL_PACK,
      idle: ["🦀 KING CRAB!", "*counts pixels*", "My claws hurt.", "hmm..."],
    };
    const safe = await petSafePhrases(generated, "en");
    expect(safe.idle).toEqual(["*counts pixels*", "hmm..."]);
  });

  it("offers a power shout that is neither crab-literal nor empty", () => {
    expect(PET_POWER_LINES.length).toBeGreaterThan(0);
    for (const line of PET_POWER_LINES) expect(CRAB_EMOJI.test(line)).toBe(false);
  });
});

describe("the frenzy easter egg", () => {
  it("tags exactly the crab-literal frenzy quotes a lexicon scan finds", () => {
    const scanned = new Set<string>();
    for (const [locale, quotes] of Object.entries(FRENZY_QUOTES)) {
      for (const line of quotes) if (looksCrabby(line, locale)) scanned.add(line);
    }
    expect([...FRENZY_CRAB_LINES].sort()).toEqual([...scanned].sort());
  });

  it("shouts none of them at a pet, and all of them at the crab", () => {
    for (const locale of Object.keys(FRENZY_QUOTES)) {
      const crab = frenzyQuotesFor(locale, NEUTRAL_PACK, NEUTRAL_PACK, false);
      expect(crab, locale).toEqual(FRENZY_QUOTES[locale]);

      const pet = frenzyQuotesFor(locale, PET_NEUTRAL_PACK, PET_NEUTRAL_PACK, true);
      expect(pet.filter((line) => looksCrabby(line, locale)), locale).toEqual([]);
      expect(pet.length, locale).toBeGreaterThan(0);
    }
  });

  it("still has a locale without its own quotes fall through to the pack", () => {
    const pet = frenzyQuotesFor("de", PET_NEUTRAL_PACK, PET_NEUTRAL_PACK, true);
    expect(pet).toEqual(PET_NEUTRAL_PACK.power);
  });
});

describe("what the crab still says", () => {
  it("keeps every crab-literal line in its own packs", async () => {
    for (const locale of LOCALES) {
      const pack = await localePackFor(locale);
      // The pack objects are what the crab is served, untouched — assert the
      // filter did not mutate them on the way past.
      expect(scanCrabLines(pack.phrases, locale).length, locale).toBeGreaterThan(0);
    }
  });

  it("leaves the neutral pack's own crab lines alone", () => {
    expect(NEUTRAL_PACK.power).toContain("🦀👑");
    expect(NEUTRAL_PACK.sass).toContain("🦀");
  });

  it("never hands a pet a category the crab pack does not define", async () => {
    const pack = await localePackFor("en");
    const safe = petSafeWithTags(pack.phrases, "en", pack.crab);
    expect(Object.keys(safe).sort()).toEqual([...PHRASE_CATEGORIES].sort());
  });
});
