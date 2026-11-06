/**
 * Lexical neighbours (lexical.ts): the words a page is compared by, TF-IDF
 * cosine through an inverted index, the minimum similarity, the same-domain
 * preference and a deterministic order. Fixtures are synthetic.
 */
import { describe, expect, it } from "vitest";
import { buildLexicalIndex, lexicalTokens, maxDocumentFrequency, type LexicalDoc } from "@/lib/prime-radiant/lexical";

const doc = (path: string, text: string, domain: string | null = "acme-ops"): LexicalDoc => ({ path, domain, text });

describe("lexical words", () => {
  it("keeps Latin and Cyrillic words, lowercased; drops stopwords, bare numbers and short words", () => {
    expect(lexicalTokens("The Widget 2026 in Склад на София, ab x9z, ВНОС и износ")).toEqual(["widget", "склад", "софия", "x9z", "внос", "износ"]);
    expect(lexicalTokens("12 345 2026-09-01")).toEqual([]);
  });

  it("lets a word tie at most a bounded number of pages", () => {
    expect(maxDocumentFrequency(20)).toBe(50);
    expect(maxDocumentFrequency(2_000)).toBe(200);
    expect(maxDocumentFrequency(20_000)).toBe(400);
  });
});

describe("lexical neighbours", () => {
  const docs = [
    doc("concepts/warranty-returns.md", "Warranty returns policy. Warranty returns need the original receipt."),
    doc("concepts/warranty-claims.md", "Warranty claims handling. Claims and returns need the original receipt."),
    doc("concepts/warranty-repairs.md", "Warranty repairs take a week.", "acme-support"),
    doc("concepts/paint-shop.md", "The paint shop runs two shifts."),
    doc("concepts/assembly.md", "The assembly line runs two shifts."),
    doc("concepts/blank.md", "Zzq."),
  ];

  it("ranks pages that share rarer words, above a minimum, and never the page itself", () => {
    const index = buildLexicalIndex(docs);
    const near = index.neighbours("concepts/warranty-returns.md", 5, 0.05);
    expect(near.map((n) => n.path)).toEqual(["concepts/warranty-claims.md", "concepts/warranty-repairs.md"]);
    expect(near[0].similarity).toBeGreaterThan(near[1].similarity);
    expect(near.every((n) => n.similarity > 0 && n.similarity <= 1)).toBe(true);
    // Unrelated pages are not neighbours, however low the bar.
    expect(index.neighbours("concepts/paint-shop.md", 5, 0.01).map((n) => n.path)).toEqual(["concepts/assembly.md"]);
    expect(index.neighbours("concepts/warranty-returns.md", 5, 0.99)).toEqual([]);
  });

  it("knows a page with no word another page shares, and an unknown one", () => {
    const index = buildLexicalIndex(docs);
    expect(index.hasText("concepts/blank.md")).toBe(false);
    expect(index.hasText("concepts/assembly.md")).toBe(true);
    expect(index.neighbours("concepts/blank.md", 5, 0)).toEqual([]);
    expect(index.neighbours("concepts/missing.md", 5, 0)).toEqual([]);
  });

  it("prefers the page's own domain, and skips what it is told to", () => {
    const twins = [
      doc("concepts/a-query.md", "Courier tariff for pallets."),
      doc("concepts/b-other-domain.md", "Courier tariff for pallets.", "acme-finance"),
      doc("concepts/c-same-domain.md", "Courier tariff for pallets."),
      // A word on every page weighs nothing: one page without them.
      doc("concepts/d-unrelated.md", "Office holidays in August."),
    ];
    const index = buildLexicalIndex(twins);
    expect(index.neighbours("concepts/a-query.md", 2, 0.1).map((n) => n.path)).toEqual(["concepts/c-same-domain.md", "concepts/b-other-domain.md"]);
    expect(index.neighbours("concepts/a-query.md", 2, 0.1, (p) => p === "concepts/c-same-domain.md").map((n) => n.path)).toEqual(["concepts/b-other-domain.md"]);
  });

  it("answers the same whatever order the pages come in, ties by path", () => {
    const same = [doc("concepts/z.md", "Pallet courier."), doc("concepts/m.md", "Pallet courier."), doc("concepts/a.md", "Pallet courier."), doc("concepts/q.md", "Office holidays.")];
    const one = buildLexicalIndex(same).neighbours("concepts/m.md", 5, 0.1);
    const other = buildLexicalIndex([...same].reverse()).neighbours("concepts/m.md", 5, 0.1);
    expect(one).toEqual(other);
    expect(one.map((n) => n.path)).toEqual(["concepts/a.md", "concepts/z.md"]);
  });

  it("stays fast on a vault of thousands of pages", () => {
    const words = Array.from({ length: 3_000 }, (_, i) => `term${i.toString(36)}`);
    const many = Array.from({ length: 10_000 }, (_, i) =>
      doc(`concepts/p-${String(i).padStart(5, "0")}.md`, Array.from({ length: 30 }, (_, k) => words[(i * 7 + k * 13) % words.length]).join(" ")),
    );
    const started = performance.now();
    const index = buildLexicalIndex(many);
    for (let i = 0; i < 2_000; i++) index.neighbours(many[i].path, 5, 0.05);
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(index.size).toBe(10_000);
  });
});
