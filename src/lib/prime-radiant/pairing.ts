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

import { DIFFERENT_RECORDS, differentSubjects, sharedReference, type Identifiers } from "./identifiers";
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
}

/** Why a pair is no pair, as a code the re-judge counts by. */
export type NoPairCode =
  | "same-document"
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
  const shared = !!a.ids && !!b.ids && sharedReference(a.ids.ref, b.ids.ref);
  if (!shared && !sameSubject(a.subject, b.subject)) return false;
  if (!shared && a.ids && b.ids && differentSubjects(a.ids, b.ids)) return false;
  if (!!a.deprecated !== !!b.deprecated || !!a.historical !== !!b.historical) return false;
  return !(a.validity && b.validity && periodsDisjoint(a.validity, b.validity));
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
