/**
 * Cutting false contradictions: template words never make two claims one
 * subject, dated facts supersede instead of contradicting, a draft and its
 * final are one document, an owner-verified claim wins, and the re-judge
 * closes the open items these rules would not raise — while the planted REAL
 * contradictions (one company with two legal forms, one invoice with two
 * totals) are still raised. Every name, number and page here is invented.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { collectClaims, comparable, createHashEmbedder, runContradictionPass, type PassClaim } from "@/lib/prime-radiant/contradictions";
import type { FlashClient } from "@/lib/prime-radiant/flash-client";
import { readJudgeItems } from "@/lib/prime-radiant/judge";
import { lintVault } from "@/lib/prime-radiant/lint";
import { noPairReason, pairable } from "@/lib/prime-radiant/pairing";
import { rejudgeOpenContradictions, rejudgeSummary, rejudgeVerdict, titleFromPath } from "@/lib/prime-radiant/rejudge";
import { addReviewItem, getReviewItem, settleReviewItem, type ReviewCandidate } from "@/lib/prime-radiant/review-store";
import { validateFrontmatter } from "@/lib/prime-radiant/schema";
import { claimSubject, nameWords, sameSubject } from "@/lib/prime-radiant/subject";
import { historicalClaim, pageValidity, periodsDisjoint, laterOf, textValidity, type Validity } from "@/lib/prime-radiant/validity";
import { ownerVerified, readStaleClaims } from "@/lib/prime-radiant/verify";
import { documentName, sameDocument, versionGroups } from "@/lib/prime-radiant/versions";
import { buildPage, claimDates, parseWriterResponse, type BuildContext } from "@/lib/prime-radiant/writer";
import type { Claim, PageFrontmatter } from "@/lib/prime-radiant/schema";
import { claim, frontmatter, pageText, snapshot } from "../helpers/prime-radiant-fixtures";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-false-"));
let n = 0;
let vault = "";
beforeEach(() => {
  vault = path.join(base, `case-${++n}`, "vault");
  fs.mkdirSync(vault, { recursive: true });
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

const WRITTEN = "2026-10-16T08:00:00.000Z";
const OWNER = { at: "2026-10-01T09:00:00.000Z", by: "owner" };
const ASSISTANT = { at: "2026-10-01T09:00:00.000Z", by: "assistant" };

/** A page of the synthetic vault: its title, its claims (id → text, or a claim), and anything else. */
function page(title: string, claims: Array<Claim>, extra: Partial<PageFrontmatter> = {}): string {
  return pageText({ title, claims, generated: { at: WRITTEN, by: "flash" }, ...extra });
}
const c = (id: string, text: string, extra: Partial<Claim> = {}) => claim(id, text, { updatedAt: WRITTEN, ...extra });

/**
 * The vault: false pairs of every kind an owner's sample showed, and the
 * real ones that must survive.
 */
const PAGES: Record<string, string> = {
  // Two credit notes of one type, two different documents.
  "concepts/credit-note-draft-starter-pack-9.md": page("Credit note draft Starter pack 9", [c("finance/credit-note-draft-starter-pack-9/net", "Net amount is €7.50.")]),
  "concepts/credit-note-draft-hardware-kit-512.md": page("Credit note draft Hardware kit 512", [c("finance/credit-note-draft-hardware-kit-512/net", "Net amount is €429.75.")]),
  // Two transfers to two payees: neither page is a record by the identifier rules, the words tell them apart.
  "concepts/transfer-to-northwind-traders.md": page("Transfer to Northwind Traders for packaging", [c("finance/transfer-to-northwind-traders/bank", "The beneficiary bank is First Harbor Bank.")]),
  "concepts/payment-to-contoso-printing.md": page("Payment to Contoso Printing for panels", [c("finance/payment-to-contoso-printing/bank", "The beneficiary bank is Lakeside Credit Union.")]),
  // One declaration, the .docx draft (dated, date left blank) and the .pdf final.
  "concepts/export-declaration-fabrikam-inv-2026-0021-docx-23-02-2026.md": page("Export declaration Fabrikam INV-2026-0021 docx 23.02.2026", [
    c("customs/export-declaration-fabrikam-inv-2026-0021-docx/invoice", "The declaration cites invoice INV-2026-0021 with the date left blank."),
  ]),
  "concepts/export-declaration-fabrikam-inv-2026-0021-pdf.md": page("Export declaration Fabrikam INV-2026-0021 pdf", [
    c("customs/export-declaration-fabrikam-inv-2026-0021-pdf/invoice", "The declaration cites invoice INV-2026-0021 dated 18.02.2026."),
  ]),
  // A nightly report's figure on two days: superseded, not contradicted.
  "concepts/finance-nightly-12-10.md": page("Finance nightly 12.10 published", [c("finance/finance-nightly-12-10/unmatched", "24 payments of €500 or more have no linked document.")]),
  "concepts/finance-nightly-14-10.md": page("Finance nightly 14.10 published", [c("finance/finance-nightly-14-10/unmatched", "15 payments of €500 or more have no linked document.")]),
  // A launch price against today's.
  "concepts/widget-pro-launch.md": page("Widget Pro launch plan", [c("sales/widget-pro-launch/price", "The Widget Pro launch price was €399.")]),
  "concepts/widget-pro.md": page("Widget Pro", [c("sales/widget-pro/price", "The Widget Pro costs €749.")]),
  // REAL: one company (one company id), two legal forms, on two declarations.
  "concepts/export-declaration-mrn-26xx000111a0000001.md": page("Export declaration MRN 26XX000111A0000001 for Initech", [
    c("customs/export-declaration-mrn-26xx000111a0000001/exporter", "The exporter on this declaration is Northwind Robotics EOOD with exporter TIN XX999000111."),
  ]),
  "concepts/import-declaration-12-dev-kits.md": page("Import declaration for 12 dev kits from Umbrella", [
    c("customs/import-declaration-12-dev-kits/importer", "Northwind Robotics OOD is the importer on this declaration with TIN XX999000111."),
  ]),
  // REAL: one invoice, two totals, on its own page and on a reminder that cites it.
  "concepts/invoice-inv-2026-0042-fabrikam.md": page("Invoice INV-2026-0042 Fabrikam", [c("finance/invoice-inv-2026-0042-fabrikam/total", "The total due on invoice INV-2026-0042 is €1,200.00.")]),
  "concepts/payment-reminder-fabrikam.md": page("Payment reminder to Fabrikam", [c("finance/payment-reminder-fabrikam/total", "The total due on invoice INV-2026-0042 is €1,250.00.")]),
  // An owner-verified claim and one against it; an assistant-verified one wins nothing.
  "concepts/northwind-support.md": page("Northwind support hours", [
    c("ops/northwind-support/hours", "The Northwind support line is open from 9 to 17.", { status: "verified", verified: OWNER }),
  ]),
  "concepts/support-faq.md": page("Support FAQ", [c("ops/support-faq/hours", "The Northwind support line is open from 8 to 16.")]),
};

function claimsById(pages: Record<string, string> = PAGES): Map<string, PassClaim> {
  return new Map(collectClaims(snapshot(pages)).map((x) => [x.id, x]));
}

describe("rule 1: template words never make two claims one subject", () => {
  const all = claimsById();
  const pair = (a: string, b: string) => noPairReason(all.get(a)!, all.get(b)!);

  it("parts two credit notes and two transfers of one type", () => {
    expect(comparable(all.get("finance/credit-note-draft-starter-pack-9/net")!, all.get("finance/credit-note-draft-hardware-kit-512/net")!)).toBe(false);
    expect(pair("finance/transfer-to-northwind-traders/bank", "finance/payment-to-contoso-printing/bank")).toMatchObject({ code: "different-subjects" });
  });

  it("reads a field-only claim as its page's: the page's name, without type, format or date", () => {
    const s = claimSubject("finance/transfer-to-northwind-traders/bank", "The beneficiary bank is First Harbor Bank.", "Transfer to Northwind Traders for packaging");
    expect([...s.words]).toEqual(expect.arrayContaining(["beneficiary", "bank", "northwind", "trader", "packaging"]));
    expect(s.words.has("transfer")).toBe(false);
    expect([...nameWords("Export declaration Fabrikam INV-2026-0021 pdf 23.02.2026")]).not.toEqual(expect.arrayContaining(["pdf", "declaration"]));
  });

  it("never takes an entity of template words for one subject", () => {
    const a = claimSubject("finance/credit-note-draft/a", "Starter pack credit is €7.50.");
    const b = claimSubject("finance/credit-note-draft/b", "Hardware kit credit is €429.75.");
    expect(a.entityNamed).toBe(false);
    expect(sameSubject(a, b)).toBe(false);
    // A named entity still makes one subject, as before.
    expect(sameSubject(claimSubject("sales/widget-pro/a", "Blue is in stock."), claimSubject("sales/widget-pro/b", "Red is sold out."))).toBe(true);
  });

  it("reads a leading count as the fact's value, not a numbered subject", () => {
    const a = claimSubject("x/report/a", "24 payments of €500 or more have no linked document.", "Finance report");
    const b = claimSubject("x/report-2/b", "15 payments of €500 or more have no linked document.", "Finance report");
    expect(sameSubject(a, b)).toBe(true);
  });

  it("still raises one company with two legal forms, named by one company id (planted, real)", () => {
    const a = all.get("customs/export-declaration-mrn-26xx000111a0000001/exporter")!;
    const b = all.get("customs/import-declaration-12-dev-kits/importer")!;
    expect(noPairReason(a, b)).toBeNull();
    expect(comparable(a, b)).toBe(true);
  });

  it("still raises one invoice with two totals, on its page and on another that cites it (planted, real)", () => {
    expect(pair("finance/invoice-inv-2026-0042-fabrikam/total", "finance/payment-reminder-fabrikam/total")).toBeNull();
    // One invoice number on two customers' pages, scoped claims: one invoice, so a question.
    const pages = {
      "concepts/invoice-inv-2026-0050-fabrikam.md": page("Invoice INV-2026-0050 Fabrikam", [c("finance/invoice-inv-2026-0050-fabrikam/total", "The total due is €644.00.")]),
      "concepts/invoice-inv-2026-0050-contoso.md": page("Invoice INV-2026-0050 Contoso", [c("finance/invoice-inv-2026-0050-contoso/total", "The total due is €584.00.")]),
    };
    const two = claimsById(pages);
    expect(comparable(two.get("finance/invoice-inv-2026-0050-fabrikam/total")!, two.get("finance/invoice-inv-2026-0050-contoso/total")!)).toBe(true);
  });
});

describe("rule 2: dated facts", () => {
  it("reads a period only from what says it is one", () => {
    expect(textValidity("The list price is €749 since 22.09.2026.", WRITTEN)).toMatchObject({ from: "2026-09-22", until: null });
    // "until February", written in October: next February.
    expect(textValidity("The promo runs until February.", WRITTEN)).toMatchObject({ from: null, until: "2027-02-28" });
    expect(textValidity("The cash balance is €12,000 as of 30.09.", WRITTEN)).toMatchObject({ from: "2026-09-30", until: "2026-09-30" });
    expect(textValidity("The rate is 4% valid from 1 October 2026 until 31 December 2026.", WRITTEN)).toMatchObject({ from: "2026-10-01", until: "2026-12-31" });
    // A date that IS the fact is no period.
    for (const t of ["The invoice is dated 14.09.2026.", "Subscription period is 2026-07-10 to 2026-08-10.", "The pack costs €12.10 since then."]) {
      expect(textValidity(t, WRITTEN), t).toBeNull();
    }
  });

  it("dates a snapshot page's claims by its title, never a record's", () => {
    expect(pageValidity("Finance nightly 14.10 published", null, WRITTEN)).toMatchObject({ from: "2026-10-14", until: "2026-10-14" });
    expect(pageValidity("Finance nightly 15.10 05:00 published", null, WRITTEN)).toMatchObject({ from: "2026-10-15T05:00:00Z" });
    expect(pageValidity("Runway 19.5 mo, weekly summary 14.10", null, WRITTEN)).toMatchObject({ from: "2026-10-14", until: "2026-10-14" });
    expect(pageValidity("2025", null, WRITTEN)).toMatchObject({ from: "2025-01-01", until: "2025-12-31" });
    expect(pageValidity("Income statement Q1 2026", null, WRITTEN)).toMatchObject({ from: "2026-01-01", until: "2026-03-31" });
    expect(pageValidity("Invoice INV-2026-0042 dated 14.09.2026", null, WRITTEN)).toBeNull();
    expect(pageValidity("Widget Pro", null, WRITTEN)).toBeNull();
  });

  it("tells disjoint periods from overlapping ones, and which is later", () => {
    const v = (from: string | null, until: string | null): Validity => ({ from, until, source: "claim" });
    expect(periodsDisjoint(v("2026-10-12", "2026-10-12"), v("2026-10-14", "2026-10-14"))).toBe(true);
    expect(periodsDisjoint(v(null, "2026-09-21"), v("2026-09-22", null))).toBe(true);
    expect(periodsDisjoint(v("2026-09-22", null), v("2026-10-01", "2026-10-01"))).toBe(false);
    expect(periodsDisjoint(v("2026-10-15T05:00:00Z", "2026-10-15T05:00:00Z"), v("2026-10-15", "2026-10-15"))).toBe(false);
    expect(periodsDisjoint(v("2026-10-12", "2026-10-12"), null)).toBe(false);
    expect(laterOf(v("2026-10-14", "2026-10-14"), v("2026-10-12", "2026-10-12"))).toBe("a");
  });

  it("supersedes a nightly figure, a past price, a deprecated page; pairs what overlaps", () => {
    const all = claimsById({
      ...PAGES,
      "concepts/old-price-list.md": page("Price list", [c("sales/old-price-list/widget", "The Widget Pro costs €599.")], { status: "deprecated" }),
      "concepts/pricing-a.md": page("Pricing", [c("sales/pricing-a/widget", "The Widget Pro costs €699 as of 01.10.2026.")]),
      "concepts/pricing-b.md": page("Pricing sheet", [c("sales/pricing-b/widget", "The Widget Pro costs €749 as of 01.10.2026.")]),
      "concepts/pricing-c.md": page("Pricing archive", [c("sales/pricing-c/widget", "The Widget Pro costs €399.", { valid_until: "2026-09-21" })]),
    });
    const pair = (a: string, b: string) => noPairReason(all.get(a)!, all.get(b)!);
    expect(pair("finance/finance-nightly-12-10/unmatched", "finance/finance-nightly-14-10/unmatched")).toMatchObject({ code: "superseded-period", current: "b" });
    expect(pair("sales/widget-pro-launch/price", "sales/widget-pro/price")).toMatchObject({ code: "superseded-historical", current: "b" });
    expect(pair("sales/old-price-list/widget", "sales/widget-pro/price")).toMatchObject({ code: "superseded-deprecated", current: "b" });
    expect(pair("sales/pricing-c/widget", "sales/pricing-b/widget")).toMatchObject({ code: "superseded-period", current: "b" });
    // One day, two prices: the contradiction itself. And a claim with no period overlaps any.
    expect(pair("sales/pricing-a/widget", "sales/pricing-b/widget")).toBeNull();
    expect(pair("sales/pricing-a/widget", "sales/widget-pro/price")).toBeNull();
  });

  it("reads a historical claim by its mark or its words; two historical claims may still be a pair", () => {
    expect(historicalClaim({ text: "The Widget Pro launch price was €399." })).toBe(true);
    expect(historicalClaim({ text: "The office was formerly at 1 Harbor Road." })).toBe(true);
    expect(historicalClaim({ text: "The office is at 1 Harbor Road.", historical: true })).toBe(true);
    expect(historicalClaim({ text: "The launch is on 1 March." })).toBe(false);
    const a = { ...claimsById().get("sales/widget-pro-launch/price")! };
    const b = { ...a, text: "The Widget Pro launch price was €349.", subject: claimSubject("sales/widget-pro-old/price", "The Widget Pro launch price was €349.", "Widget Pro history") };
    expect(noPairReason(a, b)).toBeNull();
  });

  it("validates the dated fields in the page contract", () => {
    const ok = validateFrontmatter({ ...frontmatter(), claims: [c("x/y/z", "A fact.", { valid_from: "2026-09-22", valid_until: "2026-12-31", as_of: "2026-10-01", historical: false })] });
    expect(ok.ok).toBe(true);
    const bad = validateFrontmatter({ ...frontmatter(), claims: [c("x/y/z", "A fact.", { as_of: "30.09" as unknown as string })] });
    expect(bad.ok).toBe(false);
    const backwards = validateFrontmatter({ ...frontmatter(), claims: [c("x/y/z", "A fact.", { valid_from: "2026-12-31", valid_until: "2026-01-01" })] });
    expect(!backwards.ok && backwards.errors.map((e) => e.field)).toEqual(["claims[0].valid_until"]);
    expect(validateFrontmatter({ ...frontmatter(), claims: [c("x/y/z", "A fact.", { historical: "yes" as unknown as boolean })] }).ok).toBe(false);
    expect(validateFrontmatter({ ...frontmatter(), version_of: 7 }).ok).toBe(false);
  });

  it("has the writer fill the fields from the model's answer, else from the fact's own words", () => {
    const items = [{ i: 0, path: "~/Documents/price-update.txt", kind: "text", text: "Widget Pro costs €749 since 22.09.2026. The launch price was €399. Cash was €12,000 as of 30.09." }];
    const answer = JSON.stringify([
      {
        i: 0,
        type: "concept",
        title: "Widget Pro price update",
        domain: "sales",
        summary: "The Widget Pro's price changed.",
        facts: [
          { fact: "The Widget Pro costs €749.", quote: "Widget Pro costs €749", confidence: 0.9, valid_from: "2026-09-22", as_of: "30.09" },
          { fact: "The Widget Pro launch price was €399.", quote: "The launch price was €399", confidence: 0.9 },
          { fact: "Cash was €12,000 as of 30.09.", quote: "Cash was €12,000 as of 30.09", confidence: 0.9 },
        ],
      },
    ]);
    const verdict = parseWriterResponse(answer, items).get(0)!;
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    const ctx: BuildContext = { takenPaths: new Set(), pagesBySource: new Map(), claimIndex: { active: new Map(), retired: new Map() }, now: new Date(WRITTEN) };
    const built = buildPage(verdict.draft, "~/Documents/price-update.txt", ctx);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const [price, launch, cash] = built.frontmatter.claims;
    // An ISO date from the model is kept; "30.09" is not an ISO date and is dropped.
    expect(price).toMatchObject({ valid_from: "2026-09-22" });
    expect(price.as_of).toBeUndefined();
    expect(launch).toMatchObject({ historical: true });
    expect(cash).toMatchObject({ as_of: "2026-09-30" });
    expect(validateFrontmatter(built.frontmatter).ok).toBe(true);
    expect(claimDates({ fact: "The office is at 1 Harbor Road.", quote: "", confidence: 1 }, WRITTEN)).toEqual({});
  });
});

describe("rule 3: a draft and its final are one document", () => {
  const name = documentName;
  it("tells versions by name, format, date and references", () => {
    const same = (a: string, b: string) => sameDocument(name(a), name(b));
    expect(same("Export declaration Fabrikam INV-2026-0021 docx 23.02.2026", "Export declaration Fabrikam INV-2026-0021 pdf")).toBe(true);
    expect(same("Order confirmation Contoso draft", "Order confirmation Contoso 01.03.2026")).toBe(true);
    expect(same("Invoice INV-2026-0077 Initech", "Northwind invoice INV-2026-0077 Initech second copy")).toBe(true);
    expect(same("Invoice INV-2026-0077 for Initech", "Invoice INV-2026-0077 to Initech")).toBe(true);
    expect(same("31.12.2025", "31.12.2025")).toBe(true);
    // Two documents.
    expect(same("Daily report 2026-10-12", "Daily report 2026-10-13")).toBe(false);
    expect(same("Invoice INV-2026-0050 Fabrikam", "Invoice INV-2026-0050 Contoso")).toBe(false);
    expect(same("Invoice INV-2026-0001 Initech", "Invoice INV-2026-0002 Initech")).toBe(false);
    // One commit, two boards: each title has a reference the other lacks.
    expect(same("Bench run at a1b2c3d4 board-1700000000001", "Bench run at a1b2c3d4 board-1700000000002")).toBe(false);
    // A declaration that cites an invoice is not that invoice.
    expect(same("Customs declaration Initech invoice INV-2026-0077", "Invoice INV-2026-0077 Initech")).toBe(false);
    expect(same("Northwind Robotics", "Northwind Robotics 2025")).toBe(false);
    expect(same("Invoice draft", "Invoice")).toBe(false);
  });

  it("groups them, the final first, and honours version_of", () => {
    const groups = versionGroups([
      { path: "a-docx.md", title: "Export declaration Fabrikam INV-2026-0021 docx 23.02.2026", claims: 5 },
      { path: "a-pdf.md", title: "Export declaration Fabrikam INV-2026-0021 pdf", claims: 3 },
      { path: "b.md", title: "Supply agreement Contoso", claims: 2 },
      { path: "b-signed.md", title: "Contoso contract as signed", claims: 1, versionOf: "b.md" },
      { path: "c.md", title: "Widget Pro", claims: 4 },
    ]);
    expect(groups).toEqual([
      { winner: "a-pdf.md", pages: ["a-pdf.md", "a-docx.md"] },
      { winner: "b-signed.md", pages: ["b-signed.md", "b.md"] },
    ]);
  });

  it("never pairs two versions' claims", () => {
    const all = claimsById();
    const a = all.get("customs/export-declaration-fabrikam-inv-2026-0021-docx/invoice")!;
    const b = all.get("customs/export-declaration-fabrikam-inv-2026-0021-pdf/invoice")!;
    expect(a.version).toBe("concepts/export-declaration-fabrikam-inv-2026-0021-pdf.md");
    expect(noPairReason(a, b)).toMatchObject({ code: "same-document" });
  });

  it("rebuilds a gone page's title from its path, dates and references joined", () => {
    expect(titleFromPath("concepts/export-declaration-fabrikam-inv-2026-0021-pdf-23-02-2026.md")).toBe("export declaration fabrikam inv-2026-0021 pdf 23.02.2026");
    expect(titleFromPath("concepts/daily-report-2026-10-12.md")).toBe("daily report 2026-10-12");
  });
});

describe("one rule set", () => {
  it("answers the pass's yes/no exactly as the re-judge's reasons, for every pair", () => {
    const claims = collectClaims(snapshot(PAGES));
    let parted = 0;
    for (const a of claims) {
      for (const b of claims) {
        if (a === b) continue;
        expect(pairable(a, b), `${a.id} / ${b.id}`).toBe(noPairReason(a, b) === null);
        if (!pairable(a, b)) parted += 1;
      }
    }
    expect(parted).toBeGreaterThan(0);
  });
});

describe("owner-verified claims win", () => {
  it("is a person's stamp, never the assistant's", () => {
    expect(ownerVerified({ verified: OWNER, status: "verified" })).toBe(true);
    expect(ownerVerified({ verified: ASSISTANT, status: "verified" })).toBe(false);
    expect(ownerVerified({ verified: null, status: "verified" })).toBe(true);
    expect(ownerVerified({ verified: null, status: "supported" }, { verified: OWNER })).toBe(true);
    expect(ownerVerified({ verified: null, status: "supported" }, { verified: null })).toBe(false);
  });
});

// ── the pass ──────────────────────────────────────────────────────────────

/** A judge that calls EVERY pair a contradiction: only the rules keep the queue true. */
function alwaysContradiction(asked: Array<[string, string]>): FlashClient {
  return {
    model: "deepseek-v4-flash",
    async complete(request) {
      const items = readJudgeItems(request.user) ?? [];
      for (const it of items) asked.push([it.a, it.b]);
      const text = JSON.stringify(items.map((it) => ({ i: it.i, verdict: "contradiction", why: "values differ" })));
      return { text, model: "deepseek-v4-flash", usage: { promptTokens: 100, completionTokens: 10, cacheHitTokens: 0 } };
    },
  };
}

describe("the contradiction pass under the new rules", () => {
  it("raises the planted real contradictions only, and turns one against a verified claim into a stale note", async () => {
    const asked: Array<[string, string]> = [];
    const snap = snapshot(PAGES);
    const r = await runContradictionPass(snap, {
      stateVault: vault,
      scope: null,
      client: alwaysContradiction(asked),
      embedder: createHashEmbedder(),
      retry: { attempts: 1, sleep: async () => undefined },
      now: () => new Date(WRITTEN),
    });
    const raised = r.reviewItems.map((item) => item.candidates.map((x) => x.claimId).sort().join(" | ")).sort();
    expect(raised).toEqual(
      [
        "customs/export-declaration-mrn-26xx000111a0000001/exporter | customs/import-declaration-12-dev-kits/importer",
        "finance/invoice-inv-2026-0042-fabrikam/total | finance/payment-reminder-fabrikam/total",
      ].sort(),
    );
    // Draft/final, two credit notes, two transfers, a nightly figure, a launch price: never asked.
    for (const [a, b] of asked) {
      expect(`${a} ${b}`).not.toMatch(/date left blank|Net amount|beneficiary bank|payments of €500|launch price/);
    }
    expect(r.staleNotes).toBe(1);
    const stale = readStaleClaims(vault);
    expect(stale).toEqual([expect.objectContaining({ claimId: "ops/support-faq/hours", page: "concepts/support-faq.md", verifiedClaimId: "ops/northwind-support/hours" })]);
    // The stale note is a lint warning on the losing page, not a question.
    const report = lintVault(snap, { staleClaims: stale, now: new Date(WRITTEN) });
    expect(report.findings.filter((f) => f.rule === "stale-against-verified").map((f) => f.path)).toEqual(["concepts/support-faq.md"]);
    // Rewritten since: no longer stale.
    const rewritten = snapshot({ ...PAGES, "concepts/support-faq.md": page("Support FAQ", [c("ops/support-faq/hours", "The Northwind support line is open from 9 to 17.", { updatedAt: "2026-10-17T00:00:00.000Z" })]) });
    expect(lintVault(rewritten, { staleClaims: stale }).findings.some((f) => f.rule === "stale-against-verified")).toBe(false);
  });
});

// ── the re-judge ──────────────────────────────────────────────────────────

describe("re-judging the open queue", () => {
  const side = (id: string, pagePath: string, text: string, extra: Partial<ReviewCandidate> = {}): ReviewCandidate => ({
    text,
    page: pagePath,
    claimId: id,
    evidence: [{ kind: "claim", page: pagePath }],
    ...extra,
  });
  const raise = (a: ReviewCandidate, b: ReviewCandidate) =>
    addReviewItem(vault, { kind: "contradiction", claimId: a.claimId, pages: [a.page!, b.page!], candidates: [a, b], evidence: [{ kind: "judge", verdict: "contradiction", note: "values differ" }] }).item;

  function seed() {
    const credit = raise(
      side("finance/credit-note-draft-starter-pack-9/net", "concepts/credit-note-draft-starter-pack-9.md", "Net amount is €7.50."),
      side("finance/credit-note-draft-hardware-kit-512/net", "concepts/credit-note-draft-hardware-kit-512.md", "Net amount is €429.75."),
    );
    const transfer = raise(
      side("finance/transfer-to-northwind-traders/bank", "concepts/transfer-to-northwind-traders.md", "The beneficiary bank is First Harbor Bank."),
      side("finance/payment-to-contoso-printing/bank", "concepts/payment-to-contoso-printing.md", "The beneficiary bank is Lakeside Credit Union."),
    );
    const draftFinal = raise(
      side("customs/export-declaration-fabrikam-inv-2026-0021-docx/invoice", "concepts/export-declaration-fabrikam-inv-2026-0021-docx-23-02-2026.md", "The declaration cites invoice INV-2026-0021 with the date left blank."),
      side("customs/export-declaration-fabrikam-inv-2026-0021-pdf/invoice", "concepts/export-declaration-fabrikam-inv-2026-0021-pdf.md", "The declaration cites invoice INV-2026-0021 dated 18.02.2026."),
    );
    const nightly = raise(
      side("finance/finance-nightly-12-10/unmatched", "concepts/finance-nightly-12-10.md", "24 payments of €500 or more have no linked document."),
      side("finance/finance-nightly-14-10/unmatched", "concepts/finance-nightly-14-10.md", "15 payments of €500 or more have no linked document."),
    );
    const launch = raise(
      side("sales/widget-pro-launch/price", "concepts/widget-pro-launch.md", "The Widget Pro launch price was €399."),
      side("sales/widget-pro/price", "concepts/widget-pro.md", "The Widget Pro costs €749."),
    );
    const legalForm = raise(
      side("customs/export-declaration-mrn-26xx000111a0000001/exporter", "concepts/export-declaration-mrn-26xx000111a0000001.md", "The exporter on this declaration is Northwind Robotics EOOD with exporter TIN XX999000111."),
      side("customs/import-declaration-12-dev-kits/importer", "concepts/import-declaration-12-dev-kits.md", "Northwind Robotics OOD is the importer on this declaration with TIN XX999000111."),
    );
    const twoTotals = raise(
      side("finance/invoice-inv-2026-0042-fabrikam/total", "concepts/invoice-inv-2026-0042-fabrikam.md", "The total due on invoice INV-2026-0042 is €1,200.00."),
      side("finance/payment-reminder-fabrikam/total", "concepts/payment-reminder-fabrikam.md", "The total due on invoice INV-2026-0042 is €1,250.00."),
    );
    const verified = raise(
      side("ops/support-faq/hours", "concepts/support-faq.md", "The Northwind support line is open from 8 to 16."),
      side("ops/northwind-support/hours", "concepts/northwind-support.md", "The Northwind support line is open from 9 to 17.", { evidence: [{ kind: "verified-claim", page: "concepts/northwind-support.md" }] }),
    );
    // Settled by the owner earlier, and put off by the owner: never touched.
    const ownerResolved = raise(
      side("finance/credit-note-draft-starter-pack-9/net", "concepts/credit-note-draft-starter-pack-9.md", "Net amount is €7.50."),
      side("finance/transfer-to-northwind-traders/bank", "concepts/transfer-to-northwind-traders.md", "The beneficiary bank is First Harbor Bank."),
    );
    settleReviewItem(vault, ownerResolved.id, "resolved", { action: "pick", candidate: 0, by: "owner" }, WRITTEN);
    const later = raise(
      side("finance/payment-to-contoso-printing/bank", "concepts/payment-to-contoso-printing.md", "The beneficiary bank is Lakeside Credit Union."),
      side("finance/credit-note-draft-hardware-kit-512/net", "concepts/credit-note-draft-hardware-kit-512.md", "Net amount is €429.75."),
    );
    settleReviewItem(vault, later.id, "later", { action: "later", by: "owner" }, WRITTEN);
    return { credit, transfer, draftFinal, nightly, launch, legalForm, twoTotals, verified, ownerResolved, later };
  }

  it("dry-runs first: counts per reason, closes nothing", () => {
    const items = seed();
    const dry = rejudgeOpenContradictions(vault, snapshot(PAGES), { dryRun: true, now: () => new Date(WRITTEN) });
    expect(dry).toMatchObject({ checked: 8, closed: 6, stillOpen: 2, keptVerified: 0, keptOwner: 0, staleNotes: 1, dryRun: true });
    expect(dry.byReason).toEqual({
      "different-records": 1,
      "different-subjects": 1,
      "same-document": 1,
      "superseded-period": 1,
      "superseded-historical": 1,
      "verified-wins": 1,
    });
    expect(dry.byFamily).toEqual({ "different subjects": 2, "same document": 1, superseded: 2, "verified claim wins": 1 });
    expect(rejudgeSummary(dry)[0]).toBe("would close 6 of 8 open contradiction item(s)");
    const { ownerResolved, later, ...waiting } = items;
    for (const item of Object.values(waiting)) expect(getReviewItem(vault, item.id)?.status, item.id).toBe("open");
    expect(getReviewItem(vault, ownerResolved.id)?.status).toBe("resolved");
    expect(getReviewItem(vault, later.id)?.status).toBe("later");
    expect(readStaleClaims(vault)).toEqual([]);
  });

  it("closes what no longer qualifies with an auditable note, keeps the real ones and the owner's", () => {
    const items = seed();
    const done = rejudgeOpenContradictions(vault, snapshot(PAGES), { now: () => new Date(WRITTEN) });
    expect(done).toMatchObject({ checked: 8, closed: 6, stillOpen: 2, staleNotes: 1, dryRun: false });
    const note = (id: string) => getReviewItem(vault, id)?.resolution?.note ?? "";
    for (const item of [items.credit, items.transfer, items.draftFinal, items.nightly, items.launch, items.verified]) {
      expect(getReviewItem(vault, item.id)).toMatchObject({ status: "resolved", resolution: { action: "dismiss", by: "auto" } });
    }
    expect(note(items.credit.id)).toBe("auto: different records, no shared reference (identifier filter)");
    expect(note(items.transfer.id)).toMatch(/^auto: different subjects: ".*" against ".*" $|^auto: different subjects: /);
    expect(note(items.draftFinal.id)).toMatch(/^auto: same document: draft vs final \(.*docx.* and .*pdf\.md are versions of one document; concepts\/export-declaration-fabrikam-inv-2026-0021-pdf\.md is kept\)$/);
    expect(note(items.nightly.id)).toBe("auto: superseded: as of 2026-10-12 against as of 2026-10-14; the current claim is on concepts/finance-nightly-14-10.md");
    expect(note(items.launch.id)).toBe("auto: superseded: a historical claim against the current one; the current claim is on concepts/widget-pro.md");
    expect(note(items.verified.id)).toMatch(/^auto: verified claim wins: concepts\/support-faq\.md disagrees with the owner-verified claim on concepts\/northwind-support\.md/);
    // The planted real contradictions are still the owner's questions.
    expect(getReviewItem(vault, items.legalForm.id)?.status).toBe("open");
    expect(getReviewItem(vault, items.twoTotals.id)?.status).toBe("open");
    // What the owner settled, or put off, is exactly as they left it.
    expect(getReviewItem(vault, items.ownerResolved.id)?.resolution).toEqual({ action: "pick", candidate: 0, by: "owner" });
    expect(getReviewItem(vault, items.later.id)).toMatchObject({ status: "later", resolution: { action: "later", by: "owner" } });
    expect(readStaleClaims(vault)).toEqual([expect.objectContaining({ claimId: "ops/support-faq/hours", verifiedClaimId: "ops/northwind-support/hours" })]);
    // Nothing left to close: a second run changes nothing.
    expect(rejudgeOpenContradictions(vault, snapshot(PAGES))).toMatchObject({ checked: 2, closed: 0, stillOpen: 2 });
  });

  it("leaves an item with both sides owner-verified open, and one carrying a person's answer", () => {
    const pages = {
      ...PAGES,
      "concepts/support-faq.md": page("Support FAQ", [c("ops/support-faq/hours", "The Northwind support line is open from 8 to 16.", { verified: OWNER, status: "verified" })]),
    };
    const both = raise(
      side("ops/support-faq/hours", "concepts/support-faq.md", "The Northwind support line is open from 8 to 16."),
      side("ops/northwind-support/hours", "concepts/northwind-support.md", "The Northwind support line is open from 9 to 17."),
    );
    const r = rejudgeOpenContradictions(vault, snapshot(pages));
    expect(r).toMatchObject({ checked: 1, closed: 0, keptVerified: 1 });
    expect(getReviewItem(vault, both.id)?.status).toBe("open");
  });

  it("reads a page the vault no longer holds by its path", () => {
    const item = {
      kind: "contradiction" as const,
      createdAt: WRITTEN,
      candidates: [
        side("customs/export-declaration-initech-inv-2026-0013-docx/invoice", "concepts/export-declaration-initech-inv-2026-0013-docx-23-02-2026.md", "The declaration cites invoice INV-2026-0013 with the date left blank."),
        side("customs/export-declaration-initech-inv-2026-0013-pdf/invoice", "concepts/export-declaration-initech-inv-2026-0013-pdf.md", "The declaration cites invoice INV-2026-0013 dated 17.02.2026."),
      ],
    };
    expect(rejudgeVerdict(item, new Map())).toMatchObject({ code: "same-document" });
  });
});
