// Structural contract for the mascot phrase packs (INV-2 / INV-3).
//
// Runs over every pack that currently exists, so it keeps working as the
// locale packs land on their own branch. On beta this suite fails: the single
// English bag in src/lib/mascot-phrases.ts contained "Здрасти, {name}! 🇧🇬"
// (:69) and "шефе" / "capitão" (:81), so an English box was neither
// script-compatible with its own locale nor free of another pack's lines.

import { describe, expect, it } from "vitest";
import { PREFERENCE_LANGUAGES } from "@/lib/preference-schema";
import { classifyScript, isPhraseCompatible } from "@/lib/mascot-language";
import {
  MAX_PHRASE_LENGTH,
  PHRASE_CATEGORIES,
  type MascotPhraseSet,
  type PhraseCategory,
} from "@/lib/mascot-phrases";
import { NEUTRAL_PACK, hasPack, packFor, packForSync } from "@/lib/mascot-packs";

const LOCALES = [...PREFERENCE_LANGUAGES];

async function loadPacks(): Promise<Map<string, MascotPhraseSet>> {
  const packs = new Map<string, MascotPhraseSet>([["neutral", NEUTRAL_PACK]]);
  for (const locale of LOCALES) {
    if (!hasPack(locale)) continue; // pack file not written yet
    packs.set(locale, await packFor(locale));
  }
  return packs;
}

describe("mascot packs — completeness (INV-3)", () => {
  it("every existing pack defines every category, non-empty", async () => {
    for (const [locale, pack] of await loadPacks()) {
      for (const category of PHRASE_CATEGORIES) {
        expect(Array.isArray(pack[category]), `${locale}.${category}`).toBe(true);
        expect(pack[category].length, `${locale}.${category} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("every locale resolves to a complete pack even when its file is missing", async () => {
    for (const locale of LOCALES) {
      const pack = await packFor(locale);
      for (const category of PHRASE_CATEGORIES) {
        expect(pack[category].length, `${locale}.${category}`).toBeGreaterThan(0);
      }
    }
  });

  it("falls back to the language-free pack, never to English", async () => {
    expect(await packFor("xx-unknown")).toBe(NEUTRAL_PACK);
    // Before a pack has been loaded, the synchronous path used by the very
    // first render must not hand back English either.
    expect(packForSync("xx-unknown")).toBe(NEUTRAL_PACK);
  });
});

describe("mascot packs — language correctness (INV-2)", () => {
  it("every phrase is compatible with its own locale", async () => {
    for (const [locale, pack] of await loadPacks()) {
      if (locale === "neutral") continue;
      for (const category of PHRASE_CATEGORIES) {
        for (const phrase of pack[category]) {
          expect(
            isPhraseCompatible(phrase, locale),
            `${locale}.${category}: "${phrase}" is not ${locale}`,
          ).toBe(true);
        }
      }
    }
  });

  it("the neutral pack contains nothing but language-free strings", () => {
    for (const category of PHRASE_CATEGORIES) {
      for (const phrase of NEUTRAL_PACK[category]) {
        expect(classifyScript(phrase), `neutral.${category}: "${phrase}"`).toBe("neutral");
      }
    }
  });

  it("no phrase carrying language appears in two packs", async () => {
    const owner = new Map<string, string>();
    for (const [locale, pack] of await loadPacks()) {
      for (const category of PHRASE_CATEGORIES) {
        for (const phrase of pack[category]) {
          if (classifyScript(phrase) === "neutral") continue; // pure emoji may repeat
          const previous = owner.get(phrase);
          expect(previous, `"${phrase}" is in both ${previous} and ${locale}`).toBeUndefined();
          owner.set(phrase, locale);
        }
      }
    }
  });

  it("rejects the exact entries that leaked across locales on beta", async () => {
    const leaked = ["Здрасти, {name}! 🇧🇬", "шефе", "capitão"];
    for (const [locale, pack] of await loadPacks()) {
      for (const category of PHRASE_CATEGORIES) {
        for (const bad of leaked) {
          if (locale === "bg" && bad !== "capitão") continue; // legitimate Bulgarian
          expect(pack[category], `${locale}.${category}`).not.toContain(bad);
        }
      }
    }
  });
});

describe("mascot packs — shape", () => {
  it("keeps every phrase inside a speech bubble", async () => {
    for (const [locale, pack] of await loadPacks()) {
      for (const category of PHRASE_CATEGORIES) {
        for (const phrase of pack[category]) {
          expect(typeof phrase, `${locale}.${category}`).toBe("string");
          expect(phrase.trim(), `${locale}.${category}: "${phrase}" is blank`).not.toBe("");
          expect(phrase.length, `${locale}.${category}: "${phrase}" is too long`).toBeLessThanOrEqual(MAX_PHRASE_LENGTH);
        }
      }
    }
  });

  it("nameGreetings carry the {name} token and nameFallbacks do not", async () => {
    for (const [locale, pack] of await loadPacks()) {
      for (const tpl of pack.nameGreetings) {
        expect(tpl, `${locale}: "${tpl}" has no {name}`).toContain("{name}");
      }
      for (const fallback of pack.nameFallbacks) {
        expect(fallback, `${locale}: "${fallback}"`).not.toContain("{");
        expect(fallback, `${locale}: "${fallback}" is not a single word`).not.toMatch(/\s/);
      }
    }
  });

  it("has no duplicate inside a single category", async () => {
    for (const [locale, pack] of await loadPacks()) {
      for (const category of PHRASE_CATEGORIES as readonly PhraseCategory[]) {
        const list = pack[category];
        expect(new Set(list).size, `${locale}.${category} has duplicates`).toBe(list.length);
      }
    }
  });
});
