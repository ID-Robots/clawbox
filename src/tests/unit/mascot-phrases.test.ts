import { describe, expect, it } from "vitest";
import {
  LANG_NAMES,
  MAX_PHRASE_LENGTH,
  MIN_SURVIVORS_PER_CATEGORY,
  PHRASE_CATEGORIES,
  isValidPhrase,
  mergeWithPackSync,
  sanitizeCategory,
  validateBatch,
} from "@/lib/mascot-phrases";
import { en } from "@/lib/mascot-packs/en";
import { neutral } from "@/lib/mascot-packs/neutral";
import { PREFERENCE_LANGUAGES } from "@/lib/preference-schema";

describe("PHRASE_CATEGORIES", () => {
  it("is exactly the set of keys a pack must define", () => {
    expect([...PHRASE_CATEGORIES].sort()).toEqual(Object.keys(en).sort());
    expect([...PHRASE_CATEGORIES].sort()).toEqual(Object.keys(neutral).sort());
  });
});

describe("LANG_NAMES", () => {
  it("covers every locale the device ships", () => {
    expect(Object.keys(LANG_NAMES).sort()).toEqual([...PREFERENCE_LANGUAGES].sort());
  });

  it("never has an empty display name", () => {
    for (const [code, name] of Object.entries(LANG_NAMES)) {
      expect(name, `${code} display name`).toMatch(/\S/);
    }
  });
});

describe("isValidPhrase", () => {
  it("accepts a normal line for its own locale", () => {
    expect(isValidPhrase("Ship faster, humans.", "sass", "en")).toBe(true);
    expect(isValidPhrase("Стига си скролвал 😤", "sass", "bg")).toBe(true);
  });

  it("rejects a line written in another script", () => {
    expect(isValidPhrase("Здрасти, {name}! 🇧🇬", "nameGreetings", "en")).toBe(false);
    expect(isValidPhrase("шефе", "nameFallbacks", "en")).toBe(false);
  });

  it("rejects blanks, non-strings and anything that outgrows a speech bubble", () => {
    expect(isValidPhrase("   ", "sass", "en")).toBe(false);
    expect(isValidPhrase(42, "sass", "en")).toBe(false);
    expect(isValidPhrase(null, "sass", "en")).toBe(false);
    expect(isValidPhrase("x".repeat(MAX_PHRASE_LENGTH + 1), "sass", "en")).toBe(false);
    expect(isValidPhrase("x".repeat(MAX_PHRASE_LENGTH), "sass", "en")).toBe(true);
  });

  it("enforces the per-category rules", () => {
    expect(isValidPhrase("Hello!", "nameGreetings", "en")).toBe(false);
    expect(isValidPhrase("Hello {name}!", "nameGreetings", "en")).toBe(true);
    expect(isValidPhrase("dear friend", "nameFallbacks", "en")).toBe(false);
    expect(isValidPhrase("friend", "nameFallbacks", "en")).toBe(true);
  });
});

describe("sanitizeCategory", () => {
  it("trims, drops invalid entries and de-duplicates while keeping order", () => {
    const out = sanitizeCategory(
      ["  keep me  ", "keep me", "", 7, "x".repeat(80), "Здрасти", "and me"],
      "sass",
      "en",
    );
    expect(out).toEqual(["keep me", "and me"]);
  });

  it("returns an empty array for anything that is not an array", () => {
    expect(sanitizeCategory(null, "sass", "en")).toEqual([]);
    expect(sanitizeCategory("nope", "sass", "en")).toEqual([]);
  });
});

describe("validateBatch (INV-6 — nothing unvalidated reaches the cache)", () => {
  const good = (prefix: string) => [`${prefix} one`, `${prefix} two`, `${prefix} three`, `${prefix} four`];

  it("keeps categories that have enough survivors and drops the thin ones", () => {
    const result = validateBatch(
      {
        sass: good("sass"),
        idle: good("idle"),
        jump: good("jump"),
        dance: ["only one"], // below MIN_SURVIVORS_PER_CATEGORY
      },
      "en",
    );
    expect(result.ok).toBe(true);
    expect(Object.keys(result.categories).sort()).toEqual(["idle", "jump", "sass"]);
    expect(result.categories.sass).toHaveLength(MIN_SURVIVORS_PER_CATEGORY);
    expect(result.dropped).toBe(1);
  });

  it("discards a batch that could not fill three categories", () => {
    const result = validateBatch({ sass: good("sass"), idle: ["nope"] }, "en");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("too-few-categories");
    expect(result.categories).toEqual({});
  });

  it("discards a batch whose entries are in the wrong script", () => {
    const result = validateBatch(
      { sass: good("sass"), idle: good("idle"), jump: good("jump") },
      "bg",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("too-few-categories");
  });

  it("discards a Latin-locale batch the model answered in English", () => {
    const english = [
      "You have to ship this",
      "Just make the thing",
      "What about the tests?",
      "They know what you did",
    ];
    const result = validateBatch({ sass: english, idle: english, jump: english }, "de");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("wrong-language");
  });

  it("does not flag a real German batch", () => {
    const german = ["Kaffee zuerst ☕", "Nicht schon wieder 🙄", "Läuft bei mir 😎", "Feierabend! 🎉"];
    const result = validateBatch({ sass: german, idle: german, jump: german }, "de");
    expect(result.ok).toBe(true);
  });

  it("can be asked to skip the stopword probe (cache re-validation)", () => {
    const english = ["You have to ship this", "Just make the thing", "What about the tests?", "They know"];
    expect(validateBatch({ sass: english, idle: english, jump: english }, "de", { stopwordProbe: false }).ok).toBe(true);
  });
});

describe("mergeWithPackSync (INV-3 — always complete, never another language)", () => {
  it("fills every missing category from the pack", () => {
    const merged = mergeWithPackSync({ sass: ["a fresh line"] }, en, "en");
    expect(merged.sass).toEqual(["a fresh line"]);
    expect(merged.idle).toEqual(en.idle);
    for (const category of PHRASE_CATEGORIES) {
      expect(merged[category].length, category).toBeGreaterThan(0);
    }
  });

  it("drops incoming entries in the wrong language and uses the pack instead", () => {
    const merged = mergeWithPackSync({ sass: ["Здрасти!", "шефе"] }, en, "en");
    expect(merged.sass).toEqual(en.sass);
  });

  it("returns a complete set for null / undefined input", () => {
    for (const input of [null, undefined]) {
      const merged = mergeWithPackSync(input, en, "en");
      for (const category of PHRASE_CATEGORIES) {
        expect(merged[category].length, category).toBeGreaterThan(0);
      }
    }
  });

  it("falls back to the neutral pack when the pack itself cannot supply a category", () => {
    const brokenPack = { ...en, sass: ["x".repeat(200)] };
    const merged = mergeWithPackSync(null, brokenPack, "en");
    expect(merged.sass).toEqual(neutral.sass);
  });

  it("never hands out a set that aliases the module-level packs", () => {
    const merged = mergeWithPackSync(null, en, "en");
    merged.sass.push("mutated by a caller");
    expect(en.sass).not.toContain("mutated by a caller");
  });
});
