/**
 * A page's text after a verification (stale-text.ts, pure). Every name in the
 * fixtures is invented.
 */
import { describe, expect, it } from "vitest";
import { reconcileStaleText, STALE_NOTE_PREFIX } from "@/lib/prime-radiant/stale-text";

const FACT = { before: "Globex pays suppliers within 30 days.", after: "Globex pays suppliers within 45 days." };

describe("reconcileStaleText", () => {
  it("changes nothing when nothing was superseded, or the text did not change", () => {
    const body = "Globex pays suppliers within 30 days.\n";
    expect(reconcileStaleText(body, [], "concepts/terms.md", "concepts/terms.md")).toEqual({ body, keyFacts: 0, stale: 0 });
    expect(reconcileStaleText(body, [{ before: FACT.before, after: FACT.before }], "concepts/terms.md", "concepts/terms.md").body).toBe(body);
  });

  it("leaves code, the source list and headings alone, and notes only the paragraph that states the value", () => {
    const body = [
      "# Terms",
      "",
      "Globex settles supplier invoices within 30 days of receipt.",
      "",
      "Globex was founded 30 years ago.",
      "",
      "```",
      "Globex pays suppliers within 30 days.",
      "```",
      "",
      "## Sources",
      "",
      "- Globex pays suppliers within 30 days.",
      "",
    ].join("\n");
    const r = reconcileStaleText(body, [FACT], "concepts/terms.md", "concepts/policy.md");
    expect(r.stale).toBe(1);
    expect(r.keyFacts).toBe(0);
    expect(r.body).toContain(
      `within 30 days of receipt.\n\n${STALE_NOTE_PREFIX} this said "Globex pays suppliers within 30 days."; the verified fact is "Globex pays suppliers within 45 days." ([[concepts/policy]])\n\nGlobex was founded`,
    );
    expect(r.body).toContain("```\nGlobex pays suppliers within 30 days.\n```");
    expect(r.body.endsWith("## Sources\n\n- Globex pays suppliers within 30 days.\n")).toBe(true);
  });

  it("lists the verified fact once in the verified page's Key facts", () => {
    const body = "Summary.\n\n## Key facts\n\n- Globex pays suppliers within 45 days.\n- Globex pays suppliers within 30 days.\n\n## Sources\n\n- `terms.md`\n";
    const r = reconcileStaleText(body, [FACT], "concepts/terms.md", "concepts/terms.md");
    expect(r.body).toBe("Summary.\n\n## Key facts\n\n- Globex pays suppliers within 45 days.\n\n## Sources\n\n- `terms.md`\n");
    // A Key facts list that did not state it gains it.
    const without = reconcileStaleText("Summary.\n\n## Key facts\n\n- Globex is in Springfield.\n", [FACT], "concepts/terms.md", "concepts/terms.md");
    expect(without.body).toBe("Summary.\n\n## Key facts\n\n- Globex is in Springfield.\n- Globex pays suppliers within 45 days.\n");
  });

  it("lists the verified fact once when its bullet comes after the superseded one", () => {
    const body = "Summary.\n\n## Key facts\n\n- Globex pays suppliers within 30 days.\n- Globex pays suppliers within 45 days.\n- Globex is in Springfield.\n";
    const r = reconcileStaleText(body, [FACT], "concepts/terms.md", "concepts/terms.md");
    expect(r.body).toBe("Summary.\n\n## Key facts\n\n- Globex pays suppliers within 45 days.\n- Globex is in Springfield.\n");
  });

  it("keeps an older note about another fact of the same paragraph", () => {
    const price = { before: "The blue widget costs 10 EUR.", after: "The blue widget costs 12 EUR." };
    const shipping = { before: "The blue widget ships within 3 days.", after: "The blue widget ships within 5 days." };
    const body = "The blue widget costs 10 EUR and ships within 3 days.\n";
    const once = reconcileStaleText(body, [price], "concepts/widget.md", "concepts/pricing.md").body;
    expect(once).toContain('this said "The blue widget costs 10 EUR."');
    const twice = reconcileStaleText(once, [shipping], "concepts/widget.md", "concepts/shipping.md").body;
    // Both stale values are still said to be stale: the price note was not dropped for the shipping one.
    expect(twice).toContain('this said "The blue widget costs 10 EUR."');
    expect(twice).toContain('this said "The blue widget ships within 3 days."');
    expect(twice.match(/\*\*Stale:\*\*/g)).toHaveLength(2);
    // And a pass that says the same again still writes one note per fact.
    expect(reconcileStaleText(twice, [shipping], "concepts/widget.md", "concepts/shipping.md").body).toBe(twice);
  });

  it("reads a page written with CRLF line endings, and keeps them", () => {
    const body = "Globex pays suppliers within 30 days.\r\n\r\n## Key facts\r\n\r\n- Globex pays suppliers within 30 days.\r\n- Globex is in Springfield.\r\n";
    const r = reconcileStaleText(body, [FACT], "concepts/terms.md", "concepts/terms.md");
    expect(r).toMatchObject({ keyFacts: 1, stale: 1 });
    expect(r.body).toBe(
      `Globex pays suppliers within 30 days.\r\n\r\n${STALE_NOTE_PREFIX} this said "Globex pays suppliers within 30 days."; the verified fact is "Globex pays suppliers within 45 days."\r\n\r\n## Key facts\r\n\r\n- Globex pays suppliers within 45 days.\r\n- Globex is in Springfield.\r\n`,
    );
    expect(reconcileStaleText(r.body, [FACT], "concepts/terms.md", "concepts/terms.md").body).toBe(r.body);
  });

  it("is idempotent: a second pass over its own output changes nothing", () => {
    const body = "Globex pays suppliers within 30 days.\n\n## Key facts\n\n- Globex pays suppliers within 30 days.\n";
    const once = reconcileStaleText(body, [FACT], "concepts/terms.md", "concepts/policy.md").body;
    expect(reconcileStaleText(once, [FACT], "concepts/terms.md", "concepts/policy.md").body).toBe(once);
    expect(once.match(/\*\*Stale:\*\*/g)).toHaveLength(1);
  });
});
