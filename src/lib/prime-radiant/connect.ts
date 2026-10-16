/**
 * The connect pass: turns a vault of islands (one page per document, about
 * one link a page) into a wiki whose pages point at each other.
 *
 * Deterministic, no model call. Over the whole vault it:
 *  1. links every page to the ENTITY pages (people, companies, products,
 *     projects) it names — an existing entity page by its title or aliases,
 *     and a new one, created here, for a name that recurs across many pages
 *     (a company with a legal suffix, a multi-word proper name, a CamelCase
 *     product name) and has no page yet;
 *  2. links each page to its nearest pages by embedding (top-k above a
 *     threshold, from the vault's search index) and to the pages sharing its
 *     rarest entities;
 *  3. rolls the one-page-per-thing leaves (a shipment, a bank transfer, an
 *     invoice, a daily report — told by a kind word and an identifier or date
 *     in the title) up into dated HUB pages ("Courier shipments 2026-09"), with
 *     links hub → leaves, leaf → hub and neighbouring leaves, and hub → the
 *     previous and next month's hub. Hubs are `synthesis` pages; search ranks
 *     them above leaves.
 *
 * Every link the pass writes lives in one managed block at the end of the
 * page body, replaced whole on every run (never hand-edited text):
 *   <!-- prime-radiant:related:start --> … <!-- prime-radiant:related:end -->
 * The block is sized to keep the page under lint's caps. A verified page is
 * never rewritten.
 *
 * {@link planConnections} is pure; {@link runConnectPass} writes the plan in
 * commits of {@link CONNECT_BATCH} pages.
 *
 * SERVER ONLY (the run).
 */

import { slugify } from "./claims";
import { titleIdentifiers } from "./identifiers";
import { buildLinkGraph } from "./links";
import { ATOMIC_TYPES, LIMITS } from "./lint";
import type { PageFrontmatter, PrivacyTier } from "./schema";
import type { VaultSnapshot, VaultTx } from "./vault";
import { addToIndex } from "./writer";

export const RELATED_START = "<!-- prime-radiant:related:start -->";
export const RELATED_END = "<!-- prime-radiant:related:end -->";
const BLOCK_RE = /\n*<!-- prime-radiant:related:start -->[\s\S]*?<!-- prime-radiant:related:end -->[ \t]*\n?/g;

/** Embedding neighbours a page links to, at most. */
export const RELATED_K = 5;
/** The cosine similarity a neighbour needs (vectors cut to {@link RELATED_DIMS}). */
export const RELATED_MIN_SIMILARITY = 0.6;
/** The leading dimensions the neighbour search compares (Matryoshka; plenty to rank neighbours). */
export const RELATED_DIMS = 256;
/** Pages sharing a rare entity a page links to, at most. */
export const SHARED_ENTITY_K = 3;
/** An entity named on more pages than this is too common to tie two pages by. */
export const SHARED_ENTITY_MAX_DF = 150;
/** Distinct pages a name must appear on before the pass creates an entity page for it. */
export const MIN_ENTITY_PAGES = 6;
/** New entity pages one pass creates, at most. */
export const MAX_NEW_ENTITIES = 300;
/** Leaves a hub needs. */
export const MIN_HUB_LEAVES = 3;
/** Leaves one hub page lists; a bigger month is split into parts. */
export const HUB_MAX_LEAVES = 50;
/** Pages one commit of the pass writes. */
export const CONNECT_BATCH = 400;

const BLOCK_BUDGET_SLACK = 200;

// ── names ─────────────────────────────────────────────────────────────────

const ORG_SUFFIX = "(?:Ltd|Limited|GmbH|Inc|LLC|OOD|EOOD|AD|Corp|AG|SA|BV|SRL|PLC|Oy|AB|ApS)";
const ORG_RE = new RegExp(`\\b((?:[A-Z][\\w&'-]*\\s+){0,3}[A-Z][\\w&'-]*\\s+${ORG_SUFFIX})\\b\\.?`, "g");
const PROPER_RE = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)*(?:\s+[A-Z][a-z]+(?:[A-Z][a-z]+)*){1,3})\b/g;
const CAMEL_RE = /\b([A-Z][a-z]+[A-Z][A-Za-z]*|[A-Z]{2,}[a-z]+[A-Za-z]*)\b/g;

const NAME_STOP: ReadonlySet<string> = new Set(
  (
    "The A An This That These Those In On At For From To By With And Or But If When While After Before Key Facts Fact Details Sources Source " +
    "Related Summary Total Daily Weekly Monthly Report Notes Note Page Pages Section Overview Status Task Tasks Step Steps Yes No New Old Next Last " +
    "January February March April May June July August September October November December Jan Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec " +
    "Monday Tuesday Wednesday Thursday Friday Saturday Sunday Today Yesterday Tomorrow Mr Mrs Ms Dr Please Thanks Hello Dear Subject Re Fwd " +
    "It Its We Our They Their He She His Her You Your All Any Each Every Some Other Such Only Also Then There Here Where What Which Who How Why"
  ).split(" "),
);

function cleanName(raw: string): string | null {
  const words = raw.trim().split(/\s+/);
  while (words.length > 0 && NAME_STOP.has(words[0])) words.shift();
  while (words.length > 0 && NAME_STOP.has(words[words.length - 1])) words.pop();
  if (words.length === 0) return null;
  const name = words.join(" ");
  if (name.length < 3 || name.length > 60 || /^\d/.test(name)) return null;
  // One plain capitalised word ("Delivered") is no name; a CamelCase word or an acronym-led one is.
  if (words.length === 1 && !/[a-z][A-Z]|^[A-Z]{2,}[a-z]/.test(name)) return null;
  return name;
}

/** Candidate entity names in a text: companies with a legal suffix, multi-word proper names, CamelCase names. */
export function candidateNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const re of [ORG_RE, PROPER_RE, CAMEL_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const name = cleanName(m[1]);
      if (name) out.add(name);
    }
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `text` names `name` as a whole word, as written. */
function names(text: string, name: string): boolean {
  if (!text.includes(name)) return false;
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(name)}(?![\\p{L}\\p{N}])`, "u").test(text);
}

// ── leaves and hubs ───────────────────────────────────────────────────────

export type LeafKind = "shipments" | "transactions" | "invoices" | "daily-reports";

const LEAF_KINDS: ReadonlyArray<[LeafKind, RegExp]> = [
  ["invoices", /\b(invoice|proforma|credit note|receipt)\b/i],
  ["transactions", /\b(bank transfer|transfer|payment|transaction|remittance)\b/i],
  ["shipments", /\b(waybill|parcel|shipment|shipping label|shipping|tracking|consignment|courier|delivery)\b/i],
  ["daily-reports", /\b(daily|day|digest|standup|stand-up|report|log|summary)\b/i],
];

const KIND_LABEL: Readonly<Record<LeafKind, string>> = {
  shipments: "shipments",
  transactions: "transactions",
  invoices: "invoices",
  "daily-reports": "daily reports",
};

export interface LeafInfo {
  kind: LeafKind;
  /** The brand / carrier / bank the title leads with, when it does. */
  qualifier: string | null;
  /** YYYY-MM */
  month: string;
  /** For ordering inside a hub: the day when known, else the month. */
  sortKey: string;
}

const KIND_WORDS = /^(invoice|proforma|credit|receipt|bank|transfer|payment|transaction|remittance|waybill|parcel|shipment|shipping|tracking|consignment|courier|delivery|daily|day|digest|standup|report|log|summary|sales)$/i;

/** Whether a page is a one-of-many leaf, and of what. Needs a kind word AND an identifier or a date in the title. */
export function leafInfo(title: string, claimTexts: readonly string[] = []): LeafInfo | null {
  const kind = LEAF_KINDS.find(([, re]) => re.test(title))?.[0];
  if (!kind) return null;
  const ids = titleIdentifiers(title);
  const day = [...ids.date].sort()[0] ?? null;
  let month = day ? day.slice(0, 7) : ([...ids.month].sort()[0] ?? null);
  if (kind === "daily-reports" && !day) return null;
  if (!day && !month && ids.ref.size === 0) return null;
  if (!month) {
    // A waybill or invoice number in the title, the date in its facts.
    for (const t of claimTexts) {
      const m = /\b(20\d{2})-(\d{2})-\d{2}\b|\b\d{1,2}\.(\d{1,2})\.(20\d{2})\b/.exec(t);
      if (m) {
        month = m[1] ? `${m[1]}-${m[2]}` : `${m[4]}-${m[3].padStart(2, "0")}`;
        break;
      }
    }
  }
  if (!month) return null;
  const first = title.trim().split(/\s+/)[0]?.replace(/[^\p{L}\p{N}&-]/gu, "") ?? "";
  const qualifier = /^\p{Lu}/u.test(first) && !KIND_WORDS.test(first) && !NAME_STOP.has(first) && !/\d/.test(first) ? first : null;
  return { kind, qualifier, month, sortKey: day ?? month };
}

function hubTitle(info: Pick<LeafInfo, "kind" | "qualifier" | "month">, part: number): string {
  const label = KIND_LABEL[info.kind];
  const head = info.qualifier ? `${info.qualifier} ${label}` : label.charAt(0).toUpperCase() + label.slice(1);
  return `${head} ${info.month}${part > 1 ? ` (part ${part})` : ""}`;
}

// ── the plan ──────────────────────────────────────────────────────────────

export interface ConnectPage {
  path: string;
  fm: PageFrontmatter;
  /** The body without the managed block. */
  body: string;
}

export interface PlannedWrite {
  path: string;
  frontmatter: PageFrontmatter;
  body: string;
  created: boolean;
}

export interface ConnectStats {
  pages: number;
  entitiesExisting: number;
  entitiesCreated: number;
  hubs: number;
  leaves: number;
  pagesWithEmbeddings: number;
  /** Links a page has after the pass (either way, distinct), median and mean. */
  linksMedian: number;
  linksMean: number;
  linksMedianBefore: number;
  orphansAfter: number;
}

export interface ConnectPlan {
  writes: PlannedWrite[];
  stats: ConnectStats;
}

export interface ConnectOptions {
  now?: Date;
  /** Page vectors (unit length) by path, from the search index; absent pages get no embedding links. */
  vectors?: ReadonlyMap<string, Float32Array>;
  minSimilarity?: number;
}

/** A body without the pass's managed block. */
export function stripRelatedBlock(body: string): string {
  return body.replace(BLOCK_RE, "\n").replace(/\n{3,}$/g, "\n\n").replace(/\s+$/, "") + "\n";
}

function linkLine(path: string, title: string): string {
  const t = title.replace(/[\r\n]+/g, " ").replace(/\]\]/g, "] ]").slice(0, 80);
  return `- [[${path.replace(/\.md$/, "")}]] — ${t}`;
}

interface Section {
  heading: string;
  targets: string[];
  /** Links only, no titles (a hub's long list). */
  bare?: boolean;
}

/** The managed block for `sections`, as many lines as fit in `budget` characters. */
export function renderBlock(sections: readonly Section[], titleOf: (p: string) => string, budget: number): string {
  const lines: string[] = [];
  let used = RELATED_START.length + RELATED_END.length + 16;
  const seen = new Set<string>();
  for (const s of sections) {
    const own: string[] = [];
    for (const t of s.targets) {
      if (seen.has(t)) continue;
      const line = s.bare ? `- [[${t.replace(/\.md$/, "")}]]` : linkLine(t, titleOf(t));
      const cost = line.length + 1 + (own.length === 0 ? s.heading.length + 6 : 0);
      if (used + cost > budget) break;
      used += cost;
      own.push(line);
      seen.add(t);
    }
    if (own.length > 0) lines.push(`### ${s.heading}`, "", ...own, "");
  }
  if (lines.length === 0) return "";
  return [RELATED_START, "## Related", "", ...lines, RELATED_END].join("\n");
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function linkCounts(pages: ReadonlyArray<{ path: string; title?: string; body: string }>, indexBody: string | null): { counts: number[]; orphans: number } {
  const g = buildLinkGraph(pages, indexBody);
  const counts: number[] = [];
  let orphans = 0;
  for (const p of pages) {
    const set = new Set<string>([...(g.outbound.get(p.path) ?? []), ...(g.inbound.get(p.path) ?? [])]);
    set.delete(p.path);
    counts.push(set.size);
    if ((g.inbound.get(p.path)?.size ?? 0) === 0 && !g.indexed.has(p.path)) orphans++;
  }
  return { counts, orphans };
}

function cut(vec: Float32Array, dims: number): Float32Array {
  const out = vec.length > dims ? vec.slice(0, dims) : vec.slice();
  let n = 0;
  for (let i = 0; i < out.length; i++) n += out[i] * out[i];
  const norm = Math.sqrt(n) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

const PRIVACY_ORDER: readonly PrivacyTier[] = ["public", "internal", "confidential", "secret-ref"];

function mostCommon<T>(xs: readonly T[]): T | null {
  const c = new Map<T, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  let best: T | null = null;
  let n = 0;
  for (const [x, k] of c) if (k > n) [best, n] = [x, k];
  return best;
}

function topSources(members: readonly ConnectPage[], max: number): string[] {
  const c = new Map<string, number>();
  for (const m of members) for (const s of m.fm.sources) c.set(s, (c.get(s) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([s]) => s);
}

function strictestPrivacy(members: readonly ConnectPage[]): PrivacyTier {
  let at = 1;
  for (const m of members) at = Math.max(at, Math.min(2, PRIVACY_ORDER.indexOf(m.fm.privacy)));
  return PRIVACY_ORDER[at];
}

function uniquePath(folder: string, title: string, taken: Set<string>): string {
  const base = slugify(title, 80);
  let p = `${folder}/${base}.md`;
  for (let n = 2; taken.has(p) && n < 10_000; n++) p = `${folder}/${base}-${n}.md`;
  taken.add(p);
  return p;
}

function textOf(p: ConnectPage): string {
  return [p.fm.title, p.body, ...p.fm.claims.map((c) => c.text)].join("\n");
}

function stringList(v: unknown): string[] {
  if (typeof v === "string") return [v];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Plan the pass over `snapshot`. Pure. */
export function planConnections(snapshot: Pick<VaultSnapshot, "pages" | "indexBody">, options: ConnectOptions = {}): ConnectPlan {
  const now = (options.now ?? new Date()).toISOString();
  const minSim = options.minSimilarity ?? RELATED_MIN_SIMILARITY;
  const pages: ConnectPage[] = snapshot.pages.flatMap((p) => (p.parsed.ok ? [{ path: p.path, fm: p.parsed.frontmatter, body: stripRelatedBlock(p.parsed.body) }] : []));
  const taken = new Set(snapshot.pages.map((p) => p.path));
  const byPath = new Map(pages.map((p) => [p.path, p]));
  const originals = new Map(snapshot.pages.map((p) => [p.path, p]));
  const before = linkCounts(
    snapshot.pages.map((p) => ({ path: p.path, title: p.parsed.ok ? p.parsed.frontmatter.title : undefined, body: p.parsed.body })),
    snapshot.indexBody,
  );

  // Pages this pass made on an earlier run are rebuilt from scratch: their own text is no evidence.
  const isOurs = (p: ConnectPage) => p.fm.generated?.by === "connect";
  const content = pages.filter((p) => !isOurs(p));

  // 1. entities: the existing pages by name, then names that recur without one.
  const entityByName = new Map<string, string>();
  for (const p of pages) {
    if ((p.fm.type !== "entity" && !p.path.startsWith("entities/")) || p.fm.generated?.by === "connect") continue;
    for (const n of [p.fm.title, ...stringList(p.fm.aliases)]) {
      const name = n.trim();
      if (name.length >= 3 && !entityByName.has(name)) entityByName.set(name, p.path);
    }
  }
  const existingEntities = new Set(entityByName.values()).size;
  const df = new Map<string, Set<string>>();
  for (const p of content) {
    for (const name of candidateNames([p.fm.title, ...p.fm.claims.map((c) => c.text)].join("\n"))) {
      if (entityByName.has(name)) continue;
      const s = df.get(name) ?? new Set<string>();
      s.add(p.path);
      df.set(name, s);
    }
  }
  const lowerTaken = new Set([...entityByName.keys()].map((n) => n.toLowerCase()));
  const fresh = [...df.entries()]
    .filter(([name, s]) => s.size >= MIN_ENTITY_PAGES && !lowerTaken.has(name.toLowerCase()))
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
    .slice(0, MAX_NEW_ENTITIES);
  const created: PlannedWrite[] = [];
  const newPages: ConnectPage[] = [];
  for (const [name, mentions] of fresh) {
    // A name inside a longer one already taken ("Acme" in "Acme Widgets Ltd") is kept: both may be real.
    const members = [...mentions].map((m) => byPath.get(m)!).filter(Boolean);
    const domain = mostCommon(members.map((m) => m.fm.domain)) ?? "general";
    const existingOurs = pages.find((p) => isOurs(p) && p.fm.title === name && p.path.startsWith("entities/"));
    const path = existingOurs?.path ?? uniquePath("entities", name, taken);
    const fm: PageFrontmatter = {
      type: "entity",
      title: name,
      domain,
      owner: "unassigned",
      status: "draft",
      generated: { at: existingOurs?.fm.generated.at ?? now, by: "connect" },
      verified: null,
      stale_after: null,
      sources: topSources(members, 10),
      privacy: strictestPrivacy(members),
      checked_by: "flash",
      opus_pending: false,
      claims: [],
      retiredClaimIds: [],
    };
    const page: ConnectPage = { path, fm, body: `${name} is named on ${mentions.size} pages of this wiki.\n` };
    newPages.push(page);
    entityByName.set(name, path);
    if (!existingOurs) taken.add(path);
    byPath.set(path, page);
    created.push({ path, frontmatter: fm, body: page.body, created: !existingOurs });
  }

  // Which entities each content page names.
  const entityNames = [...entityByName.keys()].sort((a, b) => b.length - a.length);
  const pageEntities = new Map<string, string[]>();
  const entityPages = new Map<string, string[]>();
  for (const p of content) {
    const text = textOf(p);
    const found = new Set<string>();
    for (const name of entityNames) {
      const target = entityByName.get(name)!;
      if (target === p.path || found.has(target)) continue;
      if (names(text, name)) found.add(target);
    }
    const list = [...found];
    pageEntities.set(p.path, list);
    for (const e of list) {
      const l = entityPages.get(e) ?? [];
      l.push(p.path);
      entityPages.set(e, l);
    }
  }

  // 3. leaves and hubs (before related links, so siblings are not each other's "related").
  const leaves = new Map<string, LeafInfo>();
  for (const p of content) {
    if (p.fm.type === "entity" || p.path.startsWith("entities/")) continue;
    const info = leafInfo(p.fm.title, p.fm.claims.map((c) => c.text));
    if (info) leaves.set(p.path, info);
  }
  const groups = new Map<string, string[]>();
  for (const [path, info] of leaves) {
    const key = `${info.kind}|${info.qualifier ?? ""}|${info.month}`;
    const l = groups.get(key) ?? [];
    l.push(path);
    groups.set(key, l);
  }
  const hubOf = new Map<string, string>();
  const hubMembers = new Map<string, string[]>();
  const hubInfo = new Map<string, LeafInfo>();
  const hubsBySeries = new Map<string, Array<{ month: string; path: string }>>();
  const ourHubs = new Map(pages.filter((p) => isOurs(p) && p.fm.type === "synthesis").map((p) => [p.fm.title, p]));
  for (const [, members] of [...groups.entries()].sort()) {
    if (members.length < MIN_HUB_LEAVES) {
      for (const m of members) leaves.delete(m);
      continue;
    }
    members.sort((a, b) => leaves.get(a)!.sortKey.localeCompare(leaves.get(b)!.sortKey) || a.localeCompare(b));
    const info = leaves.get(members[0])!;
    for (let part = 1; (part - 1) * HUB_MAX_LEAVES < members.length; part++) {
      const slice = members.slice((part - 1) * HUB_MAX_LEAVES, part * HUB_MAX_LEAVES);
      const title = hubTitle(info, part);
      const prior = ourHubs.get(title);
      const path = prior?.path ?? uniquePath("syntheses", title, taken);
      hubMembers.set(path, slice);
      hubInfo.set(path, info);
      for (const m of slice) hubOf.set(m, path);
      const series = `${info.kind}|${info.qualifier ?? ""}`;
      const l = hubsBySeries.get(series) ?? [];
      l.push({ month: `${info.month}#${String(part).padStart(3, "0")}`, path });
      hubsBySeries.set(series, l);
      const leafPages = slice.map((s) => byPath.get(s)!);
      const fm: PageFrontmatter = {
        type: "synthesis",
        title,
        domain: mostCommon(leafPages.map((m) => m.fm.domain)) ?? "general",
        owner: "unassigned",
        status: "draft",
        generated: { at: prior?.fm.generated.at ?? now, by: "connect" },
        verified: null,
        stale_after: null,
        sources: topSources(leafPages, 20),
        privacy: strictestPrivacy(leafPages),
        checked_by: "flash",
        opus_pending: false,
        claims: [],
        retiredClaimIds: [],
        hub: { kind: info.kind, month: info.month, ...(info.qualifier ? { qualifier: info.qualifier } : {}), leaves: slice.length },
      };
      const label = KIND_LABEL[info.kind];
      const body = `${title}: ${slice.length} ${label.replace(/s$/, "")} page${slice.length === 1 ? "" : "s"} of ${info.month}${info.qualifier ? ` (${info.qualifier})` : ""}, rolled up in one place.\n`;
      const page: ConnectPage = { path, fm, body };
      byPath.set(path, page);
      newPages.push(page);
      created.push({ path, frontmatter: fm, body, created: !prior });
    }
  }
  const prevNextHub = new Map<string, string[]>();
  for (const list of hubsBySeries.values()) {
    list.sort((a, b) => a.month.localeCompare(b.month));
    list.forEach((h, i) => prevNextHub.set(h.path, [list[i - 1]?.path, list[i + 1]?.path].filter((x): x is string => !!x)));
  }

  // 2. related by embedding (cut to RELATED_DIMS), leaves of the same hub left out (they are tied as siblings).
  const related = new Map<string, string[]>();
  const vecPages = content.filter((p) => options.vectors?.has(p.path));
  if (vecPages.length > 1) {
    const dims = Math.min(RELATED_DIMS, options.vectors!.get(vecPages[0].path)!.length);
    const vs = vecPages.map((p) => cut(options.vectors!.get(p.path)!, dims));
    const ok = vs.map((v) => v.length === dims);
    for (let i = 0; i < vecPages.length; i++) {
      if (!ok[i]) continue;
      const best: Array<{ j: number; s: number }> = [];
      const hubI = hubOf.get(vecPages[i].path);
      for (let j = 0; j < vecPages.length; j++) {
        if (j === i || !ok[j]) continue;
        if (hubI && hubOf.get(vecPages[j].path) === hubI) continue;
        let s = 0;
        const a = vs[i];
        const b = vs[j];
        for (let d = 0; d < dims; d++) s += a[d] * b[d];
        if (s < minSim) continue;
        if (best.length < RELATED_K) {
          best.push({ j, s });
          best.sort((x, y) => y.s - x.s);
        } else if (s > best[best.length - 1].s) {
          best[best.length - 1] = { j, s };
          best.sort((x, y) => y.s - x.s);
        }
      }
      related.set(vecPages[i].path, best.map((b) => vecPages[b.j].path));
    }
  }

  // Shared rare entities.
  const shared = new Map<string, string[]>();
  for (const p of content) {
    const score = new Map<string, number>();
    for (const e of pageEntities.get(p.path) ?? []) {
      const others = entityPages.get(e) ?? [];
      if (others.length < 2 || others.length > SHARED_ENTITY_MAX_DF) continue;
      const w = 1 / Math.log(others.length + 1);
      for (const o of others) if (o !== p.path && hubOf.get(o) !== hubOf.get(p.path)) score.set(o, (score.get(o) ?? 0) + w);
    }
    shared.set(
      p.path,
      [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, SHARED_ENTITY_K).map(([o]) => o),
    );
  }

  // 4. render the blocks.
  const titleOf = (p: string) => byPath.get(p)?.fm.title ?? p.replace(/\.md$/, "");
  const budgetFor = (p: ConnectPage) => {
    const cap = ATOMIC_TYPES.has(p.fm.type) ? LIMITS.atomicMaxChars : LIMITS.bodySoftChars;
    return Math.max(0, cap - p.body.trim().length - BLOCK_BUDGET_SLACK);
  };
  const writes: PlannedWrite[] = [];
  const finalBodies = new Map<string, string>();
  const compose = (p: ConnectPage, sections: Section[]): string => {
    const block = renderBlock(
      sections.map((s) => ({ ...s, targets: s.targets.filter((t) => t !== p.path && byPath.has(t)) })),
      titleOf,
      budgetFor(p),
    );
    return block ? `${p.body.trimEnd()}\n\n${block}\n` : p.body;
  };

  for (const p of content) {
    const hub = hubOf.get(p.path);
    const siblings: string[] = [];
    if (hub) {
      const m = hubMembers.get(hub)!;
      const at = m.indexOf(p.path);
      siblings.push(...[m[at - 1], m[at + 1]].filter((x): x is string => !!x));
    }
    const sections: Section[] = [
      { heading: "Hub", targets: hub ? [hub] : [] },
      { heading: "Entities", targets: pageEntities.get(p.path) ?? [] },
      { heading: "Similar pages", targets: related.get(p.path) ?? [] },
      { heading: "Shares entities with", targets: shared.get(p.path) ?? [] },
      { heading: "Neighbours", targets: siblings },
    ];
    // An entity page lists the pages that name it (its backlinks).
    if (p.fm.type === "entity" || p.path.startsWith("entities/")) sections.push({ heading: "Named on", targets: entityPages.get(p.path) ?? [] });
    const body = compose(p, sections);
    finalBodies.set(p.path, body);
    const original = originals.get(p.path);
    if (p.fm.verified || p.fm.claims.some((c) => c.verified)) {
      finalBodies.set(p.path, original?.parsed.body ?? p.body);
      continue;
    }
    if (original && original.parsed.body.trim() !== body.trim()) writes.push({ path: p.path, frontmatter: p.fm, body, created: false });
  }
  for (const c of created) {
    const page = byPath.get(c.path)!;
    const sections: Section[] = c.frontmatter.type === "synthesis"
      ? [
          { heading: "Pages", targets: hubMembers.get(c.path) ?? [], bare: true },
          { heading: "Other months", targets: prevNextHub.get(c.path) ?? [] },
        ]
      : [{ heading: "Named on", targets: entityPages.get(c.path) ?? [] }];
    const body = compose(page, sections);
    finalBodies.set(c.path, body);
    const original = originals.get(c.path);
    if (!original || original.parsed.body.trim() !== body.trim() || JSON.stringify(original.parsed.ok ? original.parsed.frontmatter.sources : null) !== JSON.stringify(c.frontmatter.sources)) {
      writes.push({ ...c, body });
    }
  }
  // Pages this pass made before and no longer wants are left alone (never removed by a pass).

  const indexBody = addToIndex(snapshot.indexBody, created.filter((c) => c.created).map((c) => ({ path: c.path, title: c.frontmatter.title })));
  const all = [
    ...pages.filter((p) => !finalBodies.has(p.path)).map((p) => ({ path: p.path, title: p.fm.title, body: p.body })),
    ...[...finalBodies.entries()].map(([path, body]) => ({ path, title: titleOf(path), body })),
  ];
  const after = linkCounts(all, indexBody);
  const mean = after.counts.reduce((s, x) => s + x, 0) / Math.max(1, after.counts.length);
  return {
    writes,
    stats: {
      pages: pages.length,
      entitiesExisting: existingEntities,
      entitiesCreated: created.filter((c) => c.created && c.frontmatter.type === "entity").length,
      hubs: hubMembers.size,
      leaves: hubOf.size,
      pagesWithEmbeddings: vecPages.length,
      linksMedian: median(after.counts),
      linksMean: Math.round(mean * 100) / 100,
      linksMedianBefore: median(before.counts),
      orphansAfter: after.orphans,
    },
  };
}

// ── the run ───────────────────────────────────────────────────────────────

export interface ConnectRunResult extends ConnectStats {
  written: number;
  created: number;
  commits: string[];
  dryRun: boolean;
}

/**
 * Write a plan: new pages (and their index.md lines) first, so no commit
 * leaves a new page unlinked, then the rest in commits of {@link CONNECT_BATCH}.
 */
export async function runConnectPass(
  snapshot: Pick<VaultSnapshot, "pages" | "indexBody">,
  run: (message: string, fn: (tx: VaultTx) => Promise<void>) => Promise<{ commit: string | null }>,
  options: ConnectOptions & { dryRun?: boolean } = {},
): Promise<ConnectRunResult> {
  const plan = planConnections(snapshot, options);
  const created = plan.writes.filter((w) => w.created);
  const result: ConnectRunResult = { ...plan.stats, written: plan.writes.length, created: created.length, commits: [], dryRun: !!options.dryRun };
  if (options.dryRun) return result;
  const ordered = [...created, ...plan.writes.filter((w) => !w.created)];
  const indexBody = created.length > 0 ? addToIndex(snapshot.indexBody, created.map((c) => ({ path: c.path, title: c.frontmatter.title }))) : null;
  for (let at = 0; at < ordered.length; at += CONNECT_BATCH) {
    const batch = ordered.slice(at, at + CONNECT_BATCH);
    const { commit } = await run(`connect: links, entities and hubs (${at + 1}-${at + batch.length} of ${ordered.length})`, async (tx) => {
      if (at === 0 && indexBody !== null) await tx.write("index.md", indexBody);
      for (const w of batch) await tx.writePage(w.path, w.frontmatter, w.body);
    });
    if (commit) result.commits.push(commit);
  }
  return result;
}
