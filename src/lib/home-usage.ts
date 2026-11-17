/**
 * How much a ClawBox user's home folder holds, and the writes that would take
 * it past its quota (TASK-2446, src/lib/user-limits.ts). SERVER ONLY.
 *
 * Usage is the APPARENT size of the regular files under the home — what the
 * Files app lists and what an upload adds — walked without following links,
 * so a link into `/` does not make a home the size of the disk. A walk is
 * bounded (MAX_WALK_ENTRIES, WALK_BUDGET_MS): past either the answer is a
 * FLOOR (`truncated`), which still enforces a quota the home is already far
 * past. Answers are cached per home for a minute and moved by the writes this
 * process makes, so an upload does not walk the whole home again.
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
/** lstat calls in flight at once during a walk. */
const STAT_BATCH = 64;

export interface HomeUsage {
  /** Bytes the regular files under the home hold. */
  bytes: number;
  /** True when the walk stopped early: `bytes` is a floor. */
  truncated: boolean;
  /** When it was measured (ms). */
  measuredAt: number;
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
  cache: Map<string, HomeUsage>;
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

/**
 * Walk `home` and add up its regular files. Null when the home itself cannot
 * be read (no such folder, or this account may not list it); a folder inside
 * it that cannot be read is skipped.
 */
export async function measureHomeUsage(
  home: string,
  { maxEntries = MAX_WALK_ENTRIES, budgetMs = WALK_BUDGET_MS }: { maxEntries?: number; budgetMs?: number } = {},
): Promise<HomeUsage | null> {
  const root = key(home);
  try {
    await fs.promises.readdir(/* turbopackIgnore: true */ root);
  } catch {
    return null;
  }
  const started = Date.now();
  const out: HomeUsage = { bytes: 0, truncated: false, measuredAt: started };
  const queue = [root];
  let visited = 0;
  while (queue.length) {
    if (Date.now() - started > budgetMs) {
      out.truncated = true;
      break;
    }
    const dir = queue.pop()!;
    const entries = await fs.promises.readdir(/* turbopackIgnore: true */ dir, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      if (++visited > maxEntries) {
        out.truncated = true;
        break;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile()) files.push(full);
    }
    for (let i = 0; i < files.length; i += STAT_BATCH) {
      const stats = await Promise.all(
        files.slice(i, i + STAT_BATCH).map((f) => fs.promises.lstat(/* turbopackIgnore: true */ f).catch(() => null)),
      );
      for (const st of stats) if (st?.isFile()) out.bytes += st.size;
    }
    if (out.truncated) break;
  }
  return out;
}

/**
 * The home's usage, from the cache when it is fresh, else walked (one walk per
 * home at a time, whoever else is waiting for it). Null when it cannot be read.
 */
export async function homeUsage(home: string, { maxAgeMs = USAGE_CACHE_MS }: { maxAgeMs?: number } = {}): Promise<HomeUsage | null> {
  const k = key(home);
  const cached = cache.get(k);
  if (cached && Date.now() - cached.measuredAt < maxAgeMs) return cached;
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
 * delete); with no delta the next read walks it again.
 */
export function noteHomeChange(home: string, deltaBytes?: number): void {
  const k = key(home);
  const cached = cache.get(k);
  if (!cached) return;
  if (deltaBytes === undefined || !Number.isFinite(deltaBytes)) {
    cache.delete(k);
    return;
  }
  cache.set(k, { ...cached, bytes: Math.max(0, cached.bytes + deltaBytes) });
}

/** One upload's claim on a home's quota, from its first byte to its end. */
export interface QuotaWrite {
  /** Bytes the home held when the write began (a floor when `truncated`). */
  readonly usedBytes: number;
  readonly quotaBytes: number;
  /**
   * The most this write may pass in total, given `passed` so far: the quota,
   * less what the home held, less what the other writes into it have passed,
   * plus `replacingBytes` (a file it overwrites gives its room back).
   */
  ceiling(passed: number): number;
  /** The write landed `addedBytes` (net of anything it replaced), or failed (0). */
  finish(addedBytes: number): void;
}

/**
 * Open a write into `home` under `quotaBytes`. Null when the home's usage
 * cannot be measured — the caller decides (the Files route lets such a write
 * through: the folder it cannot read is not one it can be writing to either).
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
  const others = () => {
    let sum = 0;
    for (const w of openWrites.get(k) ?? []) if (w !== mine) sum += w.passed;
    return sum;
  };
  return {
    usedBytes: usage.bytes,
    quotaBytes,
    ceiling(passed: number) {
      mine.passed = passed;
      // What the home holds NOW: a write that finished since this one began
      // has moved the cached figure and left `others()`.
      const held = cache.get(k)?.bytes ?? usage.bytes;
      return Math.max(0, quotaBytes - held - others() + Math.max(0, replacingBytes));
    },
    finish(addedBytes: number) {
      if (!open) return;
      open = false;
      openWrites.get(k)?.delete(mine);
      if (openWrites.get(k)?.size === 0) openWrites.delete(k);
      if (addedBytes) noteHomeChange(k, addedBytes);
    },
  };
}

/** Is `abs` the home itself or inside it? Both resolved; no link is followed. */
export function insideHome(home: string, abs: string): boolean {
  const h = key(home);
  const a = path.resolve(abs);
  return a === h || a.startsWith(h + path.sep);
}
