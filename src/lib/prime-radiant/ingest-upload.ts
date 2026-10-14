/**
 * Documents dropped on the app: each file is POSTed on its own and staged in
 * `<prime-radiant root>/uploads/<batch>/`, then `POST /ingest { upload: batch }`
 * ingests the batch like a folder and removes it when the job ends.
 *
 * Everything that becomes a path is REBUILT here from an alphabet rather than
 * tested and passed through: the batch id from hex, the file name from
 * `[A-Za-z0-9._ -]` with the extension one of the ingestible ones. A file is
 * written through one exclusive handle (`wx`: never over another file, never
 * through a link), metered as it arrives and cut at the size cap or at the
 * box's disk reserve, the partial file removed.
 *
 * SERVER ONLY.
 */

import crypto from "crypto";
import fs from "fs/promises";
import { statfsSync } from "fs";
import path from "@/lib/runtime-path";
import { boundedBody } from "@/lib/bounded-body";
import { DISK_FREE_RESERVE_BYTES } from "@/lib/disk-reserve";
import { isIngestExtension, type IngestExtension } from "./ingest-sources";
import { primeRadiantRoot } from "./paths";

/**
 * One dropped document's ceiling. Under 10 MiB on purpose: Next buffers a
 * request body for the middleware and keeps only its first 10 MiB WITHOUT
 * failing the request (see `MAX_SCREENSHOT_BYTES`), so a larger drop would
 * arrive cut short. A bigger document is ingested from its folder instead.
 * A body shorter than its declared length is refused for the same reason.
 */
export const MAX_UPLOAD_FILE_BYTES = 9 * 1024 * 1024;
export const MAX_UPLOAD_FILES_PER_BATCH = 200;
export const MAX_UPLOAD_BATCH_BYTES = 500 * 1024 * 1024;
/** A batch nobody ingested is removed after this long. */
export const UPLOAD_BATCH_TTL_MS = 24 * 60 * 60 * 1000;

const HEX = "0123456789abcdef";
const BATCH_HEX = 16;
const NAME_CHARS = /[A-Za-z0-9._ +()-]/;
const MAX_NAME_CHARS = 120;

export function uploadsRoot(): string {
  return path.join(primeRadiantRoot(), "uploads");
}

export function newBatchId(): string {
  return crypto.randomBytes(BATCH_HEX / 2).toString("hex");
}

/** A caller's batch id rebuilt from hex, or null. */
export function safeBatchId(input: unknown): string | null {
  if (typeof input !== "string" || input.length !== BATCH_HEX) return null;
  let out = "";
  for (const ch of input.toLowerCase()) {
    const at = HEX.indexOf(ch);
    if (at < 0) return null;
    out += HEX[at];
  }
  return out;
}

/**
 * A dropped file's name rebuilt for the staging folder: the last path segment,
 * every character outside the alphabet replaced, no leading dots, an
 * ingestible extension (lowercased). Null when there is no such extension.
 */
export function safeUploadName(input: unknown): { name: string; ext: IngestExtension } | null {
  if (typeof input !== "string") return null;
  const leaf = input.split(/[\\/]/).pop() ?? "";
  const dot = leaf.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = leaf.slice(dot).toLowerCase();
  if (!isIngestExtension(ext)) return null;
  let stem = "";
  for (const ch of leaf.slice(0, dot)) stem += NAME_CHARS.test(ch) ? ch : "_";
  stem = stem.replace(/^[.\s]+/, "").trim().slice(0, MAX_NAME_CHARS - ext.length);
  if (stem === "") stem = "document";
  return { name: `${stem}${ext}`, ext };
}

export function batchDir(batch: string): string {
  return path.join(uploadsRoot(), batch);
}

export type StageResult =
  | { ok: true; batch: string; name: string; bytes: number }
  | { ok: false; code: "invalid_name" | "unknown_batch" | "batch_full" | "too_large" | "disk_full" | "write_failed" | "empty"; status: number };

function freeBytes(dir: string): number | null {
  try {
    const st = statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

async function batchUsage(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    files += 1;
    try {
      bytes += (await fs.lstat(path.join(dir, e.name))).size;
    } catch {
      /* gone meanwhile */
    }
  }
  return { files, bytes };
}

/** Remove batches older than the TTL (best effort). */
export async function pruneStaleBatches(nowMs: number = Date.now()): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(uploadsRoot(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const id = safeBatchId(e.name);
    if (!id || !e.isDirectory()) continue;
    try {
      const st = await fs.lstat(batchDir(id));
      if (nowMs - st.mtimeMs > UPLOAD_BATCH_TTL_MS) await fs.rm(batchDir(id), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Stage one dropped file. `batch` null starts a new batch; a given one must
 * already exist (made by an earlier upload of the same drop).
 */
export async function stageUpload(
  body: ReadableStream<Uint8Array> | null,
  rawName: unknown,
  rawBatch: unknown,
  declaredLength: number | null,
): Promise<StageResult> {
  const named = safeUploadName(rawName);
  if (!named) return { ok: false, code: "invalid_name", status: 400 };
  if (!body) return { ok: false, code: "empty", status: 400 };
  if (declaredLength !== null && declaredLength > MAX_UPLOAD_FILE_BYTES) return { ok: false, code: "too_large", status: 413 };

  let batch: string;
  if (rawBatch === null || rawBatch === undefined || rawBatch === "") {
    batch = newBatchId();
    await fs.mkdir(uploadsRoot(), { recursive: true, mode: 0o700 });
    await pruneStaleBatches();
    await fs.mkdir(batchDir(batch), { mode: 0o700 });
  } else {
    const safe = safeBatchId(rawBatch);
    if (!safe) return { ok: false, code: "unknown_batch", status: 404 };
    batch = safe;
    try {
      const st = await fs.lstat(batchDir(batch));
      if (!st.isDirectory()) return { ok: false, code: "unknown_batch", status: 404 };
    } catch {
      return { ok: false, code: "unknown_batch", status: 404 };
    }
  }
  const dir = batchDir(batch);
  const usage = await batchUsage(dir);
  if (usage.files >= MAX_UPLOAD_FILES_PER_BATCH) return { ok: false, code: "batch_full", status: 409 };
  const roomInBatch = MAX_UPLOAD_BATCH_BYTES - usage.bytes;
  if (roomInBatch <= 0) return { ok: false, code: "batch_full", status: 409 };

  // A free name in the batch: `name.ext`, then `name (2).ext`, …, created exclusively.
  let handle: fs.FileHandle | null = null;
  let name = named.name;
  const stem = named.name.slice(0, -named.ext.length);
  for (let n = 1; n <= MAX_UPLOAD_FILES_PER_BATCH + 1 && !handle; n++) {
    name = n === 1 ? named.name : `${stem} (${n})${named.ext}`;
    try {
      handle = await fs.open(path.join(dir, name), "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return { ok: false, code: "write_failed", status: 500 };
    }
  }
  if (!handle) return { ok: false, code: "write_failed", status: 500 };
  const target = path.join(dir, name);

  const free = freeBytes(dir);
  // Free space is measured once: this file is the only thing the cap is about.
  const limit = Math.min(MAX_UPLOAD_FILE_BYTES, roomInBatch, free === null ? Infinity : free - DISK_FREE_RESERVE_BYTES);
  const metered = boundedBody(body, { limit });
  let failed: StageResult | null = null;
  try {
    const reader = metered.stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await handle.write(value);
    }
  } catch {
    if (metered.overflowed()) {
      const diskBound = free !== null && free - DISK_FREE_RESERVE_BYTES < Math.min(MAX_UPLOAD_FILE_BYTES, roomInBatch);
      failed = diskBound ? { ok: false, code: "disk_full", status: 507 } : { ok: false, code: "too_large", status: 413 };
    } else {
      failed = { ok: false, code: "write_failed", status: 500 };
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (!failed && metered.bytes() === 0) failed = { ok: false, code: "empty", status: 400 };
  if (!failed && declaredLength !== null && metered.bytes() !== declaredLength) failed = { ok: false, code: "too_large", status: 413 };
  if (failed) {
    await fs.rm(target, { force: true });
    return failed;
  }
  return { ok: true, batch, name, bytes: metered.bytes() };
}

/** The staged folder of a batch, when it exists and holds at least one file. */
export async function stagedBatch(rawBatch: unknown): Promise<string | null> {
  const batch = safeBatchId(rawBatch);
  if (!batch) return null;
  const dir = batchDir(batch);
  try {
    const st = await fs.lstat(dir);
    if (!st.isDirectory()) return null;
    const usage = await batchUsage(dir);
    return usage.files > 0 ? dir : null;
  } catch {
    return null;
  }
}
