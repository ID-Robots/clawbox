import { describe, expect, it } from "vitest";
import { BLOCKING_RULES, LIMITS, LINT_RULES, lintVault, staleAfterPassed, suggestSplit, type LintRule } from "@/lib/prime-radiant/lint";
import { claim, pageText, snapshot } from "../helpers/prime-radiant-fixtures";

const NOW = new Date("2026-06-01T12:00:00Z");
const INDEX = "# Index\n\n- [[concepts/pricing]]\n- [[entities/acme-widgets]]\n";
const ENTITY = pageText({ type: "entity", title: "Acme Widgets Ltd" }, "Acme Widgets Ltd is a synthetic company.\n");

function rules(report: ReturnType<typeof lintVault>, path?: string): LintRule[] {
  return report.findings.filter((f) => !path || f.path === path).map((f) => f.rule);
}

function lintOne(text: string, opts: { index?: string | null; extra?: Record<string, string> } = {}) {
  return lintVault(snapshot({ "concepts/pricing.md": text, "entities/acme-widgets.md": ENTITY, ...opts.extra }, opts.index === undefined ? INDEX : opts.index), {
    scope: ["concepts/pricing.md"],
    now: NOW,
  });
}

describe("prime radiant lint", () => {
  it("passes a well-formed page", () => {
    const report = lintOne(pageText({ claims: [claim("acme-sales/widgets/sizes")] }), {
      extra: { "syntheses/hub.md": pageText({ type: "synthesis" }, "Hub. See [[concepts/pricing]].") },
    });
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(1);
  });

  it("warns at the soft body cap and errors at the hard one, with a split by headings", () => {
    const section = (h: string) => `## ${h}\n\n${"Widgets are sold in boxes. ".repeat(100)}\n`;
    const soft = `Summary of widget pricing.\n\n${section("Small")}${section("Medium")}${section("Large")}`;
    expect(soft.length).toBeGreaterThan(LIMITS.bodySoftChars);
    const r1 = lintOne(pageText({}, soft));
    const f1 = r1.findings.find((f) => f.rule === "page-too-long")!;
    expect(f1.severity).toBe("warning");
    expect(f1.split?.strategy).toBe("headings");
    expect(f1.split?.children.map((c) => [c.title, c.path])).toEqual([
      ["Small", "concepts/pricing/small.md"],
      ["Medium", "concepts/pricing/medium.md"],
      ["Large", "concepts/pricing/large.md"],
    ]);
    const hard = `Summary.\n\n${["A", "B", "C", "D", "E"].map(section).join("")}`;
    expect(hard.length).toBeGreaterThan(LIMITS.bodyHardChars);
    const f2 = lintOne(pageText({}, hard)).findings.find((f) => f.rule === "page-too-long")!;
    expect(f2.severity).toBe("error");
    expect(f2.blocksCommit).toBe(false);
  });

  it("splits a heading-less page into paragraph runs under the target", () => {
    const body = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${"about widgets ".repeat(30)}`).join("\n\n");
    const split = suggestSplit("syntheses/overview.md", body, 3000);
    expect(split.strategy).toBe("paragraphs");
    expect(split.children.length).toBeGreaterThan(1);
    expect(split.children.every((c) => c.chars <= 3000 && c.path.startsWith("syntheses/overview/part-"))).toBe(true);
    expect(split.children[0].startLine).toBe(1);
  });

  it("holds entity and decision pages to the atomic cap", () => {
    const body = `Acme Widgets Ltd.\n\n${"x ".repeat(LIMITS.atomicMaxChars)}`;
    const entity = lintOne(pageText({ type: "entity" }, body));
    expect(rules(entity)).toContain("atomic-too-long");
    expect(entity.findings.find((f) => f.rule === "atomic-too-long")?.split).toBeDefined();
    expect(rules(lintOne(pageText({ type: "decision" }, body)))).toContain("atomic-too-long");
    expect(rules(lintOne(pageText({ type: "howto" }, body)))).not.toContain("atomic-too-long");
  });

  it("checks the summary paragraph", () => {
    expect(rules(lintOne(pageText({}, "## Only headings\n")))).toContain("summary-missing");
    const long = lintOne(pageText({}, `${"word ".repeat(80)}\n\nMore.`));
    expect(rules(long)).toContain("summary-too-long");
    expect(long.findings.find((f) => f.rule === "summary-too-long")?.details).toMatchObject({ limit: 300 });
  });

  it("caps claim count and claim length", () => {
    const many = Array.from({ length: LIMITS.maxClaims + 1 }, (_, i) => claim(`acme-sales/widgets/fact-${i}`));
    expect(rules(lintOne(pageText({ claims: many })))).toContain("too-many-claims");
    const long = lintOne(pageText({ claims: [claim("acme-sales/widgets/long", "y".repeat(LIMITS.claimMaxChars + 1))] }));
    expect(long.findings.find((f) => f.rule === "claim-too-long")?.details).toMatchObject({ claimId: "acme-sales/widgets/long" });
  });

  it("finds orphans: no inbound link from another content page", () => {
    const report = lintOne(pageText(), { index: "# Index\n" });
    expect(rules(report)).toContain("orphan");
    const linked = lintOne(pageText(), {
      index: "# Index\n",
      extra: { "syntheses/hub.md": pageText({ type: "synthesis" }, "Hub. See [pricing](../concepts/pricing.md).") },
    });
    expect(rules(linked)).not.toContain("orphan");
    const byTitle = lintOne(pageText({ title: "Widget pricing" }), {
      index: "# Index\n",
      extra: { "syntheses/hub.md": pageText({ type: "synthesis", title: "Hub" }, "Hub. See [[Widget pricing|prices]].") },
    });
    expect(rules(byTitle)).not.toContain("orphan");
    // A link inside code is an example, not a link.
    const inCode = lintOne(pageText(), {
      index: "# Index\n",
      extra: { "syntheses/hub.md": pageText({ type: "synthesis" }, "Hub. Write `[[concepts/pricing]]` to link.") },
    });
    expect(rules(inCode)).toContain("orphan");
  });

  it("counts a page index.md lists and no other page links as an orphan", () => {
    // index.md lists every page, so a listing reaches nothing.
    const listed = lintOne(pageText({}, "Pricing notes.\n"), { index: INDEX });
    const f = listed.findings.find((x) => x.rule === "orphan")!;
    expect(f).toMatchObject({ severity: "warning", blocksCommit: false, path: "concepts/pricing.md", details: { isolated: true } });
    expect(f.message).toBe("no other content page (concepts/, entities/, syntheses/) links here and it links to none (index.md, sources and reports do not count)");
    // A link from a source page (not content) does not reach it either…
    const fromSource = lintOne(pageText(), { extra: { "sources/price-list.md": pageText({ type: "source", title: "Price list" }, "See [[concepts/pricing]].") } });
    expect(rules(fromSource)).toContain("orphan");
    // …nor its own link out: it links somewhere, so it is not isolated.
    const linksOut = lintOne(pageText({}, "Pricing. See [[entities/acme-widgets]]."));
    const linked = linksOut.findings.find((x) => x.rule === "orphan")!;
    expect(linked.details).toEqual({ isolated: false });
    expect(linked.message).toBe("no other content page (concepts/, entities/, syntheses/) links here (index.md, sources and reports do not count)");
    // Only content pages are judged: a source page is never an orphan.
    const source = lintVault(snapshot({ "sources/price-list.md": pageText({ type: "source", title: "Price list" }) }, INDEX), { now: NOW });
    expect(rules(source)).not.toContain("orphan");
  });

  it("requires sources and flags a passed stale_after", () => {
    expect(rules(lintOne(pageText({ sources: [] })))).toContain("no-sources");
    expect(rules(lintOne(pageText({ stale_after: "2026-05-31" })))).toContain("stale-after-passed");
    expect(rules(lintOne(pageText({ stale_after: "2026-06-01" })))).not.toContain("stale-after-passed");
    expect(staleAfterPassed("2026-06-01", new Date("2026-06-02T00:00:00Z"))).toBe(true);
    expect(staleAfterPassed(null, NOW)).toBe(false);
  });

  it("blocks a commit on a secret, never quoting it", () => {
    const report = lintOne(pageText({}, "Pricing notes.\n\npassword=Hunter22!\n"));
    const f = report.findings.find((x) => x.rule === "secret-pattern")!;
    expect(f.blocksCommit).toBe(true);
    expect(JSON.stringify(f)).not.toContain("Hunter22");
    expect(f.details).toEqual({ kinds: ["PASSWORD"] });
    // An e-mail address is personal data, not a secret: not blocking.
    expect(rules(lintOne(pageText({}, "Contact orders@example.com.")))).not.toContain("secret-pattern");
  });

  it("blocks invalid frontmatter and malformed claim ids", () => {
    const report = lintOne("---\ntitle: x\n---\nbody");
    expect(rules(report)).toEqual(["frontmatter-invalid"]);
    expect(report.findings[0].blocksCommit).toBe(true);
    const badId = lintOne(pageText({ claims: [claim("Not An Id")] }));
    expect(badId.findings.find((f) => f.rule === "frontmatter-invalid")?.details).toEqual({ claimIds: ["Not An Id"] });
  });

  it("blocks claim-id collisions across pages and on one page", () => {
    const report = lintOne(pageText({ claims: [claim("acme-sales/widgets/sizes")] }), {
      extra: { "concepts/other.md": pageText({ title: "Other", claims: [claim("acme-sales/widgets/sizes")] }) },
    });
    const f = report.findings.find((x) => x.rule === "claim-id-collision")!;
    expect(f.blocksCommit).toBe(true);
    expect(f.details).toMatchObject({ claimId: "acme-sales/widgets/sizes", pages: ["concepts/pricing.md", "concepts/other.md"] });
    // Only the scoped page is judged.
    expect(report.findings.every((x) => x.path === "concepts/pricing.md")).toBe(true);
    const dup = lintOne(pageText({ claims: [claim("acme-sales/widgets/a"), claim("acme-sales/widgets/a")] }));
    expect(rules(dup)).toContain("claim-id-collision");
  });

  it("blocks reuse of a retired id, from a page or from the ledger", () => {
    const report = lintOne(pageText({ claims: [claim("acme-sales/widgets/old")] }), {
      extra: { "concepts/other.md": pageText({ title: "Other", retiredClaimIds: ["acme-sales/widgets/old"] }) },
    });
    expect(rules(report)).toContain("claim-id-retired-reuse");
    const viaLedger = lintVault(
      snapshot({ "concepts/pricing.md": pageText({ claims: [claim("acme-sales/widgets/gone")] }), "entities/acme-widgets.md": ENTITY }, INDEX),
      { now: NOW, ledgerRetired: ["acme-sales/widgets/gone"] },
    );
    expect(viaLedger.findings.find((f) => f.rule === "claim-id-retired-reuse")?.details).toMatchObject({ retiredBy: ["ledger"] });
  });

  it("lints every page when no scope is given, and nothing for an empty scope", () => {
    const snap = snapshot({ "concepts/a.md": pageText({ sources: [] }), "concepts/b.md": pageText({ sources: [] }) }, null);
    expect(lintVault(snap, { now: NOW }).checked).toBe(2);
    expect(lintVault(snap, { now: NOW, scope: [] }).checked).toBe(0);
  });

  it("names exactly the rules the spec lists, four of them blocking", () => {
    expect([...LINT_RULES].sort()).toEqual(
      [
        "page-too-long",
        "summary-missing",
        "summary-too-long",
        "too-many-claims",
        "claim-too-long",
        "atomic-too-long",
        "orphan",
        "no-sources",
        "stale-after-passed",
        "as-of-missing",
        "secret-pattern",
        "frontmatter-invalid",
        "claim-id-collision",
        "claim-id-retired-reuse",
        "stale-against-verified",
        "plugin-format",
        "duplicate-entity",
        "domain-mismatch",
      ].sort(),
    );
    expect([...BLOCKING_RULES].sort()).toEqual(["claim-id-collision", "claim-id-retired-reuse", "frontmatter-invalid", "secret-pattern"]);
  });
});
