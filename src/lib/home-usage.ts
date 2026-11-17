/**
 * How much a ClawBox user's home folder holds, and the writes that would take
 * it past its quota (TASK-2446, src/lib/user-limits.ts). SERVER ONLY.
 *
 * Usage is the APPARENT size of the regular files under the home — what the
 * Files app lists and what an upload adds — walked without following links,
 * so a link into `/` does not make a home the size of the disk. A walk is
 * bounded (MAX_WALK_ENTRIES, WALK_BUDGET_MS) and reads each folder a batch at
 * a time, so a flat folder of a million names is never loaded whole: past
 * either bound the answer is a FLOOR (`truncated`). A floor is shown to the
 * owner as "at least", but it never GRANTS room — a write into a home that
 * could not be measured whole is refused (`QuotaWrite.truncated`).
 *
 * ONE FIGURE PER HOME, kept current by the writes this process makes. A
 * measurement is cached for a minute and moved by every write that lands;
 * while any write into the home is open the home is never walked again (the
 * walk would count the open write's partial bytes, which its own `finish`
 * then adds a second time). A delete or a move asks for a fresh walk — but
 * while writes are open the figure is only marked stale and kept, so the
 * bytes those writes land are still added to it, and it is walked again once
 * the last of them has finished.
 *
 * Several writes into one home at once (two windows, a script) each see the
 * bytes the others have already passed: `openQuotaWrite` hands out a ceiling
 * that subtracts them, so two uploads cannot each be granted the same room.
 */

import fs from "fs";
import path from "@/lib/runtime-path";

/** The most entries a walk visits before it reports a floor. */
export const MAX_WALK_ENTRIES = 200_000;
/** The longest a walk may take before it reports a floor. */
export const WALK_BUDGET_MS = 15_000;
/** How long a measured usage is trusted (writes made here keep it current meanwhile). */
export const USAGE_CACHE_MS = 60_000;
/** lstat calls in flight at once during a walk, and the directory read batch. */
const STAT_BATCH = 64;

export interface HomeUsage {
  /** Bytes the regular files under the home hold. */
  bytes: number;
  /** True when the walk stopped early: `bytes` is a floor. */
  truncated: boolean;
  /** When it was measured (ms). */
  measuredAt: number;
}

interface CachedUsage extends HomeUsage {
  /** Asked to be walked again (a delete, a move) while writes were open. */
  stale?: boolean;
}

interface OpenWrite {
  passed: number;
}

/**
 * The measurements and open writes, kept on `globalThis` under a registered
 * symbol: every route that writes into a home (an upload, a move, a delete)
 * and the owner's usage column must see ONE figure per home, whichever copy
 * of this module a route's bundle carries.
 */
interface UsageState {
  cache: Map<string, CachedUsage>;
  measuring: Map<string, Promise<HomeUsage | null>>;
  openWrites: Map<string, Set<OpenWrite>>;
}
const STATE_KEY = Symbol.for("clawbox.homeUsage");
function usageState(): UsageState {
  const g = globalThis as unknown as Record<symbol, UsageState | undefined>;
  let state = g[STATE_KEY];
  if (!state) {
    state = { cache: new Map(), measuring: new Map(), openWrites: new Map() };
    g[STATE_KEY] = state;
  }
  return state;
}
const { cache, measuring, openWrites } = usageState();

/** Test seam: forget every measurement and open write. */
export function resetHomeUsageForTests(): void {
  cache.clear();
  measuring.clear();
  openWrites.clear();
}

function key(home: string): string {
  return path.resolve(home);
}

function writesOpen(k: string): boolean {
  return (openWrites.get(k)?.size ?? 0) > 0;
}

/**
 * Walk `dir` (a home, or a folder a move would bring into one) and add up
 * its regular files. Null when the folder itself cannot be opened (no such
 * folder, or this account may not list it); a folder inside it that cannot
 * be read is skipped.
 *
 * Links are never followed: an entry is descended into only when it was
 * listed as a folder AND an `lstat` of it just before it is opened still says
 * a real folder, so a folder swapped for a link between the listing and the
 * descent is skipped rather than walked.
 */
export async function measureHomeUsage(
  dir: string,
  { maxEntries = MAX_WALK_ENTRIES, budgetMs = WALK_BUDGET_MS }: { maxEntries?: number; budgetMs?: number } = {},
): Promise<HomeUsage | null> {
  const root = key(dir);
  const started = Date.now();
  const out: HomeUsage = { bytes: 0, truncated: false, measuredAt: started };
  const overBudget = () => Date.now() - started > budgetMs;
  let rootDir: fs.Dir;
  try {
    rootDir = await fs.promises.opendir(/* turbopackIgnore: true */ root, { bufferSize: STAT_BATCH });
  } catch {
    return null;
  }
  const queue: string[] = [];
  let visited = 0;

  /** Read one folder a batch at a time, stat its files, queue its folders. False: a bound was hit. */
  const walkOne = async (handle: fs.Dir, at: string): Promise<boolean> => {
    let files: string[] = [];
    const flush = async () => {
      const stats = await Promise.all(files.map((f) => fs.promises.lstat(/* turbopackIgnore: true */ f).catch(() => null)));
      for (const st of stats) if (st?.isFile()) out.bytes += st.size;
      files = [];
    };
    try {
      for await (const entry of handle) {
        if (++visited > maxEntries || (visited % STAT_BATCH === 0 && overBudget())) {
          await flush();
          return false;
        }
        const full = path.join(at, entry.name);
        if (entry.isDirectory()) queue.push(full);
        else if (entry.isFile()) {
          files.push(full);
          if (files.length >= STAT_BATCH) {
            await flush();
            if (overBudget()) return false;
          }
        }
      }
      await flush();
      return true;
    } catch {
      // A folder that went away or turned unreadable while being read: what
      // was counted of it stands.
      await flush();
      return true;
    } finally {
      // `for await` closes the handle when it runs to its end; an early
      // return leaves it open.
      await handle.close().catch(() => {});
    }
  };

  if (!(await walkOne(rootDir, root))) {
    out.truncated = true;
    return out;
  }
  while (queue.length) {
    if (overBudget()) {
      out.truncated = true;
      break;
    }
    const next = queue.pop()!;
    const st = await fs.promises.lstat(/* turbopackIgnore: true */ next).catch(() => null);
    if (!st?.isDirectory()) continue;
    const handle = await fs.promises.opendir(/* turbopackIgnore: true */ next, { bufferSize: STAT_BATCH }).catch(() => null);
    if (!handle) continue;
    if (!(await walkOne(handle, next))) {
      out.truncated = true;
      break;
    }
  }
  return out;
}

/**
 * The home's usage: the cached figure while it is fresh — and, whatever its
 * age, while any write into the home is open — else walked (one walk per home
 * at a time, whoever else is waiting for it). Null when it cannot be read.
 */
export async function homeUsage(home: string, { maxAgeMs = USAGE_CACHE_MS }: { maxAgeMs?: number } = {}): Promise<HomeUsage | null> {
  const k = key(home);
  const cached = cache.get(k);
  if (cached && (writesOpen(k) || (!cached.stale && Date.now() - cached.measuredAt < maxAgeMs))) return cached;
  const running = measuring.get(k);
  if (running) return running;
  const run = measureHomeUsage(k)
    .then((usage) => {
      if (usage) cache.set(k, usage);
      else cache.delete(k);
      return usage;
    })
    .finally(() => measuring.delete(k));
  measuring.set(k, run);
  return run;
}

/**
 * A write into the home changed what it holds by `deltaBytes` (negative for a
 * delete); with no delta the home is walked again — at once when no write
 * into it is open, else once the last open one has finished.
 */
export function noteHomeChange(home: string, deltaBytes?: number): void {
  const k = key(home);
  const cached = cache.get(k);
  if (!cached) return;
  if (deltaBytes === undefined || !Number.isFinite(deltaBytes)) {
    if (writesOpen(k)) cache.set(k, { ...cached, stale: true });
    else cache.delete(k);
    return;
  }
  cache.set(k, { ...cached, bytes: Math.max(0, cached.bytes + deltaBytes) });
}

/** One write's claim on a home's quota, from its first byte to its end. */
export interface QuotaWrite {
  /** Bytes the home held when the write began (a floor when `truncated`). */
  readonly usedBytes: number;
  readonly quotaBytes: number;
  /**
   * The home could not be measured whole: its figure is a floor, and a floor
   * grants no room — `ceiling` answers 0 and the write is refused.
   */
  readonly truncated: boolean;
  /**
   * The most this write may pass in total, given `passed` so far: the quota,
   * less what the home holds, less what the other writes into it have passed,
   * plus what it replaces (a file it overwrites gives its room back).
   */
  ceiling(passed: number): number;
  /** The write landed `addedBytes` (net of anything it replaced), or failed (0). */
  finish(addedBytes: number): void;
  /** The file it writes turned out to replace one of `bytes` (known once a multipart part names it). */
  replacing(bytes: number): void;
  /** Hold `bytes` against the quota until `finish` (a move, whose bytes arrive all at once). */
  reserve(bytes: number): void;
}

/**
 * Open a write into `home` under `quotaBytes`. Null when the home's usage
 * cannot be read at all — the caller decides (the Files route lets such a
 * write through: the folder it cannot read is not one it can be writing to
 * either).
 */
export async function openQuotaWrite(home: string, quotaBytes: number, replacingBytes = 0): Promise<QuotaWrite | null> {
  const usage = await homeUsage(home);
  if (!usage) return null;
  const k = key(home);
  const mine: OpenWrite = { passed: 0 };
  let set = openWrites.get(k);
  if (!set) {
    set = new Set();
    openWrites.set(k, set);
  }
  set.add(mine);
  let open = true;
  let replaced = Math.max(0, replacingBytes);
  const others = () => {
    let sum = 0;
    for (const w of openWrites.get(k) ?? []) if (w !== mine) sum += w.passed;
    return sum;
  };
  return {
    usedBytes: usage.bytes,
    quotaBytes,
    truncated: usage.truncated,
    ceiling(passed: number) {
      mine.passed = Math.max(mine.passed, passed);
      if (usage.truncated) return 0;
      // What the home holds NOW: a write that finished since this one began
      // has moved the cached figure and left `others()`.
      const held = cache.get(k)?.bytes ?? usage.bytes;
      return Math.max(0, quotaBytes - held - others() + replaced);
    },
    replacing(bytes: number) {
      replaced = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
    },
    reserve(bytes: number) {
      mine.passed = Math.max(mine.passed, Number.isFinite(bytes) ? bytes : 0);
    },
    finish(addedBytes: number) {
      if (!open) return;
      open = false;
      const writes = openWrites.get(k);
      writes?.delete(mine);
      if (writes && writes.size === 0) openWrites.delete(k);
      const cached = cache.get(k);
      if (cached && addedBytes) cache.set(k, { ...cached, bytes: Math.max(0, cached.bytes + addedBytes) });
      // The last open write is done: a walk asked for meanwhile can run now.
      const now = cache.get(k);
      if (now?.stale && !writesOpen(k)) cache.delete(k);
    },
  };
}

/** Is `abs` the home itself or inside it? Both resolved; no link is followed. */
export function insideHome(home: string, abs: string): boolean {
  const h = key(home);
  const a = path.resolve(abs);
  return a === h || a.startsWith(h + path.sep);
}
