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
  differentSubjectSides,
  IDENTIFIER_FILTER_NOTE,
  sideIdentifiers,
  titleIdentifiers,
} from "@/lib/prime-radiant/identifiers";
import { rejudgeOpenContradictions } from "@/lib/prime-radiant/rejudge";
import { addReviewItem, getReviewItem } from "@/lib/prime-radiant/review-store";
import { claimSubject } from "@/lib/prime-radiant/subject";
import { pageText, snapshot } from "../helpers/prime-radiant-fixtures";

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
    expect([...claimIdentifiers("Waybill 1054432198 was delivered on 14.09.2026.").date]).toEqual(["2026-09-14"]);
    expect(claimIdentifiers("The widget costs 12000 EUR.").ref.size).toBe(0);
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
