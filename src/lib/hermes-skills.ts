// Shared types + input validators for the Hermes Skills Store. This module is
// pure (no node/fs imports) so it can be imported from BOTH the setup-api route
// handlers and the client component. All fs-based work lives in
// `hermes-skills-server.ts` / `hermes-skill-index.ts`.
//
// Every value here is eventually handed to `runHermesCli` as an argv element
// (spawn with an array, NEVER a shell), so injection is impossible — but a value
// that starts with "-" could still be misread by hermes as a FLAG, and a value
// with ".." / "/" could escape the skills tree. The validators below reject both.

export type TrustLevel = 'builtin' | 'official' | 'trusted' | 'community' | 'unknown';

/** Card payload for the Browse grid — everything comes from the catalog index. */
export interface HermesSkill {
  /** Install identifier — pass this verbatim to `hermes skills install`. */
  id: string;
  name: string;
  description?: string;
  /**
   * Shown instead of a description when the registry only had the skills.sh
   * "Indexed by skills.sh from <repo>" placeholder — that string says nothing
   * about the skill, so we surface the provenance and drop the filler.
   */
  provenanceNote?: string;
  /** Registry source: official | skills.sh | github | clawhub | ... */
  source?: string;
  trust?: string;
  /** github only: the publishing org (`extra.provider`). */
  provider?: string;
  category?: string;
  tags?: string[];
  /** browse-sh only: install counter from the catalog. */
  installCount?: number;
  /** browse-sh only: the site the skill automates. */
  hostname?: string;
  /** Computed client-side against the installed set. */
  installed?: boolean;
}

export type SkillOrigin = 'builtin' | 'hub' | 'local';

/**
 * Can `hermes skills uninstall` remove a skill with this origin?
 *
 * `builtin` shipped with the device, `hub` came from the store, and `local` is a
 * skill directory that is NEITHER — written by the agent, hand-copied, or left
 * behind by a failed install rollback or a partial removal. The CLI works off
 * the hub LOCK, so only `hub` can be removed; the other two need someone to
 * delete the folder on the device.
 *
 * This is one exported rule rather than a comparison repeated per call site
 * because BOTH surfaces that answer the question read it — the Skills page
 * (src/components/HermesSkillsStore.tsx) and the agent's skill_list /
 * skill_uninstall (mcp/tools/skills.ts) — and one device state that gets two
 * answers is a bug the customer sees as their own page and their assistant
 * disagreeing. That is exactly what happened: the MCP side had spelled the rule
 * "not builtin", which put `local` on the removable side.
 */
export function isRemovableOrigin(origin?: string): boolean {
  return origin === 'hub';
}

/** Card payload for the Installed grid — everything comes from disk. */
export interface InstalledHermesSkill {
  /** Skill name — the lock.json key and the `uninstall` positional argument. */
  id: string;
  name: string;
  category: string;
  description?: string;
  /** How it got here: builtin | official | clawhub | skills.sh | ... */
  source: string;
  /** Full registry identifier when known (hub-installed skills carry one). */
  identifier?: string;
  trust?: string;
  /** Installer security scan verdict (hub-installed only): safe | ... */
  scanVerdict?: string;
  scanFindingCount?: number;
  /**
   * builtin = shipped with the device (in .bundled_manifest);
   * hub     = installed from the store (present in lock.json);
   * local   = created on the device by the agent itself.
   */
  origin: SkillOrigin;
  installedAt?: string;
  updatedAt?: string;
  fileCount?: number;
  bytes?: number;
  platforms?: string[];
  tags?: string[];
  /** platforms declared and `linux` not among them — it can't run here. */
  incompatible?: boolean;
  enabled?: boolean;
}

export interface ScanFinding {
  patternId?: string;
  severity?: string;
  category?: string;
  file?: string;
  line?: number;
  description?: string;
}

export interface SkillRequirements {
  /** `present: null` = not probed (we only probe for installed skills). */
  commands: { name: string; present: boolean | null }[];
  envVars: string[];
  dependencies: string[];
  credentialFiles: { path: string; description?: string }[];
  compatibility?: string;
  setupHelp?: string;
  setupHelpUrl?: string;
  secrets: { label: string; envVar?: string; providerUrl?: string }[];
}

export interface SkillProvenance {
  sourceUrl?: string;
  /** false when the URL was DERIVED from the identifier rather than published. */
  sourceUrlVerified: boolean;
  repoUrl?: string;
  detailUrl?: string;
  homepage?: string;
  installCommand?: string;
  installCount?: number;
  hostname?: string;
  revision?: string;
}

export interface SkillSecurity {
  verdict?: string;
  scannerVersion?: string;
  scannedAt?: string;
  summary?: string;
  contentHashShort?: string;
  findings: ScanFinding[];
}

export interface SkillInstallInfo {
  origin: SkillOrigin;
  installedAt?: string;
  updatedAt?: string;
  fileCount?: number;
  bytes?: number;
  supportDirs: string[];
  installPath?: string;
}

/** Where a detail view's markdown body came from. */
export type SkillBodySource = 'disk' | 'official-disk' | 'cli-preview' | 'none';

/**
 * Deep detail for a single skill (from the `inspect` route). Phase 1 is served
 * without ever touching the CLI; phase 2 (`&docs=1`) adds the remote preview.
 */
export interface HermesSkillDetail {
  id: string;
  name: string;
  description?: string;
  provenanceNote?: string;
  source?: string;
  trust?: string;
  provider?: string;
  category?: string;
  tags?: string[];
  version?: string;
  author?: string;
  license?: string;
  platforms?: string[];
  relatedSkills?: string[];
  incompatible?: boolean;
  requirements?: SkillRequirements;
  provenance?: SkillProvenance;
  security?: SkillSecurity;
  install?: SkillInstallInfo;
  /** SKILL.md markdown below the frontmatter — rendered via chat-markdown. */
  body?: string;
  bodySource: SkillBodySource;
  bodyTruncated: boolean;
  /** True when a `&docs=1` fetch would add documentation we don't have yet. */
  needsRemoteDocs: boolean;
  headings?: { level: 2 | 3; text: string; slug: string }[];
}

/** `inspect` printed a disambiguation table instead of a skill panel. */
export interface AmbiguousSkillResponse {
  ambiguous: true;
  query: string;
  candidates: HermesSkill[];
}

export interface CatalogFacet {
  id: string;
  label: string;
  count: number;
}

export interface CatalogMeta {
  /** index = offline catalog; cli = CLI fallback; warming = index being built. */
  origin: 'index' | 'cli' | 'warming';
  /** When the REGISTRY built the catalog — baked in upstream, not a device fact. */
  generatedAt?: string;
  /** When THIS device last downloaded it — the only date staleness can key on. */
  fetchedAt?: string;
  skillCount?: number;
  stale?: boolean;
}

export interface CatalogFacets {
  sources: CatalogFacet[];
  providers: CatalogFacet[];
  /** builtin+official collapsed to one bucket — see `trustBucket`. */
  trust: CatalogFacet[];
  /** Normalised `extra.category`; junk and empty values never appear. */
  categories: CatalogFacet[];
}

/**
 * Where a facet count was measured.
 *
 * `catalog` — over every row the query matches, so a count is the number of
 * skills the filter would actually reach.
 * `loaded`  — over the rows in THIS answer only. The CLI fallback has no index
 * to count against, and TASK-452 was full of surfaces that stated a number
 * confidently and wrongly, so the client says "of the {n} loaded" rather than
 * presenting a page total as a catalogue total.
 */
export type FacetScope = 'catalog' | 'loaded';

export interface BrowseResponse {
  skills: HermesSkill[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
  facets: CatalogFacets;
  /**
   * How many of the `total` matching rows carry a usable category. Only 739 of
   * the device's 90 605 rows do, so the rail states the coverage instead of
   * implying that the category buckets add up to the result count.
   */
  categoryCoverage: number;
  facetScope: FacetScope;
  catalog: CatalogMeta;
  /** True when the answer came from the CLI fallback (no paging, top-N only). */
  degraded: boolean;
}

/**
 * Why a skills route's CLI call could not answer. The route's `error` sentence
 * is English composed on the server, for the log and for a caller with no
 * locale. The store — and the MCP tool's rules — read the CODE, the way the
 * install route's own refusals are already read.
 */
export const CLI_FAILURE_CODES = ['cli_timeout', 'cli_missing', 'cli_failed', 'cancelled', 'too_large'] as const;
export type CliFailureCode = (typeof CLI_FAILURE_CODES)[number];

export function isCliFailureCode(value: unknown): value is CliFailureCode {
  return typeof value === 'string' && (CLI_FAILURE_CODES as readonly string[]).includes(value);
}

/**
 * What the BROWSE route can refuse with: every CLI failure, plus the one
 * refusal the owner caused and can undo. A search the route will not run — it
 * caps the length and rejects a leading `-`, both of which the search box lets
 * you type — is a 400, and a 400 carrying no code read as "the catalogue could
 * not be loaded, retry": the wrong story and a button that cannot help.
 */
export const BROWSE_FAILURE_CODES = [...CLI_FAILURE_CODES, 'bad_query'] as const;
export type BrowseFailureCode = (typeof BROWSE_FAILURE_CODES)[number];

export function isBrowseFailureCode(value: unknown): value is BrowseFailureCode {
  return typeof value === 'string' && (BROWSE_FAILURE_CODES as readonly string[]).includes(value);
}

/**
 * Classify a runHermesCli / skills-gate rejection by the message it settled
 * with — the test the install route applies to its own timeout. The messages
 * are runHermesCli's ("hermes timed out", "hermes call cancelled", the spawn
 * failures, the output cap) and the gate's SkillsCliAborted ("Request
 * cancelled"). Anything unrecognised is a plain failure.
 */
export function cliFailureCode(err: unknown): CliFailureCode {
  const message = err instanceof Error ? err.message : '';
  if (/timed out/i.test(message)) return 'cli_timeout';
  if (/not installed/i.test(message)) return 'cli_missing';
  if (/exceeded the size limit/i.test(message)) return 'too_large';
  if (/cancelled/i.test(message)) return 'cancelled';
  return 'cli_failed';
}

/**
 * The fixed sentence a skills route answers for a CLI failure — the log's twin
 * in the response, for a caller with no locale. Never the exception's own
 * message: the routes' try blocks cover lock and filesystem work as well as
 * the spawn, and an I/O error names absolute device paths.
 */
export const CLI_FAILURE_SENTENCES: Record<CliFailureCode, string> = {
  cli_timeout: "The device's Hermes command took too long and was stopped.",
  cli_missing: 'Hermes is not installed on this device.',
  cli_failed: "The device's Hermes command failed.",
  cancelled: 'The request was cancelled.',
  too_large: "The device's answer was too large to use.",
};

/** How many values one facet group may carry, and how many may be selected. */
export const MAX_FACET_VALUES = 24;
export const MAX_FACET_SELECTION = 12;

// The fixed set of discovery sources Hermes' `--source` flag accepts. `all` is
// the (default) firehose; the rest narrow to one registry. Anything outside
// this set is rejected so a request can't smuggle an arbitrary value.
export const HERMES_SKILL_SOURCES = [
  'all',
  'official',
  'skills-sh',
  'well-known',
  'github',
  'clawhub',
  'lobehub',
  'browse-sh',
  'nvidia',
  'openai',
  'anthropic',
  'huggingface',
  'voltagent',
  'gstack',
  'minimax',
] as const;

const SOURCE_SET = new Set<string>(HERMES_SKILL_SOURCES);

export function isValidSource(source: string): boolean {
  return SOURCE_SET.has(source);
}

// Sources that exist in the offline catalog but have NO `--source` flag: the
// index spells skills.sh with a dot, ships a one-entry `claude-marketplace`, and
// leaves `unknown` on rows with no source at all. They're valid to FILTER on
// (that happens in memory) but must never be handed to the CLI, so they live in
// their own set rather than being bolted onto the flag allowlist.
const CATALOG_ONLY_SOURCES = new Set(['skills.sh', 'claude-marketplace', 'unknown']);

export function isBrowsableSource(source: string): boolean {
  return SOURCE_SET.has(source) || CATALOG_ONLY_SOURCES.has(source);
}

// The index writes `skills.sh` where the CLI flag is `skills-sh`; both spellings
// reach the UI, so the label map covers each.
export const SOURCE_LABELS: Record<string, string> = {
  all: 'All sources',
  official: 'Official',
  'skills-sh': 'skills.sh',
  'skills.sh': 'skills.sh',
  'well-known': 'Well-known',
  github: 'GitHub',
  clawhub: 'ClawHub',
  lobehub: 'LobeHub',
  'browse-sh': 'browse.sh',
  'claude-marketplace': 'Claude marketplace',
  builtin: 'Built-in',
  hub: 'Installed',
  nvidia: 'NVIDIA',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  huggingface: 'Hugging Face',
  voltagent: 'VoltAgent',
  gstack: 'gstack',
  minimax: 'MiniMax',
};

export function sourceLabel(source?: string): string {
  if (!source) return 'Unknown source';
  return SOURCE_LABELS[source] || source;
}

/** Normalise an index/CLI source string to the `--source` flag spelling. */
export function sourceFlagValue(source: string): string {
  return source === 'skills.sh' ? 'skills-sh' : source;
}

export interface TrustMeta {
  label: string;
  icon: string;
  tone: 'brand' | 'good' | 'warn' | 'muted';
  help: string;
}

// One vocabulary for trust across cards, detail and dialogs. `builtin` and
// `official` are the same story to a customer; `community` is deliberately amber
// (NOT grey) — grey reads as "no information", which is a different risk.
export const TRUST_META: Record<TrustLevel, TrustMeta> = {
  builtin: {
    label: 'Official',
    icon: 'verified',
    tone: 'brand',
    help: 'Published by Hermes and shipped with your device.',
  },
  official: {
    label: 'Official',
    icon: 'verified',
    tone: 'brand',
    help: 'Published by Hermes and shipped with your device.',
  },
  trusted: {
    label: 'Trusted',
    icon: 'verified_user',
    tone: 'good',
    help: 'From a reviewed publisher.',
  },
  community: {
    label: 'Community',
    icon: 'groups',
    tone: 'warn',
    help: 'Anyone can publish here. Review the skill before installing.',
  },
  unknown: {
    label: 'Unknown',
    icon: 'help',
    tone: 'muted',
    help: 'No trust information for this skill.',
  },
};

export function trustMeta(trust?: string): TrustMeta {
  const key = (trust || '').toLowerCase();
  if (key === 'builtin' || key === 'official' || key === 'trusted' || key === 'community') {
    return TRUST_META[key];
  }
  return TRUST_META.unknown;
}

export const SORT_OPTIONS = ['relevance', 'name', 'trust', 'popular'] as const;
export type SortOption = (typeof SORT_OPTIONS)[number];

export function isValidSort(value: string): value is SortOption {
  return (SORT_OPTIONS as readonly string[]).includes(value);
}

/** True when the string contains any ASCII control char (0x00-0x1f or 0x7f). */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

// Registry identifier for `install`. Real ids contain dots
// (`browse-sh/github.com/...`), slashes, and 4+ segments
// (`skills-sh/anthropics/skills/pdf`), so the charset is deliberately wide —
// but we still reject flag-smuggling, traversal, and control chars.
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export interface IdCheck {
  ok: boolean;
  /**
   * Always false — direct-URL installs are disabled (see below). Kept on the
   * interface so callers that branch on it stay valid.
   */
  isUrl?: boolean;
}

/**
 * Validate an install identifier. ONLY registry identifiers (`source/skill/...`
 * from the fixed source allowlist) are accepted.
 *
 * Direct-URL installs are DELIBERATELY rejected. `hermes skills install <URL>`
 * makes the CLI fetch an arbitrary endpoint server-side — an SSRF vector
 * (hostname allow/deny lists are bypassable via DNS rebinding) and a
 * supply-chain risk (unvetted code onto the device). A customer store only
 * needs the curated registries, so URL installs have no place here.
 */
export function checkInstallIdentifier(id: string): IdCheck {
  if (typeof id !== 'string') return { ok: false };
  const v = id.trim();
  if (!v || v.length > 256) return { ok: false };
  if (v.startsWith('-')) return { ok: false }; // flag injection
  // Reject anything scheme-like (http:, https:, file:, data:, //host, ...):
  // no direct-URL installs.
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith('//')) return { ok: false };
  if (!IDENTIFIER_RE.test(v)) return { ok: false };
  if (v.startsWith('/') || v.endsWith('/')) return { ok: false };
  if (v.includes('//')) return { ok: false }; // empty segment / traversal
  if (v.split('/').includes('..')) return { ok: false }; // path traversal
  return { ok: true, isUrl: false };
}

/**
 * ClawHub's slug shape, as its own resolver defines it
 * (`tools/skills_hub.py` — `ClawHubSource._SLUG_RE`).
 */
const CLAWHUB_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The identifier `hermes skills install` must be given for a catalog id.
 *
 * ClawHub is the ONLY registry in the index whose identifiers carry no source
 * prefix: all 69 150 of its rows are a bare slug with empty `repo`/`path`,
 * while official/github/skills.sh/lobehub/browse-sh rows are all prefixed.
 * `hermes skills install` sends a slash-less argument through
 * `_resolve_short_name()`, which only accepts an exact match on the catalog
 * NAME — and a ClawHub row's name is its display name ("QR Code Decode") while
 * its identifier is the slug ("qrcode-decode"). So it never matched, the CLI
 * printed a "did you mean…" table, exited 0 having installed nothing, and this
 * route answered 502 "Skill could not be resolved" for an id that search had
 * just handed out verbatim — a guaranteed retry loop for the agent and a dead
 * Install button for three quarters of the store.
 *
 * `ClawHubSource._parse_identifier` accepts `clawhub/<slug>`, and the slash
 * makes the CLI skip short-name resolution and go straight to the adapters.
 * So a bare slug is sent as `clawhub/<slug>`.
 *
 * `source` is the catalog record's source when the index could be read. It is
 * undefined on a device whose index has not been built yet (the browse route's
 * degraded CLI path) — a bare slug is still mapped there, because ClawHub is
 * the only place one can have come from and Hermes' own short-name fallback is
 * a cross-registry fuzzy match its authors call provenance-unsafe.
 */
export function cliInstallIdentifier(id: string, source?: string): string {
  const v = typeof id === 'string' ? id.trim() : '';
  if (!v || v.includes('/')) return v;
  if (source !== undefined && source !== 'clawhub') return v;
  return CLAWHUB_SLUG_RE.test(v) ? `clawhub/${v}` : v;
}

// Skill NAME for `uninstall` — a single lock.json key, no slashes.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidSkillName(name: string): boolean {
  if (typeof name !== 'string') return false;
  const v = name.trim();
  if (!v || v.length > 128) return false;
  if (v.startsWith('-')) return false;
  return NAME_RE.test(v);
}

// `--category` / `--name` override values, and the `provider` facet value.
const META_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

export function isValidMeta(value: string, maxLen = 64): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v || v.length > maxLen) return false;
  if (v.startsWith('-')) return false;
  if (v.includes('..')) return false;
  return META_RE.test(v);
}

// A query is POSITIONAL (never read as a flag), but we still cap length, reject
// a leading "-" defensively, and forbid control chars. Spaces/printable text OK.
export function isValidQuery(q: string): boolean {
  if (typeof q !== 'string') return false;
  const v = q.trim();
  if (!v || v.length > 128) return false;
  if (v.startsWith('-')) return false;
  return !hasControlChar(v);
}

/**
 * How deep Browse can page.
 *
 * The old cap was 1000. The catalogue holds ~90 200 rows and the endpoint
 * cheerfully advertised `totalPages: 3760, hasMore: true` at page 1000 — and
 * then 400ed page 1001, so the infinite-scroll sentinel asked for a page the
 * server had just promised and got an error. At the UI's page size that made
 * 73 % of the catalogue unreachable and the last scroll of every deep browse
 * an error state.
 *
 * The catalogue is an in-memory array that is sorted once at load, so an offset
 * this large costs a slice and nothing else — the cap was never about
 * performance. It is kept only as a bound on a hostile query string, set above
 * `ceil(rows / min page size)` for any catalogue this device can hold, and the
 * response now clamps `totalPages`/`hasMore` to it so the client is never told
 * about a page it may not ask for.
 */
export const MAX_BROWSE_PAGE = 200_000;

export function clampInt(raw: string | null, min: number, max: number, fallback: number): number | null {
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

/** Human file size for a skill directory. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Split a source URL into a `{ head, tail }` pair for display, where `tail`
 * holds the part that IDENTIFIES this specific skill.
 *
 * WHY this exists: the store paints a skill's "Source" link as the raw URL
 * under a CSS `truncate` (overflow-ellipsis, end-clipped). Every browse.sh
 * skill's per-skill URL is real and distinct —
 *   https://github.com/browserbase/browse.sh/blob/main/skills/seatguru.com/get-seat-map-dog7jd/SKILL.md
 * — but they share a ~48-char prefix, and the tail that tells one skill from
 * the next is exactly the half the ellipsis eats. So on screen every skill's
 * Source read the same `github.com/browserbase/browse.sh/blob/main/skill…`,
 * which looks like the collection, not the skill (verified on-device: the
 * catalog holds 440 DISTINCT browse.sh source_urls, so the href was never the
 * bug — the rendering was). Pinning `tail` and letting only `head` clip keeps
 * the identifying segment on screen at any width, and the two parts still
 * concatenate to the exact URL, so nothing is invented or hidden.
 *
 * `tail` is the last path segment, or the last TWO when the final one is a
 * generic in-repo filename (SKILL.md, README, index.*, or any bare `*.md`) that
 * would identify nothing on its own. A URL with no path (a bare host, a
 * homepage) has no boilerplate to elide and comes back entirely as `tail`.
 */
export function sourceUrlParts(url: string): { head: string; tail: string } {
  const noScheme = url.replace(/^https?:\/\//i, '');
  const cut = noScheme.search(/[?#]/);
  // The path only — a `?query`/`#hash` is not part of the boilerplate to elide,
  // and rides along on the tail via the offset slice below.
  const pathPart = cut === -1 ? noScheme : noScheme.slice(0, cut);
  const segs = pathPart.split('/').filter(Boolean);
  const host = segs[0] ?? '';
  const pathSegs = segs.slice(1);
  // Only a DEEP path carries the shared boilerplate the clip was eating. A bare
  // host or a shallow `host/a/b` already fits and identifies itself, so it is
  // returned whole (head empty) rather than split for the sake of it.
  if (pathSegs.length < 3) return { head: '', tail: noScheme };
  const GENERIC_FILE = /^(?:skill\.md|readme(?:\.[a-z0-9]+)?|index\.[a-z0-9]+|[a-z0-9._-]+\.md)$/i;
  const last = pathSegs[pathSegs.length - 1];
  const tailCount = GENERIC_FILE.test(last) && pathSegs.length >= 2 ? 2 : 1;
  const tailSegs = pathSegs.slice(pathSegs.length - tailCount);
  // Split by OFFSET, not by re-joining: the marker is the slash-prefixed tail
  // segments, and everything from it onward (a trailing slash, the query/hash
  // suffix) is the tail. `head + tail === noScheme` byte-for-byte for every
  // input — including a deep URL ending in `/` — because nothing is rebuilt
  // from the boolean-filtered segments; the original string is only sliced.
  const marker = `/${tailSegs.join('/')}`;
  const idx = pathPart.lastIndexOf(marker);
  const head = noScheme.slice(0, idx + 1);
  const tail = noScheme.slice(idx + 1);
  return { head, tail };
}
