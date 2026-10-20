/**
 * The identifier filter: two waybills, two transfers, two days' reports are
 * different things and never a contradiction; the re-judge closes only the
 * open items the filter excludes. Fixtures are synthetic.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { comparable } from "@/lib/prime-radiant/contradictions";
import {
  claimIdentifiers,
  DIFFERENT_RECORDS,
  differentSubjectSides,
  IDENTIFIER_FILTER_NOTE,
  RECORD_FILTER_NOTE,
  recordPage,
  sideIdentifiers,
  titleIdentifiers,
  type PairSide,
} from "@/lib/prime-radiant/identifiers";
import { identifierReason, rejudgeOpenContradictions, rejudgeReason, rejudgeVerdict, touchesVerified, verifiedIndex } from "@/lib/prime-radiant/rejudge";
import { addReviewItem, getReviewItem, type ReviewCandidate } from "@/lib/prime-radiant/review-store";
import { claimSubject } from "@/lib/prime-radiant/subject";
import { claim, pageText, snapshot } from "../helpers/prime-radiant-fixtures";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-ids-"));
let n = 0;
let vault = "";
beforeEach(() => {
  vault = path.join(base, `case-${++n}`);
  fs.mkdirSync(vault, { recursive: true });
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe("identifiers", () => {
  it("reads dates, months and refs from titles", () => {
    const t = titleIdentifiers("Daily sales report 2026-09-14");
    expect([...t.date]).toEqual(["2026-09-14"]);
    expect([...titleIdentifiers("Courier waybill 1054432198").ref]).toEqual(["1054432198"]);
    expect([...titleIdentifiers("Invoice INV-2026-0012").ref]).toEqual(["inv20260012"]);
    expect([...titleIdentifiers("Shipments 2026-09").month]).toEqual(["2026-09"]);
    expect(titleIdentifiers("Widget pricing 2026").ref.size).toBe(0);
  });

  it("reads refs in claims only after a reference word", () => {
    expect([...claimIdentifiers("Waybill 1054432198 was delivered on 14.09.2026.").ref]).toEqual(["1054432198"]);
    expect(claimIdentifiers("Waybill 1054432198 was delivered on 14.09.2026.").date.size).toBe(0);
    expect(claimIdentifiers("The widget costs 12000 EUR.").ref.size).toBe(0);
    expect(claimIdentifiers("Order 12 units of widgets.").ref.size).toBe(0);
  });

  it("says two waybills, two days and two invoices are different subjects", () => {
    expect(differentSubjectSides({ title: "Waybill 1054432198", text: "The parcel was delivered." }, { title: "Waybill 1054432777", text: "The parcel was returned." })).toBe(
      "different identifiers",
    );
    expect(
      differentSubjectSides({ title: "Daily sales report 2026-09-14", text: "Total sales were 10 orders." }, { title: "Daily sales report 2026-09-15", text: "Total sales were 12 orders." }),
    ).toBe("different dates");
    expect(differentSubjectSides({ title: "Widget pricing", text: "The widget costs 10 EUR." }, { title: "Widget price list", text: "The widget costs 12 EUR." })).toBeNull();
    expect(differentSubjectSides({ title: "Invoice 20260118", text: "Paid." }, { title: "Invoice 20260118", text: "Unpaid." })).toBeNull();
    // One waybill, two delivery dates: that may be the contradiction itself.
    expect(
      differentSubjectSides({ title: "Parcel status", text: "Waybill 1054432198 was delivered on 2026-09-14." }, { title: "Parcel status", text: "Waybill 1054432198 was delivered on 2026-09-15." }),
    ).toBeNull();
    expect(differentSubjectSides({ title: "Widget orders", text: "Order 12 units." }, { title: "Widget orders", text: "Order 15 units." })).toBeNull();
  });

  it("keeps two different waybills out of the judge's pairs", () => {
    const side = (title: string, text: string) => ({ text, subject: claimSubject("ops/parcel/status", text, title), ids: sideIdentifiers(title, text) });
    expect(comparable(side("Waybill 1054432198", "The parcel was delivered."), side("Waybill 1054432777", "The parcel was returned."))).toBe(false);
    expect(comparable(side("Parcel status", "The parcel was delivered."), side("Parcel status", "The parcel was returned."))).toBe(true);
  });
});

describe("rejudgeOpenContradictions", () => {
  it("closes only the items the filter excludes, with the note", () => {
    const snap = snapshot({
      "concepts/waybill-1054432198.md": pageText({ title: "Waybill 1054432198" }),
      "concepts/waybill-1054432777.md": pageText({ title: "Waybill 1054432777" }),
      "concepts/widget-pricing.md": pageText({ title: "Widget pricing" }),
      "concepts/widget-price-list.md": pageText({ title: "Widget price list" }),
    });
    const false1 = addReviewItem(vault, {
      kind: "contradiction",
      candidates: [
        { text: "The parcel was delivered.", page: "concepts/waybill-1054432198.md", evidence: [] },
        { text: "The parcel was returned.", page: "concepts/waybill-1054432777.md", evidence: [] },
      ],
    }).item;
    const real = addReviewItem(vault, {
      kind: "contradiction",
      candidates: [
        { text: "The widget costs 10 EUR.", page: "concepts/widget-pricing.md", evidence: [] },
        { text: "The widget costs 12 EUR.", page: "concepts/widget-price-list.md", evidence: [] },
      ],
    }).item;
    const dry = rejudgeOpenContradictions(vault, snap, { dryRun: true });
    expect(dry).toMatchObject({ checked: 2, closed: 1, dryRun: true });
    expect(getReviewItem(vault, false1.id)?.status).toBe("open");
    const done = rejudgeOpenContradictions(vault, snap);
    expect(done.closed).toBe(1);
    const closed = getReviewItem(vault, false1.id);
    expect(closed?.status).toBe("resolved");
    expect(closed?.resolution).toMatchObject({ action: "dismiss", note: IDENTIFIER_FILTER_NOTE });
    expect(getReviewItem(vault, real.id)?.status).toBe("open");
  });
});

// Record pages, one per document. Every name and number is invented.
const CUSTOMS: PairSide = { title: "Customs declaration file 7712004455", text: "The invoice referenced is AC-INV-2026-5100000392 of 02.09.2026." };
const EXPORT: PairSide = { title: "Export declaration with redacted invoice", text: "The referenced invoice is dated 15.07.2026 with a redacted number." };
const CORRECTION: PairSide = { title: "Annual correction draft 4100000318", text: "The total amount due is €80.89." };
const DRAFT: PairSide = { title: "Invoice draft acme widgets pro 49", text: "The total amount due is €49.00." };
const RECEIPT_4: PairSide = { title: "Adnet receipt email 0.05 4 jun 2026 21:59", text: "The receipt was emailed on 04 Jun 2026." };
const RECEIPT_7: PairSide = { title: "Adnet receipt email 0.05 jun 7 2026", text: "The receipt was emailed on 06 Jun 2026." };
// One invoice on two pages: these stay pairs.
const VAT_A: PairSide = { title: "Invoice AC-INV-2026-7000000202", text: "Invoice AC-INV-2026-7000000202 charges VAT at 23%." };
const VAT_B: PairSide = { title: "Customs declaration file 7712009999", text: "Invoice AC-INV-2026-7000000202 is reverse-charged at 0% VAT." };
const DATED_A: PairSide = { title: "Invoice AC-INV-2026-7000000192", text: "Invoice AC-INV-2026-7000000192 is dated 20 March." };
const DATED_B: PairSide = { title: "Payment receipt 21.03.2026", text: "Invoice AC-INV-2026-7000000192 is dated 21.03.2026." };

/** The filter's answer both ways round. */
const both = (a: PairSide, b: PairSide) => [differentSubjectSides(a, b), differentSubjectSides(b, a)];

describe("month-name dates in titles", () => {
  it("reads day-month-year and month-day-year, English and Bulgarian", () => {
    expect([...titleIdentifiers(RECEIPT_4.title).date]).toEqual(["2026-06-04"]);
    expect([...titleIdentifiers(RECEIPT_7.title).date]).toEqual(["2026-06-07"]);
    expect([...titleIdentifiers("Adnet receipt 04 Jun 2026").date]).toEqual(["2026-06-04"]);
    expect([...titleIdentifiers("Statement of 7th June, 2026").date]).toEqual(["2026-06-07"]);
    expect([...titleIdentifiers("September 30, 2026 board minutes").date]).toEqual(["2026-09-30"]);
    expect([...titleIdentifiers("Касова бележка 4 юни 2026").date]).toEqual(["2026-06-04"]);
    expect([...titleIdentifiers("Shipments June 2026").month]).toEqual(["2026-06"]);
    expect([...titleIdentifiers("Отчет за юли 2026 г.").month]).toEqual(["2026-07"]);
  });

  it("reads no day from an amount, a yearless date or a word that starts like a month", () => {
    const amount = titleIdentifiers("Adnet receipt 0.02 jun 2026");
    expect(amount.date.size).toBe(0);
    expect([...amount.month]).toEqual(["2026-06"]);
    expect(titleIdentifiers("Receipt 4 June").date.size).toBe(0);
    // A day that is not on the calendar is no day, written by name or by number.
    for (const t of ["Receipt 31 June 2026", "Receipt 31.06.2026", "Receipt 2026-02-30", "Receipt Feb 29 2026"]) expect(titleIdentifiers(t).date.size, t).toBe(0);
    expect([...titleIdentifiers("Receipt 29 Feb 2028").date]).toEqual(["2028-02-29"]);
    expect(titleIdentifiers("Marching orders 12 2026").date.size + titleIdentifiers("Marching orders 12 2026").month.size).toBe(0);
    // The year of a month-name date is not left behind as a reference.
    expect(titleIdentifiers(RECEIPT_4.title).ref.size).toBe(0);
  });

  it("tells two pages dated by month name apart, record or not", () => {
    expect(both({ title: "Team standup notes 4 jun 2026", text: "Three tasks were closed." }, { title: "Team standup notes jun 7 2026", text: "Five tasks were closed." })).toEqual([
      "different dates",
      "different dates",
    ]);
    expect(both(RECEIPT_4, RECEIPT_7)).toEqual(["different dates", "different dates"]);
  });
});

describe("record pages", () => {
  it("tells a record page by its title words and identifiers", () => {
    for (const t of [CUSTOMS.title, EXPORT.title, CORRECTION.title, DRAFT.title, RECEIPT_4.title, VAT_A.title, DATED_B.title]) expect(recordPage(t), t ?? "").toBe(true);
    for (const t of ["Courier waybill 1054432198", "Bank transfer 2026-09-14", "Daily sales report 2026-09-14", "Credit note CN-2026-0042", "Statement 2026-09", "Фактура 0000004512"]) {
      expect(recordPage(t), t).toBe(true);
    }
    for (const t of ["Acme Widgets Ltd", "Widget pricing", "Invoice process", "Receipt policy 2026", "Annual correction draft", "Mission statement", "Team standup notes 4 jun 2026", ""]) {
      expect(recordPage(t), t).toBe(false);
    }
  });

  it("never takes an entity, synthesis, decision or how-to page for a record", () => {
    expect(recordPage(VAT_A.title, "concept")).toBe(true);
    expect(recordPage(VAT_A.title, "source")).toBe(true);
    for (const type of ["entity", "synthesis", "decision", "howto"]) expect(recordPage(DRAFT.title, type), type).toBe(false);
  });

  it("says two record pages with no shared reference are different records, one side without any", () => {
    // A declaration with an invoice number against one whose invoice number is redacted.
    expect(both(CUSTOMS, EXPORT)).toEqual([DIFFERENT_RECORDS, DIFFERENT_RECORDS]);
    // A correction draft with a number against an invoice draft without one.
    expect(both(CORRECTION, DRAFT)).toEqual([DIFFERENT_RECORDS, DIFFERENT_RECORDS]);
    // Two receipts of one day still need a shared reference.
    expect(both(RECEIPT_4, { title: "Adnet receipt 04 Jun 2026", text: "The receipt total is €0.07." })).toEqual([DIFFERENT_RECORDS, DIFFERENT_RECORDS]);
  });

  it("keeps two record pages that share a reference, in a claim or a title", () => {
    // One invoice, VAT 23% against a reverse charge at 0%: the contradiction itself.
    expect(both(VAT_A, VAT_B)).toEqual([null, null]);
    // One invoice, two dates — written two ways, and the pages' title dates differ.
    expect(both(DATED_A, DATED_B)).toEqual([null, null]);
    // The reference in one page's title and the other's claim, written differently.
    expect(both({ ...VAT_A, text: "VAT is charged at 23%." }, { title: "Bank transfer 2026-03-25", text: "It pays invoice 2026-7000000202, reverse-charged at 0% VAT." })).toEqual([null, null]);
    // Zero padding is no digit: two invoices numbered 1 and 1000001 stay two.
    const total = (title: string, text: string): PairSide => ({ title, text });
    expect(both(total("Invoice INV-000001", "The total is 10 EUR."), total("Invoice INV-1000001", "The total is 12 EUR."))).toEqual([
      "different identifiers",
      "different identifiers",
    ]);
    // The redacted declaration that does name the same invoice.
    expect(both(CUSTOMS, { ...EXPORT, text: "The referenced invoice AC-INV-2026-5100000392 is dated 15.07.2026." })).toEqual([null, null]);
    expect(both(RECEIPT_4, { title: "Adnet receipt 04 Jun 2026", text: "Receipt RC-48213 total is €0.07." }).every((r) => r === DIFFERENT_RECORDS)).toBe(true);
    expect(both({ ...RECEIPT_4, text: "Receipt RC-48213 total is €0.05." }, { title: "Adnet receipt 04 Jun 2026", text: "Receipt RC-48213 total is €0.07." })).toEqual([null, null]);
  });

  it("keeps today's rule when one page is not a record", () => {
    const entity: PairSide = { title: "Acme Widgets Pro", type: "entity", text: "The total amount due is €49.00." };
    expect(both(CORRECTION, entity)).toEqual([null, null]);
    expect(both(CORRECTION, { ...DRAFT, type: "synthesis" })).toEqual([null, null]);
    expect(both(EXPORT, { title: "Export rules", text: "The referenced invoice is dated 16.07.2026." })).toEqual([null, null]);
    // Different references still part a record from a page that is none.
    expect(both(CUSTOMS, { title: "Customs broker 7712001111", type: "entity", text: "The broker files declarations." })).toEqual(["different identifiers", "different identifiers"]);
  });

  it("keeps record pages of different documents out of the judge's pairs, and one invoice's pages in", () => {
    const side = (s: PairSide, type = "source") => ({ text: s.text, subject: claimSubject("finance/acme-invoice/total", s.text, s.title), ids: sideIdentifiers(s.title, s.text, type) });
    expect(comparable(side(CUSTOMS), side(EXPORT))).toBe(false);
    expect(comparable(side(DRAFT), side(CORRECTION))).toBe(false);
    expect(comparable(side(RECEIPT_7), side(RECEIPT_4))).toBe(false);
    expect(comparable(side(VAT_A), side(VAT_B))).toBe(true);
    expect(comparable(side(DATED_B), side(DATED_A))).toBe(true);
    expect(comparable(side(CORRECTION), side(DRAFT, "entity"))).toBe(true);
  });
});

describe("rejudge and record pages", () => {
  // The state database lives beside the vault: a folder of its own per case, so no other case's items are counted.
  beforeEach(() => {
    vault = path.join(base, `records-${++n}`, "vault");
    fs.mkdirSync(vault, { recursive: true });
  });
  const VERIFIED = { at: "2026-02-01T00:00:00.000Z", by: "owner" };
  const PAGES = {
    "sources/customs-7712004455.md": pageText({ title: CUSTOMS.title!, type: "source" }),
    "sources/export-redacted.md": pageText({ title: EXPORT.title!, type: "source" }),
    "sources/correction-4100000318.md": pageText({ title: CORRECTION.title!, type: "source" }),
    "sources/invoice-draft-pro-49.md": pageText({ title: DRAFT.title!, type: "source" }),
    "sources/adnet-receipt-0604.md": pageText({ title: RECEIPT_4.title!, type: "source" }),
    "sources/adnet-receipt-0607.md": pageText({ title: RECEIPT_7.title!, type: "source" }),
    "sources/invoice-7000000202.md": pageText({ title: VAT_A.title!, type: "source" }),
    "sources/customs-7712009999.md": pageText({ title: VAT_B.title!, type: "source" }),
    "sources/invoice-7000000192.md": pageText({ title: DATED_A.title!, type: "source" }),
    "sources/payment-receipt-0321.md": pageText({ title: DATED_B.title!, type: "source" }),
    "entities/acme-widgets-pro.md": pageText({ title: "Acme Widgets Pro", type: "entity" }),
    "sources/invoice-draft-starter-19.md": pageText({
      title: "Invoice draft acme widgets starter 19",
      type: "source",
      claims: [claim("finance/invoice-draft-starter-19/total", "The total amount due is €19.00.", { verified: VERIFIED })],
    }),
    "sources/correction-4100000377.md": pageText({ title: "Annual correction draft 4100000377", type: "source" }),
    "sources/receipt-verified-page.md": pageText({ title: "Adnet receipt email 0.05 9 jun 2026", type: "source", verified: VERIFIED }),
  };
  const cand = (page: keyof typeof PAGES, text: string, extra: Partial<ReviewCandidate> = {}): ReviewCandidate => ({ text, page, evidence: [], ...extra });
  const raise = (a: ReviewCandidate, b: ReviewCandidate) => addReviewItem(vault, { kind: "contradiction", candidates: [a, b] }).item;

  it("closes open items between different records, keeps one document's and a verified claim's", () => {
    const snap = snapshot(PAGES);
    const declarations = raise(cand("sources/customs-7712004455.md", CUSTOMS.text), cand("sources/export-redacted.md", EXPORT.text));
    const drafts = raise(cand("sources/invoice-draft-pro-49.md", DRAFT.text), cand("sources/correction-4100000318.md", CORRECTION.text));
    const receipts = raise(cand("sources/adnet-receipt-0604.md", RECEIPT_4.text), cand("sources/adnet-receipt-0607.md", RECEIPT_7.text));
    const vat = raise(cand("sources/invoice-7000000202.md", VAT_A.text), cand("sources/customs-7712009999.md", VAT_B.text));
    const dated = raise(cand("sources/payment-receipt-0321.md", DATED_B.text), cand("sources/invoice-7000000192.md", DATED_A.text));
    // Not a record on one side, but the two claims name only a document's fields ("The total amount due") on pages
    // with different names: different subjects once template words are out.
    const notRecord = raise(cand("sources/correction-4100000318.md", CORRECTION.text), cand("entities/acme-widgets-pro.md", DRAFT.text));
    // Different records, and a person verified one side: the verified claim is untouched, the item closes for its reason.
    const verifiedSide = raise(
      cand("sources/customs-7712004455.md", "The declaration lists 4 parcels."),
      cand("sources/export-redacted.md", "The declaration lists 6 parcels.", { evidence: [{ kind: "verified-claim", page: "sources/export-redacted.md" }] }),
    );
    const verifiedId = raise(
      cand("sources/invoice-draft-starter-19.md", "The total amount due is €19.00.", { claimId: "finance/invoice-draft-starter-19/total" }),
      cand("sources/correction-4100000377.md", "The total amount due is €80.89."),
    );
    raise(cand("sources/receipt-verified-page.md", "The receipt total is €0.05."), cand("sources/adnet-receipt-0604.md", "The receipt total is €0.07."));

    const dry = rejudgeOpenContradictions(vault, snap, { dryRun: true });
    expect(dry).toMatchObject({ checked: 9, closed: 7, keptVerified: 0, stillOpen: 2, dryRun: true });
    expect(getReviewItem(vault, declarations.id)?.status).toBe("open");

    const done = rejudgeOpenContradictions(vault, snap);
    expect(done).toMatchObject({ checked: 9, closed: 7, keptVerified: 0, stillOpen: 2 });
    const reasons = Object.fromEntries(done.sample.map((s) => [s.id, s.reason]));
    expect(reasons).toMatchObject({
      [declarations.id]: DIFFERENT_RECORDS,
      [drafts.id]: DIFFERENT_RECORDS,
      [receipts.id]: "different dates",
      [verifiedSide.id]: DIFFERENT_RECORDS,
      [verifiedId.id]: DIFFERENT_RECORDS,
    });
    expect(done.sample.find((s) => s.id === notRecord.id)?.code).toBe("different-subjects");
    for (const item of [declarations, drafts]) {
      expect(getReviewItem(vault, item.id)?.resolution).toMatchObject({ action: "dismiss", by: "auto", note: RECORD_FILTER_NOTE });
    }
    expect(getReviewItem(vault, receipts.id)?.resolution).toMatchObject({ action: "dismiss", note: IDENTIFIER_FILTER_NOTE });
    // One invoice on two pages: still the owner's question.
    for (const item of [vat, dated]) expect(getReviewItem(vault, item.id)?.status, item.id).toBe("open");
    // Nothing left to close: a second run changes nothing.
    expect(rejudgeOpenContradictions(vault, snap)).toMatchObject({ checked: 2, closed: 0, keptVerified: 0, stillOpen: 2 });
  });

  it("reads the page type: an entity page is never a record", () => {
    const pages = new Map([
      ["a.md", { title: CORRECTION.title!, type: "source" }],
      ["b.md", { title: DRAFT.title!, type: "entity" }],
      ["c.md", { title: DRAFT.title!, type: "source" }],
    ]);
    const item = (b: string) => ({ kind: "contradiction" as const, candidates: [cand("sources/customs-7712004455.md", CORRECTION.text, { page: "a.md" }), cand("sources/customs-7712004455.md", DRAFT.text, { page: b })] });
    // The identifier filter alone: an entity page is no record.
    expect(identifierReason(item("b.md"), pages)).toBeNull();
    // The full rules: two claims naming only a document's fields, on pages of different names, are different subjects.
    expect(rejudgeVerdict({ ...item("b.md"), createdAt: "" }, pages)?.code).toBe("different-subjects");
    expect(rejudgeReason(item("c.md"), pages)).toBe(DIFFERENT_RECORDS);
    // A title alone (no type known) is read as before.
    expect(rejudgeReason(item("c.md"), new Map([["a.md", CORRECTION.title!], ["c.md", DRAFT.title!]]))).toBe(DIFFERENT_RECORDS);
  });

  it("tells an item touching an owner-verified claim by the snapshot alone: claim id on its page, claim text, or a verified page", () => {
    const index = verifiedIndex(snapshot(PAGES));
    expect([...index.claims]).toEqual(["finance/invoice-draft-starter-19/total"]);
    expect([...index.pages]).toEqual(["sources/receipt-verified-page.md"]);
    const plain = cand("sources/correction-4100000377.md", "The total amount due is €80.89.");
    const touches = (c: ReviewCandidate) => touchesVerified({ candidates: [plain, c] }, index);
    expect(touches(cand("sources/adnet-receipt-0604.md", "The receipt total is €0.07."))).toBe(false);
    // The evidence an item was raised with is history (any verifier, maybe undone since): not read.
    expect(touches(cand("sources/adnet-receipt-0604.md", "x", { evidence: [{ kind: "verified-claim" }] }))).toBe(false);
    // A verified claim's id on ANOTHER page (an old collision) is not that claim.
    expect(touches(cand("sources/adnet-receipt-0604.md", "x", { claimId: "finance/invoice-draft-starter-19/total" }))).toBe(false);
    expect(touches(cand("sources/invoice-draft-starter-19.md", "x", { claimId: "finance/invoice-draft-starter-19/total" }))).toBe(true);
    expect(touches(cand("sources/invoice-draft-starter-19.md", "The total amount due is €19.00."))).toBe(true);
    expect(touches(cand("sources/receipt-verified-page.md", "Anything on a verified page."))).toBe(true);
    // The assistant's verifications verify nothing here.
    const assistant = verifiedIndex(
      snapshot({
        "sources/assistant-checked.md": pageText({
          title: "Adnet receipt email 0.05 10 jun 2026",
          type: "source",
          verified: { at: "2026-02-01T00:00:00.000Z", by: "assistant" },
          claims: [claim("finance/assistant-checked/total", "The receipt total is €0.05.", { verified: { at: "2026-02-01T00:00:00.000Z", by: "assistant" }, status: "verified" })],
        }),
      }),
    );
    expect([...assistant.claims, ...assistant.pages]).toEqual([]);
  });
});
