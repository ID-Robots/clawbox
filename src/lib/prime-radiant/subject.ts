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
 * Pure.
 */

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

export interface ClaimSubject {
  /** The entity segment of the claim's id: the page's subject when the claim was written. */
  entity: string;
  /** What the claim is about: its own subject, or its page's when it names none (or one word only). */
  words: ReadonlySet<string>;
  /** Every content word the claim mentions. */
  mentions: ReadonlySet<string>;
}

/** What a claim (`<domain>/<entity>/<fact>`, its text, its page's title) is about. */
export function claimSubject(id: string, text: string, title?: string | null): ClaimSubject {
  const entity = id.split("/")[1] ?? "";
  const own = subjectWords(text);
  const words = new Set(own);
  // Named by one word or not at all ("The price is …", "It is …"): the page's subject says what of.
  if (own.size <= 1) {
    for (const w of contentWords(entity)) words.add(w);
    if (title) for (const w of contentWords(title)) words.add(w);
  }
  return { entity, words, mentions: contentWords(text) };
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
 * are two subjects.
 */
export function sameSubject(a: ClaimSubject, b: ClaimSubject): boolean {
  if (a.entity !== "" && a.entity === b.entity) return true;
  if (a.words.size === 0 || b.words.size === 0) return false;
  // "Widget model 0" and "widget model 1", invoice 2026-118 and 2026-121: two numbered things are two things.
  const ids = (s: ReadonlySet<string>) => new Set([...s].filter((w) => /\d/.test(w)));
  const idsA = ids(a.words);
  const idsB = ids(b.words);
  if (idsA.size > 0 && idsB.size > 0 && intersection(idsA, idsB) === 0) return false;
  const shared = intersection(a.words, b.words);
  if (shared > 0) {
    const union = a.words.size + b.words.size - shared;
    if (shared / union >= SUBJECT_SIMILARITY || shared === Math.min(a.words.size, b.words.size)) return true;
  }
  return (a.words.size >= 2 && within(a.words, b.mentions)) || (b.words.size >= 2 && within(b.words, a.mentions));
}
