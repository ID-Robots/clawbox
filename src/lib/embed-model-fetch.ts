import { createHash } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import fs from "fs/promises";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import path from "./runtime-path";
import type { LocalEmbeddingVariant } from "./embed-runtime-ids";

/**
 * Fetch one catalog GGUF as the web server's own user: resumable, checked for
 * disk first, and verified against the Hub's sha256 before it is put where the
 * embedder looks (TASK-2411).
 *
 * WHY NOT THE ROOT STEP. The 0.6B still arrives through install.sh's
 * `embed_model`, exactly as before. The 4B is offered only on an x86 PC, and
 * neither x86 install has that step (install-x64.sh does not dispatch it and
 * the desktop integration refuses it), while data/embed/models is the web
 * server's own directory on every install — so fetching it needs no privilege
 * at all, and asks for none.
 *
 *  - RESUMABLE: the bytes go to `<file>.part`, and a later attempt — after a
 *    dropped link, a cancelled task or a restarted server — asks the Hub for
 *    the rest with a Range request instead of starting over.
 *  - DISK FIRST: what is still to come, plus a margin, must be free on the
 *    model directory's filesystem before a byte is fetched.
 *  - VERIFIED: the whole file is hashed and compared with the catalog's
 *    sha256; a mismatch deletes the part (a resume cannot repair it) and
 *    fails. Only a verified file is renamed into place, so the embedder never
 *    sees a partial or a wrong one.
 *
 * SERVER ONLY.
 */

/** Room left over after the download, so a full disk is not the outcome. */
export const DOWNLOAD_DISK_MARGIN_BYTES = 512 * 1024 * 1024;

export interface FetchGgufOptions {
  repo: string;
  variant: LocalEmbeddingVariant;
  dir: string;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
  /** Seams for the tests. */
  fetchImpl?: typeof fetch;
  freeBytes?: (dir: string) => Promise<number | null>;
}

export function partPathOf(dir: string, variant: LocalEmbeddingVariant): string {
  return path.join(dir, `${variant.file}.part`);
}

function hubUrl(repo: string, file: string): string {
  // HF_ENDPOINT is the Hub CLI's own switch for a mirror; honour it the same way.
  const base = (process.env.HF_ENDPOINT || "https://huggingface.co").replace(/\/+$/, "");
  return `${base}/${repo}/resolve/main/${encodeURIComponent(file)}`;
}

async function statfsFree(dir: string): Promise<number | null> {
  try {
    const s = await fs.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

async function sizeOf(file: string): Promise<number> {
  return fs.stat(file).then((s) => s.size, () => 0);
}

export async function sha256OfFile(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash, { signal });
  return hash.digest("hex");
}

const gb = (bytes: number) => (bytes / 1e9).toFixed(1);

/** Download, verify and place one GGUF. Resolves with its final path. */
export async function fetchVerifiedGguf(opts: FetchGgufOptions): Promise<string> {
  const { repo, variant, dir, signal, onProgress } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const freeBytes = opts.freeBytes ?? statfsFree;
  const dest = path.join(dir, variant.file);
  const part = partPathOf(dir, variant);
  await fs.mkdir(dir, { recursive: true });

  let have = await sizeOf(part);
  if (have > variant.bytes) {
    await fs.rm(part, { force: true });
    have = 0;
  }
  const free = await freeBytes(dir);
  const needed = variant.bytes - have + DOWNLOAD_DISK_MARGIN_BYTES;
  if (free !== null && free < needed) {
    throw new Error(
      `Not enough disk space for ${variant.file}: it needs ${gb(needed)} GB free and ${gb(free)} GB is free. Free some space and try again.`,
    );
  }

  onProgress?.(have, variant.bytes);
  if (have < variant.bytes) {
    const res = await fetchImpl(hubUrl(repo, variant.file), {
      headers: have > 0 ? { Range: `bytes=${have}-` } : {},
      redirect: "follow",
      signal,
    });
    if (res.status === 200 && have > 0) {
      // The server ignored the Range: the whole file comes again.
      have = 0;
    } else if (res.status !== 200 && res.status !== 206) {
      throw new Error(`The model download was refused (HTTP ${res.status}). Try again later.`);
    }
    if (!res.body) throw new Error("The model download returned no data.");
    let completed = have;
    const counted = Readable.fromWeb(res.body as unknown as import("stream/web").ReadableStream<Uint8Array>);
    counted.on("data", (chunk: Buffer) => {
      completed += chunk.length;
      onProgress?.(Math.min(completed, variant.bytes), variant.bytes);
    });
    await pipeline(counted, createWriteStream(part, { flags: have > 0 ? "a" : "w" }), { signal });
  }

  const size = await sizeOf(part);
  if (size !== variant.bytes) {
    // Short: the next attempt resumes. Long: nothing can repair it.
    if (size > variant.bytes) await fs.rm(part, { force: true });
    throw new Error(`The download of ${variant.file} stopped at ${gb(size)} of ${gb(variant.bytes)} GB. Try again to resume it.`);
  }
  const digest = await sha256OfFile(part, signal);
  if (digest !== variant.sha256) {
    await fs.rm(part, { force: true });
    throw new Error(`${variant.file} did not verify (its sha256 is not the one the Hub lists), so it was deleted. Try again.`);
  }
  await fs.rename(part, dest);
  onProgress?.(variant.bytes, variant.bytes);
  return dest;
}
