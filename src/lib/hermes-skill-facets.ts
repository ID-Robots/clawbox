// The facet vocabulary the Hermes Skills store filters on — pure (no node/fs),
// so the browse route, the offline index and the client rail all read the SAME
// definition of "what is a category" and "what is a trust bucket".
//
// WHY this module exists: the store used to filter through one <select> per tab
// (source on Browse, category on Installed) and the two disagreed about what a
// value even was — the index writes `skills.sh` where the CLI flag says
// `skills-sh`, and the registries write `Vision AI`, `vision-ai` and
// `Vision  AI` for one thing. A rail that shows counts has to answer that once.

import { type TrustLevel, sourceLabel } from '@/lib/hermes-skills';
import { CLEAN_VERDICTS } from '@/lib/hermes-skill-capabilities';

export const FACET_GROUP_IDS = ['source', 'trust', 'safety', 'category', 'provider'] as const;
export type FacetGroupId = (typeof FACET_GROUP_IDS)[number];

// ── Trust ───────────────────────────────────────────────────────────────────

/**
 * `builtin` and `official` are ONE bucket: `trustMeta` already labels both
 * "Official" because they are the same story to a customer, and a rail that
 * offered two identically-labelled checkboxes would be a bug on screen.
 */
export type TrustBucket = 'official' | 'trusted' | 'community' | 'unknown';

/** Most trustworthy first — the order the rail lists them in. */
export const TRUST_BUCKETS: readonly TrustBucket[] = ['official', 'trusted', 'community', 'unknown'];

const TRUST_BUCKET_SET = new Set<string>(TRUST_BUCKETS);

export function trustBucket(trust?: string): TrustBucket {
  const v = (trust || '').trim().toLowerCase() as TrustLevel;
  if (v === 'builtin' || v === 'official') return 'official';
  if (v === 'trusted') return 'trusted';
  if (v === 'community') return 'community';
  return 'unknown';
}

export function isTrustBucket(value: string): value is TrustBucket {
  return TRUST_BUCKET_SET.has(value);
}

// ── Safety (the installer's scan verdict) ───────────────────────────────────

/**
 * Only ever known for a skill that has been INSTALLED: the verdict comes from
 * the installer's own scan report in the hub lock, and the catalogue index
 * carries nothing like it. Browse therefore has no Safety facet, and saying so
 * is better than showing an empty one.
 */
export type SafetyBucket = 'safe' | 'caution' | 'dangerous' | 'unscanned';

export const SAFETY_BUCKETS: readonly SafetyBucket[] = ['safe', 'caution', 'dangerous', 'unscanned'];

const SAFETY_BUCKET_SET = new Set<string>(SAFETY_BUCKETS);

// Verdicts that mean the scanner refused, as opposed to merely raised an
// eyebrow. Everything else non-clean is `caution` — the same fail-closed
// reading as `isFlaggedVerdict`, which treats an unrecognised verdict as
// flagged rather than as clean.
const DANGEROUS_VERDICTS = new Set(['dangerous', 'blocked', 'critical', 'malicious']);

export function safetyBucket(verdict?: string): SafetyBucket {
  const v = (verdict || '').trim().toLowerCase();
  if (!v) return 'unscanned';
  if (CLEAN_VERDICTS.has(v)) return 'safe';
  if (DANGEROUS_VERDICTS.has(v)) return 'dangerous';
  return 'caution';
}

export function isSafetyBucket(value: string): value is SafetyBucket {
  return SAFETY_BUCKET_SET.has(value);
}

// ── Category ────────────────────────────────────────────────────────────────

/**
 * TASK-452 listed "junk ClawHub categories" as a defect, and the box confirms
 * something worse: of 90 605 catalogue rows only 739 carry `extra.category` at
 * all, and NONE of the 69 150 clawhub rows do. What is left is written three
 * ways by three registries — `Vision AI`, `real-estate`, `Data Science` — so a
 * raw facet list would offer `Developer Tools` and `developer-tools` as two
 * different filters that each hide half the answer.
 *
 * So a category is normalised to a KEY (lowercase, one separator) and given a
 * display LABEL derived from that key. Anything that cannot be a category — a
 * sentence, a mangled `metadata:` tail, an empty word like `other` that tells a
 * customer nothing — is rejected outright rather than painted as a filter that
 * narrows to noise.
 *
 * Category is therefore never the facet the rail leans on. Trust and Safety
 * cover every row; this one covers the rows that bothered to say.
 */
export interface NormalizedCategory {
  /** Stable filter value: lowercase, `-` separated. Its own normal form. */
  key: string;
  /** What the rail shows: `vision-ai` → `Vision AI`. */
  label: string;
}

const CATEGORY_MAX_LEN = 40;
const CATEGORY_MAX_WORDS = 4;

// Structural punctuation a category never legitimately contains. The observed
// failure mode is a YAML fragment or a `metadata:` tail that was never a
// category at all.
const CATEGORY_REJECT_RE = /["'`:;,!?{}<>|\\[\]()]/;

/**
 * Values that ARE a category syntactically and say nothing semantically. They
 * are dropped rather than listed, because a rail whose largest bucket is
 * "Other" has not narrowed anything — and `other` is exactly what the installed
 * enumeration falls back to when a skill declares nothing.
 */
const CATEGORY_NOISE = new Set([
  'other',
  'others',
  'misc',
  'miscellaneous',
  'general',
  'uncategorized',
  'uncategorised',
  'unknown',
  'none',
  'null',
  'undefined',
  'n-a',
  'na',
  'category',
  'categories',
  'skill',
  'skills',
  'metadata',
  'default',
  'tbd',
]);

/**
 * The same thing under two spellings. Deliberately small: every entry is a pair
 * seen in the device's own catalogue or in its bundled skill directories, and a
 * synonym table that starts guessing does more damage than the duplicates it
 * merges.
 */
const CATEGORY_SYNONYMS: Record<string, string> = {
  'dev-tools': 'developer-tools',
  devtools: 'developer-tools',
  'development-tools': 'developer-tools',
  'developer-docs': 'documentation',
  docs: 'documentation',
  'e-commerce': 'ecommerce',
  shopping: 'ecommerce',
  retail: 'ecommerce',
  'artificial-intelligence': 'ai',
  'agentic-ai': 'ai',
  'conversational-ai': 'ai',
  'vision-ai': 'ai',
  'inference-ai': 'ai',
  'training-ai': 'ai',
  'physical-ai': 'ai',
  'machine-learning': 'ai',
  'data-science': 'data',
  analytics: 'data',
  'software-engineering': 'software-development',
  'software-dev': 'software-development',
  'home-automation': 'smart-home',
  'personal-finance': 'finance',
  payments: 'finance',
  jobs: 'careers',
  health: 'healthcare',
  fitness: 'healthcare',
};

// Words the title-caser must not touch. Everything else gets its first letter
// upper-cased, which is right for the ASCII slugs the registries publish and
// harmless for scripts that have no case.
const CATEGORY_WORDS: Record<string, string> = {
  ai: 'AI',
  ml: 'ML',
  gpu: 'GPU',
  api: 'API',
  cli: 'CLI',
  iot: 'IoT',
  ui: 'UI',
  ux: 'UX',
  sql: 'SQL',
  pdf: 'PDF',
  hr: 'HR',
  it: 'IT',
  crm: 'CRM',
  seo: 'SEO',
  qa: 'QA',
  ar: 'AR',
  vr: 'VR',
  xr: 'XR',
  '3d': '3D',
  devops: 'DevOps',
  mlops: 'MLOps',
  github: 'GitHub',
  gitlab: 'GitLab',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  ios: 'iOS',
  macos: 'macOS',
  osint: 'OSINT',
};

function titleWord(word: string): string {
  return CATEGORY_WORDS[word] || word.charAt(0).toUpperCase() + word.slice(1);
}

/** `vision-ai` → `Vision AI`. Exported so a KEY can be labelled on its own. */
export function categoryLabelFromKey(key: string): string {
  return key.split('-').filter(Boolean).map(titleWord).join(' ');
}

export function normalizeCategory(raw?: string | null): NormalizedCategory | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > CATEGORY_MAX_LEN) return null;
  if (CATEGORY_REJECT_RE.test(trimmed)) return null;
  if (trimmed.endsWith('.')) return null;
  // `_`, `/` and runs of spaces or hyphens are all "the same separator" across
  // the registries; collapsing them is what makes `Data Science` and
  // `data-science` one bucket instead of two half-empty ones.
  const collapsed = trimmed.toLowerCase().replace(/[\s_/]+/g, '-').replace(/-{2,}/g, '-');
  const bare = collapsed.replace(/^-+|-+$/g, '');
  if (!bare) return null;
  if (bare.split('-').length > CATEGORY_MAX_WORDS) return null;
  const key = CATEGORY_SYNONYMS[bare] || bare;
  if (CATEGORY_NOISE.has(key)) return null;
  return { key, label: categoryLabelFromKey(key) };
}

/**
 * A category filter value is valid exactly when it is its own normal form —
 * which is what the client always sends, and what nothing hostile can be
 * coaxed into producing.
 */
export function isValidCategoryKey(value: string): boolean {
  return typeof value === 'string' && normalizeCategory(value)?.key === value;
}

// ── Counting ────────────────────────────────────────────────────────────────

export interface RankedFacet {
  id: string;
  label: string;
  count: number;
}

/**
 * Sort a count map into the rail's option list, capped, with the CURRENT
 * SELECTION always present.
 *
 * That last property is the one the old <select> needed and the rail needs just
 * as much: the list is the top N for the current query, so a value the user has
 * ticked can drop out of it — and a checkbox that vanishes while its filter is
 * still applied is a filter the user cannot remove.
 */
export function rankFacets(
  counts: Map<string, number>,
  selected: readonly string[],
  labeller: (id: string) => string,
  limit: number,
): RankedFacet[] {
  const out = Array.from(counts.entries())
    .map(([id, count]) => ({ id, label: labeller(id), count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
    .slice(0, limit);
  for (const id of selected) {
    if (!out.some((o) => o.id === id)) {
      out.push({ id, label: labeller(id), count: counts.get(id) || 0 });
    }
  }
  return out;
}

/** Source ids reach the UI in both spellings the registries use. */
export function sourceFacetLabel(id: string): string {
  return sourceLabel(id);
}

// ── The Installed tab ───────────────────────────────────────────────────────

/** The rail's groups on the Installed tab, in the order it renders them. */
export const INSTALLED_FACET_GROUPS = ['trust', 'safety', 'category', 'source'] as const;
export type InstalledFacetGroup = (typeof INSTALLED_FACET_GROUPS)[number];
export type InstalledSelection = Record<InstalledFacetGroup, string[]>;

export const EMPTY_INSTALLED_SELECTION: InstalledSelection = {
  trust: [],
  safety: [],
  category: [],
  source: [],
};

/** The fields the Installed rail reads. A superset of `InstalledHermesSkill`. */
export interface FacetableSkill {
  category?: string;
  trust?: string;
  scanVerdict?: string;
  source?: string;
}

export interface InstalledFacetResult<T> {
  rows: T[];
  counts: Record<InstalledFacetGroup, Map<string, number>>;
  /** Rows in the filtered set that carry a usable category. */
  categoryCoverage: number;
}

/**
 * Filter and count the installed list in one pass, with the same honesty rule
 * the catalogue applies: a group's counts are measured with the OTHER groups'
 * filters applied but not its own.
 *
 * Unlike Browse, this runs over the WHOLE list — the installed endpoint returns
 * every row rather than a page — so these counts are never a page total wearing
 * a catalogue total's clothes.
 */
export function facetInstalled<T extends FacetableSkill>(
  rows: T[],
  selection: InstalledSelection,
): InstalledFacetResult<T> {
  const wantTrust = selection.trust.length ? new Set(selection.trust) : null;
  const wantSafety = selection.safety.length ? new Set(selection.safety) : null;
  const wantCategory = selection.category.length ? new Set(selection.category) : null;
  const wantSource = selection.source.length ? new Set(selection.source) : null;

  const counts: Record<InstalledFacetGroup, Map<string, number>> = {
    trust: new Map(),
    safety: new Map(),
    category: new Map(),
    source: new Map(),
  };
  const kept: T[] = [];
  let categoryCoverage = 0;

  for (const row of rows) {
    const trust = trustBucket(row.trust);
    const safety = safetyBucket(row.scanVerdict);
    const category = normalizeCategory(row.category)?.key;
    const source = row.source || 'unknown';

    const okTrust = !wantTrust || wantTrust.has(trust);
    const okSafety = !wantSafety || wantSafety.has(safety);
    const okCategory = !wantCategory || (!!category && wantCategory.has(category));
    const okSource = !wantSource || wantSource.has(source);

    if (okSafety && okCategory && okSource) bumpCount(counts.trust, trust);
    if (okTrust && okCategory && okSource) bumpCount(counts.safety, safety);
    if (okTrust && okSafety && okSource && category) bumpCount(counts.category, category);
    if (okTrust && okSafety && okCategory) bumpCount(counts.source, source);

    if (!okTrust || !okSafety || !okCategory || !okSource) continue;
    if (category) categoryCoverage++;
    kept.push(row);
  }
  return { rows: kept, counts, categoryCoverage };
}

function bumpCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) || 0) + 1);
}

/**
 * Fixed-vocabulary groups (trust, safety) are listed in their own order rather
 * than by count, so the rail does not reshuffle under the pointer as a query
 * changes which bucket is largest.
 */
export function fixedFacets<T extends string>(
  order: readonly T[],
  counts: Map<string, number>,
  selected: readonly string[],
  labeller: (id: T) => string,
): RankedFacet[] {
  // An empty bucket is noise — unless it is TICKED, in which case hiding it
  // would leave a filter applied with no checkbox to clear it.
  return order
    .filter((id) => (counts.get(id) || 0) > 0 || selected.includes(id))
    .map((id) => ({ id, label: labeller(id), count: counts.get(id) || 0 }));
}
