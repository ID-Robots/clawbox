import { describe, expect, it } from "vitest";
import { pageSummary, parsePage, serializePage, splitFrontmatter } from "@/lib/prime-radiant/frontmatter";
import { folderForType, hasVerification, parseStamp, validateFrontmatter } from "@/lib/prime-radiant/schema";
import { claim, frontmatter, pageText } from "../helpers/prime-radiant-fixtures";

describe("prime radiant frontmatter", () => {
  it("round-trips a page byte for byte", () => {
    const text = pageText({ claims: [claim("acme-sales/widgets/blue-widgets")] });
    const parsed = parsePage(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(serializePage(parsed.frontmatter, parsed.body)).toBe(text);
  });

  it("writes the contract fields first, in order, and keeps unknown keys after them", () => {
    const text = pageText({ relationships: [{ targetId: "entity.acme" }], id: "concept.widget-pricing" });
    const keys = splitFrontmatter(text)
      .yamlText!.split("\n")
      .filter((l) => /^[a-zA-Z_]+:/.test(l))
      .map((l) => l.split(":")[0]);
    expect(keys.slice(0, 5)).toEqual(["type", "title", "domain", "owner", "status"]);
    expect(keys).toContain("relationships");
    expect(keys.indexOf("relationships")).toBeGreaterThan(keys.indexOf("retiredClaimIds"));
    const parsed = parsePage(text);
    expect(parsed.ok && parsed.frontmatter.id).toBe("concept.widget-pricing");
  });

  it("keeps ISO timestamps as strings (no implicit YAML dates)", () => {
    const text = "---\ntype: concept\ntitle: T\ndomain: d\nowner: o\nstatus: draft\ngenerated:\n  at: 2026-01-15T10:00:00Z\n  by: flash\nsources: []\nprivacy: public\nstale_after: 2027-01-01\n---\nBody\n";
    const parsed = parsePage(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.frontmatter.generated.at).toBe("2026-01-15T10:00:00Z");
    expect(parsed.frontmatter.stale_after).toBe("2027-01-01");
  });

  it("fills the bookkeeping defaults a hand-written page may omit", () => {
    const text = "---\ntype: howto\ntitle: Reset a widget\ndomain: acme-support\nowner: support\nstatus: stable\ngenerated: 2026-01-15 by someone\nsources: [sources/manual.md]\nprivacy: public\n---\nPress the button.\n";
    const parsed = parsePage(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.frontmatter).toMatchObject({
      verified: null,
      stale_after: null,
      checked_by: "flash",
      opus_pending: false,
      claims: [],
      retiredClaimIds: [],
      generated: { at: "2026-01-15", by: "someone" },
    });
  });

  it("reports every broken field", () => {
    const result = validateFrontmatter({ type: "poem", title: "", domain: "Acme Sales", status: "final", privacy: "open", sources: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const fields = result.errors.map((e) => e.field);
    for (const f of ["type", "title", "domain", "owner", "status", "generated", "sources", "privacy"]) expect(fields).toContain(f);
  });

  it("validates claims", () => {
    const result = validateFrontmatter({
      ...frontmatter(),
      claims: [{ id: "a/b/c", text: "x", confidence: 2, status: "maybe", updatedAt: "yesterday", evidence: "none" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.field)).toEqual(
      expect.arrayContaining(["claims[0].confidence", "claims[0].status", "claims[0].updatedAt", "claims[0].evidence"]),
    );
  });

  it("refuses bad YAML, a missing block and a non-mapping without throwing", () => {
    expect(parsePage("no frontmatter").ok).toBe(false);
    expect(parsePage("---\ntitle: [unclosed\n---\nx").ok).toBe(false);
    expect(parsePage("---\n- a\n- b\n---\nx").ok).toBe(false);
    expect(parsePage("---\nx: !!js/function 'function(){}'\n---\nx").ok).toBe(false);
  });

  it("reads verification at page and claim level", () => {
    expect(hasVerification(frontmatter())).toBe(false);
    expect(hasVerification(frontmatter({ verified: { at: "2026-02-01", by: "owner" } }))).toBe(true);
    expect(hasVerification(frontmatter({ claims: [claim("a/b/c", "x", { verified: { at: "2026-02-01", by: "owner" } })] }))).toBe(true);
    expect(parseStamp("2026-02-01 by owner")).toEqual({ at: "2026-02-01", by: "owner" });
    expect(parseStamp(true)).toBeNull();
  });

  it("takes the summary from the first paragraph after the headings", () => {
    expect(pageSummary("# Title\n\nFirst line\nsecond line.\n\nNext paragraph.")).toBe("First line second line.");
    expect(pageSummary("# Only a heading\n\n## Another\n")).toBeNull();
  });

  it("never takes an HTML comment for the summary, on one line or across several", () => {
    expect(pageSummary("<!-- prime-radiant:hub:start -->\nInvoices 2026-09: 6 invoices.\n\n## Totals\n")).toBe("Invoices 2026-09: 6 invoices.");
    expect(pageSummary("<!--\n  a note to the editor,\n  over three lines\n-->\nThe real summary.\n")).toBe("The real summary.");
    expect(pageSummary("First part.\n<!-- one\ntwo -->\nSecond paragraph.\n")).toBe("First part.");
    expect(pageSummary("Widgets <!-- inline\nnote --> ship weekly.")).toBe("Widgets ship weekly.");
    expect(pageSummary("<!-- only a comment -->\n")).toBeNull();
    // An unclosed comment opener is text, as before.
    expect(pageSummary("Use <!-- to open a comment.")).toBe("Use <!-- to open a comment.");
  });

  it("maps types onto memory-wiki folders", () => {
    expect(folderForType("entity")).toBe("entities");
    expect(folderForType("synthesis")).toBe("syntheses");
    expect(folderForType("source")).toBe("sources");
    expect(folderForType("decision")).toBe("concepts");
  });
});
