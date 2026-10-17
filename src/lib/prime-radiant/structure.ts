/**
 * The structure pass: the layer that turns a vault of document-per-page
 * leaves (one page per receipt, invoice, waybill, transfer) and stub entities
 * into a wiki a person can walk from the top.
 *
 * Deterministic, no model call (the cheap-model fallback for a record's type
 * is the caller's: structure-run.ts hands its answers in as `assigned`). Over
 * the whole vault it plans:
 *  1. MONTHLY RECORD HUBS — one `synthesis` page per record type × month
 *     (records.ts classifies the leaves): how many, totals per currency, a
 *     table of the leaves with links, the previous and next month. A month
 *     with more than {@link HUB_PART_LEAVES} leaves gives each counterparty
 *     with {@link COUNTERPARTY_HUB_MIN} or more of them a hub of its own under
 *     the month's; a list still too long for one page is cut into parts. Each
 *     leaf links back up to the hub that lists it and carries
 *     `record: { type, month, hub, by }` in its frontmatter — what the search
 *     index (a leaf never outranks its hub) and the contradiction pass (two
 *     leaves of one hub are never paired, pairing.ts) read.
 *  2. DOMAIN HUBS — one per configured domain (settings `domains` and their
 *     owners): what it covers, its current key facts (owner-verified first),
 *     its open review items, its top entities and its record hubs.
 *  3. THE ROOT — one page for the owner's company, linking every domain hub,
 *     the record hubs and the decisions register.
 *  4. ENTITY ENRICHMENT — the top {@link DEFAULT_ENRICH_TOP} entities by
 *     inbound links get claims worked out from the pages around them: their
 *     role (the records they are the counterparty of), who they appear with,
 *     their totals, when they were first and last seen. At most
 *     {@link ENRICH_MAX_CLAIMS} a page, never past lint's claim cap.
 *  5. THE DECISIONS REGISTER — every `decision` page and every claim of type
 *     decision, with its date, who decided and its source, newest first;
 *     older years on pages of their own once the register is full.
 *
 * What the pass writes lives in managed blocks, replaced whole on every run:
 *   <!-- prime-radiant:hub:start --> … <!-- prime-radiant:hub:end -->      (a page this pass owns)
 *   <!-- prime-radiant:record:start --> … <!-- prime-radiant:record:end --> (a leaf's link up)
 * Everything outside them is a person's and is kept byte for byte. A run over
 * an unchanged vault plans no write (idempotent). A verified page is never
 * rewritten; a page this pass made and a person verified is theirs.
 *
 * {@link planStructure} is pure; {@link runStructurePass} writes the plan in
 * commits of {@link STRUCTURE_BATCH} pages (new pages and their index.md lines
 * first).
 */

import { isClaimId, makeClaimId, slugify } from "./claims";
import { RELATED_START, type PlannedWrite } from "./connect";
import { titleIdentifiers } from "./identifiers";
import { buildLinkGraph, isContentPage, linkDensity, relativeHref } from "./links";
import { LIMITS } from "./lint";
import {
  classifyRecord,
  formatAmount,
  readRecordFrontmatter,
  RECORD_LABELS,
  RECORD_TYPES,
  totalsByCurrency,
  type RecordInfo,
  type RecordType,
} from "./records";
import { isIsoDate, ownerVerified, type Claim, type PageFrontmatter, type PrivacyTier } from "./schema";
import type { DomainSetting } from "./settings";
import type { VaultSnapshot, VaultTx } from "./vault";
import { addToIndex } from "./writer";

export const STRUCTURE_BY = "structure";
export const HUB_START = "<!-- prime-radiant:hub:start -->";
export const HUB_END = "<!-- prime-radiant:hub:end -->";
export const RECORD_START = "<!-- prime-radiant:record:start -->";
export const RECORD_END = "<!-- prime-radiant:record:end -->";

/** Leaves a type × month needs before it gets a hub. Two: any pair the contradiction pass could form has one. */
export const MIN_RECORD_HUB_LEAVES = 2;
/** Leaves one hub page lists at most; more go to counterparty hubs, then to parts. */
export const HUB_PART_LEAVES = 40;
/** Leaves a counterparty needs in a crowded month before it gets a hub of its own. */
export const COUNTERPARTY_HUB_MIN = 5;
/** Characters a hub's leaf table may take (lint's soft cap is 6,000 for the whole body). */
export const HUB_TABLE_BUDGET = 3_600;
/** Entities enriched per run, by default (settings `structure.enrichTop`). */
export const DEFAULT_ENRICH_TOP = 25;
/** Claims enrichment adds to one entity page, at most. */
export const ENRICH_MAX_CLAIMS = 5;
/** Key facts a domain hub lists. */
export const DOMAIN_KEY_FACTS = 8;
/** Entities and hubs a domain hub (and the root) links to, at most. */
export const DOMAIN_TOP_ENTITIES = 8;
export const DOMAIN_HUB_LINKS = 12;
export const DOMAIN_REVIEW_ITEMS = 8;
/** Rows the register page holds before older years move to pages of their own. */
export const REGISTER_ROWS = 20;
/** Rows one year page of the register holds before it is cut into parts. */
export const REGISTER_YEAR_ROWS = 24;
/** Pages one commit of the pass writes. */
export const STRUCTURE_BATCH = 400;
/** The domain the root page and the register live in when no configured domain is theirs. */
export const GENERAL_DOMAIN = "general";

export type StructureKind = "record-hub" | "domain-hub" | "root" | "decisions";

/** The `structure` frontmatter of a page this pass made: what it is, so a re-run finds it whatever its path or title. */
export interface StructureMeta {
  kind: StructureKind;
  type?: RecordType;
  month?: string;
  counterparty?: string;
  part?: number;
  domain?: string;
  /** A register page of one year (`undated` for decisions with no date). */
  year?: string;
  leaves?: number;
}

export function readStructureMeta(fm: Record<string, unknown>): StructureMeta | null {
  const raw = fm.structure;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "record-hub" && r.kind !== "domain-hub" && r.kind !== "root" && r.kind !== "decisions") return null;
  return r as unknown as StructureMeta;
}

/** One identity per page this pass owns. */
function identityOf(meta: StructureMeta): string {
  switch (meta.kind) {
    case "record-hub":
      return `record-hub|${meta.type}|${meta.month}|${meta.counterparty ?? ""}|${meta.part ?? 1}`;
    case "domain-hub":
      return `domain-hub|${meta.domain}`;
    case "decisions":
      return `decisions|${meta.year ?? ""}|${meta.part ?? 1}`;
    default:
      return "root";
  }
}

// ── managed blocks ────────────────────────────────────────────────────────

function blockRe(start: string, end: string): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\n*${esc(start)}[\\s\\S]*?${esc(end)}[ \\t]*\\n?`);
}

/** What a managed block holds (between its markers), or null when the body has none. */
export function blockContent(body: string, start: string, end: string): string | null {
  const at = body.indexOf(start);
  if (at < 0) return null;
  const stop = body.indexOf(end, at + start.length);
  return stop < 0 ? null : body.slice(at + start.length, stop).replace(/^\n+|\n+$/g, "");
}

/**
 * `body` with the managed block holding `content`: replaced where it is, else
 * put before the connect pass's block (which closes a page), else at the end.
 * Empty `content` takes the block out. Text outside the block is kept as is.
 */
export function upsertBlock(body: string, start: string, end: string, content: string, where: "start" | "end" = "end"): string {
  const re = blockRe(start, end);
  const block = content === "" ? "" : `${start}\n${content.replace(/\n+$/, "")}\n${end}`;
  if (re.test(body)) {
    const replaced = body.replace(re, (whole) => {
      if (block === "") return "\n";
      const lead = whole.startsWith("\n") ? (whole.match(/^\n*/)?.[0] ?? "") : "";
      return `${lead}${block}\n`;
    });
    return tidy(replaced);
  }
  if (block === "") return body;
  const trimmed = body.replace(/\s+$/, "");
  if (where === "start") return tidy(trimmed === "" ? `${block}\n` : `${block}\n\n${trimmed}\n`);
  const related = trimmed.indexOf(RELATED_START);
  if (related >= 0) {
    const before = trimmed.slice(0, related).replace(/\s+$/, "");
    return tidy(`${before === "" ? "" : `${before}\n\n`}${block}\n\n${trimmed.slice(related)}\n`);
  }
  return tidy(trimmed === "" ? `${block}\n` : `${trimmed}\n\n${block}\n`);
}

/** A body without a leaf's link up to its hub (navigation, never embedded for search). */
export function stripRecordBlock(body: string): string {
  return body.includes(RECORD_START) ? upsertBlock(body, RECORD_START, RECORD_END, "") : body;
}

function tidy(body: string): string {
  const out = body.replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
  return out === "" ? "" : `${out}\n`;
}

// ── small helpers ─────────────────────────────────────────────────────────

interface Page {
  path: string;
  fm: PageFrontmatter;
  body: string;
  text: string;
}

const PRIVACY_ORDER: readonly PrivacyTier[] = ["public", "internal", "confidential", "secret-ref"];

/** The strictest privacy of what a page rolls up, `confidential` at most (a `secret-ref` stays on its own page). */
function strictestPrivacy(pages: readonly Page[]): PrivacyTier {
  let at = 1;
  for (const p of pages) at = Math.max(at, Math.min(2, PRIVACY_ORDER.indexOf(p.fm.privacy)));
  return PRIVACY_ORDER[at];
}

/** The most common value, ties alphabetically. */
function mostCommon(xs: readonly string[]): string | null {
  const c = new Map<string, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

/** The sources a page rolls up: the most shared first; the pages' own paths when they name none (lint wants one). */
function rollupSources(pages: readonly Page[], max: number): string[] {
  const c = new Map<string, number>();
  for (const p of pages) for (const s of p.fm.sources) c.set(s, (c.get(s) ?? 0) + 1);
  const ranked = [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([s]) => s);
  return ranked.length > 0 ? ranked : pages.slice(0, max).map((p) => p.path);
}

/** A title fit for one table cell or one line: no pipes, brackets or line breaks, capped. */
function cell(text: string, max = 70): string {
  const clean = text.replace(/[\r\n]+/g, " ").replace(/\|/g, "/").replace(/\[/g, "(").replace(/\]/g, ")").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function wikiLine(path: string, title: string, note = ""): string {
  return `- [[${path.replace(/\.md$/, "")}]] — ${cell(title, 80)}${note}`;
}

function mdLink(from: string, to: string, title: string, max = 70): string {
  return `[${cell(title, max)}](${relativeHref(from, to)})`;
}

function uniquePath(folder: string, title: string, taken: Set<string>): string {
  const base = slugify(title, 80);
  let p = `${folder}/${base === "index" ? "index-page" : base}.md`;
  for (let n = 2; taken.has(p) && n < 10_000; n++) p = `${folder}/${base}-${n}.md`;
  taken.add(p);
  return p;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function totalsText(totals: ReadonlyArray<{ currency: string; total: number }>): string {
  if (totals.length === 0) return "";
  const shown = totals.slice(0, 3).map((t) => `${formatAmount(t.total)} ${t.currency}`);
  const more = totals.length > 3 ? ` and ${totals.length - 3} more currencies` : "";
  return shown.length === 1 ? shown[0] + more : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}${more}`;
}

function domainLabel(name: string): string {
  const words = name.split("-").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isEntity(p: Page): boolean {
  return p.fm.type === "entity" || p.path.startsWith("entities/");
}

function isVerifiedPage(fm: PageFrontmatter): boolean {
  return !!fm.verified || fm.claims.some((c) => !!c.verified);
}

function stringList(v: unknown): string[] {
  if (typeof v === "string") return [v];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function normName(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function dayOf(v: unknown): string | null {
  return isIsoDate(v) ? v.slice(0, 10) : null;
}

// ── the plan ──────────────────────────────────────────────────────────────

export interface StructureReviewItem {
  id: string;
  kind: string;
  pages: string[];
  claimId?: string | null;
}

export interface StructureOptions {
  now?: Date;
  /** The configured domains and their owners (settings `domains`). None: the domains the pages name. */
  domains?: readonly DomainSetting[];
  /** The owner's company: the root page's title, and never a record's counterparty. */
  company?: string | null;
  /** Entities enriched (settings `structure.enrichTop`); 0 switches enrichment off. */
  enrichTop?: number;
  /** The open review items, for the domain hubs. */
  reviewItems?: readonly StructureReviewItem[];
  /** Retired claim ids the state database remembers: never used again. */
  ledgerRetired?: Iterable<string>;
  /** Record types the cheap model gave pages the rules could not type. */
  assigned?: ReadonlyMap<string, RecordType>;
}

export interface StructureStats {
  pages: number;
  /** Record leaves, by type. */
  leaves: number;
  byType: Record<RecordType, number>;
  /** Leaves rolled up in a hub. */
  leavesInHubs: number;
  recordHubs: number;
  counterpartyHubs: number;
  domainHubs: number;
  /** Configured domains no page names yet: no hub until one does. */
  domainsEmpty: string[];
  root: boolean;
  entitiesEnriched: number;
  claimsAdded: number;
  decisions: number;
  registerPages: number;
  /** Verified pages the plan would have changed, left as they are. */
  skippedVerified: number;
  /** Meaningful links per page (links.ts `linkDensity`), before and after. */
  linksMedianBefore: number;
  linksMedianAfter: number;
}

export interface StructurePlan {
  writes: PlannedWrite[];
  stats: StructureStats;
}

/** What the pass decides on a page of its own; the rest of its frontmatter is kept or defaulted. */
interface OurFields {
  type: "synthesis";
  title: string;
  domain: string;
  owner: string;
  sources: string[];
  privacy: PrivacyTier;
  structure: StructureMeta;
}

interface Leaf {
  page: Page;
  info: RecordInfo;
  sortKey: string;
}

interface HubDraft {
  path: string;
  title: string;
  meta: StructureMeta;
  domain: string;
  owner: string;
  leaves: Leaf[];
  /** Every leaf of the type × month, for the month hub's totals. */
  group: Leaf[];
  prior: Page | null;
  /** Parts of the same list, in order (this one included). */
  siblings: string[];
}

function emptyByType(): Record<RecordType, number> {
  return Object.fromEntries(RECORD_TYPES.map((t) => [t, 0])) as Record<RecordType, number>;
}

/** A leaf table, as many rows as fit {@link HUB_TABLE_BUDGET} and {@link HUB_PART_LEAVES}: the rows and how many leaves they hold. */
function leafRows(from: string, leaves: readonly Leaf[]): { rows: string[]; count: number } {
  const rows: string[] = [];
  let used = 0;
  for (const l of leaves) {
    if (rows.length >= HUB_PART_LEAVES) break;
    const a = l.info.amount;
    const row = `| ${l.info.day ?? l.info.month} | ${mdLink(from, l.page.path, l.page.fm.title)} | ${cell(l.info.counterparty ?? "—", 40)} | ${a ? `${formatAmount(a.value)} ${a.currency}` : "—"} |`;
    if (rows.length > 0 && used + row.length + 1 > HUB_TABLE_BUDGET) break;
    rows.push(row);
    used += row.length + 1;
  }
  return { rows, count: rows.length };
}

/** A list cut into parts by what one page's table holds. Paths are not known yet: a part's rows are laid out against a stand-in. */
function cutParts(leaves: readonly Leaf[]): Leaf[][] {
  const parts: Leaf[][] = [];
  let rest = leaves.slice();
  while (rest.length > 0) {
    const { count } = leafRows("syntheses/x.md", rest);
    const n = Math.max(1, count);
    parts.push(rest.slice(0, n));
    rest = rest.slice(n);
  }
  return parts;
}

/** Plan the pass over `snapshot`. Pure. */
export function planStructure(snapshot: Pick<VaultSnapshot, "pages" | "indexBody">, options: StructureOptions = {}): StructurePlan {
  const now = (options.now ?? new Date()).toISOString();
  const company = options.company?.trim() || null;
  const pages: Page[] = snapshot.pages.flatMap((p) => (p.parsed.ok ? [{ path: p.path, fm: p.parsed.frontmatter, body: p.parsed.body, text: p.text }] : []));
  const byPath = new Map(pages.map((p) => [p.path, p]));
  const taken = new Set(snapshot.pages.map((p) => p.path));
  const ours = new Map<string, Page>();
  for (const p of pages) {
    // A page of ours a person has since taken over keeps its place too: found by what it is, not by who wrote it last.
    const meta = readStructureMeta(p.fm);
    if (meta && !ours.has(identityOf(meta))) ours.set(identityOf(meta), p);
  }
  const connectHubs = new Map(pages.filter((p) => p.fm.generated?.by === "connect" && p.fm.type === "synthesis" && !readStructureMeta(p.fm)).map((p) => [p.fm.title, p]));
  const ownerOf = new Map((options.domains ?? []).map((d) => [d.name, d.owner]));
  const stats: StructureStats = {
    pages: pages.length,
    leaves: 0,
    byType: emptyByType(),
    leavesInHubs: 0,
    recordHubs: 0,
    counterpartyHubs: 0,
    domainHubs: 0,
    domainsEmpty: [],
    root: false,
    entitiesEnriched: 0,
    claimsAdded: 0,
    decisions: 0,
    registerPages: 0,
    skippedVerified: 0,
    linksMedianBefore: 0,
    linksMedianAfter: 0,
  };
  const graphBefore = buildLinkGraph(pages.map((p) => ({ path: p.path, title: p.fm.title, body: p.body })), null);
  stats.linksMedianBefore = linkDensity(graphBefore).median;

  // The plan's pages as they will be: path -> { fm, body } (written only where they differ).
  const next = new Map<string, { fm: PageFrontmatter; body: string; created: boolean }>();
  const fmOf = (path: string) => next.get(path)?.fm ?? byPath.get(path)?.fm;
  const titleOf = (path: string) => fmOf(path)?.title ?? path.replace(/\.md$/, "");
  const placeFor = (meta: StructureMeta, title: string): { path: string; prior: Page | null } => {
    const prior = ours.get(identityOf(meta)) ?? (meta.kind === "record-hub" && !meta.counterparty ? connectHubs.get(title) ?? null : null);
    if (prior) return { path: prior.path, prior };
    return { path: uniquePath("syntheses", title, taken), prior: null };
  };
  const stamp = (prior: Page | null) => (prior?.fm.generated?.at ? { at: prior.fm.generated.at, by: STRUCTURE_BY } : { at: now, by: STRUCTURE_BY });
  /** A page of ours: the prior's frontmatter kept where a person may have set it (owner, status, privacy, aliases). */
  const ourFrontmatter = (prior: Page | null, fresh: OurFields): PageFrontmatter => {
    if (prior) {
      const kept: PageFrontmatter = { ...prior.fm };
      // An adopted connect hub drops connect's own bookkeeping.
      if (prior.fm.generated?.by === "connect") delete kept.hub;
      return {
        ...kept,
        type: "synthesis",
        title: fresh.title,
        domain: prior.fm.generated?.by === STRUCTURE_BY ? fresh.domain : prior.fm.domain,
        owner: prior.fm.owner === "unassigned" ? fresh.owner : prior.fm.owner,
        generated: stamp(prior),
        sources: fresh.sources,
        privacy: PRIVACY_ORDER.indexOf(prior.fm.privacy) > PRIVACY_ORDER.indexOf(fresh.privacy) ? prior.fm.privacy : fresh.privacy,
        structure: fresh.structure,
      };
    }
    return {
      type: "synthesis",
      title: fresh.title,
      domain: fresh.domain,
      owner: fresh.owner,
      status: "draft",
      generated: stamp(null),
      verified: null,
      stale_after: null,
      sources: fresh.sources,
      privacy: fresh.privacy,
      checked_by: "flash",
      opus_pending: false,
      claims: [],
      retiredClaimIds: [],
      structure: fresh.structure,
    };
  };
  const setOurPage = (path: string, prior: Page | null, fm: PageFrontmatter, content: string) => {
    // An adopted connect hub was all machine text (a line and connect's block): it starts over.
    const kept = prior && prior.fm.generated?.by !== "connect" ? prior.body : "";
    const body = upsertBlock(kept, HUB_START, HUB_END, content, "start");
    next.set(path, { fm, body, created: !prior });
  };

  // 1. leaves
  const leaves: Leaf[] = [];
  for (const p of pages) {
    if (readStructureMeta(p.fm)) continue;
    const assigned = options.assigned?.get(p.path);
    const info = classifyRecord(p.path, p.fm, { ownCompany: company, assign: assigned ? { type: assigned, by: "model" } : null });
    if (!info) continue;
    leaves.push({ page: p, info, sortKey: `${info.day ?? `${info.month}-00`}|${p.path}` });
    stats.byType[info.type]++;
  }
  stats.leaves = leaves.length;
  const groups = new Map<string, Leaf[]>();
  for (const l of leaves) {
    const key = `${l.info.type}|${l.info.month}`;
    const g = groups.get(key) ?? [];
    g.push(l);
    groups.set(key, g);
  }

  const hubs: HubDraft[] = [];
  const hubOfLeaf = new Map<string, HubDraft>();
  const monthHub = new Map<string, HubDraft>();
  const domainOfLeaves = (ls: readonly Leaf[]) => mostCommon(ls.map((l) => l.page.fm.domain)) ?? GENERAL_DOMAIN;
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    if (group.length < MIN_RECORD_HUB_LEAVES) continue;
    const { type, month } = group[0].info;
    const many = RECORD_LABELS[type].many;
    const domain = domainOfLeaves(group);
    const owner = ownerOf.get(domain) ?? "unassigned";
    // A crowded month: counterparties with enough leaves get hubs of their own.
    const byCounterparty = new Map<string, Leaf[]>();
    if (group.length > HUB_PART_LEAVES) {
      for (const l of group) {
        if (!l.info.counterparty) continue;
        const list = byCounterparty.get(l.info.counterparty) ?? [];
        list.push(l);
        byCounterparty.set(l.info.counterparty, list);
      }
      for (const [name, list] of [...byCounterparty]) if (list.length < COUNTERPARTY_HUB_MIN) byCounterparty.delete(name);
    }
    const ownList = group.filter((l) => !l.info.counterparty || !byCounterparty.has(l.info.counterparty));
    const lists: Array<{ counterparty: string | null; leaves: Leaf[] }> = [
      { counterparty: null, leaves: ownList },
      ...[...byCounterparty.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([counterparty, ls]) => ({ counterparty, leaves: ls })),
    ];
    for (const list of lists) {
      const parts = list.leaves.length > 0 ? cutParts(list.leaves) : [[]];
      const drafts: HubDraft[] = [];
      parts.forEach((slice, i) => {
        const part = i + 1;
        const title = `${many} ${month}${list.counterparty ? ` — ${list.counterparty}` : ""}${part > 1 ? ` (part ${part})` : ""}`;
        const meta: StructureMeta = { kind: "record-hub", type, month, ...(list.counterparty ? { counterparty: list.counterparty } : {}), ...(part > 1 ? { part } : {}), leaves: slice.length };
        const { path, prior } = placeFor(meta, title);
        const draft: HubDraft = { path, title, meta, domain, owner, leaves: slice, group, prior, siblings: [] };
        drafts.push(draft);
        for (const l of slice) hubOfLeaf.set(l.page.path, draft);
      });
      for (const d of drafts) d.siblings = drafts.map((x) => x.path);
      hubs.push(...drafts);
      if (list.counterparty === null) monthHub.set(key, drafts[0]);
      else stats.counterpartyHubs++;
    }
  }
  stats.recordHubs = hubs.length;
  stats.leavesInHubs = hubOfLeaf.size;
  const hubByPath = new Map(hubs.map((h) => [h.path, h]));

  // 2. domains: the configured ones, else the ones pages name.
  const pagesByDomain = new Map<string, Page[]>();
  for (const p of pages) {
    if (readStructureMeta(p.fm)) continue;
    const list = pagesByDomain.get(p.fm.domain) ?? [];
    list.push(p);
    pagesByDomain.set(p.fm.domain, list);
  }
  const configured = options.domains ?? [];
  const domainList: DomainSetting[] = configured.length > 0
    ? configured.filter((d) => (pagesByDomain.get(d.name)?.length ?? 0) > 0)
    : [...pagesByDomain.entries()].filter(([, ps]) => ps.length >= 3).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).slice(0, 24).map(([name]) => ({ name, owner: "unassigned" }));
  stats.domainsEmpty = configured.filter((d) => (pagesByDomain.get(d.name)?.length ?? 0) === 0).map((d) => d.name);
  const domainHubPath = new Map<string, string>();
  const domainHubDrafts: Array<{ domain: DomainSetting; path: string; prior: Page | null; title: string }> = [];
  for (const d of domainList) {
    const title = `${domainLabel(d.name)} — domain hub`;
    const place = placeFor({ kind: "domain-hub", domain: d.name }, title);
    domainHubPath.set(d.name, place.path);
    domainHubDrafts.push({ domain: d, title, ...place });
  }
  const rootTitle = company ?? "Company overview";
  const rootPlace = domainHubDrafts.length > 0 || hubs.length > 0 ? placeFor({ kind: "root" }, rootTitle) : null;

  // 3. decisions
  interface Decision {
    date: string | null;
    title: string;
    decider: string | null;
    source: string | null;
    page: string;
    domain: string;
  }
  const decisions: Decision[] = [];
  const decidedBy = (o: Record<string, unknown>): string | null => {
    for (const k of ["decider", "decided_by", "decision_by"]) if (typeof o[k] === "string" && (o[k] as string).trim() !== "") return (o[k] as string).trim();
    return null;
  };
  for (const p of pages) {
    if (readStructureMeta(p.fm)) continue;
    const fm = p.fm as PageFrontmatter & Record<string, unknown>;
    const pageDate = dayOf(fm.date) ?? dayOf(fm.decided_at) ?? dayOf(fm.decided) ?? ([...titleIdentifiers(fm.title).date].sort()[0] ?? null);
    const pageDecider = decidedBy(fm) ?? (fm.owner && fm.owner !== "unassigned" ? fm.owner : null);
    if (fm.type === "decision") {
      const claimDate = fm.claims.map((c) => dayOf(c.as_of) ?? dayOf(c.valid_from)).find((d) => !!d) ?? null;
      decisions.push({ date: pageDate ?? claimDate ?? dayOf(fm.generated?.at), title: fm.title, decider: pageDecider, source: fm.sources[0] ?? null, page: p.path, domain: fm.domain });
      continue;
    }
    for (const c of fm.claims) {
      if (c.type !== "decision" && c.kind !== "decision") continue;
      const cr = c as Claim & Record<string, unknown>;
      const ev = c.evidence[0];
      decisions.push({
        date: dayOf(cr.date) ?? dayOf(cr.decided_at) ?? dayOf(c.as_of) ?? dayOf(c.valid_from) ?? pageDate,
        title: c.text,
        decider: decidedBy(cr) ?? pageDecider,
        source: (typeof ev?.path === "string" ? ev.path : typeof ev?.sourceId === "string" ? ev.sourceId : null) ?? fm.sources[0] ?? null,
        page: p.path,
        domain: fm.domain,
      });
    }
  }
  decisions.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.title.localeCompare(b.title) || a.page.localeCompare(b.page));
  stats.decisions = decisions.length;
  const registerTitle = "Decisions register";
  const registerPlace = decisions.length > 0 ? placeFor({ kind: "decisions" }, registerTitle) : null;

  // Inbound links for the top entities, over the vault WITHOUT what this pass wrote (its pages, a leaf's link
  // block): a re-run counts what the first run counted, so it plans the same pages.
  const structurePaths = new Set(pages.filter((p) => readStructureMeta(p.fm)).map((p) => p.path));
  const graphBase = buildLinkGraph(pages.filter((p) => !structurePaths.has(p.path)).map((p) => ({ path: p.path, title: p.fm.title, body: stripRecordBlock(p.body) })), null);
  const linkingTo = (path: string) => [...(graphBase.inbound.get(path) ?? [])].filter((x) => x !== path);
  const inboundOf = (path: string) => linkingTo(path).filter(isContentPage).length;
  const entities = pages.filter((p) => isEntity(p) && !readStructureMeta(p.fm)).map((p) => ({ page: p, inbound: inboundOf(p.path) }));
  entities.sort((a, b) => b.inbound - a.inbound || a.page.path.localeCompare(b.page.path));

  // ── write the record hubs ──
  const seriesOf = new Map<string, string[]>();
  for (const [key, hub] of monthHub) {
    const type = key.split("|")[0];
    const list = seriesOf.get(type) ?? [];
    list.push(hub.path);
    seriesOf.set(type, list);
  }
  for (const list of seriesOf.values()) list.sort((a, b) => (hubByPath.get(a)?.meta.month ?? "").localeCompare(hubByPath.get(b)?.meta.month ?? ""));
  const counterpartyHubsOf = (type: RecordType, month: string) => hubs.filter((h) => h.meta.type === type && h.meta.month === month && h.meta.counterparty && (h.meta.part ?? 1) === 1);
  for (const h of hubs) {
    const type = h.meta.type!;
    const month = h.meta.month!;
    const label = RECORD_LABELS[type];
    const lower = label.many.toLowerCase();
    const isMonth = !h.meta.counterparty && (h.meta.part ?? 1) === 1;
    const scope = isMonth ? h.group : h.meta.counterparty ? h.group.filter((l) => l.info.counterparty === h.meta.counterparty) : h.leaves;
    const totals = totalsByCurrency(scope.map((l) => l.info.amount));
    const missing = scope.filter((l) => !l.info.amount).length;
    const lines: string[] = [];
    const tt = totalsText(totals);
    if ((h.meta.part ?? 1) > 1) {
      lines.push(cell(`${h.title}: ${plural(h.leaves.length, label.one, lower)} more of ${month}${h.meta.counterparty ? ` with ${h.meta.counterparty}` : ""}; the totals are on the first part.`, 290));
    } else {
      lines.push(cell(`${h.title}: ${plural(scope.length, label.one, lower)}${h.meta.counterparty ? ` with ${h.meta.counterparty}` : ""}${tt ? `, ${tt} in total` : ""}.`, 290));
    }
    if ((h.meta.part ?? 1) === 1 && totals.length > 0) {
      lines.push("", "## Totals", "", "| Currency | Total | Records |", "| --- | ---: | ---: |", ...totals.map((t) => `| ${t.currency} | ${formatAmount(t.total)} | ${t.count} |`));
      if (missing > 0) lines.push("", `${plural(missing, label.one, lower)} carry no amount this pass could read.`);
    }
    if (isMonth) {
      const sub = counterpartyHubsOf(type, month);
      const subOf = new Map(sub.map((s) => [s.meta.counterparty!, s]));
      const counts = new Map<string, Leaf[]>();
      for (const l of h.group) if (l.info.counterparty) counts.set(l.info.counterparty, [...(counts.get(l.info.counterparty) ?? []), l]);
      if (counts.size > 1 || sub.length > 0) {
        const ranked = [...counts.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).slice(0, 10);
        lines.push("", "## By counterparty", "", "| Counterparty | Records | Total |", "| --- | ---: | --- |");
        for (const [name, ls] of ranked) {
          const s = subOf.get(name);
          lines.push(`| ${s ? mdLink(h.path, s.path, name, 40) : cell(name, 40)} | ${ls.length} | ${totalsText(totalsByCurrency(ls.map((l) => l.info.amount))) || "—"} |`);
        }
      }
    }
    if (h.leaves.length > 0) {
      lines.push("", `## ${label.many}`, "", "| Date | Record | Counterparty | Amount |", "| --- | --- | --- | ---: |", ...leafRows(h.path, h.leaves).rows);
    }
    const see: string[] = [];
    if (!isMonth) {
      const up = monthHub.get(`${type}|${month}`);
      if (up && up.path !== h.path) see.push(wikiLine(up.path, up.title, " (the month)"));
    }
    if (h.siblings.length > 1) for (const s of h.siblings) if (s !== h.path) see.push(wikiLine(s, titleOfHub(s)));
    if (isMonth) {
      const series = seriesOf.get(type) ?? [];
      const at = series.indexOf(h.path);
      if (at > 0) see.push(wikiLine(series[at - 1], titleOfHub(series[at - 1]), " (previous month)"));
      if (at >= 0 && at < series.length - 1) see.push(wikiLine(series[at + 1], titleOfHub(series[at + 1]), " (next month)"));
      const dh = domainHubPath.get(h.domain);
      if (dh) see.push(wikiLine(dh, `${domainLabel(h.domain)} — domain hub`));
    }
    if (see.length > 0) lines.push("", "## See also", "", ...see);
    const fm = ourFrontmatter(h.prior, {
      type: "synthesis",
      title: h.title,
      domain: h.domain,
      owner: h.owner,
      sources: rollupSources(scope.length > 0 ? scope.map((l) => l.page) : h.leaves.map((l) => l.page), 20),
      privacy: strictestPrivacy((isMonth ? h.group : h.leaves).map((l) => l.page)),
      structure: { ...h.meta, leaves: h.leaves.length },
    });
    setOurPage(h.path, h.prior, fm, lines.join("\n"));
  }
  function titleOfHub(path: string): string {
    return hubByPath.get(path)?.title ?? titleOf(path);
  }

  // ── the leaves: frontmatter `record`, the link up, the counterparty and the neighbours in the hub ──
  const entityByName = new Map<string, string>();
  for (const e of entities) for (const n of [e.page.fm.title, ...stringList(e.page.fm.aliases)]) if (normName(n).length >= 3 && !entityByName.has(normName(n))) entityByName.set(normName(n), e.page.path);
  const neighbours = new Map<string, { prev: Leaf | null; next: Leaf | null }>();
  for (const h of hubs) {
    if ((h.meta.part ?? 1) !== 1) continue;
    // One list across its parts, in date order.
    const list = h.siblings.flatMap((s) => hubByPath.get(s)?.leaves ?? []);
    list.forEach((l, i) => neighbours.set(l.page.path, { prev: list[i - 1] ?? null, next: list[i + 1] ?? null }));
  }
  for (const l of leaves) {
    const hub = hubOfLeaf.get(l.page.path) ?? null;
    const record = { type: l.info.type, month: l.info.month, ...(hub ? { hub: hub.path } : {}), by: l.info.by };
    const lines: string[] = [];
    if (hub) {
      lines.push(`- Filed under [[${hub.path.replace(/\.md$/, "")}]] — ${cell(hub.title, 80)}`);
      const party = l.info.counterparty ? entityByName.get(normName(l.info.counterparty)) : undefined;
      if (party && party !== l.page.path) lines.push(`- Counterparty: [[${party.replace(/\.md$/, "")}]] — ${cell(titleOf(party), 80)}`);
      const near = neighbours.get(l.page.path);
      if (near?.prev) lines.push(`- Previous: [[${near.prev.page.path.replace(/\.md$/, "")}]] — ${cell(near.prev.page.fm.title, 80)}`);
      if (near?.next) lines.push(`- Next: [[${near.next.page.path.replace(/\.md$/, "")}]] — ${cell(near.next.page.fm.title, 80)}`);
    }
    const body = upsertBlock(l.page.body, RECORD_START, RECORD_END, lines.join("\n"));
    const fm: PageFrontmatter = { ...l.page.fm, record };
    next.set(l.page.path, { fm, body, created: false });
  }
  // A page an earlier run filed as a record that the rules no longer call one: its record and link come off.
  const leafSet = new Set(leaves.map((l) => l.page.path));
  for (const p of pages) {
    if (leafSet.has(p.path)) continue;
    const r = readRecordFrontmatter(p.fm);
    if (!r || r.by !== "rules") continue;
    const fm: PageFrontmatter = { ...p.fm };
    delete fm.record;
    next.set(p.path, { fm, body: upsertBlock(p.body, RECORD_START, RECORD_END, ""), created: false });
  }

  // ── entity enrichment ──
  const claimIndex = new Map<string, string>();
  for (const p of pages) for (const c of p.fm.claims) if (!claimIndex.has(c.id)) claimIndex.set(c.id, p.path);
  const retired = new Set<string>(options.ledgerRetired ?? []);
  for (const p of pages) for (const id of p.fm.retiredClaimIds) retired.add(id);
  const leafByPath = new Map(leaves.map((l) => [l.page.path, l]));
  const top = entities.filter((e) => e.inbound > 0 && !isVerifiedPage(e.page.fm)).slice(0, Math.max(0, options.enrichTop ?? DEFAULT_ENRICH_TOP));
  const entityPaths = new Set(entities.map((e) => e.page.path));
  for (const { page: ent } of top) {
    const names = new Set([ent.fm.title, ...stringList(ent.fm.aliases)].map(normName).filter((n) => n.length >= 3));
    const linking = linkingTo(ent.path);
    const recs = new Map<string, Leaf>();
    for (const x of linking) {
      const l = leafByPath.get(x);
      if (l) recs.set(x, l);
    }
    for (const l of leaves) if (l.info.counterparty && names.has(normName(l.info.counterparty))) recs.set(l.page.path, l);
    const records = [...recs.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    const name = cell(ent.fm.title, 80);
    const facts: Array<{ fact: string; text: string; asOf?: string }> = [];
    if (records.length > 0) {
      const byType = new Map<RecordType, number>();
      for (const r of records) byType.set(r.info.type, (byType.get(r.info.type) ?? 0) + 1);
      const parts = [...byType.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t, n]) => plural(n, RECORD_LABELS[t].one, RECORD_LABELS[t].many.toLowerCase()));
      facts.push({ fact: "structure-role", text: `${name} is the counterparty on ${plural(records.length, "record", "records")} in this wiki: ${parts.join(", ")}.` });
    } else {
      const domains = mostCommon(linking.map((x) => byPath.get(x)?.fm.domain ?? "").filter(Boolean));
      facts.push({ fact: "structure-role", text: `${name} is linked from ${plural(linking.length, "page", "pages")} in this wiki${domains ? `, most of them in the ${domains} domain` : ""}.` });
    }
    // Who it appears with: other entities the same pages link to.
    const co = new Map<string, number>();
    for (const x of linking) for (const t of graphBase.outbound.get(x) ?? []) if (t !== ent.path && entityPaths.has(t)) co.set(t, (co.get(t) ?? 0) + 1);
    const withWhom = [...co.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([t]) => cell(titleOf(t), 50));
    if (withWhom.length > 0) {
      const list = withWhom.length === 1 ? withWhom[0] : `${withWhom.slice(0, -1).join(", ")} and ${withWhom[withWhom.length - 1]}`;
      facts.push({ fact: "structure-counterparties", text: `${name} appears most often with ${list}.` });
    }
    const totals = totalsByCurrency(records.map((r) => r.info.amount));
    const days = records.map((r) => r.info.day).filter((d): d is string => !!d).sort();
    if (totals.length > 0) {
      const months = records.map((r) => r.info.month).sort();
      facts.push({
        fact: "structure-totals",
        text: `The records with ${name} total ${totalsText(totals)} (${months[0]} to ${months[months.length - 1]}).`,
        ...(days.length > 0 ? { asOf: days[days.length - 1] } : {}),
      });
    }
    const seen = days.length > 0 ? days : linking.flatMap((x) => [...titleIdentifiers(byPath.get(x)?.fm.title).date]).sort();
    if (seen.length > 0) {
      facts.push({ fact: "structure-first-seen", text: `${name} is first seen on ${seen[0]} in this wiki.` });
      facts.push({ fact: "structure-last-seen", text: `${name} is last seen on ${seen[seen.length - 1]} in this wiki.` });
    }
    // Ours from an earlier run are replaced; a person's claims (and one of ours a person verified) stay.
    const kept = ent.fm.claims.filter((c) => c.origin !== STRUCTURE_BY || ownerVerified(c, ent.fm) || !!c.verified);
    const keptIds = new Set(kept.map((c) => c.id));
    const room = Math.max(0, Math.min(ENRICH_MAX_CLAIMS, LIMITS.maxClaims - kept.length));
    const domain = ent.fm.domain;
    const entitySlug = slugify(ent.path.split("/").pop()!.replace(/\.md$/, ""));
    const previous = new Map(ent.fm.claims.filter((c) => c.origin === STRUCTURE_BY).map((c) => [c.id, c]));
    const added: Claim[] = [];
    for (const f of facts) {
      if (added.length >= room) break;
      const id = makeClaimId(domain, entitySlug, f.fact);
      if (!isClaimId(id) || keptIds.has(id) || retired.has(id)) continue;
      const elsewhere = claimIndex.get(id);
      if (elsewhere && elsewhere !== ent.path) continue;
      const text = f.text.length > LIMITS.claimMaxChars ? `${f.text.slice(0, LIMITS.claimMaxChars - 1).trimEnd()}…` : f.text;
      const before = previous.get(id);
      const claim: Claim = {
        id,
        text,
        confidence: 0.9,
        status: "supported",
        updatedAt: before && before.text === text ? before.updatedAt : now,
        evidence: [{ kind: "structure", note: `worked out from ${plural(Math.max(records.length, linking.length), "page", "pages")} linked with this one` }],
        origin: STRUCTURE_BY,
        ...(f.asOf ? { as_of: f.asOf } : {}),
      };
      added.push(claim);
    }
    const claims = [...kept, ...added];
    const changed = JSON.stringify(claims) !== JSON.stringify(ent.fm.claims);
    if (changed) {
      const cur = next.get(ent.path);
      next.set(ent.path, { fm: { ...(cur?.fm ?? ent.fm), claims }, body: cur?.body ?? ent.body, created: false });
      stats.entitiesEnriched++;
      stats.claimsAdded += added.filter((c) => !previous.has(c.id)).length;
    }
  }

  // ── domain hubs ──
  const reviewByPage = new Map<string, StructureReviewItem[]>();
  for (const item of options.reviewItems ?? []) for (const p of item.pages) reviewByPage.set(p, [...(reviewByPage.get(p) ?? []), item]);
  for (const dh of domainHubDrafts) {
    const name = dh.domain.name;
    const members = pagesByDomain.get(name) ?? [];
    const types = new Map<string, number>();
    for (const p of members) types.set(p.fm.type, (types.get(p.fm.type) ?? 0) + 1);
    // The pass's own enrichment claims are no evidence for a hub (and would change it on every re-run).
    const claimsAll = members.flatMap((p) => p.fm.claims.filter((c) => c.status !== "contested" && c.origin !== STRUCTURE_BY).map((c) => ({ c, p })));
    const verified = claimsAll.filter(({ c, p }) => ownerVerified(c, p.fm)).length;
    const domainLeaves = leaves.filter((l) => l.page.fm.domain === name);
    const months = domainLeaves.map((l) => l.info.month).sort();
    const lines: string[] = [];
    const range = months.length > 0 ? `, records from ${months[0]} to ${months[months.length - 1]}` : "";
    lines.push(cell(`The ${name} domain${dh.domain.owner !== "unassigned" ? `, owned by ${dh.domain.owner}` : ""}: ${plural(members.length, "page", "pages")} and ${plural(claimsAll.length, "fact", "facts")} (${verified} verified)${range}.`, 290));
    lines.push("", "## What it covers", "");
    for (const [t, n] of [...types.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) lines.push(`- ${plural(n, `${t} page`, `${t} pages`)}`);
    const recordTypes = new Map<RecordType, number>();
    for (const l of domainLeaves) recordTypes.set(l.info.type, (recordTypes.get(l.info.type) ?? 0) + 1);
    for (const [t, n] of [...recordTypes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) lines.push(`- ${plural(n, RECORD_LABELS[t].one, RECORD_LABELS[t].many.toLowerCase())} among them`);
    // Key facts: owner-verified first, then the most confident; never a record leaf's (those are in its hub).
    const facts = claimsAll
      .filter(({ p }) => !leafSet.has(p.path))
      .sort((a, b) => Number(ownerVerified(b.c, b.p.fm)) - Number(ownerVerified(a.c, a.p.fm)) || b.c.confidence - a.c.confidence || b.c.updatedAt.localeCompare(a.c.updatedAt) || a.c.id.localeCompare(b.c.id))
      .slice(0, DOMAIN_KEY_FACTS);
    if (facts.length > 0) {
      lines.push("", "## Key facts", "");
      for (const { c, p } of facts) lines.push(`- ${ownerVerified(c, p.fm) ? "✓ " : ""}${cell(c.text, 160)} — ${mdLink(dh.path, p.path, p.fm.title, 50)}`);
    }
    const open = members.flatMap((p) => (reviewByPage.get(p.path) ?? []).map((item) => ({ item, p })));
    const openIds = new Set(open.map((o) => o.item.id));
    lines.push("", "## Open review items", "");
    if (openIds.size === 0) lines.push("Nothing waits for a decision in this domain.");
    else {
      lines.push(`${plural(openIds.size, "item waits", "items wait")} in Review:`, "");
      const seenIds = new Set<string>();
      for (const { item, p } of open.sort((a, b) => a.item.id.localeCompare(b.item.id))) {
        if (seenIds.has(item.id) || seenIds.size >= DOMAIN_REVIEW_ITEMS) continue;
        seenIds.add(item.id);
        lines.push(`- ${item.kind}: ${mdLink(dh.path, p.path, p.fm.title, 60)}`);
      }
    }
    const topEntities = entities.filter((e) => e.page.fm.domain === name).slice(0, DOMAIN_TOP_ENTITIES);
    if (topEntities.length > 0) {
      lines.push("", "## Top entities", "");
      for (const e of topEntities) lines.push(wikiLine(e.page.path, e.page.fm.title, e.inbound > 0 ? ` (${plural(e.inbound, "link", "links")} in)` : ""));
    }
    const domainHubs = [...monthHub.values()].filter((h) => h.domain === name).sort((a, b) => (b.meta.month ?? "").localeCompare(a.meta.month ?? "") || a.title.localeCompare(b.title)).slice(0, DOMAIN_HUB_LINKS);
    const domainDecisions = decisions.filter((d) => d.domain === name).length;
    if (domainHubs.length > 0 || domainDecisions > 0 || rootPlace) {
      lines.push("", "## Hubs", "");
      for (const h of domainHubs) lines.push(wikiLine(h.path, h.title));
      if (registerPlace && domainDecisions > 0) lines.push(wikiLine(registerPlace.path, registerTitle, ` (${plural(domainDecisions, "decision", "decisions")} of this domain)`));
      if (rootPlace) lines.push(wikiLine(rootPlace.path, rootTitle, " (all domains)"));
    }
    const fm = ourFrontmatter(dh.prior, {
      type: "synthesis",
      title: dh.title,
      domain: name,
      owner: dh.domain.owner,
      sources: rollupSources(members, 20),
      privacy: strictestPrivacy(members),
      structure: { kind: "domain-hub", domain: name },
    });
    setOurPage(dh.path, dh.prior, fm, lines.join("\n"));
  }
  stats.domainHubs = domainHubDrafts.length;

  // ── the decisions register ──
  if (registerPlace) {
    const row = (from: string, d: Decision) => `| ${d.date ?? "—"} | ${mdLink(from, d.page, d.title, 70)} | ${cell(d.decider ?? "—", 40)} | ${cell(d.source ?? "—", 30)} |`;
    const header = ["| Date | Decision | Decided by | Source |", "| --- | --- | --- | --- |"];
    const decisionPages = decisions.map((d) => byPath.get(d.page)).filter((p): p is Page => !!p);
    const shown = decisions.slice(0, REGISTER_ROWS);
    const older = decisions.slice(REGISTER_ROWS);
    const years = new Map<string, Decision[]>();
    for (const d of older) {
      const y = d.date ? d.date.slice(0, 4) : "undated";
      years.set(y, [...(years.get(y) ?? []), d]);
    }
    const yearPages: Array<{ path: string; title: string }> = [];
    for (const y of [...years.keys()].sort().reverse()) {
      const list = years.get(y)!;
      const parts = Math.ceil(list.length / REGISTER_YEAR_ROWS);
      for (let part = 1; part <= parts; part++) {
        const slice = list.slice((part - 1) * REGISTER_YEAR_ROWS, part * REGISTER_YEAR_ROWS);
        const title = `${registerTitle} ${y === "undated" ? "(undated)" : y}${part > 1 ? ` (part ${part})` : ""}`;
        const meta: StructureMeta = { kind: "decisions", year: y, ...(part > 1 ? { part } : {}) };
        const place = placeFor(meta, title);
        yearPages.push({ path: place.path, title });
        const lines = [
          cell(`${title}: ${plural(slice.length, "decision", "decisions")}, newest first; the latest are on the register itself.`, 290),
          "",
          ...header,
          ...slice.map((d) => row(place.path, d)),
          "",
          "## See also",
          "",
          wikiLine(registerPlace.path, registerTitle),
        ];
        const pagesHere = slice.map((d) => byPath.get(d.page)).filter((p): p is Page => !!p);
        setOurPage(place.path, place.prior, ourFrontmatter(place.prior, { type: "synthesis", title, domain: GENERAL_DOMAIN, owner: "unassigned", sources: rollupSources(pagesHere, 20), privacy: strictestPrivacy(pagesHere), structure: meta }), lines.join("\n"));
      }
    }
    const lines = [
      cell(`${registerTitle}: ${plural(decisions.length, "decision", "decisions")} recorded in this wiki, newest first${decisions.length > REGISTER_ROWS ? `; the latest ${REGISTER_ROWS} here, older years on their own pages` : ""}.`, 290),
      "",
      ...header,
      ...shown.map((d) => row(registerPlace.path, d)),
    ];
    if (yearPages.length > 0) lines.push("", "## Earlier", "", ...yearPages.map((y) => wikiLine(y.path, y.title)));
    if (rootPlace) lines.push("", "## See also", "", wikiLine(rootPlace.path, rootTitle));
    setOurPage(
      registerPlace.path,
      registerPlace.prior,
      ourFrontmatter(registerPlace.prior, { type: "synthesis", title: registerTitle, domain: GENERAL_DOMAIN, owner: "unassigned", sources: rollupSources(decisionPages, 20), privacy: strictestPrivacy(decisionPages), structure: { kind: "decisions" } }),
      lines.join("\n"),
    );
    stats.registerPages = 1 + yearPages.length;
  }

  // ── the root ──
  if (rootPlace) {
    const contentPages = pages.filter((p) => !readStructureMeta(p.fm));
    const lines: string[] = [cell(`${rootTitle}: the top of this wiki — ${plural(contentPages.length, "page", "pages")} across ${plural(domainHubDrafts.length, "domain", "domains")}${hubs.length > 0 ? `, ${plural(leaves.length, "record", "records")} in monthly hubs` : ""}.`, 290)];
    if (domainHubDrafts.length > 0) {
      lines.push("", "## Domains", "");
      for (const dh of domainHubDrafts) lines.push(wikiLine(dh.path, dh.title, dh.domain.owner !== "unassigned" ? ` (owner: ${cell(dh.domain.owner, 40)})` : ""));
    }
    const latest = new Map<RecordType, HubDraft[]>();
    for (const h of monthHub.values()) latest.set(h.meta.type!, [...(latest.get(h.meta.type!) ?? []), h]);
    if (latest.size > 0) {
      lines.push("", "## Records", "");
      for (const t of RECORD_TYPES) {
        const list = (latest.get(t) ?? []).sort((a, b) => (b.meta.month ?? "").localeCompare(a.meta.month ?? ""));
        if (list.length === 0) continue;
        lines.push(wikiLine(list[0].path, list[0].title, ` (latest of ${plural(list.length, "month", "months")})`));
      }
    }
    if (registerPlace) {
      lines.push("", "## Decisions", "", wikiLine(registerPlace.path, registerTitle, ` (${plural(decisions.length, "decision", "decisions")})`));
      for (const d of decisions.slice(0, 5)) lines.push(`- ${d.date ?? "undated"}: ${mdLink(rootPlace.path, d.page, d.title, 90)}`);
    }
    const topAll = entities.filter((e) => e.inbound > 0).slice(0, 10);
    if (topAll.length > 0) {
      lines.push("", "## Top entities", "");
      for (const e of topAll) lines.push(wikiLine(e.page.path, e.page.fm.title, ` (${plural(e.inbound, "link", "links")} in)`));
    }
    const rolled = domainHubDrafts.flatMap((d) => pagesByDomain.get(d.domain.name) ?? []);
    const fm = ourFrontmatter(rootPlace.prior, {
      type: "synthesis",
      title: rootTitle,
      domain: GENERAL_DOMAIN,
      owner: "unassigned",
      sources: rollupSources(rolled.length > 0 ? rolled : leaves.map((l) => l.page), 20),
      privacy: "internal",
      structure: { kind: "root" },
    });
    setOurPage(rootPlace.path, rootPlace.prior, fm, lines.join("\n"));
    stats.root = true;
  }

  // ── what differs is written; a verified page never is ──
  const writes: PlannedWrite[] = [];
  for (const [path, want] of [...next.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const original = byPath.get(path);
    if (original && isVerifiedPage(original.fm)) {
      if (original.body.trim() !== want.body.trim() || JSON.stringify(original.fm) !== JSON.stringify(want.fm)) stats.skippedVerified++;
      next.set(path, { fm: original.fm, body: original.body, created: false });
      continue;
    }
    if (original && original.body.trim() === want.body.trim() && JSON.stringify(original.fm) === JSON.stringify(want.fm)) continue;
    writes.push({ path, frontmatter: want.fm, body: want.body, created: !original, expected: original?.text ?? null });
  }

  const after = buildLinkGraph(
    [
      ...pages.filter((p) => !next.has(p.path)).map((p) => ({ path: p.path, title: p.fm.title, body: p.body })),
      ...[...next.entries()].map(([path, v]) => ({ path, title: v.fm.title, body: v.body })),
    ],
    null,
  );
  stats.linksMedianAfter = linkDensity(after).median;
  return { writes, stats };
}

// ── the run ───────────────────────────────────────────────────────────────

export interface StructureRunResult extends StructureStats {
  written: number;
  created: number;
  commits: string[];
  dryRun: boolean;
  /** The pages a dry run would write (at most 200), new ones first. */
  would?: Array<{ path: string; title: string; created: boolean }>;
}

/**
 * Write a plan: new pages (and their index.md lines) first, so no commit
 * leaves a new page unlisted, then the rest in commits of {@link STRUCTURE_BATCH}.
 * A page edited since the plan was made is left as the person left it.
 */
export async function runStructurePass(
  snapshot: Pick<VaultSnapshot, "pages" | "indexBody">,
  run: (message: string, fn: (tx: VaultTx) => Promise<void>) => Promise<{ commit: string | null }>,
  options: StructureOptions & { dryRun?: boolean } = {},
): Promise<StructureRunResult> {
  const plan = planStructure(snapshot, options);
  const created = plan.writes.filter((w) => w.created);
  const ordered = [...created, ...plan.writes.filter((w) => !w.created)];
  const result: StructureRunResult = { ...plan.stats, written: plan.writes.length, created: created.length, commits: [], dryRun: !!options.dryRun };
  if (options.dryRun) {
    result.would = ordered.slice(0, 200).map((w) => ({ path: w.path, title: w.frontmatter.title, created: w.created }));
    return result;
  }
  const indexBody = created.length > 0 ? addToIndex(snapshot.indexBody, created.map((c) => ({ path: c.path, title: c.frontmatter.title }))) : null;
  for (let at = 0; at < ordered.length; at += STRUCTURE_BATCH) {
    const batch = ordered.slice(at, at + STRUCTURE_BATCH);
    const { commit } = await run(`structure: record hubs, domain hubs, root, entities and decisions (${at + 1}-${at + batch.length} of ${ordered.length})`, async (tx) => {
      if (at === 0 && indexBody !== null) await tx.write("index.md", indexBody);
      for (const w of batch) {
        const current = await tx.read(w.path);
        if ((current?.text ?? null) !== w.expected) continue;
        await tx.writePage(w.path, w.frontmatter, w.body);
      }
    });
    if (commit) result.commits.push(commit);
  }
  return result;
}
