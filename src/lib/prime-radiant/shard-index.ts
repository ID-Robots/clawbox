/**
 * The Prime Radiant vault as a built-in Memory Shard source.
 *
 * Memory Shard stays the search engine: this module reuses its chunker
 * (`chunkText`), its embedding client (`embedMemoryTexts` — the same fence,
 * retries and normalised vectors), its embedder choice (`resolveMemoryEmbedder`)
 * and keeps a vector budget of its own (`vaultMaxChunks`, vectors cut to 1,024-d). What it adds is what the owner's
 * folders never had: every hit knows WHICH page or claim it came from (`path`,
 * `id`, `kind`, page `type`), and a page or claim a person verified ranks above
 * one nobody checked.
 *
 * WHY A STORE OF ITS OWN (`<prime-radiant root>/shard-index.sqlite`) rather
 * than rows in Shard's `data/memory-index/index.sqlite`: that store only exists
 * on the edition where ClawBox indexes the owner's folders (on OpenClaw they
 * are OpenClaw's), and its identity, rebuild and "nothing owed" rules are about
 * those folders. The vault is ClawBox's own on every edition, so its index is
 * too. It is derived data, beside the vault and never inside it.
 *
 * WHAT IS INDEXED IS `main`. Pages are read out of git (`ls-tree`, then the
 * blob), never the working tree, so a nightly pass working on a `dream/…`
 * branch cannot leak half-reviewed text into search, and the blob id is the
 * change key — an unchanged page costs nothing, not even a read.
 *
 * INCREMENTAL. {@link reindexPrimeRadiantPaths} re-embeds only the pages named
 * whose blob moved and drops the ones `main` no longer has.
 * `vaultOperation` calls it after every commit on `main` without waiting for
 * it; a merge from a `dream/` branch (the nightly pass) calls it with the
 * merged paths. Runs are serialised per vault and coalesce: paths queued while
 * one runs are taken together by the next. A run the embedder refused leaves a
 * `needs_full` mark, so the next run scans the whole tree instead of trusting
 * the paths it was told about.
 *
 * ONLY WHILE MEMORY SHARD IS ON AND THE VAULT EXISTS ({@link
 * vaultIndexingAllowed}), checked by every run. Switching Memory Shard on
 * starts a whole-vault run, which catches up on whatever was committed while it
 * was off.
 *
 * TEXT IS REDACTED BEFORE IT IS EMBEDDED — the embedder may be the cloud one,
 * and an embedding request is a network call like any other (the same
 * `redactText` the writer uses). The snippet stored for a hit is the redacted
 * text too.
 *
 * SERVER ONLY: sqlite, git, and a call to this box's embedder.
 */

import crypto from "crypto";
import fs from "fs/promises";
import type { DatabaseSync } from "node:sqlite";
import path from "@/lib/runtime-path";
import { openSqlite } from "@/lib/openclaw-session-store";
import { processStore } from "@/lib/process-store";
import { createSerialLock, type SerialLock } from "@/lib/serial-lock";
import { resolveMemoryEmbedder, type ResolvedEmbedder } from "@/lib/memory-embedder";
import { getMemoryShardEnabled } from "@/lib/memory-shard";
import {
  MEMORY_EMBED_BATCH_INPUTS,
  chunkText,
  embedMemoryTexts,
  embedderIdentity,
} from "@/lib/memory-index-local";
import { stripRelatedBlock } from "./connect";
import { parsePage } from "./frontmatter";
import { currentBranch, git, VAULT_MAIN_BRANCH } from "./git";
import { isKnowledgePage, safePagePath, vaultDir } from "./paths";
import { redactText } from "./redact";
import { vaultInitialised } from "./vault";
import type { PageFrontmatter } from "./schema";

/** Bumped when the tables or what goes into them change: the store is rebuilt. */
const VAULT_INDEX_SCHEMA = "2";

/**
 * The width a vault vector is kept at. The cloud embedder answers 3,072-d
 * Matryoshka vectors whose leading dimensions carry most of the meaning: cut
 * to {@link VAULT_INDEX_DIMS} and normalised again, a vector costs a third of
 * the memory, so the whole vault fits where only a quarter of it did. A
 * narrower embedder is kept as it is. Queries are cut the same way.
 */
export const VAULT_INDEX_DIMS = 1024;

/**
 * The vault's own vector budget (Shard's is for the owner's folders): enough
 * for ~40k chunks at {@link VAULT_INDEX_DIMS}, a vault of several thousand
 * pages with room to grow.
 */
export const VAULT_INDEX_BUDGET_BYTES = 160 * 1024 * 1024;

/** The most chunks the vault index holds for vectors `dims` wide. */
export function vaultMaxChunks(dims: number): number {
  const width = Math.max(1, Math.min(VAULT_INDEX_DIMS, Number.isFinite(dims) && dims > 0 ? dims : VAULT_INDEX_DIMS));
  return Math.max(1, Math.floor(VAULT_INDEX_BUDGET_BYTES / (width * Float32Array.BYTES_PER_ELEMENT)));
}

/** A vector cut to {@link VAULT_INDEX_DIMS} and normalised to unit length again (Matryoshka truncation). */
export function truncateVector(vec: Float32Array, dims = VAULT_INDEX_DIMS): Float32Array {
  if (vec.length <= dims) return vec;
  const out = vec.slice(0, dims);
  let sum = 0;
  for (let i = 0; i < out.length; i++) sum += out[i] * out[i];
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

export const VAULT_INDEX_FILE = "shard-index.sqlite";

/** A page bigger than this is not indexed (the vault's own read cap). */
const MAX_INDEXED_PAGE_BYTES = 1024 * 1024;

/**
 * How far a verified page or claim is lifted, added to its cosine similarity.
 *
 * Additive rather than a multiplier so the lift is the same at every
 * similarity: a verified answer beats an unverified one that is only a little
 * closer, and never one that is about something else entirely.
 *
 * The lifted score is CLAMPED to {@link MAX_SCORE}: Memory Shard merges these
 * hits with the owner's documents by score, and those are plain similarities
 * in 0..1 — a vault hit above 1 would outrank every document whatever it said.
 * The ORDER still follows the unclamped lift, so hits at the ceiling keep the
 * order the boost gave them.
 */
export const VERIFIED_BOOST = 0.1;

/**
 * How far a hub page (a `synthesis` page rolling up many leaves: a month of
 * shipments, of transfers, of daily reports) is lifted, so a query about the
 * kind of thing finds the hub before the hundred single parcels under it.
 */
export const HUB_BOOST = 0.08;

/** The page types ranked as hubs. */
export const HUB_TYPES: ReadonlySet<string> = new Set(["synthesis"]);

/** The ceiling of a hit's score, the same as a plain similarity's. */
export const MAX_SCORE = 1;

/** How much of a chunk a hit shows. */
const SNIPPET_CHARS = 400;

/** Vectors stay loaded this long after the last search (the Shard rule). */
const VECTOR_CACHE_IDLE_MS = 10 * 60 * 1000;

export type VaultHitKind = "page" | "claim";

/** One piece of a page that gets its own vector. Pure data, see {@link pageIndexUnits}. */
export interface VaultIndexUnit {
  /** The page id, or the claim's global id. */
  refId: string;
  kind: VaultHitKind;
  verified: boolean;
  /** Redacted text: what is embedded and what a hit shows. */
  text: string;
}

export interface VaultPageUnits {
  pageId: string;
  title: string;
  type: string;
  verified: boolean;
  units: VaultIndexUnit[];
}

/** A search hit from the vault. `path` is vault-relative, never absolute. */
export interface VaultSearchHit {
  source: "prime-radiant";
  path: string;
  /** Page id (`kind: "page"`) or global claim id (`kind: "claim"`). */
  id: string;
  kind: VaultHitKind;
  /** The page's type: entity, concept, howto, … */
  type: string;
  title: string;
  snippet: string;
  /** Ranking score: similarity plus {@link VERIFIED_BOOST} when verified, at most {@link MAX_SCORE}. */
  score: number;
  /** Cosine similarity, 0..1, before the boost. */
  similarity: number;
  verified: boolean;
}

export interface VaultIndexResult {
  /** `full` when the whole tree was looked at (first run, embedder change, recovery). */
  mode: "full" | "incremental";
  /** Pages embedded (new or changed) by this run. */
  indexed: number;
  /** Pages dropped because `main` no longer has them. */
  removed: number;
  /**
   * Pages whose vectors stayed as they were: their blob had not moved, or
   * what is embedded of them had not (a frontmatter metadata change), and
   * only their row followed the new blob.
   */
  unchanged: number;
  /** Pages not indexed because the chunk budget was full. */
  capped: number;
  pages: number;
  chunks: number;
}

export interface VaultIndexStatus {
  exists: boolean;
  pages: number;
  chunks: number;
  /** `mismatched`: built with another embedder (or schema); search answers nothing until the next run rebuilds it. */
  identity: "valid" | "mismatched" | "missing";
  /** The last run did not finish; the next run scans the whole tree. */
  needsFullScan: boolean;
  builtAt: number | null;
}

interface IndexOptions {
  vault?: string;
  signal?: AbortSignal;
}

// ─── pure halves ─────────────────────────────────────────────────────────────

function pageIdOf(rel: string, fm: PageFrontmatter): string {
  const own = typeof fm.id === "string" ? fm.id.trim() : "";
  if (own && own.length <= 256 && !/[\r\n]/.test(own)) return own;
  return rel.replace(/\.md$/, "");
}

function redacted(text: string): string {
  return redactText(text).text;
}

/**
 * What one page contributes to the index: its body in Shard-sized chunks
 * (each led by the title, so a chunk from the middle of a page still says what
 * it is about) and every claim on its own, so a hit can name the claim. Null
 * for a page whose frontmatter does not parse — lint keeps such pages out of
 * commits, and there is no type or id to report for one.
 */
export function pageIndexUnits(rel: string, text: string): VaultPageUnits | null {
  const parsed = parsePage(text);
  if (!parsed.ok) return null;
  const fm = parsed.frontmatter;
  const pageId = pageIdOf(rel, fm);
  const pageVerified = fm.verified != null;
  const title = fm.title.trim();
  const units: VaultIndexUnit[] = [];
  // The connect pass's link block is navigation, not content: never embedded.
  for (const chunk of chunkText(stripRelatedBlock(parsed.body))) {
    units.push({ refId: pageId, kind: "page", verified: pageVerified, text: redacted(`${title}\n\n${chunk}`) });
  }
  for (const claim of fm.claims) {
    const claimText = claim.text.trim();
    if (!claimText) continue;
    units.push({
      refId: claim.id,
      kind: "claim",
      verified: pageVerified || claim.verified != null || claim.status === "verified",
      text: redacted(`${title}: ${claimText}`),
    });
  }
  // A page with neither body nor claims is still findable by its title.
  if (units.length === 0 && title) units.push({ refId: pageId, kind: "page", verified: pageVerified, text: redacted(title) });
  return { pageId, title, type: fm.type, verified: pageVerified, units };
}

export interface RankCandidate {
  path: string;
  refId: string;
  kind: VaultHitKind;
  type: string;
  title: string;
  text: string;
  verified: boolean;
  similarity: number;
}

/** One hit per page or claim: the identity both the search and the ranking dedupe on. */
function hitKey(c: Pick<RankCandidate, "kind" | "refId" | "path">): string {
  return `${c.kind}\u0000${c.refId}\u0000${c.path}`;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Boost, deduplicate and order candidate chunks: one hit per page or claim
 * (its best chunk), verified ones lifted by {@link VERIFIED_BOOST} up to
 * {@link MAX_SCORE}, ties broken by similarity and then by id so the order is
 * stable.
 */
export function rankVaultHits(candidates: readonly RankCandidate[], limit: number): VaultSearchHit[] {
  // Ordered by the UNCLAMPED lift, so a verified hit at the ceiling still
  // ranks above an unverified one that reached it on similarity alone; only
  // the score handed out is clamped.
  const best = new Map<string, { hit: VaultSearchHit; rank: number }>();
  for (const c of candidates) {
    const similarity = Math.max(0, Math.min(1, c.similarity));
    const rank = similarity + (c.verified ? VERIFIED_BOOST : 0) + (c.kind === "page" && HUB_TYPES.has(c.type) ? HUB_BOOST : 0);
    const key = hitKey(c);
    const held = best.get(key);
    if (held && held.rank >= rank) continue;
    best.set(key, {
      rank,
      hit: {
        source: "prime-radiant",
        path: c.path,
        id: c.refId,
        kind: c.kind,
        type: c.type,
        title: c.title,
        snippet: c.text.slice(0, SNIPPET_CHARS),
        score: Math.min(MAX_SCORE, rank),
        similarity,
        verified: c.verified,
      },
    });
  }
  return [...best.values()]
    .sort((a, b) => b.rank - a.rank || b.hit.similarity - a.hit.similarity || a.hit.id.localeCompare(b.hit.id))
    .slice(0, Math.max(0, limit))
    .map(({ hit }) => ({ ...hit, score: round3(hit.score), similarity: round3(hit.similarity) }));
}

// ─── the store ───────────────────────────────────────────────────────────────

export function vaultIndexPathFor(vault: string): string {
  return path.join(path.dirname(path.resolve(vault)), VAULT_INDEX_FILE);
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS pages (
    path TEXT PRIMARY KEY,
    blob TEXT NOT NULL,
    page_id TEXT NOT NULL,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    verified INTEGER NOT NULL,
    chunks INTEGER NOT NULL,
    indexed_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    verified INTEGER NOT NULL,
    text TEXT NOT NULL,
    vec BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chunks_by_path ON chunks(path);
`;

async function openForWrite(file: string): Promise<DatabaseSync> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = openSqlite(file, false);
  try {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
    } catch {
      /* a speed-up, not a rule */
    }
    db.exec(SCHEMA);
  } catch (err) {
    try { db.close(); } catch { /* nothing more to do */ }
    throw err;
  }
  return db;
}

/** Open an existing store, or null. Never creates one (a search must not leave a file behind). */
async function openForRead(file: string): Promise<DatabaseSync | null> {
  try {
    if (!(await fs.stat(file)).isFile()) return null;
  } catch {
    return null;
  }
  try {
    return openSqlite(file, false);
  } catch (err) {
    console.warn(`[prime-radiant] could not open the vault index: ${errorText(err)}`);
    return null;
  }
}

function metaGet(db: DatabaseSync, key: string): string | null {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value?: unknown } | undefined;
    return typeof row?.value === "string" ? row.value : null;
  } catch {
    return null;
  }
}

function metaSet(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

function countOf(db: DatabaseSync, sql: string): number {
  try {
    const n = Number((db.prepare(sql).get() as { n?: unknown } | undefined)?.n ?? 0);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** What this store must have been built for: the embedder, the vault, the schema. */
function storeIdentity(embedder: ResolvedEmbedder, vault: string): string {
  return crypto
    .createHash("sha256")
    .update(`${embedderIdentity(embedder)}|${path.resolve(vault)}|v${VAULT_INDEX_SCHEMA}|d${VAULT_INDEX_DIMS}`)
    .digest("hex")
    .slice(0, 16);
}

function toBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── reading `main` ──────────────────────────────────────────────────────────

const BLOB_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

interface TreeEntry {
  blob: string;
  size: number;
}

/**
 * Every knowledge page on `main` with its blob id, or null when there is no
 * `main` to read (no vault, an empty repository). `ls-tree -l` gives the size
 * too, so an oversized page is skipped without being read.
 */
async function mainTree(vault: string): Promise<Map<string, TreeEntry> | null> {
  const r = await git(vault, ["ls-tree", "-r", "-l", "-z", `refs/heads/${VAULT_MAIN_BRANCH}`], { allowFail: true });
  if (r.code !== 0) return null;
  const tree = new Map<string, TreeEntry>();
  for (const record of r.stdout.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, object, size] = record.slice(0, tab).trim().split(/\s+/);
    const rel = safePagePath(record.slice(tab + 1));
    if (type !== "blob" || (mode !== "100644" && mode !== "100755") || !rel || rel !== record.slice(tab + 1) || !isKnowledgePage(rel)) continue;
    // The id is taken out of the match rather than passed through.
    const blob = BLOB_RE.exec(object ?? "")?.[0];
    if (!blob) continue;
    tree.set(rel, { blob, size: Number(size) || 0 });
  }
  return tree;
}

async function readBlob(vault: string, blob: string): Promise<string | null> {
  const id = BLOB_RE.exec(blob)?.[0];
  if (!id) return null;
  const r = await git(vault, ["cat-file", "blob", id], { allowFail: true });
  return r.code === 0 ? r.stdout : null;
}

/** Is `vault` a repository of its own (not a folder inside someone else's)? Read-only. */
async function isVaultRepo(vault: string): Promise<boolean> {
  try {
    if (!(await fs.stat(vault)).isDirectory()) return false;
  } catch {
    return false;
  }
  const top = await git(vault, ["rev-parse", "--show-toplevel"], { allowFail: true });
  return top.code === 0 && path.resolve(top.stdout.trim()) === path.resolve(vault);
}

// ─── one run ─────────────────────────────────────────────────────────────────

/** Whether a page's stored chunks are exactly `units`, in order: the same ids, kinds, verification and text. */
function sameUnits(rows: unknown[], units: readonly VaultIndexUnit[]): boolean {
  if (rows.length !== units.length) return false;
  return rows.every((row, i) => {
    const r = row as { ref_id?: unknown; kind?: unknown; verified?: unknown; text?: unknown };
    const u = units[i];
    return r.ref_id === u.refId && r.kind === u.kind && Number(r.verified) === (u.verified ? 1 : 0) && r.text === u.text;
  });
}

const PROBE_TEXT = "prime radiant vault index readiness check";

/**
 * Bring the index in step with `main` — for `paths`, or the whole tree when
 * `paths` is null (or the store asks for it). Not serialised: callers go
 * through {@link reindexPrimeRadiantPaths} / {@link reindexPrimeRadiantVault}.
 */
async function syncOnce(vault: string, paths: ReadonlySet<string> | null, signal?: AbortSignal): Promise<VaultIndexResult | null> {
  // Never git -C into a folder that is not the vault's own repository: under
  // the box's data dir that would read whatever repository encloses it.
  if (!(await isVaultRepo(vault))) return null;
  const tree = await mainTree(vault);
  if (!tree) return null;

  const embedder = await resolveMemoryEmbedder();
  const identity = storeIdentity(embedder, vault);
  const ceiling = vaultMaxChunks(embedder.dimensions);
  const db = await openForWrite(vaultIndexPathFor(vault));
  try {
    const disowned = metaGet(db, "identity") !== identity;
    const full = paths === null || disowned || metaGet(db, "needs_full") === "1";
    // Marked before any work and cleared only by a run that finished, so a run
    // the embedder (or a crash) cut short is followed by a whole-tree scan.
    metaSet(db, "needs_full", "1");

    if (disowned && countOf(db, "SELECT COUNT(*) AS n FROM chunks") > 0) {
      // The vectors on disk answer to another model (or another vault). The
      // embedder answers ONE request before they are thrown away, so a run
      // that cannot embed leaves the old index in place.
      await embedMemoryTexts([PROBE_TEXT], "document", signal, embedder);
      db.exec("DELETE FROM chunks; DELETE FROM pages;");
      db.prepare("DELETE FROM meta WHERE key = 'identity'").run();
    }

    const stored = new Map<string, string>();
    for (const row of db.prepare("SELECT path, blob FROM pages").all() as { path?: unknown; blob?: unknown }[]) {
      if (typeof row.path === "string" && typeof row.blob === "string") stored.set(row.path, row.blob);
    }
    const targets = new Set<string>();
    if (full) {
      for (const rel of tree.keys()) targets.add(rel);
      for (const rel of stored.keys()) targets.add(rel);
    } else {
      for (const rel of paths!) targets.add(rel);
    }

    const sql = {
      dropChunks: db.prepare("DELETE FROM chunks WHERE path = ?"),
      dropPage: db.prepare("DELETE FROM pages WHERE path = ?"),
      chunksFor: db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE path = ?"),
      chunksOf: db.prepare("SELECT ref_id, kind, verified, text FROM chunks WHERE path = ? ORDER BY id"),
      insertChunk: db.prepare("INSERT INTO chunks (path, ref_id, kind, verified, text, vec) VALUES (?, ?, ?, ?, ?, ?)"),
      upsertPage: db.prepare(
        `INSERT INTO pages (path, blob, page_id, title, type, verified, chunks, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET blob = excluded.blob, page_id = excluded.page_id, title = excluded.title,
           type = excluded.type, verified = excluded.verified, chunks = excluded.chunks, indexed_at = excluded.indexed_at`,
      ),
    };
    const tx = (fn: () => void) => {
      db.exec("BEGIN");
      try {
        fn();
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    };

    let chunkCount = countOf(db, "SELECT COUNT(*) AS n FROM chunks");
    let indexed = 0;
    let removed = 0;
    let unchanged = 0;
    let capped = 0;
    let wrote = false;

    for (const rel of [...targets].sort()) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const entry = tree.get(rel);
      if (!entry || entry.size > MAX_INDEXED_PAGE_BYTES) {
        if (stored.has(rel)) {
          tx(() => {
            sql.dropChunks.run(rel);
            sql.dropPage.run(rel);
          });
          chunkCount = countOf(db, "SELECT COUNT(*) AS n FROM chunks");
          removed += 1;
          wrote = true;
        }
        continue;
      }
      if (stored.get(rel) === entry.blob) {
        unchanged += 1;
        continue;
      }
      const text = await readBlob(vault, entry.blob);
      const page = text === null ? null : pageIndexUnits(rel, text);
      const units = page?.units ?? [];
      const existing = Number((sql.chunksFor.get(rel) as { n?: unknown } | undefined)?.n ?? 0) || 0;
      // What is embedded of the page did not move (its domain, owner, privacy
      // or status changed, say): its vectors stay, only its row follows the
      // new blob, and the embedder is not asked again.
      if (page && existing > 0 && existing === units.length && sameUnits(sql.chunksOf.all(rel), units)) {
        tx(() => {
          sql.upsertPage.run(rel, entry.blob, page.pageId, page.title, page.type, page.verified ? 1 : 0, units.length, Date.now());
        });
        unchanged += 1;
        wrote = true;
        continue;
      }
      if (chunkCount - existing + units.length > ceiling) {
        capped += 1;
        continue;
      }
      const vectors: Float32Array[] = [];
      for (let at = 0; at < units.length; at += MEMORY_EMBED_BATCH_INPUTS) {
        const batch = units.slice(at, at + MEMORY_EMBED_BATCH_INPUTS).map((u) => u.text);
        vectors.push(...(await embedMemoryTexts(batch, "document", signal, embedder)).map((v) => truncateVector(v)));
      }
      tx(() => {
        sql.dropChunks.run(rel);
        units.forEach((u, i) => {
          sql.insertChunk.run(rel, u.refId, u.kind, u.verified ? 1 : 0, u.text, toBlob(vectors[i]));
        });
        // An unparseable page is recorded too (with no chunks), so its blob is
        // not read again until it changes.
        sql.upsertPage.run(
          rel, entry.blob, page?.pageId ?? rel.replace(/\.md$/, ""), page?.title ?? "", page?.type ?? "",
          page?.verified ? 1 : 0, units.length, Date.now(),
        );
      });
      chunkCount = chunkCount - existing + units.length;
      indexed += 1;
      wrote = true;
    }

    const dim = db.prepare("SELECT vec FROM chunks LIMIT 1").get() as { vec?: Uint8Array } | undefined;
    tx(() => {
      metaSet(db, "identity", identity);
      metaSet(db, "built_at", String(Date.now()));
      metaSet(db, "capped", capped > 0 ? "1" : "");
      // A capped page was never recorded; only a whole-tree run can pick it up.
      metaSet(db, "needs_full", capped > 0 ? "1" : "");
      if (dim?.vec) metaSet(db, "dim", String(dim.vec.byteLength / Float32Array.BYTES_PER_ELEMENT));
      if (wrote) metaSet(db, "generation", String(Number(metaGet(db, "generation") ?? 0) + 1));
    });
    if (wrote) dropVectorCache(vaultIndexPathFor(vault));
    return {
      mode: full ? "full" : "incremental",
      indexed,
      removed,
      unchanged,
      capped,
      pages: countOf(db, "SELECT COUNT(*) AS n FROM pages"),
      chunks: countOf(db, "SELECT COUNT(*) AS n FROM chunks"),
    };
  } finally {
    db.close();
  }
}

// ─── the queue ───────────────────────────────────────────────────────────────

interface VaultQueue {
  lock: SerialLock;
  pending: Set<string>;
  full: boolean;
}

/** Per vault, per PROCESS (this module is compiled more than once — see process-store.ts). */
function queueFor(vault: string): VaultQueue {
  const queues = processStore("prime-radiant:shard-index-queues", () => new Map<string, VaultQueue>());
  const key = path.resolve(vault);
  let q = queues.get(key);
  if (!q) {
    q = { lock: createSerialLock(), pending: new Set(), full: false };
    queues.set(key, q);
  }
  return q;
}

/**
 * May the vault be indexed at all? Only while the owner has Memory Shard
 * switched on — the vault is one of its sources, and "off" means nothing is
 * embedded, on this box or in the cloud — and only once the vault exists (a
 * repository with a first commit). Read at every run, never cached: the switch
 * can change between a commit and the run it queued.
 */
export async function vaultIndexingAllowed(vault: string = vaultDir()): Promise<boolean> {
  try {
    return (await getMemoryShardEnabled()) && (await vaultInitialised(vault));
  } catch (err) {
    console.warn(`[prime-radiant] could not tell whether the vault may be indexed: ${errorText(err)}`);
    return false;
  }
}

function enqueue(vault: string, paths: readonly string[] | null, signal?: AbortSignal): Promise<VaultIndexResult | null> {
  const q = queueFor(vault);
  if (paths === null) q.full = true;
  else for (const p of paths) q.pending.add(p);
  return q.lock(async () => {
    // Everything queued up to now goes in this run; a caller whose paths an
    // earlier run already took answers null.
    if (!q.full && q.pending.size === 0) return null;
    const full = q.full;
    const taken = new Set(q.pending);
    q.full = false;
    q.pending.clear();
    // Paths dropped here are not lost: switching Memory Shard on starts a
    // whole-vault run, which compares every page's blob with the store.
    if (!(await vaultIndexingAllowed(vault))) return null;
    return syncOnce(vault, full ? null : taken, signal);
  });
}

/**
 * The incremental reindex hook: re-embed the named vault pages that changed on
 * `main` and drop the ones it no longer has. Paths that are not knowledge pages
 * (index.md, `.openclaw-wiki/`, …) are ignored. Answers null when there was
 * nothing to do (no vault, nothing queued); throws when the embedder refused —
 * the store is then marked for a whole-tree scan on the next run.
 */
export function reindexPrimeRadiantPaths(paths: readonly string[], options: IndexOptions = {}): Promise<VaultIndexResult | null> {
  const pages = paths
    .map((p) => safePagePath(p))
    .filter((p): p is string => p !== null && isKnowledgePage(p));
  if (pages.length === 0) return Promise.resolve(null);
  return enqueue(options.vault ?? vaultDir(), pages, options.signal);
}

/** A whole-tree run: first build, recovery, or after the embedder changed. */
export function reindexPrimeRadiantVault(options: IndexOptions = {}): Promise<VaultIndexResult | null> {
  return enqueue(options.vault ?? vaultDir(), null, options.signal);
}

/**
 * What `vaultOperation` calls after a commit: fire and forget. Only a commit on
 * `main` is indexed — a `dream/` branch is merged first, and the merge calls
 * {@link reindexPrimeRadiantPaths} itself. Never throws, never blocks.
 */
export function scheduleReindexAfterCommit(vault: string, changed: readonly string[]): void {
  if (!changed.some((p) => isKnowledgePage(p))) return;
  void (async () => {
    if ((await currentBranch(vault)) !== VAULT_MAIN_BRANCH) return;
    await reindexPrimeRadiantPaths(changed, { vault });
  })().catch((err) => {
    console.warn(`[prime-radiant] vault reindex after commit did not finish: ${errorText(err)}`);
  });
}

// ─── status and search ───────────────────────────────────────────────────────

export async function vaultIndexStatus(vault: string = vaultDir()): Promise<VaultIndexStatus> {
  const db = await openForRead(vaultIndexPathFor(vault));
  if (!db) return { exists: false, pages: 0, chunks: 0, identity: "missing", needsFullScan: false, builtAt: null };
  try {
    const stored = metaGet(db, "identity");
    const now = storeIdentity(await resolveMemoryEmbedder(), vault);
    const built = Number(metaGet(db, "built_at"));
    return {
      exists: true,
      pages: countOf(db, "SELECT COUNT(*) AS n FROM pages"),
      chunks: countOf(db, "SELECT COUNT(*) AS n FROM chunks"),
      identity: stored === null ? "missing" : stored === now ? "valid" : "mismatched",
      needsFullScan: metaGet(db, "needs_full") === "1",
      builtAt: Number.isFinite(built) && built > 0 ? built : null,
    };
  } finally {
    db.close();
  }
}

interface VectorCache {
  stamp: string;
  dim: number;
  vectors: Float32Array;
  ids: number[];
  verified: Uint8Array;
  /** What each row is lifted by: verified, hub page. */
  lift: Float32Array;
}

interface CacheSlot {
  cache: VectorCache | null;
  timer: ReturnType<typeof setTimeout> | null;
}

function cacheSlot(file: string): CacheSlot {
  const slots = processStore("prime-radiant:shard-index-vectors", () => new Map<string, CacheSlot>());
  let slot = slots.get(file);
  if (!slot) {
    slot = { cache: null, timer: null };
    slots.set(file, slot);
  }
  return slot;
}

function dropVectorCache(file: string): void {
  const slot = cacheSlot(file);
  slot.cache = null;
  if (slot.timer) clearTimeout(slot.timer);
  slot.timer = null;
}

/** For the tests, which build several stores in one process. */
export function _resetVaultIndexCacheForTests(): void {
  const slots = processStore("prime-radiant:shard-index-vectors", () => new Map<string, CacheSlot>());
  for (const file of slots.keys()) dropVectorCache(file);
}

function loadVectors(db: DatabaseSync, file: string): VectorCache | null {
  const slot = cacheSlot(file);
  const stamp = metaGet(db, "generation") ?? "0";
  const arm = () => {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => dropVectorCache(file), VECTOR_CACHE_IDLE_MS);
    slot.timer.unref?.();
  };
  if (slot.cache?.stamp === stamp) {
    arm();
    return slot.cache;
  }
  const total = countOf(db, "SELECT COUNT(*) AS n FROM chunks");
  if (total === 0) return null;
  let vectors: Float32Array | null = null;
  let bytes: Uint8Array | null = null;
  let dim = 0;
  const ids: number[] = [];
  const verified = new Uint8Array(total);
  const lift = new Float32Array(total);
  for (const raw of db
    .prepare("SELECT c.id AS id, c.verified AS verified, c.vec AS vec, c.kind AS kind, p.type AS type FROM chunks c LEFT JOIN pages p ON p.path = c.path ORDER BY c.id")
    .iterate()) {
    const row = raw as { id?: unknown; verified?: unknown; vec?: unknown; kind?: unknown; type?: unknown };
    const vec = row.vec as Uint8Array;
    if (!vectors) {
      dim = vec.byteLength / Float32Array.BYTES_PER_ELEMENT;
      if (!Number.isInteger(dim) || dim === 0) return null;
      vectors = new Float32Array(total * dim);
      bytes = new Uint8Array(vectors.buffer);
    }
    if (vec.byteLength !== dim * Float32Array.BYTES_PER_ELEMENT || ids.length >= total) continue;
    bytes!.set(vec, ids.length * dim * Float32Array.BYTES_PER_ELEMENT);
    verified[ids.length] = Number(row.verified) ? 1 : 0;
    lift[ids.length] = (Number(row.verified) ? VERIFIED_BOOST : 0) + (row.kind === "page" && typeof row.type === "string" && HUB_TYPES.has(row.type) ? HUB_BOOST : 0);
    ids.push(Number(row.id));
  }
  if (!vectors || ids.length === 0) return null;
  slot.cache = { stamp, dim, vectors: vectors.subarray(0, ids.length * dim), ids, verified: verified.subarray(0, ids.length), lift: lift.subarray(0, ids.length) };
  arm();
  return slot.cache;
}

/**
 * Search the vault. Answers [] when there is no index yet, or when it was
 * built with another embedder (the next run rebuilds it); throws
 * `EmbeddingUnavailableError` when the query cannot be embedded.
 */
export async function searchPrimeRadiant(
  query: string,
  limit: number,
  signal?: AbortSignal,
  vault: string = vaultDir(),
): Promise<VaultSearchHit[]> {
  const text = query.trim();
  if (!text) return [];
  const want = Math.max(1, Math.min(50, Math.trunc(limit) || 1));
  const file = vaultIndexPathFor(vault);
  const db = await openForRead(file);
  if (!db) return [];
  try {
    const embedder = await resolveMemoryEmbedder();
    if (metaGet(db, "identity") !== storeIdentity(embedder, vault)) return [];
    // The query text leaves the box too when the embedder is the cloud one.
    const embedding = embedMemoryTexts([redacted(text)], "query", signal, embedder);
    embedding.catch(() => {});
    const cache = loadVectors(db, file);
    if (!cache) return [];
    const [raw] = await embedding;
    const q = raw ? truncateVector(raw) : raw;
    if (!q || q.length !== cache.dim) return [];

    // Every row scored, then read best first until `want` distinct pages and
    // claims are held: a page can fill more chunks than any fixed pool, and a
    // pool cut before the dedupe could hand back one hit for a request of ten.
    // Boosted order is rank order (the clamp is monotonic), so the first chunk
    // seen for an identity is the one `rankVaultHits` would keep.
    const boostedAt = new Float64Array(cache.ids.length);
    for (let row = 0; row < cache.ids.length; row += 1) {
      let s = 0;
      const base = row * cache.dim;
      for (let i = 0; i < cache.dim; i += 1) s += cache.vectors[base + i] * q[i];
      boostedAt[row] = s + cache.lift[row];
    }
    const order = Array.from(cache.ids.keys()).sort((a, b) => boostedAt[b] - boostedAt[a] || a - b);

    const detail = db.prepare(
      `SELECT c.path AS path, c.ref_id AS ref_id, c.kind AS kind, c.verified AS verified, c.text AS text,
              p.title AS title, p.type AS type
         FROM chunks c JOIN pages p ON p.path = c.path WHERE c.id = ?`,
    );
    const candidates: RankCandidate[] = [];
    const held = new Set<string>();
    for (const at of order) {
      if (held.size >= want) break;
      const row = detail.get(cache.ids[at]) as Record<string, unknown> | undefined;
      if (!row || typeof row.path !== "string" || typeof row.text !== "string") continue;
      const verified = Number(row.verified) === 1;
      const candidate: RankCandidate = {
        path: row.path,
        refId: typeof row.ref_id === "string" ? row.ref_id : row.path,
        kind: row.kind === "claim" ? "claim" : "page",
        type: typeof row.type === "string" ? row.type : "",
        title: typeof row.title === "string" ? row.title : "",
        text: row.text,
        verified,
        similarity: boostedAt[at] - cache.lift[at],
      };
      const key = hitKey(candidate);
      if (held.has(key)) continue;
      held.add(key);
      candidates.push(candidate);
    }
    return rankVaultHits(candidates, want);
  } finally {
    db.close();
  }
}

/**
 * One vector per indexed page — the mean of its page chunks, unit length —
 * for the connect pass's related-page links. Empty when there is no index
 * (or it answers to another embedder). Read-only.
 */
export async function readPageVectors(vault: string = vaultDir()): Promise<Map<string, Float32Array>> {
  const out = new Map<string, Float32Array>();
  const db = await openForRead(vaultIndexPathFor(vault));
  if (!db) return out;
  try {
    if (metaGet(db, "identity") !== storeIdentity(await resolveMemoryEmbedder(), vault)) return out;
    const sums = new Map<string, Float32Array>();
    for (const raw of db.prepare("SELECT path, vec FROM chunks WHERE kind = 'page'").iterate()) {
      const row = raw as { path?: unknown; vec?: unknown };
      if (typeof row.path !== "string" || !(row.vec instanceof Uint8Array) || row.vec.byteLength % 4 !== 0) continue;
      const copy = new Float32Array(row.vec.byteLength / 4);
      new Uint8Array(copy.buffer).set(row.vec);
      const sum = sums.get(row.path);
      if (!sum) sums.set(row.path, copy);
      else if (sum.length === copy.length) for (let i = 0; i < sum.length; i++) sum[i] += copy[i];
    }
    for (const [p, v] of sums) {
      let n = 0;
      for (let i = 0; i < v.length; i++) n += v[i] * v[i];
      const norm = Math.sqrt(n) || 1;
      for (let i = 0; i < v.length; i++) v[i] /= norm;
      out.set(p, v);
    }
    return out;
  } finally {
    db.close();
  }
}
