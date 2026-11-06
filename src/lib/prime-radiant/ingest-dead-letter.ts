/**
 * Keeping a dead letter's bytes where a retry can read them.
 *
 * A document from the owner's folders is retried from where it lies. A
 * DROPPED document has no such place — its upload batch is removed when the
 * job ends — so a dropped file that still failed is moved into
 * `<prime-radiant root>/dead-letter/<job>/` first, and its row points there.
 * A retry that turns it into pages (or finds it a duplicate, or nothing to
 * keep) removes the kept copy; one that fails again leaves it for the next
 * retry. Kept copies older than {@link DEAD_LETTER_TTL_MS} are removed, and a
 * retry of one that is gone fails it for good (`gone`) instead of listing it
 * again.
 *
 * SERVER ONLY.
 */

import fs from "fs/promises";
import path from "@/lib/runtime-path";
import { primeRadiantRoot } from "./paths";

export const DEAD_LETTER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function deadLetterRoot(): string {
  return path.join(primeRadiantRoot(), "dead-letter");
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function isKeptCopy(abs: string): boolean {
  return inside(path.resolve(deadLetterRoot()), path.resolve(abs));
}

/**
 * Move the failed files of an upload job out of its staging folder into the
 * job's dead-letter folder. Answers the new source of each (null when the
 * move failed: that file cannot be retried, the owner drops it again).
 */
export async function keepFailedUploads(
  jobId: string,
  stagingDir: string,
  files: ReadonlyArray<{ seq: number; source: string }>,
): Promise<Array<{ seq: number; source: string | null }>> {
  const out: Array<{ seq: number; source: string | null }> = [];
  if (files.length === 0) return out;
  const target = path.join(deadLetterRoot(), jobId);
  for (const f of files) {
    const rel = path.relative(stagingDir, f.source);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      out.push({ seq: f.seq, source: null });
      continue;
    }
    const dest = path.join(target, rel);
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await fs.rename(f.source, dest);
      out.push({ seq: f.seq, source: dest });
    } catch {
      out.push({ seq: f.seq, source: null });
    }
  }
  return out;
}

/** Remove kept copies a retry no longer needs, and any folder that leaves empty. */
export async function dropKeptCopies(sources: readonly string[]): Promise<void> {
  const root = path.resolve(deadLetterRoot());
  for (const s of sources) {
    if (!isKeptCopy(s)) continue;
    await fs.rm(s, { force: true }).catch(() => undefined);
    let dir = path.dirname(path.resolve(s));
    while (inside(root, dir)) {
      try {
        await fs.rmdir(dir);
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
  }
}

/** Remove job folders under the dead-letter root older than the TTL. */
export async function pruneKeptCopies(now: number = Date.now(), ttlMs = DEAD_LETTER_TTL_MS): Promise<number> {
  let entries;
  try {
    entries = await fs.readdir(deadLetterRoot(), { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(deadLetterRoot(), e.name);
    try {
      const st = await fs.stat(dir);
      if (now - st.mtimeMs < ttlMs) continue;
      await fs.rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* gone already */
    }
  }
  return removed;
}
