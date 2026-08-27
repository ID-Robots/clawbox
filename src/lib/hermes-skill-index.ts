// Offline catalog for the Hermes Skills store (server-only).
//
// WHY this exists: `hermes skills browse` renders a Rich table (no --json), one
// page at a time, seconds per page, truncates names/descriptions at the terminal
// width, and its `--source` filter is unreliable. `hermes skills search --json`
// has no paging and returns 5 fields. Neither can back a real store.
//
// Hermes itself already writes a complete catalog to
// ~/.hermes/skills/.hub/index-cache/hermes-index.json (v1: ~90 600 skills,
// ~41 MB, `{version, generated_at, skill_count, skills[]}`). We read that ONCE,
// project it down to the fields the UI shows, and serve every list/search/facet
// request from memory. The CLI stays as the fallback for a device whose index
// hasn't been built yet.
//
// SECURITY: every string in that file comes from public registries — Hermes even
// writes `.hub/.ignore` so its own agent won't read them as instructions. Nothing
// here is ever rendered as markdown or HTML; the store paints catalog strings as
// React text nodes only.

import fs from 'fs/promises';
import path from 'path';
import { runHermesCli } from '@/lib/hermes-cli';
import { runSkillsCli } from '@/lib/hermes-skills-cli';
import {
  type OfficialSkillOnDisk,
  SKILLS_DIR,
  enumerateOfficialSkills,
} from '@/lib/hermes-skills-server';
import {
  type CatalogFacet,
  type HermesSkill,
  type SortOption,
  MAX_FACET_VALUES,
  checkInstallIdentifier,
  sourceFlagValue,
  sourceLabel,
} from '@/lib/hermes-skills';
import {
  type TrustBucket,
  TRUST_BUCKETS,
  categoryLabelFromKey,
  fixedFacets,
  normalizeCategory,
  rankFacets,
  trustBucket,
} from '@/lib/hermes-skill-facets';

const INDEX_PATH = path.join(SKILLS_DIR, '.hub', 'index-cache', 'hermes-index.json');

// The index is rewritten in place by the CLI (not atomically), so a read can
// land mid-write. When that happens we stop retrying for a short window and let
// the caller fall back to the CLI rather than re-parsing 41 MB on every request.
const POISON_WINDOW_MS = 30_000;
// A parsed catalog costs ~40 MB of heap. Drop it when the store isn't being
// used; a reload is ~0.5 s and only pays off on the next browse.
const IDLE_EVICT_MS = 10 * 60_000;
const MAX_INDEX_BYTES = 256 * 1024 * 1024;

export interface CatalogRecord {
  id: string;
  name: string;
  description?: string;
  provenanceNote?: string;
  source: string;
  trust: string;
  tags: string[];
  provider?: string;
  category?: string;
  /**
   * `category` run through `normalizeCategory`, precomputed. Normalising 90 000
   * strings on every browse request is exactly the kind of per-request work the
   * `hay` field exists to avoid, and the facet counter touches this on every
   * row of every query.
   */
  categoryKey?: string;
  installCount?: number;
  hostname?: string;
  detailUrl?: string;
  repoUrl?: string;
  sourceUrl?: string;
  /** Repo-relative path of an `official` skill inside hermes-agent/. */
  localPath?: string;
  /**
   * `owner/repo` the row was indexed from, and the skill's directory inside it.
   * Kept (they were previously read only to build a provenance note) because
   * they are what lets the install route ask GitHub for the skill's COMPLETE
   * file list and repair an install the Hermes fetcher truncated — see
   * hermes-skill-manifest.ts.
   */
  repo?: string;
  repoPath?: string;
  /** Lowercased name+id, precomputed — the hot path of every query. */
  hay: string;
}

export interface CatalogState {
  records: CatalogRecord[];
  byId: Map<string, CatalogRecord>;
  /** Records ordered by name A–Z — precomputed, see `queryCatalog`. */
  orderName: CatalogRecord[];
  /** Records ordered by trust desc, then name — the default listing order. */
  orderTrust: CatalogRecord[];
  generatedAt?: string;
  /** When THIS device last wrote the index file (its mtime), ISO-8601. */
  fetchedAt?: string;
  skillCount: number;
  sourceCounts: Map<string, number>;
  providerCounts: Map<string, number>;
  /** Trust bucket → rows. Precomputed for the same reason as the orderings. */
  trustCounts: Map<string, number>;
  categoryCounts: Map<string, number>;
  /** Rows that carry a usable category at all (739 of 90 605 on the box). */
  categoryCoverage: number;
}

interface CacheSlot {
  key: string;
  state: CatalogState;
  touchedAt: number;
  timer?: NodeJS.Timeout;
}

let cache: CacheSlot | null = null;
let poisonedUntil = 0;
let inFlight: Promise<CatalogState | null> | null = null;

// ── Projection ──────────────────────────────────────────────────────────────

interface RawRecord {
  name?: unknown;
  description?: unknown;
  source?: unknown;
  identifier?: unknown;
  trust_level?: unknown;
  repo?: unknown;
  path?: unknown;
  tags?: unknown;
  extra?: unknown;
}

/**
 * Some registry rows were never YAML-unquoted upstream, so the quote characters
 * are part of the value: `"Dictionary"`, `"dictionary`, `reference"`. Rendered
 * verbatim they become card titles in quotes and tag chips like `#"dictionary`.
 * A matched pair is always decoration; a single stray quote at an end is
 * upstream mangling. Anything else (`"What if?" Scenario Builder`) is the
 * author's own punctuation and is left alone.
 */
function stripStrayQuotes(v: string): string {
  const first = v[0];
  const last = v[v.length - 1];
  const isQuote = (c: string) => c === '"' || c === "'";
  if (v.length >= 2 && isQuote(first) && first === last) return v.slice(1, -1).trim();
  if ((isQuote(first) || isQuote(last)) && (v.match(/["']/g) || []).length === 1) {
    return v.replace(/^["']|["']$/, '').trim();
  }
  return v;
}

function str(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Control chars would break the layout and can hide text from a reviewer.
  const v = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!v) return undefined;
  const unquoted = stripStrayQuotes(v);
  if (!unquoted) return undefined;
  return unquoted.length > maxLen ? `${unquoted.slice(0, maxLen).trimEnd()}…` : unquoted;
}

function httpsOnly(value: unknown): string | undefined {
  const v = str(value, 400);
  return v && /^https:\/\/[^\s<>"']+$/i.test(v) ? v : undefined;
}

function tagList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    const t = str(raw, 40);
    if (t) out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

// skills.sh indexes whole repos and fills the description with a fixed
// placeholder that says nothing about the skill. Suppress it and keep the
// provenance instead — "from owner/repo" is at least true and useful.
const PLACEHOLDER_RE = /^Indexed by skills\.sh from\s+(.+)$/i;

function trustOf(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return v === 'builtin' || v === 'official' || v === 'trusted' || v === 'community' ? v : 'unknown';
}

/**
 * A small fraction of clawhub rows are mangled at the registry end: the "name"
 * is the whole description with a trailing `metadata:`. They're unusable and
 * un-installable, so they never reach the grid.
 */
function isUsableName(name: string): boolean {
  if (name.length > 80) return false;
  if (/[\r\n]/.test(name)) return false;
  if (/metadata:\s*$/.test(name)) return false;
  return true;
}

// Hermes' index hard-truncates descriptions at exactly this many characters and
// leaves no marker, so a sentence cut mid-word reads as a complete one.
const REGISTRY_DESCRIPTION_LIMIT = 200;

function project(raw: RawRecord): CatalogRecord | null {
  const identifier = str(raw.identifier, 256);
  const rawName = str(raw.name, 120);
  const id = identifier || rawName;
  if (!id) return null;
  const name = rawName || id.split('/').pop() || id;
  if (!isUsableName(name)) return null;
  // A row whose identifier the install validator rejects (a trailing `/`,
  // parentheses, an over-long segment) can be neither opened nor installed —
  // its detail request 400s. Drop it here rather than paint a dead card.
  if (!checkInstallIdentifier(id).ok) return null;

  const extra = (raw.extra && typeof raw.extra === 'object' ? raw.extra : {}) as Record<string, unknown>;
  const source = str(raw.source, 40) || 'unknown';

  let description = str(raw.description, 400);
  if (description && description.length === REGISTRY_DESCRIPTION_LIMIT) {
    // Restore the marker the registry dropped. A genuinely 200-char-long
    // description gains a spurious ellipsis; presenting truncated text as
    // complete is the worse of the two errors.
    description = `${description}…`;
  }
  let provenanceNote: string | undefined;
  const placeholder = description?.match(PLACEHOLDER_RE);
  if (placeholder) {
    description = undefined;
    const repo = str(raw.repo, 160) || placeholder[1];
    provenanceNote = `from ${repo}`;
  }

  const installCountRaw = extra.install_count;
  const category = str(extra.category, 60);
  const record: CatalogRecord = {
    id,
    name,
    description,
    provenanceNote,
    source,
    trust: trustOf(raw.trust_level),
    tags: tagList(raw.tags),
    provider: str(extra.provider, 60),
    category,
    categoryKey: normalizeCategory(category)?.key,
    installCount: typeof installCountRaw === 'number' && installCountRaw >= 0 ? installCountRaw : undefined,
    hostname: str(extra.hostname, 100),
    detailUrl: httpsOnly(extra.detail_url),
    repoUrl: httpsOnly(extra.repo_url),
    sourceUrl: httpsOnly(extra.source_url) || httpsOnly(extra.url),
    localPath: source === 'official' ? str(raw.path, 300) : undefined,
    repo: str(raw.repo, 160),
    repoPath: source === 'official' ? undefined : str(raw.path, 300),
    hay: hayOf(name, id),
  };
  return record;
}

const TRUST_RANK: Record<string, number> = { builtin: 4, official: 4, trusted: 3, community: 2, unknown: 1 };

function hayOf(name: string, id: string): string {
  return `${name}\n${id}`.toLowerCase();
}

/**
 * Reconcile the `official` slice of the index with the agent checkout on THIS
 * device. The index is published upstream and lags the checkout, so it can be
 * missing skills that ship here, list one whose directory is gone, and carry
 * descriptions truncated at 200 chars where the file has the real sentence.
 * The files win for every one of those.
 */
function applyOfficialOverlay(byId: Map<string, CatalogRecord>, disk: OfficialSkillOnDisk[]): void {
  if (!disk.length) return; // no checkout on this device — trust the index as-is
  const byPath = new Map(disk.map((d) => [d.path, d]));

  for (const [id, rec] of byId) {
    if (rec.source !== 'official') continue;
    const onDisk = rec.localPath ? byPath.get(rec.localPath) : undefined;
    if (!onDisk) {
      // The skill the row points at is not installed on this device: opening it
      // would show catalog metadata for something that cannot be read.
      if (rec.localPath) byId.delete(id);
      continue;
    }
    // Through the same sanitiser as an index row: SKILL.md is hand-written and
    // its length caps / control-char stripping are not this module's business
    // to assume.
    rec.name = str(onDisk.name, 120) || rec.name;
    rec.description = str(onDisk.description, 400) ?? rec.description;
    const tags = tagList(onDisk.tags);
    if (tags.length) rec.tags = tags;
    rec.category = rec.category || str(onDisk.category, 60);
    rec.categoryKey = normalizeCategory(rec.category)?.key;
    rec.hay = hayOf(rec.name, rec.id);
  }

  for (const d of disk) {
    if (byId.has(d.id)) continue;
    const name = str(d.name, 120);
    if (!name || !checkInstallIdentifier(d.id).ok) continue;
    const category = str(d.category, 60);
    byId.set(d.id, {
      id: d.id,
      name,
      description: str(d.description, 400),
      source: 'official',
      // Every official row in the index carries trust_level "builtin".
      trust: 'builtin',
      tags: tagList(d.tags),
      category,
      categoryKey: normalizeCategory(category)?.key,
      localPath: d.path,
      hay: hayOf(name, d.id),
    });
  }
}

/** Exported for tests: projects a parsed index document into the catalog. */
export function buildCatalogState(parsed: unknown, official: OfficialSkillOnDisk[] = []): CatalogState {
  const doc = (parsed && typeof parsed === 'object' ? parsed : {}) as {
    generated_at?: unknown;
    skill_count?: unknown;
    skills?: unknown;
  };
  const rows = Array.isArray(doc.skills) ? doc.skills : [];
  const byId = new Map<string, CatalogRecord>();
  for (const row of rows) {
    const rec = project(row as RawRecord);
    if (!rec) continue;
    const existing = byId.get(rec.id);
    // Same identifier from two registries: keep the more trusted copy.
    if (existing && (TRUST_RANK[existing.trust] || 0) >= (TRUST_RANK[rec.trust] || 0)) continue;
    byId.set(rec.id, rec);
  }
  applyOfficialOverlay(byId, official);
  const records = Array.from(byId.values());
  const sourceCounts = new Map<string, number>();
  const providerCounts = new Map<string, number>();
  const trustCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  let categoryCoverage = 0;
  for (const r of records) {
    // Counted under the FLAG spelling (`skills-sh`), which is the only spelling
    // the client, the query string and the CLI all agree on. The index's own
    // `skills.sh` never leaves this module as a facet id.
    const sourceId = sourceFlagValue(r.source);
    sourceCounts.set(sourceId, (sourceCounts.get(sourceId) || 0) + 1);
    if (r.source === 'github' && r.provider) {
      providerCounts.set(r.provider, (providerCounts.get(r.provider) || 0) + 1);
    }
    const bucket = trustBucket(r.trust);
    trustCounts.set(bucket, (trustCounts.get(bucket) || 0) + 1);
    if (r.categoryKey) {
      categoryCounts.set(r.categoryKey, (categoryCounts.get(r.categoryKey) || 0) + 1);
      categoryCoverage++;
    }
  }
  // The two unfiltered listing orders are invariant for a given index, so they
  // are computed ONCE here. Sorting 90 000 records on every browse request to
  // return 24 of them cost 80–250 ms of event-loop block per page on device.
  const orderName = records.slice().sort(byNameAsc);
  const orderTrust = records.slice().sort(byTrustDesc);
  return {
    records,
    byId,
    orderName,
    orderTrust,
    generatedAt: typeof doc.generated_at === 'string' ? doc.generated_at : undefined,
    skillCount: records.length,
    sourceCounts,
    providerCounts,
    trustCounts,
    categoryCounts,
    categoryCoverage,
  };
}

function byNameAsc(a: CatalogRecord, b: CatalogRecord): number {
  return a.name.localeCompare(b.name);
}

function byTrustDesc(a: CatalogRecord, b: CatalogRecord): number {
  return (TRUST_RANK[b.trust] || 0) - (TRUST_RANK[a.trust] || 0) || a.name.localeCompare(b.name);
}

function byPopularDesc(a: CatalogRecord, b: CatalogRecord): number {
  return (b.installCount || 0) - (a.installCount || 0) || a.name.localeCompare(b.name);
}

function scheduleEviction(slot: CacheSlot): void {
  if (slot.timer) clearTimeout(slot.timer);
  const timer = setTimeout(() => {
    if (cache === slot && Date.now() - slot.touchedAt >= IDLE_EVICT_MS) cache = null;
  }, IDLE_EVICT_MS);
  // Never hold the process open for a cache timer.
  timer.unref?.();
  slot.timer = timer;
}

/**
 * Load (or reuse) the projected catalog. Returns null when the index is
 * missing/unreadable/mid-write — callers fall back to the CLI. Never throws.
 *
 * The JSON.parse of a 41 MB file blocks the event loop for ~0.4 s. That is a
 * DELIBERATE trade on a single-user device: it happens at most once per index
 * rewrite (and once per 10-minute idle eviction), and it buys every subsequent
 * browse/search/facet an in-memory answer instead of a multi-second CLI call.
 */
export async function loadCatalog(): Promise<CatalogState | null> {
  let stat;
  try {
    stat = await fs.stat(INDEX_PATH);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_INDEX_BYTES) return null;

  const key = `${stat.mtimeMs}:${stat.size}`;
  if (cache && cache.key === key) {
    cache.touchedAt = Date.now();
    scheduleEviction(cache);
    return cache.state;
  }
  if (Date.now() < poisonedUntil) return null;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const [raw, official] = await Promise.all([
        fs.readFile(INDEX_PATH, 'utf8'),
        // ~110 small reads, once per index rewrite — the same order of cost as
        // the installed walk, and the only way Browse can show the `official`
        // skills this device actually has (see applyOfficialOverlay).
        enumerateOfficialSkills().catch(() => [] as OfficialSkillOnDisk[]),
      ]);
      const state = buildCatalogState(JSON.parse(raw), official);
      state.fetchedAt = new Date(stat.mtimeMs).toISOString();
      const slot: CacheSlot = { key, state, touchedAt: Date.now() };
      cache = slot;
      scheduleEviction(slot);
      poisonedUntil = 0;
      return state;
    } catch {
      // Truncated read (the CLI rewrites this file in place) or OOM-ish parse
      // failure — back off so we don't re-parse 41 MB per request.
      poisonedUntil = Date.now() + POISON_WINDOW_MS;
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export async function getCatalogRecord(id: string): Promise<CatalogRecord | undefined> {
  const state = await loadCatalog();
  return state?.byId.get(id);
}

// ── Query ───────────────────────────────────────────────────────────────────

export interface CatalogQuery {
  q?: string;
  /** Multi-select. Empty (or omitted) means every source. */
  sources?: string[];
  providers?: string[];
  /** Trust BUCKETS — `builtin` and `official` are the same one. */
  trust?: string[];
  /** Normalised category keys. */
  categories?: string[];
  sort: SortOption;
  page: number;
  pageSize: number;
}

export interface CatalogPage {
  skills: HermesSkill[];
  total: number;
  sources: CatalogFacet[];
  providers: CatalogFacet[];
  trust: CatalogFacet[];
  categories: CatalogFacet[];
  /** Rows in the CURRENT result set that carry a usable category. */
  categoryCoverage: number;
}

function toCardPayload(r: CatalogRecord): HermesSkill {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    provenanceNote: r.provenanceNote,
    source: r.source,
    trust: r.trust,
    provider: r.provider,
    category: r.category,
    tags: r.tags.length ? r.tags.slice(0, 4) : undefined,
    installCount: r.installCount,
    hostname: r.hostname,
  };
}

/**
 * Relevance score. Deterministic and intentionally simple — an exact name beats
 * a prefix beats a substring beats a tag beats a description hit; trust breaks
 * near-ties; a skill with no real description is pushed down because its card
 * can't tell the user anything.
 */
function score(r: CatalogRecord, q: string, re: RegExp): number {
  const name = r.name.toLowerCase();
  let s = 0;
  if (name === q) s = 100;
  else if (name.startsWith(q)) s = 80;
  else if (name.includes(q)) s = 60;
  else if (r.tags.some((t) => t.toLowerCase() === q)) s = 50;
  else if (r.id.toLowerCase().includes(q)) s = 40;
  else if (r.description && re.test(r.description)) s = 20;
  else return 0;
  if (r.trust === 'builtin' || r.trust === 'official') s += 6;
  else if (r.trust === 'trusted') s += 3;
  if (!r.description) s -= 5;
  return s;
}

function escapeRegExp(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `hay` is precomputed lowercase, but tags and descriptions are not — and
 * lowercasing 90 000 descriptions per request (twice, once for facets and once
 * for the filter) was the single most expensive thing the browse endpoint did.
 * A regex compiled ONCE per query tests them in place, allocating nothing.
 */
function matches(r: CatalogRecord, q: string, re: RegExp): boolean {
  if (r.hay.includes(q)) return true;
  if (r.tags.some((t) => re.test(t))) return true;
  return !!r.description && re.test(r.description);
}

/** Selection as a lookup, or null for "this group filters nothing". */
function selectionSet(values: string[] | undefined, lower = false): Set<string> | null {
  if (!values || values.length === 0) return null;
  const set = new Set<string>();
  for (const v of values) {
    if (v === 'all') return null; // the firehose beats any narrowing beside it
    set.add(lower ? v.toLowerCase() : v);
  }
  return set.size ? set : null;
}

/**
 * Facet counting, the honest way.
 *
 * Every group's counts are measured with the OTHER groups' filters applied but
 * NOT its own. That is what makes a rail truthful: "Trusted (478)" means 478
 * skills are reachable by ticking it from where you stand, and ticking
 * "Community" beside it never collapses its sibling counts to zero. The old
 * single-<select> version approximated this by ignoring the facet selection
 * entirely, which was right for one group and wrong the moment there were four.
 */
export function queryCatalog(state: CatalogState, query: CatalogQuery): CatalogPage {
  const q = (query.q || '').trim().toLowerCase();
  const wantSources = selectionSet(query.sources);
  const wantProviders = selectionSet(query.providers, true);
  const wantTrust = selectionSet(query.trust);
  const wantCategories = selectionSet(query.categories);

  // "Best match" without a query has nothing to rank on — the listing order is
  // trust, the same default the route picks.
  const sort: SortOption = query.sort === 'relevance' && !q ? 'trust' : query.sort;

  const filtered = !!(wantSources || wantProviders || wantTrust || wantCategories);
  let sourceCounts = state.sourceCounts;
  let providerCounts = state.providerCounts;
  let trustCounts = state.trustCounts;
  let categoryCounts = state.categoryCounts;
  let categoryCoverage = state.categoryCoverage;
  let sorted: CatalogRecord[];

  if (!q && !filtered && (sort === 'name' || sort === 'trust')) {
    // Unfiltered listing: served straight from the orderings and the counts
    // computed once at load. 90 000 rows are not walked to show 24 of them.
    sorted = sort === 'name' ? state.orderName : state.orderTrust;
  } else {
    const re = q ? new RegExp(escapeRegExp(q), 'i') : null;
    const rows: CatalogRecord[] = [];
    sourceCounts = new Map();
    providerCounts = new Map();
    trustCounts = new Map();
    categoryCounts = new Map();
    categoryCoverage = 0;
    // ONE pass does the query match, all four facet counts and all four facet
    // filters.
    for (const r of state.records) {
      if (re && !matches(r, q, re)) continue;
      const sourceId = sourceFlagValue(r.source);
      const trust = trustBucket(r.trust);
      const provider = r.provider ? r.provider.toLowerCase() : undefined;
      const okSource = !wantSources || wantSources.has(sourceId);
      const okProvider = !wantProviders || (!!provider && wantProviders.has(provider));
      const okTrust = !wantTrust || wantTrust.has(trust);
      const okCategory = !wantCategories || (!!r.categoryKey && wantCategories.has(r.categoryKey));

      if (okProvider && okTrust && okCategory) bump(sourceCounts, sourceId);
      if (okSource && okTrust && okCategory && r.source === 'github' && r.provider) {
        bump(providerCounts, r.provider);
      }
      if (okSource && okProvider && okCategory) bump(trustCounts, trust);
      if (okSource && okProvider && okTrust && r.categoryKey) {
        bump(categoryCounts, r.categoryKey);
      }
      if (!okSource || !okProvider || !okTrust || !okCategory) continue;
      if (r.categoryKey) categoryCoverage++;
      rows.push(r);
    }
    if (re && sort === 'relevance') {
      const cached = new Map<CatalogRecord, number>();
      for (const r of rows) cached.set(r, score(r, q, re));
      rows.sort((a, b) => cached.get(b)! - cached.get(a)! || a.name.localeCompare(b.name));
    } else if (sort === 'popular') {
      rows.sort(byPopularDesc);
    } else if (sort === 'name') {
      rows.sort(byNameAsc);
    } else {
      rows.sort(byTrustDesc);
    }
    sorted = rows;
  }

  const start = (query.page - 1) * query.pageSize;
  return {
    skills: sorted.slice(start, start + query.pageSize).map(toCardPayload),
    total: sorted.length,
    sources: rankFacets(sourceCounts, query.sources || [], sourceLabel, MAX_FACET_VALUES),
    providers: rankFacets(providerCounts, query.providers || [], (id) => id, MAX_FACET_VALUES),
    trust: fixedFacets(TRUST_BUCKETS, trustCounts, query.trust || [], (id: TrustBucket) => id),
    categories: rankFacets(
      categoryCounts,
      query.categories || [],
      categoryLabelFromKey,
      MAX_FACET_VALUES,
    ),
    categoryCoverage,
  };
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) || 0) + 1);
}

// ── CLI fallbacks ───────────────────────────────────────────────────────────

interface RawSearchItem {
  name?: unknown;
  identifier?: unknown;
  source?: unknown;
  trust_level?: unknown;
  description?: unknown;
}

function normalizeSearchItem(item: RawSearchItem): HermesSkill | null {
  const identifier = str(item.identifier, 256);
  const name = str(item.name, 120);
  const id = identifier || name;
  if (!id) return null;
  return {
    id,
    name: name || id,
    description: str(item.description, 400),
    source: str(item.source, 40),
    trust: trustOf(item.trust_level),
  };
}

/**
 * `hermes skills search --json` — the only machine-readable subcommand. Used
 * ONLY when the offline index isn't available: no paging, top-N, 5 fields.
 */
export async function cliSearch(
  q: string,
  source: string | undefined,
  limit: number,
  signal?: AbortSignal,
): Promise<HermesSkill[]> {
  const args = ['skills', 'search', '--json', q, '--limit', String(limit)];
  if (source && source !== 'all') args.push('--source', source);
  const r = await runSkillsCli(args, { timeoutMs: 60_000, signal });
  if (r.code !== 0) throw new Error('Search failed');
  let raw: unknown;
  try {
    raw = r.stdout ? JSON.parse(r.stdout) : [];
  } catch {
    return []; // a human "no results" message rather than JSON
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((i) => normalizeSearchItem(i as RawSearchItem))
    .filter((s): s is HermesSkill => s !== null);
}

/**
 * `hermes skills browse` — a Rich table, no --json. Rendered at a wide COLUMNS
 * so each skill is one row; continuation rows (blank #) carry wrapped tails.
 * Lossy (names/descriptions are ellipsised) which is exactly why the index is
 * preferred — this only runs before the index exists.
 */
export function parseBrowseTable(out: string): HermesSkill[] {
  const skills: HermesSkill[] = [];
  let last: HermesSkill | null = null;
  for (const line of out.split(/\r?\n/)) {
    if (!line.startsWith('│')) continue;
    // cells: ["", num, name, description, source, trust, identifier, ""]
    const cells = line.split('│').map((c) => c.trim());
    if (cells.length < 7) continue;
    const num = cells[1];
    if (/^\d+$/.test(num)) {
      const trust = cells[5].replace(/^★\s*/, '').trim();
      last = {
        id: cells[6],
        name: cells[2],
        description: cells[3] || undefined,
        source: cells[4] || undefined,
        trust: trust || undefined,
      };
      if (last.id && last.name) skills.push(last);
      else last = null;
    } else if (num === '' && last) {
      if (cells[6]) last.id += cells[6];
      if (cells[3]) last.description = `${last.description || ''} ${cells[3]}`.trim();
    }
  }
  for (const s of skills) {
    // A truncated name ("3-statement…") is unreliable — derive it from the
    // (now-complete) identifier leaf.
    if (/[…]|\.\.\.$/.test(s.name)) {
      const leaf = s.id.split('/').pop();
      if (leaf) s.name = leaf;
    }
    // The description's ellipsis is KEPT: the table cuts it at the column width
    // and there is no second source for the tail, so stripping the marker would
    // present a half sentence as a whole one.
    if (s.description) s.description = s.description.trim() || undefined;
  }
  return skills;
}

export async function cliBrowse(
  page: number,
  size: number,
  source: string | undefined,
  signal?: AbortSignal,
): Promise<{ skills: HermesSkill[]; hasMore: boolean }> {
  const args = ['skills', 'browse', '--page', String(page), '--size', String(size)];
  if (source && source !== 'all') args.push('--source', source);
  const r = await runSkillsCli(args, { timeoutMs: 60_000, env: { COLUMNS: '400' }, signal });
  if (r.code !== 0) throw new Error('Browse failed');
  const m = r.stdout.match(/page\s+(\d+)\/(\d+)/i);
  return {
    skills: parseBrowseTable(r.stdout),
    hasMore: m ? Number(m[1]) < Number(m[2]) : false,
  };
}

// ── Index warm-up ───────────────────────────────────────────────────────────

let warming: Promise<void> | null = null;
let lastWarmAt = 0;
// After a failed build (hermes missing/offline) don't immediately spawn another
// indexer on the next request — a refresh loop would otherwise start a new
// multi-minute CLI process every time.
const WARM_COOLDOWN_MS = 60_000;

/**
 * Kick the CLI once so it builds the index on a device that has never browsed.
 * Fire-and-forget: the caller answers the current request from the CLI fallback
 * and the next one lands on the index. Guarded so concurrent requests can't
 * spawn a pile of indexers.
 */
export function warmIndex(): boolean {
  if (warming) return true;
  if (Date.now() - lastWarmAt < WARM_COOLDOWN_MS) return false;
  // Deliberately NOT queued behind runSkillsCli: this is the one long-running
  // (multi-minute) call and it must not hold a slot the user's clicks need.
  warming = runHermesCli(['skills', 'browse', '--page', '1', '--size', '1'], {
    timeoutMs: 300_000,
    env: { COLUMNS: '200' },
  })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      warming = null;
      lastWarmAt = Date.now();
    });
  return true;
}

export function isWarming(): boolean {
  return warming !== null;
}
