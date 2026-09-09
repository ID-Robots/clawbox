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
import { openSqlite } from "@/lib/openclaw-session-store";
import { getEmbedProvisioningStatus, getEmbedProxyBaseUrl } from "@/lib/embed-server";
import { isLoopbackBaseUrl } from "@/lib/embed-runtime-ids";
import { getLocalAiToken } from "@/lib/local-ai-token";
import { EXTRACT_ROOT, extractDocuments, newWalkBudget, walkFiles } from "@/lib/memory-extract";
import { readConfig as readOpenclawConfig } from "@/lib/openclaw-config";
import {
  INDEXABLE_EXTENSIONS,
  LOCAL_EMBEDDING_MODEL,
  LOCAL_EMBEDDING_PROVIDER,
  MEMORY_SHARD_SOURCES_KEY,
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
 * The ceiling on the whole index.
 *
 * Qwen3-Embedding-0.6B is 1,024 dimensions, so a chunk costs 4 KB of float32:
 * 20,000 chunks is ~80 MB of vectors over ~25 MB of source text, which is a
 * great deal of personal notes and still fits beside the agent on an Orin.
 * Reaching it is reported, never silent — a cap nobody is told about reads as
 * "everything is indexed".
 */
export const MAX_INDEX_CHUNKS = 20_000;

/** One embeddings request's budget. The unit may be cold on the first call. */
const EMBED_TIMEOUT_MS = 120_000;

/** A document over this size is not chunked. The extractor uses the same bound. */
const MAX_INDEXABLE_BYTES = 40 * 1024 * 1024;

/**
 * The embedder could not be reached or refused the request.
 *
 * Its own class because it is the one failure that must END the pass: a run
 * that quietly recorded every file as failed and then reported "succeeded"
 * would leave the owner with a healthy-looking panel over an empty index. A
 * file that cannot be READ is the other kind and is counted and stepped over.
 */
export class EmbeddingUnavailableError extends Error {
  constructor(detail: string) {
    super(`The embedding model did not answer: ${detail}`);
    this.name = "EmbeddingUnavailableError";
  }
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
  const raw = await configGet(MEMORY_SHARD_SOURCES_KEY);
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  }
  // No key at all — never written on this box. That is a fresh install, or a
  // box that has just been swapped to this harness from OpenClaw, and the two
  // want different answers: see `carryOverSources`.
  return seedSources();
}

/**
 * The seed, at most once at a time and re-checked at the moment it writes.
 *
 * Both halves matter, because this is a WRITE on a read path. `readLocalSources`
 * is what the status probe calls — every two minutes, from a route the desktop
 * polls — and what a folder mutation calls inside its own queue. Two of those
 * arriving together on a freshly swapped box would each carry the list over and
 * each write it, and if the probe's write landed after the mutation's the
 * folder the owner had just added would be gone. Sharing one in-flight promise
 * means there is only ever one seed to land, and reading the key again inside
 * it means a seed that raced a real write does nothing at all.
 *
 * The promise is dropped when it settles rather than kept for the process's
 * life: after the seed the key EXISTS, so a later call re-reads it and never
 * gets here — and a caller that arrives after an owner has cleared their whole
 * list must see the empty list, not a memoised carry-over.
 */
let seeding: Promise<string[]> | null = null;

function seedSources(): Promise<string[]> {
  if (seeding) return seeding;
  const run = (async (): Promise<string[]> => {
    const again = await configGet(MEMORY_SHARD_SOURCES_KEY);
    if (Array.isArray(again)) {
      return again.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    }
    const carried = await carryOverSources();
    // Written even when it is empty, so the carry-over happens exactly once and
    // an owner who later removes every folder does not get them back.
    await configSet(MEMORY_SHARD_SOURCES_KEY, carried);
    return carried;
  })();
  seeding = run;
  void run.then(
    () => { if (seeding === run) seeding = null; },
    () => { if (seeding === run) seeding = null; },
  );
  return run;
}

/**
 * The folders the owner chose while this box ran OpenClaw.
 *
 * The harness swap is a product feature, and its dialogue promises that what
 * the assistant knows about the owner carries over. A list of folders they
 * picked by hand is squarely that, and it lived in openclaw.json — so without
 * this a swapped box comes up with Memory Shard set up, switched on, and
 * reading nothing at all, which reads as a broken feature rather than as a
 * setting that needs redoing.
 *
 * Deliberately narrow. It runs ONCE (the caller writes the result whatever it
 * is), it only reads a file this edition otherwise ignores, and it keeps only
 * folders that are still there — a `~/.openclaw` left behind by a swap is a
 * snapshot of a moment, and resurrecting a folder the owner deleted would be
 * worse than asking them to add it again. Every failure is an empty list.
 */
async function carryOverSources(): Promise<string[]> {
  let config: unknown;
  try {
    config = await readOpenclawConfig();
  } catch {
    return [];
  }
  const search = (config as { memory?: { search?: { extraPaths?: unknown } } })?.memory?.search?.extraPaths;
  if (!Array.isArray(search)) return [];
  const named = search
    .map((entry) => (typeof entry === "string" ? entry : (entry as { path?: unknown })?.path))
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  const kept: string[] = [];
  for (const folder of named) {
    // The derived folders ClawBox itself registered alongside a source on the
    // OpenClaw side are not the owner's choices — this arm walks them from the
    // source instead, so carrying them would add a scratch directory to a list
    // the owner is shown.
    if (folder.startsWith(EXTRACT_ROOT)) continue;
    try {
      if ((await fs.stat(folder)).isDirectory()) kept.push(folder);
    } catch {
      /* gone since the swap */
    }
  }
  if (kept.length) {
    console.warn(`[memory-index] carried ${kept.length} folder(s) over from the OpenClaw configuration`);
  }
  return kept;
}

export async function writeLocalSources(paths: readonly string[]): Promise<void> {
  await configSet(MEMORY_SHARD_SOURCES_KEY, [...paths]);
}

// ─── the store ───────────────────────────────────────────────────────────────

interface IndexDb {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  };
  close(): void;
}

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
  const db = openSqlite(LOCAL_INDEX_PATH, false) as unknown as IndexDb;
  // WAL so the panel can still READ while a pass is writing. An index run over
  // a real folder is minutes long and the status route is polled throughout;
  // under the default rollback journal every one of those reads would be
  // racing a writer for the same file, and `busy_timeout` would turn the
  // collisions into five-second stalls in the UI rather than into errors.
  try {
    try {
      db.exec("PRAGMA journal_mode = WAL");
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
async function openIndexForRead(): Promise<IndexDb | null> {
  try {
    if (!(await fs.stat(LOCAL_INDEX_PATH)).isFile()) return null;
  } catch {
    return null;
  }
  try {
    return openSqlite(LOCAL_INDEX_PATH, false) as unknown as IndexDb;
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
export function localEmbeddingIdentity(): string {
  return crypto
    .createHash("sha256")
    .update(`${LOCAL_EMBEDDING_PROVIDER}|${LOCAL_EMBEDDING_MODEL}|${getEmbedProxyBaseUrl()}|v${SCHEMA_VERSION}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Record what the index is built for, without building anything.
 *
 * The Hermes half of `switchToLocalEmbeddings`. On OpenClaw that call points an
 * external client at this box's embedder; here there is no external client to
 * point — ClawBox is the client — so the write that remains is the one fact
 * that would otherwise be missing: which model the vectors about to be written
 * belong to.
 */
export async function stampLocalEmbeddingIdentity(): Promise<void> {
  const db = await openIndexForWrite();
  try {
    metaSet(db, "identity", localEmbeddingIdentity());
    metaSet(db, "schema_version", SCHEMA_VERSION);
  } finally {
    db.close();
  }
}

function identityOf(db: IndexDb): "valid" | "missing" | "mismatched" {
  const stored = metaGet(db, "identity");
  if (!stored) return "missing";
  if (stored !== localEmbeddingIdentity()) return "mismatched";
  // An identity over an EMPTY index is not evidence of anything: the wizard
  // stamps one before the first pass, and a rebuild whose first embed failed
  // leaves exactly the same shape. Reported `valid`, the shared parser reads
  // both as `healthy` — a green panel over a search that finds nothing. The
  // OpenClaw arm says `missing` at that point and so does this one, which is
  // also what gets the next pass to rebuild rather than to do nothing.
  return countOf(db, "SELECT COUNT(*) AS n FROM chunks") > 0 ? "valid" : "missing";
}

// ─── embedding ───────────────────────────────────────────────────────────────

/**
 * Embed a batch through THIS BOX'S OWN PROXY, never llama-server directly.
 *
 * Going through `/setup-api/local-ai/embed/v1` is what wakes the unit on the
 * first request (and re-arms the idle stop that puts it away again), what
 * restores the Qwen3 query instruction that keeps recall from quietly
 * degrading, and what trims an input too long for the server's batch. A client
 * that talked to port 8081 would have to reimplement all three and would get
 * one of them subtly wrong.
 */
async function embedBatch(
  texts: readonly string[],
  inputType: "query" | "document",
  signal: AbortSignal | undefined,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  // The owner's document text is about to become an HTTP body, so where it is
  // going is checked rather than assumed. `getEmbedProxyBaseUrl()` is built
  // from `CLAWBOX_LOCAL_AI_PROXY_BASE_URL`/`PORT` and is loopback on every box;
  // this is what keeps that true if either ever becomes settable from anywhere
  // less trustworthy. Off-box, the index would be quietly shipping the
  // customer's files to a third party — so it refuses instead.
  const endpoint = getEmbedProxyBaseUrl();
  if (!isLoopbackBaseUrl(endpoint)) {
    throw new EmbeddingUnavailableError("the embedder endpoint is not on this device");
  }
  let res: Response;
  try {
    res = await fetch(`${endpoint}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${getLocalAiToken()}`,
      },
      body: JSON.stringify({ model: LOCAL_EMBEDDING_MODEL, input: [...texts], input_type: inputType }),
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(EMBED_TIMEOUT_MS)]),
    });
  } catch (err) {
    if (signal?.aborted) throw new IndexPassAbortedError();
    throw new EmbeddingUnavailableError(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) {
    // 502 here is the wake being refused — most often the MemAvailable guard
    // in `ensureLocalAiReady`, which is a real answer and not a bug: the box
    // is too busy to hold the model right now.
    throw new EmbeddingUnavailableError(`HTTP ${res.status}`);
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

/**
 * A stored blob back as floats, through a COPY.
 *
 * `new Float32Array(bytes.buffer)` would reuse whatever buffer sqlite handed
 * back, whose byte offset is not guaranteed to be four-aligned; the copy makes
 * the alignment ours.
 */
function toVector(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
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
  /** True when MAX_INDEX_CHUNKS stopped the pass short. */
  capped: boolean;
}

function isIndexable(file: string): boolean {
  return (INDEXABLE_EXTENSIONS as readonly string[]).includes(path.extname(file).toLowerCase());
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new IndexPassAbortedError();
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
function displayName(source: string, file: string, origins: Record<string, string>): string {
  const origin = origins[path.basename(file)];
  const label = path.basename(source);
  return path.join(label, origin ?? path.relative(path.resolve(source), file));
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
 * different model.
 *
 * A file that cannot be read is counted and stepped over. The EMBEDDER failing
 * ends the pass — see `EmbeddingUnavailableError`.
 */
export async function runLocalIndexPass(
  mode: MemoryIndexMode,
  signal?: AbortSignal,
): Promise<LocalIndexPassResult> {
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

    const identity = identityOf(db);
    const schema = metaGet(db, "schema_version");
    const rebuild = mode === "full" || identity === "mismatched" || schema !== SCHEMA_VERSION;
    if (rebuild) {
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
    let failures = scan.unreadableSources.size;
    let capped = false;

    for (const entry of scan.files) {
      throwIfAborted(signal);
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
        continue;
      }
      if (!opened) {
        // Not a regular file, or bigger than this pass will read.
        failures += 1;
        continue;
      }
      const { stat } = opened;
      const row = db.prepare("SELECT mtime_ms, size, sha, source, display FROM files WHERE path = ?").get(entry.file) as
        { mtime_ms?: unknown; size?: unknown; sha?: unknown; source?: unknown; display?: unknown } | undefined;
      // The source and the display name are part of what is stored, so they are
      // part of what "unchanged" means. Without them, moving a folder's entry
      // in the list (removing `~/Docs`, adding `~`) left every already-indexed
      // file citing the folder the owner had just removed, in results the agent
      // reads back to them.
      const sameFile = row
        && Number(row.mtime_ms) === Math.floor(stat.mtimeMs)
        && Number(row.size) === stat.size
        && row.source === entry.source
        && row.display === entry.display;
      if (sameFile) {
        await opened.close();
        continue;
      }

      let text: string;
      try {
        text = await opened.read();
      } catch {
        failures += 1;
        continue;
      } finally {
        await opened.close();
      }
      const sha = sha256Of(text);
      if (row && row.sha === sha && row.source === entry.source && row.display === entry.display) {
        // Touched, not edited. Record the new stat so the next pass skips it
        // without reading it again.
        db.prepare("UPDATE files SET mtime_ms = ?, size = ? WHERE path = ?")
          .run(Math.floor(stat.mtimeMs), stat.size, entry.file);
        continue;
      }

      const pieces = chunkText(text);
      const existing = row ? countOf(db, "SELECT COUNT(*) AS n FROM chunks WHERE path = ?", entry.file) : 0;
      if (chunkCount - existing + pieces.length > MAX_INDEX_CHUNKS) {
        // `continue`, not `break`: one large document early in the scan must not
        // shut out the thousand small ones behind it that still fit.
        capped = true;
        continue;
      }

      let vectors: Float32Array[];
      try {
        vectors = [];
        for (let at = 0; at < pieces.length; at += EMBED_BATCH_INPUTS) {
          throwIfAborted(signal);
          vectors.push(...await embedBatch(pieces.slice(at, at + EMBED_BATCH_INPUTS), "document", signal));
        }
      } catch (err) {
        // The embedder is the shared resource; a failure there is not this
        // file's fault and every later file would fail the same way.
        if (err instanceof EmbeddingUnavailableError || err instanceof IndexPassAbortedError) throw err;
        failures += 1;
        continue;
      }
      // A width change empties the store, so everything counted before it is
      // gone: re-read rather than carry a total that no longer describes
      // anything. Left stale, the next cap check fired on a store of ~19,800
      // rows that held none, and the rebuild indexed almost nothing.
      if (assertDimension(db, vectors[0])) chunkCount = 0;

      // One transaction per FILE: sqlite fsyncs at every commit, so a document
      // of 200 chunks written a row at a time is 200 syncs on an SD card. Per
      // file rather than per pass because a pass is minutes long and its work
      // should survive being interrupted — an interrupted run is reconciled and
      // re-run, and everything already committed is skipped on the way back.
      const replaced = countOf(db, "SELECT COUNT(*) AS n FROM chunks WHERE path = ?", entry.file);
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM chunks WHERE path = ?").run(entry.file);
        const insert = db.prepare("INSERT INTO chunks (path, ord, text, vec) VALUES (?, ?, ?, ?)");
        for (let i = 0; i < pieces.length; i += 1) insert.run(entry.file, i, pieces[i], toBlob(vectors[i]));
        db.prepare(
          `INSERT INTO files (path, source, display, mtime_ms, size, sha, chunks, indexed_at, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, '')
           ON CONFLICT(path) DO UPDATE SET source = excluded.source, display = excluded.display,
             mtime_ms = excluded.mtime_ms, size = excluded.size, sha = excluded.sha,
             chunks = excluded.chunks, indexed_at = excluded.indexed_at, error = ''`,
        ).run(entry.file, entry.source, entry.display, Math.floor(stat.mtimeMs), stat.size, sha, pieces.length, Date.now());
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      chunkCount = chunkCount - replaced + pieces.length;
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
    for (const row of db.prepare("SELECT path, source FROM files").all() as { path?: unknown; source?: unknown }[]) {
      const stored = typeof row.path === "string" ? row.path : "";
      if (!stored || scan.seen.has(stored)) continue;
      if (typeof row.source === "string" && scan.unreadableSources.has(row.source)) continue;
      db.prepare("DELETE FROM chunks WHERE path = ?").run(stored);
      db.prepare("DELETE FROM files WHERE path = ?").run(stored);
    }

    // Now, and only now: the identity describes an index that exists.
    metaSet(db, "identity", localEmbeddingIdentity());
    metaSet(db, "built_at", String(Date.now()));
    metaSet(db, "scan_total_files", String(scan.files.length));
    metaSet(db, "failures", String(failures));
    metaSet(db, "capped", capped ? "1" : "");
    if (capped) {
      console.warn(
        `[memory-index] the index reached its ${MAX_INDEX_CHUNKS}-chunk ceiling; some files in this pass were not indexed`,
      );
    }
    if (scan.unreadableSources.size) {
      console.warn(
        `[memory-index] ${scan.unreadableSources.size} source folder(s) could not be read in full; their entries were left as they were`,
      );
    }

    return {
      mode: rebuild ? "full" : mode,
      files: countOf(db, "SELECT COUNT(*) AS n FROM files"),
      chunks: countOf(db, "SELECT COUNT(*) AS n FROM chunks"),
      failures,
      capped,
    };
  } finally {
    db.close();
    invalidateVectorCache();
  }
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
}

/** Find everything there is to index, and be honest about what could not be looked at. */
async function scanSources(sources: readonly string[], signal: AbortSignal | undefined): Promise<ScanResult> {
  const files: PendingFile[] = [];
  const seen = new Set<string>();
  const unreadableSources = new Set<string>();

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
    for (const root of derived ? [source, derived] : [source]) {
      const found = await indexableFilesUnder(root);
      if (!found.complete) unreadableSources.add(source);
      for (const file of found.files) {
        // One file can sit under two overlapping sources; the first to claim
        // it is the one that indexes it.
        if (seen.has(file)) continue;
        seen.add(file);
        files.push({ file, source, display: displayName(source, file, origins) });
      }
    }
  }
  return { files, seen, unreadableSources };
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
  const [sources, provisioning] = await Promise.all([
    readLocalSources(),
    getEmbedProvisioningStatus().catch(() => null),
  ]);
  // The model on disk is what makes semantic search POSSIBLE; whether it is
  // awake right now is not the question — the proxy wakes it on demand.
  const ready = provisioning?.installed === true;
  const db = await openIndexForRead();
  if (!db) {
    return {
      agentId: "main",
      scan: { totalFiles: 0 },
      status: {
        provider: LOCAL_EMBEDDING_PROVIDER,
        model: LOCAL_EMBEDDING_MODEL,
        files: 0,
        chunks: 0,
        dbPath: LOCAL_INDEX_PATH,
        dirty: false,
        sources,
        vector: { semanticAvailable: ready },
        batch: { failures: 0 },
        custom: {
          providerState: { mode: ready ? "active" : "degraded" },
          // Nothing has been built, so there is no identity to be wrong: the
          // wizard is what stamps one, and until it has, "missing" is the
          // honest answer and the one the OpenClaw box gives too.
          indexIdentity: { status: "missing" },
        },
      },
    };
  }
  try {
    return {
      agentId: "main",
      scan: { totalFiles: Number(metaGet(db, "scan_total_files") ?? 0) },
      status: {
        provider: LOCAL_EMBEDDING_PROVIDER,
        model: LOCAL_EMBEDDING_MODEL,
        files: countOf(db, "SELECT COUNT(*) AS n FROM files"),
        chunks: countOf(db, "SELECT COUNT(*) AS n FROM chunks"),
        dbPath: LOCAL_INDEX_PATH,
        // OpenClaw's `dirty` means "this index still has work owed to it",
        // which is exactly true of one that hit its ceiling: files were
        // scanned and not indexed, and `pendingFiles` carries how many.
        dirty: metaGet(db, "capped") === "1",
        sources,
        vector: { semanticAvailable: ready },
        batch: { failures: Number(metaGet(db, "failures") ?? 0) },
        custom: {
          providerState: { mode: ready ? "active" : "degraded" },
          indexIdentity: { status: identityOf(db) },
        },
      },
    };
  } finally {
    db.close();
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
  /** `mtimeMs:size` of the store the cache was built from. */
  stamp: string;
  dim: number;
  vectors: Float32Array;
  ids: number[];
}

let vectorCache: VectorCache | null = null;

function invalidateVectorCache(): void {
  vectorCache = null;
}

/** Exported for the tests, which build several indexes in one process. */
export function _resetLocalMemoryCacheForTests(): void {
  invalidateVectorCache();
}

/**
 * Every vector as ONE Float32Array, cached against the store's own stat.
 *
 * 20,000 chunks of 1,024 floats is a 20M-multiply scan, which is tens of
 * milliseconds in JS — no vector extension, no approximate index, and nothing
 * to keep in step with the rows. Keyed on the file's mtime and size rather than
 * an in-process generation counter so a store rewritten by anything else — a
 * restore, a factory reset — invalidates it too.
 */
function loadVectors(db: IndexDb, stamp: string): VectorCache | null {
  if (vectorCache?.stamp === stamp) return vectorCache;
  const rows = db.prepare("SELECT id, vec FROM chunks ORDER BY id").all() as { id?: unknown; vec?: unknown }[];
  if (rows.length === 0) return null;
  const first = toVector(rows[0].vec as Uint8Array);
  const dim = first.length;
  const vectors = new Float32Array(rows.length * dim);
  const ids: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const vec = i === 0 ? first : toVector(rows[i].vec as Uint8Array);
    // A row of another width belongs to a previous embedder and cannot be
    // compared with this query; skipping it is right, and the identity check
    // is what gets the index rebuilt.
    if (vec.length !== dim) continue;
    vectors.set(vec, ids.length * dim);
    ids.push(Number(rows[i].id));
  }
  if (ids.length === 0) return null;
  vectorCache = { stamp, dim, vectors: vectors.subarray(0, ids.length * dim), ids };
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
  let stat;
  try {
    stat = await fs.stat(LOCAL_INDEX_PATH);
  } catch {
    return [];
  }
  const db = await openIndexForRead();
  if (!db) return [];
  try {
    const cache = loadVectors(db, `${Math.floor(stat.mtimeMs)}:${stat.size}`);
    if (!cache) return [];
    const [embedded] = await embedBatch([text], "query", signal);
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
