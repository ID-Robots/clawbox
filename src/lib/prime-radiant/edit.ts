/**
 * Direct edits to the vault: a page created, edited or deleted, a claim
 * added, edited or deleted, a claim verified as it stands. The routes under
 * `pages` and `claims` answer from here, for the owner and for the assistant
 * through the box's MCP server alike.
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
 *
 * Request bodies are read strictly here (`readNewPage`, `readPagePatch`, …):
 * an unknown field or a wrong type is a 400, never silently dropped.
 *
 * SERVER ONLY.
 */

import { allocateClaimId, assertClaimIdAvailable, buildClaimIndex, ClaimIdError, isClaimId, nowIso, slugify, type ClaimIndex } from "./claims";
import type { VaultAuthor } from "./git";
import { LIMITS, type LintFinding } from "./lint";
import { isKnowledgePage, safePagePath, vaultDir } from "./paths";
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
import { readRetiredLedger, syncActiveClaims } from "./state-db";
import { INDEX_FILE, readVaultSnapshot, vaultInitialised, vaultOperation, type VaultSnapshot } from "./vault";
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
    readonly code: "invalid" | "not_initialised" | "not_found" | "exists" | "invalid_page" | "verified" | "taken" | "retired" | "too_many_claims",
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
  sources?: string[];
}

/** `PATCH pages/<path>`: any of `{ title, summary, body, status, domain, owner, privacy, stale_after, sources }`. */
export function readPagePatch(body: unknown): PagePatch {
  const b = objectBody(body, ["title", "summary", "body", "status", "domain", "owner", "privacy", "stale_after", "sources"]);
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
}

/** `POST claims/verify`: `{ id, text?, page? }` — no text verifies the claim as it stands. */
export function readVerifyRequest(body: unknown): VerifyRequest {
  const b = objectBody(body, ["id", "text", "page"]);
  return {
    id: claimIdOf(b.id),
    text: b.text === undefined || b.text === null ? null : claimText(b.text),
    page: b.page === undefined || b.page === null ? null : pagePathOf(b.page),
  };
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
      const snapshot = await readVaultSnapshot(tx.vault);
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

/** Change a page's body, summary or frontmatter fields: one commit, `edit: <path>`. Its claims are untouched. */
export async function editPage(rel: string, patch: PagePatch, who: EditWho, options: EditOptions = {}): Promise<PageEditResult> {
  const vault = options.vault ?? vaultDir();
  const path = pagePathOf(rel);
  await requireVault(vault);
  const at = nowIso(options.now);
  const changed: string[] = [];
  const op = await vaultOperation(
    `edit: ${path}`,
    async (tx) => {
      const page = pageIn(await readVaultSnapshot(tx.vault), path);
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
      if (body.trim() !== page.body.trim()) changed.push(patch.summary !== undefined && patch.body === undefined ? "summary" : "body");
      if (changed.length === 0) return;
      fm.generated = { at, by: who.by };
      await tx.writePage(path, fm, body);
    },
    { vault, now: options.now, author: who.author },
  );
  return { path, commit: op.commit, claims: [], changed, findings: findingsOf(op.findings) };
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
      const snapshot = await readVaultSnapshot(tx.vault);
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
      const snapshot = await readVaultSnapshot(tx.vault);
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
      const page = holderOf(await readVaultSnapshot(tx.vault), tx.vault, id, patch.page ?? null);
      const claims = page.frontmatter.claims.map((c) => {
        if (c.id !== id) return c;
        if (c.verified) throw new PageEditError("verified", "This claim is verified; verify it again with the new text instead of editing it.", 409);
        const next: Claim = { ...c, ...(patch.text !== undefined ? { text: patch.text } : {}), ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}) };
        if (next.text === c.text && next.confidence === c.confidence) return c;
        return { ...next, updatedAt: at, evidence: [...c.evidence, { kind: "edit", note: `edited by ${who.by}`, updatedAt: at }].slice(-20) };
      });
      await tx.writePage(page.path, { ...page.frontmatter, claims }, page.body);
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
      const holder = holderOf(await readVaultSnapshot(tx.vault), tx.vault, id, page);
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
    page: input.page,
    note: `verified by ${who.by}`,
    author: who.author,
    person: who.person === true,
    vault,
    now: options.now,
  });
}
