import { describe, expect, it } from "vitest";
import {
  LANG_NAMES,
  MAX_PHRASE_LENGTH,
  MIN_SURVIVORS_PER_CATEGORY,
  PHRASE_CATEGORIES,
  isValidPhrase,
  mergeWithPackSync,
  sanitizeCategory,
  stripPackEchoes,
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

  it("rejects placeholder tokens the renderer would never substitute", () => {
    // Only `{name}`, and only in nameGreetings, is ever substituted. Anything
    // else reaches the bubble as literal braces.
    expect(isValidPhrase("Hi {user}!", "sass", "en")).toBe(false);
    expect(isValidPhrase("Working, {name}?", "sass", "en")).toBe(false);
    expect(isValidPhrase("Hey {name} {user}", "nameGreetings", "en")).toBe(false);
    expect(isValidPhrase("Hey {name}!", "nameGreetings", "en")).toBe(true);
  });

  it("classifies decomposed (NFD) accented text by its base script, not as mixed", () => {
    // "Kapitän" with the umlaut as a combining mark: the é/ä accent is its own
    // code point, which the per-character script test would bucket as "other".
    const nfd = "Kapitän";
    expect(nfd.normalize("NFC")).not.toBe(nfd);
    expect(isValidPhrase(nfd, "sass", "de")).toBe(true);
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

describe("stripPackEchoes", () => {
  it("removes lines the pack already has and keeps the new ones", () => {
    const result = stripPackEchoes(
      { sass: [en.sass[0], "A line the pack has never seen.", en.sass[1]] },
      en,
    );
    expect(result.sass).toEqual(["A line the pack has never seen."]);
  });

  it("matches on case and collapsed whitespace, not byte equality", () => {
    const result = stripPackEchoes({ sass: [`  ${en.sass[0].toUpperCase()}  `] }, en);
    expect(result.sass).toEqual([]);
  });

  it("compares within a category, not across the whole pack", () => {
    // A power line is not an echo just because some other category has it.
    const result = stripPackEchoes({ sass: [en.power[0]] }, en);
    expect(result.sass).toEqual([en.power[0]]);
  });

  it("leaves categories the batch did not supply absent", () => {
    const result = stripPackEchoes({ sass: ["something new entirely"] }, en);
    expect(result.idle).toBeUndefined();
    expect(Object.keys(result)).toEqual(["sass"]);
  });

  it("passes non-strings through for validateBatch to drop and count", () => {
    const result = stripPackEchoes({ sass: [42, en.sass[0], "new"] as unknown as string[] }, en);
    expect(result.sass).toEqual([42, "new"]);
  });

  it("turns an all-echo batch into one validateBatch rejects", () => {
    // The end-to-end point: a run that only parroted the tone reference is a
    // failed run, not a cacheable one.
    const echo = { sass: en.sass.slice(0, 6), idle: en.idle.slice(0, 6), jump: en.jump.slice(0, 6) };
    expect(validateBatch(echo, "en").ok).toBe(true);
    expect(validateBatch(stripPackEchoes(echo, en), "en").ok).toBe(false);
  });
});

describe("mergeWithPackSync (INV-3 — always complete, never another language)", () => {
  it("fills every missing category from the pack", () => {
    const merged = mergeWithPackSync({ sass: ["a fresh line"] }, en, "en");
    expect(merged.idle).toEqual(en.idle);
    for (const category of PHRASE_CATEGORIES) {
      expect(merged[category].length, category).toBeGreaterThan(0);
    }
  });

  it("ADDS generated lines to the pack rather than replacing it", () => {
    // A full regen used to substitute its output for the pack outright, which
    // SHRANK the repertoire — a measured English box went from 102 hand-written
    // lines to 72 generated ones, most of them near-copies of the pack lines the
    // prompt had shown the model as a tone reference. Net: fewer, samier lines.
    const merged = mergeWithPackSync({ sass: ["a fresh line"] }, en, "en");
    expect(merged.sass).toEqual(["a fresh line", ...en.sass]);
    expect(merged.sass.length).toBeGreaterThan(en.sass.length);
  });

  it("de-duplicates a generated line the model copied straight off the pack", () => {
    const merged = mergeWithPackSync({ sass: [en.sass[0]] }, en, "en");
    expect(merged.sass).toEqual(en.sass);
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
