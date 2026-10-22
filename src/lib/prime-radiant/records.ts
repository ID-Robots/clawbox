/**
 * Record leaves: the pages a vault holds one per document — an invoice, a
 * credit note, a receipt, a bank transfer, a shipment (waybill), a customs
 * declaration, an ad platform's receipt. Thousands of them, alike, each with a
 * date, often a counterparty and an amount; the structure pass (structure.ts)
 * rolls them up into monthly hubs.
 *
 * {@link classifyRecord} reads, in order:
 *  1. the page's own `record` frontmatter when a person or the model set it
 *     (`record.by` other than `rules`) — what someone decided stands;
 *  2. its TITLE: a document word of one of the {@link RECORD_TYPES} (English
 *     and Bulgarian), most specific first — a credit note before an invoice,
 *     an ad platform's receipt before a receipt, a customs declaration before
 *     a shipment;
 *  3. its CLAIMS, when the title names no kind: the kind most of its facts
 *     name, with a reference after the word ("invoice no. 4500012345").
 * A page needs a month too (its title's day or month, a `date` field, a
 * claim's `as_of` / `valid_from`, else the first date in its facts): a record
 * with no date is no leaf of a monthly hub. Never an entity, synthesis,
 * decision or how-to page, nor a page ABOUT such documents ("Invoice process").
 *
 * The amount is the record's total in one currency (a claim saying "total",
 * "amount due", "общо" first, else the one amount its facts agree on); the
 * counterparty is a company name with a legal suffix (never the owner's own
 * company). Both may be null: unknown is never guessed.
 *
 * Pure.
 */

import { claimIdentifiers, titleIdentifiers, topicTitle, withoutAddresses } from "./identifiers";
import { isIsoDate, type PageFrontmatter } from "./schema";

export const RECORD_TYPES = ["invoice", "credit-note", "receipt", "bank-transfer", "shipment", "customs", "ad-receipt"] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

/** Who decided a record's type: the rules here, the cheap model, or a person (any other name). */
export type RecordBy = "rules" | "model" | string;

/** Page types that are never one record of many. */
const NON_RECORD_TYPES: ReadonlySet<string> = new Set(["entity", "synthesis", "decision", "howto", "metric"]);

/** The plural a hub's title uses, and the singular a leaf's line does. */
export const RECORD_LABELS: Readonly<Record<RecordType, { one: string; many: string }>> = {
  invoice: { one: "invoice", many: "Invoices" },
  "credit-note": { one: "credit note", many: "Credit notes" },
  receipt: { one: "receipt", many: "Receipts" },
  "bank-transfer": { one: "bank transfer", many: "Bank transfers" },
  shipment: { one: "shipment", many: "Shipments" },
  customs: { one: "customs declaration", many: "Customs declarations" },
  "ad-receipt": { one: "ad platform receipt", many: "Ad platform receipts" },
};

const w = (alternatives: readonly string[]) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.map((a) => a.replace(/ /g, "[\\s_-]*")).join("|")})(?![\\p{L}])`, "iu");

/** Ads, advertising, a campaign: what makes a receipt or invoice an ad platform's. */
const AD_WORDS = w(["ads", "ad spend", "advertising", "adwords", "ad account", "ad campaign", "campaigns?", "sponsored", "рекламн[аи]", "реклама"]);
const BILLING_WORDS = w(["receipts?", "invoices?", "billing", "charges?", "statements?", "фактур[аи]", "разписк[аи]"]);

/**
 * Most specific first: the first type whose words a title holds is the type.
 * A WEAK word ("transfer", "courier", "tracking") names a record only beside
 * a code-shaped reference: "Transfer TR-88001234" is one, "Transfer of
 * ownership 2026-03" is not.
 */
const WEAK_KINDS: ReadonlyArray<[RecordType, RegExp]> = [
  ["shipment", w(["tracking", "courier", "parcels?", "пратк[аи]", "доставк[аи]"])],
  ["bank-transfer", w(["transfers?", "преводи?"])],
];

const TITLE_KINDS: ReadonlyArray<[RecordType, RegExp]> = [
  ["credit-note", w(["credit notes?", "credit memos?", "debit notes?", "кредитн[оия]+ извести[ея]", "дебитн[оия]+ извести[ея]"])],
  [
    "customs",
    w([
      "customs declarations?", "export declarations?", "import declarations?", "customs entr(?:y|ies)", "customs clearance", "single administrative document",
      "mrn", "ead", "митническ[аи] декларации?я?", "износн[аи] декларации?я?", "експортн[аи] декларации?я?", "вносн[аи] декларации?я?",
    ]),
  ],
  [
    "shipment",
    w([
      "waybills?", "air ?waybills?", "awb", "bills? of lading", "consignment notes?", "delivery notes?", "shipping labels?", "shipments?",
      "consignments?", "товарителниц[аи]",
    ]),
  ],
  [
    "bank-transfer",
    w([
      "bank transfers?", "wire transfers?", "sepa transfers?", "payment orders?", "remittances?", "outgoing payments?", "incoming payments?",
      "платежн[оия]+ нарежд(?:ане|ания)", "банков[и]? преводи?",
    ]),
  ],
  ["receipt", w(["receipts?", "cash receipts?", "sales receipts?", "касов[аи] бележк[аи]", "разписк[аи]", "фискален бон"])],
  ["invoice", w(["invoices?", "e-?invoices?", "inv", "pro ?formas?", "tax invoices?", "фактур[аи]", "проформ[аи]"])],
];

/** The kind words a CLAIM uses for its document, with a reference after them ("invoice no. 4500012345"). */
const CLAIM_KINDS: ReadonlyArray<[RecordType, RegExp]> = [...TITLE_KINDS, ...WEAK_KINDS];

/** Currency codes and symbols an amount is read with. */
const CURRENCY_CODES = ["EUR", "USD", "GBP", "BGN", "CHF", "PLN", "RON", "CZK", "HUF", "SEK", "NOK", "DKK", "JPY", "CNY", "CAD", "AUD", "TRY"];
const SYMBOLS: Readonly<Record<string, string>> = { "€": "EUR", $: "USD", "£": "GBP", "¥": "JPY", лв: "BGN", "лв.": "BGN" };

const NUM = "(\\d{1,3}(?:[ \\u00a0.,]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)";
const CODE = `(${CURRENCY_CODES.join("|")}|€|\\$|£|¥|лв\\.?)`;
const AMOUNT_AFTER = new RegExp(`${CODE}\\s?${NUM}(?![\\d])`, "giu");
const AMOUNT_BEFORE = new RegExp(`(?<![\\d.,])${NUM}\\s?${CODE}(?![\\p{L}])`, "giu");
const TOTAL_WORDS = w([
  "total", "grand total", "total amount", "amount due", "total due", "balance due", "amount paid", "total paid", "sum", "общо", "обща сума",
  "сума за плащане", "сума", "стойност",
]);

/** A company name with its legal suffix: a counterparty. */
const ORG_SUFFIX = "(?:Ltd|Limited|GmbH|Inc|LLC|OOD|EOOD|AD|EAD|Corp|AG|SA|BV|SRL|PLC|Oy|AB|ApS|ООД|ЕООД|АД|ЕАД)";
const ORG_RE = new RegExp(`((?:[\\p{Lu}][\\p{L}\\p{N}&'-]*\\s+){0,3}[\\p{Lu}][\\p{L}\\p{N}&'-]*\\s+${ORG_SUFFIX})(?![\\p{L}])\\.?`, "gu");

export interface RecordAmount {
  currency: string;
  /** In the currency's major unit, to the cent. */
  value: number;
}

export interface RecordInfo {
  type: RecordType;
  /** YYYY-MM */
  month: string;
  /** YYYY-MM-DD when known. */
  day: string | null;
  counterparty: string | null;
  amount: RecordAmount | null;
  /** The first reference its title carries, normalised (identifiers.ts). */
  ref: string | null;
  /** What decided its type. */
  via: "frontmatter" | "title" | "claims";
  /** Who: `rules`, `model`, or a person. */
  by: RecordBy;
}

/** The `record` frontmatter a leaf carries once a pass has seen it (structure.ts writes it). */
export interface RecordFrontmatter {
  type: RecordType;
  month: string;
  /** The hub page that lists it. */
  hub?: string;
  by?: RecordBy;
}

export function isRecordType(v: unknown): v is RecordType {
  return typeof v === "string" && (RECORD_TYPES as readonly string[]).includes(v);
}

/** A page's `record` frontmatter, read strictly; null when absent or malformed. */
export function readRecordFrontmatter(fm: Pick<PageFrontmatter, "record"> | Record<string, unknown>): RecordFrontmatter | null {
  const raw = (fm as Record<string, unknown>).record;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isRecordType(r.type) || typeof r.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(r.month)) return null;
  return {
    type: r.type,
    month: r.month,
    ...(typeof r.hub === "string" && r.hub !== "" ? { hub: r.hub } : {}),
    ...(typeof r.by === "string" && r.by !== "" ? { by: r.by } : {}),
  };
}

/** The type a title names, most specific first; null when it names none (or is about such documents). */
export function titleRecordType(title: string): RecordType | null {
  if (topicTitle(title)) return null;
  if (AD_WORDS.test(title) && BILLING_WORDS.test(title)) return "ad-receipt";
  const strong = TITLE_KINDS.find(([, re]) => re.test(title))?.[0];
  if (strong) return strong;
  const weak = WEAK_KINDS.find(([, re]) => re.test(title))?.[0];
  return weak && titleIdentifiers(title).ref.size > 0 ? weak : null;
}

/** The type most of a page's facts name next to a reference (theirs, or one in the page's title); null when none does, or two tie. */
export function claimsRecordType(claimTexts: readonly string[], titleHasRef = false): RecordType | null {
  const votes = new Map<RecordType, number>();
  let referenced = titleHasRef;
  for (const text of claimTexts) {
    const type = AD_WORDS.test(text) && BILLING_WORDS.test(text) ? "ad-receipt" : CLAIM_KINDS.find(([, re]) => re.test(text))?.[0];
    if (!type) continue;
    votes.set(type, (votes.get(type) ?? 0) + 1);
    if (claimIdentifiers(text).ref.size > 0) referenced = true;
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0 || (ranked[1] && ranked[1][1] === ranked[0][1])) return null;
  // One mention needs a reference beside it; two or more name the document by themselves.
  return referenced || ranked[0][1] >= 2 ? ranked[0][0] : null;
}

/** "1.234,56" / "1,234.56" / "1 234,56" / "12,5" → 1234.56 / 12.5; null when it is no number. */
export function parseAmountNumber(raw: string): number | null {
  const s = raw.replace(/[\s ]/g, "");
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let normal: string;
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? "." : ",";
    const thou = dec === "." ? "," : ".";
    normal = s.split(thou).join("").replace(dec, ".");
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const parts = s.split(sep);
    // One separator with three digits after it, or several: thousands. Else decimals.
    normal = parts.length > 2 || parts[parts.length - 1].length === 3 ? parts.join("") : parts.join(".");
  } else normal = s;
  const n = Number(normal);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function currencyOf(raw: string): string {
  const up = raw.toUpperCase();
  return SYMBOLS[raw] ?? SYMBOLS[raw.toLowerCase()] ?? up.replace(/\.$/, "");
}

/** Every amount with a currency a text names, in order. */
export function amountsIn(text: string): RecordAmount[] {
  const out: Array<RecordAmount & { at: number }> = [];
  for (const m of text.matchAll(AMOUNT_AFTER)) {
    const value = parseAmountNumber(m[2]);
    if (value !== null) out.push({ currency: currencyOf(m[1]), value, at: m.index ?? 0 });
  }
  for (const m of text.matchAll(AMOUNT_BEFORE)) {
    const at = m.index ?? 0;
    // "EUR 12 EUR" read twice is one amount.
    if (out.some((o) => Math.abs(o.at - at) < 4)) continue;
    const value = parseAmountNumber(m[1]);
    if (value !== null) out.push({ currency: currencyOf(m[2]), value, at });
  }
  return out.sort((a, b) => a.at - b.at).map(({ currency, value }) => ({ currency, value }));
}

function frontmatterAmount(fm: Record<string, unknown>): RecordAmount | null {
  const record = (fm.record && typeof fm.record === "object" ? fm.record : {}) as Record<string, unknown>;
  for (const src of [record, fm]) {
    const value = typeof src.amount === "number" ? src.amount : typeof src.total === "number" ? src.total : null;
    const currency = typeof src.currency === "string" ? src.currency.trim().toUpperCase() : "";
    if (value !== null && Number.isFinite(value) && /^[A-Z]{3}$/.test(currency)) return { currency, value: Math.round(value * 100) / 100 };
  }
  return null;
}

/** The record's total: a claim saying "total" (or "amount due", "общо"), else the one amount every fact agrees on. */
export function recordAmount(claimTexts: readonly string[]): RecordAmount | null {
  for (const text of claimTexts) {
    if (!TOTAL_WORDS.test(text)) continue;
    const found = amountsIn(text);
    if (found.length > 0) return found[found.length - 1];
  }
  const all = claimTexts.flatMap((t) => amountsIn(t));
  const distinct = new Map(all.map((a) => [`${a.currency}:${a.value}`, a]));
  return distinct.size === 1 ? [...distinct.values()][0] : null;
}

function normName(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Words that lead into a company's name without being part of it: a document's kind, a code, a preposition. */
const NAME_LEAD = /^(?:the|from|to|by|for|and|of|with|at|paid|issued|invoice|invoices|inv|receipt|receipts|credit|debit|note|memo|bank|wire|sepa|transfer|payment|order|proforma|statement|waybill|awb|shipment|parcel|delivery|courier|customs|export|import|declaration|ads?|advertising|billing|фактура|проформа|разписка|товарителница|превод|плащане)$/iu;

/**
 * Company names with a legal suffix a text names, as written. A postal
 * address is blanked first: its region code is no legal suffix ("12 Maple
 * Grove Drive Springfield AB" names no company).
 */
export function companyNames(text: string): string[] {
  const out: string[] = [];
  ORG_RE.lastIndex = 0;
  for (const m of withoutAddresses(text).matchAll(ORG_RE)) {
    const words = m[1].trim().split(/\s+/);
    // "Invoice INV-2026-001 Globex Ltd" names Globex Ltd: kind words and codes before the name are no part of it.
    while (words.length > 2 && (NAME_LEAD.test(words[0]) || /\d/.test(words[0]))) words.shift();
    const name = words.join(" ");
    if (name.length >= 4 && name.length <= 80 && !out.includes(name)) out.push(name);
  }
  return out;
}

/** The counterparty: the frontmatter's, else the company its title names, else the one its facts name most — never the owner's own. */
export function recordCounterparty(fm: Record<string, unknown>, title: string, claimTexts: readonly string[], ownCompany?: string | null): string | null {
  const own = ownCompany ? normName(ownCompany) : "";
  const notOwn = (n: string) => own === "" || (normName(n) !== own && !normName(n).startsWith(`${own} `) && !own.startsWith(`${normName(n)} `));
  const record = (fm.record && typeof fm.record === "object" ? fm.record : {}) as Record<string, unknown>;
  for (const v of [record.counterparty, fm.counterparty]) {
    if (typeof v === "string" && v.trim() !== "" && v.length <= 80 && notOwn(v)) return v.trim();
  }
  const inTitle = companyNames(title).filter(notOwn);
  if (inTitle.length > 0) return inTitle[0];
  const counts = new Map<string, number>();
  for (const t of claimTexts) for (const n of companyNames(t).filter(notOwn)) counts.set(n, (counts.get(n) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked[0]?.[0] ?? null;
}

const DAY_IN_TEXT = /\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b|\b(0?[1-9]|[12]\d|3[01])\.(0?[1-9]|1[0-2])\.(20\d{2})\b/;

/** The record's day and month: its title's, a `date` field, a claim's dated fields, else the first date in its facts. */
export function recordDate(fm: Pick<PageFrontmatter, "title" | "claims"> & Record<string, unknown>): { day: string | null; month: string | null } {
  const ids = titleIdentifiers(fm.title);
  const day = [...ids.date].sort()[0] ?? null;
  if (day) return { day, month: day.slice(0, 7) };
  const month = [...ids.month].sort()[0] ?? null;
  if (month) return { day: null, month };
  const record = (fm.record && typeof fm.record === "object" ? fm.record : {}) as Record<string, unknown>;
  for (const v of [record.date, fm.date, fm.issued, fm.document_date]) {
    if (isIsoDate(v)) return { day: v.slice(0, 10), month: v.slice(0, 7) };
  }
  for (const c of fm.claims) {
    for (const v of [c.as_of, c.valid_from]) if (isIsoDate(v)) return { day: v.slice(0, 10), month: v.slice(0, 7) };
  }
  for (const c of fm.claims) {
    const m = DAY_IN_TEXT.exec(c.text);
    if (!m) continue;
    const d = m[1] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[6]}-${m[5].padStart(2, "0")}-${m[4].padStart(2, "0")}`;
    if (isIsoDate(d)) return { day: d, month: d.slice(0, 7) };
  }
  return { day: null, month: null };
}

export interface ClassifyOptions {
  /** The owner's company: never a record's counterparty. */
  ownCompany?: string | null;
  /** A type decided elsewhere (the cheap model's answer), used where the rules found none. */
  assign?: { type: RecordType; by: RecordBy } | null;
}

/**
 * Whether a page is a record leaf, and what of. Null for every page that is
 * not one, or whose date cannot be told. See the module comment for the order.
 */
export function classifyRecord(path: string, fm: PageFrontmatter, options: ClassifyOptions = {}): RecordInfo | null {
  if (NON_RECORD_TYPES.has(fm.type)) return null;
  if (fm.structure !== undefined) return null; // a page the structure pass made
  const claimTexts = fm.claims.map((c) => c.text);
  const set = readRecordFrontmatter(fm);
  let type: RecordType | null = null;
  let via: RecordInfo["via"] = "title";
  let by: RecordBy = "rules";
  if (set && set.by !== undefined && set.by !== "rules") {
    type = set.type;
    via = "frontmatter";
    by = set.by;
  } else if (set && set.by === undefined) {
    // Written by hand, with no `by`: a person's word.
    type = set.type;
    via = "frontmatter";
    by = "owner";
  } else {
    type = titleRecordType(fm.title);
    if (!type && !topicTitle(fm.title)) {
      type = claimsRecordType(claimTexts, titleIdentifiers(fm.title).ref.size > 0);
      via = "claims";
    }
    if (!type && options.assign) {
      type = options.assign.type;
      via = "frontmatter";
      by = options.assign.by;
    }
  }
  if (!type) return null;
  const date = recordDate(fm);
  // A month a person or the model set stands, as their type does (recordHubKey reads the same key); the page's own date only fills in.
  const decided = via === "frontmatter" && set && set.by !== "rules" ? set : null;
  const month = decided?.month ?? date.month;
  if (!month) return null;
  // A day outside that month is no day of this record's month.
  const day = date.day && date.day.startsWith(`${month}-`) ? date.day : null;
  const refs = [...titleIdentifiers(fm.title).ref].sort();
  return {
    type,
    month,
    day,
    counterparty: recordCounterparty(fm, fm.title, claimTexts, options.ownCompany),
    amount: frontmatterAmount(fm) ?? recordAmount(claimTexts),
    ref: refs[0] ?? null,
    via,
    by,
  };
}

/**
 * The key leaves of one hub share — type and month, whatever part or
 * counterparty hub lists them — that the contradiction pass never pairs
 * across (pairing.ts `hub`). From the page's `record` frontmatter, else its
 * classification; null for a page that is no record leaf.
 */
export function recordHubKey(path: string, fm: PageFrontmatter): string | null {
  if (NON_RECORD_TYPES.has(fm.type) || fm.structure !== undefined) return null;
  const set = readRecordFrontmatter(fm);
  // A person's or the model's type stands; the rules' own is read again, as classifyRecord does.
  if (set && set.by !== "rules") return `${set.type}/${set.month}`;
  // The type and month only (classifyRecord's order, without amount and counterparty): the pass asks it of every page.
  if (topicTitle(fm.title)) return null;
  const type = titleRecordType(fm.title) ?? claimsRecordType(fm.claims.map((c) => c.text), titleIdentifiers(fm.title).ref.size > 0);
  if (!type) return null;
  const { month } = recordDate(fm);
  return month ? `${type}/${month}` : null;
}

/**
 * The record type of one side of a contradiction pair (pairing.ts): its hub's
 * type when its page is a record leaf ({@link recordHubKey}), else the type
 * its title names — all a page the vault no longer holds has. Null for a page
 * that is no record (an entity, a synthesis, a page about such documents).
 */
export function sideRecordType(title: string | null | undefined, type?: string | null, hub?: string | null): RecordType | null {
  const ofHub = hub ? hub.slice(0, hub.indexOf("/")) : "";
  if (isRecordType(ofHub)) return ofHub;
  if (!title || (type && NON_RECORD_TYPES.has(type))) return null;
  return titleRecordType(title);
}

/** Amounts summed per currency, currencies in alphabetical order, to the cent. */
export function totalsByCurrency(amounts: ReadonlyArray<RecordAmount | null>): Array<{ currency: string; total: number; count: number }> {
  const sums = new Map<string, { total: number; count: number }>();
  for (const a of amounts) {
    if (!a) continue;
    const s = sums.get(a.currency) ?? { total: 0, count: 0 };
    // In cents, so a thousand leaves add up without float drift.
    s.total += Math.round(a.value * 100);
    s.count += 1;
    sums.set(a.currency, s);
  }
  return [...sums.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([currency, s]) => ({ currency, total: s.total / 100, count: s.count }));
}

/** 1234.5 → "1,234.50" (one format for every hub, whatever the owner's locale). */
export function formatAmount(value: number): string {
  const fixed = Math.abs(value).toFixed(2);
  const [int, dec] = fixed.split(".");
  return `${value < 0 ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${dec}`;
}
