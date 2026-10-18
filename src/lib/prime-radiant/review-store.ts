/**
 * The review queue: `review_items` in the state database.
 *
 * An item is one question only a person can settle — a disputed fact (two
 * claims the judge says cannot both be true), a nightly change that touched a
 * verified page, a lint error that keeps a night from merging, or an Opus
 * proposal. It names the claim it is about (`claimId`, when there is one),
 * the pages involved, the candidate answers with their evidence, and why it
 * was raised. Resolving it is review.ts's business; this module only stores.
 *
 * The same question raised again (the same pair on the next night, the same
 * lint finding) is NOT a second item: `dedupe_key` names it, and an item still
 * open or put off ("later") under that key is answered instead of a new one.
 * A key past {@link MAX_DEDUPE_KEY} characters is stored as the SHA-256 of
 * the whole key ({@link storedDedupeKey}) — it was cut there once, which let
 * two questions whose keys began alike pass for one. A key a caller used
 * before (`legacyKeys`) still finds the item waiting under it. With
 * `keepDismissed`, a question a person dismissed is not asked again while its
 * candidates read as they did then.
 *
 * Reads never create the database (`stateDbExists` first).
 *
 * SERVER ONLY.
 */

import crypto from "crypto";
import type { DatabaseSync } from "node:sqlite";
import { claimTextKey, isClaimId } from "./claims";
import { safePagePath } from "./paths";
import { stateDbExists, withStateDb } from "./state-db";

export const REVIEW_KINDS = ["contradiction", "verified-touch", "lint", "opus"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const REVIEW_STATUSES = ["open", "resolved", "later"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const MAX_CANDIDATES = 8;
export const MAX_CANDIDATE_TEXT = 1000;
export const MAX_REVIEW_PAGES = 20;
export const MAX_EVIDENCE_ITEMS = 20;
const MAX_EVIDENCE_TEXT = 500;

export interface ReviewCandidate {
  text: string;
  /** The page the candidate answer comes from (vault-relative), or null for a new answer. */
  page: string | null;
  /** The claim id the candidate is filed under on that page, when it is one. */
  claimId?: string;
  evidence: ReviewEvidence[];
}

/** A short, display-only fact about why: who raised it and on what grounds. Never page text beyond a claim. */
export interface ReviewEvidence {
  kind: string;
  note?: string;
  page?: string;
  source?: string;
  verdict?: string;
}

export interface ReviewResolution {
  action: "pick" | "new" | "dismiss" | "later";
  text?: string;
  candidate?: number;
  commit?: string | null;
  retired?: string[];
  by: string;
  /** `assistant` when the assistant settled it on the owner's word (`by: owner`). */
  via?: string;
  /** Why it was settled: a pass's reason, or the one the person gave. */
  note?: string;
  /** Claims removed from their page (deleted, or folded into a same-worded claim): the item asks about nothing now. */
  removed?: string[];
}

export interface ReviewItem {
  id: string;
  kind: ReviewKind;
  claimId: string | null;
  pages: string[];
  candidates: ReviewCandidate[];
  evidence: ReviewEvidence[];
  status: ReviewStatus;
  createdAt: string;
  resolvedAt: string | null;
  resolution: ReviewResolution | null;
  runId: string | null;
}

export interface NewReviewItem {
  kind: ReviewKind;
  claimId?: string | null;
  pages?: readonly string[];
  candidates?: readonly ReviewCandidate[];
  evidence?: readonly ReviewEvidence[];
  dedupeKey?: string | null;
  /** Keys the same question was stored under before: an item waiting under one answers too. */
  legacyKeys?: readonly string[];
  /** Answer, never re-raise, a question a person dismissed under the key while its candidates read the same. */
  keepDismissed?: boolean;
  runId?: string | null;
}

const ID_ALPHABET = "0123456789abcdef";
const ID_HEX = 12;

export function newReviewId(): string {
  return `rev-${crypto.randomBytes(ID_HEX / 2).toString("hex")}`;
}

/** A caller's review id rebuilt from the id alphabet, or null. */
export function safeReviewId(input: unknown): string | null {
  if (typeof input !== "string" || !input.startsWith("rev-") || input.length !== 4 + ID_HEX) return null;
  let hex = "";
  for (const ch of input.slice(4)) {
    const at = ID_ALPHABET.indexOf(ch);
    if (at < 0) return null;
    hex += ID_ALPHABET[at];
  }
  return `rev-${hex}`;
}

function oneLine(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

function cleanEvidence(list: readonly unknown[] | undefined): ReviewEvidence[] {
  const out: ReviewEvidence[] = [];
  for (const raw of (list ?? []).slice(0, MAX_EVIDENCE_ITEMS)) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const kind = typeof e.kind === "string" ? oneLine(e.kind, 40) : "";
    if (kind === "") continue;
    const item: ReviewEvidence = { kind };
    for (const key of ["note", "source", "verdict"] as const) {
      if (typeof e[key] === "string" && (e[key] as string).trim() !== "") item[key] = oneLine(e[key] as string, MAX_EVIDENCE_TEXT);
    }
    const page = safePagePath(e.page);
    if (page) item.page = page;
    out.push(item);
  }
  return out;
}

/** Candidates read strictly: text required, page rebuilt or null, claim id only when it is one. */
export function cleanCandidates(list: readonly unknown[] | undefined): ReviewCandidate[] {
  const out: ReviewCandidate[] = [];
  for (const raw of (list ?? []).slice(0, MAX_CANDIDATES)) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const text = typeof c.text === "string" ? oneLine(c.text, MAX_CANDIDATE_TEXT) : "";
    if (text === "") continue;
    const candidate: ReviewCandidate = {
      text,
      page: safePagePath(c.page),
      evidence: cleanEvidence(Array.isArray(c.evidence) ? c.evidence : []),
    };
    if (isClaimId(c.claimId)) candidate.claimId = c.claimId;
    out.push(candidate);
  }
  return out;
}

function cleanPages(list: readonly unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const p of list ?? []) {
    const safe = safePagePath(p);
    if (safe && !out.includes(safe)) out.push(safe);
    if (out.length >= MAX_REVIEW_PAGES) break;
  }
  return out;
}

interface Row {
  id: string;
  kind: string;
  claim_id: string | null;
  pages: string;
  candidates: string;
  evidence: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
  resolution: string | null;
  run_id: string | null;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function fromRow(r: Row): ReviewItem {
  return {
    id: r.id,
    kind: (REVIEW_KINDS as readonly string[]).includes(r.kind) ? (r.kind as ReviewKind) : "lint",
    claimId: r.claim_id,
    pages: parseJson<string[]>(r.pages, []),
    candidates: parseJson<ReviewCandidate[]>(r.candidates, []),
    evidence: parseJson<ReviewEvidence[]>(r.evidence, []),
    status: (REVIEW_STATUSES as readonly string[]).includes(r.status) ? (r.status as ReviewStatus) : "open",
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolution: parseJson<ReviewResolution | null>(r.resolution, null),
    runId: r.run_id,
  };
}

const COLUMNS = "id, kind, claim_id, pages, candidates, evidence, status, created_at, resolved_at, resolution, run_id";

/** The longest dedupe key stored as it is. */
export const MAX_DEDUPE_KEY = 200;

/** A dedupe key as the table holds it: itself up to {@link MAX_DEDUPE_KEY} characters, else the SHA-256 of all of it. */
export function storedDedupeKey(key: string): string {
  return key.length <= MAX_DEDUPE_KEY ? key : `sha256:${crypto.createHash("sha256").update(key).digest("hex")}`;
}

function findOpenByKey(db: DatabaseSync, keys: readonly string[]): ReviewItem | null {
  const stmt = db.prepare(`SELECT ${COLUMNS} FROM review_items WHERE dedupe_key = ? AND status IN ('open', 'later') ORDER BY created_at LIMIT 1`);
  for (const key of keys) {
    const row = stmt.get(key) as Row | undefined;
    if (row) return fromRow(row);
  }
  return null;
}

const candidateTexts = (list: readonly ReviewCandidate[]) => JSON.stringify(list.map((c) => claimTextKey(c.text)).sort());

/**
 * A person's dismissal of the same question with the same candidate texts:
 * not one a pass made (`auto`), nor one closed because a claim was retired or
 * removed — the claims of such a question are gone, a new one is new.
 */
function findDismissed(db: DatabaseSync, keys: readonly string[], candidates: readonly ReviewCandidate[]): ReviewItem | null {
  const stmt = db.prepare(`SELECT ${COLUMNS} FROM review_items WHERE dedupe_key = ? AND status = 'resolved' ORDER BY resolved_at DESC`);
  const texts = candidateTexts(candidates);
  for (const key of keys) {
    for (const item of (stmt.all(key) as unknown as Row[]).map(fromRow)) {
      const r = item.resolution;
      if (!r || r.action !== "dismiss" || r.by === "auto" || (r.retired?.length ?? 0) > 0 || (r.removed?.length ?? 0) > 0) continue;
      if (candidateTexts(item.candidates) === texts) return item;
    }
  }
  return null;
}

/**
 * Add an item, or answer the one already waiting under the same dedupe key
 * (`created: false`), or — with `keepDismissed` — the dismissal that already
 * answered it (`dismissed: true`). Everything is cleaned here, so every
 * caller (the nightly pass, the POST route) stores the same shape.
 */
export function addReviewItem(
  vault: string,
  input: NewReviewItem,
  at: string = new Date().toISOString(),
): { item: ReviewItem; created: boolean; dismissed?: boolean } {
  return withStateDb(vault, (db) => {
    const key = input.dedupeKey ? storedDedupeKey(input.dedupeKey) : null;
    if (key) {
      // An old key was stored as it was only when it fitted; one that was cut is no key to look for.
      const keys = [key, ...(input.legacyKeys ?? []).filter((k) => k.length <= MAX_DEDUPE_KEY && k !== key)];
      const existing = findOpenByKey(db, keys);
      if (existing) return { item: existing, created: false };
      if (input.keepDismissed) {
        const dismissed = findDismissed(db, keys, cleanCandidates(input.candidates));
        if (dismissed) return { item: dismissed, created: false, dismissed: true };
      }
    }
    const item: ReviewItem = {
      id: newReviewId(),
      kind: input.kind,
      claimId: isClaimId(input.claimId) ? input.claimId : null,
      pages: cleanPages(input.pages),
      candidates: cleanCandidates(input.candidates),
      evidence: cleanEvidence(input.evidence),
      status: "open",
      createdAt: at,
      resolvedAt: null,
      resolution: null,
      runId: input.runId ?? null,
    };
    db.prepare(
      `INSERT INTO review_items (id, kind, claim_id, pages, candidates, evidence, status, created_at, dedupe_key, run_id)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    ).run(
      item.id,
      item.kind,
      item.claimId,
      JSON.stringify(item.pages),
      JSON.stringify(item.candidates),
      JSON.stringify(item.evidence),
      at,
      key,
      item.runId,
    );
    return { item, created: true };
  });
}

export function getReviewItem(vault: string, id: string): ReviewItem | null {
  if (!stateDbExists(vault)) return null;
  return withStateDb(vault, (db) => {
    const row = db.prepare(`SELECT ${COLUMNS} FROM review_items WHERE id = ?`).get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  });
}

export interface ReviewListFilter {
  /** One status, or `all`. Default `open`. */
  status?: ReviewStatus | "all";
  kind?: ReviewKind;
  claimId?: string;
  offset?: number;
  limit?: number;
}

export const MAX_REVIEW_LIST = 200;

export interface ReviewList {
  total: number;
  counts: Record<ReviewStatus, number>;
  items: ReviewItem[];
}

export function listReviewItems(vault: string, filter: ReviewListFilter = {}): ReviewList {
  const empty: ReviewList = { total: 0, counts: { open: 0, resolved: 0, later: 0 }, items: [] };
  if (!stateDbExists(vault)) return empty;
  return withStateDb(vault, (db) => {
    const where: string[] = [];
    const params: string[] = [];
    const status = filter.status ?? "open";
    if (status !== "all") {
      where.push("status = ?");
      params.push(status);
    }
    if (filter.kind) {
      where.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.claimId) {
      where.push("claim_id = ?");
      params.push(filter.claimId);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM review_items ${clause}`).get(...params) as { n: number }).n);
    const limit = Math.max(1, Math.min(filter.limit ?? 50, MAX_REVIEW_LIST));
    const offset = Math.max(0, filter.offset ?? 0);
    const rows = db
      .prepare(`SELECT ${COLUMNS} FROM review_items ${clause} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as Row[];
    const counts = { ...empty.counts };
    for (const r of db.prepare("SELECT status, COUNT(*) AS n FROM review_items GROUP BY status").all() as Array<{ status: string; n: number }>) {
      if ((REVIEW_STATUSES as readonly string[]).includes(r.status)) counts[r.status as ReviewStatus] = Number(r.n);
    }
    return { total, counts, items: rows.map(fromRow) };
  });
}

/**
 * Settle an item: `resolved` (with what was done) or `later` (put off; it
 * stays in the queue). Only an item that is not already resolved moves —
 * answers whether this call was the one that moved it.
 */
export function settleReviewItem(
  vault: string,
  id: string,
  status: "resolved" | "later",
  resolution: ReviewResolution,
  at: string = new Date().toISOString(),
): boolean {
  return withStateDb(vault, (db) => {
    const r = db
      .prepare("UPDATE review_items SET status = ?, resolved_at = ?, resolution = ? WHERE id = ? AND status != 'resolved'")
      .run(status, status === "resolved" ? at : null, JSON.stringify(resolution), id);
    return Number(r.changes) > 0;
  });
}

/**
 * Close every still-waiting item about claims that no longer exist (retired
 * by a verification), so the queue never asks about a fact that is gone.
 */
export function closeItemsForRetired(vault: string, retired: readonly string[], by: string, at: string = new Date().toISOString()): number {
  if (retired.length === 0 || !stateDbExists(vault)) return 0;
  return withStateDb(vault, (db) => {
    const stmt = db.prepare(
      "UPDATE review_items SET status = 'resolved', resolved_at = ?, resolution = ? WHERE claim_id = ? AND status IN ('open', 'later')",
    );
    let n = 0;
    for (const id of retired) {
      n += Number(stmt.run(at, JSON.stringify({ action: "dismiss", by, retired: [id] } satisfies ReviewResolution), id).changes);
    }
    return n;
  });
}

/**
 * Close every still-waiting item about claims removed from their page (a
 * delete, or a fold into a same-worded claim — `note` says which, or answers
 * it for each removed claim id): the one about the claim, and a contradiction
 * one of its sides. Not a dismissal a person made, so the same question about
 * a claim that comes back is asked again.
 */
export function closeItemsForRemoved(
  vault: string,
  removed: readonly string[],
  by: string,
  note: string | ((removedId: string) => string),
  at: string = new Date().toISOString(),
): number {
  if (removed.length === 0 || !stateDbExists(vault)) return 0;
  const ids = new Set(removed);
  return withStateDb(vault, (db) => {
    const rows = db.prepare(`SELECT ${COLUMNS} FROM review_items WHERE status IN ('open', 'later')`).all() as unknown as Row[];
    const close = db.prepare("UPDATE review_items SET status = 'resolved', resolved_at = ?, resolution = ? WHERE id = ? AND status IN ('open', 'later')");
    let n = 0;
    for (const item of rows.map(fromRow)) {
      const hit = [item.claimId, ...(item.kind === "contradiction" ? item.candidates.map((c) => c.claimId) : [])].filter((id): id is string => !!id && ids.has(id));
      if (hit.length === 0) continue;
      const removedIds = [...new Set(hit)];
      const noteText = typeof note === "string" ? note : [...new Set(removedIds.map((id) => note(id)))].join("; ");
      n += Number(close.run(at, JSON.stringify({ action: "dismiss", by, note: noteText, removed: removedIds } satisfies ReviewResolution), item.id).changes);
    }
    return n;
  });
}

/**
 * Let the still-waiting items about `claimIds` follow those claims to the page
 * they moved to (a page merge: `moved` maps each old page to its new one).
 * The page names change, in `pages` and in the candidates; the claim ids,
 * the status and everything else stay — nothing is resolved. Answers how
 * many items changed (with `dryRun`, would change).
 */
export function followMovedClaims(
  vault: string,
  claimIds: readonly string[],
  moved: ReadonlyMap<string, string>,
  options: { dryRun?: boolean } = {},
): number {
  if (claimIds.length === 0 || moved.size === 0 || !stateDbExists(vault)) return 0;
  const ids = new Set(claimIds);
  return withStateDb(vault, (db) => {
    const rows = db.prepare(`SELECT ${COLUMNS} FROM review_items WHERE status IN ('open', 'later')`).all() as unknown as Row[];
    const update = db.prepare("UPDATE review_items SET pages = ?, candidates = ? WHERE id = ? AND status IN ('open', 'later')");
    let n = 0;
    for (const item of rows.map(fromRow)) {
      if (!(item.claimId && ids.has(item.claimId)) && !item.candidates.some((c) => c.claimId && ids.has(c.claimId))) continue;
      const pages = [...new Set(item.pages.map((p) => moved.get(p) ?? p))];
      const candidates = item.candidates.map((c) => (c.page && moved.has(c.page) ? { ...c, page: moved.get(c.page) ?? c.page } : c));
      if (JSON.stringify(pages) === JSON.stringify(item.pages) && JSON.stringify(candidates) === JSON.stringify(item.candidates)) continue;
      n++;
      if (!options.dryRun) update.run(JSON.stringify(pages), JSON.stringify(candidates), item.id);
    }
    return n;
  });
}

/** How many items raised by these runs still wait (open or later). */
export function countWaitingForRuns(vault: string, runIds: readonly string[]): number {
  if (runIds.length === 0 || !stateDbExists(vault)) return 0;
  return withStateDb(vault, (db) => {
    const stmt = db.prepare("SELECT COUNT(*) AS n FROM review_items WHERE run_id = ? AND status IN ('open', 'later')");
    return runIds.reduce((n, id) => n + Number((stmt.get(id) as { n: number }).n), 0);
  });
}
