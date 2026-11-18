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
 *
 * The bytes a write is metered against while they arrive can go stale before
 * it lands (TASK-2663): so an upload into a limited home is checked once more
 * at its commit, under the home's lock (`UploadGuard.commit`), and a move into
 * one measures and moves under that lock too (`guardedMove`).
 */

import fs from "fs";
import path from "@/lib/runtime-path";
import { MEMBER_HOME_ENTRY, type FilesFence } from "@/lib/files-scope";
import { insideHome, measureHomeUsage, noteHomeChange, openQuotaWrite, withHomeLock, type QuotaWrite } from "@/lib/home-usage";
import { commitUploadTemp } from "@/lib/upload-temp";
import { quotaExceededMessage, quotaUnmeasuredMessage, uploadTooLargeMessage } from "@/lib/user-limits";
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
  /**
   * Its bytes go to the temporary file `tempPath` (by the path its descriptor
   * was judged at) until the commit: a walk of the home while it is open
   * leaves that file out, since its bytes are counted when it lands.
   */
  staging(tempPath: string): void;
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
   * Put the whole accepted upload in place: its temporary file `tempReal` is
   * renamed over `destPath` (src/lib/upload-temp.ts) and the upload finishes.
   * Into a limited home this happens under the home's lock, and only when the
   * home still has room for it NOW — net of the file the rename really
   * replaces, read right before it — and the figure moves before the lock is
   * let go. False when the quota refused it at this last check: nothing was
   * renamed, the old file is untouched, and the caller removes the temporary
   * file, answers `refusalFor("quota")` and calls `finish(null)`. A rename
   * that fails throws, as `commitUploadTemp` does.
   */
  commit(tempReal: string, destPath: string): Promise<boolean>;
  /**
   * The upload ended: `landedBytes` is the size of the file it wrote, or null
   * when it failed (the file it would have replaced is untouched then).
   * `replacedBytes` is the size of the file the commit actually replaced, read
   * right before its rename: the home's figure moves by the difference, so it
   * matches the disk even when another upload of the same name landed first.
   * Only the first call counts (`commit` makes it for a write it landed).
   */
  finish(landedBytes: number | null, replacedBytes?: number): void;
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
  let writing: string | null = null;
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
    if (which === "quota" && quota) return quotaRefusal(quota);
    return null;
  };

  let finished = false;
  const finish = (landedBytes: number | null, replacedAtCommit?: number) => {
    if (finished) return;
    finished = true;
    if (writing) endWriting(writing);
    writing = null;
    if (!quota) return;
    const gaveBack = replacedAtCommit !== undefined && Number.isFinite(replacedAtCommit) ? Math.max(0, replacedAtCommit) : replaced;
    quota.finish(landedBytes === null ? 0 : landedBytes - gaveBack);
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
      // Every upload's file is known to be written until it ends, whoever
      // writes it: a move must not carry it into a limited home meanwhile.
      writing = path;
      beginWriting(path);
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
    async commit(tempReal: string, destPath: string) {
      // Only a write into the limited user's own home is the quota's: the
      // check, the rename and the figure's move are one step under its lock.
      const home = quota && quotaHome && insideHome(quotaHome, destPath) ? quotaHome : null;
      const land = (admit?: (sizes: { landedBytes: number; replacedBytes: number }) => boolean): boolean => {
        const committed = commitUploadTemp(tempReal, destPath, admit);
        if (!committed) return false;
        finish(committed.landedBytes, committed.replacedBytes);
        return true;
      };
      if (!home || !quota) return land();
      const write = quota;
      return withHomeLock(home, async () => {
        // A figure a delete or a move left stale is measured again first, so
        // the check below is against what the home really holds.
        await write.settle();
        // Nothing awaited from here: the check, the rename and the figure's move.
        return land(({ landedBytes, replacedBytes }) => write.admits(landedBytes, replacedBytes));
      });
    },
    staging(tempPath: string) {
      quota?.staging(tempPath);
    },
    finish,
  };
}

/** A member of staff's own home in their Files view, or null for any other view. */
export function memberHome(fence: FilesFence): string | null {
  if (fence.scope.kind !== "member") return null;
  return fence.scope.roots.find((r) => r.name === MEMBER_HOME_ENTRY)?.real ?? null;
}

/** Bytes the regular files at `abs` hold: the file itself, or everything under a folder. */
/**
 * The refusal of a write past a home's quota — or, for a home too large to
 * measure whole within the walk's bounds, of any write that would add to it:
 * a floor of its usage grants no room (src/lib/home-usage.ts).
 */
function quotaRefusal(quota: QuotaWrite): { status: number; body: UploadRefusalBody } {
  if (quota.truncated) {
    return {
      status: 507,
      body: { error: quotaUnmeasuredMessage(quota.quotaBytes), code: "quota_unmeasured", usedBytes: quota.usedBytes, quotaBytes: quota.quotaBytes },
    };
  }
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

/** Bytes the regular files at `abs` hold, and whether a folder's walk stopped short (then a floor). */
async function bytesAt(abs: string): Promise<{ bytes: number; truncated: boolean }> {
  try {
    const st = await fs.promises.lstat(/* turbopackIgnore: true */ abs);
    if (st.isFile()) return { bytes: st.size, truncated: false };
    if (st.isDirectory()) {
      const usage = await measureHomeUsage(abs);
      return usage ? { bytes: usage.bytes, truncated: usage.truncated } : { bytes: 0, truncated: true };
    }
  } catch {
    // gone: it moves nothing
  }
  return { bytes: 0, truncated: false };
}

// ── Files being written ──────────────────────────────────────────────────────
//
// An upload writes through a descriptor: a file moved while it is still being
// written goes on growing where it now is. So the files uploads are writing
// right now are kept here — on `globalThis`, one set for every route bundle —
// and a move into a limited user's home refuses to carry one (TASK-2446):
// whatever it would still grow by is bytes no quota check sees.

const WRITING_KEY = Symbol.for("clawbox.userUploadGuard.writing");
function writingNow(): Map<string, number> {
  const g = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
  let map = g[WRITING_KEY];
  if (!map) {
    map = new Map();
    g[WRITING_KEY] = map;
  }
  return map;
}

function beginWriting(abs: string): void {
  const k = path.resolve(abs);
  const map = writingNow();
  map.set(k, (map.get(k) ?? 0) + 1);
}

function endWriting(abs: string): void {
  const k = path.resolve(abs);
  const map = writingNow();
  const n = (map.get(k) ?? 0) - 1;
  if (n > 0) map.set(k, n);
  else map.delete(k);
  noteLanded(k);
}

// What landed where while a move was measuring, by a sequence number: a move
// that measured a source before something landed in it — an upload that
// finished writing a file there, another move or a rename into it — must not
// move it at the size it measured (TASK-2663). Every landing is noted
// (`noteLanded`); a move notes the sequence when it starts measuring and asks,
// right before it moves, whether anything landed under a source since.
//
// An entry matters only to a measurement that was already running when it was
// noted, so entries are kept exactly as long as one is: none once the last
// running measurement has ended, however long it took.
interface LandedState {
  seq: number;
  /** Path → the sequence of the last landing there. */
  at: Map<string, number>;
  /** Each running measurement → the sequence it started at. */
  measuring: Map<symbol, number>;
}
const LANDED_KEY = Symbol.for("clawbox.userUploadGuard.landed");
function landedState(): LandedState {
  const g = globalThis as unknown as Record<symbol, LandedState | undefined>;
  let state = g[LANDED_KEY];
  if (!state) {
    state = { seq: 0, at: new Map(), measuring: new Map() };
    g[LANDED_KEY] = state;
  }
  return state;
}

/** Forget every entry no running measurement can ask about. */
function pruneLanded(state: LandedState): void {
  let oldest = Infinity;
  for (const since of state.measuring.values()) oldest = Math.min(oldest, since);
  for (const [p, seq] of state.at) if (seq <= oldest) state.at.delete(p);
}

/**
 * Something landed at `abs` — an upload's file, or a file or folder a move or
 * a rename put there: a move that measured a folder it is in measures again.
 */
export function noteLanded(abs: string): void {
  const state = landedState();
  if (state.measuring.size === 0) return;
  state.at.set(path.resolve(abs), ++state.seq);
}

/** A measurement starts: `landedUnder` answers for what lands from now until `end()`. */
function startMeasuring(): { landedUnder: (abs: string) => boolean; end: () => void } {
  const state = landedState();
  const token = Symbol("measuring");
  const since = state.seq;
  state.measuring.set(token, since);
  return {
    landedUnder(abs: string) {
      const k = path.resolve(abs);
      for (const [p, seq] of state.at) if (seq > since && (p === k || p.startsWith(k + path.sep))) return true;
      return false;
    },
    end() {
      state.measuring.delete(token);
      pruneLanded(state);
    },
  };
}


/** Is an upload writing `abs`, or a file under it right now? */
export function uploadWritingUnder(abs: string): boolean {
  const k = path.resolve(abs);
  for (const p of writingNow().keys()) if (p === k || p.startsWith(k + path.sep)) return true;
  return false;
}

type MoveRefusalOf = { status: number; body: UploadRefusalBody };

/** What `guardedMove` answers: the move's own answer, or why it did not run. */
export type GuardedMove<T> = { refusal: MoveRefusalOf } | { value: T };

/** Something a move would carry is still being uploaded: it would go on growing wherever it lands. */
const MOVE_UPLOAD_IN_PROGRESS: MoveRefusalOf = {
  status: 409,
  body: { error: "Something in this selection is still being uploaded. Move it once the upload has finished.", code: "upload_in_progress" },
};

/** What a move would carry kept changing while it was measured. */
const MOVE_SOURCES_CHANGED: MoveRefusalOf = {
  status: 409,
  body: { error: "Something in this selection changed while it was being moved. Try the move again.", code: "move_sources_changed" },
};

/** How often a move measures again what changed under it before it gives up (409 `move_sources_changed`). */
export const MOVE_MEASURE_ATTEMPTS = 3;

/**
 * Run `move` — the Files route's synchronous batch of renames — unless it may
 * not run now. Answers `{ value }` with what `move` answered, or `{ refusal }`
 * when it did not run:
 *
 * - 409 `upload_in_progress`: an upload is still writing one of `sources` (or
 *   a file under one), asked synchronously right before `move`, for anyone.
 * - A limited user's move from outside their home (their Shared folder) into
 *   it adds what it carries, and runs under the home's lock
 *   (`withHomeLock`): no other write lands in the home while the move is
 *   measured and moved. 507 `quota_exceeded` when what it carries would take
 *   the home past its quota (asked with nothing awaited between the answer
 *   and the move), `quota_unmeasured` when the size of what it carries — or
 *   of the home — could not be established within the walk's bounds.
 * - Something landed under a source while it was measured (an upload, another
 *   person's move or rename into it — `noteLanded`): it is measured again, up
 *   to `MOVE_MEASURE_ATTEMPTS` times, then 409 `move_sources_changed`.
 *
 * The owner, a move within one home, no quota or a home that cannot be read
 * at all: only the first rule applies.
 */
export async function guardedMove<T>(
  opts: {
    limitedUser: string | null;
    fence: FilesFence;
    destAbs: string | null;
    sources: ReadonlyArray<string | null>;
  },
  move: () => T,
): Promise<GuardedMove<T>> {
  const { limitedUser, fence, destAbs, sources } = opts;
  const uploading = () => sources.some((s) => s !== null && uploadWritingUnder(s));
  const plain = (): GuardedMove<T> => (uploading() ? { refusal: MOVE_UPLOAD_IN_PROGRESS } : { value: move() });
  if (!limitedUser || !destAbs) return plain();
  const home = memberHome(fence);
  if (!home || !insideHome(home, destAbs)) return plain();
  const incoming = sources.filter((s): s is string => typeof s === "string" && !insideHome(home, s));
  if (incoming.length === 0) return plain();
  const quotaBytes = homeQuotaBytes(await readUserLimits());
  if (quotaBytes === null) return plain();

  return withHomeLock(home, async () => {
    for (let attempt = 1; ; attempt++) {
      // Started before anything is measured: whatever lands under a source
      // from here on was not in what this attempt counts.
      const measuring = startMeasuring();
      let write: QuotaWrite | null = null;
      let bytes = 0;
      let ran = false;
      try {
        if (uploading()) return { refusal: MOVE_UPLOAD_IN_PROGRESS };
        write = await openQuotaWrite(home, quotaBytes);
        if (!write) return plain();
        await write.settle();
        let unmeasured = false;
        for (const abs of incoming) {
          const at = await bytesAt(abs);
          bytes += at.bytes;
          if (at.truncated) unmeasured = true;
        }
        // ── Nothing is awaited from here to the move. ──
        if (uploading()) return { refusal: MOVE_UPLOAD_IN_PROGRESS };
        if (incoming.some(measuring.landedUnder)) {
          if (attempt < MOVE_MEASURE_ATTEMPTS) continue;
          return { refusal: MOVE_SOURCES_CHANGED };
        }
        if (unmeasured) {
          return { refusal: { status: 507, body: { error: quotaUnmeasuredMessage(quotaBytes), code: "quota_unmeasured", usedBytes: write.usedBytes, quotaBytes } } };
        }
        if (!write.admits(bytes, 0)) return { refusal: quotaRefusal(write) };
        ran = true;
        return { value: move() };
      } finally {
        // Counted whole at once — a write that opens before the next walk
        // must not be granted these bytes again — and then measured anew, so
        // a move that ran only in part is not counted whole for long. Both
        // before the lock is let go.
        write?.finish(ran ? bytes : 0);
        if (ran) noteHomeChange(home);
        measuring.end();
      }
    }
  });
}

/** Something under a member's view changed by other means (a move, a delete): measure the home again next time. */
export function memberHomeChanged(fence: FilesFence): void {
  const home = memberHome(fence);
  if (home) noteHomeChange(home);
}
