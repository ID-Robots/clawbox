// The mascot's language gate. Every speech bubble and every cached phrase is
// judged by these functions, so they are tested against the exact strings that
// caused the bug they exist to prevent: an English box greeting its owner with
// "Здрасти, {name}! 🇧🇬".

import { describe, expect, it } from "vitest";
import {
  ENGLISH_STOPWORDS,
  LOCALE_SCRIPTS,
  TECH_ALLOWLIST,
  VALIDATOR_VERSION,
  classifyScript,
  englishStopwordRatio,
  isNonEnglishLatinLocale,
  isPhraseCompatible,
  stripTechTerms,
} from "@/lib/mascot-language";
import { PREFERENCE_LANGUAGES } from "@/lib/preference-schema";

describe("classifyScript", () => {
  it("treats emoji, punctuation, digits and the {name} token as language-free", () => {
    for (const phrase of ["🦀", "💤 ...", "🎉!!!", "404", "{name}", "*  *", "😶‍🌫️", "⬆️"]) {
      expect(classifyScript(phrase), phrase).toBe("neutral");
    }
  });

  it("does not treat a flag emoji as a language", () => {
    // 🇧🇬 is a regional-indicator pair, not a letter — "🇧🇬" alone says nothing
    // about the phrase's language, and stripping it must not need a special
    // case in every caller.
    expect(classifyScript("🇧🇬")).toBe("neutral");
    expect(classifyScript("🇯🇵 🇬🇧 🇩🇪")).toBe("neutral");
  });

  it("buckets single-script phrases", () => {
    expect(classifyScript("Ship faster, humans.")).toBe("latin");
    expect(classifyScript("Здрасти!")).toBe("cyrillic");
    expect(classifyScript("你好")).toBe("han");
    expect(classifyScript("こんにちは")).toBe("kana");
    expect(classifyScript("カタカナ")).toBe("kana");
  });

  it("counts kana + kanji as ordinary written Japanese, not a mix-up", () => {
    expect(classifyScript("デプロイ完了しました")).toBe("japanese");
    // The prolonged sound mark ー is Script=Common; without Script_Extensions
    // it would land in "other" and make every katakana phrase look mixed.
    expect(classifyScript("コーヒー")).toBe("kana");
  });

  it("rejects two incompatible scripts in one string as mixed", () => {
    expect(classifyScript("Здрасти, {name}! Hello")).toBe("mixed");
    expect(classifyScript("НИЕ СМЕ BUILT DIFFERENT")).toBe("mixed");
  });

  it("buckets scripts the device ships no locale for as other", () => {
    expect(classifyScript("Γειά σου")).toBe("other");
  });
});

describe("isPhraseCompatible", () => {
  it("rejects the Bulgarian greeting that shipped inside the English bag", () => {
    // src/lib/mascot-phrases.ts:69 on beta — every English box greeted its
    // owner in Bulgarian.
    expect(isPhraseCompatible("Здрасти, {name}! 🇧🇬", "en")).toBe(false);
    expect(isPhraseCompatible("Здрасти, {name}! 🇧🇬", "bg")).toBe(true);
  });

  it("rejects the Bulgarian name fallback that shipped inside the English bag", () => {
    // src/lib/mascot-phrases.ts:81 on beta.
    expect(isPhraseCompatible("шефе", "en")).toBe(false);
    expect(isPhraseCompatible("шефе", "bg")).toBe(true);
  });

  it("judges the TEMPLATE, so a name in another script does not silence the crab", () => {
    // This is why the render gate must run before {name} substitution: the
    // template is English, the owner is not.
    expect(isPhraseCompatible("Hey {name}! 👋", "en")).toBe(true);
    expect(isPhraseCompatible("Hey Красимир! 👋", "en")).toBe(false);
  });

  it("lets language-free phrases through in every locale", () => {
    for (const locale of PREFERENCE_LANGUAGES) {
      expect(isPhraseCompatible("🦀👑", locale), locale).toBe(true);
    }
  });

  it("allows English technical terms inside any locale", () => {
    expect(isPhraseCompatible("Пак ли този bug? 🐛", "bg")).toBe(true);
    expect(isPhraseCompatible("deploy 完了", "zh")).toBe(true);
    expect(isPhraseCompatible("git push して", "ja")).toBe(true);
    expect(isPhraseCompatible("ClawBox е буден ☕", "bg")).toBe(true);
  });

  it("does not allow arbitrary English words inside another locale", () => {
    expect(isPhraseCompatible("Пак ли този problem?", "bg")).toBe(false);
  });

  it("fails closed for a locale the device does not ship", () => {
    // "capitão" is Latin script, so nothing here can catch it — it is kept out
    // by not being in any pack. An unknown LOCALE, however, gets nothing but
    // language-free strings.
    expect(isPhraseCompatible("capitão", "pt")).toBe(false);
    expect(isPhraseCompatible("🦀", "pt")).toBe(true);
  });

  it("rejects non-strings", () => {
    expect(isPhraseCompatible(undefined as unknown as string, "en")).toBe(false);
    expect(isPhraseCompatible(42 as unknown as string, "en")).toBe(false);
  });
});

describe("stripTechTerms", () => {
  it("only removes whole words", () => {
    expect(stripTechTerms("debugger").trim()).toBe("debugger");
    expect(stripTechTerms("a bug").trim()).toBe("a");
  });

  it("is case-insensitive", () => {
    expect(stripTechTerms("BUG Bug bug").trim()).toBe("");
  });
});

describe("LOCALE_SCRIPTS", () => {
  it("covers every locale the device ships", () => {
    for (const locale of PREFERENCE_LANGUAGES) {
      expect(LOCALE_SCRIPTS[locale], locale).toBeDefined();
      expect(LOCALE_SCRIPTS[locale].length, locale).toBeGreaterThan(0);
    }
  });

  it("marks the non-English Latin locales", () => {
    expect(isNonEnglishLatinLocale("de")).toBe(true);
    expect(isNonEnglishLatinLocale("en")).toBe(false);
    expect(isNonEnglishLatinLocale("bg")).toBe(false);
    expect(isNonEnglishLatinLocale("ja")).toBe(false);
  });
});

describe("englishStopwordRatio", () => {
  it("is high for English text and zero for the other Latin locales", () => {
    expect(englishStopwordRatio(["What have you done?", "Just ship the thing"])).toBe(1);
    expect(englishStopwordRatio(["Läuft nicht mehr", "Kaffee zuerst ☕"])).toBe(0);
    expect(englishStopwordRatio(["Café primero ☕", "¡Vamos!"])).toBe(0);
    expect(englishStopwordRatio([])).toBe(0);
  });

  it("avoids stopwords that are real words in the other locales", () => {
    // "die", "was", "man", "so", "in", "on", "a" all mean something in
    // German/Dutch/French/Spanish — including them would flag correct packs.
    for (const trap of ["die", "was", "man", "so", "in", "on", "a", "en", "de", "no"]) {
      expect(ENGLISH_STOPWORDS, trap).not.toContain(trap);
    }
  });
});

describe("TECH_ALLOWLIST / VALIDATOR_VERSION", () => {
  it("is lowercase and free of whitespace so word-boundary matching works", () => {
    for (const term of TECH_ALLOWLIST) {
      expect(term, term).toBe(term.toLowerCase());
      expect(term, term).not.toMatch(/\s/);
    }
  });

  it("is a positive integer that cache envelopes can compare against", () => {
    expect(Number.isInteger(VALIDATOR_VERSION)).toBe(true);
    expect(VALIDATOR_VERSION).toBeGreaterThan(0);
  });
});
