/**
 * Why two claims are no contradiction pair: one rule set for the nightly pass
 * (which never sends such a pair to the judge) and for the re-judge of the
 * open queue (which closes an item raised before a rule existed, saying why).
 *
 * In order — the first that applies is the reason:
 *
 *  1. SAME DOCUMENT: the two pages are versions of one document, a draft and
 *     its final, a copy and its original (versions.ts). Their claims differ
 *     where the versions do; that is no question for the owner.
 *  2. DIFFERENT SUBJECTS by identifiers (identifiers.ts): different
 *     references (invoice, waybill, transfer numbers, company ids), different
 *     days or months, two records with no reference in common. A reference
 *     both sides share means one thing, and from here on nothing below can
 *     part the pair by its words.
 *  2b. SAME HUB: the two pages are record leaves of one monthly hub (two
 *     invoices of September, two receipts of one month — records.ts,
 *     structure.ts), and nothing above parted them: they are alike because
 *     the documents are, and a company's VAT number on both is a shared
 *     reference but no shared document.
 *  2c. EXPORT DATE: a customs, export or import declaration that cites an
 *     invoice by its number, against that invoice's page, each claim with one
 *     date and no amount, the declaration's 1 to {@link EXPORT_DATE_MAX_DAYS}
 *     days after the invoice's: the goods leave after they are invoiced, and
 *     the declaration's date is its own, not the invoice's. A date before the
 *     invoice's or further after it, an amount, VAT, a payment, a receipt or a
 *     waybill stays a question.
 *  3. SUPERSEDED (validity.ts): one claim sits on a deprecated page, or is
 *     historical, and the other is current; or their periods do not overlap
 *     (as of 12.10 against as of 14.10, the 2023 accounts against the 2025
 *     ones). The later claim is current.
 *  4. DIFFERENT SUBJECTS by words (subject.ts): what the claims are about
 *     differs once template words are out ("the net amount of credit note
 *     draft A" against "of credit note draft B").
 *
 * What none of these parts goes to the judge as before. Errs towards a pair:
 * an unknown page, a claim with no period, a title with no identifiers part
 * nothing.
 *
 * Pure.
 */

import { DIFFERENT_RECORDS, differentSubjects, invoiceCitations, sharedReference, textDates, type Identifiers } from "./identifiers";
import { amountsIn, type RecordType } from "./records";
import { sameSubject, type ClaimSubject } from "./subject";
import { describeValidity, laterOf, periodsDisjoint, type Validity } from "./validity";

/** One claim of a pair, with what the rules read of it and its page. */
export interface PairClaim {
  text: string;
  /** What it is about (subject.ts). */
  subject: ClaimSubject;
  /** The identifiers its page title and its text carry (identifiers.ts). Absent: none known. */
  ids?: Identifiers;
  /** Its page's version group (the winner's path), when the page is one of several versions of a document. */
  version?: string | null;
  /** When it holds (validity.ts). Absent or null: whenever. */
  validity?: Validity | null;
  /** Marked or worded as a past state of things. */
  historical?: boolean;
  /** Its page's `status` is `deprecated`. */
  deprecated?: boolean;
  /** Its page's record hub (`<type>/<month>`, records.ts `recordHubKey`) when the page is a record leaf. */
  hub?: string | null;
  /** Its page's record type (records.ts `sideRecordType`): an invoice, a customs declaration …; absent or null: no record. */
  recordType?: RecordType | null;
}

/** The most days a declaration may be dated after the invoice it cites for the two dates to be two documents' ({@link noPairReason} 2c). */
export const EXPORT_DATE_MAX_DAYS = 7;

/** Why a pair is no pair, as a code the re-judge counts by. */
export type NoPairCode =
  | "same-document"
  | "same-hub"
  | "export-date"
  | "different-identifiers"
  | "different-dates"
  | "different-months"
  | "different-records"
  | "different-subjects"
  | "superseded-deprecated"
  | "superseded-historical"
  | "superseded-period";

export interface NoPair {
  code: NoPairCode;
  /** What the code means for this pair, in a few words a person can audit. */
  detail: string;
  /** For a supersession: the side that is current. */
  current?: "a" | "b";
}

const IDENTIFIER_CODES: Readonly<Record<string, NoPairCode>> = {
  "different identifiers": "different-identifiers",
  "different dates": "different-dates",
  "different months": "different-months",
  [DIFFERENT_RECORDS]: "different-records",
};

/** Why two claims may not be judged as a pair, or null when they may (see the module comment). */
export function noPairReason(a: PairClaim, b: PairClaim): NoPair | null {
  if (a.version && a.version === b.version) return { code: "same-document", detail: "same document: draft vs final" };
  const shared = !!a.ids && !!b.ids && sharedReference(a.ids.ref, b.ids.ref);
  if (!shared && a.ids && b.ids) {
    const why = differentSubjects(a.ids, b.ids);
    if (why) return { code: IDENTIFIER_CODES[why] ?? "different-identifiers", detail: why };
  }
  if (a.hub && a.hub === b.hub) return { code: "same-hub", detail: `two records of one monthly hub (${a.hub})` };
  const exported = shared ? exportDate(a, b) : null;
  if (exported) return { code: "export-date", detail: exported };
  if (!!a.deprecated !== !!b.deprecated) {
    return { code: "superseded-deprecated", detail: "a claim on a deprecated page against a current one", current: a.deprecated ? "b" : "a" };
  }
  if (!!a.historical !== !!b.historical) {
    return { code: "superseded-historical", detail: "a historical claim against the current one", current: a.historical ? "b" : "a" };
  }
  if (a.validity && b.validity && periodsDisjoint(a.validity, b.validity)) {
    const current = laterOf(a.validity, b.validity);
    return { code: "superseded-period", detail: `${describeValidity(a.validity)} against ${describeValidity(b.validity)}`, current };
  }
  if (!shared && !sameSubject(a.subject, b.subject)) {
    return { code: "different-subjects", detail: `${subjectLabel(a.subject)} against ${subjectLabel(b.subject)}` };
  }
  return null;
}

/**
 * The same rules as {@link noPairReason}, as a yes/no with no reason built:
 * the pass asks it for every candidate pair (thousands per claim), so the
 * check that parts most pairs, the subject, comes first.
 */
export function pairable(a: PairClaim, b: PairClaim): boolean {
  if (a.version && a.version === b.version) return false;
  if (a.hub && a.hub === b.hub) return false;
  const shared = !!a.ids && !!b.ids && sharedReference(a.ids.ref, b.ids.ref);
  if (!shared && !sameSubject(a.subject, b.subject)) return false;
  if (!shared && a.ids && b.ids && differentSubjects(a.ids, b.ids)) return false;
  if (shared && exportDate(a, b) !== null) return false;
  if (!!a.deprecated !== !!b.deprecated || !!a.historical !== !!b.historical) return false;
  return !(a.validity && b.validity && periodsDisjoint(a.validity, b.validity));
}

/** Words of another fact than a document's date: a payment, a tax, a receipt, a delivery. */
const OTHER_FACT_WORDS =
  /(?<![\p{L}\p{N}])(?:paid|pays?|payments?|vat|tax(?:es)?|receipts?|deliver(?:y|ed)|shipped|waybills?|ддс|данъ[кц]\p{L}*|плат\p{L}*|плащ\p{L}*|разписк\p{L}*|доставк\p{L}*|товарителниц\p{L}*)(?![\p{L}\p{N}])/iu;

/** The one day a claim text names, or null when it names none, several, or a month. */
function onlyDay(text: string): string | null {
  const { date, month } = textDates(text);
  return date.size === 1 && month.size === 0 ? [...date][0] : null;
}

function daysAfter(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Rule 2c, for two sides that share a reference: why a declaration's claim and
 * the claim of the invoice it cites are two documents' dates, or null. The
 * reason names the invoice, both dates and the days between them.
 */
function exportDate(a: PairClaim, b: PairClaim): string | null {
  const [declaration, invoice] = a.recordType === "customs" && b.recordType === "invoice" ? [a, b] : b.recordType === "customs" && a.recordType === "invoice" ? [b, a] : [];
  if (!declaration || !invoice?.ids) return null;
  const invoiceRefs = invoice.ids.ref;
  const cited = invoiceCitations(declaration.text).find((c) => sharedReference(new Set([c.ref]), invoiceRefs));
  if (!cited) return null;
  const declared = onlyDay(declaration.text);
  const invoiced = onlyDay(invoice.text);
  if (!declared || !invoiced) return null;
  if (amountsIn(declaration.text).length > 0 || amountsIn(invoice.text).length > 0) return null;
  if (OTHER_FACT_WORDS.test(declaration.text) || OTHER_FACT_WORDS.test(invoice.text)) return null;
  const gap = daysAfter(invoiced, declared);
  if (gap < 1 || gap > EXPORT_DATE_MAX_DAYS) return null;
  return `invoice ${cited.written} dated ${invoiced}, the declaration citing it dated ${declared}: ${gap} day${gap === 1 ? "" : "s"} later`;
}

/** A subject as a short label: its words, at most six. */
function subjectLabel(s: ClaimSubject): string {
  const words = [...s.words].slice(0, 6).join(" ");
  return words === "" ? "(no subject)" : `"${words}"`;
}

/** The family a code belongs to, as the resolution note names it. */
export function noPairFamily(code: NoPairCode): "same document" | "different subjects" | "superseded" {
  if (code === "same-document") return "same document";
  return code.startsWith("superseded") ? "superseded" : "different subjects";
}
