import { describe, expect, it } from "vitest";
import {
  ensureFullPhraseSet,
  INSPIRATION_PHRASES,
  LANG_NAMES,
  PHRASE_CATEGORIES,
  type MascotPhraseSet,
} from "@/lib/mascot-phrases";

describe("INSPIRATION_PHRASES", () => {
  it("has at least one entry in every category so the mascot never picks from an empty bag", () => {
    for (const cat of PHRASE_CATEGORIES) {
      expect(INSPIRATION_PHRASES[cat].length, `${cat} should be non-empty`).toBeGreaterThan(0);
    }
  });

  it("nameGreetings entries all contain the {name} token (the renderer substitutes it at runtime)", () => {
    for (const tpl of INSPIRATION_PHRASES.nameGreetings) {
      expect(tpl, `"${tpl}" missing {name}`).toContain("{name}");
    }
  });

  it("nameFallbacks are single-word friendly placeholders (no whitespace, no template tokens)", () => {
    for (const name of INSPIRATION_PHRASES.nameFallbacks) {
      expect(name).not.toMatch(/\s/);
      expect(name).not.toContain("{");
    }
  });
});

describe("LANG_NAMES", () => {
  it("covers every locale the i18n provider supports", () => {
    // Match the union in src/lib/i18n.tsx — keeping this list in sync
    // prevents a missing locale from silently falling back to "English"
    // when the LLM prompt is built.
    const expected = ["en", "bg", "de", "es", "fr", "it", "ja", "nl", "sv", "zh"];
    expect(Object.keys(LANG_NAMES).sort()).toEqual(expected.sort());
  });

  it("never has an empty display name", () => {
    for (const [code, name] of Object.entries(LANG_NAMES)) {
      expect(name, `${code} display name`).toMatch(/\S/);
    }
  });
});

describe("PHRASE_CATEGORIES", () => {
  it("equals the runtime keys of INSPIRATION_PHRASES", () => {
    expect([...PHRASE_CATEGORIES].sort()).toEqual(Object.keys(INSPIRATION_PHRASES).sort());
  });
});

describe("ensureFullPhraseSet", () => {
  it("returns the inspiration set verbatim when called with null", () => {
    const out = ensureFullPhraseSet(null);
    expect(out).toEqual(INSPIRATION_PHRASES);
  });

  it("returns the inspiration set verbatim when called with undefined", () => {
    const out = ensureFullPhraseSet(undefined);
    expect(out).toEqual(INSPIRATION_PHRASES);
  });

  it("backfills missing categories from inspiration so every bag stays non-empty", () => {
    const out = ensureFullPhraseSet({ sass: ["custom sass line"] });
    expect(out.sass).toEqual(["custom sass line"]);
    // Untouched categories must come from inspiration.
    expect(out.idle).toEqual(INSPIRATION_PHRASES.idle);
    expect(out.nameGreetings).toEqual(INSPIRATION_PHRASES.nameGreetings);
  });

  it("ignores empty arrays — they should not blank out the inspiration fallback", () => {
    const out = ensureFullPhraseSet({ sass: [], idle: ["only idle"] });
    expect(out.sass).toEqual(INSPIRATION_PHRASES.sass);
    expect(out.idle).toEqual(["only idle"]);
  });

  it("filters out non-string entries so a bad LLM payload cannot inject objects/numbers", () => {
    // The model is asked for { sass: [...] } but if it returns a junk
    // payload (e.g. mixed types), we strip everything that isn't a
    // non-empty short string before keeping the array.
    const out = ensureFullPhraseSet({
      sass: [
        "good line",
        "" as unknown as string,                        // empty
        42 as unknown as string,                        // wrong type
        "x".repeat(200) as unknown as string,           // too long (>120)
        null as unknown as string,                      // null
        "another good one",
      ] as string[],
    });
    expect(out.sass).toEqual(["good line", "another good one"]);
  });

  it("falls back to inspiration when filtering empties the category entirely", () => {
    const out = ensureFullPhraseSet({
      sass: ["x".repeat(200), 7 as unknown as string],
    });
    expect(out.sass).toEqual(INSPIRATION_PHRASES.sass);
  });

  it("strips nameGreetings entries missing the {name} token (would render literally otherwise)", () => {
    const out = ensureFullPhraseSet({
      nameGreetings: [
        "Hello {name}!",
        "Hello!",                  // missing token — must be dropped
        "{name} ✨",
      ],
    });
    expect(out.nameGreetings).toEqual(["Hello {name}!", "{name} ✨"]);
  });

  it("falls back to inspiration nameGreetings when none of the incoming entries have {name}", () => {
    const out = ensureFullPhraseSet({
      nameGreetings: ["plain hello", "no token here"],
    });
    expect(out.nameGreetings).toEqual(INSPIRATION_PHRASES.nameGreetings);
  });

  it("does not mutate the input nor the inspiration constant (immutability check)", () => {
    const inspirationSnapshot = JSON.stringify(INSPIRATION_PHRASES);
    const incoming: Partial<MascotPhraseSet> = { sass: ["a", "b"] };
    const incomingSnapshot = JSON.stringify(incoming);

    ensureFullPhraseSet(incoming);

    expect(JSON.stringify(INSPIRATION_PHRASES)).toBe(inspirationSnapshot);
    expect(JSON.stringify(incoming)).toBe(incomingSnapshot);
  });
});
