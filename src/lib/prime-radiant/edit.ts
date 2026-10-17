/**
 * Direct edits to the vault: a page created, edited, deleted or merged into
 * another, a claim added, edited or deleted, a claim verified as it stands.
 * The routes under `pages` and `claims` answer from here, for the owner and
 * for the assistant through the box's MCP server alike.
 *
 * Every change is ONE {@link vaultOperation}: the vault's lock, the scoped lint
 * that refuses the four blocking rules, and one commit naming its author — so
 * History shows it and Undo reverses it. Everything a change depends on is
 * read again under the lock, the way verify.ts does.
 *
 * Two rules keep a person's word what it was:
 *
 *   - a VERIFIED claim (by the owner or the assistant) changes its text only
 *     by being verified again (verify.ts): an edit is refused `verified`, since
 *     it would leave a verification stamp on words nobody verified. Deleting one is allowed
 *     and is in History like every other change.
 *   - a deleted claim is REMOVED, not retired. Retiring is what a verification
 *     does to a losing answer, and a retired id is refused for good — so the
 *     delete could not be undone (lint's `claim-id-retired-reuse`). The id is
 *     free to come back.
 *   - a merge MOVES claims: the same id, the same text, the same verification
 *     on the page that stays. One it cannot move so — its id on a different
 *     claim there already — refuses the merge, and says which. The page that
 *     stays keeps its body byte for byte unless the caller lets it change
 *     (`keep_into_body: false`): only its frontmatter takes the merge.
 *
 * Request bodies are read strictly here (`readNewPage`, `readPagePatch`, …):
 * an unknown field or a wrong type is a 400, never silently dropped.
 *
 * SERVER ONLY.
 */

import { allocateClaimId, assertClaimIdAvailable, buildClaimIndex, ClaimIdError, isClaimId, nowIso, slugify, type ClaimIndex } from "./claims";
import { pageSummary, parsePage, serializeFrontmatter, splitFrontmatter } from "./frontmatter";
import type { VaultAuthor } from "./git";
import { createLinkResolver, extractLinks, pathAliases, relativeHref, rewriteLinks, type FoundLink } from "./links";
import { LIMITS, lintVault, type LintFinding } from "./lint";
import { isKnowledgePage, safePagePath, vaultDir } from "./paths";
import { withPluginFields } from "./plugin-compat";
import { followMovedClaims } from "./review-store";
import {
  isIsoDate,
  PAGE_STATUSES,
  PAGE_TYPES,
  PRIVACY_TIERS,
  SLUG_RE,
  type Claim,
  type ClaimEvidence,
  type PageFrontmatter,
  type PageStatus,
  type PageType,
  type PrivacyTier,
} from "./schema";
import { readSettings } from "./settings";
import { reconcileStaleText, type SupersededFact } from "./stale-text";
import { readRetiredLedger, syncActiveClaims } from "./state-db";
import {
  INDEX_FILE,
  indexedPaths,
  readListedPage,
  readVaultSnapshot,
  vaultInitialised,
  VaultLintBlockedError,
  vaultOperation,
  VaultPathError,
  type VaultPage,
  type VaultSnapshot,
  type VaultTx,
} from "./vault";
import { cleanVerifiedText, MAX_VERIFIED_TEXT, verifyClaim, type VerifyResult } from "./verify";
import { addToIndex, DEFAULT_OWNER, pathFor, removeFromIndex } from "./writer";

export const MAX_TITLE_CHARS = 200;
export const MAX_OWNER_CHARS = 80;
export const MAX_SOURCES = 20;
export const MAX_SOURCE_CHARS = 300;
/** A claim nobody vouched for yet: below a source-backed one, above a guess. */
export const DEFAULT_CLAIM_CONFIDENCE = 0.8;

export class PageEditError extends Error {
  constructor(
    readonly code:
      | "invalid"
      | "not_initialised"
      | "not_found"
      | "exists"
      | "invalid_page"
      | "verified"
      | "taken"
      | "retired"
      | "too_many_claims"
      | "deprecated"
      | "too_long"
      | "into_links",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PageEditError";
  }
}

/** Who makes a change: as stamps record it, as the commit names it, and whether a person did. */
export interface EditWho {
  /** "owner" or "assistant". */
  by: string;
  /** "assistant" on the owner's word carried out by the assistant (route-helpers.ts `OWNER_VIA_ASSISTANT_WRITER`). */
  via?: string;
  author?: VaultAuthor;
  /** A person's word (the owner's), not the assistant's. Default false. */
  person?: boolean;
}

export interface EditOptions {
  vault?: string;
  now?: Date;
}

/** The non-blocking findings a change left, in the shape the routes answer. */
export interface EditFinding {
  rule: string;
  severity: string;
  path: string;
  message: string;
}

function findingsOf(findings: readonly LintFinding[]): EditFinding[] {
  return findings.map((f) => ({ rule: f.rule, severity: f.severity, path: f.path, message: f.message }));
}

// ── reading request bodies ─────────────────────────────────────────────────

const CONTROL_RE = /[\u0000-\u001f\u007f]+/g;
const BODY_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const HEADING_RE = /^#{1,6}\s/;

function bad(message: string): PageEditError {
  return new PageEditError("invalid", message, 400);
}

function objectBody(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("The request body must be a JSON object.");
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) if (!allowed.includes(key)) throw bad(`Unknown field: ${key.slice(0, 40)}.`);
  return b;
}

/** One line of text: control characters and runs of space folded, 1..max characters. */
function oneLine(value: unknown, max: number, field: string): string {
  if (typeof value !== "string") throw bad(`${field} must be text.`);
  const t = value.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
  if (t === "" || t.length > max) throw bad(`${field} is one line of 1 to ${max} characters.`);
  return t;
}

function summaryText(value: unknown): string {
  const t = oneLine(value, LIMITS.summaryMaxChars, "summary");
  if (HEADING_RE.test(t)) throw bad("summary is a sentence or two of prose, not a heading.");
  return t;
}

/** Markdown body text: CRLF folded, control characters other than tab and newline dropped, at most the lint's hard cap. */
function bodyText(value: unknown): string {
  if (typeof value !== "string") throw bad("body must be text.");
  const t = value.replace(/\r\n?/g, "\n").replace(BODY_CONTROL_RE, "").trim();
  if (t.length > LIMITS.bodyHardChars) throw bad(`body is at most ${LIMITS.bodyHardChars} characters; split the page instead.`);
  return t;
}

function oneOf<T extends string>(list: readonly T[], value: unknown, field: string): T {
  if (typeof value !== "string" || !(list as readonly string[]).includes(value)) throw bad(`${field} must be one of ${list.join(", ")}.`);
  return value as T;
}

function domainName(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !SLUG_RE.test(value)) throw bad("domain is lowercase kebab-case, e.g. acme-widgets.");
  return value;
}

function sourceList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SOURCES) throw bad(`sources is a list of at most ${MAX_SOURCES} labels.`);
  return [...new Set(value.map((s) => oneLine(s, MAX_SOURCE_CHARS, "a source")))];
}

function confidenceOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw bad("confidence is a number from 0 to 1.");
  return Math.round(value * 100) / 100;
}

function claimText(value: unknown): string {
  const t = cleanVerifiedText(value);
  if (!t) throw bad(`A claim is one line of 1 to ${MAX_VERIFIED_TEXT} characters.`);
  return t;
}

function claimIdOf(value: unknown): string {
  if (!isClaimId(value)) throw bad("A claim id is <domain>/<entity>/<fact>, each part lowercase kebab-case.");
  return value;
}

function pagePathOf(value: unknown): string {
  const safe = safePagePath(value);
  if (!safe || !isKnowledgePage(safe)) throw new PageEditError("not_found", "No such page.", 404);
  return safe;
}

export interface NewPage {
  type: PageType;
  title: string;
  domain: string;
  summary: string;
  body: string;
  owner: string | null;
  status: PageStatus;
  privacy: PrivacyTier;
  sources: string[];
  facts: string[];
  confidence: number;
}

/** `POST pages`: `{ type, title, domain, summary, body?, owner?, status?, privacy?, sources?, facts?, confidence? }`. */
export function readNewPage(body: unknown): NewPage {
  const b = objectBody(body, ["type", "title", "domain", "summary", "body", "owner", "status", "privacy", "sources", "facts", "confidence"]);
  const facts = b.facts === undefined ? [] : b.facts;
  if (!Array.isArray(facts) || facts.length > LIMITS.maxClaims) throw bad(`facts is a list of at most ${LIMITS.maxClaims} one-line claims.`);
  return {
    type: oneOf(PAGE_TYPES, b.type, "type"),
    title: oneLine(b.title, MAX_TITLE_CHARS, "title"),
    domain: domainName(b.domain),
    summary: summaryText(b.summary),
    body: b.body === undefined ? "" : bodyText(b.body),
    owner: b.owner === undefined ? null : oneLine(b.owner, MAX_OWNER_CHARS, "owner"),
    status: b.status === undefined ? "draft" : oneOf(PAGE_STATUSES, b.status, "status"),
    privacy: b.privacy === undefined ? "internal" : oneOf(PRIVACY_TIERS, b.privacy, "privacy"),
    sources: b.sources === undefined ? [] : sourceList(b.sources),
    facts: [...new Set(facts.map(claimText))],
    confidence: b.confidence === undefined ? DEFAULT_CLAIM_CONFIDENCE : confidenceOf(b.confidence),
  };
}

export interface PagePatch {
  title?: string;
  summary?: string;
  body?: string;
  status?: PageStatus;
  domain?: string;
  owner?: string;
  privacy?: PrivacyTier;
  /** null clears it. */
  stale_after?: string | null;
  /** The day the page's figures were true on (a metric page needs one); null clears it. */
  as_of?: string | null;
  sources?: string[];
}

/** `PATCH pages/<path>`: any of `{ title, summary, body, status, domain, owner, privacy, stale_after, as_of, sources }`. */
export function readPagePatch(body: unknown): PagePatch {
  const b = objectBody(body, ["title", "summary", "body", "status", "domain", "owner", "privacy", "stale_after", "as_of", "sources"]);
  const patch: PagePatch = {};
  if (b.title !== undefined) patch.title = oneLine(b.title, MAX_TITLE_CHARS, "title");
  if (b.summary !== undefined) patch.summary = summaryText(b.summary);
  if (b.body !== undefined) patch.body = bodyText(b.body);
  if (b.status !== undefined) patch.status = oneOf(PAGE_STATUSES, b.status, "status");
  if (b.domain !== undefined) patch.domain = domainName(b.domain);
  if (b.owner !== undefined) patch.owner = oneLine(b.owner, MAX_OWNER_CHARS, "owner");
  if (b.privacy !== undefined) patch.privacy = oneOf(PRIVACY_TIERS, b.privacy, "privacy");
  if (b.stale_after !== undefined) {
    if (b.stale_after !== null && !isIsoDate(b.stale_after)) throw bad("stale_after is an ISO date (YYYY-MM-DD) or null.");
    patch.stale_after = b.stale_after as string | null;
  }
  if (b.as_of !== undefined) {
    if (b.as_of !== null && !isIsoDate(b.as_of)) throw bad("as_of is an ISO date (YYYY-MM-DD) or null.");
    patch.as_of = b.as_of as string | null;
  }
  if (b.sources !== undefined) patch.sources = sourceList(b.sources);
  if (Object.keys(patch).length === 0) throw bad("Name at least one field to change.");
  return patch;
}

export interface NewClaim {
  page: string;
  text: string;
  id: string | null;
  confidence: number;
  source: string | null;
}

/** `POST claims`: `{ page, text, id?, confidence?, source? }`. */
export function readNewClaim(body: unknown): NewClaim {
  const b = objectBody(body, ["page", "text", "id", "confidence", "source"]);
  return {
    page: pagePathOf(b.page),
    text: claimText(b.text),
    id: b.id === undefined || b.id === null ? null : claimIdOf(b.id),
    confidence: b.confidence === undefined ? DEFAULT_CLAIM_CONFIDENCE : confidenceOf(b.confidence),
    source: b.source === undefined || b.source === null ? null : oneLine(b.source, MAX_SOURCE_CHARS, "source"),
  };
}

export interface ClaimPatch {
  text?: string;
  confidence?: number;
  page?: string;
}

/** `PATCH claims/<id>`: `{ text?, confidence?, page? }` — `page` only says which copy, when an id sits on two. */
export function readClaimPatch(body: unknown): ClaimPatch {
  const b = objectBody(body, ["text", "confidence", "page"]);
  const patch: ClaimPatch = {};
  if (b.text !== undefined) patch.text = claimText(b.text);
  if (b.confidence !== undefined) patch.confidence = confidenceOf(b.confidence);
  if (b.page !== undefined && b.page !== null) patch.page = pagePathOf(b.page);
  if (patch.text === undefined && patch.confidence === undefined) throw bad("Name the new text or confidence.");
  return patch;
}

/** `DELETE claims/<id>` and `POST claims/verify` name a page the same way: optional, for an id on two pages. */
export function readClaimPage(body: unknown): string | null {
  const b = objectBody(body ?? {}, ["page"]);
  return b.page === undefined || b.page === null ? null : pagePathOf(b.page);
}

export interface VerifyRequest {
  id: string;
  text: string | null;
  page: string | null;
  /** The assistant's word that the user confirmed the fact (the MCP tool's `confirm: true`); the route reads it. */
  confirm: boolean;
}

/** `POST claims/verify`: `{ id, text?, page?, confirm? }` — no text verifies the claim as it stands. */
export function readVerifyRequest(body: unknown): VerifyRequest {
  const b = objectBody(body, ["id", "text", "page", "confirm"]);
  if (b.confirm !== undefined && typeof b.confirm !== "boolean") throw bad("confirm must be true or false.");
  return {
    id: claimIdOf(b.id),
    text: b.text === undefined || b.text === null ? null : claimText(b.text),
    page: b.page === undefined || b.page === null ? null : pagePathOf(b.page),
    confirm: b.confirm === true,
  };
}

/** Pages one merge folds into its target, at most. */
export const MAX_MERGE_PAGES = 20;

export interface PageMerge {
  into: string;
  from: string[];
  dryRun: boolean;
  /** Leave `into`'s body exactly as it is (the default): only its frontmatter changes. */
  keepIntoBody: boolean;
}

function mergePath(value: unknown, field: string): string {
  if (typeof value !== "string") throw bad(`${field} names pages by their vault path, e.g. entities/acme-widgets.md.`);
  const safe = safePagePath(value);
  if (!safe || !isKnowledgePage(safe)) throw new PageEditError("not_found", `No such page: ${value.slice(0, 120)}.`, 404);
  return safe;
}

/** `POST pages/merge`: `{ into, from: [1..20 page paths], dry_run?, keep_into_body? }` (keep_into_body defaults to true). */
export function readPageMerge(body: unknown): PageMerge {
  const b = objectBody(body, ["into", "from", "dry_run", "keep_into_body"]);
  const into = mergePath(b.into, "into");
  if (!Array.isArray(b.from) || b.from.length === 0 || b.from.length > MAX_MERGE_PAGES) throw bad(`from is a list of 1 to ${MAX_MERGE_PAGES} page paths.`);
  const from = [...new Set(b.from.map((p) => mergePath(p, "from")))];
  if (from.includes(into)) throw bad("A page cannot be merged into itself: leave the target out of from.");
  if (b.dry_run !== undefined && typeof b.dry_run !== "boolean") throw bad("dry_run is true or false.");
  if (b.keep_into_body !== undefined && typeof b.keep_into_body !== "boolean") throw bad("keep_into_body is true or false.");
  return { into, from, dryRun: b.dry_run === true, keepIntoBody: b.keep_into_body !== false };
}

// ── shared ─────────────────────────────────────────────────────────────────

async function requireVault(vault: string): Promise<void> {
  if (!(await vaultInitialised(vault))) {
    throw new PageEditError("not_initialised", "Prime Radiant has no vault yet: open the app once to create it.", 412);
  }
}

function ledger(vault: string): string[] {
  try {
    return readRetiredLedger(vault);
  } catch {
    return [];
  }
}

function validPages(snapshot: VaultSnapshot) {
  return snapshot.pages.flatMap((p) => (p.parsed.ok ? [{ path: p.path, frontmatter: p.parsed.frontmatter, body: p.parsed.body }] : []));
}

function indexOf(snapshot: VaultSnapshot, vault: string): ClaimIndex {
  return buildClaimIndex(validPages(snapshot), ledger(vault));
}

/** The page under the lock, valid, or the refusal that says why not. */
function pageIn(snapshot: VaultSnapshot, rel: string): { path: string; frontmatter: PageFrontmatter; body: string } {
  const page = snapshot.pages.find((p) => p.path === rel);
  if (!page) throw new PageEditError("not_found", "No such page.", 404);
  if (!page.parsed.ok) {
    throw new PageEditError("invalid_page", "That page's frontmatter does not parse; fix it by hand before editing it here.", 409);
  }
  return { path: page.path, frontmatter: page.parsed.frontmatter, body: page.parsed.body };
}

function stampedEvidence(who: EditWho, at: string, source: string | null): ClaimEvidence[] {
  return [source ? { kind: "source", path: source, note: `added by ${who.by}`, updatedAt: at } : { kind: "stated", note: `stated by ${who.by}`, updatedAt: at }];
}

function syncClaims(vault: string, claims: ReadonlyArray<{ id: string; page: string; updatedAt: string }>): void {
  if (claims.length === 0) return;
  try {
    syncActiveClaims(vault, claims);
  } catch {
    // The ledger is a second copy; the page holds the claim.
  }
}

/**
 * `body` with its summary — the first paragraph of prose after any leading
 * headings, as `pageSummary` reads it — replaced by `summary`, or put first
 * when the body has none.
 */
export function withSummary(body: string, summary: string): string {
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && (lines[i].trim() === "" || HEADING_RE.test(lines[i]))) i++;
  let end = i;
  while (end < lines.length && lines[end].trim() !== "" && !HEADING_RE.test(lines[end])) end++;
  if (end === i) return body.trim() === "" ? summary : `${summary}\n\n${body.trim()}`;
  return [...lines.slice(0, i), summary, ...lines.slice(end)].join("\n");
}

// ── pages ──────────────────────────────────────────────────────────────────

export interface PageWriteResult {
  path: string;
  commit: string | null;
  claims: string[];
  findings: EditFinding[];
}

/** A new page, its facts as proposed claims and its line in index.md: one commit, `create: <path>`. */
export async function createPage(input: NewPage, who: EditWho, options: EditOptions = {}): Promise<PageWriteResult> {
  const vault = options.vault ?? vaultDir();
  await requireVault(vault);
  const before = await readVaultSnapshot(vault);
  const path = pathFor(input.type, input.title, new Set(before.pages.map((p) => p.path)));
  const at = nowIso(options.now);
  const written: Claim[] = [];
  const op = await vaultOperation(
    `create: ${path}`,
    async (tx) => {
      const snapshot = await tx.snapshot();
      if (snapshot.pages.some((p) => p.path === path)) throw new PageEditError("exists", "A page was written at that path a moment ago; try again.", 409);
      const index = indexOf(snapshot, tx.vault);
      const entity = slugify(input.title, 48);
      const used = new Set<string>();
      for (const fact of input.facts) {
        const id = allocateClaimId(index, input.domain, entity, slugify(fact, 48), path, used);
        used.add(id);
        written.push({ id, text: fact, confidence: input.confidence, status: "proposed", updatedAt: at, evidence: stampedEvidence(who, at, input.sources[0] ?? null) });
      }
      const owner = input.owner ?? readSettings().domains.find((d) => d.name === input.domain)?.owner ?? DEFAULT_OWNER;
      const frontmatter: PageFrontmatter = {
        type: input.type,
        title: input.title,
        domain: input.domain,
        owner,
        status: input.status,
        generated: { at, by: who.by },
        verified: null,
        stale_after: null,
        sources: input.sources.length > 0 ? input.sources : [who.by],
        privacy: input.privacy,
        checked_by: who.person ? "human" : "flash",
        opus_pending: false,
        claims: written,
        retiredClaimIds: [],
      };
      await tx.writePage(path, frontmatter, input.body === "" ? input.summary : `${input.summary}\n\n${input.body}`);
      const next = addToIndex(snapshot.indexBody, [{ path, title: input.title }]);
      if (next !== snapshot.indexBody) await tx.write(INDEX_FILE, next);
    },
    { vault, now: options.now, author: who.author },
  );
  if (op.commit) syncClaims(vault, written.map((c) => ({ id: c.id, page: path, updatedAt: c.updatedAt })));
  return { path, commit: op.commit, claims: written.map((c) => c.id), findings: findingsOf(op.findings) };
}

export interface PageEditResult extends PageWriteResult {
  /** The fields that changed; empty when the patch matched the page already. */
  changed: string[];
}

/**
 * The fields a metadata edit changes. None of them moves a title, a word of
 * the body, a claim or a link, so a change of these alone is linted on its
 * own page (vault.ts `lint: "pages"`) and leaves Memory Shard's index as it
 * is: what it embeds of a page is its title, body and claims.
 */
const METADATA_FIELDS: ReadonlySet<string> = new Set(["status", "domain", "owner", "privacy", "stale_after", "as_of", "sources"]);

/** The page `rel` under the lock, read alone; null also for a path deeper than the vault's walk reaches (`tx.read` refuses it), which is no page. */
function txRead(tx: VaultTx, rel: string): Promise<VaultPage | null> {
  return tx.read(rel).catch((err) => {
    if (err instanceof VaultPathError) return null;
    throw err;
  });
}

/** The page `rel` under the lock, read alone, or the refusal that says why not. */
async function txPage(tx: VaultTx, rel: string): Promise<{ path: string; frontmatter: PageFrontmatter; body: string; text: string }> {
  const page = await txRead(tx, rel);
  if (!page) throw new PageEditError("not_found", "No such page.", 404);
  if (!page.parsed.ok) {
    throw new PageEditError("invalid_page", "That page's frontmatter does not parse; fix it by hand before editing it here.", 409);
  }
  return { path: page.path, frontmatter: page.parsed.frontmatter, body: page.parsed.body, text: page.text };
}

/**
 * Change a page's body, summary or frontmatter fields: one commit, `edit: <path>`. Its claims are untouched.
 * The page is read alone; a change of {@link METADATA_FIELDS} only is linted
 * on that page alone and not re-embedded.
 */
export async function editPage(rel: string, patch: PagePatch, who: EditWho, options: EditOptions = {}): Promise<PageEditResult> {
  const vault = options.vault ?? vaultDir();
  const path = pagePathOf(rel);
  await requireVault(vault);
  const at = nowIso(options.now);
  const changed: string[] = [];
  const metadataOnly = Object.keys(patch).every((key) => METADATA_FIELDS.has(key));
  const op = await vaultOperation(
    `edit: ${path}`,
    async (tx) => {
      const page = await txPage(tx, path);
      if (page.frontmatter.verified && !who.person) {
        throw new PageEditError("verified", "A person verified this page as a whole; raise a review item for the owner instead of editing it.", 409);
      }
      let body = patch.body ?? page.body;
      if (patch.summary !== undefined) body = withSummary(body, patch.summary);
      const fm: PageFrontmatter = { ...page.frontmatter };
      const set = <K extends keyof PagePatch & keyof PageFrontmatter>(key: K) => {
        const value = patch[key];
        if (value === undefined) return;
        if (JSON.stringify(fm[key]) !== JSON.stringify(value)) changed.push(key);
        (fm as Record<string, unknown>)[key] = value;
      };
      for (const key of ["title", "status", "domain", "owner", "privacy", "stale_after", "sources"] as const) set(key);
      if (patch.as_of !== undefined && JSON.stringify(fm.as_of ?? null) !== JSON.stringify(patch.as_of)) {
        changed.push("as_of");
        if (patch.as_of === null) delete fm.as_of;
        else fm.as_of = patch.as_of;
      }
      if (body.trim() !== page.body.trim()) changed.push(patch.summary !== undefined && patch.body === undefined ? "summary" : "body");
      if (changed.length === 0) return;
      fm.generated = { at, by: who.by };
      await tx.writePage(path, fm, body);
    },
    { vault, now: options.now, author: who.author, ...(metadataOnly ? { lint: "pages" as const, reindex: false } : {}) },
  );
  return { path, commit: op.commit, claims: [], changed, findings: findingsOf(op.findings) };
}

// ── bulk metadata edits ────────────────────────────────────────────────────

/** Pages one bulk metadata edit names, at most. */
export const MAX_BULK_EDITS = 500;
/** The fields a bulk edit may set on a page: its metadata, never its title, body or claims. */
export const BULK_FIELDS = ["domain", "owner", "privacy", "status"] as const;

export interface BulkPageEdit {
  path: string;
  domain?: string;
  owner?: string;
  privacy?: PrivacyTier;
  status?: PageStatus;
}

/** A page a bulk edit leaves as it is, and why: the code a PATCH of that page alone would answer. */
export interface BulkRefusal {
  path: string;
  code: PageEditError["code"] | "lint_blocked";
  error: string;
}

export interface PageBulkEdit {
  /** In the request's order: an edit to make, or one refused as it was read. */
  edits: Array<{ edit: BulkPageEdit } | { refused: BulkRefusal }>;
  dryRun: boolean;
}

/** One edit of `POST pages/bulk`: `{ path, domain?, owner?, privacy?, status? }`, read as strictly as PATCH reads its body. */
function readBulkEdit(value: unknown): BulkPageEdit {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad("Each edit is a JSON object: { path, domain?, owner?, privacy?, status? }.");
  const b = objectBody(value, ["path", ...BULK_FIELDS]);
  const edit: BulkPageEdit = { path: mergePath(b.path, "path") };
  if (b.domain !== undefined) edit.domain = domainName(b.domain);
  if (b.owner !== undefined) edit.owner = oneLine(b.owner, MAX_OWNER_CHARS, "owner");
  if (b.privacy !== undefined) edit.privacy = oneOf(PRIVACY_TIERS, b.privacy, "privacy");
  if (b.status !== undefined) edit.status = oneOf(PAGE_STATUSES, b.status, "status");
  if (Object.keys(edit).length === 1) throw bad(`Name at least one of ${BULK_FIELDS.join(", ")} to change.`);
  return edit;
}

/**
 * `POST pages/bulk`: `{ edits: [1..500 of { path, domain?, owner?, privacy?, status? }], dry_run? }`.
 * The request itself is read strictly (a 400 for its shape); an edit that is
 * wrong on its own — a bad domain, no such page, an unknown field, a page
 * named twice — is refused alone, the others still go.
 */
export function readPageBulk(body: unknown): PageBulkEdit {
  const b = objectBody(body, ["edits", "dry_run"]);
  if (!Array.isArray(b.edits) || b.edits.length === 0 || b.edits.length > MAX_BULK_EDITS) {
    throw bad(`edits is a list of 1 to ${MAX_BULK_EDITS} edits, each { path, domain?, owner?, privacy?, status? }.`);
  }
  if (b.dry_run !== undefined && typeof b.dry_run !== "boolean") throw bad("dry_run is true or false.");
  const seen = new Set<string>();
  const edits = b.edits.map((value: unknown): PageBulkEdit["edits"][number] => {
    const asked = value && typeof value === "object" && typeof (value as { path?: unknown }).path === "string" ? (value as { path: string }).path.slice(0, 200) : "";
    try {
      const edit = readBulkEdit(value);
      if (seen.has(edit.path)) throw bad("This page is named more than once; give it one edit with every field it changes.");
      seen.add(edit.path);
      return { edit };
    } catch (err) {
      if (!(err instanceof PageEditError)) throw err;
      return { refused: { path: asked, code: err.code, error: err.message } };
    }
  });
  return { edits, dryRun: b.dry_run === true };
}

export interface PageBulkResult {
  /** Pages whose metadata changed (or, in a dry run, would). */
  changed: string[];
  /** Pages that already said what the edit asked. */
  unchanged: string[];
  refused: BulkRefusal[];
  /** The one commit, `bulk: N pages`; null for a dry run or when nothing changed. */
  commit: string | null;
  dryRun: boolean;
}

type BulkTally = Omit<PageBulkResult, "commit" | "dryRun">;
type BulkOutcome = { path: string; changed: false } | { path: string; changed: true; text: string } | { refused: BulkRefusal };

/**
 * What one edit does to its page, written nowhere: the page's new text (its
 * body the bytes it was, behind the new frontmatter), or the refusal the
 * page's own PATCH would answer — `not_found`, `invalid_page`, `verified`, or
 * `lint_blocked` when the page with its new frontmatter breaks a blocking rule.
 */
function planBulkEdit(page: VaultPage | null, edit: BulkPageEdit, who: EditWho, at: string, ledgerRetired: readonly string[], now: Date | undefined): BulkOutcome {
  const refuse = (code: BulkRefusal["code"], error: string): BulkOutcome => ({ refused: { path: edit.path, code, error } });
  if (!page) return refuse("not_found", "No such page.");
  if (!page.parsed.ok) return refuse("invalid_page", "That page's frontmatter does not parse; fix it by hand before editing it here.");
  const before = page.parsed.frontmatter;
  if (before.verified && !who.person) return refuse("verified", "A person verified this page as a whole; raise a review item for the owner instead of editing it.");
  const fm: PageFrontmatter = { ...before };
  let differs = false;
  for (const key of BULK_FIELDS) {
    const value = edit[key];
    if (value === undefined || fm[key] === value) continue;
    (fm as Record<string, unknown>)[key] = value;
    differs = true;
  }
  if (!differs) return { path: edit.path, changed: false };
  fm.generated = { at, by: who.by };
  const text = `---\n${serializeFrontmatter(withPluginFields(edit.path, fm))}---\n${splitFrontmatter(page.text).body}`;
  const own = { ...page, text, parsed: parsePage(text) };
  const blocking = lintVault({ vault: "", pages: [own], indexBody: null, truncated: false }, { scope: [edit.path], ledgerRetired, now }).findings.filter((f) => f.blocksCommit);
  if (blocking.length > 0) return refuse("lint_blocked", `That change breaks a rule of the vault: ${blocking.map((f) => f.rule).join(", ")}.`);
  return { path: edit.path, changed: true, text };
}

/**
 * Set metadata (domain, owner, privacy, status) on many pages at once: ONE
 * commit, `bulk: N pages`, that Undo reverses whole. Each page is read alone
 * under the lock and only its frontmatter is rewritten; a page that its own
 * PATCH would refuse is listed in `refused`, and the rest still go. The
 * pages are linted on their own (vault.ts `lint: "pages"`) and nothing is
 * re-embedded: no title, body, claim or link changes. `dryRun` answers the
 * same without writing anything.
 */
export async function bulkEditPages(input: PageBulkEdit, who: EditWho, options: EditOptions = {}): Promise<PageBulkResult> {
  const vault = options.vault ?? vaultDir();
  await requireVault(vault);
  const at = nowIso(options.now);
  // Pages the vault's own lint refused when it judged them against the whole
  // vault (a page index.md does not list, a claim id of which is on another
  // page too): left out, and the rest tried again.
  const lintRefused = new Map<string, BulkRefusal>();
  const plan = async (read: (rel: string) => Promise<VaultPage | null>, write: ((rel: string, text: string) => Promise<unknown>) | null) => {
    const ledgerRetired = ledger(vault);
    const out: BulkTally = { changed: [], unchanged: [], refused: [] };
    for (const item of input.edits) {
      if ("refused" in item) {
        out.refused.push(item.refused);
        continue;
      }
      const blocked = lintRefused.get(item.edit.path);
      const outcome = blocked ? { refused: blocked } : planBulkEdit(await read(item.edit.path), item.edit, who, at, ledgerRetired, options.now);
      if ("refused" in outcome) out.refused.push(outcome.refused);
      else if (!outcome.changed) out.unchanged.push(outcome.path);
      else {
        if (write) await write(outcome.path, outcome.text);
        out.changed.push(outcome.path);
      }
    }
    return out;
  };
  if (input.dryRun) return { ...(await plan((rel) => readListedPage(rel, vault), null)), commit: null, dryRun: true };
  for (;;) {
    try {
      const op = await vaultOperation<BulkTally>(
        (r) => `bulk: ${r.changed.length} ${r.changed.length === 1 ? "page" : "pages"}`,
        (tx) => plan((rel) => txRead(tx, rel), (rel, text) => tx.write(rel, text)),
        { vault, now: options.now, author: who.author, lint: "pages", reindex: false },
      );
      return { ...op.result, commit: op.commit, dryRun: false };
    } catch (err) {
      if (!(err instanceof VaultLintBlockedError)) throw err;
      const named = err.findings.filter((f) => !lintRefused.has(f.path) && input.edits.some((e) => "edit" in e && e.edit.path === f.path));
      // A finding on no page of ours, or none left to take out: the refusal stands.
      if (named.length === 0 || named.length < err.findings.length) throw err;
      // The unlisted pages first: they are the ones judged against the whole
      // vault. A listed page refused beside them is tried again, on its own.
      const blocked = [...new Set(named.map((f) => f.path))];
      const listed = await indexedPaths(vault, blocked);
      const unlisted = blocked.filter((p) => !listed.has(p));
      for (const path of unlisted.length > 0 ? unlisted : blocked) {
        const rules = err.findings.filter((x) => x.path === path).map((x) => x.rule);
        lintRefused.set(path, { path, code: "lint_blocked", error: `That change breaks a rule of the vault: ${[...new Set(rules)].join(", ")}.` });
      }
    }
  }
}

export interface PageDeleteResult {
  path: string;
  commit: string | null;
  /** Ids of the claims that went with the page; `verified` the ones that carried a verification. */
  claims: string[];
  verified: string[];
}

/** Remove a page and its index.md line: one commit, `delete: <path>`. Undo puts both back. */
export async function deletePage(rel: string, who: EditWho, options: EditOptions = {}): Promise<PageDeleteResult> {
  const vault = options.vault ?? vaultDir();
  const path = pagePathOf(rel);
  await requireVault(vault);
  const op = await vaultOperation(
    `delete: ${path}`,
    async (tx): Promise<Claim[]> => {
      const snapshot = await tx.snapshot();
      const page = snapshot.pages.find((p) => p.path === path);
      if (!page) throw new PageEditError("not_found", "No such page.", 404);
      await tx.remove(path);
      if (snapshot.indexBody !== null) {
        const next = removeFromIndex(snapshot.indexBody, path);
        if (next !== snapshot.indexBody) await tx.write(INDEX_FILE, next);
      }
      return page.parsed.ok ? page.parsed.frontmatter.claims : [];
    },
    { vault, now: options.now, author: who.author },
  );
  const claims = op.result;
  return { path, commit: op.commit, claims: claims.map((c) => c.id), verified: claims.filter((c) => c.verified).map((c) => c.id) };
}

// ── claims ─────────────────────────────────────────────────────────────────

export interface ClaimWriteResult {
  id: string;
  page: string;
  commit: string | null;
  findings: EditFinding[];
}

/** A new proposed claim on a page, its id given or allocated in the global namespace: one commit, `claim: add <id>`. */
export async function addClaim(input: NewClaim, who: EditWho, options: EditOptions = {}): Promise<ClaimWriteResult> {
  const vault = options.vault ?? vaultDir();
  await requireVault(vault);
  const at = nowIso(options.now);
  // The id is settled before the commit message is: allocated against the
  // vault as it is now, then checked again under the lock.
  const before = await readVaultSnapshot(vault);
  const target = pageIn(before, input.page);
  const onPage = new Set(target.frontmatter.claims.map((c) => c.id));
  const id = input.id ?? allocateClaimId(indexOf(before, vault), target.frontmatter.domain, slugify(target.frontmatter.title, 48), slugify(input.text, 48), input.page, onPage);
  const op = await vaultOperation(
    `claim: add ${id}`,
    async (tx) => {
      const snapshot = await tx.snapshot();
      const page = pageIn(snapshot, input.page);
      if (page.frontmatter.claims.some((c) => c.id === id)) {
        throw new PageEditError("exists", "That page already carries this claim id; edit the claim instead.", 409);
      }
      if (page.frontmatter.claims.length >= LIMITS.maxClaims) {
        throw new PageEditError("too_many_claims", `A page carries at most ${LIMITS.maxClaims} claims; put this fact on another page.`, 409);
      }
      try {
        assertClaimIdAvailable(indexOf(snapshot, tx.vault), id, page.path);
      } catch (err) {
        if (err instanceof ClaimIdError) {
          throw err.code === "retired"
            ? new PageEditError("retired", err.message, 409)
            : err.code === "taken"
              ? new PageEditError("taken", err.message, 409)
              : bad(err.message);
        }
        throw err;
      }
      const claim: Claim = { id, text: input.text, confidence: input.confidence, status: "proposed", updatedAt: at, evidence: stampedEvidence(who, at, input.source) };
      await tx.writePage(page.path, { ...page.frontmatter, claims: [...page.frontmatter.claims, claim] }, page.body);
    },
    { vault, now: options.now, author: who.author },
  );
  if (op.commit) syncClaims(vault, [{ id, page: input.page, updatedAt: at }]);
  return { id, page: input.page, commit: op.commit, findings: findingsOf(op.findings) };
}

/** The one page carrying `id` (or the named one), under the lock. */
function holderOf(snapshot: VaultSnapshot, vault: string, id: string, page: string | null) {
  const holders = indexOf(snapshot, vault).active.get(id) ?? [];
  const chosen = page ? holders.filter((h) => h.page === page) : holders;
  if (chosen.length === 0) throw new PageEditError("not_found", page ? `${page} carries no claim ${id}.` : `No page carries the claim ${id}.`, 404);
  if (chosen.length > 1) throw bad(`The claim ${id} sits on ${chosen.length} pages; name the page.`);
  return pageIn(snapshot, chosen[0].page);
}

/** New text or confidence for an unverified claim, keeping its id: one commit, `claim: edit <id>`. */
export async function editClaim(rawId: string, patch: ClaimPatch, who: EditWho, options: EditOptions = {}): Promise<ClaimWriteResult> {
  const vault = options.vault ?? vaultDir();
  const id = claimIdOf(rawId);
  await requireVault(vault);
  const at = nowIso(options.now);
  const op = await vaultOperation(
    `claim: edit ${id}`,
    async (tx) => {
      const page = holderOf(await tx.snapshot(), tx.vault, id, patch.page ?? null);
      const superseded: SupersededFact[] = [];
      const claims = page.frontmatter.claims.map((c) => {
        if (c.id !== id) return c;
        if (c.verified) throw new PageEditError("verified", "This claim is verified; verify it again with the new text instead of editing it.", 409);
        const next: Claim = { ...c, ...(patch.text !== undefined ? { text: patch.text } : {}), ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}) };
        if (next.text === c.text && next.confidence === c.confidence) return c;
        if (next.text !== c.text) superseded.push({ before: c.text, after: next.text });
        return { ...next, updatedAt: at, evidence: [...c.evidence, { kind: "edit", note: `edited by ${who.by}`, updatedAt: at }].slice(-20) };
      });
      // The page's Key facts list the claim as it reads now.
      const body = reconcileStaleText(page.body, superseded, page.path, page.path, { prose: false }).body;
      await tx.writePage(page.path, { ...page.frontmatter, claims }, body);
      return page.path;
    },
    { vault, now: options.now, author: who.author },
  );
  if (op.commit) syncClaims(vault, [{ id, page: op.result, updatedAt: at }]);
  return { id, page: op.result, commit: op.commit, findings: findingsOf(op.findings) };
}

export interface ClaimDeleteResult {
  id: string;
  page: string;
  commit: string | null;
  /** True when the claim that went carried a verification. */
  wasVerified: boolean;
}

/** Remove a claim from its page — removed, not retired, so Undo can bring it back: one commit, `claim: delete <id>`. */
export async function deleteClaim(rawId: string, page: string | null, who: EditWho, options: EditOptions = {}): Promise<ClaimDeleteResult> {
  const vault = options.vault ?? vaultDir();
  const id = claimIdOf(rawId);
  await requireVault(vault);
  const op = await vaultOperation(
    `claim: delete ${id}`,
    async (tx) => {
      const holder = holderOf(await tx.snapshot(), tx.vault, id, page);
      await tx.writePage(holder.path, { ...holder.frontmatter, claims: holder.frontmatter.claims.filter((c) => c.id !== id) }, holder.body);
      return { page: holder.path, wasVerified: holder.frontmatter.claims.some((c) => c.id === id && !!c.verified) };
    },
    { vault, now: options.now, author: who.author },
  );
  return { id, page: op.result.page, commit: op.commit, wasVerified: op.result.wasVerified };
}

/**
 * Verify a claim: with `text`, that text is the fact (verify.ts — a new id
 * needs `page`); without, the claim is verified as it stands.
 */
export async function verifyClaimAs(input: VerifyRequest, who: EditWho, options: EditOptions = {}): Promise<VerifyResult> {
  const vault = options.vault ?? vaultDir();
  await requireVault(vault);
  let text = input.text;
  if (text === null) {
    const snapshot = await readVaultSnapshot(vault);
    const holders = (indexOf(snapshot, vault).active.get(input.id) ?? []).filter((h) => !input.page || h.page === input.page);
    if (holders.length === 0) throw new PageEditError("not_found", `No page carries the claim ${input.id}; give its text and page to verify a new fact.`, 404);
    text = holders[0].claim.text;
  }
  return verifyClaim({
    claimId: input.id,
    text,
    by: who.by,
    ...(who.via ? { via: who.via } : {}),
    page: input.page,
    note: who.via ? `verified by ${who.by} via ${who.via}` : `verified by ${who.by}`,
    author: who.author,
    person: who.person === true,
    vault,
    now: options.now,
  });
}

// ── merging pages ──────────────────────────────────────────────────────────

export interface PageMergeResult {
  into: string;
  from: string[];
  dryRun: boolean;
  /** The merge's commit; null for a dry run. */
  commit: string | null;
  /** Ids of the claims the merged pages carried, now on `into` unchanged; `verified` the ones whose verification moved with them. */
  claims: string[];
  verified: string[];
  /** Names `into` gained as aliases: the merged pages' titles and their own aliases. */
  aliases: string[];
  /** Sources `into` gained. */
  sources: string[];
  /** `into`'s privacy when a merged page's stricter tier raised it, else null. */
  privacy: PrivacyTier | null;
  /** The merged pages whose summary was new to `into` and now closes its body ("Merged from …"); always empty when its body is kept. */
  notes: string[];
  /** Pages whose links to a merged page now lead to `into` (on `into` itself, when its body may change, they became plain text), with how many each. */
  relinked: Array<{ path: string; links: number }>;
  /** Every link rewritten, index.md's included. */
  links: number;
  /** index.md lines that went with the merged pages (`into` gets one of its own when it had none). */
  indexLines: number;
  /** Pages linking a merged page that do not parse, left as they are: fix them by hand. */
  unparsed: string[];
  /** Waiting review items about a moved claim, now naming `into` where they named a merged page. */
  reviewItems: number;
  findings: EditFinding[];
}

interface MergePlan {
  result: Omit<PageMergeResult, "dryRun" | "commit" | "reviewItems" | "findings">;
  /** `text`: the whole new file when the body is kept as it was (its raw bytes, memory-wiki's blocks included). */
  page: { frontmatter: PageFrontmatter; body: string; text: string | null };
  rewrites: Array<{ path: string; frontmatter: PageFrontmatter; body: string }>;
  /** index.md's new text, or null when it stays as it is. */
  index: string | null;
}

/** A page a merge names, valid, or the refusal that says which and why not. */
function mergePage(snapshot: VaultSnapshot, rel: string): { path: string; frontmatter: PageFrontmatter; body: string; text: string } {
  const page = snapshot.pages.find((p) => p.path === rel);
  if (!page) throw new PageEditError("not_found", `No such page: ${rel}.`, 404);
  if (!page.parsed.ok) throw new PageEditError("invalid_page", `The frontmatter of ${rel} does not parse; fix it by hand before merging.`, 409);
  return { path: page.path, frontmatter: page.parsed.frontmatter, body: page.parsed.body, text: page.text };
}

function nameList(value: unknown): string[] {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return list.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
}

/** Text as a containment test reads it: spacing and case do not count. */
function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** What a link shows, for where it stops being a link. */
function shownText(link: FoundLink): string {
  if (link.kind === "md") return link.text.trim() !== "" ? link.text : link.target;
  return link.alias !== null && link.alias.trim() !== "" ? link.alias : link.target;
}

function mdLink(link: FoundLink & { kind: "md" }, href: string): string {
  return `[${link.text}](${href}${link.fragment !== null ? `#${link.fragment}` : ""}${link.title ? ` ${link.title}` : ""})`;
}

/**
 * The whole merge, worked out from a snapshot and written nowhere: the target
 * page as it will be, every other page whose links change, and index.md.
 * Throws the refusal when the merge may not happen. Pure apart from the
 * retired-id ledger it reads.
 */
function planMerge(snapshot: VaultSnapshot, vault: string, input: PageMerge, who: EditWho, at: string): MergePlan {
  const into = mergePage(snapshot, input.into);
  if (input.from.includes(into.path)) throw bad("A page cannot be merged into itself: leave the target out of from.");
  const fm = into.frontmatter;
  if (fm.status === "deprecated") throw new PageEditError("deprecated", `${into.path} is deprecated; merge into the page that replaces it.`, 409);
  if (fm.verified && !who.person) {
    throw new PageEditError("verified", `A person verified ${into.path} as a whole; raise a review item for the owner instead of merging into it.`, 409);
  }
  const froms = input.from.map((p) => mergePage(snapshot, p));
  for (const f of froms) {
    if (f.frontmatter.verified && !who.person) {
      throw new PageEditError("verified", `A person verified ${f.path} as a whole; only the owner can merge it away.`, 409);
    }
  }

  // Claims move as they are: id, text, status, evidence and verification.
  const index = indexOf(snapshot, vault);
  const claims = [...fm.claims];
  const slot = new Map(claims.map((c, i) => [c.id, i]));
  const holder = new Map(claims.map((c) => [c.id, into.path]));
  const movedIds: string[] = [];
  for (const f of froms) {
    for (const c of f.frontmatter.claims) {
      const i = slot.get(c.id);
      if (i === undefined) {
        if (index.retired.has(c.id)) {
          throw new PageEditError("retired", `The claim ${c.id} on ${f.path} uses a retired id, which may not move to another page; delete that claim first.`, 409);
        }
        slot.set(c.id, claims.length);
        holder.set(c.id, f.path);
        claims.push(c);
        movedIds.push(c.id);
        continue;
      }
      const there = claims[i];
      const other = holder.get(c.id) ?? into.path;
      if (there.text !== c.text) {
        if (c.verified || there.verified) {
          const [v, w] = c.verified ? [f.path, other] : [other, f.path];
          throw new PageEditError("verified", `The verified claim ${c.id} on ${v} shares its id with a different claim on ${w}, so it cannot move intact; settle the two first.`, 409);
        }
        throw new PageEditError("taken", `The claim id ${c.id} is on ${other} and on ${f.path} with different text; settle the two before merging.`, 409);
      }
      // The same fact twice keeps one copy: the verified one when only one is.
      if (c.verified && !there.verified) {
        claims[i] = c;
        holder.set(c.id, f.path);
        if (!movedIds.includes(c.id)) movedIds.push(c.id);
      }
    }
  }
  if (claims.length > fm.claims.length && claims.length > LIMITS.maxClaims) {
    throw new PageEditError(
      "too_many_claims",
      `Merging would leave ${claims.length} claims on ${into.path}; a page carries at most ${LIMITS.maxClaims}. Delete or move ${claims.length - LIMITS.maxClaims} of them first, or merge fewer pages.`,
      409,
    );
  }
  // A retirement the merged pages recorded stays on a page, not only in the ledger.
  const retired = new Set(fm.retiredClaimIds);
  for (const f of froms) for (const id of f.frontmatter.retiredClaimIds) retired.add(id);
  const retiredClaimIds = retired.size === fm.retiredClaimIds.length ? fm.retiredClaimIds : [...retired].sort();

  const sources = [...fm.sources];
  const gainedSources: string[] = [];
  for (const s of froms.flatMap((f) => f.frontmatter.sources)) {
    if (sources.includes(s)) continue;
    sources.push(s);
    gainedSources.push(s);
  }

  const aliases = nameList(fm.aliases);
  const named = new Set([fm.title, ...aliases].map((n) => n.toLowerCase()));
  const gainedAliases: string[] = [];
  for (const f of froms) {
    for (const name of [f.frontmatter.title, ...nameList(f.frontmatter.aliases)]) {
      if (named.has(name.toLowerCase())) continue;
      named.add(name.toLowerCase());
      aliases.push(name);
      gainedAliases.push(name);
    }
  }
  // The merged pages' facts keep at least the protection they had.
  const tier = (p: PrivacyTier) => PRIVACY_TIERS.indexOf(p);
  const privacy = froms.reduce<PrivacyTier>((strictest, f) => (tier(f.frontmatter.privacy) > tier(strictest) ? f.frontmatter.privacy : strictest), fm.privacy);

  // Links: every one that resolves to a merged page today, as lint resolves it.
  const gone = new Set(froms.map((f) => f.path));
  const resolver = createLinkResolver(snapshot.pages.map((p) => ({ path: p.path, title: p.parsed.ok ? p.parsed.frontmatter.title : undefined, aliases: p.parsed.ok ? pathAliases(p.parsed.frontmatter.aliases) : undefined })));
  const intoLink = into.path.replace(/\.md$/, "");
  const retarget = (page: string) => (link: FoundLink): string | null => {
    const target = resolver.resolve(page, link);
    if (target === null || !gone.has(target)) return null;
    if (page === into.path) return shownText(link);
    if (link.kind === "md") return mdLink(link, relativeHref(page, into.path));
    // A link by name or title keeps showing those words; one by path shows the new path.
    const label = link.alias ?? (link.target.includes("/") ? null : link.target);
    return `[[${intoLink}${link.heading !== null ? `#${link.heading}` : ""}${label !== null ? `|${label}` : ""}]]`;
  };

  const relinked: Array<{ path: string; links: number }> = [];
  let links = 0;
  let body = into.body;
  if (input.keepIntoBody) {
    // A kept body cannot drop its links to the pages that go, and they would lead nowhere.
    const linked = [...new Set(extractLinks(into.body).flatMap((l) => {
      const target = resolver.resolve(into.path, l);
      return target !== null && gone.has(target) ? [target] : [];
    }))];
    if (linked.length > 0) {
      throw new PageEditError(
        "into_links",
        `${into.path} links to ${linked.join(", ")}, which the merge removes, and its body is kept as it is: take those links out of it first, or merge with keep_into_body: false to make them plain text.`,
        409,
      );
    }
  } else {
    const own = rewriteLinks(into.body, retarget(into.path));
    body = own.body;
    if (own.rewritten > 0) relinked.push({ path: into.path, links: own.rewritten });
    links += own.rewritten;
  }

  // A merged page's summary that `into` does not say yet closes its body, its
  // links read from where it now sits — unless the body is kept, or the page
  // was deprecated (its text is a pointer like "Duplicate of [[…]]", no fact).
  const notes: string[] = [];
  for (const f of input.keepIntoBody ? [] : froms) {
    const summary = f.frontmatter.status === "deprecated" ? null : pageSummary(f.body);
    if (summary === null) continue;
    const moved = rewriteLinks(summary, (link) => {
      const target = resolver.resolve(f.path, link);
      if (target === null) return null;
      if (target === into.path || gone.has(target)) return shownText(link);
      return link.kind === "md" ? mdLink(link, relativeHref(into.path, target)) : null;
    }).body;
    if (squash(body).includes(squash(summary)) || squash(body).includes(squash(moved))) continue;
    body = pageSummary(body) === null ? withSummary(body, moved) : `${body.trimEnd()}\n\nMerged from ${f.frontmatter.title}: ${moved}`;
    notes.push(f.path);
  }
  if (notes.length > 0 && body.trim().length > LIMITS.bodyHardChars) {
    throw new PageEditError("too_long", `The merged summaries would take ${into.path} past ${LIMITS.bodyHardChars} characters; shorten it or merge fewer pages.`, 409);
  }

  const rewrites: MergePlan["rewrites"] = [];
  const unparsed: string[] = [];
  for (const p of snapshot.pages) {
    if (gone.has(p.path) || p.path === into.path) continue;
    if (!p.parsed.ok) {
      if (extractLinks(p.parsed.body).some((l) => gone.has(resolver.resolve(p.path, l) ?? ""))) unparsed.push(p.path);
      continue;
    }
    const r = rewriteLinks(p.parsed.body, retarget(p.path));
    if (r.rewritten === 0) continue;
    rewrites.push({ path: p.path, frontmatter: p.parsed.frontmatter, body: r.body });
    relinked.push({ path: p.path, links: r.rewritten });
    links += r.rewritten;
  }

  let indexText: string | null = null;
  let indexLines = 0;
  if (snapshot.indexBody !== null) {
    let next = snapshot.indexBody;
    for (const f of froms) {
      const without = removeFromIndex(next, f.path);
      indexLines += next.split("\n").length - without.split("\n").length;
      next = without;
    }
    const r = rewriteLinks(next, retarget(INDEX_FILE));
    links += r.rewritten;
    next = r.body;
    // The merged pages' lines listed the subject: it stays listed, under the page that stays.
    if (indexLines > 0 && !extractLinks(next).some((l) => resolver.resolve(INDEX_FILE, l) === into.path)) {
      next = addToIndex(next, [{ path: into.path, title: fm.title }]);
    }
    if (next !== snapshot.indexBody) indexText = next;
  }

  const frontmatter: PageFrontmatter = { ...fm, privacy, generated: { at, by: who.by }, sources, claims, retiredClaimIds };
  if (gainedAliases.length > 0) frontmatter.aliases = aliases;
  return {
    result: {
      into: into.path,
      from: froms.map((f) => f.path),
      claims: movedIds,
      verified: movedIds.filter((id) => claims[slot.get(id) ?? -1]?.verified),
      aliases: gainedAliases,
      sources: gainedSources,
      privacy: privacy === fm.privacy ? null : privacy,
      notes,
      relinked,
      links,
      indexLines,
      unparsed,
    },
    // The kept body goes back as the bytes it was, behind the new frontmatter.
    page: { frontmatter, body, text: input.keepIntoBody ? `---\n${serializeFrontmatter(withPluginFields(into.path, frontmatter))}---\n${splitFrontmatter(into.text).body}` : null },
    rewrites,
    index: indexText,
  };
}

function followReviewItems(vault: string, plan: MergePlan["result"], dryRun: boolean): number {
  try {
    return followMovedClaims(vault, plan.claims, new Map(plan.from.map((p) => [p, plan.into])), { dryRun });
  } catch {
    // The items still name the claims, which is how they are settled.
    return 0;
  }
}

/**
 * A merge worked out on a snapshot the caller already holds, written nowhere:
 * what {@link mergePages} would do in a dry run, or the refusal it would
 * answer (the summaries pass's merge suggestions for duplicate entities).
 */
export function previewMerge(
  snapshot: VaultSnapshot,
  input: Pick<PageMerge, "into" | "from">,
  who: EditWho,
  options: { vault: string; now?: Date },
): { ok: true; result: MergePlan["result"] } | { ok: false; code: string; message: string } {
  try {
    const plan = planMerge(snapshot, options.vault, { ...input, dryRun: true, keepIntoBody: true }, who, nowIso(options.now));
    return { ok: true, result: plan.result };
  } catch (err) {
    if (err instanceof PageEditError) return { ok: false, code: err.code, message: err.message };
    throw err;
  }
}

/**
 * Fold duplicate pages into one: one commit, `merge: <from, …> -> <into>`,
 * that Undo reverses whole. Every claim of the merged pages moves onto `into`
 * as it is (see the header), their sources and names join its own, every
 * link to them in the vault (index.md too) leads to `into`, and they go with
 * their index lines. `into`'s body stays byte for byte (`keepIntoBody`, the
 * default — a link there to a merged page refuses the merge, `into_links`);
 * let it change and their summaries close it when it lacks them, its links
 * to them become plain text.
 * Waiting review items about a moved claim follow it; none is resolved.
 * `dryRun` answers the same without writing anything.
 */
export async function mergePages(input: PageMerge, who: EditWho, options: EditOptions = {}): Promise<PageMergeResult> {
  const vault = options.vault ?? vaultDir();
  await requireVault(vault);
  const at = nowIso(options.now);
  if (input.dryRun) {
    const plan = planMerge(await readVaultSnapshot(vault), vault, input, who, at);
    return { ...plan.result, dryRun: true, commit: null, reviewItems: followReviewItems(vault, plan.result, true), findings: [] };
  }
  const op = await vaultOperation(
    `merge: ${input.from.join(", ")} -> ${input.into}`,
    async (tx) => {
      const plan = planMerge(await tx.snapshot(), tx.vault, input, who, at);
      if (plan.page.text !== null) await tx.write(plan.result.into, plan.page.text);
      else await tx.writePage(plan.result.into, plan.page.frontmatter, plan.page.body);
      for (const w of plan.rewrites) await tx.writePage(w.path, w.frontmatter, w.body);
      for (const p of plan.result.from) await tx.remove(p);
      if (plan.index !== null) await tx.write(INDEX_FILE, plan.index);
      return plan;
    },
    { vault, now: options.now, author: who.author },
  );
  const plan = op.result;
  let reviewItems = 0;
  if (op.commit) {
    const moved = new Set(plan.result.claims);
    syncClaims(vault, plan.page.frontmatter.claims.filter((c) => moved.has(c.id)).map((c) => ({ id: c.id, page: plan.result.into, updatedAt: c.updatedAt })));
    reviewItems = followReviewItems(vault, plan.result, false);
  }
  return { ...plan.result, dryRun: false, commit: op.commit, reviewItems, findings: findingsOf(op.findings) };
}
