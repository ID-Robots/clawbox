/**
 * What a claim is about, on the live test's own examples: 84 of 85
 * contradiction items were false because claims were written without a
 * subject ("It is Project Gutenberg eBook #5", "The work is called the oldest
 * military treatise") and the pass paired claims from unrelated pages (a
 * black hole against the US Constitution) by their wording. The writer now
 * keeps only self-contained claims; the pass pairs only claims about the
 * same thing. Fixtures are synthetic or public-domain titles.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { collectClaims, comparable, createHashEmbedder, runContradictionPass } from "@/lib/prime-radiant/contradictions";
import type { FlashClient } from "@/lib/prime-radiant/flash-client";
import { readJudgeItems } from "@/lib/prime-radiant/judge";
import { vaultDir } from "@/lib/prime-radiant/paths";
import { claimOpener, claimSubject, sameSubject, selfContainedClaim, subjectWords } from "@/lib/prime-radiant/subject";
import { claim, pageText, snapshot } from "../helpers/prime-radiant-fixtures";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe("self-contained claims", () => {
  const ART = "The Art of War";

  it.each([
    ["It is Project Gutenberg eBook #132.", "The Art of War is Project Gutenberg eBook #132."],
    ["The work is called the oldest military treatise.", "The Art of War is called the oldest military treatise."],
    ["The work, written around 500 BC, is attributed to Sun Tzu.", "The Art of War, written around 500 BC, is attributed to Sun Tzu."],
    ["This book was translated by Lionel Giles in 1910.", "The Art of War was translated by Lionel Giles in 1910."],
    ["This is the oldest military treatise.", "The Art of War is the oldest military treatise."],
    ["It's a classic of strategy.", "The Art of War is a classic of strategy."],
    ["Its author is Sun Tzu.", "The Art of War's author is Sun Tzu."],
    ["The book's 13 chapters each cover one aspect of war.", "The Art of War's 13 chapters each cover one aspect of war."],
    ["The author was Sun Tzu.", "The Art of War's author was Sun Tzu."],
  ])("repairs %j with the page's title", (raw, repaired) => {
    expect(selfContainedClaim(raw, ART)).toBe(repaired);
  });

  it.each([
    "The author, Sun Tzu, was a Chinese general.",
    "The company Acme Widgets Ltd was founded in 1990.",
    "The price of the blue widget is 10 EUR.",
    "Sun Tzu wrote The Art of War.",
    "There are 13 chapters in The Art of War.",
    "This year the office moved to Sofia.",
    "The ID Robots office is at 25 Tsar Boris III Blvd.",
  ])("keeps %j as written: it names its subject", (text) => {
    expect(claimOpener(text)).toEqual({ kind: "named" });
    expect(selfContainedClaim(text, ART)).toBe(text);
  });

  it.each(["He was a Chinese general.", "They fought at the battle of Boju.", "These chapters are short.", "The chapter on spies is the last.", "Their army was small."])(
    "drops %j: the pointer could mean someone else",
    (text) => {
      expect(selfContainedClaim(text, ART)).toBeNull();
    },
  );

  it("drops a pronoun-led claim when the title names nothing either", () => {
    expect(selfContainedClaim("It is Project Gutenberg eBook #5.", "Notes")).toBeNull();
    expect(selfContainedClaim("It is Project Gutenberg eBook #5.", "")).toBeNull();
    expect(selfContainedClaim("It is Project Gutenberg eBook #5.", "The United States Constitution.")).toBe(
      "The United States Constitution is Project Gutenberg eBook #5.",
    );
  });

  it("reads the subject before the verb", () => {
    expect([...subjectWords("The ID Robots office is at 25 Tsar Boris III Blvd.")]).toEqual(["id", "robot", "office"]);
    expect([...subjectWords("ID Robots moved its office to 10 Vitosha Blvd.")]).toEqual(["id", "robot"]);
    expect([...subjectWords("The price of the blue widget is 10 EUR.")]).toEqual(["price", "blue", "widget"]);
    expect([...subjectWords("It is Project Gutenberg eBook #5.")]).toEqual([]);
  });
});

describe("same subject", () => {
  const S = claimSubject;
  const same: Array<[string, ReturnType<typeof S>, ReturnType<typeof S>]> = [
    ["two prices of the blue widget", S("acme-sales/pricing/a", "The blue widget costs 10 EUR per unit.", "Widget pricing"), S("acme-sales/catalogue/b", "The blue widget costs 12 EUR per unit.", "Catalogue")],
    ["the office, in two documents", S("general/office-move/a", "The ID Robots office is at 25 Tsar Boris III Blvd.", "Office move"), S("general/company-info/b", "ID Robots moved its office to 10 Vitosha Blvd.", "Company info")],
    ["one claim naming the other's subject", S("military/sun-tzu/a", "Sun Tzu wrote The Art of War around 500 BC.", "Sun Tzu"), S("military/the-art-of-war/b", "The Art of War was written in the 4th century BC.", "The Art of War")],
    ["the same entity", S("general/acme/a", "It was founded in 1990.", "Acme"), S("general/acme/b", "The company employs 40 people.", "Acme")],
  ];
  const different: Array<[string, ReturnType<typeof S>, ReturnType<typeof S>]> = [
    ["a black hole and the US Constitution", S("science/black-hole/a", "A black hole is a region of spacetime where gravity prevents escape.", "Black hole"), S("law/united-states-constitution/b", "The United States Constitution is Project Gutenberg eBook #5.", "The United States Constitution")],
    ["two books with alike wording", S("law/united-states-constitution/a", "The United States Constitution is Project Gutenberg eBook #5.", "The United States Constitution"), S("military/the-art-of-war/b", "The Art of War is Project Gutenberg eBook #132.", "The Art of War")],
    ["two old pronoun-led claims of two books", S("law/united-states-constitution/a", "It is Project Gutenberg eBook #5.", "The United States Constitution"), S("military/the-art-of-war/b", "It is Project Gutenberg eBook #132.", "The Art of War")],
    ["two old pronoun-led claims, a black hole and a constitution", S("science/black-hole/a", "It is a region of spacetime.", "Black hole"), S("law/united-states-constitution/b", "It is the supreme law of the United States.", "The United States Constitution")],
    ["two numbered products", S("acme-sales/catalogue-0/a", "The widget model 0 costs 10 EUR per unit.", "Catalogue 0"), S("acme-sales/catalogue-1/b", "The widget model 1 costs 11 EUR per unit.", "Catalogue 1")],
    ["the price of two things", S("shop/blue-widget/a", "The price is 10 EUR.", "Blue widget"), S("shop/laptop/b", "The price is 900 EUR.", "Laptop")],
  ];
  it.each(same)("pairs %s", (_, a, b) => {
    expect(sameSubject(a, b)).toBe(true);
    expect(sameSubject(b, a)).toBe(true);
  });
  it.each(different)("does not pair %s", (_, a, b) => {
    expect(sameSubject(a, b)).toBe(false);
    expect(sameSubject(b, a)).toBe(false);
  });

  it("never pairs a statement with itself on another page", () => {
    const a = { text: "The blue widget costs 10 EUR.", subject: S("x/a/f", "The blue widget costs 10 EUR.") };
    expect(comparable(a, { ...a })).toBe(false);
  });
});

// ── the pass ──────────────────────────────────────────────────────────────

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-subject-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
let n = 0;

beforeEach(() => {
  process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`);
});

afterAll(() => {
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  fs.rmSync(base, { recursive: true, force: true });
});

/** The live test's vault, in miniature: three books (two with old pronoun-led claims), a black hole, and an office that moved. */
function liveVault() {
  return snapshot({
    "concepts/united-states-constitution.md": pageText({
      title: "The United States Constitution",
      claims: [
        claim("law/united-states-constitution/ebook", "It is Project Gutenberg eBook #5."),
        claim("law/united-states-constitution/articles", "The United States Constitution has seven articles."),
      ],
    }),
    "concepts/the-art-of-war.md": pageText({
      title: "The Art of War",
      claims: [
        claim("military/the-art-of-war/ebook", "It is Project Gutenberg eBook #132."),
        claim("military/the-art-of-war/treatise", "The work is called the oldest military treatise."),
        claim("military/the-art-of-war/chapters", "The Art of War has 13 chapters."),
      ],
    }),
    "concepts/black-hole.md": pageText({
      title: "Black hole",
      claims: [
        claim("science/black-hole/region", "It is a region of spacetime where gravity is so strong nothing escapes."),
        claim("science/black-hole/articles", "A black hole has seven known properties."),
      ],
    }),
    "concepts/office-move.md": pageText({ title: "Office move", claims: [claim("general/office-move/address", "The ID Robots office is at 25 Tsar Boris III Blvd.")] }),
    "concepts/company-info.md": pageText({ title: "Company info", claims: [claim("general/company-info/address", "The ID Robots office is at 10 Vitosha Blvd.")] }),
  });
}

describe("the contradiction pass pairs only claims about the same thing", () => {
  it("asks the judge about the office alone, never a black hole against a constitution", async () => {
    const asked: Array<[string, string]> = [];
    // A judge that calls EVERY pair a contradiction: only the pairing can keep the items true.
    const client: FlashClient = {
      model: "deepseek-v4-flash",
      async complete(request) {
        const items = readJudgeItems(request.user) ?? [];
        for (const it of items) asked.push([it.a, it.b]);
        const text = JSON.stringify(items.map((it) => ({ i: it.i, verdict: "contradiction", why: "differs" })));
        return { text, model: "deepseek-v4-flash", usage: { promptTokens: 100, completionTokens: 10, cacheHitTokens: 0 } };
      },
    };
    const r = await runContradictionPass(liveVault(), { stateVault: vaultDir(), scope: null, client, embedder: createHashEmbedder(), retry: { attempts: 1, sleep: async () => undefined } });
    expect(asked).toHaveLength(1);
    expect(asked[0].join(" | ")).toMatch(/25 Tsar Boris III Blvd.*10 Vitosha Blvd|10 Vitosha Blvd.*25 Tsar Boris III Blvd/);
    expect(r.findings).toHaveLength(1);
    expect(r.reviewItems).toHaveLength(1);
    expect(r.pairs).toBe(1);
  });

  it("reads an old claim's subject from its page", () => {
    const claims = collectClaims(liveVault());
    const ebook5 = claims.find((c) => c.id === "law/united-states-constitution/ebook")!;
    const ebook132 = claims.find((c) => c.id === "military/the-art-of-war/ebook")!;
    expect([...ebook5.subject.words]).toEqual(expect.arrayContaining(["united", "state", "constitution"]));
    expect(comparable(ebook5, ebook132)).toBe(false);
  });
});
