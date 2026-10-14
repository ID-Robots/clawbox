/**
 * The Flash writer's contract: the prompt, the strict reading of the model's
 * answer, and draft → page (paths, global claim ids, update in place, the
 * verified gate, redaction of what the model wrote).
 */
import { describe, expect, it } from "vitest";
import { buildClaimIndex } from "@/lib/prime-radiant/claims";
import { scanSecrets } from "@/lib/prime-radiant/redact";
import {
  DEFAULT_OWNER,
  MAX_CLAIM_CHARS,
  MAX_FACTS_PER_PAGE,
  MAX_SUMMARY_CHARS,
  WRITER_ITEMS_MARKER,
  WriterParseError,
  addToIndex,
  buildPage,
  buildWriterPrompt,
  cleanDetails,
  cleanLine,
  indexLine,
  parseWriterResponse,
  readWriterItems,
  type BuildContext,
  type PageDraft,
  type WriterItem,
} from "@/lib/prime-radiant/writer";
import { validateFrontmatter } from "@/lib/prime-radiant/schema";
import { claim, frontmatter } from "../helpers/prime-radiant-fixtures";

const FAKE_KEY = "sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6";

const items: WriterItem[] = [
  { i: 0, path: "~/Documents/acme/catalogue.md", kind: "md", text: "Acme Widgets Ltd sells blue widgets." },
  { i: 1, path: "~/Documents/acme/support.txt", kind: "txt", text: "Support answers on weekdays." },
];

function card(i: number, extra: Record<string, unknown> = {}) {
  return {
    i,
    useful: true,
    type: "entity",
    title: "Acme Widgets Ltd",
    domain: "sales",
    summary: "Acme Widgets Ltd is a synthetic widget maker.",
    details: "Ships from the example.com depot.",
    facts: [{ fact: "Acme Widgets Ltd sells blue widgets.", quote: "sells blue widgets", confidence: 0.9 }],
    sensitivity: "internal",
    confidence: 0.8,
    ...extra,
  };
}

function draft(extra: Partial<PageDraft> = {}): PageDraft {
  return {
    i: 0,
    useful: true,
    type: "entity",
    title: "Acme Widgets Ltd",
    domain: "sales",
    summary: "Acme Widgets Ltd is a synthetic widget maker.",
    details: "",
    facts: [{ fact: "Acme Widgets Ltd sells blue widgets.", quote: "sells blue widgets", confidence: 0.9 }],
    privacy: "internal",
    confidence: 0.8,
    ...extra,
  };
}

function ctx(extra: Partial<BuildContext> = {}): BuildContext {
  return {
    takenPaths: new Set(),
    pagesBySource: new Map(),
    claimIndex: buildClaimIndex([]),
    now: new Date("2026-03-01T12:00:00.000Z"),
    ...extra,
  };
}

describe("the prompt", () => {
  it("carries the items as JSON after a marker, and reads them back", () => {
    const p = buildWriterPrompt(items);
    expect(p.system).toMatch(/JSON array only/);
    expect(p.user.startsWith(WRITER_ITEMS_MARKER)).toBe(true);
    expect(readWriterItems(p.user)).toEqual(items);
    expect(readWriterItems("no marker")).toBeNull();
    expect(readWriterItems(`${WRITER_ITEMS_MARKER} {not json`)).toBeNull();
  });
});

describe("parseWriterResponse", () => {
  it("reads an array wrapped in prose or a code fence", () => {
    const text = "Here you go:\n```json\n" + JSON.stringify([card(0), card(1, { title: "Support hours", type: "howto" })]) + "\n```";
    const v = parseWriterResponse(text, items);
    expect(v.get(0)).toMatchObject({ ok: true, draft: { title: "Acme Widgets Ltd", type: "entity", domain: "sales" } });
    expect(v.get(1)).toMatchObject({ ok: true, draft: { title: "Support hours", type: "howto" } });
  });

  it("finds the array behind brackets in the prose", () => {
    const array = JSON.stringify([card(0), card(1)]);
    for (const text of [
      `I kept [REDACTED:EMAIL] out of the cards:\n${array}`,
      `Here are [2 items] as asked: ${array}\nNote: [REDACTED:IBAN] was left out.`,
      `Indexes [0, 1] follow:\n${array}`,
    ]) {
      const v = parseWriterResponse(text, items);
      expect(v.get(0)).toMatchObject({ ok: true });
      expect(v.get(1)).toMatchObject({ ok: true });
    }
  });

  it("throws a WriterParseError when there is no usable array", () => {
    expect(() => parseWriterResponse("I cannot help with that.", items)).toThrow(WriterParseError);
    expect(() => parseWriterResponse("[not json]", items)).toThrow(WriterParseError);
  });

  it("fails one item, not the batch: missing, twice, unknown number, no title", () => {
    const v = parseWriterResponse(JSON.stringify([card(0), card(0), card(7)]), items);
    expect(v.get(0)).toEqual({ ok: false, reason: "answered twice" });
    expect(v.get(1)).toEqual({ ok: false, reason: "missing from the answer" });
    expect(v.has(7)).toBe(false);
    const noTitle = parseWriterResponse(JSON.stringify([card(0, { title: "" }), card(1)]), items);
    expect(noTitle.get(0)).toEqual({ ok: false, reason: "no title" });
    expect(noTitle.get(1)?.ok).toBe(true);
  });

  it("takes a useless item as not useful even without a title", () => {
    const v = parseWriterResponse(JSON.stringify([{ i: 0, useful: false }, card(1)]), items);
    expect(v.get(0)).toMatchObject({ ok: true, draft: { useful: false } });
  });

  it("normalises: unknown type → concept, source/synthesis refused, domain kebab, privacy, clamps, caps", () => {
    const longFacts = Array.from({ length: 30 }, (_, n) => ({ fact: `Fact number ${n} about widgets.`, confidence: 7 }));
    const v = parseWriterResponse(
      JSON.stringify([
        card(0, { type: "source", domain: "Sales & Marketing", sensitivity: "secret", facts: longFacts, confidence: -2 }),
        card(1, { type: "nonsense", summary: "x ".repeat(400), domain: 12 }),
      ]),
      items,
    );
    const a = v.get(0);
    const b = v.get(1);
    if (!a?.ok || !b?.ok) throw new Error("expected both to parse");
    expect(a.draft.type).toBe("concept");
    expect(a.draft.domain).toBe("sales-marketing");
    expect(a.draft.privacy).toBe("confidential");
    expect(a.draft.confidence).toBe(0);
    expect(a.draft.facts).toHaveLength(MAX_FACTS_PER_PAGE);
    expect(a.draft.facts[0].confidence).toBe(1);
    expect(b.draft.type).toBe("concept");
    expect(b.draft.domain).toBe("general");
    expect(b.draft.summary.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
  });

  it("redacts what the model wrote back", () => {
    const v = parseWriterResponse(
      JSON.stringify([card(0, { summary: `The key is ${FAKE_KEY} for the widget API.`, facts: [{ fact: `api_key=${FAKE_KEY}` }] }), card(1)]),
      items,
    );
    const a = v.get(0);
    if (!a?.ok) throw new Error("expected a draft");
    expect(a.draft.summary).not.toContain(FAKE_KEY);
    expect(a.draft.summary).toContain("[REDACTED:");
    expect(scanSecrets(JSON.stringify(a.draft))).toEqual([]);
  });
});

describe("cleaning", () => {
  it("cleanLine collapses whitespace and cuts at a word", () => {
    expect(cleanLine("a\n  b\tc", 50)).toBe("a b c");
    const cut = cleanLine("word ".repeat(100), 40);
    expect(cut.length).toBeLessThanOrEqual(40);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("cleanDetails drops frontmatter fences and demotes top headings", () => {
    const out = cleanDetails("---\n# Title\n\n\n\nText", 1000);
    expect(out).not.toMatch(/^---$/m);
    expect(out).toContain("## Title");
    expect(out).not.toMatch(/\n{3,}/);
    expect(cleanDetails("line\n".repeat(500), 100).length).toBeLessThanOrEqual(104);
  });
});

describe("buildPage", () => {
  it("writes a valid page in the type's folder with global claim ids and evidence", () => {
    const c = ctx();
    const built = buildPage(draft(), "~/Documents/acme/catalogue.md", c);
    if (!built.ok) throw new Error("expected a page");
    expect(built.path).toBe("entities/acme-widgets-ltd.md");
    expect(built.updated).toBe(false);
    const v = validateFrontmatter(built.frontmatter);
    expect(v.ok).toBe(true);
    expect(built.frontmatter).toMatchObject({
      type: "entity",
      domain: "sales",
      owner: DEFAULT_OWNER,
      status: "draft",
      generated: { at: "2026-03-01T12:00:00.000Z", by: "flash" },
      verified: null,
      sources: ["~/Documents/acme/catalogue.md"],
      checked_by: "flash",
      opus_pending: false,
    });
    expect(built.frontmatter.claims).toEqual([
      expect.objectContaining({
        id: "sales/acme-widgets-ltd/acme-widgets-ltd-sells-blue-widgets",
        status: "proposed",
        confidence: 0.9,
        evidence: [{ kind: "source", path: "~/Documents/acme/catalogue.md", note: "sells blue widgets" }],
      }),
    ]);
    expect(built.body.split("\n\n")[0]).toBe("Acme Widgets Ltd is a synthetic widget maker.");
    expect(built.body).toContain("## Key facts");
    expect(built.body).toContain("## Sources");
    expect(c.claimIndex.active.has(built.frontmatter.claims[0].id)).toBe(true);
  });

  it("never reuses a path or a claim id (taken, retired, earlier in the batch)", () => {
    const retiredId = "sales/acme-widgets-ltd/acme-widgets-ltd-sells-blue-widgets";
    const c = ctx({
      takenPaths: new Set(["entities/acme-widgets-ltd.md"]),
      claimIndex: buildClaimIndex([], [retiredId]),
    });
    const a = buildPage(draft(), "~/a.md", c);
    const b = buildPage(draft(), "~/b.md", c);
    if (!a.ok || !b.ok) throw new Error("expected pages");
    expect(a.path).toBe("entities/acme-widgets-ltd-2.md");
    expect(b.path).toBe("entities/acme-widgets-ltd-3.md");
    expect(a.frontmatter.claims[0].id).toBe(`${retiredId}-2`);
    expect(b.frontmatter.claims[0].id).toBe(`${retiredId}-3`);
  });

  it("updates the page of a document ingested before, in place, keeping owner and history", () => {
    const old = frontmatter({
      type: "entity",
      title: "Acme Widgets Ltd",
      domain: "sales",
      owner: "sales-team",
      status: "stable",
      sources: ["~/a.md"],
      claims: [claim("sales/acme-widgets-ltd/acme-widgets-ltd-sells-blue-widgets")],
      retiredClaimIds: ["sales/acme-widgets-ltd/old-fact"],
    });
    const pages = [{ path: "entities/acme.md", frontmatter: old }];
    const c = ctx({
      takenPaths: new Set(["entities/acme.md"]),
      pagesBySource: new Map([["~/a.md", pages[0]]]),
      claimIndex: buildClaimIndex(pages),
    });
    const built = buildPage(draft(), "~/a.md", c);
    if (!built.ok) throw new Error("expected a page");
    expect(built.path).toBe("entities/acme.md");
    expect(built.updated).toBe(true);
    expect(built.frontmatter.owner).toBe("sales-team");
    expect(built.frontmatter.status).toBe("stable");
    expect(built.frontmatter.retiredClaimIds).toEqual(["sales/acme-widgets-ltd/old-fact"]);
    // Its own previous id is free to take again on the same page.
    expect(built.frontmatter.claims[0].id).toBe("sales/acme-widgets-ltd/acme-widgets-ltd-sells-blue-widgets");
  });

  it("never touches a verified page (page or claim level)", () => {
    for (const fm of [
      frontmatter({ sources: ["~/a.md"], verified: { at: "2026-01-01T00:00:00Z", by: "owner" } }),
      frontmatter({ sources: ["~/a.md"], claims: [claim("sales/x/y", "t", { verified: { at: "2026-01-01T00:00:00Z", by: "owner" } })] }),
    ]) {
      const c = ctx({ pagesBySource: new Map([["~/a.md", { path: "concepts/x.md", frontmatter: fm }]]) });
      expect(buildPage(draft(), "~/a.md", c)).toEqual({ ok: false, reason: "verified-page", path: "concepts/x.md" });
    }
  });

  it("uses the owner the caller maps the domain to", () => {
    const built = buildPage(draft(), "~/a.md", ctx({ ownerFor: (d) => (d === "sales" ? "sales-team" : undefined) }));
    expect(built.ok && built.frontmatter.owner).toBe("sales-team");
  });

  it("keeps claims within the lint's length cap", () => {
    const built = buildPage(draft({ facts: [{ fact: cleanLine("long ".repeat(200), MAX_CLAIM_CHARS), quote: "", confidence: 0.5 }] }), "~/a.md", ctx());
    if (!built.ok) throw new Error("expected a page");
    expect(built.frontmatter.claims[0].text.length).toBeLessThanOrEqual(MAX_CLAIM_CHARS);
    expect(built.frontmatter.claims[0].evidence[0]).not.toHaveProperty("note");
  });
});

describe("index.md", () => {
  it("adds a line per new page, once", () => {
    const once = addToIndex("# Index\n\nIntro.\n", [{ path: "entities/acme.md", title: "Acme" }]);
    expect(once).toContain(indexLine("entities/acme.md", "Acme"));
    expect(addToIndex(once, [{ path: "entities/acme.md", title: "Acme" }])).toBe(once);
    expect(addToIndex(null, [{ path: "concepts/a.md", title: "A\nB" }])).toBe("# Index\n\n- [[concepts/a]] — A B\n");
  });
});
