/**
 * The structure layer: record classification, monthly record hubs (totals,
 * leaf tables, counterparty hubs, parts), idempotency, a person's text kept,
 * the domain hubs and the company's root, entity enrichment, the decisions
 * register, the links metric, search ranking (a leaf never above its hub) and
 * the contradiction pass (two leaves of one hub never paired). Every fixture
 * is synthetic.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { collectClaims, comparable } from "@/lib/prime-radiant/contradictions";
import { planConnections } from "@/lib/prime-radiant/connect";
import { pageSummary, serializePage } from "@/lib/prime-radiant/frontmatter";
import { buildLinkGraph, linkDensity } from "@/lib/prime-radiant/links";
import { LIMITS, lintVault } from "@/lib/prime-radiant/lint";
import { noPairReason, pairable } from "@/lib/prime-radiant/pairing";
import { withPluginFields } from "@/lib/prime-radiant/plugin-compat";
import {
  amountsIn,
  classifyRecord,
  companyNames,
  parseAmountNumber,
  recordHubKey,
  titleRecordType,
  totalsByCurrency,
  type RecordType,
} from "@/lib/prime-radiant/records";
import { rejudgeVerdict, type RejudgePage } from "@/lib/prime-radiant/rejudge";
import type { PageFrontmatter } from "@/lib/prime-radiant/schema";
import { readSettings, readSettingsPatch, SettingsError, writeSettings } from "@/lib/prime-radiant/settings";
import { pageIndexUnits, rankVaultHits, type RankCandidate } from "@/lib/prime-radiant/shard-index";
import {
  blockContent,
  ENRICH_MAX_CLAIMS,
  HUB_END,
  HUB_PART_LEAVES,
  HUB_START,
  planStructure,
  readStructureMeta,
  RECORD_END,
  RECORD_START,
  REGISTER_ROWS,
  runStructurePass,
  upsertBlock,
  type StructureOptions,
} from "@/lib/prime-radiant/structure";
import { buildClassifyPrompt, changeKey, CLASSIFY_BATCH, classifyMaxTokens, classifyWithModel, modelCandidates, parseClassifyResponse } from "@/lib/prime-radiant/structure-run";
import { statusLinkDensity } from "@/lib/prime-radiant/service";
import { DEFAULT_COST_RATES } from "@/lib/prime-radiant/cost-rates";
import { FlashCallError, type FlashClient } from "@/lib/prime-radiant/flash-client";
import { readCosts } from "@/lib/prime-radiant/ingest-store";
import type { VaultSnapshot, VaultTx } from "@/lib/prime-radiant/vault";
import { claim, frontmatter, snapshot, vaultPage } from "../helpers/prime-radiant-fixtures";
import { COUNTERPARTIES, DOMAINS, OWN_COMPANY, structurePage, syntheticVault } from "../helpers/prime-radiant-structure-fixtures";

const NOW = new Date("2026-10-01T10:00:00.000Z");
const OPTIONS: StructureOptions = { now: NOW, domains: DOMAINS, company: OWN_COMPANY };

function fm(extra: Partial<PageFrontmatter>): PageFrontmatter {
  return frontmatter({ type: "reference", ...extra });
}

function leaf(title: string, claims: string[] = [], extra: Partial<PageFrontmatter> = {}): string {
  return structurePage(
    { type: "reference", title, domain: "finance", sources: [`sources/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pdf`], claims: claims.map((t, i) => claim(`finance/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}/f${i}`, t)), ...extra },
    `${title}.\n`,
  );
}

/** Apply a plan's writes to a snapshot the way vaultOperation would (memory-wiki's fields filled in). */
function apply(snap: VaultSnapshot, writes: ReadonlyArray<{ path: string; frontmatter: PageFrontmatter; body: string }>): VaultSnapshot {
  const pages = new Map(snap.pages.map((p) => [p.path, p]));
  for (const w of writes) pages.set(w.path, vaultPage(w.path, serializePage(withPluginFields(w.path, w.frontmatter), w.body)));
  return { ...snap, pages: [...pages.values()] };
}

function fakeRun(snap: { current: VaultSnapshot }) {
  const commits: string[] = [];
  const run = async (message: string, fn: (tx: VaultTx) => Promise<void>) => {
    const tx = {
      vault: "/nonexistent",
      touched: new Set<string>(),
      async read(rel: string) {
        return snap.current.pages.find((p) => p.path === rel) ?? null;
      },
      async write(rel: string, text: string) {
        if (rel === "index.md") snap.current = { ...snap.current, indexBody: text };
        else snap.current = { ...snap.current, pages: [...snap.current.pages.filter((p) => p.path !== rel), vaultPage(rel, text)] };
        return rel;
      },
      async writePage(rel: string, f: PageFrontmatter, body: string) {
        return tx.write(rel, serializePage(withPluginFields(rel, f), body));
      },
      async remove(rel: string) {
        return rel;
      },
    } as unknown as VaultTx;
    await fn(tx);
    commits.push(message);
    return { commit: `c${commits.length}` };
  };
  return { run, commits };
}

function pageOf(snap: VaultSnapshot, path: string) {
  const p = snap.pages.find((x) => x.path === path);
  if (!p || !p.parsed.ok) throw new Error(`no page ${path}`);
  return { fm: p.parsed.frontmatter, body: p.parsed.body, text: p.text };
}

function ourPages(snap: VaultSnapshot, kind: string) {
  return snap.pages.flatMap((p) => (p.parsed.ok && readStructureMeta(p.parsed.frontmatter)?.kind === kind ? [{ path: p.path, fm: p.parsed.frontmatter, body: p.parsed.body }] : []));
}

describe("record classification", () => {
  const cases: Array<[string, RecordType | null]> = [
    ["Invoice INV-2026-000123 Globex Ltd", "invoice"],
    ["Proforma PF-2026-0042", "invoice"],
    ["Фактура 0000004512 Initech GmbH", "invoice"],
    ["Credit note CN-2026-00042 to invoice INV-2026-000123", "credit-note"],
    ["Кредитно известие 0000000042", "credit-note"],
    ["Receipt RC-0001234 Hooli Inc", "receipt"],
    ["Касова бележка 2026-03-14", "receipt"],
    ["Bank transfer TR-88001234 to Wonka AG", "bank-transfer"],
    ["Платежно нареждане 2026-05-02", "bank-transfer"],
    ["Waybill 1054400012 Soylent Corp", "shipment"],
    ["Товарителница 1054400013", "shipment"],
    ["Customs declaration 26XX0000000042", "customs"],
    ["Export declaration MRN 26XX0000000043", "customs"],
    ["Ads receipt AR-2026-00042", "ad-receipt"],
    ["Advertising invoice 2026-04 Tyrell Corp", "ad-receipt"],
    ["Transfer TR-88001234 Wonka AG", "bank-transfer"],
    ["Transfer of ownership 2026-03", null],
    ["Courier 1Z999AA10123456784", "shipment"],
    ["Courier contract review 2026-05", null],
    ["Payment for ads campaign 2026-04", null],
    ["Invoice process", null],
    ["Receipt policy for travel", null],
    ["Widget pricing", null],
  ];
  it.each(cases)("reads %j as %s", (title, want) => {
    expect(titleRecordType(title)).toBe(want);
  });

  it("needs a month, never types an entity, synthesis or decision page, and reads a type from the facts when the title names none", () => {
    expect(classifyRecord("concepts/a.md", fm({ title: "Invoice INV-2026-000123" }))).toBeNull(); // no date anywhere
    expect(classifyRecord("concepts/a.md", fm({ title: "Invoice INV-2026-000123", claims: [claim("f/a/b", "The invoice is dated 2026-09-14.")] }))?.month).toBe("2026-09");
    for (const type of ["entity", "synthesis", "decision"] as const) expect(classifyRecord("x/a.md", fm({ type, title: "Invoice 2026-09-14" }))).toBeNull();
    const byClaims = classifyRecord(
      "concepts/doc.md",
      fm({ title: "Document 4500012345 2026-08-02", claims: [claim("f/d/a", "Invoice no. 4500012345 is issued by Globex Ltd."), claim("f/d/b", "The total amount due is EUR 1.234,56.")] }),
    );
    expect(byClaims).toMatchObject({ type: "invoice", via: "claims", month: "2026-08", counterparty: "Globex Ltd", amount: { currency: "EUR", value: 1234.56 } });
  });

  it("lets a person's or the model's `record` frontmatter stand, and re-reads the rules' own", () => {
    const person = fm({ title: "Scan 0042 2026-07-01", record: { type: "customs", month: "2026-07" } });
    expect(classifyRecord("concepts/s.md", person)).toMatchObject({ type: "customs", via: "frontmatter", by: "owner" });
    const model = fm({ title: "Scan 0043 2026-07-02", record: { type: "receipt", month: "2026-07", by: "model" } });
    expect(classifyRecord("concepts/t.md", model)).toMatchObject({ type: "receipt", by: "model" });
    // `by: rules` is re-read: a title that is no record any more stops being one.
    expect(classifyRecord("concepts/u.md", fm({ title: "Meeting notes 2026-07-03", record: { type: "invoice", month: "2026-07", by: "rules" } }))).toBeNull();
  });

  it("keeps the month a person or the model set over a date the page reads, the same key the pass and the hubs use", () => {
    const person = fm({ title: "Invoice INV-2026-000555 2026-08-14", record: { type: "invoice", month: "2026-07" } });
    expect(classifyRecord("concepts/p.md", person)).toMatchObject({ type: "invoice", month: "2026-07", day: null, by: "owner" });
    expect(recordHubKey("concepts/p.md", person)).toBe("invoice/2026-07");
    const model = fm({ title: "Scan 0099 2026-08-02", record: { type: "receipt", month: "2026-07", by: "model" } });
    expect(classifyRecord("concepts/m.md", model)).toMatchObject({ month: "2026-07", by: "model" });
    expect(recordHubKey("concepts/m.md", model)).toBe("receipt/2026-07");
    // The rules' own month is read from the page again.
    const rules = fm({ title: "Invoice INV-2026-000556 2026-08-14", record: { type: "invoice", month: "2026-07", by: "rules" } });
    expect(classifyRecord("concepts/r.md", rules)?.month).toBe("2026-08");
    const snap = snapshot({
      "concepts/p1.md": leaf("Invoice INV-2026-000561 2026-08-14", [], { record: { type: "invoice", month: "2026-07" } }),
      "concepts/p2.md": leaf("Invoice INV-2026-000562 2026-08-15", [], { record: { type: "invoice", month: "2026-07" } }),
    });
    const plan = planStructure(snap, OPTIONS);
    expect(plan.writes.filter((w) => readStructureMeta(w.frontmatter)?.kind === "record-hub").map((w) => w.frontmatter.title)).toEqual(["Invoices 2026-07"]);
    expect(plan.writes.find((w) => w.path === "concepts/p1.md")?.frontmatter.record).toMatchObject({ month: "2026-07" });
  });

  it("reads amounts in either decimal style and sums per currency in cents", () => {
    expect(parseAmountNumber("1.234,56")).toBe(1234.56);
    expect(parseAmountNumber("1,234.56")).toBe(1234.56);
    expect(parseAmountNumber("1 234,5")).toBe(1234.5);
    expect(parseAmountNumber("1,234")).toBe(1234);
    expect(parseAmountNumber("12,5")).toBe(12.5);
    expect(amountsIn("Paid €12.50 and 3,000.00 USD; also 45 лв.")).toEqual([
      { currency: "EUR", value: 12.5 },
      { currency: "USD", value: 3000 },
      { currency: "BGN", value: 45 },
    ]);
    const tenths = Array.from({ length: 1000 }, () => ({ currency: "EUR", value: 0.1 }));
    expect(totalsByCurrency([...tenths, null, { currency: "USD", value: 2 }])).toEqual([
      { currency: "EUR", total: 100, count: 1000 },
      { currency: "USD", total: 2, count: 1 },
    ]);
  });

  it("names the counterparty without the document words before it, and never the owner's own company", () => {
    expect(companyNames("Invoice INV-2026-001 Globex Ltd")).toEqual(["Globex Ltd"]);
    const info = classifyRecord("concepts/i.md", fm({ title: "Invoice INV-2026-000777 2026-09-01", claims: [claim("f/i/a", "Issued by Acme Widgets Ltd to Initech GmbH.")] }), { ownCompany: OWN_COMPANY });
    expect(info?.counterparty).toBe("Initech GmbH");
  });
});

describe("monthly record hubs", () => {
  function month(): VaultSnapshot {
    const pages: Record<string, string> = {};
    for (let d = 1; d <= 6; d++) {
      const cp = d % 2 ? "Globex Ltd" : "Initech GmbH";
      pages[`concepts/invoice-inv-2026-00000${d}.md`] = leaf(`Invoice INV-2026-00000${d} ${cp}`, [`The invoice total is ${d % 3 ? "EUR" : "USD"} ${d}00.25, dated 2026-09-0${d}.`]);
    }
    pages["concepts/invoice-inv-2026-000099.md"] = leaf("Invoice INV-2026-000099 Globex Ltd", ["The invoice is dated 2026-10-02."]);
    pages["concepts/invoice-inv-2026-000098.md"] = leaf("Invoice INV-2026-000098 Hooli Inc", ["The invoice is dated 2026-10-05; the total is EUR 10.00."]);
    pages["concepts/receipt-rc-1.md"] = leaf("Receipt RC-0000001 2026-09-03", ["The receipt total is EUR 3.50."]);
    return snapshot(pages, "# Index\n");
  }

  it("builds one hub per type × month with the count, totals per currency and a table of leaves, and every leaf links up", () => {
    const snap = month();
    const plan = planStructure(snap, OPTIONS);
    const after = apply(snap, plan.writes);
    const hubs = ourPages(after, "record-hub");
    expect(hubs.map((h) => h.fm.title).sort()).toEqual(["Invoices 2026-09", "Invoices 2026-10"]); // one receipt makes no hub
    const sept = hubs.find((h) => h.fm.title === "Invoices 2026-09")!;
    expect(sept.fm).toMatchObject({ type: "synthesis", domain: "finance", owner: "Finance team", structure: { kind: "record-hub", type: "invoice", month: "2026-09", leaves: 6 } });
    expect(pageSummary(sept.body)).toBe("Invoices 2026-09: 6 invoices, 1,201.00 EUR and 900.50 USD in total.");
    expect(sept.body).toContain("| EUR | 1,201.00 | 4 |");
    expect(sept.body).toContain("| USD | 900.50 | 2 |");
    expect(sept.body).toContain("| 2026-09-01 | [Invoice INV-2026-000001 Globex Ltd](../concepts/invoice-inv-2026-000001.md) | Globex Ltd | 100.25 EUR |");
    expect(sept.body).toContain("## By counterparty");
    expect(sept.body).toContain("[[syntheses/invoices-2026-10]] — Invoices 2026-10 (next month)");
    expect(sept.fm.sources.length).toBeGreaterThan(0);
    for (let d = 1; d <= 6; d++) {
      const l = pageOf(after, `concepts/invoice-inv-2026-00000${d}.md`);
      expect(l.fm.record).toEqual({ type: "invoice", month: "2026-09", hub: sept.path, by: "rules" });
      const block = blockContent(l.body, RECORD_START, RECORD_END)!.split("\n");
      expect(block[0]).toBe("- Filed under [[syntheses/invoices-2026-09]] — Invoices 2026-09");
      // Its neighbours in the hub, in date order.
      if (d > 1) expect(block).toContain(`- Previous: [[concepts/invoice-inv-2026-00000${d - 1}]] — Invoice INV-2026-00000${d - 1} ${d % 2 ? "Initech GmbH" : "Globex Ltd"}`);
      if (d < 6) expect(block.some((x) => x.startsWith(`- Next: [[concepts/invoice-inv-2026-00000${d + 1}]]`))).toBe(true);
    }
    expect(plan.stats).toMatchObject({ leaves: 9, leavesInHubs: 8, recordHubs: 2 });
    expect(plan.stats.linksMedianAfter).toBeGreaterThan(plan.stats.linksMedianBefore);
  });

  it("is idempotent: a second run over its own result writes nothing", async () => {
    const holder = { current: month() };
    const first = fakeRun(holder);
    const r1 = await runStructurePass(holder.current, first.run, OPTIONS);
    expect(r1.written).toBeGreaterThan(0);
    const textBefore = new Map(holder.current.pages.map((p) => [p.path, p.text]));
    const second = fakeRun(holder);
    const r2 = await runStructurePass(holder.current, second.run, { ...OPTIONS, now: new Date("2026-11-01T00:00:00Z") });
    expect(r2.written).toBe(0);
    expect(second.commits).toEqual([]);
    expect(new Map(holder.current.pages.map((p) => [p.path, p.text]))).toEqual(textBefore);
  });

  it("keeps what a person wrote outside its blocks, byte for byte, when it regenerates", () => {
    const snap = month();
    let after = apply(snap, planStructure(snap, OPTIONS).writes);
    const hub = ourPages(after, "record-hub").find((h) => h.fm.title === "Invoices 2026-09")!;
    const note = "\n## Notes\n\nTwo of these were paid late; ask the supplier about terms.\n";
    const leafPath = "concepts/invoice-inv-2026-000002.md";
    const leafPage = pageOf(after, leafPath);
    after = apply(after, [
      { path: hub.path, frontmatter: hub.fm, body: `${hub.body.trimEnd()}\n${note}` },
      { path: leafPath, frontmatter: leafPage.fm, body: `${leafPage.body.trimEnd()}\n\nChecked by hand.\n` },
    ]);
    // A new leaf moves the hub's totals: the block is rewritten, the note is not.
    after = { ...after, pages: [...after.pages, vaultPage("concepts/invoice-inv-2026-000007.md", leaf("Invoice INV-2026-000007 Globex Ltd", ["The invoice total is EUR 1.00, dated 2026-09-07."]))] };
    const plan = planStructure(after, OPTIONS);
    const write = plan.writes.find((w) => w.path === hub.path)!;
    expect(write).toBeDefined();
    expect(write.body).toContain(note.trim());
    expect(write.body.endsWith(`${note.trim()}\n`)).toBe(true);
    expect(blockContent(write.body, HUB_START, HUB_END)).toContain("7 invoices");
    const leafAfter = apply(after, plan.writes);
    expect(pageOf(leafAfter, leafPath).body).toContain("Checked by hand.");
  });

  it("never rewrites a verified leaf or a hub a person verified, and counts them", () => {
    const snap = month();
    const verifiedLeaf = "concepts/invoice-inv-2026-000003.md";
    const pages = snap.pages.map((p) => (p.path === verifiedLeaf ? vaultPage(p.path, leaf("Invoice INV-2026-000003 Initech GmbH", ["The invoice total is USD 300.25, dated 2026-09-03."], { verified: { at: "2026-09-30", by: "owner" } })) : p));
    const plan = planStructure({ ...snap, pages }, OPTIONS);
    expect(plan.writes.some((w) => w.path === verifiedLeaf)).toBe(false);
    expect(plan.stats.skippedVerified).toBe(1);
    // Still listed in its hub.
    expect(plan.writes.find((w) => w.frontmatter.title === "Invoices 2026-09")!.body).toContain("invoice-inv-2026-000003.md");
  });

  it("gives a crowded month's big counterparties hubs of their own, cuts long lists into parts and files every leaf exactly once, lint-clean", () => {
    const pages: Record<string, string> = {};
    for (let i = 0; i < 130; i++) {
      const cp = i < 70 ? "Globex Ltd" : i < 76 ? "Initech GmbH" : COUNTERPARTIES[2 + (i % 4)];
      const day = String(1 + (i % 28)).padStart(2, "0");
      pages[`concepts/receipt-rc-${1000 + i}.md`] = leaf(`Receipt RC-000${1000 + i} ${cp}`, [`The receipt total is EUR ${i}.10, dated 2026-03-${day}.`]);
    }
    const snap = snapshot(pages, "# Index\n");
    const plan = planStructure(snap, OPTIONS);
    const after = apply(snap, plan.writes);
    const hubs = ourPages(after, "record-hub");
    const titles = hubs.map((h) => h.fm.title).sort();
    expect(titles).toContain("Receipts 2026-03");
    expect(titles).toContain("Receipts 2026-03 — Globex Ltd");
    expect(titles).toContain("Receipts 2026-03 — Globex Ltd (part 2)");
    expect(titles).toContain("Receipts 2026-03 — Initech GmbH");
    const listed = new Map<string, string>();
    for (const h of hubs) {
      for (const m of h.body.matchAll(/\]\(\.\.\/(concepts\/receipt-rc-\d+\.md)\)/g)) {
        expect(listed.has(m[1])).toBe(false);
        listed.set(m[1], h.path);
      }
      expect(h.body.length).toBeLessThan(LIMITS.bodySoftChars);
      expect((h.fm.structure as { leaves: number }).leaves).toBeLessThanOrEqual(HUB_PART_LEAVES);
    }
    expect(listed.size).toBe(130);
    for (const [leafPath, hubPath] of listed) expect(pageOf(after, leafPath).fm.record).toMatchObject({ hub: hubPath });
    // The month hub totals the whole month and links its counterparty hubs.
    const monthHub = hubs.find((h) => h.fm.title === "Receipts 2026-03")!;
    expect(pageSummary(monthHub.body)).toMatch(/^Receipts 2026-03: 130 receipts, /);
    expect(monthHub.body).toMatch(/\[Globex Ltd\]\(receipts-2026-03-globex-ltd\.md\)/);
    const report = lintVault(after, { now: NOW });
    expect(report.findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("takes over a connect hub of the same name instead of making a second one", () => {
    const snap = month();
    const connectHub = serializePage(
      frontmatter({ type: "synthesis", title: "Invoices 2026-09", domain: "finance", owner: "unassigned", generated: { at: "2026-09-01T00:00:00.000Z", by: "connect" }, sources: ["sources/x.pdf"], hub: { kind: "invoices", month: "2026-09", leaves: 6 } }),
      "Invoices 2026-09: 6 invoice pages of 2026-09, rolled up in one place.\n",
    );
    const withHub = { ...snap, pages: [...snap.pages, vaultPage("syntheses/invoices-2026-09.md", connectHub)] };
    const plan = planStructure(withHub, OPTIONS);
    const write = plan.writes.find((w) => w.path === "syntheses/invoices-2026-09.md")!;
    expect(write.created).toBe(false);
    expect(write.frontmatter.generated).toEqual({ at: "2026-09-01T00:00:00.000Z", by: "structure" });
    expect(write.frontmatter.hub).toBeUndefined();
    expect(write.body).not.toContain("rolled up in one place");
    expect(plan.writes.filter((w) => w.frontmatter.title === "Invoices 2026-09")).toHaveLength(1);
  });

  it("leaves leaves it filed out of connect's own hubs, so no second hub is made for them", async () => {
    const snap = month();
    const after = apply(snap, planStructure(snap, OPTIONS).writes);
    const connect = await planConnections(after, { now: NOW });
    expect(connect.writes.filter((w) => w.created && w.frontmatter.type === "synthesis")).toEqual([]);
  });
});

describe("domain hubs and the root", () => {
  it("makes one hub per configured domain with its owner, key facts (verified first), open review items, top entities and hubs; the root links them all", () => {
    const snap = snapshot(syntheticVault(400), "# Index\n");
    const reviewPage = snap.pages.find((p) => p.path.startsWith("concepts/marketing-topic"))!.path;
    const plan = planStructure(snap, { ...OPTIONS, domains: [...DOMAINS, { name: "legal", owner: "Counsel" }], reviewItems: [{ id: "rev-1", kind: "contradiction", pages: [reviewPage] }] });
    const after = apply(snap, plan.writes);
    const hubs = ourPages(after, "domain-hub");
    expect(hubs.map((h) => h.fm.domain).sort()).toEqual(["finance", "logistics", "marketing", "operations"]);
    expect(plan.stats.domainsEmpty).toEqual(["legal"]);
    const finance = hubs.find((h) => h.fm.domain === "finance")!;
    expect(finance.fm.owner).toBe("Finance team");
    expect(pageSummary(finance.body)).toMatch(/^The finance domain, owned by Finance team: \d+ pages and \d+ facts \(\d+ verified\), records from 2026-01 to 2026-12\.$/);
    expect(finance.body).toContain("## What it covers");
    const facts = finance.body.split("## Key facts")[1].split("##")[0].trim().split("\n");
    expect(facts[0].startsWith("- ✓ ")).toBe(true);
    const firstUnverified = facts.findIndex((l) => !l.startsWith("- ✓ "));
    if (firstUnverified >= 0) expect(facts.slice(firstUnverified).every((l) => !l.startsWith("- ✓ "))).toBe(true);
    expect(finance.body).toContain("Nothing waits for a decision in this domain.");
    const marketing = hubs.find((h) => h.fm.domain === "marketing")!;
    expect(marketing.body).toContain("1 item waits in Review");
    expect(marketing.body).toContain("- contradiction: [");
    expect(finance.body).toMatch(/## Top entities\n\n- \[\[entities\//);
    expect(finance.body).toMatch(/## Hubs\n\n- \[\[syntheses\/[a-z-]+-2026-12\]\] — [A-Z][a-z ]+ 2026-12\n/);
    const root = ourPages(after, "root");
    expect(root).toHaveLength(1);
    expect(root[0].fm.title).toBe(OWN_COMPANY);
    for (const h of hubs) expect(root[0].body).toContain(`[[${h.path.replace(/\.md$/, "")}]]`);
    expect(root[0].body).toContain("[[syntheses/decisions-register]]");
    // Every page the pass made is reached from another content page.
    const graph = buildLinkGraph(after.pages.flatMap((p) => (p.parsed.ok ? [{ path: p.path, title: p.parsed.frontmatter.title, body: p.parsed.body }] : [])), null);
    for (const p of [...hubs, ...root, ...ourPages(after, "record-hub"), ...ourPages(after, "decisions")]) expect(graph.inbound.get(p.path)?.size ?? 0).toBeGreaterThan(0);
  });

  it("names the root page after no company when none is set, and keeps its place when one is set later", () => {
    const snap = snapshot(syntheticVault(120), "# Index\n");
    const first = apply(snap, planStructure(snap, { ...OPTIONS, company: "" }).writes);
    const root = ourPages(first, "root")[0];
    expect(root.fm.title).toBe("Company overview");
    const renamed = planStructure(first, OPTIONS).writes.find((w) => w.path === root.path)!;
    expect(renamed.frontmatter.title).toBe(OWN_COMPANY);
  });
});

describe("entity enrichment", () => {
  it("adds role, counterparties, totals and first/last seen to the top entities, within the claim cap, idempotently", () => {
    const snap = snapshot(syntheticVault(300), "# Index\n");
    const plan = planStructure(snap, { ...OPTIONS, enrichTop: 3 });
    expect(plan.stats.entitiesEnriched).toBe(3);
    const after = apply(snap, plan.writes);
    const enriched = after.pages.filter((p) => p.parsed.ok && p.parsed.frontmatter.claims.some((c) => c.origin === "structure"));
    expect(enriched).toHaveLength(3);
    for (const p of enriched) {
      const f = p.parsed.ok ? p.parsed.frontmatter : null;
      const ours = f!.claims.filter((c) => c.origin === "structure");
      expect(ours.length).toBeLessThanOrEqual(ENRICH_MAX_CLAIMS);
      expect(ours.map((c) => c.id.split("/")[2])).toEqual(expect.arrayContaining(["structure-role", "structure-first-seen", "structure-last-seen"]));
      const role = ours.find((c) => c.id.endsWith("/structure-role"))!;
      expect(role.text).toMatch(/is the counterparty on \d+ records in this wiki: /);
      const totals = ours.find((c) => c.id.endsWith("/structure-totals"));
      expect(totals?.text).toMatch(/^The records with .+ total [\d,]+\.\d\d [A-Z]{3}/);
      expect(totals?.as_of).toMatch(/^2026-\d\d-\d\d$/);
      for (const c of ours) expect(c.text.length).toBeLessThanOrEqual(LIMITS.claimMaxChars);
    }
    expect(lintVault(after, { now: NOW }).findings.filter((f) => f.blocksCommit)).toEqual([]);
    expect(planStructure(after, { ...OPTIONS, enrichTop: 3 }).writes).toEqual([]);
  });

  it("never passes lint's claim cap, never reuses a retired id and never touches a verified entity", () => {
    const pages = syntheticVault(200);
    const crowded = "entities/globex-ltd.md";
    pages[crowded] = structurePage(
      { type: "entity", title: "Globex Ltd", domain: "finance", sources: ["sources/globex.md"], claims: Array.from({ length: LIMITS.maxClaims - 2 }, (_, i) => claim(`finance/globex-ltd/fact-${i}`, `Globex Ltd fact ${i}.`)), retiredClaimIds: ["finance/globex-ltd/structure-role"] },
      "Globex Ltd.\n",
    );
    pages["entities/initech-gmbh.md"] = structurePage({ type: "entity", title: "Initech GmbH", domain: "logistics", sources: ["sources/initech.md"], verified: { at: "2026-09-01", by: "owner" } }, "Initech GmbH.\n");
    const plan = planStructure(snapshot(pages, "# Index\n"), { ...OPTIONS, enrichTop: 8 });
    const globex = plan.writes.find((w) => w.path === crowded)!;
    expect(globex.frontmatter.claims).toHaveLength(LIMITS.maxClaims);
    expect(globex.frontmatter.claims.some((c) => c.id === "finance/globex-ltd/structure-role")).toBe(false);
    expect(plan.writes.some((w) => w.path === "entities/initech-gmbh.md")).toBe(false);
  });
});

describe("the decisions register", () => {
  it("collects decision pages and decision claims, newest first, with date, decider and source", () => {
    const pages: Record<string, string> = {
      "concepts/use-globex.md": structurePage({ type: "decision", title: "Use Globex Ltd for widgets", domain: "finance", sources: ["sources/minutes-1.md"], date: "2026-03-01", decider: "Board" } as Partial<PageFrontmatter>, "Decided.\n"),
      "concepts/q3-plan.md": structurePage(
        { type: "concept", title: "Q3 plan", domain: "operations", owner: "Ops lead", sources: ["sources/q3.md"], claims: [claim("operations/q3-plan/ship-weekly", "Ship weekly from July.", { type: "decision", as_of: "2026-06-15", evidence: [{ kind: "source", path: "sources/q3-minutes.md" }] })] },
        "The Q3 plan.\n",
      ),
      "concepts/old-call.md": structurePage({ type: "decision", title: "Drop the fax line", domain: "operations", sources: ["sources/old.md"], decided_by: "Managing director", generated: { at: "2025-11-20T09:00:00.000Z", by: "flash" } } as Partial<PageFrontmatter>, "Done.\n"),
    };
    const snap = snapshot(pages, "# Index\n");
    const after = apply(snap, planStructure(snap, OPTIONS).writes);
    const register = ourPages(after, "decisions");
    expect(register).toHaveLength(1);
    const rows = register[0].body.split("\n").filter((l) => /^\| \d{4}-/.test(l));
    expect(rows).toEqual([
      "| 2026-06-15 | [Ship weekly from July.](../concepts/q3-plan.md) | Ops lead | sources/q3-minutes.md |",
      "| 2026-03-01 | [Use Globex Ltd for widgets](../concepts/use-globex.md) | Board | sources/minutes-1.md |",
      "| 2025-11-20 | [Drop the fax line](../concepts/old-call.md) | Managing director | sources/old.md |",
    ]);
  });

  it("moves older decisions to pages of their own years once the register is full", () => {
    const pages: Record<string, string> = {};
    for (let i = 0; i < REGISTER_ROWS + 30; i++) {
      const year = i < REGISTER_ROWS ? 2026 : 2024 + (i % 2);
      pages[`concepts/decision-${i}.md`] = structurePage({ type: "decision", title: `Decision number ${i}`, domain: "operations", sources: [`sources/d${i}.md`], date: `${year}-0${1 + (i % 9)}-1${i % 10}` } as Partial<PageFrontmatter>, "Decided.\n");
    }
    const snap = snapshot(pages, "# Index\n");
    const after = apply(snap, planStructure(snap, OPTIONS).writes);
    const all = ourPages(after, "decisions");
    const main = all.find((p) => !readStructureMeta(p.fm)?.year)!;
    expect(main.body.split("\n").filter((l) => /^\| \d{4}-/.test(l))).toHaveLength(REGISTER_ROWS);
    expect(all.map((p) => p.fm.title).sort()).toEqual(["Decisions register", "Decisions register 2024", "Decisions register 2025"]);
    expect(main.body).toContain("[[syntheses/decisions-register-2025]]");
  });
});

describe("links per page", () => {
  it("counts each other content page once, either way, and ignores sources and missing pages", () => {
    const g = buildLinkGraph(
      [
        { path: "concepts/a.md", body: "[[concepts/b]] [[concepts/c]] [[sources/s]] [[concepts/nowhere]]" },
        { path: "concepts/b.md", body: "[[concepts/a]]" },
        { path: "concepts/c.md", body: "" },
        { path: "sources/s.md", body: "[[concepts/c]]" },
      ],
      null,
    );
    expect(linkDensity(g)).toEqual({ pages: 3, median: 1, mean: 1.33, atTarget: 0, target: 5 });
  });

  it("keeps Status's links metric until a page changes", () => {
    const snap = snapshot({ "concepts/a.md": structurePage({ title: "A" }, "[[concepts/b]]\n"), "concepts/b.md": structurePage({ title: "B" }, "B.\n") });
    const first = statusLinkDensity("/synthetic-cache-vault", snap);
    expect(first).toMatchObject({ pages: 2, median: 1 });
    expect(statusLinkDensity("/synthetic-cache-vault", snap)).toBe(first);
    const grown = { ...snap, pages: [...snap.pages, vaultPage("concepts/c.md", structurePage({ title: "C" }, "[[concepts/a]]\n"))] };
    const second = statusLinkDensity("/synthetic-cache-vault", grown);
    expect(second).not.toBe(first);
    expect(second).toMatchObject({ pages: 3 });
  });

  it("lifts the median to the target on the synthetic vault: a leaf links its hub, its counterparty, its neighbours and the counterparty's", () => {
    const snap = snapshot(syntheticVault(600), "# Index\n");
    const plan = planStructure(snap, OPTIONS);
    expect(plan.stats.linksMedianBefore).toBeLessThanOrEqual(1);
    expect(plan.stats.linksMedianAfter).toBeGreaterThanOrEqual(5);
    const leafWrite = plan.writes.find((w) => w.frontmatter.record && w.body.includes("- Counterparty: [[entities/") && w.body.includes("- Earlier with "));
    expect(leafWrite).toBeDefined();
  });
});

describe("search ranking", () => {
  const base = { kind: "page" as const, text: "t", verified: false };
  it("never ranks a leaf above its hub, and caps its score at the hub's", () => {
    const hits = rankVaultHits(
      [
        { ...base, path: "concepts/invoice-1.md", refId: "concepts/invoice-1", type: "reference", title: "Invoice 1", similarity: 0.9, hub: "syntheses/invoices-2026-09.md" },
        { ...base, path: "concepts/invoice-1.md", refId: "finance/invoice-1/total", kind: "claim", type: "reference", title: "Invoice 1", similarity: 0.88, hub: "syntheses/invoices-2026-09.md" },
        { ...base, path: "syntheses/invoices-2026-09.md", refId: "syntheses/invoices-2026-09", type: "synthesis", title: "Invoices 2026-09", similarity: 0.5 },
        { ...base, path: "concepts/other.md", refId: "concepts/other", type: "concept", title: "Other", similarity: 0.7 },
      ] satisfies RankCandidate[],
      10,
    );
    expect(hits.map((h) => h.id)).toEqual(["concepts/other", "syntheses/invoices-2026-09", "concepts/invoice-1", "finance/invoice-1/total"]);
    expect(hits[2].score).toBeLessThanOrEqual(hits[1].score);
  });

  it("leaves a leaf alone when its hub is not among the hits, and a page with no hub as it was", () => {
    const hits = rankVaultHits([{ ...base, path: "concepts/a.md", refId: "concepts/a", type: "reference", title: "A", similarity: 0.9, hub: "syntheses/x.md" }], 5);
    expect(hits[0]).toMatchObject({ id: "concepts/a", score: 0.9 });
  });

  it("indexes a leaf with its hub and without its link up", () => {
    const text = serializePage(fm({ title: "Invoice INV-2026-000001 Globex Ltd", record: { type: "invoice", month: "2026-09", hub: "syntheses/invoices-2026-09.md", by: "rules" } }), upsertBlock("Invoice one.\n", RECORD_START, RECORD_END, "Filed under [[syntheses/invoices-2026-09]] — Invoices 2026-09."));
    const units = pageIndexUnits("concepts/invoice-1.md", text)!;
    expect(units.hub).toBe("syntheses/invoices-2026-09.md");
    expect(units.units.some((u) => u.text.includes("Filed under"))).toBe(false);
  });
});

describe("the contradiction pass inside a hub", () => {
  // Two invoices of one month from one supplier: its VAT number on both is a shared reference, so before
  // the hub rule the pass paired their totals.
  const pages = {
    "concepts/invoice-inv-2026-000001.md": leaf("Invoice INV-2026-000001 Globex Ltd", ["Globex Ltd, VAT number XX123456789, invoiced a total of EUR 120.00 on 2026-09-01."]),
    "concepts/invoice-inv-2026-000002.md": leaf("Invoice INV-2026-000002 Globex Ltd", ["Globex Ltd, VAT number XX123456789, invoiced a total of EUR 450.00 on 2026-09-14."]),
    "concepts/invoice-inv-2026-000003.md": leaf("Invoice INV-2026-000003 Globex Ltd", ["Globex Ltd, VAT number XX123456789, invoiced a total of EUR 99.00 on 2026-10-02."]),
  };

  it("never pairs two leaves of one hub, before and after the structure pass wrote it", () => {
    for (const snap of [snapshot(pages), (() => { const s = snapshot(pages); return apply(s, planStructure(s, OPTIONS).writes); })()]) {
      const claims = collectClaims(snap);
      const [a, b, c] = ["000001", "000002", "000003"].map((n) => claims.find((x) => x.page.includes(n))!);
      expect(a.hub).toBe("invoice/2026-09");
      expect(comparable(a, b)).toBe(false);
      expect(noPairReason(a, b)).toMatchObject({ code: "same-hub" });
      // Another month is another hub: this rule does not part them (the identifier rules still may).
      expect(noPairReason(a, c)?.code).not.toBe("same-hub");
    }
  });

  it("gives the re-judge the same answer as the pass", () => {
    const snap = snapshot(pages);
    const map = new Map<string, RejudgePage>(snap.pages.map((p) => [p.path, { title: p.parsed.ok ? p.parsed.frontmatter.title : "", type: "reference", frontmatter: p.parsed.ok ? p.parsed.frontmatter : undefined }]));
    const fmA = pageOf(snap, "concepts/invoice-inv-2026-000001.md").fm;
    const fmB = pageOf(snap, "concepts/invoice-inv-2026-000002.md").fm;
    const verdict = rejudgeVerdict(
      {
        kind: "contradiction",
        createdAt: "2026-09-20T00:00:00.000Z",
        candidates: [
          { text: fmA.claims[0].text, page: "concepts/invoice-inv-2026-000001.md", claimId: fmA.claims[0].id, evidence: [] },
          { text: fmB.claims[0].text, page: "concepts/invoice-inv-2026-000002.md", claimId: fmB.claims[0].id, evidence: [] },
        ],
      },
      map,
    );
    expect(verdict?.code).toBe("same-hub");
  });

  it("keeps the hub key off pages that are no leaves", () => {
    expect(recordHubKey("concepts/x.md", fm({ title: "Widget pricing" }))).toBeNull();
    expect(pairable({ text: "a", subject: { entity: "x", words: new Set(["a"]), mentions: new Set() } as never, hub: null }, { text: "a", subject: { entity: "x", words: new Set(["a"]), mentions: new Set() } as never, hub: null })).toBe(true);
  });
});

describe("the cheap-model fallback", () => {
  it("asks only about record-like, dated pages the rules could not type, and reads a tolerant answer", () => {
    const snap = snapshot({
      "concepts/statement.md": leaf("Statement 2026-09 Globex Ltd", ["The statement lists four movements."]),
      "concepts/invoice.md": leaf("Invoice INV-2026-000001 2026-09-01"),
      "concepts/topic.md": leaf("Widget pricing"),
      "concepts/undated.md": leaf("Payment confirmation PC-12345"),
    });
    const asked = modelCandidates(snap.pages);
    expect(asked.map((c) => c.path)).toEqual(["concepts/statement.md"]);
    expect(modelCandidates(snap.pages, new Set([asked[0].key]))).toEqual([]);
    // The change key: the path and a SHA-256 digest of what the model is shown; a changed fact is a new key.
    expect(asked[0].key).toBe(changeKey("concepts/statement.md", "Statement 2026-09 Globex Ltd", ["The statement lists four movements."]));
    expect(asked[0].key).toMatch(/^concepts\/statement\.md@[0-9a-f]{16}$/);
    expect(changeKey("concepts/statement.md", "Statement 2026-09 Globex Ltd", ["The statement lists five movements."])).not.toBe(asked[0].key);
    // A verified page is never rewritten, so a type the model gave it would never be kept: it is never asked (else every night's cap goes to it again).
    const verified = snapshot({ "concepts/statement-v.md": leaf("Statement 2026-09 Initech GmbH", ["The statement lists two movements."], { verified: { at: "2026-09-30", by: "owner" } }) });
    expect(modelCandidates(verified.pages)).toEqual([]);
    const prompt = buildClassifyPrompt(asked);
    expect(prompt.user).toContain("ITEMS (JSON):");
    expect(parseClassifyResponse('Sure:\n```json\n[{"i": 0, "type": "bank-transfer"}, {"i": 7, "type": "invoice"}, {"i": 0}]\n```', 1)).toEqual(new Map([[0, "bank-transfer"]]));
    expect(parseClassifyResponse('[{"i":0,"type":"invoice"},{"i":0,"type":"receipt"}]', 1).size).toBe(0);
    const plan = planStructure(snap, { ...OPTIONS, assigned: new Map([["concepts/statement.md", "bank-transfer" as RecordType]]) });
    expect(plan.writes.find((w) => w.path === "concepts/statement.md")?.frontmatter.record).toEqual({ type: "bank-transfer", month: "2026-09", by: "model" });
  });
});

describe("structure settings", () => {
  it("default to on, read every field strictly and put a section back with null", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-structure-settings-"));
    try {
      expect(readSettings(root).structure).toEqual({ enabled: true, company: "", enrichTop: 25, modelFallback: 25 });
      const saved = writeSettings({ structure: { company: " Acme\u0007Widgets Ltd ", enrichTop: 0 } }, root);
      expect(saved.structure).toEqual({ enabled: true, company: "Acme Widgets Ltd", enrichTop: 0, modelFallback: 25 });
      expect(() => writeSettings({ structure: { enrichTop: 500 } }, root)).toThrow(SettingsError);
      expect(() => writeSettings({ structure: { modelFallback: -1 } }, root)).toThrow(SettingsError);
      expect(() => writeSettings({ structure: { company: "x".repeat(81) } }, root)).toThrow(/at most 80 characters/);
      expect(() => readSettingsPatch({ structure: { colour: "red" } })).toThrow(/Unknown setting: structure\.colour/);
      expect(readSettings(root).structure.enrichTop).toBe(0);
      expect(writeSettings({ structure: null }, root).structure.enrichTop).toBe(25);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the cheap-model fallback on a state database", () => {
  function record(n: number): Record<string, string> {
    const pages: Record<string, string> = {};
    for (let i = 0; i < n; i++) pages[`concepts/statement-${i}.md`] = leaf(`Statement 2026-0${1 + (i % 9)} Globex Ltd ${i}`, ["The statement lists four movements."]);
    return pages;
  }
  function client(answer: (items: number) => string, asked: number[]): FlashClient {
    return {
      model: "deepseek-v4-flash",
      async complete(req) {
        const items = (JSON.parse(req.user.split("ITEMS (JSON):\n")[1]) as unknown[]).length;
        asked.push(items);
        return { text: answer(items), model: "deepseek-v4-flash", usage: { promptTokens: 400, completionTokens: 40, cacheHitTokens: 0 } };
      },
    };
  }

  it("asks at most its cap in one recorded call, remembers a 'none', never asks on a dry run or with no cap, and never throws", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-structure-model-"));
    const stateVault = path.join(root, "vault");
    try {
      const snap = snapshot(record(5));
      const asked: number[] = [];
      const answers = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ i, type: i === 0 ? "none" : "bank-transfer" })));
      const opts = { stateVault, rates: DEFAULT_COST_RATES, runId: "run-structure-test", now: () => NOW };

      expect(await classifyWithModel(snap, { ...opts, cap: 3, client: client(answers, asked), dryRun: true })).toMatchObject({ candidates: 5, asked: 0, skipped: "dry_run" });
      expect(await classifyWithModel(snap, { ...opts, cap: 0, client: client(answers, asked) })).toMatchObject({ asked: 0, skipped: "disabled" });
      expect(asked).toEqual([]);

      const first = await classifyWithModel(snap, { ...opts, cap: 3, client: client(answers, asked) });
      expect(asked).toEqual([3]);
      expect(first).toMatchObject({ candidates: 5, asked: 3, calls: 1 });
      expect(first.assigned.size).toBe(2);
      expect([...first.assigned.values()]).toEqual(["bank-transfer", "bank-transfer"]);
      expect(readCosts(stateVault, "run-structure-test")).toMatchObject([{ operation: "structure-classify", model: "deepseek-v4-flash", tokensIn: 400, tokensOut: 40 }]);

      // The page the model called none is not asked again (until its title or facts change).
      const second = await classifyWithModel(snap, { ...opts, cap: 10, client: client(answers, asked) });
      expect(second.candidates).toBe(4);
      expect(asked).toEqual([3, 4]);

      const failing: FlashClient = { model: "deepseek-v4-flash", complete: async () => { throw new FlashCallError("refused", "the proxy refused the call"); } };
      const failed = await classifyWithModel(snap, { ...opts, cap: 3, client: failing });
      expect(failed.assigned.size).toBe(0);
      expect(failed.skipped).toMatch(/^failed: /);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("managed blocks a person broke", () => {
  it("never takes a person's text when they deleted a block's end or start marker", () => {
    const leafBody = `Invoice one.\n\n${RECORD_START}\n- Filed under [[syntheses/old]] — Old\n\nPaid by hand on the 3rd.\n`;
    const once = upsertBlock(leafBody, RECORD_START, RECORD_END, "- Filed under [[syntheses/new]] — New");
    const twice = upsertBlock(once, RECORD_START, RECORD_END, "- Filed under [[syntheses/newer]] — Newer");
    for (const b of [once, twice]) {
      expect(b).toContain("Paid by hand on the 3rd.");
      expect(b.split(RECORD_START)).toHaveLength(2);
      expect(b.split(RECORD_END)).toHaveLength(2);
    }
    expect(blockContent(twice, RECORD_START, RECORD_END)).toBe("- Filed under [[syntheses/newer]] — Newer");
    const loneEnd = upsertBlock(`Notes kept.\n${HUB_END}\nMore notes.\n`, HUB_START, HUB_END, "Fresh.", "start");
    expect(loneEnd).toBe(`${HUB_START}\nFresh.\n${HUB_END}\n\nNotes kept.\nMore notes.\n`);
    // An intact block is replaced in place, as before.
    expect(upsertBlock(`A.\n\n${HUB_START}\nold\n${HUB_END}\n\nB.\n`, HUB_START, HUB_END, "new", "start")).toBe(`A.\n\n${HUB_START}\nnew\n${HUB_END}\n\nB.\n`);
  });
});

describe("the cheap-model fallback in batches", () => {
  it("asks CLASSIFY_BATCH pages a call with an answer cap by size, and stops at a failed call without counting its pages", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-structure-batches-"));
    const stateVault = path.join(root, "vault");
    try {
      const pages: Record<string, string> = {};
      for (let i = 0; i < 250; i++) pages[`concepts/statement-${String(i).padStart(3, "0")}.md`] = leaf(`Statement 2026-0${1 + (i % 9)} Globex Ltd ${i}`, ["The statement lists movements."]);
      const snap = snapshot(pages);
      const calls: Array<{ items: number; maxTokens: number }> = [];
      const answering = (failAfter = Infinity): FlashClient => ({
        model: "deepseek-v4-flash",
        async complete(req) {
          if (calls.length >= failAfter) throw new FlashCallError("refused", "the proxy refused the call");
          const items = (JSON.parse(req.user.split("ITEMS (JSON):\n")[1]) as unknown[]).length;
          calls.push({ items, maxTokens: req.maxTokens });
          return { text: JSON.stringify(Array.from({ length: items }, (_, i) => ({ i, type: "bank-transfer" }))), model: "deepseek-v4-flash", usage: { promptTokens: 100, completionTokens: 20 * items, cacheHitTokens: 0 } };
        },
      });
      const opts = { stateVault, rates: DEFAULT_COST_RATES, runId: "run-batches", now: () => NOW };
      const all = await classifyWithModel(snap, { ...opts, cap: 250, client: answering() });
      expect(CLASSIFY_BATCH).toBe(100);
      expect(calls).toEqual([
        { items: 100, maxTokens: classifyMaxTokens(100) },
        { items: 100, maxTokens: classifyMaxTokens(100) },
        { items: 50, maxTokens: classifyMaxTokens(50) },
      ]);
      expect(all).toMatchObject({ candidates: 250, asked: 250, calls: 3 });
      expect(all.assigned.size).toBe(250);
      expect(readCosts(stateVault, "run-batches")).toHaveLength(3);

      calls.length = 0;
      const partial = await classifyWithModel(snap, { ...opts, cap: 250, client: answering(1) });
      expect(partial).toMatchObject({ asked: 100, calls: 1, skipped: expect.stringMatching(/^failed: /) });
      expect(partial.assigned.size).toBe(100);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
