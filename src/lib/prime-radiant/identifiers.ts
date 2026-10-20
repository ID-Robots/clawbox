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
 *  - in a page TITLE: dates (2026-09-14, 14.09.2026, 4 Jun 2026, Jun 7 2026,
 *    4 юни 2026), months (2026-09, June 2026), and any token of 5+ digits or
 *    of letters and 3+ digits (INV-2026-0012, 1Z999AA1, #48213);
 *  - in a claim TEXT: code-shaped references after a reference word
 *    (waybill, invoice, order, transfer, parcel, tracking, shipment,
 *    reference, #, №) — six digits or more, or letters and digits; never a
 *    bare amount ("order 12 units", "10 EUR against 12 EUR") and never a
 *    date (two dates in claims about one thing may be the contradiction).
 *
 * One reference is one thing however it is written: two refs whose digits
 * agree (six or more, one the tail of the other — "INV-2026-000123" in a
 * title, "invoice 2026-000123" in a claim) are the same ref.
 *
 * Two sides are different subjects when both carry references and those
 * share none, or — sharing none — their TITLES carry different days or
 * months. A shared reference means one thing: never filtered.
 *
 * RECORD pages are stricter. A page per document — an invoice, a receipt, a
 * credit note, a waybill, a customs or export declaration, a bank transfer, a
 * statement, a day's report, a draft invoice ({@link recordPage}) — is one of
 * many alike, and two of them are one document only when they share a
 * reference: two record pages with none in common are different records, even
 * when one side carries no reference at all ("the invoice is dated 15.07.2026
 * with a redacted number"). A pair with a page that is no record (an entity, a
 * synthesis, a decision, a how-to, or a title that names no document) keeps
 * the rules above.
 *
 * Errs towards keeping a pair: anything unclear goes to the judge as before.
 *
 * Pure.
 */

export type IdentifierKind = "date" | "month" | "ref";

export interface Identifiers {
  date: Set<string>;
  month: Set<string>;
  ref: Set<string>;
  /** The side's page is a record: one document of many alike ({@link recordPage}). */
  record: boolean;
}

/**
 * The words a reference follows. A company's own identifiers are among them
 * (TIN, VAT number, EIK/BULSTAT, IBAN): two claims that name one company by
 * its id are about that company, whatever documents they sit on, so a claim
 * pair "exporter Acme EOOD, TIN X" / "importer Acme OOD, TIN X" is one subject.
 */
const REF_WORDS =
  "waybill|awb|invoice|inv|order|transfer|parcel|package|tracking|shipment|consignment|receipt|reference|ref|transaction|txn|proforma|credit\\s+note|" +
  "tin|vat\\s+(?:no|number|id|reg(?:istration)?(?:\\s+no)?)\\.?|vat|eik|еик|bulstat|булстат|uic|company\\s+(?:id|no|number)|registration\\s+(?:no|number)|ддс\\s*№?|iban|#|№";

const REF_AFTER_WORD = new RegExp(`(?:^|[^\\p{L}])(?:${REF_WORDS})\\s*[:#№]?\\s*([A-Za-z]{0,6}[-/]?\\d[\\dA-Za-z/-]{2,})`, "giu");
const HASH_REF = /[#№]\s*([A-Za-z]{0,6}\d[\dA-Za-z-]{2,})/gu;

/** Month names and their abbreviations, English and Bulgarian. */
const MONTHS: Readonly<Record<string, number>> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
  януари: 1, яну: 1, февруари: 2, фев: 2, март: 3, мар: 3, април: 4, апр: 4, май: 5, юни: 6, юли: 7, август: 8, авг: 8,
  септември: 9, септ: 9, сеп: 9, октомври: 10, окт: 10, ноември: 11, ное: 11, декември: 12, дек: 12,
};
/** The month names (and abbreviations) a date may be written with, longest first, as a regex alternation. */
export const MONTH_NAMES = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const MONTH = `(${MONTH_NAMES})(?!\\p{L})\\.?`;

/** The month (1-12) a month name or abbreviation names, or null. */
export function monthNumber(name: string): number | null {
  return MONTHS[name.toLowerCase().replace(/\.$/, "")] ?? null;
}
/** Not inside a word or a number, and not the decimals of an amount ("0.02 Jun 2026" is no 2 June). */
const START = "(?<![\\p{L}\\p{N}])(?<!\\d[.,])";
const END = "(?![\\p{L}\\p{N}])";
const ORDINAL = "(?:st|nd|rd|th)?";
/** "4 Jun 2026", "04-Jun-2026", "4th of June, 2026", "4 юни 2026". */
const DAY_MONTH_YEAR = new RegExp(`${START}(\\d{1,2})${ORDINAL}\\.?[\\s/-]*(?:of\\s+)?${MONTH},?[\\s/-]*(\\d{4})${END}`, "giu");
/** "Jun 7 2026", "June 7th, 2026". */
const MONTH_DAY_YEAR = new RegExp(`${START}${MONTH}[\\s/-]*(\\d{1,2})${ORDINAL},?[\\s/-]+(\\d{4})${END}`, "giu");
/** "June 2026", "Jun-2026". */
const MONTH_YEAR = new RegExp(`${START}${MONTH},?[\\s/-]*(\\d{4})${END}`, "giu");

function empty(): Identifiers {
  return { date: new Set(), month: new Set(), ref: new Set(), record: false };
}

function pad(n: string): string {
  return n.length === 1 ? `0${n}` : n;
}

function normRef(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^0+(?=\d)/, "");
}

function year(y: string): boolean {
  return /^(19|20)\d{2}$/.test(y);
}

/** A day that is on the calendar: never "31 June" or "29 Feb" of a common year. */
function addDay(out: Identifiers, y: string, m: string | number, d: string): void {
  const month = +m;
  const day = +d;
  if (!year(y) || month < 1 || month > 12) return;
  const lastDay = new Date(Date.UTC(+y, month, 0)).getUTCDate();
  if (day >= 1 && day <= lastDay) out.date.add(`${y}-${pad(String(month))}-${pad(String(day))}`);
}

/** Dates and months in a text, normalised to YYYY-MM-DD / YYYY-MM; their spans are blanked so they are not read as refs. */
function readDates(text: string, out: Identifiers): string {
  let rest = text.replace(/\b(20\d{2}|19\d{2})[-_./](\d{1,2})[-_./](\d{1,2})\b/g, (_m, y: string, m: string, d: string) => {
    addDay(out, y, m, d);
    return " ";
  });
  rest = rest.replace(/\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2}|19\d{2})\b/g, (_m, d: string, m: string, y: string) => {
    addDay(out, y, m, d);
    return " ";
  });
  const named = (m: string, name: string, y: string, d?: string) => {
    const mo = MONTHS[name.toLowerCase()];
    if (!year(y)) return m;
    if (d === undefined) out.month.add(`${y}-${pad(String(mo))}`);
    else addDay(out, y, mo, d);
    return " ";
  };
  rest = rest.replace(DAY_MONTH_YEAR, (m, d: string, name: string, y: string) => named(m, name, y, d));
  rest = rest.replace(MONTH_DAY_YEAR, (m, name: string, d: string, y: string) => named(m, name, y, d));
  rest = rest.replace(MONTH_YEAR, (m, name: string, y: string) => named(m, name, y));
  rest = rest.replace(/\b(20\d{2})[-_./](\d{1,2})\b(?![-./]\d)/g, (m, y: string, mo: string) => {
    if (+mo >= 1 && +mo <= 12) {
      out.month.add(`${y}-${pad(mo)}`);
      return " ";
    }
    return m;
  });
  return rest;
}

/** A text with its dates and months blanked: what names a thing, without when. */
export function withoutDates(text: string): string {
  return readDates(text, empty());
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

// ── record pages ──────────────────────────────────────────────────────────

/** Page types that are never one record of many: what a person reads about a thing, not the thing's paper. */
const NON_RECORD_TYPES: ReadonlySet<string> = new Set(["entity", "synthesis", "decision", "howto"]);

const words = (alternatives: readonly string[]) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.map((a) => a.replace(/ /g, "[\\s_-]*")).join("|")})(?![\\p{L}])`, "iu");

/** Title words that name a document of which there are many: the title alone makes the page a record. */
const RECORD_WORDS = words([
  "invoices?", "e-?invoices?", "inv", "pro ?formas?", "receipts?", "credit notes?", "debit notes?", "credit memos?",
  "waybills?", "air ?waybills?", "awb", "bills? of lading", "consignment notes?", "delivery notes?", "packing lists?",
  "customs declarations?", "export declarations?", "import declarations?", "customs entr(?:y|ies)",
  "bank transfers?", "wire transfers?", "payment orders?", "remittances?", "bank statements?", "account statements?",
  "card statements?", "statements? of account", "daily (?:sales )?reports?", "z ?reports?", "shift reports?",
  "end of day reports?", "purchase orders?", "order confirmations?", "payment confirmations?", "pay ?slips?",
  // Bulgarian: фактура, проформа, кредитно/дебитно известие, касова бележка, разписка, товарителница,
  // митническа/износна/експортна декларация, платежно нареждане, банково извлечение, дневен отчет.
  "фактур[аи]", "проформ[аи]", "кредитн[оия]+ извести[ея]", "дебитн[оия]+ извести[ея]", "касов[аи] бележк[аи]", "разписк[аи]",
  "товарителниц[аи]", "митническ[аи] декларации?я?", "износн[аи] декларации?я?", "експортн[аи] декларации?я?",
  "платежн[оия]+ нарежд(?:ане|ания)", "банков[оия]+ извлечени[ея]", "дневен отчет", "дневни отчети", "z ?отчети?",
]);

/** Words that name a document only next to an identifier: "correction draft 4100000318", "Statement 2026-09". */
const DOCUMENT_WORDS = words([
  "drafts?", "corrections?", "corrective", "declarations?", "transfers?", "statements?", "reports?", "orders?", "bills?",
  "shipments?", "parcels?", "consignments?", "payments?", "payouts?", "refunds?", "quotes?", "quotations?", "vouchers?",
  "tickets?", "bookings?", "settlements?", "deposits?", "withdrawals?", "filings?", "returns?",
  "декларации?я?", "извлечени[ея]", "отчети?", "преводи?", "поръчк[аи]", "плащан(?:е|ия)", "протоколи?",
]);

/** Words of a page ABOUT such documents, not one of them: "Invoice process", "Receipt policy", "Waybill template". */
const TOPIC_WORDS = words([
  "process(?:es|ing)?", "polic(?:y|ies)", "procedures?", "rules?", "templates?", "guides?", "guidelines?", "how ?to",
  "workflows?", "overview", "checklists?", "formats?", "requirements?", "numbering", "setup", "settings", "system", "faq",
  "процес", "политика", "правила", "шаблон", "ръководство", "инструкци[яи]",
]);

/** Whether a title is about documents rather than one of them ("Invoice process", "Receipt policy", "Waybill template"). */
export function topicTitle(title: string | null | undefined): boolean {
  return !!title && TOPIC_WORDS.test(title);
}

/**
 * Whether a page is a RECORD — one document of many alike (an invoice, a
 * receipt, a waybill, a declaration, a transfer, a statement, a day's report):
 * its title names such a document, or names a draft, a correction, a report,
 * an order … next to an identifier (a reference, a day or a month). An
 * entity, a synthesis, a decision or a how-to page never is, nor a page about
 * such documents ("Invoice process", "Receipt policy").
 */
export function recordPage(title: string | null | undefined, type?: string | null): boolean {
  if (!title || (type && NON_RECORD_TYPES.has(type)) || TOPIC_WORDS.test(title)) return false;
  if (RECORD_WORDS.test(title)) return true;
  if (!DOCUMENT_WORDS.test(title)) return false;
  const ids = titleIdentifiers(title);
  return ids.ref.size + ids.date.size + ids.month.size > 0;
}

// ── claims, sides, pairs ──────────────────────────────────────────────────

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
  return {
    date: new Set([...a.date, ...b.date]),
    month: new Set([...a.month, ...b.month]),
    ref: new Set([...a.ref, ...b.ref]),
    record: a.record || b.record,
  };
}

/** Everything one side of a pair is identified by: its page title's identifiers and its claim's, and whether its page is a record. */
export function sideIdentifiers(title: string | null | undefined, text: string, type?: string | null): Identifiers {
  return { ...merge(titleIdentifiers(title), claimIdentifiers(text)), record: recordPage(title, type) };
}

/** The fewest digits that make a reference's number its own, whatever letters and separators it is written with. */
const MIN_REF_DIGITS = 6;

/**
 * One reference written two ways: the same, or digits that agree — six or
 * more, one the tail of the other ("AC-INV-2026-000123" in a title and
 * "invoice 2026-000123" in a claim). Errs towards one thing: a pair is kept.
 * Leading zeros are padding, not digits: "INV-000001" is no tail of "INV-1000001".
 */
function sameRef(x: string, y: string): boolean {
  if (x === y) return true;
  const dx = x.replace(/\D/g, "").replace(/^0+/, "");
  const dy = y.replace(/\D/g, "").replace(/^0+/, "");
  const [short, long] = dx.length <= dy.length ? [dx, dy] : [dy, dx];
  return short.length >= MIN_REF_DIGITS && long.endsWith(short);
}

function sharedRef(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const x of a) for (const y of b) if (sameRef(x, y)) return true;
  return false;
}

/** Whether two sets of references name one thing: a reference on both sides, however each is written. */
export function sharedReference(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return sharedRef(a, b);
}

function disjoint(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const x of a) if (b.has(x)) return false;
  return true;
}

/** The reason {@link differentSubjects} gives two record pages that share no reference. */
export const DIFFERENT_RECORDS = "different records (no shared reference)";

/**
 * Why two sides are about different things, or null when nothing says so:
 * different refs (waybill, invoice, transfer, order numbers), different days,
 * different months (a day's month counts as its month), or two record pages
 * with no reference in common.
 */
export function differentSubjects(a: Identifiers, b: Identifiers): string | null {
  // One reference on both sides: the same thing, whatever its dates say.
  if (sharedRef(a.ref, b.ref)) return null;
  if (a.ref.size > 0 && b.ref.size > 0) return "different identifiers";
  if (disjoint(a.date, b.date)) return "different dates";
  const months = (x: Identifiers) => new Set([...x.month, ...[...x.date].map((d) => d.slice(0, 7))]);
  const ma = months(a);
  const mb = months(b);
  if (a.month.size + b.month.size > 0 && disjoint(ma, mb)) return "different months";
  // Two invoices, two receipts, two declarations: one document only when a reference says so.
  if (a.record && b.record) return DIFFERENT_RECORDS;
  return null;
}

/** One side of a pair: its page's title (and type, when known) and its claim text. */
export interface PairSide {
  title?: string | null;
  type?: string | null;
  text: string;
}

/** Shorthand: different subjects for two (title, type, claim text) sides. */
export function differentSubjectSides(a: PairSide, b: PairSide): string | null {
  return differentSubjects(sideIdentifiers(a.title, a.text, a.type), sideIdentifiers(b.title, b.text, b.type));
}

/** The resolution note an item closed by this filter carries. */
export const IDENTIFIER_FILTER_NOTE = "auto: different subjects (identifier filter)";
/** The note of an item closed because its two sides are two record pages with no reference in common. */
export const RECORD_FILTER_NOTE = "auto: different records, no shared reference (identifier filter)";
