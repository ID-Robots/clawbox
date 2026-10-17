/**
 * Node summaries: the one to three sentences the Map's card and a page's
 * header show for a page, written from what the wiki around it says — never
 * the "X is named on 53 pages of this wiki" stub the connect pass leaves on a
 * new entity page (that line stays in the body, the fallback).
 *
 * For each page it works out a NEIGHBOURHOOD of numbered facts:
 *  - the page's own facts (claims; the structure pass's enrichment claims among
 *    them: role, totals with their as-of day, who it appears with), and the
 *    lead line of its own text (not the connect stub);
 *  - its neighbours' facts that name it, and the owner-verified facts of the
 *    entities linked with it;
 *  - the hubs that list it, the pages linked with it (entities first), and the
 *    sources it shares with them.
 * Owner-verified facts come first. A neighbour whose privacy is stricter than
 * the page's own lends it nothing (a summary never lifts text up a tier). The
 * facts' digest is the page's NEIGHBOURHOOD HASH: a page whose hash is the
 * one its summary was written from is skipped.
 *
 * Who writes the sentences: the cheap model (node-summary-run.ts) from the
 * facts alone, each sentence naming the facts it rests on; then
 * {@link checkSentences} — the check step — rejects any sentence that cites no
 * fact, or carries a number, a name or a content word the cited facts (and
 * the page's own names) do not hold. Without the model, or when every
 * sentence it wrote is rejected, {@link factsSummary} composes the summary
 * from the facts' own words. Either way every sentence is traceable: the page
 * keeps, beside `summary`, the facts each sentence came from.
 *
 * Order: entities (people, companies, products) → hubs → concepts, the most
 * linked first. Record leaves keep their short summary; a verified page is
 * never rewritten; a `summary` a person wrote (or edited) is theirs; a
 * duplicate entity's summary lives on its canonical page (entity-hygiene.ts).
 *
 * Pure apart from hashing.
 */

import crypto from "crypto";
import { leafInfo } from "./connect";
import { pageSummary } from "./frontmatter";
import { findDuplicateEntities, domainMismatches, isEntityPage, pageNames, type DomainMismatch, type DuplicateGroup } from "./entity-hygiene";
import { buildLinkGraph, isContentPage, pathAliases, type LinkGraph } from "./links";
import { cutAtSentence } from "./page-blurb";
import { classifyRecord, readRecordFrontmatter } from "./records";
import { redactText } from "./redact";
import { hasVerification, ownerVerified, type Claim, type PageFrontmatter, type PageType, type PrivacyTier } from "./schema";
import { readSummaryMeta, SUMMARIES_BY, SUMMARY_ITEMS_MARKER, summaryDigest, summaryOwner, type SummaryMeta } from "./summary-meta";
import type { VaultSnapshot } from "./vault";

export { generatedSummary, readSummaryItems, readSummaryMeta, SUMMARIES_BY, SUMMARY_ITEMS_MARKER, summaryDigest, summaryOwner, type SummaryMeta } from "./summary-meta";

/** Bumped when the facts or the prompt change shape: every summary is written again. */
export const SUMMARY_VERSION = 1;
export const SUMMARY_MAX_SENTENCES = 3;
/** The whole summary, at most (the Map card's blurb cap). */
export const SUMMARY_MAX_CHARS = 400;
export const SENTENCE_MAX_CHARS = 280;
/** Characters of one fact the model is shown. */
export const FACT_MAX_CHARS = 240;
export const MAX_OWN_FACTS = 8;
export const MAX_NAMING_FACTS = 10;
export const MAX_VERIFIED_NEIGHBOUR_FACTS = 3;
export const MAX_HUB_FACTS = 3;
export const MAX_RELATION_FACTS = 8;
export const MAX_SOURCE_FACTS = 2;
/** The line the connect pass gives a new entity page: no fact, the thing this replaces. */
export const CONNECT_STUB_RE = /^.{1,200} is named on \d+ pages? of this wiki\.?$/;

export type SummaryTier = "entity" | "hub" | "concept";
export const TIER_ORDER: readonly SummaryTier[] = ["entity", "hub", "concept"];

export type FactKind = "claim" | "text" | "neighbour-claim" | "hub" | "relation" | "source";

export interface NodeFact {
  /** F1, F2 … in the order shown. */
  id: string;
  kind: FactKind;
  text: string;
  /** The page the fact is from, when not the node itself (its title). */
  on: string | null;
  /** Owner-verified. */
  verified: boolean;
  asOf: string | null;
  /** What it traces to: a claim id, a page path or a source. */
  ref: string;
}

export interface Neighbourhood {
  path: string;
  title: string;
  type: PageType;
  tier: SummaryTier;
  /** Title and aliases (a duplicate's too). */
  names: string[];
  facts: NodeFact[];
  hash: string;
  inbound: number;
  outbound: number;
}

// ── small helpers ─────────────────────────────────────────────────────────────

const PRIVACY_ORDER: readonly PrivacyTier[] = ["public", "internal", "confidential", "secret-ref"];

function sha(text: string, n = 16): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, n);
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A test for "names one of these", compiled once per node. */
function nameMatcher(names: readonly string[]): (text: string) => boolean {
  const res = names
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length >= 3)
    .map((n) => ({ n, re: new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, "u") }));
  return (text: string) => {
    const hay = text.toLowerCase();
    return res.some(({ n, re }) => hay.includes(n) && re.test(hay));
  };
}

function claimRank(a: { c: Claim; v: boolean }, b: { c: Claim; v: boolean }): number {
  return Number(b.v) - Number(a.v) || b.c.confidence - a.c.confidence || b.c.updatedAt.localeCompare(a.c.updatedAt) || a.c.id.localeCompare(b.c.id);
}

function asOfOf(c: Claim): string | null {
  const v = c.as_of ?? c.valid_from ?? null;
  return typeof v === "string" ? v.slice(0, 10) : null;
}

interface Page {
  path: string;
  fm: PageFrontmatter;
  body: string;
  text: string;
}

/** Which summary tier a page is in, or null when it keeps what it has (a record leaf, a source, not a content page). */
export function summaryTier(path: string, fm: PageFrontmatter): SummaryTier | null {
  if (!isContentPage(path) || fm.type === "source") return null;
  if (isEntityPage({ path, fm })) return "entity";
  if (fm.type === "synthesis") return "hub";
  if (readRecordFrontmatter(fm) || classifyRecord(path, fm) || leafInfo(fm.title, fm.claims.map((c) => c.text))) return null;
  return "concept";
}

function isHubPage(fm: PageFrontmatter): boolean {
  const s = fm.structure as { kind?: unknown } | null | undefined;
  if (s && typeof s === "object" && (s.kind === "record-hub" || s.kind === "domain-hub")) return true;
  return fm.type === "synthesis" && !!fm.hub && typeof fm.hub === "object";
}

// ── the neighbourhood ─────────────────────────────────────────────────────────

interface Context {
  byPath: Map<string, Page>;
  graph: LinkGraph;
  /** canonical → its duplicates */
  duplicatesOf: Map<string, string[]>;
}

/** The neighbourhood of `page` (and of its duplicates, when it is their canonical page). */
export function neighbourhoodOf(page: Page, tier: SummaryTier, ctx: Context): Neighbourhood {
  const members = [page, ...(ctx.duplicatesOf.get(page.path) ?? []).map((p) => ctx.byPath.get(p)).filter((p): p is Page => !!p)];
  const memberPaths = new Set(members.map((m) => m.path));
  const names = [...new Set(members.flatMap((m) => pageNames(m.fm)))];
  const named = nameMatcher(names);
  const rank = PRIVACY_ORDER.indexOf(page.fm.privacy);
  const allowed = (p: Page) => p.fm.privacy !== "secret-ref" && PRIVACY_ORDER.indexOf(p.fm.privacy) <= rank;
  const collect = (m: Map<string, Set<string>>) => {
    const out = new Set<string>();
    for (const mem of memberPaths) for (const x of m.get(mem) ?? []) if (!memberPaths.has(x) && isContentPage(x)) out.add(x);
    return out;
  };
  const inbound = collect(ctx.graph.inbound);
  const outbound = collect(ctx.graph.outbound);
  const neighbours = [...new Set([...inbound, ...outbound])]
    .sort()
    .map((p) => ctx.byPath.get(p))
    .filter((p): p is Page => !!p && allowed(p));
  const degree = (p: string) => (ctx.graph.inbound.get(p)?.size ?? 0) + (ctx.graph.outbound.get(p)?.size ?? 0);

  type Draft = Omit<NodeFact, "id">;
  const usedClaims = new Set<string>();
  const live = (c: Claim) => c.status !== "contested" && c.historical !== true;

  // The node's own facts (a duplicate's within its privacy), verified first.
  const own = members
    .filter((m) => m === page || allowed(m))
    .flatMap((m) => m.fm.claims.filter(live).map((c) => ({ c, v: ownerVerified(c, m.fm) })))
    .sort(claimRank)
    .filter(({ c }) => !usedClaims.has(c.id) && usedClaims.add(c.id))
    .slice(0, MAX_OWN_FACTS)
    .map(({ c, v }): Draft => ({ kind: "claim", text: clip(c.text, FACT_MAX_CHARS), on: null, verified: v, asOf: asOfOf(c), ref: c.id }));

  // Its own lead line (a hub's count and totals, a concept's summary) — never the connect stub.
  const lead = pageSummary(page.body);
  const leadText = lead ? clip(lead, FACT_MAX_CHARS) : null;
  const text: Draft[] = leadText && !CONNECT_STUB_RE.test(leadText) ? [{ kind: "text", text: leadText, on: null, verified: false, asOf: null, ref: page.path }] : [];

  // What the neighbours say about it.
  const naming = neighbours
    .flatMap((n) => n.fm.claims.filter((c) => live(c) && named(c.text)).map((c) => ({ c, v: ownerVerified(c, n.fm), n })))
    .sort(claimRank)
    .filter(({ c }) => !usedClaims.has(c.id) && usedClaims.add(c.id))
    .slice(0, MAX_NAMING_FACTS)
    .map(({ c, v, n }): Draft => ({ kind: "neighbour-claim", text: clip(c.text, FACT_MAX_CHARS), on: clip(n.fm.title, 80), verified: v, asOf: asOfOf(c), ref: c.id }));

  // The owner-verified facts of the entities linked with it.
  const verifiedNear = neighbours
    .filter((n) => isEntityPage(n))
    .flatMap((n) => n.fm.claims.filter((c) => live(c) && ownerVerified(c, n.fm)).map((c) => ({ c, v: true, n })))
    .sort(claimRank)
    .filter(({ c }) => !usedClaims.has(c.id) && usedClaims.add(c.id))
    .slice(0, MAX_VERIFIED_NEIGHBOUR_FACTS)
    .map(({ c, n }): Draft => ({ kind: "neighbour-claim", text: clip(c.text, FACT_MAX_CHARS), on: clip(n.fm.title, 80), verified: true, asOf: asOfOf(c), ref: c.id }));

  // The hubs that hold it: its domain's hub first, then record hubs, the newest first.
  const hubs = neighbours
    .filter((n) => isHubPage(n.fm))
    .sort((a, b) => {
      const da = (a.fm.structure as { kind?: string } | undefined)?.kind === "domain-hub" ? 0 : 1;
      const db = (b.fm.structure as { kind?: string } | undefined)?.kind === "domain-hub" ? 0 : 1;
      return da - db || b.fm.title.localeCompare(a.fm.title) || a.path.localeCompare(b.path);
    })
    .slice(0, MAX_HUB_FACTS)
    .map((n): Draft => ({ kind: "hub", text: `Listed in the hub "${clip(n.fm.title, 100)}"`, on: null, verified: false, asOf: null, ref: n.path }));
  const hubPaths = new Set(hubs.map((h) => h.ref));

  // The pages linked with it: entities first, both-way links first, the most linked first.
  const relations = neighbours
    .filter((n) => !hubPaths.has(n.path) && !isHubPage(n.fm) && !(n.fm.structure !== undefined && n.fm.structure !== null))
    .map((n) => ({ n, entity: isEntityPage(n), both: inbound.has(n.path) && outbound.has(n.path) }))
    .sort((a, b) => Number(b.entity) - Number(a.entity) || Number(b.both) - Number(a.both) || degree(b.n.path) - degree(a.n.path) || a.n.path.localeCompare(b.n.path))
    .slice(0, MAX_RELATION_FACTS)
    .map(({ n, both }): Draft => {
      const how = both ? "linked both ways" : inbound.has(n.path) ? "links to it" : "linked from it";
      return { kind: "relation", text: `${clip(n.fm.title, 100)} (${isEntityPage(n) ? "entity" : n.fm.type}; ${how})`, on: null, verified: false, asOf: null, ref: n.path };
    });

  // Sources it shares with its neighbours, the most shared first.
  const shared = new Map<string, string[]>();
  for (const src of new Set(members.flatMap((m) => m.fm.sources))) {
    const with_ = neighbours.filter((n) => n.fm.sources.includes(src)).map((n) => n.fm.title);
    if (with_.length > 0) shared.set(src, with_);
  }
  const sources = [...shared.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, MAX_SOURCE_FACTS)
    .map(([src, with_]): Draft => ({
      kind: "source",
      text: `Shares the source "${clip(src.split("/").pop() ?? src, 80)}" with ${with_.slice(0, 2).map((t) => `"${clip(t, 60)}"`).join(" and ")}${with_.length > 2 ? ` and ${with_.length - 2} more` : ""}`,
      on: null,
      verified: false,
      asOf: null,
      ref: src,
    }));

  // Verified first, whoever says it; then the rest in the order above.
  const ordered: Draft[] = [
    ...own.filter((f) => f.verified),
    ...naming.filter((f) => f.verified),
    ...verifiedNear,
    ...own.filter((f) => !f.verified),
    ...text,
    ...naming.filter((f) => !f.verified),
    ...hubs,
    ...relations,
    ...sources,
  ];
  const facts = ordered.map((f, i) => ({ id: `F${i + 1}`, ...f }));
  const hash = sha(
    JSON.stringify([SUMMARY_VERSION, page.fm.title, page.fm.type, tier, names, facts.map((f) => [f.kind, f.ref, f.text, f.on, f.verified, f.asOf])]),
  );
  return { path: page.path, title: page.fm.title, type: page.fm.type, tier, names, facts, hash, inbound: inbound.size, outbound: outbound.size };
}

/** The neighbourhood as the model may see it: every text redacted (what the check then holds sentences against). */
export function shownNeighbourhood(hood: Neighbourhood): Neighbourhood {
  const r = (t: string) => redactText(t).text;
  return {
    ...hood,
    title: r(hood.title),
    names: hood.names.map(r),
    facts: hood.facts.map((f) => ({ ...f, text: r(f.text), on: f.on === null ? null : r(f.on) })),
  };
}

// ── the model call ────────────────────────────────────────────────────────────

export interface DraftSentence {
  text: string;
  from: string[];
}

export function buildSummaryPrompt(hoods: readonly Neighbourhood[]): { system: string; user: string } {
  return {
    system:
      "You write the summary line of pages in a company wiki from numbered facts. Use only what the facts say: no outside knowledge, no guesses, no praise. Answer with a JSON array only, no prose.",
    user: [
      `For every node write 1 to ${SUMMARY_MAX_SENTENCES} short sentences, at most ${SUMMARY_MAX_CHARS} characters together: what or who it is, its role, its key numbers with their as-of dates, its main relations.`,
      "Rules:",
      '- Every sentence lists in "from" the ids of the facts it rests on. A name, number, date or claim that is not in those facts is not allowed.',
      '- Facts with "verified": true were checked by the owner: lead with them.',
      "- Keep the facts' own words; no adjectives of your own; no links, no markup.",
      '- When the facts say too little, write fewer sentences (an empty "sentences" list is fine).',
      'Answer: [{"i": <node i>, "sentences": [{"text": "...", "from": ["F1", "F3"]}]}]',
      SUMMARY_ITEMS_MARKER,
      JSON.stringify(
        hoods.map((h, i) => ({
          i,
          title: h.title,
          type: h.tier === "entity" ? "entity" : h.type,
          facts: h.facts.map((f) => ({ id: f.id, text: f.text, ...(f.on ? { on: f.on } : {}), ...(f.verified ? { verified: true } : {}), ...(f.asOf ? { as_of: f.asOf } : {}) })),
        })),
      ),
    ].join("\n"),
  };
}

/** Each node's sentences, wherever the answer's array sits; a node out of range or answered twice is dropped. */
export function parseSummaryResponse(text: string, count: number): Map<number, DraftSentence[]> {
  const out = new Map<number, DraftSentence[]>();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;
  const twice = new Set<number>();
  for (const item of parsed) {
    const o = item as { i?: unknown; sentences?: unknown };
    if (typeof o?.i !== "number" || !Number.isInteger(o.i) || o.i < 0 || o.i >= count || !Array.isArray(o.sentences)) continue;
    if (out.has(o.i)) twice.add(o.i);
    const sentences: DraftSentence[] = [];
    for (const s of o.sentences) {
      const r = s as { text?: unknown; from?: unknown };
      if (typeof r?.text !== "string") continue;
      sentences.push({ text: r.text, from: Array.isArray(r.from) ? r.from.filter((x): x is string => typeof x === "string") : [] });
    }
    out.set(o.i, sentences);
  }
  for (const i of twice) out.delete(i);
  return out;
}

// ── the check step ────────────────────────────────────────────────────────────

/** Capitalised words that are no name: sentence openers, pronouns, months, weekdays. */
const NAME_STOP: ReadonlySet<string> = new Set(
  (
    "The A An This That These Those It Its Their They Them He She His Her Hers Our We You Your Both Each Every All Most Some Several Many Few One Two Three " +
    "In On At For From To By With And Or But As Of About Over Under Since Until Through Between Among After Before During While When Where Which Who Whose " +
    "Also Mainly Mostly Often Together According Here There Its Is Was Are Were Has Have Had " +
    "January February March April May June July August September October November December Jan Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec " +
    "Monday Tuesday Wednesday Thursday Friday Saturday Sunday"
  ).split(" "),
);

/** Words a summary may use that no fact needs to hold: how sentences are joined, what kind of thing a node is. */
const CONNECTIVE: ReadonlySet<string> = new Set(
  (
    "about above according across after again against along also among another appears appear around based because before being below between both " +
    "company companies person people product products project projects entity entities concept concepts organisation organization business " +
    "connected connection connections counterparty customer customers supplier suppliers partner partners vendor vendors client clients " +
    "during either every first further hub hubs include includes including itself known latest linked links listed lists mainly most mostly named " +
    "other others page pages record records related relation relations several shared shares since source sources their there these those through " +
    "together total totals under until verified which while whose within without works worked working wiki owner role roles currently recorded " +
    "where whom often frequently together various number amount amounts dated date dates according period"
  ).split(" "),
);

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Each number in a text: its value ("1,234.50" → 1234.5, "09" → 9) and its runs of digits (a date spelt another way). */
function numberTokens(text: string): Array<{ value: string; runs: string[] }> {
  return (text.match(/\d+(?:[.,'’]\d+)*/g) ?? []).map((t) => {
    const plain = t.replace(/[,'’]/g, "");
    const n = Number(plain);
    return { value: Number.isFinite(n) ? String(n) : plain, runs: (t.match(/\d+/g) ?? []).map((d) => String(Number(d))) };
  });
}

const STOP_WORDS: ReadonlySet<string> = new Set([...NAME_STOP].map((w) => w.toLowerCase()));

export interface CheckedSummary {
  accepted: Array<{ text: string; refs: string[]; verified: boolean }>;
  rejected: Array<{ text: string; reason: string }>;
}

/**
 * The check step: a sentence stands only when it cites facts of this node and
 * every number, name and content word in it is in those facts (or the node's
 * own names). Sentences resting on an owner-verified fact go first; at most
 * {@link SUMMARY_MAX_SENTENCES}, {@link SUMMARY_MAX_CHARS} together.
 */
export function checkSentences(drafts: readonly DraftSentence[], hood: Neighbourhood): CheckedSummary {
  const byId = new Map(hood.facts.map((f) => [f.id, f]));
  const out: CheckedSummary = { accepted: [], rejected: [] };
  const seen = new Set<string>();
  const ok: Array<{ text: string; refs: string[]; verified: boolean; at: number }> = [];
  drafts.forEach((d, at) => {
    let text = d.text.replace(/\s+/g, " ").trim();
    const reject = (reason: string) => out.rejected.push({ text: clip(text, 300), reason });
    if (text === "") return reject("empty");
    if (!/[.!?…]$/.test(text)) text = `${text}.`;
    if (text.length > SENTENCE_MAX_CHARS) return reject("too_long");
    if (/\[REDACTED|\[\[|\]\(|https?:|<[a-z!/]|`/i.test(text)) return reject("markup");
    const cited = [...new Set(d.from)].map((id) => byId.get(id)).filter((f): f is NodeFact => !!f);
    if (cited.length === 0) return reject("no_source");
    const corpusText = [...cited.flatMap((f) => [f.text, f.on ?? "", f.asOf ?? ""]), ...hood.names, hood.title].join(" \n ");
    const corpusWords = new Set(words(corpusText));
    const corpusNumbers = new Set(numberTokens(corpusText).flatMap((t) => [t.value, ...t.runs]));
    const stems = new Set([...corpusWords].filter((w) => w.length >= 5).map((w) => w.slice(0, 5)));
    for (const n of numberTokens(text)) {
      if (!corpusNumbers.has(n.value) && !n.runs.every((r) => corpusNumbers.has(r))) return reject(`unsupported_number:${n.value}`);
    }
    for (const raw of text.match(/(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{N}]*/gu) ?? []) {
      const w = raw.replace(/(?:'s|’s)$/u, "");
      if (NAME_STOP.has(w) || corpusWords.has(w.toLowerCase())) continue;
      return reject(`unsupported_name:${w}`);
    }
    for (const w of words(text)) {
      if (w.length < 5 || /\d/.test(w) || CONNECTIVE.has(w) || STOP_WORDS.has(w) || corpusWords.has(w) || stems.has(w.slice(0, 5))) continue;
      return reject(`unsupported_word:${w}`);
    }
    const key = text.toLowerCase();
    if (seen.has(key)) return reject("repeated");
    seen.add(key);
    ok.push({ text, refs: [...new Set(cited.map((f) => f.ref))], verified: cited.some((f) => f.verified), at });
  });
  ok.sort((a, b) => Number(b.verified) - Number(a.verified) || a.at - b.at);
  let used = 0;
  for (const s of ok) {
    const cost = s.text.length + (out.accepted.length > 0 ? 1 : 0);
    if (out.accepted.length >= SUMMARY_MAX_SENTENCES || used + cost > SUMMARY_MAX_CHARS) {
      out.rejected.push({ text: s.text, reason: "over_length" });
      continue;
    }
    used += cost;
    out.accepted.push({ text: s.text, refs: s.refs, verified: s.verified });
  }
  return out;
}

/** "A", "A and B", "A, B and C". */
function list(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The summary from the facts' own words, when no model writes it: the
 * strongest facts about the node (verified first), then who it is linked
 * with. Every sentence passes {@link checkSentences} by construction.
 */
export function factsSummary(hood: Neighbourhood): DraftSentence[] {
  const out: DraftSentence[] = [];
  const named = nameMatcher(hood.names);
  const about = hood.facts.filter(
    (f) => (f.kind === "claim" || (f.kind === "neighbour-claim" && named(f.text))) && f.text.length <= SENTENCE_MAX_CHARS - 1 && !f.text.endsWith("…"),
  );
  for (const f of about.slice(0, 2)) out.push({ text: f.text, from: [f.id] });
  if (out.length < 2) {
    const lead = hood.facts.find((f) => f.kind === "text");
    if (lead) out.push({ text: cutAtSentence(lead.text, SENTENCE_MAX_CHARS - 1), from: [lead.id] });
  }
  const rel = hood.facts.filter((f) => f.kind === "relation").slice(0, 3);
  if (rel.length > 0) {
    const titles = rel.map((f) => f.text.replace(/ \([^()]*\)$/, ""));
    out.push({ text: `${hood.title} is linked with ${list(titles)}.`, from: rel.map((f) => f.id) });
  } else {
    const hubs = hood.facts.filter((f) => f.kind === "hub").slice(0, 2);
    if (hubs.length > 0) out.push({ text: `${hood.title} is listed in ${list(hubs.map((f) => f.text.replace(/^Listed in the hub /, "")))}.`, from: hubs.map((f) => f.id) });
  }
  return out;
}

// ── the plan ──────────────────────────────────────────────────────────────────

export type SummaryReason = "new" | "changed" | "upgrade";

export interface SummaryJob {
  hood: Neighbourhood;
  reason: SummaryReason;
  /** What the page carries now. */
  prior: SummaryMeta | null;
}

export interface SummaryPlanStats {
  /** Pages in a summary tier. */
  eligible: number;
  byTier: Record<SummaryTier, number>;
  /** Their neighbourhood is the one their summary was written from. */
  unchanged: number;
  skippedVerified: number;
  /** A `summary` a person wrote or edited: kept. */
  keptPerson: number;
  /** Nothing around them to say anything with. */
  noFacts: number;
  /** Duplicates whose summary lives on their canonical page. */
  duplicates: number;
  /** Record leaves and source pages: they keep their short summary. */
  leaves: number;
}

export interface SummaryPlan {
  /** Pages to (re)write, entities → hubs → concepts, new before changed before upgrades, the most linked first. */
  jobs: SummaryJob[];
  stats: SummaryPlanStats;
  duplicates: DuplicateGroup[];
  mismatches: DomainMismatch[];
}

export interface SummaryPlanOptions {
  /** The configured domain names (settings `domains`): what a domain suggestion may name. */
  domains?: readonly string[];
  /** Whether the model can write this run: a summary the facts wrote is then due an upgrade. */
  modelAvailable?: boolean;
}

/** Plan the summaries pass over `snapshot`. Pure. */
export function planSummaries(snapshot: Pick<VaultSnapshot, "pages">, options: SummaryPlanOptions = {}): SummaryPlan {
  const pages: Page[] = snapshot.pages.flatMap((p) => (p.parsed.ok ? [{ path: p.path, fm: p.parsed.frontmatter, body: p.parsed.body, text: p.text }] : []));
  const byPath = new Map(pages.map((p) => [p.path, p]));
  const graph = buildLinkGraph(
    pages.map((p) => ({ path: p.path, title: p.fm.title, aliases: pathAliases(p.fm.aliases), body: p.body })),
    null,
  );
  const inboundOf = (p: string) => [...(graph.inbound.get(p) ?? [])].filter(isContentPage).length;
  const duplicates = findDuplicateEntities(pages, inboundOf);
  const duplicatesOf = new Map(duplicates.map((g) => [g.canonical, g.duplicates]));
  const duplicate = new Set(duplicates.flatMap((g) => g.duplicates));
  const linked = (p: string) => [...(graph.inbound.get(p) ?? []), ...(graph.outbound.get(p) ?? [])].filter(isContentPage);
  const mismatches = domainMismatches(pages, linked, { configured: options.domains });
  const ctx: Context = { byPath, graph, duplicatesOf };

  const stats: SummaryPlanStats = { eligible: 0, byTier: { entity: 0, hub: 0, concept: 0 }, unchanged: 0, skippedVerified: 0, keptPerson: 0, noFacts: 0, duplicates: 0, leaves: 0 };
  const jobs: SummaryJob[] = [];
  for (const p of pages) {
    const tier = summaryTier(p.path, p.fm);
    if (!tier) {
      if (isContentPage(p.path)) stats.leaves++;
      continue;
    }
    stats.eligible++;
    stats.byTier[tier]++;
    if (duplicate.has(p.path)) {
      stats.duplicates++;
      continue;
    }
    if (hasVerification(p.fm)) {
      stats.skippedVerified++;
      continue;
    }
    const owner = summaryOwner(p.fm);
    if (owner === "person") {
      stats.keptPerson++;
      continue;
    }
    const hood = neighbourhoodOf(p, tier, ctx);
    if (hood.facts.length === 0) {
      stats.noFacts++;
      continue;
    }
    const prior = owner === "ours" ? readSummaryMeta(p.fm) : null;
    if (prior && prior.hash === hood.hash && !(prior.method === "facts" && options.modelAvailable)) {
      stats.unchanged++;
      continue;
    }
    jobs.push({ hood, reason: !prior ? "new" : prior.hash !== hood.hash ? "changed" : "upgrade", prior });
  }
  const reasonOrder: readonly SummaryReason[] = ["new", "changed", "upgrade"];
  jobs.sort(
    (a, b) =>
      TIER_ORDER.indexOf(a.hood.tier) - TIER_ORDER.indexOf(b.hood.tier) ||
      reasonOrder.indexOf(a.reason) - reasonOrder.indexOf(b.reason) ||
      b.hood.inbound - a.hood.inbound ||
      a.hood.path.localeCompare(b.hood.path),
  );
  return { jobs, stats, duplicates, mismatches };
}

/** A page's frontmatter with `summary` and its meta set from accepted sentences. */
export function withSummary(
  fm: PageFrontmatter,
  accepted: CheckedSummary["accepted"],
  method: SummaryMeta["method"],
  hash: string,
  at: string,
): PageFrontmatter {
  const text = accepted.map((s) => s.text).join(" ");
  const meta: SummaryMeta = { by: SUMMARIES_BY, method, hash, digest: summaryDigest(text), at, from: accepted.map((s) => s.refs) };
  return { ...fm, summary: text, summary_meta: meta };
}
