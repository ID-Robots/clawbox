/**
 * The Flash writer's contract: what one batch of documents is turned into a
 * prompt as, how the model's answer is read (strictly — an item that is not
 * what was asked for is a failed file, never repaired into a page), and how a
 * draft becomes a page with claims.
 *
 * Every string that reaches the prompt was redacted by the caller (text AND
 * path label); every string the model answers is redacted AGAIN before it is
 * written, so a secret the model echoed back cannot land in the vault (where
 * the lint's `secret-pattern` rule would refuse the whole batch's commit).
 *
 * Pure: no fs, no network.
 */

import { allocateClaimId, claimFactKey, claimTextKey, slugify, type ClaimIndex } from "./claims";
import { redactText } from "./redact";
import { selfContainedClaim } from "./subject";
import { historicalClaim, isValidityDate, textValidity, validityRange } from "./validity";
import {
  PAGE_TYPES,
  SLUG_RE,
  folderForType,
  isIsoDate,
  type Claim,
  type PageFrontmatter,
  type PageType,
  type PrivacyTier,
} from "./schema";

/** Files per model call. */
export const WRITER_BATCH_SIZE = 50;
/** Characters of one document's text sent to the model. */
export const MAX_TEXT_CHARS_PER_FILE = 6_000;
/** Characters of document text in one call, whatever the file count. */
export const MAX_BATCH_CHARS = 240_000;
/** Output ceiling for one call: ~50 cards of a few hundred tokens each. */
export const WRITER_MAX_TOKENS = 48_000;

export const MAX_TITLE_CHARS = 120;
export const MAX_SUMMARY_CHARS = 300;
export const MAX_CLAIM_CHARS = 240;
export const MAX_FACTS_PER_PAGE = 12;
/** Extra prose the model may add under the summary, by type (atomic pages stay under their 3,000 cap). */
export const MAX_DETAIL_CHARS: Readonly<Record<string, number>> = { entity: 1_500, decision: 1_500 };
export const DEFAULT_MAX_DETAIL_CHARS = 4_000;

/** Page types the writer may produce; `source` and `synthesis` are made by later passes. */
export const WRITER_PAGE_TYPES = ["entity", "concept", "howto", "reference", "decision", "metric"] as const satisfies readonly PageType[];

export const DEFAULT_DOMAIN = "general";
export const DEFAULT_OWNER = "unassigned";

/** What one document looks like inside the prompt. */
export interface WriterItem {
  i: number;
  /** The redacted path label, e.g. `~/Documents/acme/catalogue.pdf`. */
  path: string;
  kind: string;
  text: string;
}

/** Marks where the items' JSON starts in the user message (the test stub reads it back). */
export const WRITER_ITEMS_MARKER = "ITEMS (JSON):";

export const WRITER_SYSTEM_PROMPT = [
  "You turn an owner's documents into pages of a private knowledge wiki.",
  "For EVERY item you are given, answer one object. Answer a JSON array only, no prose around it.",
  "Never copy secret values (passwords, keys, tokens, bank or card numbers, personal ids); text shown as [REDACTED:...] is already removed — do not guess it.",
  "Each object has exactly these fields:",
  '{"i": <the item number>,',
  ' "useful": true|false (false only for noise: empty templates, generated logs, build output),',
  ` "type": one of ${WRITER_PAGE_TYPES.join("|")},`,
  ' "title": a short page title (the thing the document is about),',
  ' "domain": a lowercase-kebab business area, e.g. "sales", "support", "finance", "engineering",',
  ' "summary": at most 2 sentences and 300 characters: what it is and why it matters,',
  ' "details": optional Markdown with the important specifics (no top-level heading), may be "",',
  ' "facts": up to 8 atomic facts [{"fact": "one sentence", "quote": "<= 12 words copied word for word from THIS item\'s text", "confidence": 0.0-1.0,',
  '   optional: "valid_from": "YYYY-MM-DD", "valid_until": "YYYY-MM-DD", "as_of": "YYYY-MM-DD", "historical": true}],',
  ' "sensitivity": "public"|"internal"|"confidential",',
  ' "confidence": 0.0-1.0}',
  "Every fact must be true read ALONE, away from the page and the other facts: it names its subject.",
  'Write "The Art of War is Project Gutenberg eBook #132", never "It is Project Gutenberg eBook #132"; "The Art of War is called the oldest military treatise", never "The work is called …".',
  "Never open a fact with a pronoun (it, its, this, they, he, she) or a stand-in (the document, the work, the book, the company, the author).",
  "An item's facts and quotes come from that item's own text only — never from another item in the same call.",
  'When the item says WHEN a fact holds — since a date ("since 22.09.2026"), until one ("until February"), or as of one ("as of 30.09") — give it as valid_from, valid_until or as_of (ISO dates; a date without a year is in the year the item was written). A fact about a past state that no longer holds (a launch price, a former address) gets "historical": true. Leave these out when the item does not say; never guess.',
].join("\n");

export function buildWriterPrompt(items: readonly WriterItem[]): { system: string; user: string } {
  return { system: WRITER_SYSTEM_PROMPT, user: `${WRITER_ITEMS_MARKER}\n${JSON.stringify(items)}` };
}

/** Read the items back out of a prompt built by {@link buildWriterPrompt}; null when it is not one. */
export function readWriterItems(user: string): WriterItem[] | null {
  const at = user.indexOf(WRITER_ITEMS_MARKER);
  if (at < 0) return null;
  try {
    const parsed = JSON.parse(user.slice(at + WRITER_ITEMS_MARKER.length));
    return Array.isArray(parsed) ? (parsed as WriterItem[]) : null;
  } catch {
    return null;
  }
}

export interface DraftFact {
  fact: string;
  quote: string;
  confidence: number;
  /** When the fact holds, as the model read it from the document (ISO dates); absent when it did not say. */
  validFrom?: string;
  validUntil?: string;
  asOf?: string;
  /** A past state of things, as the model read it. */
  historical?: boolean;
}

/** The dated fields of one fact of the model's answer: ISO dates only, a period that runs forwards (a backwards one loses its two bounds, nothing else). */
function draftValidity(fo: Record<string, unknown>): Pick<DraftFact, "validFrom" | "validUntil" | "asOf" | "historical"> {
  const out: Pick<DraftFact, "validFrom" | "validUntil" | "asOf" | "historical"> = {};
  const iso = (v: unknown) => (typeof v === "string" && isValidityDate(v.trim()) && isIsoDate(v.trim()) ? v.trim() : undefined);
  const from = iso(fo.valid_from);
  const until = iso(fo.valid_until);
  if (!(from && until && !validityRange({ from, until, source: "claim" }))) {
    if (from) out.validFrom = from;
    if (until) out.validUntil = until;
  }
  const asOf = iso(fo.as_of);
  if (asOf) out.asOf = asOf;
  if (fo.historical === true) out.historical = true;
  return out;
}

/**
 * The dated fields a claim is written with: what the model read from the
 * document, else what the fact's own text states ("as of 30.09", "since
 * 22.09.2026"), else none; `historical` when the model said so or the text
 * reads as a past state ("formerly", "the launch price was").
 */
export function claimDates(fact: DraftFact, written: string): Pick<Claim, "valid_from" | "valid_until" | "as_of" | "historical"> {
  const out: Pick<Claim, "valid_from" | "valid_until" | "as_of" | "historical"> = {};
  if (fact.validFrom || fact.validUntil || fact.asOf) {
    if (fact.validFrom) out.valid_from = fact.validFrom;
    if (fact.validUntil) out.valid_until = fact.validUntil;
    if (fact.asOf) out.as_of = fact.asOf;
  } else {
    const stated = textValidity(fact.fact, written);
    if (stated && stated.from && stated.from === stated.until) out.as_of = stated.from;
    else if (stated) {
      if (stated.from) out.valid_from = stated.from;
      if (stated.until) out.valid_until = stated.until;
    }
  }
  if (fact.historical || historicalClaim({ text: fact.fact })) out.historical = true;
  return out;
}

export interface PageDraft {
  i: number;
  useful: boolean;
  type: PageType;
  title: string;
  domain: string;
  summary: string;
  details: string;
  facts: DraftFact[];
  privacy: PrivacyTier;
  confidence: number;
}

export type ItemVerdict = { ok: true; draft: PageDraft } | { ok: false; reason: string };

/** The model's whole answer was unusable (no JSON array in it). */
export class WriterParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriterParseError";
  }
}

function clamp01(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

/** Redacted, whitespace-collapsed, cut at a word boundary to `max` characters. */
export function cleanLine(value: string, max: number): string {
  const one = redactText(value).text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/** Redacted Markdown, headings demoted below the page's own, cut at a line to `max`. */
export function cleanDetails(value: string, max: number): string {
  let text = redactText(value).text.replace(/\r\n/g, "\n").replace(/\0/g, "");
  // No frontmatter fence and no top-level heading inside a page body.
  text = text.replace(/^---\s*$/gm, "").replace(/^#\s/gm, "## ").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const nl = cut.lastIndexOf("\n");
  return `${(nl > max * 0.5 ? cut.slice(0, nl) : cut).trimEnd()}\n\n…`;
}

const PRIVACY_OF: Readonly<Record<string, PrivacyTier>> = {
  public: "public",
  internal: "internal",
  confidential: "confidential",
  secret: "confidential",
};

/** Validate one object of the model's answer against the item it claims to be. */
export function readDraft(raw: unknown, expected: ReadonlySet<number>): ItemVerdict & { i?: number } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "not an object" };
  const o = raw as Record<string, unknown>;
  const i = o.i;
  if (typeof i !== "number" || !Number.isInteger(i) || !expected.has(i)) return { ok: false, reason: "unknown item number" };
  const fail = (reason: string) => ({ ok: false as const, reason, i });
  const useful = o.useful !== false;
  const type = typeof o.type === "string" && (PAGE_TYPES as readonly string[]).includes(o.type) ? (o.type as PageType) : null;
  const writerType = type && (WRITER_PAGE_TYPES as readonly string[]).includes(type) ? type : "concept";
  if (typeof o.title !== "string" || o.title.trim() === "") return useful ? fail("no title") : { ok: true, i, draft: notUseful(i) };
  if (typeof o.summary !== "string" || o.summary.trim() === "") return useful ? fail("no summary") : { ok: true, i, draft: notUseful(i) };
  const domainRaw = typeof o.domain === "string" ? o.domain.trim().toLowerCase() : "";
  const domain = SLUG_RE.test(domainRaw) && domainRaw.length <= 48 ? domainRaw : domainRaw ? slugify(domainRaw, 48) : DEFAULT_DOMAIN;
  const title = cleanLine(o.title, MAX_TITLE_CHARS);
  const facts: DraftFact[] = [];
  if (Array.isArray(o.facts)) {
    for (const f of o.facts) {
      if (!f || typeof f !== "object") continue;
      const fo = f as Record<string, unknown>;
      if (typeof fo.fact !== "string" || fo.fact.trim() === "") continue;
      // A claim must say what it is about: "It is …" is repaired with the
      // title, "He was …" (who?) is not kept.
      const fact = selfContainedClaim(cleanLine(fo.fact, MAX_CLAIM_CHARS), title);
      if (fact === null) continue;
      facts.push({
        fact: fact.length > MAX_CLAIM_CHARS ? cleanLine(fact, MAX_CLAIM_CHARS) : fact,
        quote: typeof fo.quote === "string" ? cleanLine(fo.quote, 160) : "",
        confidence: clamp01(fo.confidence, clamp01(o.confidence, 0.6)),
        ...draftValidity(fo),
      });
      if (facts.length >= MAX_FACTS_PER_PAGE) break;
    }
  }
  const maxDetails = MAX_DETAIL_CHARS[writerType] ?? DEFAULT_MAX_DETAIL_CHARS;
  return {
    ok: true,
    i,
    draft: {
      i,
      useful,
      type: writerType,
      title,
      domain: domain === "x" ? DEFAULT_DOMAIN : domain,
      summary: cleanLine(o.summary, MAX_SUMMARY_CHARS),
      details: typeof o.details === "string" ? cleanDetails(o.details, maxDetails) : "",
      facts,
      privacy: PRIVACY_OF[typeof o.sensitivity === "string" ? o.sensitivity : ""] ?? "internal",
      confidence: clamp01(o.confidence, 0.6),
    },
  };
}

function notUseful(i: number): PageDraft {
  return {
    i,
    useful: false,
    type: "concept",
    title: "",
    domain: DEFAULT_DOMAIN,
    summary: "",
    details: "",
    facts: [],
    privacy: "internal",
    confidence: 0,
  };
}

/** Candidate brackets tried at most, each way: a prose `[REDACTED:EMAIL]` costs one try, not the call. */
const MAX_ARRAY_STARTS = 32;
const MAX_ARRAY_ENDS = 8;

function bracketsFrom(text: string, ch: string, forward: boolean, max: number): number[] {
  const out: number[] = [];
  let at = forward ? text.indexOf(ch) : text.lastIndexOf(ch);
  while (at >= 0 && out.length < max) {
    out.push(at);
    at = forward ? text.indexOf(ch, at + 1) : at === 0 ? -1 : text.lastIndexOf(ch, at - 1);
  }
  return out;
}

/**
 * The JSON array in a model's answer. Not simply the first `[` to the last
 * `]`: prose around the array may hold brackets of its own (a repeated
 * `[REDACTED:…]` placeholder, "[3 items]"), so every `[` is tried in turn
 * against the last few `]`, and the first slice that parses as an array of
 * objects wins (a bare list of numbers only when nothing better parses).
 */
function findJsonArray(text: string): unknown[] {
  const starts = bracketsFrom(text, "[", true, MAX_ARRAY_STARTS);
  const ends = bracketsFrom(text, "]", false, MAX_ARRAY_ENDS);
  if (starts.length === 0 || ends.length === 0 || ends[0] <= starts[0]) throw new WriterParseError("the answer holds no JSON array");
  let sawJson = false;
  let fallback: unknown[] | null = null;
  for (const start of starts) {
    for (const end of ends) {
      if (end <= start) break;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        continue;
      }
      sawJson = true;
      if (!Array.isArray(parsed)) continue;
      // A bare list in the prose ("[1, 2]") is not the answer; an array of cards is.
      if (parsed.length === 0 || parsed.some((x) => x !== null && typeof x === "object")) return parsed;
      fallback ??= parsed;
    }
  }
  if (fallback) return fallback;
  throw new WriterParseError(sawJson ? "the answer is not a JSON array" : "the answer's JSON array does not parse");
}

// ── evidence ──────────────────────────────────────────────────────────────

/**
 * Text reduced to its words for a containment test: case, quote marks,
 * punctuation, Markdown marks and spacing do not count; a quote cut short
 * (`…`) loses its last, partial word.
 */
export function evidenceWords(text: string): string {
  let t = text.normalize("NFKC").toLowerCase();
  const cut = /…\s*$/.test(t);
  t = t.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (cut) t = t.replace(/\s*\S+$/, "");
  return t;
}

/** Whether `quote` is in a document's text (both as {@link evidenceWords} reads them). */
export function quoteIn(documentWords: string, quote: string): boolean {
  const q = evidenceWords(quote);
  return q !== "" && ` ${documentWords} `.includes(` ${q} `);
}

/**
 * Each fact's quote checked against the page's OWN document: on the live
 * test the page for `Office move.txt` cited a line of another file in the
 * same call, and a call writing two documents left claims on one page whose
 * evidence was the other. A page keeps the claims of its own document, so a
 * claim's evidence is always the file it came from: a quote in the page's
 * own text stays; a fact whose quote is in exactly one OTHER document of the
 * call is that document's, not this page's, and is left out (its own
 * document's card states what it says); a quote found in none, or in
 * several others, is dropped and the fact keeps its page.
 */
export function checkEvidence(draft: PageDraft, own: WriterItem, items: readonly WriterItem[], words: ReadonlyMap<number, string>): PageDraft {
  if (draft.facts.every((f) => f.quote === "")) return draft;
  const facts: DraftFact[] = [];
  for (const f of draft.facts) {
    if (f.quote === "" || quoteIn(words.get(own.i) ?? "", f.quote)) {
      facts.push(f);
      continue;
    }
    const elsewhere = items.filter((it) => it.i !== own.i && quoteIn(words.get(it.i) ?? "", f.quote));
    if (elsewhere.length === 1 && elsewhere[0].path !== own.path) continue;
    facts.push({ ...f, quote: "" });
  }
  return { ...draft, facts };
}

/**
 * Read the model's answer for a batch: one verdict per item asked about.
 * An item the answer does not mention, or mentions twice, is a failure for
 * that item alone. No JSON array at all throws {@link WriterParseError}, so
 * the caller can retry the whole call. Every quote is checked against the
 * documents of the call ({@link checkEvidence}).
 */
export function parseWriterResponse(text: string, items: readonly WriterItem[]): Map<number, ItemVerdict> {
  const parsed = findJsonArray(text);
  const expected = new Set(items.map((it) => it.i));
  const byIndex = new Map(items.map((it) => [it.i, it]));
  let words: Map<number, string> | null = null;
  const out = new Map<number, ItemVerdict>();
  const seen = new Set<number>();
  for (const raw of parsed) {
    const verdict = readDraft(raw, expected);
    if (verdict.i === undefined) continue;
    if (seen.has(verdict.i)) {
      out.set(verdict.i, { ok: false, reason: "answered twice" });
      continue;
    }
    seen.add(verdict.i);
    if (!verdict.ok) {
      out.set(verdict.i, { ok: false, reason: verdict.reason });
      continue;
    }
    words ??= new Map(items.map((it) => [it.i, evidenceWords(it.text)]));
    out.set(verdict.i, { ok: true, draft: checkEvidence(verdict.draft, byIndex.get(verdict.i)!, items, words) });
  }
  for (const it of items) if (!out.has(it.i)) out.set(it.i, { ok: false, reason: "missing from the answer" });
  return out;
}

// ── draft → page ──────────────────────────────────────────────────────────

/** A page of the vault the writer may have to update rather than duplicate. */
export interface ExistingPage {
  path: string;
  frontmatter: PageFrontmatter | null;
}

export interface BuildContext {
  /** Every page path in the vault and every path already given out in this batch. */
  takenPaths: Set<string>;
  /** Pages by source label, for re-ingesting a changed document in place. */
  pagesBySource: Map<string, ExistingPage>;
  claimIndex: ClaimIndex;
  now: Date;
  ownerFor?: (domain: string) => string | undefined;
}

export type BuiltPage =
  | { ok: true; path: string; frontmatter: PageFrontmatter; body: string; updated: boolean }
  | { ok: false; reason: "verified-page"; path: string };

/** File names a page never takes: `<folder>/index.md` is memory-wiki's (see plugin-files.ts). */
const RESERVED_PAGE_SLUGS: ReadonlySet<string> = new Set(["index"]);

/** A new page's path: its type's folder and its title's slug, never one `taken`. */
export function pathFor(type: PageType, title: string, taken: ReadonlySet<string>): string {
  const folder = folderForType(type);
  const base = slugify(title, 80);
  const first = RESERVED_PAGE_SLUGS.has(base) ? 2 : 1;
  let candidate = first === 1 ? `${folder}/${base}.md` : `${folder}/${base}-${first}.md`;
  for (let n = first + 1; taken.has(candidate) && n < 10_000; n++) candidate = `${folder}/${base}-${n}.md`;
  return candidate;
}

export function pageBody(draft: PageDraft, source: string): string {
  const parts = [draft.summary];
  if (draft.details) parts.push(draft.details);
  // A fact the draft repeats is listed once, as it is one claim.
  const seen = new Set<string>();
  const facts = draft.facts.map((f) => f.fact).filter((f) => !seen.has(claimTextKey(f)) && !!seen.add(claimTextKey(f)));
  if (facts.length > 0) parts.push(["## Key facts", "", ...facts.map((f) => `- ${f}`)].join("\n"));
  parts.push(["## Sources", "", `- \`${source.replace(/`/g, "'")}\``].join("\n"));
  return `${parts.join("\n\n")}\n`;
}

/**
 * Turn a draft into a page. A document already ingested (same source label)
 * updates its page in place — unless that page carries a human verification,
 * which the writer never touches. Claim ids are allocated in the global
 * namespace against `ctx.claimIndex`, and the index is updated so the next
 * page of the same batch sees them.
 */
export function buildPage(draft: PageDraft, source: string, ctx: BuildContext): BuiltPage {
  const existing = ctx.pagesBySource.get(source);
  const updatedAt = ctx.now.toISOString();
  let path: string;
  let updated = false;
  if (existing) {
    const fm = existing.frontmatter;
    if (fm && (fm.verified || fm.claims.some((c) => c.verified))) return { ok: false, reason: "verified-page", path: existing.path };
    path = existing.path;
    updated = true;
    // The page's own previous claims stop holding their ids; they are replaced, not retired.
    if (fm) {
      for (const c of fm.claims) {
        const list = (ctx.claimIndex.active.get(c.id) ?? []).filter((loc) => loc.page !== path);
        if (list.length > 0) ctx.claimIndex.active.set(c.id, list);
        else ctx.claimIndex.active.delete(c.id);
      }
    }
  } else {
    path = pathFor(draft.type, draft.title, ctx.takenPaths);
  }
  ctx.takenPaths.add(path);

  const entity = slugify(draft.title, 48);
  const claims: Claim[] = [];
  const usedOnPage = new Set<string>();
  const byFact = new Map<string, Claim>();
  for (const fact of draft.facts) {
    const confidence = Math.round(fact.confidence * 100) / 100;
    const dates = claimDates(fact, updatedAt);
    // The same fact said twice is one claim (the first, at the higher confidence), never a `-2` id beside it.
    const key = claimFactKey({ text: fact.fact, ...dates });
    const twin = byFact.get(key);
    if (twin) {
      twin.confidence = Math.max(twin.confidence, confidence);
      continue;
    }
    const id = allocateClaimId(ctx.claimIndex, draft.domain, entity, slugify(fact.fact, 48), path, usedOnPage);
    usedOnPage.add(id);
    const claim: Claim = {
      id,
      text: fact.fact,
      confidence,
      status: "proposed",
      updatedAt,
      // The page's own document: a claim is never filed under another one (checkEvidence).
      evidence: [{ kind: "source", path: source, ...(fact.quote ? { note: fact.quote } : {}) }],
      ...dates,
    };
    byFact.set(key, claim);
    claims.push(claim);
    const list = ctx.claimIndex.active.get(id) ?? [];
    list.push({ page: path, claim });
    ctx.claimIndex.active.set(id, list);
  }

  const previous = existing?.frontmatter ?? null;
  const frontmatter: PageFrontmatter = {
    ...(previous ?? {}),
    type: draft.type,
    title: draft.title,
    domain: draft.domain,
    owner: previous?.owner ?? ctx.ownerFor?.(draft.domain) ?? DEFAULT_OWNER,
    status: previous?.status ?? "draft",
    generated: { at: updatedAt, by: "flash" },
    verified: null,
    stale_after: previous?.stale_after ?? null,
    sources: [...new Set([...(previous?.sources ?? []), source])],
    privacy: draft.privacy,
    checked_by: "flash",
    opus_pending: false,
    claims,
    retiredClaimIds: previous?.retiredClaimIds ?? [],
  };
  return { ok: true, path, frontmatter, body: pageBody(draft, source), updated };
}

/** The line index.md lists a page with. */
export function indexLine(path: string, title: string): string {
  return `- [[${path.replace(/\.md$/, "")}]] — ${title.replace(/[\r\n]+/g, " ")}`;
}

/** index.md with a line for every page it does not link yet. */
export function addToIndex(indexText: string | null, pages: ReadonlyArray<{ path: string; title: string }>): string {
  let text = indexText ?? "# Index\n";
  if (!text.endsWith("\n")) text += "\n";
  const lines: string[] = [];
  for (const p of pages) {
    if (text.includes(`[[${p.path.replace(/\.md$/, "")}]]`)) continue;
    lines.push(indexLine(p.path, p.title));
  }
  if (lines.length === 0) return text;
  return `${text}${text.endsWith("\n\n") ? "" : "\n"}${lines.join("\n")}\n`;
}

/** index.md without the list lines that link `path` (a deleted page). */
export function removeFromIndex(indexText: string, path: string): string {
  const link = `[[${path.replace(/\.md$/, "")}]]`;
  return indexText
    .split("\n")
    .filter((line) => !(/^\s*[-*]\s/.test(line) && line.includes(link)))
    .join("\n");
}
