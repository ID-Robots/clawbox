/**
 * What a claim is about.
 *
 * On the live test 84 of 85 contradiction items were false: claims were
 * written without a subject ("It is Project Gutenberg eBook #5", "The work is
 * called the oldest military treatise"), and the pass judged pairs from
 * unrelated pages (a black hole against the US Constitution) because their
 * WORDING was alike. Two rules come from here:
 *
 *  - the writer keeps only SELF-CONTAINED claims ({@link selfContainedClaim}):
 *    one that opens with a pronoun or a stand-in ("It", "This book", "The
 *    work's") is repaired with the page's title when the stand-in can only
 *    mean the page's subject, and dropped when it could mean someone else
 *    ("He", "They", "Their");
 *  - the contradiction pass pairs two claims only when they are about the
 *    same thing ({@link sameSubject}): the same entity in their ids, or
 *    subjects that share most of their words, or one claim naming the
 *    other's subject. A claim that names none (an old pronoun-led one) is
 *    about its page's entity.
 *
 * Words, not meaning: cheap, deterministic and explainable, and it errs
 * towards pairing — a pair it lets through still goes to the judge.
 *
 * TEMPLATE words never make two claims about the same thing
 * ({@link TEMPLATE_WORDS}): a document's type ("credit note", "invoice",
 * "export declaration", "transfer", "waybill", "receipt", "order",
 * "statement"), its version ("draft", "final", "second copy") and its file
 * format ("pdf", "docx") — nor do the dates in a title. In an owner's sample
 * of open items four in ten paired two different documents of one type
 * ("credit note draft A, net €429.75" against "credit note draft B, net
 * €7.50"). And a claim that names nothing but a document's FIELDS ("The net
 * amount is …", "The beneficiary bank is …", "The receipt's reference number
 * is …") is about its own page's document, so its page's name says which
 * ({@link claimSubject}).
 *
 * A DOCUMENT is never what a fact is about ({@link documentStatement}). On
 * the TASK-2180 UI test the writer named the policy that states a fact as its
 * subject — "Acme Widgets Ltd Employee Handbook grants full-time employees 25
 * working days …" against "Acme Widgets Ltd Annual Leave Policy HR-07 grants
 * full-time employees 20 working days …" — and two documents' names are two
 * subjects, so the planted contradiction never reached the judge. Such a
 * claim is about what its document says, never about the document's name: it
 * is one subject with a claim of the same organisation that says nearly the
 * same thing ({@link STATED_TOPIC_SIMILARITY} of all their words shared,
 * values out) and with a claim whose own subject it names, and with nothing
 * else — all the facts of one company's documents are not one subject.
 *
 * Pure.
 */

import { withoutDates } from "./identifiers";

/** Openers that point back at something the claim does not name. */
const POINTERS: ReadonlySet<string> = new Set(["it", "it's", "its", "this", "that", "these", "those", "they", "they're", "them", "their", "theirs", "he", "he's", "his", "him", "she", "she's", "her", "hers", "we", "our", "us", "i", "my", "you", "your"]);
/** The ones that, opening a claim on a page, can only mean the page's own subject — repaired with its title. */
const PAGE_POINTERS: ReadonlySet<string> = new Set(["it", "it's", "its", "this", "that"]);

/** Nouns that stand in for the page's own subject without naming it: "the work", "this document", "the company". */
const STAND_INS: ReadonlySet<string> = new Set([
  "work", "book", "ebook", "e-book", "text", "document", "file", "page", "article", "report", "note", "paper", "letter",
  "email", "e-mail", "memo", "manual", "guide", "handbook", "project", "company", "organisation", "organization", "firm",
  "business", "product", "item", "story", "novel", "essay", "treatise", "poem", "volume", "edition", "presentation",
  "program", "programme", "app", "application", "tool", "system", "plan", "contract", "agreement", "policy", "website",
  "site", "piece", "publication", "film", "movie", "song", "album", "game", "device", "service", "event", "place",
  "meeting", "team",
]);
/** Nouns for something OF the page's subject: "the author" is "<title>'s author". */
const ROLES: ReadonlySet<string> = new Set([
  "author", "writer", "owner", "founder", "publisher", "translator", "editor", "creator", "illustrator", "narrator",
  "director", "producer", "manager", "ceo", "price", "cost", "address", "deadline", "budget",
]);
/** Nouns for a part, or for someone else: "the chapter", "the person" — nothing a title can name. */
const PARTS: ReadonlySet<string> = new Set([
  "chapter", "section", "list", "table", "spreadsheet", "source", "entity", "subject", "topic", "person", "thing", "one",
  "former", "latter", "figure", "image", "picture", "appendix", "paragraph", "sentence", "quote", "passage", "line",
]);
const DETERMINERS: ReadonlySet<string> = new Set(["the", "this", "that", "these", "those"]);
const ARTICLES: ReadonlySet<string> = new Set(["the", "a", "an"]);

/** Words that end a subject: the verb (or the preposition) after it. */
const VERBS: ReadonlySet<string> = new Set([
  "is", "are", "was", "were", "be", "been", "being", "has", "have", "had", "will", "would", "can", "could", "should",
  "shall", "may", "might", "must", "does", "do", "did", "isn't", "aren't", "wasn't", "weren't", "hasn't", "haven't",
  "won't", "can't", "doesn't", "don't", "costs", "cost", "contains", "includes", "uses", "needs", "requires",
  "provides", "supports", "offers", "sells", "makes", "takes", "gives", "owns", "runs", "lists", "describes",
  "explains", "says", "states", "holds", "becomes", "became", "remains", "lies", "sits", "stands", "opens", "closes",
  "starts", "ends", "begins", "began", "ships", "employs", "wrote", "writes", "covers", "shows", "means", "belongs",
  "consists", "comes", "came", "goes", "went", "gets", "got", "keeps", "kept", "pays", "paid", "earns", "weighs",
  "measures", "lasts", "applies", "allows", "helps", "works", "lives", "operates", "produces", "reaches", "returns",
  "serves", "answers", "publishes", "collects", "stores", "reports", "tracks", "handles", "manages", "leads",
  "follows", "accepts", "depends", "refers", "relates", "appears", "exists", "happens", "occurs", "increases",
  "decreases", "grows", "falls", "rises", "totals", "equals", "counts", "plays", "sees", "finds", "found", "knows",
  "knew", "thinks", "believes", "wants", "likes", "loves", "hates", "receives", "sends", "sent", "builds", "built",
  "moves", "meets", "met", "visits", "joins", "joined", "left", "leaves", "won", "wins", "lost", "loses", "lacks",
]);
const PREPOSITIONS: ReadonlySet<string> = new Set([
  "in", "at", "on", "for", "from", "to", "by", "with", "since", "during", "after", "before", "under", "over", "between",
  "within", "without", "per", "via", "about", "as", "than", "into", "onto", "upon", "against", "near", "until",
]);
/** Words too common to tell two subjects apart. */
const STOP: ReadonlySet<string> = new Set([
  ...ARTICLES, ...DETERMINERS, ...POINTERS, "of", "and", "or", "nor", "but", "s", "new", "old", "all", "any", "each",
  "every", "some", "no", "not", "own", "other", "another", "such", "same", "very", "most", "more", "many", "much",
]);

const MAX_SUBJECT_WORDS = 6;
/** A title longer than this is no subject to put at the head of a claim. */
const MAX_REPAIR_TITLE = 80;
/** Titles that name nothing, so a claim repaired with one would still say nothing. */
const EMPTY_TITLES: ReadonlySet<string> = new Set(["notes", "note", "document", "untitled", "readme", "draft", "text", "file", "page", "misc", "todo", "new document"]);

/** A word as it is compared: lower case, edge punctuation and a possessive out, a plural folded. */
export function normWord(raw: string): string {
  let w = raw.toLowerCase().replace(/[’`]/g, "'").replace(/^[^\p{L}\p{N}#]+|[^\p{L}\p{N}]+$/gu, "");
  w = w.replace(/'s?$/, "");
  if (w.length > 3 && /[^s]s$/.test(w) && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  return w;
}

function rawWords(text: string): string[] {
  return text.trim().split(/\s+/).filter((w) => w !== "");
}

function bare(raw: string): string {
  return raw.toLowerCase().replace(/[’`]/g, "'").replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");
}

/** Content words of a text (or an id's slug), compared as {@link normWord} folds them. */
export function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/[\s/_-]+/)) {
    const w = normWord(raw);
    if (w !== "" && !STOP.has(w) && (w.length >= 2 || /\d/.test(w))) out.add(w);
  }
  return out;
}

const folded = (list: readonly string[]): ReadonlySet<string> => new Set(list.map((w) => normWord(w)));

/** Words that name a KIND of document, not which one: "credit note", "invoice", "export declaration", "waybill". */
export const DOCUMENT_TYPE_WORDS: ReadonlySet<string> = folded([
  "invoice", "inv", "e-invoice", "proforma", "pro-forma", "receipt", "credit", "debit", "note", "memo", "waybill", "awb",
  "airwaybill", "bill", "lading", "consignment", "declaration", "customs", "export", "import", "transfer", "wire",
  "remittance", "payment", "order", "statement", "extract", "report", "daily", "nightly", "weekly", "monthly", "slip",
  "payslip", "voucher", "quote", "quotation", "label", "form", "document", "doc", "file", "scan", "scanned", "email",
  "e-mail", "letter", "domestic", "foreign",
  "фактура", "фактури", "проформа", "кредитно", "дебитно", "известие", "касова", "бележка", "разписка", "товарителница",
  "митническа", "износна", "експортна", "декларация", "платежно", "нареждане", "банково", "извлечение", "дневен", "отчет",
  "превод", "поръчка", "плащане", "протокол",
]);
/** File formats a title may carry ("… pdf", "….docx"). */
export const FORMAT_WORDS: ReadonlySet<string> = folded([
  "pdf", "docx", "doc", "odt", "rtf", "xlsx", "xls", "ods", "csv", "txt", "md", "html", "htm", "eml", "msg", "png", "jpg",
  "jpeg", "zip",
]);
/** Words that name a VERSION of a document: "draft", "final", "second copy", "v2", "signed". */
export const VERSION_WORDS: ReadonlySet<string> = folded([
  "draft", "final", "copy", "copies", "duplicate", "dup", "version", "ver", "revision", "rev", "revised", "updated",
  "corrected", "correction", "preview", "signed", "unsigned", "original", "second", "third", "dated", "undated", "sent",
  "issued", "wip", "чернова", "копие", "дубликат", "окончателен", "окончателна", "подписан", "подписана",
]);

/** A template word: a document's type, version or format ("invoice", "draft", "pdf", "v2"). */
export function isTemplateWord(w: string): boolean {
  return DOCUMENT_TYPE_WORDS.has(w) || FORMAT_WORDS.has(w) || VERSION_WORDS.has(w) || /^(?:v|rev)\d{1,3}$/.test(w);
}

/** Every template word, for a reader that wants the list. */
export const TEMPLATE_WORDS: ReadonlySet<string> = new Set([...DOCUMENT_TYPE_WORDS, ...FORMAT_WORDS, ...VERSION_WORDS]);

/**
 * Words for a FIELD of a document, not a thing of its own: "the net amount",
 * "the beneficiary bank", "the statement number", "the customs value". A
 * claim whose subject is only these (and template words) is about its page's
 * document.
 */
export const FIELD_WORDS: ReadonlySet<string> = folded([
  "amount", "net", "gross", "total", "subtotal", "sum", "payable", "due", "vat", "tax", "base", "rate", "balance",
  "opening", "closing", "final", "initial", "turnover", "number", "no", "nr", "num", "id", "date", "day", "time", "period",
  "term", "value", "declared", "weight", "size", "dimension", "bank", "beneficiary", "iban", "bic", "swift", "account",
  "holder", "sender", "recipient", "receiver", "payer", "payee", "consignee", "consignor", "shipper", "exporter",
  "importer", "issuer", "customer", "client", "buyer", "seller", "supplier", "vendor", "address", "price", "cost", "fee",
  "charge", "threshold", "status", "reference", "ref", "transaction", "txn", "currency", "quantity", "qty", "unit", "issue",
  "execution", "validity", "delivery", "shipping", "discount", "deposit", "method", "card", "description", "line",
  "tracking", "origin", "destination", "incoterm", "tariff", "code", "mrn", "subscription", "next", "billing", "actual",
  "estimated", "expected", "proposed", "referenced", "cited", "stated", "listed", "main", "remaining", "outstanding",
  "paid", "unpaid", "received", "pack", "package", "parcel", "shipment", "item", "event", "terms",
]);

/** A word that names nothing on its own: an article, a pointer, a conjunction, a preposition ("to", "for", "with"). */
export function isFunctionWord(w: string): boolean {
  return STOP.has(w) || PREPOSITIONS.has(w);
}

/** The words that NAME something in a title or an id's slug: content words, without template words, dates or a bare year. */
export function nameWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of contentWords(withoutDates(text))) {
    if (isTemplateWord(w) || /^(?:19|20)\d{2}$/.test(w)) continue;
    out.add(w);
  }
  return out;
}

export type Opener =
  /** The claim names its subject. */
  | { kind: "named" }
  /**
   * It opens with a stand-in for the page's own subject, `words` long:
   * replaced by the title (`possessive`: "Its" → "<title>'s"), or — `role`
   * — the title's ("The author" → "<title>'s author").
   */
  | { kind: "page"; words: number; possessive: boolean; role?: string }
  /** It opens with a pointer that could mean anyone or anything else ("He", "They", "These", "The chapter"). */
  | { kind: "other" };

/** How a claim opens: does it name what it is about? */
export function claimOpener(text: string): Opener {
  const words = rawWords(text);
  if (words.length === 0) return { kind: "other" };
  const first = bare(words[0]);
  if (DETERMINERS.has(first) && words.length > 1) {
    const noun = normWord(words[1]);
    if (first === "these" || first === "those") return { kind: "other" };
    if (STAND_INS.has(noun) || ROLES.has(noun) || PARTS.has(noun)) return standIn(words, noun);
  }
  if (POINTERS.has(first)) {
    if (!PAGE_POINTERS.has(first)) return { kind: "other" };
    // "This"/"That" stand alone only before a verb ("This is …"); "This year …" names a time, not a subject.
    if ((first === "this" || first === "that") && !VERBS.has(bare(words[1] ?? ""))) return { kind: "named" };
    return { kind: "page", words: 1, possessive: first === "its" };
  }
  return { kind: "named" };
}

/**
 * "The work", "this book's", "the author" — unless the name follows ("The
 * company Acme Widgets Ltd", "The author, Sun Tzu,", "The price of the blue
 * widget").
 */
function standIn(words: readonly string[], noun: string): Opener {
  const after = words[2] ?? "";
  const written = words[1].replace(/[’`]/g, "'");
  const capital = /^["“'(]?\p{Lu}/u.test(after);
  if (/[,:(]$/.test(written) ? capital : (capital && !VERBS.has(bare(after))) || bare(after) === "of") return { kind: "named" };
  if (PARTS.has(noun)) return { kind: "other" };
  const possessive = /'s?$/.test(written.replace(/[^\p{L}']+$/u, ""));
  if (ROLES.has(noun)) return { kind: "page", words: 1, possessive: true, role: words[1] };
  return { kind: "page", words: 2, possessive };
}

function usableTitle(title: string): string | null {
  const t = title.replace(/\s+/g, " ").replace(/[\s.,;:!?…]+$/, "").trim();
  if (t === "" || t.length > MAX_REPAIR_TITLE || EMPTY_TITLES.has(t.toLowerCase())) return null;
  if (contentWords(t).size === 0) return null;
  return t;
}

/**
 * The claim as it may be kept: as it is when it names its subject; with the
 * page's title in place of an opening "It", "This", "Its" or "The work" (the
 * page's own subject is the only thing those can mean there); null when it
 * opens with a pointer that could mean someone else ("He", "They", "Their")
 * or there is no title to name the subject with.
 */
export function selfContainedClaim(text: string, title: string): string | null {
  const opener = claimOpener(text);
  if (opener.kind === "named") return text;
  if (opener.kind === "other") return null;
  const subject = usableTitle(title);
  if (!subject) return null;
  const words = rawWords(text);
  let rest = words.slice(opener.words).join(" ");
  const opening = words.slice(0, opener.words).join(" ");
  // "It's" is "it is"; a comma or colon glued to the stand-in ("The work,") stays with the title.
  if (/^it['’]s$/i.test(opening)) rest = `is ${rest}`;
  const tail = opener.role ? "" : (/[,;:]$/.exec(opening)?.[0] ?? "");
  const head = opener.possessive ? `${subject}'s` : subject;
  const repaired = `${head}${tail} ${rest}`.replace(/\s+/g, " ").trim();
  return repaired.charAt(0).toUpperCase() + repaired.slice(1);
}

/** The words of a claim's own subject: what comes before its verb, articles out. Empty when it names none. */
export function subjectWords(text: string): Set<string> {
  if (claimOpener(text).kind !== "named") return new Set();
  const words = rawWords(text);
  let at = 0;
  while (at < words.length && ARTICLES.has(bare(words[at]))) at += 1;
  // "24 payments of €500 …", "€0.05 Meta charge …": a leading count or amount is the fact's value, not a numbered subject.
  if (at < words.length - 1 && /^[€$£]?\d[\d.,]*[%€$]?$/.test(words[at]) && !/^(?:19|20)\d{2}$/.test(words[at])) at += 1;
  const phrase: string[] = [];
  for (; at < words.length && phrase.length < MAX_SUBJECT_WORDS; at++) {
    const raw = words[at];
    const w = bare(raw);
    if (phrase.length > 0 && (VERBS.has(w) || PREPOSITIONS.has(w))) break;
    // "Acme moved its office": a past tense after the subject's first word ends it.
    if (phrase.length > 0 && w.length > 4 && /^\p{Ll}+ed$/u.test(raw)) break;
    phrase.push(raw);
    if (/[,;:]$/.test(raw)) break;
  }
  return contentWords(phrase.join(" "));
}

/** Nouns for a document that states facts: "the employee handbook", "Annual Leave Policy HR-07", "the customer FAQ". */
const DOCUMENT_NOUNS: ReadonlySet<string> = folded([
  "handbook", "policy", "policies", "procedure", "guide", "guideline", "manual", "faq", "sheet", "datasheet", "specification",
  "spec", "checklist", "minutes", "notes", "review", "agreement", "contract", "rulebook", "regulation", "rules", "terms",
  "charter", "catalogue", "catalog", "brochure", "leaflet", "memo", "report", "notice", "announcement", "newsletter",
  "letter", "email", "e-mail", "presentation", "proposal", "playbook", "sop", "instructions", "document", "readme", "wiki",
  "list", "register",
]);
/** Verbs a document states a fact with: "the handbook grants …", "the policy allows …", "the guide states that …". */
const STATEMENT_VERBS: ReadonlySet<string> = new Set(
  [
    "grant", "give", "allow", "permit", "let", "entitle", "require", "oblige", "mandate", "set", "specify", "state", "say",
    "stipulate", "provide", "list", "limit", "cap", "restrict", "define", "prohibit", "forbid", "ban", "note", "record",
    "report", "describe", "show", "mention", "confirm", "offer", "guarantee", "promise", "assign", "allocate", "allot",
    "establish", "fix", "prescribe", "put", "reserve", "expect", "recommend", "instruct", "tell", "explain", "indicate",
    "declare", "lay", "award", "cover", "include", "contain", "direct", "authorise", "authorize", "outline", "detail",
    "estimate", "quote", "target", "plan",
  ].flatMap((v) => [v, /(?:s|sh|ch|x|z|o)$/.test(v) ? `${v}es` : /[^aeiou]y$/.test(v) ? `${v.slice(0, -1)}ies` : `${v}s`]),
);
/** Words between a document and its verb that change nothing: "the policy also allows", "the guide does not permit". */
const AUXILIARIES: ReadonlySet<string> = new Set(["will", "shall", "does", "do", "also", "only", "still", "now", "currently", "explicitly", "expressly", "clearly", "not", "no", "longer"]);
/** Openers that cite a document for what follows the comma: "According to the Acme handbook, …", "Under Acme Widgets Ltd policy HR-07, …". */
const ATTRIBUTION = /^(?:according\s+to|under|per|as\s+per|as\s+(?:stated|set\s+out|laid\s+down|defined|specified|described|written)\s+in|in\s+line\s+with)\s+/i;
/** The most words a document's name runs to before its verb: "Acme Widgets Ltd Travel and Expense Policy FIN-03". */
const MAX_DOCUMENT_NAME_WORDS = 10;
/** Words that tell a fact's value, not what it is about: amounts, counts, times, a lone digit group. */
const VALUE_WORD = /^[€$£]?\d[\d.,:%]*(?:[a-z]{0,3})?$/;

/** A word that tags a document's name: a code ("HR-07", "PUR-01"), a version ("v3.2", "version 3.2", "2026 edition"), a year, a format. */
function documentTag(raw: string): boolean {
  const w = normWord(raw.replace(/^[(\[]+|[)\],;:]+$/g, ""));
  return w === "" || /\d/.test(w) || VERSION_WORDS.has(w) || FORMAT_WORDS.has(w) || w === "edition" || w === "no" || w === "nr";
}

/** What a claim says, as words: its content words, values, dates and words that name nothing out. */
export function topicWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of contentWords(withoutDates(text))) {
    if (isFunctionWord(w) || VERBS.has(w) || STATEMENT_VERBS.has(w) || AUXILIARIES.has(w) || VALUE_WORD.test(w)) continue;
    out.add(w);
  }
  return out;
}

/** A claim a document states: whose document it is, and what the document says. */
export interface StatedBy {
  /**
   * Whose document it is: the words of its name, its kind, code and version out, that the statement does not write as
   * a common word — "Acme Widgets Ltd Employee Handbook grants full-time employees …" gives "acme widgets ltd". Empty:
   * the name tells no owner.
   */
  name: ReadonlySet<string>;
  /** What it says: {@link topicWords} of the claim after the document and its verb (or the comma that ends a citation). */
  topic: ReadonlySet<string>;
}

/**
 * The name of a document as words, or null when the phrase names no document:
 * it ends in a document noun, then a code, a version or a date at most
 * ("Annual Leave Policy HR-07", "management review of 5 October 2026").
 */
function documentName(phrase: string): Set<string> | null {
  const words = rawWords(withoutDates(phrase));
  let end = words.length;
  while (end > 0 && (documentTag(words[end - 1]) || isFunctionWord(normWord(words[end - 1])))) end -= 1;
  if (end === 0 || !DOCUMENT_NOUNS.has(normWord(words[end - 1]))) return null;
  const name = new Set<string>();
  for (const w of contentWords(words.slice(0, end).join(" "))) {
    if (!DOCUMENT_NOUNS.has(w) && !isTemplateWord(w) && !/\d/.test(w)) name.add(w);
  }
  return name.size > 0 ? name : null;
}

/**
 * Whether the word at `at` is the verb after a document's name. A capitalised
 * word belongs to a title-case name ("Price List", "Returns Policy", "1 May
 * 2026"), and so does a document noun that a statement verb follows ("the
 * price list states …").
 */
function verbAt(words: readonly string[], at: number): boolean {
  const raw = words[at];
  const w = bare(raw);
  if (!VERBS.has(w) && !STATEMENT_VERBS.has(w) && !AUXILIARIES.has(w)) return false;
  if (/^\p{Lu}/u.test(raw)) return false;
  if (!DOCUMENT_NOUNS.has(normWord(raw))) return true;
  let next = at + 1;
  while (next < words.length && AUXILIARIES.has(bare(words[next]))) next += 1;
  return !(next < words.length && STATEMENT_VERBS.has(bare(words[next])));
}

/**
 * A statement of the document `name` saying `said`. Its owner is the name's
 * words that are not what it says: a word the statement writes in lower case
 * ("grants full-time employees …") is a thing of the statement, not whose
 * document it is, and a name it repeats as a name ("states that Acme Widgets
 * Ltd pays …") still is.
 */
function statedBy(name: ReadonlySet<string>, said: string): StatedBy {
  const common = contentWords(rawWords(said).filter((w) => !/^["“'(]?\p{Lu}/u.test(w)).join(" "));
  return { name: new Set([...name].filter((w) => !common.has(w))), topic: topicWords(said) };
}

/**
 * A claim whose subject is the DOCUMENT that states it, read for what the
 * document says, or null for any other claim: "Acme Widgets Ltd Annual
 * Leave Policy HR-07 grants full-time employees 20 working days …", "The
 * Acme guide states that the Plovdiv warehouse has 1,200 pallet spaces",
 * "According to the Acme Widgets employee handbook, every full-time employee
 * …". The document must be named beyond its kind: "According to the
 * handbook, …" is none. A fact about the document itself, worded with a verb
 * of being or having — "The handbook is version 3.2", "The policy is
 * effective 1 January 2026", "The procedure carries the code PUR-01" — is no
 * statement: its verb is no {@link STATEMENT_VERBS} one, and the document is
 * its subject.
 */
export function documentStatement(text: string): StatedBy | null {
  const words = rawWords(text);
  const cited = ATTRIBUTION.exec(text.trim());
  if (cited) {
    const skip = rawWords(cited[0]).length;
    const comma = words.findIndex((w, i) => i >= skip && /,$/.test(w));
    if (comma < 0 || comma - skip >= MAX_DOCUMENT_NAME_WORDS || comma + 1 >= words.length) return null;
    const name = documentName(words.slice(skip, comma + 1).join(" "));
    return name ? statedBy(name, words.slice(comma + 1).join(" ")) : null;
  }
  let at = 0;
  while (at < words.length && ARTICLES.has(bare(words[at]))) at += 1;
  const start = at;
  for (; at < words.length && at - start < MAX_DOCUMENT_NAME_WORDS; at++) {
    if (at > start && verbAt(words, at)) break;
  }
  let verb = at;
  while (verb < words.length && AUXILIARIES.has(bare(words[verb]))) verb += 1;
  if (verb >= words.length || !STATEMENT_VERBS.has(bare(words[verb]))) return null;
  const name = documentName(words.slice(start, at).join(" "));
  return name ? statedBy(name, words.slice(verb + 1).join(" ")) : null;
}

export interface ClaimSubject {
  /** The entity segment of the claim's id: the page's subject when the claim was written. */
  entity: string;
  /** What the claim is about: its own subject, or its page's when it names none (or one word only, or only a document's fields). */
  words: ReadonlySet<string>;
  /** Every content word the claim mentions. */
  mentions: ReadonlySet<string>;
  /**
   * Whether the entity names something beyond template words: "credit-note-draft" names no one document, so two
   * claims filed under it are not one subject for that alone. Absent: it does.
   */
  entityNamed?: boolean;
  /** What the claim names ITSELF, template words out — empty when it names only a document's fields. Absent: unknown. */
  own?: ReadonlySet<string>;
  /** What the claim says ({@link topicWords}; a document's statement: after its verb). Absent: unknown. */
  topic?: ReadonlySet<string>;
  /** The claim's subject is the document that states it ({@link documentStatement}). */
  stated?: StatedBy;
}

/** What a claim (`<domain>/<entity>/<fact>`, its text, its page's title) is about. */
export function claimSubject(id: string, text: string, title?: string | null): ClaimSubject {
  const entity = id.split("/")[1] ?? "";
  // Template words never tell what a claim is about: "The credit note's net amount" names a field, not a credit note.
  const own = new Set([...subjectWords(text)].filter((w) => !isTemplateWord(w)));
  const words = new Set(own);
  const stated = documentStatement(text);
  // Named by one word or not at all ("The price is …", "It is …"), or only by a document's fields ("The net amount",
  // "The beneficiary bank"): the page's subject says what of — its NAME, without its type, version, format or date.
  const fieldsOnly = [...own].every((w) => FIELD_WORDS.has(w));
  if (own.size <= 1 || fieldsOnly) {
    for (const w of nameWords(entity)) words.add(w);
    if (title) for (const w of nameWords(title)) words.add(w);
  }
  return {
    entity,
    words,
    mentions: contentWords(text),
    entityNamed: nameWords(entity).size > 0,
    own: fieldsOnly ? new Set() : own,
    // A document's statement: what follows the document and its verb, which sameSubject pairs it by.
    topic: stated?.topic ?? topicWords(text),
    ...(stated ? { stated } : {}),
  };
}

function intersection(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n += 1;
  return n;
}

function within(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size > 0 && intersection(a, b) === a.size;
}

/** The share of their words two subjects must have in common (of all their words) to be one. */
export const SUBJECT_SIMILARITY = 0.5;

/**
 * Whether two claims are about the same thing: the same entity in their ids;
 * or subjects that share at least {@link SUBJECT_SIMILARITY} of their words,
 * or one inside the other ("ID Robots" and "the ID Robots office"); or one
 * claim naming the other's subject of two words or more ("Sun Tzu wrote The
 * Art of War" and "The Art of War is …"). Wording alike is not enough, and
 * two subjects numbered differently ("widget model 0", "widget model 1")
 * are two subjects. An entity of template words alone ("credit-note-draft")
 * is no one subject. A claim whose subject is the document that states it is
 * about what the document says ({@link statedAlike}).
 */
export function sameSubject(a: ClaimSubject, b: ClaimSubject): boolean {
  if (a.entity !== "" && a.entity === b.entity && a.entityNamed !== false) return true;
  // A document's statement is one subject by what it says, never by what its document is called: "Acme Widgets Ltd
  // IT Security Policy" and "Acme Widgets Ltd Annual Leave Policy" share most of their words. The other claim's own
  // subject named in it still is one ("The Acme FAQ states that the Sprocket X200 weighs …", "The Sprocket X200 …");
  // two statements name no subject of their own, so they are one by what they say alone.
  if (a.stated && b.stated) return statedAlike(a.stated, b);
  if (a.stated) return statedAlike(a.stated, b) || named(b, a);
  if (b.stated) return statedAlike(b.stated, a) || named(a, b);
  return wordsAlike(a, b);
}

/** Whether `b` names `a`'s subject of two words or more. */
function named(a: ClaimSubject, b: ClaimSubject): boolean {
  return a.words.size >= 2 && within(a.words, b.mentions);
}

/** The share of all their topic words (values out; shared over the union) a document's statement and another claim must have in common to be one subject. */
export const STATED_TOPIC_SIMILARITY = 0.5;

/**
 * Whether a document's statement and another claim say the same thing of one
 * organisation: the other names the document's owner (all of a one-word
 * owner, two words of a longer one — "Acme Widgets Ltd Employee Handbook" and
 * "Every full-time employee of Acme Widgets …"; a document whose name tells
 * no owner meets nothing here), and once those words are out of both, the
 * words their topics share are at least {@link STATED_TOPIC_SIMILARITY} of
 * all their topic words ("full-time employees 25 working days of paid annual
 * leave per calendar year" against the same with 20). Two facts of one
 * company's documents that say different things — passwords against expense
 * receipts — are two subjects, and so are two differently numbered things.
 */
function statedAlike(s: StatedBy, other: ClaimSubject): boolean {
  const topic = other.topic;
  if (!topic || s.name.size === 0 || other.stated?.name.size === 0) return false;
  const theirs = other.stated?.name ?? other.mentions;
  let org = 0;
  for (const w of s.name) if (theirs.has(w)) org += 1;
  if (org < Math.min(2, s.name.size, other.stated?.name.size ?? 2)) return false;
  const owner = (w: string) => s.name.has(w) && theirs.has(w);
  let mine = 0;
  let yours = 0;
  let shared = 0;
  let idsMine = 0;
  let idsYours = 0;
  let idsShared = 0;
  for (const w of s.topic) {
    if (owner(w)) continue;
    const id = /\d/.test(w);
    mine += 1;
    if (id) idsMine += 1;
    if (topic.has(w)) {
      shared += 1;
      if (id) idsShared += 1;
    }
  }
  for (const w of topic) {
    if (owner(w)) continue;
    yours += 1;
    if (/\d/.test(w)) idsYours += 1;
  }
  if (mine < 2 || yours < 2) return false;
  if (idsMine > 0 && idsYours > 0 && idsShared === 0) return false;
  return shared / (mine + yours - shared) >= STATED_TOPIC_SIMILARITY;
}

/** {@link sameSubject} by the words of the two subjects (see there). */
function wordsAlike(a: ClaimSubject, b: ClaimSubject): boolean {
  if (a.words.size === 0 || b.words.size === 0) return false;
  // "Widget model 0" and "widget model 1", invoice 2026-118 and 2026-121: two numbered things are two things.
  const ids = (s: ReadonlySet<string>) => new Set([...s].filter((w) => /\d/.test(w)));
  const idsA = ids(a.words);
  const idsB = ids(b.words);
  if (idsA.size > 0 && idsB.size > 0 && intersection(idsA, idsB) === 0) return false;
  // Both name the same thing themselves ("The widget costs …" on "Widget pricing" and on "Widget price list"):
  // one subject, whatever their pages are called. Fields alone ("The net amount") name nothing.
  if (a.own && b.own && a.own.size > 0 && a.own.size === b.own.size && intersection(a.own, b.own) === a.own.size) return true;
  const shared = intersection(a.words, b.words);
  if (shared > 0) {
    const union = a.words.size + b.words.size - shared;
    if (shared / union >= SUBJECT_SIMILARITY || shared === Math.min(a.words.size, b.words.size)) return true;
  }
  return named(a, b) || named(b, a);
}
