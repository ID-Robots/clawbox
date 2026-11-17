/**
 * The bounds one Files upload is held to (TASK-2446): the disk's room, which
 * binds everyone, and — for a signed-in ClawBox user other than the owner —
 * their upload size limit and, for a write into their own home, their home
 * quota (src/lib/user-limits.ts). SERVER ONLY.
 *
 * The route meters the body against `ceiling` (src/lib/bounded-body.ts) and,
 * when the meter cuts it off, answers the refusal of whichever bound was the
 * lowest at that moment: 413 `upload_too_large` names the limit, 507
 * `quota_exceeded` names what the home holds and its quota, and the disk's own
 * 507 `disk_full` is the route's. A refusal is decided by the numbers, never
 * by an error's text.
 */

import fs from "fs";
import { MEMBER_HOME_ENTRY, type FilesFence } from "@/lib/files-scope";
import { insideHome, measureHomeUsage, noteHomeChange, openQuotaWrite, type QuotaWrite } from "@/lib/home-usage";
import { quotaExceededMessage, uploadTooLargeMessage } from "@/lib/user-limits";
import { homeQuotaBytes, readUserLimits, uploadLimitBytes } from "@/lib/user-limits-server";

export type UploadBound = "disk" | "upload_limit" | "quota";

export interface UploadRefusalBody {
  error: string;
  code: string;
  limitBytes?: number;
  usedBytes?: number;
  quotaBytes?: number;
}

export interface UploadGuard {
  /**
   * The most the file may be by the disk's room and the upload limit, judged
   * once now, or Infinity — a multipart parser's per-file limit. The quota is
   * not in it: what a part replaces is known only once it names its file, so
   * the quota is metered on the part's own bytes (`quotaCeiling`).
   */
  readonly initialMax: number;
  /** Which bound `initialMax` came from. */
  readonly initialBound: UploadBound;
  /** The body meter's ceiling for the bytes passed so far; re-asks the disk and the quota. */
  ceiling(passed: number): number;
  /** The quota's ceiling alone for a file that has passed `passed` bytes; Infinity without one. */
  quotaCeiling(passed: number): number;
  /** The upload writes `destPath` (a multipart part named it): a file there gives its room back. */
  destination(destPath: string): void;
  /** Which bound the last `ceiling` came from. */
  lastBound(): UploadBound;
  /**
   * A refusal before any byte is read, for an upload that declared its size:
   * past the upload limit or the quota. Null when it may go ahead (the disk's
   * own pre-check is the route's).
   */
  precheck(declaredBytes: number, opts?: { quota?: boolean }): { status: number; body: UploadRefusalBody } | null;
  /** The refusal for an upload stopped at `bound`; null for the disk's (the route words that). */
  refusalFor(bound: UploadBound): { status: number; body: UploadRefusalBody } | null;
  /**
   * The upload ended: `landedBytes` is the size of the file it wrote, or null
   * when it failed (what it may have replaced is then measured again).
   */
  finish(landedBytes: number | null): void;
}

/** The size of a regular file the upload would replace, else 0. */
export function replacedBytes(destPath: string): number {
  try {
    const st = fs.lstatSync(/* turbopackIgnore: true */ destPath);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

/**
 * The guard for one upload to `destPath`, by `limitedUser` (null: the owner
 * or the agent's bearer, held to the disk alone). `disk` is the route's own
 * re-measured disk ceiling.
 */
export async function userUploadGuard(opts: {
  limitedUser: string | null;
  fence: FilesFence;
  destPath: string;
  disk: (passed: number) => number;
}): Promise<UploadGuard> {
  const { limitedUser, fence, destPath, disk } = opts;
  let uploadLimit: number | null = null;
  let quota: QuotaWrite | null = null;
  let quotaHome: string | null = null;
  let replaced = 0;
  if (limitedUser) {
    const limits = await readUserLimits();
    uploadLimit = uploadLimitBytes(limits);
    const quotaBytes = homeQuotaBytes(limits);
    // The quota is the user's OWN home's: on an organisation box Files serves
    // it as their Home. Their writes into Shared, and a home box's users
    // writing into the owner's folders, are the disk's to bound.
    const home = memberHome(fence);
    if (quotaBytes !== null && home && insideHome(home, destPath)) {
      replaced = replacedBytes(destPath);
      quota = await openQuotaWrite(home, quotaBytes, replaced);
      if (quota) quotaHome = home;
    }
  }

  let bound: UploadBound = "disk";
  const lowest = (passed: number): { max: number; bound: UploadBound } => {
    let max = disk(passed);
    let which: UploadBound = "disk";
    if (uploadLimit !== null && uploadLimit < max) {
      max = uploadLimit;
      which = "upload_limit";
    }
    if (quota) {
      const room = quota.ceiling(passed);
      if (room < max) {
        max = room;
        which = "quota";
      }
    }
    return { max, bound: which };
  };
  // The parser's per-file limit: the disk and the upload limit, not the quota.
  const firstRoom = disk(0);
  const first: { max: number; bound: UploadBound } = uploadLimit !== null && uploadLimit < firstRoom
    ? { max: uploadLimit, bound: "upload_limit" }
    : { max: firstRoom, bound: "disk" };
  bound = first.bound;

  const refusalFor = (which: UploadBound): { status: number; body: UploadRefusalBody } | null => {
    if (which === "upload_limit" && uploadLimit !== null) {
      return { status: 413, body: { error: uploadTooLargeMessage(uploadLimit), code: "upload_too_large", limitBytes: uploadLimit } };
    }
    if (which === "quota" && quota) {
      return {
        status: 507,
        body: {
          error: quotaExceededMessage(quota.usedBytes, quota.quotaBytes),
          code: "quota_exceeded",
          usedBytes: quota.usedBytes,
          quotaBytes: quota.quotaBytes,
        },
      };
    }
    return null;
  };

  return {
    initialMax: first.max,
    initialBound: first.bound,
    ceiling(passed: number) {
      const now = lowest(passed);
      bound = now.bound;
      return now.max;
    },
    lastBound: () => bound,
    quotaCeiling: (passed: number) => (quota ? quota.ceiling(passed) : Infinity),
    destination(path: string) {
      if (!quota || !quotaHome || !insideHome(quotaHome, path)) return;
      replaced = replacedBytes(path);
      quota.replacing(replaced);
    },
    precheck(declaredBytes: number, { quota: withQuota = true }: { quota?: boolean } = {}) {
      if (!(declaredBytes > 0)) return null;
      const overLimit = uploadLimit !== null && declaredBytes > uploadLimit;
      const room = quota && withQuota ? quota.ceiling(0) : Infinity;
      const overQuota = declaredBytes > room;
      // Past both: the lower of the two is the one the person has to deal with.
      if (overLimit && overQuota) return refusalFor(uploadLimit! <= room ? "upload_limit" : "quota");
      if (overLimit) return refusalFor("upload_limit");
      if (overQuota) return refusalFor("quota");
      return null;
    },
    refusalFor,
    finish(landedBytes: number | null) {
      if (!quota) return;
      quota.finish(landedBytes === null ? 0 : landedBytes - replaced);
      // A failed write may have taken the file it was replacing with it.
      if (landedBytes === null && replaced > 0 && quotaHome) noteHomeChange(quotaHome);
    },
  };
}

/** A member of staff's own home in their Files view, or null for any other view. */
export function memberHome(fence: FilesFence): string | null {
  if (fence.scope.kind !== "member") return null;
  return fence.scope.roots.find((r) => r.name === MEMBER_HOME_ENTRY)?.real ?? null;
}

/** Bytes the regular files at `abs` hold: the file itself, or everything under a folder. */
async function bytesAt(abs: string): Promise<number> {
  try {
    const st = await fs.promises.lstat(/* turbopackIgnore: true */ abs);
    if (st.isFile()) return st.size;
    if (st.isDirectory()) return (await measureHomeUsage(abs))?.bytes ?? 0;
  } catch {
    // gone: it moves nothing
  }
  return 0;
}

/**
 * A move into a limited user's home from outside it (their Shared folder)
 * adds what it carries: refused 507 `quota_exceeded` when that would take the
 * home past its quota. Null when the move may go ahead — and always for the
 * owner, a move within one folder tree, or a home that cannot be measured.
 */
export async function moveQuotaRefusal(opts: {
  limitedUser: string | null;
  fence: FilesFence;
  destAbs: string | null;
  sources: ReadonlyArray<string | null>;
}): Promise<{ status: number; body: UploadRefusalBody } | null> {
  const { limitedUser, fence, destAbs, sources } = opts;
  if (!limitedUser || !destAbs) return null;
  const home = memberHome(fence);
  if (!home || !insideHome(home, destAbs)) return null;
  const incoming = sources.filter((s): s is string => typeof s === "string" && !insideHome(home, s));
  if (incoming.length === 0) return null;
  const quotaBytes = homeQuotaBytes(await readUserLimits());
  if (quotaBytes === null) return null;
  let bytes = 0;
  for (const abs of incoming) bytes += await bytesAt(abs);
  const write = await openQuotaWrite(home, quotaBytes);
  if (!write) return null;
  try {
    if (bytes <= write.ceiling(0)) return null;
    return {
      status: 507,
      body: {
        error: quotaExceededMessage(write.usedBytes, write.quotaBytes),
        code: "quota_exceeded",
        usedBytes: write.usedBytes,
        quotaBytes: write.quotaBytes,
      },
    };
  } finally {
    write.finish(0);
  }
}

/** Something under a member's view changed by other means (a move, a delete): measure the home again next time. */
export function memberHomeChanged(fence: FilesFence): void {
  const home = memberHome(fence);
  if (home) noteHomeChange(home);
}
