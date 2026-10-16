/**
 * The identifier filter: two claims about things that carry DIFFERENT
 * identifiers are about two different things, and never a contradiction.
 *
 * On a real vault every open contradiction item sampled was false: two
 * waybills, two bank transfers, two daily sales reports of different days —
 * pages one per shipment / transfer / invoice / day, whose claims read alike
 * ("The parcel was delivered on …", "Total sales were …") because the things
 * are alike. Their titles (and often their claims) carry the identifier that
 * tells them apart; this module reads those identifiers deterministically, so
 * such a pair is never sent to the judge and an item already raised for one
 * can be closed with a reason.
 *
 * Identifiers read:
 *  - in a page TITLE: dates (2026-09-14, 14.09.2026, 2026-09), and any token
 *    of 5+ digits or of letters and 3+ digits (INV-2026-0012, 1Z999AA1, #48213);
 *  - in a claim TEXT: code-shaped references after a reference word
 *    (waybill, invoice, order, transfer, parcel, tracking, shipment,
 *    reference, #, №) — six digits or more, or letters and digits; never a
 *    bare amount ("order 12 units", "10 EUR against 12 EUR") and never a
 *    date (two dates in claims about one thing may be the contradiction).
 *
 * Two sides are different subjects when both carry references and those
 * share none, or — sharing none — their TITLES carry different days or
 * months. A shared reference means one thing: never filtered. Errs towards
 * keeping a pair: anything unclear goes to the judge as before.
 *
 * Pure.
 */

export type IdentifierKind = "date" | "month" | "ref";

export interface Identifiers {
  date: Set<string>;
  month: Set<string>;
  ref: Set<string>;
}

const REF_WORDS =
  "waybill|awb|invoice|inv|order|transfer|parcel|package|tracking|shipment|consignment|receipt|reference|ref|transaction|txn|proforma|credit\\s+note|#|№";

const REF_AFTER_WORD = new RegExp(`(?:^|[^\\p{L}])(?:${REF_WORDS})\\s*[:#№]?\\s*([A-Za-z]{0,6}[-/]?\\d[\\dA-Za-z/-]{2,})`, "giu");
const HASH_REF = /[#№]\s*([A-Za-z]{0,6}\d[\dA-Za-z-]{2,})/gu;

function empty(): Identifiers {
  return { date: new Set(), month: new Set(), ref: new Set() };
}

function pad(n: string): string {
  return n.length === 1 ? `0${n}` : n;
}

function normRef(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^0+(?=\d)/, "");
}

/** Dates and months in a text, normalised to YYYY-MM-DD / YYYY-MM; their spans are blanked so they are not read as refs. */
function readDates(text: string, out: Identifiers): string {
  let rest = text.replace(/\b(20\d{2}|19\d{2})[-_./](\d{1,2})[-_./](\d{1,2})\b/g, (_m, y: string, m: string, d: string) => {
    if (+m >= 1 && +m <= 12 && +d >= 1 && +d <= 31) out.date.add(`${y}-${pad(m)}-${pad(d)}`);
    return " ";
  });
  rest = rest.replace(/\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2}|19\d{2})\b/g, (_m, d: string, m: string, y: string) => {
    if (+m >= 1 && +m <= 12 && +d >= 1 && +d <= 31) out.date.add(`${y}-${pad(m)}-${pad(d)}`);
    return " ";
  });
  rest = rest.replace(/\b(20\d{2})[-_./](\d{1,2})\b(?![-./]\d)/g, (m, y: string, mo: string) => {
    if (+mo >= 1 && +mo <= 12) {
      out.month.add(`${y}-${pad(mo)}`);
      return " ";
    }
    return m;
  });
  return rest;
}

/** The identifiers a page title carries. */
export function titleIdentifiers(title: string | null | undefined): Identifiers {
  const out = empty();
  if (!title) return out;
  const rest = readDates(title, out);
  for (const raw of rest.split(/[\s,;:()[\]{}"'“”]+/)) {
    const tok = raw.replace(/^[#№]/, "").replace(/[.]+$/, "");
    if (tok === "") continue;
    const digits = (tok.match(/\d/g) ?? []).length;
    const letters = /[A-Za-z]/.test(tok);
    if (digits >= 5 || (letters && digits >= 3 && /^[A-Za-z0-9/-]+$/.test(tok))) {
      // A bare year is a date's part, not an identifier.
      if (/^(19|20)\d{2}$/.test(tok)) continue;
      out.ref.add(normRef(tok));
    }
  }
  return out;
}

/** A reference that looks like a code, not an amount: six digits or more, or letters with three digits or more. */
function codeShaped(tok: string): boolean {
  const digits = (tok.match(/\d/g) ?? []).length;
  return digits >= 6 || (/[A-Za-z]/.test(tok) && digits >= 3);
}

/** The references a claim text carries after a reference word. Dates in a claim are left out on purpose. */
export function claimIdentifiers(text: string): Identifiers {
  const out = empty();
  const rest = readDates(text, empty());
  for (const re of [REF_AFTER_WORD, HASH_REF]) {
    re.lastIndex = 0;
    for (const m of rest.matchAll(re)) {
      const tok = m[1].replace(/[-/]+$/, "");
      if (!codeShaped(tok)) continue;
      out.ref.add(normRef(tok));
    }
  }
  return out;
}

function merge(a: Identifiers, b: Identifiers): Identifiers {
  return { date: new Set([...a.date, ...b.date]), month: new Set([...a.month, ...b.month]), ref: new Set([...a.ref, ...b.ref]) };
}

/** Everything one side of a pair is identified by: its page title's identifiers and its claim's. */
export function sideIdentifiers(title: string | null | undefined, text: string): Identifiers {
  return merge(titleIdentifiers(title), claimIdentifiers(text));
}

function disjoint(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const x of a) if (b.has(x)) return false;
  return true;
}

/**
 * Why two sides are about different things, or null when nothing says so:
 * different refs (waybill, invoice, transfer, order numbers), different days,
 * or different months (a day's month counts as its month).
 */
export function differentSubjects(a: Identifiers, b: Identifiers): string | null {
  // One reference on both sides: the same thing, whatever its dates say.
  for (const r of a.ref) if (b.ref.has(r)) return null;
  if (disjoint(a.ref, b.ref)) return "different identifiers";
  if (disjoint(a.date, b.date)) return "different dates";
  const months = (x: Identifiers) => new Set([...x.month, ...[...x.date].map((d) => d.slice(0, 7))]);
  const ma = months(a);
  const mb = months(b);
  if (a.month.size + b.month.size > 0 && disjoint(ma, mb)) return "different months";
  return null;
}

/** Shorthand: different subjects for two (title, claim text) sides. */
export function differentSubjectSides(
  a: { title?: string | null; text: string },
  b: { title?: string | null; text: string },
): string | null {
  return differentSubjects(sideIdentifiers(a.title, a.text), sideIdentifiers(b.title, b.text));
}

/** The resolution note an item closed by this filter carries. */
export const IDENTIFIER_FILTER_NOTE = "auto: different subjects (identifier filter)";
