/**
 * Memory Shard's index on a box that has no OpenClaw.
 *
 * WHY THIS EXISTS. Memory Shard has always BEEN OpenClaw's memory index: the
 * app drove `openclaw memory status/index`, the folder list was OpenClaw's own
 * `memory.search.extraPaths`, and the desktop hid the app on the Hermes SKU
 * because opening it there would have opened onto errors. And that was the
 * right call at the time, because Hermes ships no index to point at: its
 * `memory` toolset reads and writes MEMORY.md directly, `hermes memory` only
 * configures third-party providers (honcho/mem0), and there is no reindex verb
 * at all — `scripts/clawbox-identity-sync.sh` records what happened the last
 * time someone assumed otherwise.
 *
 * So on that edition ClawBox owns the index itself. Everything it needs was
 * already on the box and harness-neutral: `clawbox-embed.service` (Qwen3
 * embeddings on llama.cpp) is installed on every edition, and the local-AI
 * proxy in front of it is what wakes the unit on the first request, restores
 * the model's query instruction and trims an input that would not fit the
 * batch. This module is the four things that were missing — a chunker, a
 * store, an embedding client and a status — and nothing more.
 *
 * IT IMPERSONATES `openclaw memory status --deep --json`. `localMemoryStatusJson`
 * emits the same row shape the OpenClaw probe does, and `clawkeep-memory.ts`
 * feeds it through the SAME `parseMemoryStatus`. That is not a trick for its
 * own sake: it means the health rules, the fingerprint, the index-size read and
 * the whole `MemoryStatusErrorCode` catalogue — and therefore all ten locale
 * packs and every Memory Shard component — are shared rather than reimplemented,
 * and a Hermes box cannot drift into saying something no screen can word.
 *
 * SERVER ONLY: sqlite, the filesystem, and a loopback call to this box's own
 * proxy.
 */

import crypto from "crypto";
import fs from "fs/promises";
import { constants as fsConstants } from "fs";
import path from "path";
import { DATA_DIR, get as configGet, set as configSet } from "@/lib/config-store";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { openSqlite } from "@/lib/openclaw-session-store";
import { getEmbedProvisioningStatus } from "@/lib/embed-server";
import { getLocalAiToken } from "@/lib/local-ai-token";
import {
  clawaiCredentialGeneration,
  clawaiCredentialRefused,
  noteClawaiCredentialRefused,
  proxyRefusedClawaiCredential,
} from "@/lib/harness/credentials";
import {
  assertEmbedEndpointAllowed,
  embedderUsable,
  resolveMemoryEmbedder,
  type ResolvedEmbedder,
} from "@/lib/memory-embedder";
import { EXTRACT_ROOT, MAX_DOCUMENT_BYTES, extractDocuments, newWalkBudget, walkFiles } from "@/lib/memory-extract";
import { isInside } from "@/lib/file-guard";
import { readConfig as readOpenclawConfig, runOpenclawConfigSetBatch } from "@/lib/openclaw-config";
import {
  EXTRA_PATHS_CONFIG_PATH,
  INDEXABLE_EXTENSIONS,
  LOCAL_EMBEDDING_DIMENSIONS,
  MEMORY_SHARD_SOURCES_KEY,
  extraPathsOf,
  stringList,
} from "@/lib/memory-shard-state";
// Type-only, so nothing at runtime crosses back to the module that imports
// this one — `clawkeep-memory.ts` is the arm that CALLS the pass.
import type { MemoryIndexMode } from "@/lib/clawkeep-memory";

/**
 * Where the index lives.
 *
 * Under `DATA_DIR` and on NEITHER keep-list, which is the answer to both
 * questions a store like this raises. A factory reset wipes it
 * (`src/app/setup-api/setup/reset/route.ts` keeps `data/embed/models` — the
 * weights, which are cache — and nothing else here), and it must: the chunks
 * table holds the TEXT of the owner's own documents, so leaving it for the next
 * owner would be leaving their filing cabinet behind. ClawKeep does not back it
 * up either — its Hermes allowlist covers `~/.hermes` and the identity bridge,
 * not this — and that is right as well: every byte is derived from files the
 * owner still has, and a snapshot carrying a second copy of their documents is
 * a second place for them to leak from.
 */
export const LOCAL_INDEX_DIR = path.join(DATA_DIR, "memory-index");
export const LOCAL_INDEX_PATH = path.join(LOCAL_INDEX_DIR, "index.sqlite");

/**
 * Bumped when the tables change shape. A mismatch is treated exactly like an
 * embedder change: the store is emptied and rebuilt, because an index this
 * build cannot read is worth no more than one built by another model.
 */
const SCHEMA_VERSION = "1";

/**
 * Chunk size in CHARACTERS, and how much of the previous chunk a hard split
 * repeats.
 *
 * ~1,200 characters is ~300 tokens of English, comfortably under the ~1,016
 * the proxy's fit guard trims to. CJK runs closer to one token per character
 * and would be trimmed there — the guard trims rather than refusing
 * (`embed-input-fit.ts`), so that degrades recall on a long CJK paragraph
 * rather than failing the run. Measuring every chunk through llama-server's
 * /tokenize would cost a round trip per chunk; the heuristic is the trade.
 */
const CHUNK_CHARS = 1_200;
const CHUNK_OVERLAP = 150;

/** Inputs per embeddings request. ~20 KB of body — far inside the proxy's cap. */
const EMBED_BATCH_INPUTS = 16;

/**
 * THE CEILING IS A MEMORY BUDGET, so it is derived from the budget and not
 * written down as a number.
 *
 * Every chunk costs `dimensions x 4` bytes of float32 twice over — once in the
 * sqlite blob and once in the vector cache a search loads — and the two
 * embedders this box can use are not the same width: Qwen3-Embedding-0.6B is
 * 1,024 dimensions (4 KB a chunk) and the ClawBox AI cloud model is 3,072
 * (12 KB a chunk). The old flat 20,000 was sized against the first of those —
 * ~80 MB of vectors over ~25 MB of source text, which is a great deal of
 * personal notes and still fits beside the agent on an Orin — and the cloud
 * arm tripled the width underneath it, which would have been ~234 MiB of
 * vectors in one contiguous allocation on a box with 7.4 GB shared with a
 * local model and a 2 GB embedder.
 *
 * So the BUDGET is the constant now and the ceiling follows the embedder. The
 * number is exactly what 20,000 chunks of the on-device model weigh, so that
 * arm is unchanged to the chunk and the cloud arm lands at 6,666.
 */
const MAX_LOCAL_INDEX_CHUNKS = 20_000;

const INDEX_VECTOR_BUDGET_BYTES = MAX_LOCAL_INDEX_CHUNKS * LOCAL_EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT;

/**
 * How many chunks this box will hold for an embedder of this width.
 *
 * Reaching it is reported, never silent — a cap nobody is told about reads as
 * "everything is indexed". A width that is not a positive number (nothing
 * resolves one today, but the field is carried rather than computed here)
 * falls back to the on-device ceiling rather than to zero, because a ceiling
 * of zero is an index that refuses every file.
 */
export function maxIndexChunks(dimensions: number): number {
  if (!Number.isFinite(dimensions) || dimensions <= 0) return MAX_LOCAL_INDEX_CHUNKS;
  return Math.max(1, Math.floor(INDEX_VECTOR_BUDGET_BYTES / (dimensions * Float32Array.BYTES_PER_ELEMENT)));
}

/** One embeddings request's budget. The unit may be cold on the first call. */
const EMBED_TIMEOUT_MS = 120_000;

/**
 * What a rebuild embeds to prove the model is there, before it empties the
 * store. Nothing of the owner's — the point is to spend the cheapest possible
 * request on the question — and it is never written to the index.
 */
const REBUILD_PROBE_TEXT = "clawbox memory index readiness check";

/** A document over this size is not read. The extractor's own bound, shared
 *  rather than repeated, so the two cannot drift into disagreeing. */
const MAX_INDEXABLE_BYTES = MAX_DOCUMENT_BYTES;

/**
 * The embedder could not be reached or refused the request.
 *
 * Its own class because it is the one failure that must END the pass: a run
 * that quietly recorded every file as failed and then reported "succeeded"
 * would leave the owner with a healthy-looking panel over an empty index. A
 * file that cannot be READ is the other kind and is counted and stepped over.
 */
export class EmbeddingUnavailableError extends Error {
  /**
   * The far side said "not now" rather than "no": a rate limit or a server
   * fault, which the SAME request may well survive a moment later. Carried on
   * the error rather than decided by the retry loop, because only the place
   * that read the status knows.
   */
  readonly retryable: boolean;
  /** What `Retry-After` asked for, in milliseconds, when it asked for anything. */
  readonly retryAfterMs: number | null;
  constructor(detail: string, retryable = false, retryAfterMs: number | null = null) {
    super(`The embedding model did not answer: ${detail}`);
    this.name = "EmbeddingUnavailableError";
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * A REBUILD IS ~1,250 REQUESTS TO A RATE-LIMITED ENDPOINT, and it starts by
 * emptying the store.
 *
 * Over the network a transient refusal is the EXPECTED case: one `429` or one
 * `503` at request 500 of a full rebuild used to end the pass with the tables
 * already emptied, and memory search then answered nothing until some later
 * scheduled pass happened to succeed — on a box with no armed slot,
 * indefinitely. So a batch the far side refused with "not now" is asked again,
 * a bounded number of times, with a widening wait it will honour `Retry-After`
 * over.
 *
 * THE CLOUD ARM ONLY, deliberately. On the loopback proxy the commonest refusal
 * is the MemAvailable wake guard's 502, and that is not a hiccup — it is the box
 * saying it cannot hold the model right now, which the pass is meant to respect
 * by ending. Retrying it would spend the guard's own answer three times over and
 * push the wake through on a device that had just refused it. A refusal that is
 * not transient at all (a 4xx that is not 429 — a bad model id, a lapsed plan)
 * is not retried on either arm: the next attempt would be refused the same way
 * and the pass would take three times as long to say so.
 */
const EMBED_RETRY_ATTEMPTS = 3;
const EMBED_RETRY_BASE_MS = 1_000;
/** No `Retry-After` may hold one batch longer than this. */
const EMBED_RETRY_MAX_WAIT_MS = 30_000;
/**
 * …and none may make it shorter than this.
 *
 * `Retry-After: 0` is a legal header and `err.retryAfterMs ?? wait` read the
 * zero as a number rather than as "nothing asked for", so a rate-limited
 * endpoint answering it was asked three times with NO pause between them —
 * precisely the hammer the backoff exists to prevent, aimed at the endpoint that
 * had just asked for room.
 */
export const EMBED_RETRY_MIN_WAIT_MS = 1_000;

/**
 * How long ONE interactive search may take, end to end.
 *
 * Sized against the caller that times it: `memory_shard_search` abandons the
 * call at 60 s (`mcp/tools/memory.ts`), so past that the box is spending a cold
 * llama.cpp wake on an answer nobody is waiting for any more — and the wake it
 * started carries on regardless, which is what makes the NEXT search warm. The
 * search route combines this with the caller's own `request.signal`.
 */
export const MEMORY_SEARCH_DEADLINE_MS = 60_000;

/** Is this status the far side saying "not now"? */
function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** `Retry-After` as milliseconds — seconds or an HTTP date — or null. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after")?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, EMBED_RETRY_MAX_WAIT_MS);
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  return Math.min(Math.max(0, at - Date.now()), EMBED_RETRY_MAX_WAIT_MS);
}

/** Wait, unless the pass is being abandoned — in which case say so at once. */
async function pauseBeforeRetry(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) throw new IndexPassAbortedError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new IndexPassAbortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The pass was abandoned — the two-hour budget, or a web server going down. */
export class IndexPassAbortedError extends Error {
  constructor() {
    super("Indexing was stopped");
    this.name = "IndexPassAbortedError";
  }
}

// ─── the owner's folders ─────────────────────────────────────────────────────

/**
 * The folders the owner added, on the edition where ClawBox is the indexer.
 *
 * On OpenClaw the list lives in `memory.search.extraPaths` precisely so that
 * ClawBox reads the setting that governs indexing rather than a mirror of it.
 * That invariant is kept here, not abandoned: on this edition ClawBox IS what
 * indexes, so its own store is the thing that governs, and there is still
 * exactly one copy of the list.
 */
export async function readLocalSources(): Promise<string[]> {
  return stringList(await configGet(MEMORY_SHARD_SOURCES_KEY));
}

export async function writeLocalSources(paths: readonly string[]): Promise<void> {
  await configSet(MEMORY_SHARD_SOURCES_KEY, [...paths]);
}

/**
 * Carry the owner's chosen folders across a harness swap.
 *
 * The swap's dialogue promises that what the assistant knows about the owner
 * carries over, and a list of folders they picked by hand is squarely that.
 * The two arms keep the list in different places by design — the one that
 * INDEXES owns the setting — so the swap has to move it, or the box comes up
 * with Memory Shard set up, switched on, and reading nothing at all: a feature
 * that looks broken rather than a setting that needs redoing.
 *
 * Called from `carryOverAfterSwap` in harness-swap.ts, beside the ClawBox AI
 * sign-in and the Telegram bot, because that is the one place a swap has
 * already happened and it runs exactly once. It was briefly done lazily inside
 * `readLocalSources` instead, which meant a WRITE on the path a polled status
 * route takes, single-flight machinery to stop that racing a folder edit, and
 * a carry-over in one direction only.
 *
 * Answers what it moved, so the swap can say so, and moves NOTHING it is not
 * sure of: only folders that are still there — a config left behind by a swap
 * is a snapshot of a moment, and resurrecting a folder the owner deleted is
 * worse than asking for it again — and never over a list the target arm
 * already has.
 */
export async function carryMemorySourcesTo(target: "openclaw" | "hermes"): Promise<number> {
  const toLocal = target === "hermes";
  const existing = toLocal ? await readLocalSources() : extraPathsOf(await readOpenclawConfig());
  if (existing.length) return 0;

  const named = toLocal ? extraPathsOf(await readOpenclawConfig()) : await readLocalSources();
  const kept: string[] = [];
  for (const folder of named) {
    // ClawBox's own derived-Markdown folders are not the owner's choices — the
    // local arm walks them from the source instead — so carrying one would put
    // a scratch directory in a list the owner is shown.
    if (isInside(path.resolve(folder), EXTRACT_ROOT)) continue;
    try {
      if ((await fs.stat(folder)).isDirectory()) kept.push(folder);
    } catch {
      /* gone since the swap */
    }
  }
  if (!kept.length) return 0;
  if (toLocal) await writeLocalSources(kept);
  else await runOpenclawConfigSetBatch([[EXTRA_PATHS_CONFIG_PATH, JSON.stringify(kept), "--json"]]);
  return kept.length;
}

// ─── the store ───────────────────────────────────────────────────────────────

/**
 * The handle `openSqlite` hands back.
 *
 * The ambient declaration in src/types/node-sqlite.d.ts, not a private copy of
 * the parts this file happens to use — a second surface here is a second thing
 * to keep in step with the runtime, and it is how `iterate` came to be missing.
 * Same shape openclaw-state-store.ts passes around.
 */
type IndexDb = DatabaseSyncType;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    display TEXT NOT NULL,
    mtime_ms INTEGER NOT NULL,
    size INTEGER NOT NULL,
    sha TEXT NOT NULL,
    chunks INTEGER NOT NULL,
    indexed_at INTEGER NOT NULL,
    error TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    ord INTEGER NOT NULL,
    text TEXT NOT NULL,
    vec BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chunks_by_path ON chunks(path);
`;

async function openIndexForWrite(): Promise<IndexDb> {
  await fs.mkdir(LOCAL_INDEX_DIR, { recursive: true, mode: 0o700 });
  const db = openSqlite(LOCAL_INDEX_PATH, false);
  // WAL so the panel can still READ while a pass is writing. An index run over
  // a real folder is minutes long and the status route is polled throughout;
  // under the default rollback journal every one of those reads would be
  // racing a writer for the same file, and `busy_timeout` would turn the
  // collisions into five-second stalls in the UI rather than into errors.
  try {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      // NORMAL, and safe here for a reason that is specific to this store.
      // Under WAL it cannot corrupt the database — it only risks losing the
      // last few commits to a power cut — and every byte in here is DERIVED
      // from files the owner still has, so the worst a lost commit costs is
      // re-embedding what the next pass would re-read anyway. Measured at 1.8x
      // on the whole write path even on an SSD; more on the box's eMMC.
      db.exec("PRAGMA synchronous = NORMAL");
    } catch {
      /* A filesystem that cannot do WAL still works; it is a speed-up, not a rule. */
    }
    db.exec(SCHEMA);
  } catch (err) {
    // The open is lazy, so a corrupt store or a full disk fails HERE, with a
    // handle already allocated. Left unclosed it is one leaked descriptor per
    // scheduled run, on a box where indexing is nightly.
    try { db.close(); } catch { /* nothing more to do about it */ }
    throw err;
  }
  return db;
}

/**
 * Open for reading, or null when there is no index yet.
 *
 * NEVER CREATES ONE, which is why the file is stat'd first rather than opened
 * with `readOnly: true` and the failure caught: a status read and a search must
 * not leave a database behind on a box whose owner never switched the feature
 * on, and sqlite creates one on any open that is not read-only.
 *
 * But the open ITSELF is read-write, and that is the point of the stat. The
 * store is in WAL mode, and a WAL left behind by a web server that died
 * mid-pass has to be recovered before anything can be read — which is a WRITE.
 * A read-only connection cannot do it and fails the open outright, so a crash
 * during indexing would have left the panel reporting "no index" and search
 * answering nothing about a database that is entirely intact. Nothing on this
 * path writes a row.
 */
/** Is there a store at all? A stat, so asking cannot create one. */
async function indexStoreExists(): Promise<boolean> {
  try {
    return (await fs.stat(LOCAL_INDEX_PATH)).isFile();
  } catch {
    return false;
  }
}

async function openIndexForRead(): Promise<IndexDb | null> {
  try {
    if (!(await fs.stat(LOCAL_INDEX_PATH)).isFile()) return null;
  } catch {
    return null;
  }
  try {
    return openSqlite(LOCAL_INDEX_PATH, false);
  } catch (err) {
    console.warn(`[memory-index] could not open the index: ${errorText(err)}`);
    return null;
  }
}

function metaGet(db: IndexDb, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value?: unknown } | undefined;
  return typeof row?.value === "string" ? row.value : null;
}

function metaSet(db: IndexDb, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

function countOf(db: IndexDb, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { n?: unknown } | undefined;
  const n = Number(row?.n ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// ─── index identity ──────────────────────────────────────────────────────────

/**
 * What this index was built FOR.
 *
 * `scripts/ensure-local-embeddings.sh` encodes the rule OpenClaw enforces for
 * itself: change the provider, the model or the endpoint and the vectors that
 * are on disk belong to somebody else. Nothing warns you — search simply stops
 * finding things while the panel still says healthy. So the identity is stamped
 * with the index and compared on every pass and every status read, and a
 * mismatch travels through the untouched `parseMemoryStatus` into the amber
 * "Run a full reindex" the OpenClaw box already shows.
 *
 * The vector dimension is deliberately NOT in it: it is unknowable until the
 * first embedding comes back, and this has to be stampable by the wizard's
 * provisioning step, before anything has been embedded. A dimension change is
 * caught on its own, where it becomes known — see `assertDimension`.
 */
export function embedderIdentity(embedder: ResolvedEmbedder): string {
  return crypto
    .createHash("sha256")
    .update(`${embedder.provider}|${embedder.model}|${embedder.baseUrl}|v${SCHEMA_VERSION}`)
    .digest("hex")
    .slice(0, 16);
}

/** The identity of the embedder this box uses right now. */
export async function localEmbeddingIdentity(): Promise<string> {
  return embedderIdentity(await resolveMemoryEmbedder());
}

/**
 * Record what the index is built for, without building anything.
 *
 * The Hermes half of `switchToLocalEmbeddings`/`switchToCloudEmbeddings`. On
 * OpenClaw those calls point an external client at an embedder; here there is
 * no external client to point — ClawBox is the client — so the write that
 * remains is the one fact that would otherwise be missing: which model the
 * vectors about to be written belong to.
 *
 * IT NEVER STAMPS OVER AN INDEX THAT HOLDS SOMETHING. The vectors on disk
 * belong to the embedder that wrote them, and a switch is exactly when that
 * stops being the one this returns: stamping the new embedder over them would
 * report `valid` — the shared parser's `healthy` — for an index whose rows are
 * the wrong width for every query, so search would answer nothing behind a
 * green panel. Left alone, the identity reads `mismatched`, the card draws the
 * amber "Run a full reindex", and the full pass every switch posts rebuilds it.
 */
export async function stampLocalEmbeddingIdentity(): Promise<void> {
  // AND IT NEVER CREATES THE STORE. `openIndexForRead`'s own invariant is that
  // a status read and a search must not leave a database behind on a box whose
  // owner never switched the feature on, and this call reaches that box now:
  // the automatic cloud promotion runs at BOOT, unattended, where it used to be
  // an owner pressing a switch. With no store there is nothing to stamp either
  // — `identityOf` answers `missing`, and the first pass stamps what it wrote.
  if (!(await indexStoreExists())) return;
  const identity = await localEmbeddingIdentity();
  const db = await openIndexForWrite();
  try {
    if (countOf(db, "SELECT COUNT(*) AS n FROM chunks") > 0) return;
    metaSet(db, "identity", identity);
    metaSet(db, "schema_version", SCHEMA_VERSION);
  } finally {
    db.close();
  }
}

/**
 * The folder list a pass covered, as one short row it can be compared against.
 *
 * Sorted, because the order the owner's list happens to be in is not part of
 * what was looked at, and hashed because the alternative is every one of the
 * owner's paths a second time in the store.
 */
function sourceListKey(sources: readonly string[]): string {
  return crypto.createHash("sha256").update(JSON.stringify([...sources].sort())).digest("hex").slice(0, 16);
}

function identityOf(db: IndexDb, sources: readonly string[], identity: string): "valid" | "missing" | "mismatched" {
  const stored = metaGet(db, "identity");
  if (!stored) return "missing";
  if (stored !== identity) return "mismatched";
  if (countOf(db, "SELECT COUNT(*) AS n FROM chunks") > 0) return "valid";
  // ZERO CHUNKS IS TWO DIFFERENT STATES, and only one of them is wrong. An
  // index emptied by a rebuild whose first embed failed must not read `valid`,
  // which the shared parser calls `healthy` — a green panel over a search that
  // finds nothing. But on a box whose folders hold no memory file yet, empty is
  // the FINISHED state, and reporting `missing` there put a permanent "Needs
  // attention — the index fingerprint is missing. Run a full reindex" on it:
  // the reindex scans the same zero files and leaves the same zero chunks, so
  // the remedy the card named could never clear the banner. A real OpenClaw box
  // in that state reports `valid` (the captured payload in
  // `src/tests/fixtures/openclaw-memory-status.json`), so this arm was the only
  // one of the two nagging, on a card both editions draw.
  //
  // Three things have to hold before an empty index may call itself correct,
  // and the pass that ended recorded the first two in the same transaction as
  // the identity. A pass has to have LOOKED (no row at all is the wizard's
  // stamp before the first pass, and an index older than these rows); it has to
  // have OWED nothing when it stopped; and what it looked at has to still be
  // what the owner has registered — "there is nothing to index" is a claim
  // about now, and a folder added after that pass makes it false. An index from
  // before this row is trusted on that last point only when nothing is
  // registered at all, which is the one configuration that cannot have gone
  // stale under it.
  //
  // The middle one used to read "the scan found no files at all", and that is
  // the same conflation one line up, one level down: zero chunks OVER FILES is
  // itself two states, and the FILES table is what tells them apart. A file the
  // pass finished with has a row — whatever the file held — and one it could
  // not read, could not embed or could not fit has none. So a folder whose
  // documents genuinely hold no text (a note the owner has not written yet, a
  // scanned PDF with no text layer, a document the extractor converted to
  // nothing) was carrying "the index fingerprint is missing. Run a full
  // reindex" for ever: the reindex reads the same files and writes the same
  // nothing, and the banner comes straight back — the exact loop this arm of
  // the rule exists to have closed. Work that did not happen still says
  // `missing`, because it leaves the scan's count above the rows, and it is
  // the same subtraction the card prints as `pendingFiles`, so the banner and
  // the tile can no longer disagree.
  //
  // A folder the walk could not open is deliberately NOT part of this: it is a
  // real fault, but the fault is the folder and not the fingerprint, a reindex
  // cannot clear it, and the pass already counts it where the card has a
  // "Failed" tile for it. `missing` is not what makes the next pass rebuild
  // either — that is `resolveIndexMode`, on the chunk count.
  const scanned = metaGet(db, "scan_total_files");
  if (scanned === null) return "missing";
  // Written as `!(owed <= 0)`, so an unreadable or half-written row — `Number`
  // of it being NaN — falls to `missing` rather than through to `valid`.
  const owed = Number(scanned) - countOf(db, "SELECT COUNT(*) AS n FROM files");
  if (!(owed <= 0)) return "missing";
  // A row is not proof the pass finished with the file. One indexed on an
  // earlier pass that this pass could not read keeps its old row — it is still
  // in the scan, so the stale sweep rightly leaves it — and the count above
  // then balances over work that did not happen. The pass records how many
  // files it left unfinished; an index from before that row has none, which is
  // the old rule. Same `!(… <= 0)` shape, so NaN falls to `missing`.
  if (!(Number(metaGet(db, "incomplete_files") ?? 0) <= 0)) return "missing";
  const covered = metaGet(db, "scan_sources");
  const stillTrue = covered === null ? sources.length === 0 : covered === sourceListKey(sources);
  return stillTrue ? "valid" : "missing";
}

// ─── embedding ───────────────────────────────────────────────────────────────

/**
 * Embed a batch with the embedder this box is pointed at — and at exactly one
 * of the two addresses that is allowed to be.
 *
 * LOCAL goes through THIS BOX'S OWN PROXY, never llama-server directly. Going
 * through `/setup-api/local-ai/embed/v1` is what wakes the unit on the first
 * request (and re-arms the idle stop that puts it away again), what restores
 * the Qwen3 query instruction that keeps recall from quietly degrading, and
 * what trims an input too long for the server's batch. A client that talked to
 * port 8081 would have to reimplement all three and would get one of them
 * subtly wrong.
 *
 * CLOUD goes to the ClawBox AI embeddings endpoint with the box's own `claw_`
 * bearer — the same request the OpenClaw edition's core makes from
 * `memory.search.remote.*`, and the same one `probeCloudEmbeddings` proved the
 * box can make before the switch was offered. No `input_type` there: it is an
 * unknown field on an OpenAI-shaped route, which is why the OpenClaw arm unsets
 * those two keys rather than leaving them.
 *
 * Anywhere else is refused — see `embedEndpointAllowed`.
 */
async function embedBatch(
  texts: readonly string[],
  inputType: "query" | "document",
  signal: AbortSignal | undefined,
  embedder: ResolvedEmbedder,
): Promise<Float32Array[]> {
  let wait = EMBED_RETRY_BASE_MS;
  // A QUERY IS SOMEBODY WAITING, and the rebuild's budget is the wrong one for
  // it: three attempts of up to `EMBED_TIMEOUT_MS` with two waits of up to 30 s
  // is about seven minutes inside a search the MCP tool abandons at 60 s. A
  // rebuild retries because the alternative is an emptied index; a query that
  // cannot be embedded now is answered now, and the person asks again.
  const attempts = inputType === "query" ? 1 : EMBED_RETRY_ATTEMPTS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await embedBatchOnce(texts, inputType, signal, embedder);
    } catch (err) {
      const transient = err instanceof EmbeddingUnavailableError && err.retryable;
      if (!transient || attempt >= attempts) throw err;
      const pause = Math.max(
        EMBED_RETRY_MIN_WAIT_MS,
        (err as EmbeddingUnavailableError).retryAfterMs ?? wait,
      );
      console.warn(
        `[memory-index] the embedder answered "not now" (attempt ${attempt}/${attempts}); retrying in ${Math.round(pause / 100) / 10}s`,
      );
      await pauseBeforeRetry(pause, signal);
      wait = Math.min(wait * 2, EMBED_RETRY_MAX_WAIT_MS);
    }
  }
}

/** One request, one answer. The retry above is what decides to ask again. */
async function embedBatchOnce(
  texts: readonly string[],
  inputType: "query" | "document",
  signal: AbortSignal | undefined,
  embedder: ResolvedEmbedder,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  // The owner's document text is about to become an HTTP body, so where it is
  // going is checked rather than assumed — at the moment the socket is opened,
  // not only where the choice was made.
  try {
    assertEmbedEndpointAllowed(embedder.source, embedder.baseUrl);
  } catch (err) {
    throw new EmbeddingUnavailableError(err instanceof Error ? err.message : String(err));
  }
  if (!embedderUsable(embedder)) {
    // Pointed at the cloud with no credential on the box. Said out loud rather
    // than quietly embedded on this box instead: that would write vectors from
    // another model into an index stamped for this one.
    throw new EmbeddingUnavailableError("this box holds no ClawBox AI credential for the cloud embedder");
  }
  const bearer = embedder.source === "cloud" ? embedder.token : getLocalAiToken();
  // Snapshotted BEFORE the request, so a refusal about a credential the box has
  // since replaced is dropped rather than remembered against the new one.
  const generation = clawaiCredentialGeneration();
  let res: Response;
  try {
    res = await fetch(embedder.requestUrl, {
      method: "POST",
      // A REDIRECT IS NOT A DESTINATION THIS BOX CHECKED. The fence above judges
      // `embedder.baseUrl`, and `fetch` follows a 307/308 on its own — with the
      // POST method and the body, which here is the owner's document or query
      // text, carried to wherever the answer pointed. Manual makes the redirect
      // the ANSWER, so it lands in the `!res.ok` branch below and the pass is
      // told the embedder did not answer, which is exactly what happened.
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({
        model: embedder.model,
        input: [...texts],
        ...(embedder.labelInputs ? { input_type: inputType } : {}),
      }),
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(EMBED_TIMEOUT_MS)]),
    });
  } catch (err) {
    if (signal?.aborted) throw new IndexPassAbortedError();
    // THE SOCKET FAILING IS THE COMMONEST TRANSIENT FAILURE, and it never
    // reaches an HTTP status: a reset connection, a DNS blip, a TLS error or the
    // `EMBED_TIMEOUT_MS` abort all arrive here. Constructed non-retryable, one
    // of them at request 200 of a 420-request rebuild ended the pass with
    // `DELETE FROM chunks` already done — no index at all until some later
    // scheduled pass happened to succeed. The caller's own abort is separated
    // one line above, so this cannot swallow a cancelled pass.
    //
    // The CLOUD ARM ONLY, the same fence the status rule uses: on the loopback
    // proxy a failure to connect is the embed unit being down or refusing the
    // wake, which the pass is meant to respect by ending rather than by dialling
    // a socket that is not there twice more.
    throw new EmbeddingUnavailableError(
      err instanceof Error ? err.message : String(err),
      embedder.source === "cloud",
    );
  }
  if (!res.ok) {
    // A CREDENTIAL THE PROXY ITSELF NAMES AS THE PROBLEM is remembered here, the
    // same two lines the picture and voice paths already use. Without them
    // nothing on the EMBEDDING path ever armed `clawaiCredentialRefused()`, so a
    // box whose credential the proxy refuses — revoked, re-minted on another
    // device, lost in a migration — and whose owner uses neither of those
    // features kept reporting `semanticAvailable: true` and `mode: active` while
    // every pass failed and every search threw: the guard was written and its
    // input never arrived.
    //
    // It has to be the proxy saying so, and `proxyRefusedClawaiCredential` is
    // the one place that judges it: 401 `missing_token` / 403 `invalid_token`
    // and nothing else. A bare 401/403 can come from an edge rule or an
    // interception proxy, and remembering one of those would send a customer
    // with a good credential to re-pair their box. NOT the proxy's PLAN gate
    // either, which is also a 403 (`clawai-cloud-defaults-state.ts`: "TTS is
    // Max-only on the proxy, which answers 403 to Free and Pro") — a plan that
    // does not cover the cloud embedder is a fact about the ACCOUNT, and this
    // memo is the one the box acts on by telling the owner to re-link a device
    // whose credential is perfectly good. 402 is not on the wire here at all:
    // it is what ClawBox's OWN routes answer (`refusePaidPlan`) and what the
    // portal answers to a device poll, never what the proxy sends.
    // Both bodies are cancelled on the way out: the helper reads the clone
    // only for a 401/403, so a 429 or a 5xx — the statuses the cloud arm
    // retries up to three times — would otherwise leave two unread bodies
    // holding their connection out of the fetch pool the next batch needs.
    const refusalCopy = embedder.source === "cloud" ? res.clone() : null;
    try {
      if (refusalCopy && (await proxyRefusedClawaiCredential(refusalCopy))) {
        await noteClawaiCredentialRefused(res.status, generation);
      }
    } finally {
      // Together, never one after the other: a clone tees the stream, and a
      // teed branch's cancel settles only once BOTH branches are cancelled.
      await Promise.all([
        refusalCopy?.body?.cancel().catch(() => {}),
        res.body?.cancel().catch(() => {}),
      ]);
    }
    // 502 here is the wake being refused — most often the MemAvailable guard
    // in `ensureLocalAiReady`, which is a real answer and not a bug: the box
    // is too busy to hold the model right now.
    throw new EmbeddingUnavailableError(
      `HTTP ${res.status}`,
      embedder.source === "cloud" && retryableStatus(res.status),
      retryAfterMs(res),
    );
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    throw new EmbeddingUnavailableError(err instanceof Error ? err.message : "unreadable answer");
  }
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new EmbeddingUnavailableError(`expected ${texts.length} embeddings, got ${Array.isArray(data) ? data.length : "none"}`);
  }
  const out = new Array<Float32Array | null>(texts.length).fill(null);
  for (let i = 0; i < data.length; i += 1) {
    const entry = data[i] as { embedding?: unknown; index?: unknown };
    const at = Number.isInteger(entry?.index) ? Number(entry.index) : i;
    const raw = entry?.embedding;
    if (!Array.isArray(raw) || raw.length === 0 || at < 0 || at >= texts.length) {
      throw new EmbeddingUnavailableError("an embedding came back empty");
    }
    out[at] = normalise(Float32Array.from(raw as number[]));
  }
  if (out.some((v) => v === null)) throw new EmbeddingUnavailableError("an embedding was missing from the answer");
  return out as Float32Array[];
}

/**
 * Unit length, once, at write time — so every later comparison is a dot
 * product rather than a cosine with two square roots per candidate.
 */
function normalise(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i += 1) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return vec;
  for (let i = 0; i < vec.length; i += 1) vec[i] /= norm;
  return vec;
}

function toBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

// ─── chunking ────────────────────────────────────────────────────────────────

/**
 * Split a document into embeddable pieces on paragraph boundaries.
 *
 * Paragraphs are joined until the next one would not fit, so a chunk is whole
 * thoughts rather than a fixed window sliding over the middle of sentences. A
 * single paragraph longer than one chunk is the case that has no natural seam,
 * and only there is the window used — with an overlap, so a fact that straddles
 * the cut is complete in one of the two halves.
 */
export function chunkText(raw: string): string[] {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
    current = "";
  };
  for (const paragraph of text.split(/\n{2,}/)) {
    const block = paragraph.trim();
    if (!block) continue;
    if (block.length > CHUNK_CHARS) {
      flush();
      for (let at = 0; at < block.length; at += CHUNK_CHARS - CHUNK_OVERLAP) {
        chunks.push(block.slice(at, at + CHUNK_CHARS));
        if (at + CHUNK_CHARS >= block.length) break;
      }
      continue;
    }
    if (current.length + block.length + 2 > CHUNK_CHARS) flush();
    current = current ? `${current}\n\n${block}` : block;
  }
  flush();
  return chunks;
}

// ─── one indexing pass ───────────────────────────────────────────────────────

export interface LocalIndexPassResult {
  mode: MemoryIndexMode;
  files: number;
  chunks: number;
  /** Files that could not be read or embedded. Counted, never fatal. */
  failures: number;
  /** True when the chunk ceiling (`maxIndexChunks`) stopped the pass short. */
  capped: boolean;
}

/**
 * How far this pass has got, for the bar the owner is watching.
 *
 * Files rather than chunks as the denominator: the total number of chunks is
 * not knowable until every file has been read, and a bar whose 100% moves is
 * worse than no bar. `chunks` travels beside it as a figure, never as the
 * fraction.
 */
export interface LocalIndexProgress {
  /** Files this pass has finished with — indexed, skipped or refused alike. */
  filesDone: number;
  /** Files the scan found. 0 until the scan has finished. */
  filesTotal: number;
  /** Chunks in the store as this pass has left it so far. */
  chunks: number;
}

/**
 * Told how far the pass has got. Called often — once per file — and it is the
 * CALLER that throttles what it does with that, because only the caller knows
 * what a report costs it (the run-state file is an atomic write).
 */
export type LocalIndexProgressReporter = (progress: LocalIndexProgress) => void;

function isIndexable(file: string): boolean {
  return (INDEXABLE_EXTENSIONS as readonly string[]).includes(path.extname(file).toLowerCase());
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new IndexPassAbortedError();
}

/**
 * Is the derived folder simply not there?
 *
 * Only ClawBox's own derived folder is asked. "Not there" and "could not be
 * opened" are one silence to `walkFiles`, and for the OWNER'S folder that is
 * exactly right — an unplugged drive must never look like an emptied one. For
 * the derived folder they are different facts, and only one of them is a fault:
 * see the caller.
 *
 * ENOENT and nothing else. Every other answer — a permission refused, an I/O
 * error, something that is not a folder — is "could not look", and it has to
 * reach the walk, which reports it as the shortfall it is. Folded into "absent"
 * it skipped the walk, the source was never marked unreadable, and the stale
 * sweep then deleted every derived document it had not seen: the owner's PDFs
 * gone from the index over a folder ClawBox could not open for a moment.
 */
async function derivedFolderAbsent(dir: string): Promise<boolean> {
  try {
    await fs.stat(dir);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/**
 * Every `.md` under one root, inside the shared walk budget — and whether the
 * walk actually SAW the whole tree.
 *
 * The second half is the load-bearing one. `walkFiles` swallows an opendir
 * failure and yields nothing, so a drive that is unplugged, a folder whose
 * permissions changed and a tree past the entry budget are all indistinguishable
 * from a folder the owner emptied. Only the caller knows that difference is the
 * difference between "delete this source's index" and "leave it exactly alone".
 */
async function indexableFilesUnder(root: string): Promise<{ files: string[]; complete: boolean }> {
  const files: string[] = [];
  const budget = newWalkBudget();
  for await (const file of walkFiles(path.resolve(root), budget)) {
    if (isIndexable(file)) files.push(file);
  }
  return { files, complete: !budget.rootUnreadable && budget.unreadable === 0 && !budget.truncated };
}

/**
 * What a search result should CALL a file.
 *
 * A `.md` the owner wrote is named by its path inside the folder they chose. A
 * derived file is ClawBox's own scratch copy of a PDF, and naming it by its
 * real filename would answer a question about the lease with
 * `contracts__lease.pdf-9f2c1a04bb7e.md`; `origins` from the extractor is what
 * turns that back into `Documents/contracts/lease.pdf`.
 */
/** The naming rule, for the tests — the walk cannot reach every case it covers. */
export const _displayNameForTests = (source: string, file: string, origins: Record<string, string>) =>
  displayName(source, file, origins);

function displayName(source: string, file: string, origins: Record<string, string>): string | null {
  const origin = origins[path.basename(file)];
  const label = path.basename(source);
  if (origin) return path.join(label, origin);
  const relative = path.relative(path.resolve(source), file);
  // A file that is not UNDER the source has no name in the owner's terms, and
  // the relative path to it would be a `../../…/data/memory-extracted/…` chain
  // — ClawBox's own scratch folder, handed to the agent as if it were the
  // owner's document. Refuse instead: the caller drops the file.
  //
  // `".." + sep`, not `startsWith("..")`: a document the owner named
  // `..notes.txt` is a file INSIDE the folder, and a prefix test would refuse
  // to index it. (The walk skips dot-prefixed entries today, so nothing reaches
  // this — which is exactly why the rule has to be right rather than lucky.)
  const escapes = relative === ".." || relative.startsWith(`..${path.sep}`);
  if (!relative || escapes || path.isAbsolute(relative)) return null;
  return path.join(label, relative);
}

/** A file this pass will read, held open so nothing can swap it underneath. */
interface OpenedFile {
  stat: { mtimeMs: number; size: number };
  read(): Promise<string>;
  close(): Promise<void>;
}

/**
 * Open one candidate for indexing, or null when it is not one.
 *
 * `O_NOFOLLOW`: a source folder is a directory the OWNER pointed at, and
 * anything inside it can be a symlink — including one aimed at a credential
 * store. The index reads real files under the folder, not wherever a link says.
 */
async function openForIndexing(file: string): Promise<OpenedFile | null> {
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let stat;
  try {
    stat = await handle.stat();
  } catch (err) {
    await handle.close();
    throw err;
  }
  if (!stat.isFile() || stat.size > MAX_INDEXABLE_BYTES) {
    await handle.close();
    return null;
  }
  return {
    stat: { mtimeMs: stat.mtimeMs, size: stat.size },
    read: async () => {
      const buffer = Buffer.alloc(stat.size);
      let read = 0;
      while (read < buffer.length) {
        const result = await handle.read(buffer, read, buffer.length - read, read);
        if (result.bytesRead === 0) break;
        read += result.bytesRead;
      }
      return buffer.subarray(0, read).toString("utf8");
    },
    close: async () => { await handle.close().catch(() => {}); },
  };
}

function sha256Of(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
}

interface PendingFile {
  file: string;
  source: string;
  display: string;
}

/**
 * Bring the index in step with the owner's folders.
 *
 * INCREMENTAL by default and by construction: a file whose size and mtime are
 * unchanged is not even read, and one that was touched without being edited is
 * read, hashed, and left alone. `full` (and an identity that no longer matches)
 * empties the store first, because the vectors then on disk answer to a
 * different model — but only once the embedder has answered one request, so a
 * reindex that cannot run leaves the index it was going to replace.
 *
 * A file that cannot be read is counted and stepped over. The EMBEDDER failing
 * ends the pass — see `EmbeddingUnavailableError`.
 */
export async function runLocalIndexPass(
  mode: MemoryIndexMode,
  signal?: AbortSignal,
  onProgress?: LocalIndexProgressReporter,
): Promise<LocalIndexPassResult> {
  // ONE reading of the embedder for the whole pass. Resolved before the store is
  // opened, so a pass cannot embed its first files with one embedder and its
  // last with another — a switch landing mid-pass would leave an index of two
  // widths under a single identity.
  const embedder = await resolveMemoryEmbedder();
  const identityNow = embedderIdentity(embedder);
  // And ONE ceiling, from that embedder's width — the vectors this pass is
  // about to write are the ones the budget is about. Resolved with the
  // embedder for the same reason: a ceiling that moved mid-pass would cap the
  // last files of a run against a different budget from its first.
  const ceiling = maxIndexChunks(embedder.dimensions);
  const db = await openIndexForWrite();
  try {
    // THE SCAN COMES FIRST, before anything is emptied. A `full` pass wipes the
    // tables, and reading the owner's folder list can fail — the config store
    // being unreadable is exactly the state an index run might be trying to
    // recover from — so a wipe followed by a failed read would have destroyed a
    // working index over a momentary failure. Same rule as `mutateExtraPaths`:
    // a read that FAILED is never written over as if it were empty.
    const sources = await readLocalSources();
    const scan = await scanSources(sources, signal);

    const identity = identityOf(db, sources, identityNow);
    const schema = metaGet(db, "schema_version");
    const rebuild = mode === "full" || identity === "mismatched" || schema !== SCHEMA_VERSION;
    if (rebuild) {
      // THE EMBEDDER ANSWERS BEFORE A WORKING INDEX IS THROWN AWAY.
      //
      // A rebuild deletes every row and then embeds the owner's folders again,
      // so from the first statement until the pass succeeds there is no index
      // at all. The commonest way this box refuses a pass is the embedder
      // declining to WAKE — `ensureLocalAiReady` answers 502 below
      // `EMBED_WAKE_MIN_AVAILABLE_MB` of MemAvailable, which is a busy Orin
      // saying "not now" rather than anything being wrong — and a Full reindex
      // pressed at that moment emptied an index that was working, failed, and
      // left memory search finding nothing until some later pass happened to
      // succeed. The owner's remedy for an amber card destroyed what the card
      // was complaining about.
      //
      // One request, before anything is deleted. It costs a single embedding on
      // a path about to spend thousands, it is the same call that wakes the
      // unit for them, and a refusal ends the pass (`EmbeddingUnavailableError`)
      // with the index it was going to replace still on disk.
      await embedBatch([REBUILD_PROBE_TEXT], "document", signal, embedder);
      // The identity goes WITH the rows it describes. Stamping it here — before
      // a single vector had been written — meant a rebuild whose first embed
      // failed left a valid identity over an empty index, which the shared
      // parser reads as `healthy` with zero chunks: a green panel and a search
      // that finds nothing. It is stamped at the END, once there is something
      // for it to be true of.
      db.exec("DELETE FROM chunks; DELETE FROM files;");
      db.prepare("DELETE FROM meta WHERE key = 'identity'").run();
    }
    metaSet(db, "schema_version", SCHEMA_VERSION);

    let chunkCount = countOf(db, "SELECT COUNT(*) AS n FROM chunks");
    // A document the extractor could not read is a failure of the same kind as
    // a file this pass cannot open below, and it was counted nowhere: its notes
    // are the extractor's own and are dropped here. Without it a folder of
    // PDFs none of which convert is a silently empty index.
    let failures = scan.unreadableSources.size + scan.unusableDocuments;
    // The part of `failures` that is about a FILE this pass did not finish —
    // opened, read, embedded or fitted — as opposed to a folder it could not
    // walk or a document the extractor refused. Kept apart because
    // `identityOf` needs exactly this and not the aggregate: a file that was
    // indexed once and cannot be read now keeps its old row (it is still in the
    // scan, so the stale sweep leaves it), and "rows == files scanned" then
    // reads as nothing owed over work that did not happen.
    let incompleteFiles = 0;
    let capped = false;
    let wrote = false;
    // The denominator as soon as it exists. Until the scan has walked every
    // source the pass genuinely does not know how much work there is, and the
    // bar says so by staying indeterminate rather than by guessing.
    let filesDone = 0;
    const report = () => onProgress?.({ filesDone, filesTotal: scan.files.length, chunks: chunkCount });
    report();

    // Prepared ONCE. Every one of these was re-parsed and re-planned on each of
    // up to 20,000 files: ~10 us each, so about a second of pure SQL parsing
    // per pass on an Orin, for statements that never change.
    const sql = {
      row: db.prepare("SELECT mtime_ms, size, sha, source, display FROM files WHERE path = ?"),
      touch: db.prepare("UPDATE files SET mtime_ms = ?, size = ? WHERE path = ?"),
      chunksFor: db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE path = ?"),
      dropChunks: db.prepare("DELETE FROM chunks WHERE path = ?"),
      dropFile: db.prepare("DELETE FROM files WHERE path = ?"),
      insertChunk: db.prepare("INSERT INTO chunks (path, ord, text, vec) VALUES (?, ?, ?, ?)"),
      upsertFile: db.prepare(
        `INSERT INTO files (path, source, display, mtime_ms, size, sha, chunks, indexed_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '')
         ON CONFLICT(path) DO UPDATE SET source = excluded.source, display = excluded.display,
           mtime_ms = excluded.mtime_ms, size = excluded.size, sha = excluded.sha,
           chunks = excluded.chunks, indexed_at = excluded.indexed_at, error = ''`,
      ),
    };
    // Files whose bytes are unchanged but whose stat moved — a restore, an
    // rsync, a git checkout touches thousands at once. Flushed in ONE
    // transaction at the end rather than one autocommit each: measured at 2.3 ms
    // of fsync per row, which is eleven seconds for five thousand files.
    const touched: { path: string; mtimeMs: number; size: number }[] = [];

    for (const entry of scan.files) {
      throwIfAborted(signal);
      // Reported at the TOP of the body and counted after it, because every
      // path below — a skip, a refusal, an embed — leaves through a `continue`
      // and a report at the bottom would have shown 0 of 900 for the whole
      // length of a pass over unchanged files, which is the commonest pass
      // there is. `filesDone` is therefore what is genuinely finished with,
      // never one ahead of it.
      report();
      filesDone += 1;
      // ONE DESCRIPTOR for the size check, the skip decision and the read.
      // A path-level stat followed by a path-level readFile lets the file be
      // replaced between them, so the bytes that get embedded are not the ones
      // the size check passed and not the ones the mtime recorded — an index
      // that quietly disagrees with the disk. Same shape `boundedJsonFile` in
      // chat-spoken-history.ts uses, and O_NOFOLLOW for the same reason: a
      // link planted inside a folder the owner added must not be read through.
      let opened: OpenedFile | null;
      try {
        opened = await openForIndexing(entry.file);
      } catch {
        failures += 1;
        incompleteFiles += 1;
        continue;
      }
      if (!opened) {
        // Not a regular file, or bigger than this pass will read.
        failures += 1;
        incompleteFiles += 1;
        continue;
      }
      const { stat } = opened;
      const row = sql.row.get(entry.file) as
        { mtime_ms?: unknown; size?: unknown; sha?: unknown; source?: unknown; display?: unknown } | undefined;
      // The source and the display name are part of what is stored, so they are
      // part of what "unchanged" means. Without them, moving a folder's entry
      // in the list (removing `~/Docs`, adding `~`) left every already-indexed
      // file citing the folder the owner had just removed, in results the agent
      // reads back to them.
      const sameMeta = !!row && row.source === entry.source && row.display === entry.display;

      let text: string;
      try {
        if (sameMeta && Number(row!.mtime_ms) === Math.floor(stat.mtimeMs) && Number(row!.size) === stat.size) continue;
        text = await opened.read();
      } catch {
        failures += 1;
        incompleteFiles += 1;
        continue;
      } finally {
        // `continue` runs this too, so the descriptor is released on every path.
        await opened.close();
      }
      const sha = sha256Of(text);
      if (sameMeta && row!.sha === sha) {
        // Touched, not edited. Record the new stat so the next pass skips it
        // without reading it again — batched, see `touched`.
        touched.push({ path: entry.file, mtimeMs: Math.floor(stat.mtimeMs), size: stat.size });
        continue;
      }

      const pieces = chunkText(text);
      const existing = row ? countOf2(sql.chunksFor, entry.file) : 0;
      if (chunkCount - existing + pieces.length > ceiling) {
        // `continue`, not `break`: one large document early in the scan must not
        // shut out the thousand small ones behind it that still fit.
        capped = true;
        incompleteFiles += 1;
        continue;
      }

      let vectors: Float32Array[];
      try {
        vectors = [];
        for (let at = 0; at < pieces.length; at += EMBED_BATCH_INPUTS) {
          throwIfAborted(signal);
          vectors.push(...await embedBatch(pieces.slice(at, at + EMBED_BATCH_INPUTS), "document", signal, embedder));
        }
      } catch (err) {
        // The embedder is the shared resource; a failure there is not this
        // file's fault and every later file would fail the same way.
        if (err instanceof EmbeddingUnavailableError || err instanceof IndexPassAbortedError) throw err;
        failures += 1;
        incompleteFiles += 1;
        continue;
      }
      // A width change empties the store, so everything counted before it is
      // gone: re-read rather than carry a total that no longer describes
      // anything. Left stale, the next cap check fired on a store of ~19,800
      // rows that held none, and the rebuild indexed almost nothing.
      // A width change empties the store, so everything counted before it is
      // gone — including this file's own rows, which is why `replaced` follows
      // from the same answer rather than being asked for a second time.
      const wiped = assertDimension(db, vectors[0]);
      if (wiped) chunkCount = 0;
      const replaced = wiped ? 0 : existing;

      // One transaction per FILE: sqlite fsyncs at every commit, so a document
      // of 200 chunks written a row at a time is 200 syncs on an SD card. Per
      // file rather than per pass because a pass is minutes long and its work
      // should survive being interrupted — an interrupted run is reconciled and
      // re-run, and everything already committed is skipped on the way back.
      db.exec("BEGIN");
      try {
        sql.dropChunks.run(entry.file);
        for (let i = 0; i < pieces.length; i += 1) sql.insertChunk.run(entry.file, i, pieces[i], toBlob(vectors[i]));
        sql.upsertFile.run(
          entry.file, entry.source, entry.display,
          Math.floor(stat.mtimeMs), stat.size, sha, pieces.length, Date.now(),
        );
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      chunkCount = chunkCount - replaced + pieces.length;
      wrote = true;
    }
    // The last file's own outcome, which the loop's top-of-body report could
    // not carry. Everything after this is bookkeeping over a walk that is
    // finished, so this is the reading the bar rests on while it happens.
    report();

    if (touched.length) {
      db.exec("BEGIN");
      try {
        for (const t of touched) sql.touch.run(t.mtimeMs, t.size, t.path);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      wrote = true;
    }

    // Anything the scan did not find is gone from the owner's folders — or the
    // folder itself is.
    //
    // ONLY for a source the scan could actually READ. `walkFiles` swallows an
    // opendir failure and yields nothing, so an unplugged drive, a permission
    // blip or a tree past the walk's entry budget all look exactly like an
    // emptied folder — and this loop would then delete that whole source's
    // slice of the index and the run would report `succeeded`. The owner would
    // have to re-embed everything. A source that could not be read is counted
    // as a failure instead and its rows are left alone.
    //
    // The cap is deliberately NOT a reason to skip this. `seen` is complete
    // whatever the cap did — it comes from the scan, which always runs to the
    // end — and skipping the delete while capped is what made a full index
    // permanently unable to shrink: the chunks of deleted files were never
    // reclaimed, so every later pass hit the ceiling again and skipped the
    // delete again. Only a full reindex escaped.
    // IN ONE TRANSACTION, and this is not a micro-optimisation: removing a
    // single source folder makes every file under it stale, and at two
    // autocommits each — an fsync apiece — two thousand of them measured 2.4
    // seconds on an SSD against 52 ms batched. On the box's eMMC, with the
    // whole event loop blocked on every one of those syncs, that is the
    // difference between a pause and an outage.
    const stale: string[] = [];
    for (const row of db.prepare("SELECT path, source FROM files").all() as { path?: unknown; source?: unknown }[]) {
      const stored = typeof row.path === "string" ? row.path : "";
      if (!stored || scan.seen.has(stored)) continue;
      if (typeof row.source === "string" && scan.unreadableSources.has(row.source)) continue;
      stale.push(stored);
    }
    if (stale.length) {
      db.exec("BEGIN");
      try {
        for (const gone of stale) {
          sql.dropChunks.run(gone);
          sql.dropFile.run(gone);
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      chunkCount = countOf(db, "SELECT COUNT(*) AS n FROM chunks");
      wrote = true;
    }

    const files = countOf(db, "SELECT COUNT(*) AS n FROM files");
    const chunks = countOf(db, "SELECT COUNT(*) AS n FROM chunks");
    // Now, and only now: the identity describes an index that exists. All of it
    // in one transaction — five autocommits is five fsyncs for six short rows.
    db.exec("BEGIN");
    try {
      metaSet(db, "identity", identityNow);
      metaSet(db, "built_at", String(Date.now()));
      // Everything this pass had to ACCOUNT FOR, which is not the same as what
      // it could open: a document the extractor refused never becomes an
      // indexable file, and counted only among the failures it left the card
      // saying "Nothing to index yet" over the owner's PDFs. Counted here it is
      // owed work — `pendingFiles` on the card — and an index that is empty
      // because of it is not an index with nothing to index.
      metaSet(db, "scan_total_files", String(scan.files.length + scan.unusableDocuments));
      // WHICH folders that count is about. Without it, "the last pass found
      // nothing" outlives the configuration it was true of, and a folder the
      // owner added afterwards reads as nothing to index — see `identityOf`.
      metaSet(db, "scan_sources", sourceListKey(sources));
      metaSet(db, "failures", String(failures));
      metaSet(db, "incomplete_files", String(incompleteFiles));
      metaSet(db, "capped", capped ? "1" : "");
      // What the vector cache keys on. A file mtime cannot do this job under
      // WAL: an ordinary commit lands in the -wal and leaves the main file's
      // stat untouched, so the stamp both missed real changes and invalidated
      // over a checkpoint that changed nothing.
      metaSet(db, "generation", String(Number(metaGet(db, "generation") ?? 0) + 1));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    if (capped) {
      console.warn(
        `[memory-index] the index reached its ${ceiling}-chunk ceiling; some files in this pass were not indexed`,
      );
    }
    if (scan.unreadableSources.size) {
      console.warn(
        `[memory-index] ${scan.unreadableSources.size} source folder(s) could not be read in full; their entries were left as they were`,
      );
    }

    if (wrote) invalidateVectorCache();
    return { mode: rebuild ? "full" : mode, files, chunks, failures, capped };
  } finally {
    db.close();
  }
}

/** `countOf` for a statement that is already prepared. */
function countOf2(statement: { get(...params: unknown[]): unknown }, ...params: unknown[]): number {
  const row = statement.get(...params) as { n?: unknown } | undefined;
  const n = Number(row?.n ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

interface ScanResult {
  /** Every indexable file found, deduplicated, in scan order. */
  files: PendingFile[];
  /** Their paths, for the "is this still there?" question. */
  seen: Set<string>;
  /**
   * Sources whose walk was INCOMPLETE — unreadable, partly unreadable, or past
   * the walk's entry budget. Their rows are not deletable on this pass, because
   * "found nothing" and "could not look" are the same silence from `walkFiles`
   * and only one of them means the documents are gone.
   */
  unreadableSources: Set<string>;
  /**
   * Documents the extractor could not turn into text — too large to read, gone
   * mid-scan, or a conversion that failed. Per-DOCUMENT faults, so they are
   * counted with the file failures and not with the folder-level shortfall
   * above, and nothing else on the box reports them: one of them never becomes
   * an indexable file, so a folder of PDFs that every one of them refused to
   * convert leaves an index that is empty and must not read as "there was
   * nothing to index".
   */
  unusableDocuments: number;
}

/** Find everything there is to index, and be honest about what could not be looked at. */
async function scanSources(sources: readonly string[], signal: AbortSignal | undefined): Promise<ScanResult> {
  const files: PendingFile[] = [];
  const seen = new Set<string>();
  const unreadableSources = new Set<string>();
  let unusableDocuments = 0;

  for (const source of sources) {
    throwIfAborted(signal);
    // The extractor turns the owner's PDFs, .docx, .odt, .rtf and .txt into
    // Markdown in a folder of its own, and skips what it already converted.
    // On OpenClaw that derived folder is registered as a second source
    // because its indexer reads `.md` and nothing else; here the pass simply
    // walks both, which is the same coverage without a second entry in a
    // list the owner did not put it in.
    let origins: Record<string, string> = {};
    let derived: string | null = null;
    try {
      const extraction = await extractDocuments(source, signal);
      origins = extraction.origins;
      derived = extraction.derived;
      unusableDocuments += extraction.skipped;
      // The extractor's own notes are about a scan that fell short — a folder
      // it could not open, a budget it ran out of — so they carry the same
      // "do not delete from this source" meaning the walk below does.
      if (extraction.partial) unreadableSources.add(source);
    } catch (err) {
      // The extractor stops on the shared signal, and it throws the platform's
      // own AbortError doing it — which is this pass ending, not this folder
      // failing.
      if (err instanceof IndexPassAbortedError || signal?.aborted) throw new IndexPassAbortedError();
      console.warn(`[memory-index] extracting documents from a source failed: ${errorText(err)}`);
      unreadableSources.add(source);
    }
    // The derived folder is named EAGERLY and written LAZILY: `extractDocuments`
    // answers one as soon as the folder holds a single extractable document,
    // and creates it only when it is about to write a conversion into it. So a
    // source whose every extractable document was passed over before that point
    // — one over MAX_DOCUMENT_BYTES, one that vanished between the walk and the
    // stat — is handed a derived folder that is not there, and walking it
    // charged "could not be read" to the OWNER'S folder. That is the worst
    // wrong answer this module has: the pass counts a failure the owner cannot
    // act on, and `unreadableSources` then disables the stale delete for the
    // WHOLE source, so a document they deleted stays in the index and goes on
    // coming back in search results on every later pass, for ever. Nothing was
    // looked at and nothing is unknown — a derived folder that does not exist
    // is an extraction that wrote nothing, which `skipped` has already counted.
    const roots = [source];
    if (derived && !(await derivedFolderAbsent(derived))) roots.push(derived);
    for (const root of roots) {
      const found = await indexableFilesUnder(root);
      if (!found.complete) unreadableSources.add(source);
      for (const file of found.files) {
        // One file can sit under two overlapping sources; the first to claim
        // it is the one that indexes it.
        if (seen.has(file)) continue;
        // A derived file the extractor did not name in THIS call is a leftover:
        // the derived folder outlives a run, so it can hold a copy of a
        // document the owner has since deleted, or one an extraction cut short
        // by MAX_FILES never reached. There is no owner-facing name for it, and
        // the fallback below would be ClawBox's own scratch path — the exact
        // answer `searchLocalMemory` must never give. Skipped, and reclaimed by
        // the delete pass on the next complete run.
        const display = displayName(source, file, origins);
        if (!display) continue;
        seen.add(file);
        files.push({ file, source, display });
      }
    }
  }
  return { files, seen, unreadableSources, unusableDocuments };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The dimension is only knowable once the model has answered, so it is checked
 * here rather than folded into the identity. A changed dimension means every
 * stored vector is unreadable, so the store is emptied on the spot instead of
 * mixing widths that no comparison could survive.
 */
function assertDimension(db: IndexDb, sample: Float32Array | undefined): boolean {
  if (!sample) return false;
  const stored = metaGet(db, "dim");
  let wiped = false;
  if (stored && Number(stored) !== sample.length) {
    db.exec("DELETE FROM chunks; DELETE FROM files;");
    wiped = true;
    console.warn(`[memory-index] the embedder changed width (${stored} -> ${sample.length}); the index was rebuilt`);
  }
  metaSet(db, "dim", String(sample.length));
  return wiped;
}

// ─── status ──────────────────────────────────────────────────────────────────

/**
 * The same JSON `openclaw memory status --agent main --deep --json` answers.
 *
 * Every field here is one `parseMemoryStatus` already reads; nothing is
 * invented, and nothing this shape cannot carry is reported. See the module
 * comment for why it is worth impersonating rather than parallel-implementing.
 */
export async function localMemoryStatusJson(): Promise<unknown> {
  const [sources, provisioning, embedder] = await Promise.all([
    readLocalSources(),
    getEmbedProvisioningStatus().catch(() => null),
    resolveMemoryEmbedder(),
  ]);
  // What makes semantic search POSSIBLE, per embedder. On this box that is the
  // model being on disk — whether it is awake right now is not the question,
  // the proxy wakes it on demand. In the cloud it is the box holding the
  // credential the endpoint wants AND that credential not having been REFUSED:
  // a credential the proxy has rejected (401 `missing_token` / 403
  // `invalid_token` — revoked, re-minted elsewhere, lost in a migration) sits in
  // the store looking exactly like a working one, so "a token is present"
  // reported `semanticAvailable: true` and `mode: active` over a box where every
  // pass failed and every search threw. `clawaiCredentialRefused()` is the fact
  // the rest of the box already keeps for the picture and microphone paths; a
  // refusal expires on its own, so this reports degraded only while one is
  // actually on record. The GGUF need not be there at all, and reading
  // `installed` on the cloud arm would report a perfectly good cloud index as
  // degraded on a box that never downloaded 639 MB it does not use.
  //
  // WHAT THIS STILL DOES NOT COVER, said out loud rather than implied: the
  // proxy's PLAN gate is a 403 too, and it names the plan rather than the
  // credential, so `proxyRefusedClawaiCredential` refuses it — correctly, since
  // a refused credential is the one the box tells the owner to re-link. A plan
  // that lapses after the embedder was pinned to the cloud therefore still
  // reads as available here. Closing that needs a fact about the ACCOUNT, from
  // the portal poll that already reads the plan, not a wider reading of a
  // status on the embedding path.
  const ready =
    embedder.source === "cloud"
      ? embedderUsable(embedder) && clawaiCredentialRefused() === null
      : provisioning?.installed === true;
  const identityNow = embedderIdentity(embedder);
  // ONE object literal for both cases, so the "there is no index yet" shape and
  // the real one cannot drift into disagreeing about a field name.
  //
  // The counts are COUNTED, not read from a number the last pass wrote. A
  // cached count is only true while every pass finishes: one that dies partway
  // — the embedder refusing a wake is the common case — leaves the tables and
  // the recorded totals describing different indexes, and this probe is what
  // the panel believes. Measured at ~0.1 ms warm on a store at its chunk
  // ceiling (sqlite answers both from `chunks_by_path`), which is not a price
  // worth paying in honesty.
  const db = await openIndexForRead();
  try {
    return {
      agentId: "main",
      scan: { totalFiles: db ? Number(metaGet(db, "scan_total_files") ?? 0) : 0 },
      status: {
        provider: embedder.provider,
        model: embedder.model,
        files: db ? countOf(db, "SELECT COUNT(*) AS n FROM files") : 0,
        chunks: db ? countOf(db, "SELECT COUNT(*) AS n FROM chunks") : 0,
        dbPath: LOCAL_INDEX_PATH,
        // OpenClaw's `dirty` means "this index still has work owed to it",
        // which is exactly true of one that hit its ceiling: files were
        // scanned and not indexed, and `pendingFiles` carries how many.
        dirty: db ? metaGet(db, "capped") === "1" : false,
        sources,
        vector: { semanticAvailable: ready },
        batch: { failures: db ? Number(metaGet(db, "failures") ?? 0) : 0 },
        custom: {
          providerState: { mode: ready ? "active" : "degraded" },
          // No store at all is not the same answer as a store a pass has
          // finished with: nothing here has ever been looked at, the state the
          // wizard's own stamp leaves too. `identityOf` is what tells an index
          // that is empty because there was nothing to index from one that is
          // empty because the work did not happen.
          indexIdentity: { status: db ? identityOf(db, sources, identityNow) : "missing" },
        },
      },
    };
  } finally {
    db?.close();
  }
}

// ─── search ──────────────────────────────────────────────────────────────────

export interface LocalMemoryHit {
  /** What to call the file: the owner's own name for it, never our scratch copy. */
  path: string;
  snippet: string;
  /** Cosine similarity, 0..1. */
  score: number;
}

/** How much of a chunk a result shows. */
const SNIPPET_CHARS = 400;

interface VectorCache {
  /** The `generation` the pass stamped when it last wrote a vector. */
  stamp: string;
  dim: number;
  vectors: Float32Array;
  ids: number[];
}

let vectorCache: VectorCache | null = null;
let cacheRelease: ReturnType<typeof setTimeout> | null = null;

/**
 * How long the vectors stay resident after the last search.
 *
 * At the ceiling the cache is ~78 MiB of float32 WHICHEVER embedder this box
 * uses — that is what `INDEX_VECTOR_BUDGET_BYTES` is, and the ceiling is
 * derived from it rather than fixed at 20,000, so the cloud model's 3,072
 * dimensions buy fewer chunks instead of three times the memory. This box has
 * 7.4 GB shared with a local model and a 2 GB embedder. The embedder itself is
 * put away after ten idle minutes (`LOCAL_AI_IDLE_TIMEOUT_MS`); a search index
 * that pinned ~78 MiB for the life of the process while the model it belongs
 * to was handing memory back would be the odd one out.
 */
const VECTOR_CACHE_IDLE_MS = 10 * 60 * 1000;

function invalidateVectorCache(): void {
  vectorCache = null;
  if (cacheRelease) {
    clearTimeout(cacheRelease);
    cacheRelease = null;
  }
}

function armCacheRelease(): void {
  if (cacheRelease) clearTimeout(cacheRelease);
  cacheRelease = setTimeout(invalidateVectorCache, VECTOR_CACHE_IDLE_MS);
  cacheRelease.unref();
}

/** Exported for the tests, which build several indexes in one process. */
export function _resetLocalMemoryCacheForTests(): void {
  invalidateVectorCache();
}

/**
 * Every vector as ONE Float32Array.
 *
 * The ceiling is a memory budget, so the scan is about the same size on either
 * embedder: 20,000 chunks of 1,024 floats, or 6,666 of 3,072, is ~20M
 * multiplies — tens of milliseconds in JS, with no vector extension, no
 * approximate index and nothing to keep in step with the rows.
 *
 * `iterate`, not `all`, and the bytes go STRAIGHT into the destination. `all`
 * built 20,000 row objects each holding a 4 KB buffer before one could be
 * consumed, then `toVector` copied each into a second buffer and `set` into a
 * third: measured at a 265 MB resident spike against 107 MB this way, inside a
 * synchronous block, on a box with 7.4 GB shared with a language model. Writing
 * through a byte view also removes the alignment problem `toVector` exists for,
 * because the destination is ours and four-aligned by construction.
 *
 * Keyed on the `generation` the pass stamps, not on the file's mtime: this
 * store is in WAL mode, so an ordinary commit lands in the -wal and leaves the
 * main file's stat alone — the stamp would have missed real changes, and
 * thrown the cache away over a checkpoint that changed nothing.
 */
function loadVectors(db: IndexDb, stamp: string): VectorCache | null {
  if (vectorCache?.stamp === stamp) {
    armCacheRelease();
    return vectorCache;
  }
  const total = countOf(db, "SELECT COUNT(*) AS n FROM chunks");
  if (total === 0) return null;

  let vectors: Float32Array | null = null;
  let bytes: Uint8Array | null = null;
  let dim = 0;
  const ids: number[] = [];
  for (const raw of db.prepare("SELECT id, vec FROM chunks ORDER BY id").iterate()) {
    const row = raw as { id?: unknown; vec?: unknown };
    const vec = row.vec as Uint8Array;
    if (!vectors) {
      dim = vec.byteLength / Float32Array.BYTES_PER_ELEMENT;
      if (!Number.isInteger(dim) || dim === 0) return null;
      vectors = new Float32Array(total * dim);
      bytes = new Uint8Array(vectors.buffer);
    }
    // A row of another width belongs to a previous embedder and cannot be
    // compared with this query; skipping it is right, and the identity check
    // is what gets the index rebuilt.
    if (vec.byteLength !== dim * Float32Array.BYTES_PER_ELEMENT) continue;
    bytes!.set(vec, ids.length * dim * Float32Array.BYTES_PER_ELEMENT);
    ids.push(Number(row.id));
  }
  if (!vectors || ids.length === 0) return null;
  vectorCache = { stamp, dim, vectors: vectors.subarray(0, ids.length * dim), ids };
  armCacheRelease();
  return vectorCache;
}

/**
 * Find the owner's own documents.
 *
 * This is the half the OpenClaw box never had a surface for: there the index is
 * OpenClaw's and OpenClaw searches it. Here ClawBox owns it, so ClawBox has to
 * answer questions about it — otherwise an index nothing can read is a panel
 * with counts on it.
 */
export async function searchLocalMemory(
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<LocalMemoryHit[]> {
  const text = query.trim();
  if (!text) return [];
  // Clamped HERE, not only in the two callers: the top-k loop indexes
  // `best[best.length - 1]` and a limit of zero makes that `best[-1]`.
  const want = Math.max(1, Math.min(50, Math.trunc(limit) || 1));
  // The SAME embedder the last pass wrote with, or the query lands in a space
  // the stored vectors do not live in. A switch that has not been rebuilt for
  // yet answers nothing here (the widths differ), which is what the card's
  // mismatched fingerprint and its "Run a full reindex" are about.
  const embedder = await resolveMemoryEmbedder();
  const db = await openIndexForRead();
  if (!db) return [];
  try {
    // The two halves are independent, so they run together. The embed call is
    // the one that WAKES a sleeping llama.cpp unit — its budget is two minutes
    // for exactly that reason — and loading 82 MB of vectors needs nothing from
    // it. Started first, the wake covers the whole cold load, which is the
    // worst case this feature has: the agent's first search after a restart.
    const embedding = embedBatch([text], "query", signal, embedder);
    // A handler on a DERIVED promise, attached before anything can throw: the
    // load below can return early or fail, and an in-flight rejection with
    // nobody listening takes the whole process down. `await embedding` still
    // sees the real rejection.
    embedding.catch(() => {});
    const cache = loadVectors(db, metaGet(db, "generation") ?? "0");
    if (!cache) return [];
    const [embedded] = await embedding;
    if (!embedded || embedded.length !== cache.dim) return [];

    // Top-k by insertion into a small array: k is at most 10, so a heap would
    // be more code for the same work.
    const best: { at: number; score: number }[] = [];
    for (let row = 0; row < cache.ids.length; row += 1) {
      let score = 0;
      const base = row * cache.dim;
      for (let i = 0; i < cache.dim; i += 1) score += cache.vectors[base + i] * embedded[i];
      if (best.length < want) {
        best.push({ at: row, score });
        best.sort((a, b) => b.score - a.score);
      } else if (score > best[best.length - 1].score) {
        best[best.length - 1] = { at: row, score };
        best.sort((a, b) => b.score - a.score);
      }
    }

    const hits: LocalMemoryHit[] = [];
    for (const { at, score } of best) {
      const row = db
        .prepare("SELECT c.text AS text, f.display AS display FROM chunks c JOIN files f ON f.path = c.path WHERE c.id = ?")
        .get(cache.ids[at]) as { text?: unknown; display?: unknown } | undefined;
      if (!row || typeof row.text !== "string") continue;
      hits.push({
        // The display name, never `c.path`: that is an absolute path inside the
        // owner's home directory, and on the search route it would be handed
        // to the agent.
        path: typeof row.display === "string" && row.display ? row.display : "a document",
        snippet: row.text.slice(0, SNIPPET_CHARS),
        score: Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000,
      });
    }
    return hits;
  } finally {
    db.close();
  }
}
