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
 *
 * ONE COMMIT AT A TIME PER HOME (TASK-2663). What a write is measured against
 * while its bytes arrive can go stale before it lands: another upload of the
 * same name may land first and change what the rename replaces, or a move may
 * add to the home. So every write that lands bytes in a limited home — an
 * upload's rename into place, a move into it — does its last check and its
 * landing under `withHomeLock`, against the figure as it is then
 * (`QuotaWrite.admits`), and moves the figure before the lock is let go.
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
  /** The temporary file it writes its bytes into (src/lib/upload-temp.ts), once known. */
  temp: string | null;
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
  /** Per home, how often it was asked to be walked again (a delete, a move). */
  changes: Map<string, number>;
  /** Per home, writes reading the figure they open on, not registered yet. */
  opening: Map<string, number>;
}
const STATE_KEY = Symbol.for("clawbox.homeUsage");
function usageState(): UsageState {
  const g = globalThis as unknown as Record<symbol, UsageState | undefined>;
  let state = g[STATE_KEY];
  if (!state) {
    state = { cache: new Map(), measuring: new Map(), openWrites: new Map(), changes: new Map(), opening: new Map() };
    g[STATE_KEY] = state;
  }
  return state;
}
const { cache, measuring, openWrites, changes, opening } = usageState();

/** Test seam: forget every measurement and open write (and any lock a test left held). */
export function resetHomeUsageForTests(): void {
  cache.clear();
  measuring.clear();
  openWrites.clear();
  changes.clear();
  opening.clear();
  homeLocks().clear();
}

function key(home: string): string {
  return path.resolve(home);
}

function writesOpen(k: string): boolean {
  return (openWrites.get(k)?.size ?? 0) > 0;
}

/**
 * Must a figure marked stale be kept rather than dropped? While a write is
 * open — and while one is reading the figure it will open on: dropped in that
 * gap, it would open on what it read, without what landed meanwhile.
 */
function figureHeld(k: string): boolean {
  return writesOpen(k) || (opening.get(k) ?? 0) > 0;
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
  {
    maxEntries = MAX_WALK_ENTRIES,
    budgetMs = WALK_BUDGET_MS,
    skip,
  }: {
    maxEntries?: number;
    budgetMs?: number;
    /** A file (by its resolved path) the walk leaves out: an open write's temporary file. */
    skip?: (file: string) => boolean;
  } = {},
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
        else if (entry.isFile() && !skip?.(full)) {
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
  const asked = changes.get(k) ?? 0;
  const run = measureHomeUsage(k)
    .then((usage) => {
      // A write that opened on the cached figure while this walk ran may have
      // put bytes on disk the walk counted and its `finish` will add: while
      // any write is open, the figure it opened on stands.
      if (writesOpen(k) && cache.has(k)) return usage;
      // A delete or a move that asked for a walk while this one ran may or
      // may not be in it: kept, but marked, so it is walked again.
      if (usage) cache.set(k, (changes.get(k) ?? 0) !== asked ? { ...usage, stale: true } : usage);
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
  const remeasure = deltaBytes === undefined || !Number.isFinite(deltaBytes);
  // Counted even with no figure yet: a walk running now must not be trusted.
  if (remeasure) changes.set(k, (changes.get(k) ?? 0) + 1);
  const cached = cache.get(k);
  if (!cached) return;
  if (remeasure) {
    if (figureHeld(k)) cache.set(k, { ...cached, stale: true });
    else cache.delete(k);
    return;
  }
  cache.set(k, { ...cached, bytes: Math.max(0, cached.bytes + deltaBytes) });
}

// ── One commit at a time per home ────────────────────────────────────────────
//
// On `globalThis` like the figure itself: the Files routes' bundles, the
// sign-in and the limits routes all run in the one server process, and each
// must queue behind the same lock for a given home.

const LOCKS_KEY = Symbol.for("clawbox.homeUsage.locks");
function homeLocks(): Map<string, Promise<void>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Promise<void>> | undefined>;
  let locks = g[LOCKS_KEY];
  if (!locks) {
    locks = new Map();
    g[LOCKS_KEY] = locks;
  }
  return locks;
}

/**
 * Run `task` holding `home`'s lock: the tasks given for one home run one after
 * another, in the order they asked, whatever each awaits. The quota's last
 * check and the landing it admits go in one task, so no other write lands in
 * the home between them. A task that throws lets the next one run all the same.
 */
export async function withHomeLock<T>(home: string, task: () => T | Promise<T>): Promise<T> {
  const k = key(home);
  const locks = homeLocks();
  const before = locks.get(k) ?? Promise.resolve();
  let release: () => void = () => {};
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Never rejects: `before` is an earlier task's `mine`, which only resolves.
  const tail = before.then(() => mine);
  locks.set(k, tail);
  await before;
  try {
    return await task();
  } finally {
    release();
    if (locks.get(k) === tail) locks.delete(k);
  }
}

/** One write's claim on a home's quota, from its first byte to its end. */
export interface QuotaWrite {
  /**
   * Bytes the home holds now, by this process's figure: what it held when the
   * write began, moved by every write that has landed since (a floor when
   * `truncated`).
   */
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
  /**
   * May the write land `landedBytes` in place of a file of `replacedBytes`
   * NOW? Asked under the home's lock (`withHomeLock`) right before the
   * landing, with nothing awaited in between: against what the home holds at
   * this moment, what the other open writes have passed, and the size the
   * landing really replaces — never the credit the write began with, which
   * another write of the same name may have made stale.
   */
  admits(landedBytes: number, replacedBytes: number): boolean;
  /**
   * The write puts its bytes in the temporary file `tempPath` until it lands
   * (src/lib/upload-temp.ts): a walk of the home made while it is open leaves
   * that file out — its bytes are counted once, when the write lands.
   */
  staging(tempPath: string): void;
  /**
   * Before the last check, under the home's lock: a figure that was only
   * marked stale (a delete or a move while writes were open) is walked again
   * now, leaving out the open writes' temporary files, so `admits` answers by
   * what the home really holds — not by bytes already deleted. A walk that
   * fails or stops short keeps the figure as it was.
   */
  settle(): Promise<void>;
  /** The write landed `addedBytes` (net of anything it replaced), or failed (0). */
  finish(addedBytes: number): void;
  /** The file it writes turned out to replace one of `bytes` (known once a multipart part names it). */
  replacing(bytes: number): void;
}

/**
 * Open a write into `home` under `quotaBytes`. Null when the home's usage
 * cannot be read at all — the caller decides (the Files route lets such a
 * write through: the folder it cannot read is not one it can be writing to
 * either).
 */
export async function openQuotaWrite(home: string, quotaBytes: number, replacingBytes = 0): Promise<QuotaWrite | null> {
  const k = key(home);
  opening.set(k, (opening.get(k) ?? 0) + 1);
  let read: HomeUsage | null;
  try {
    read = await homeUsage(home);
  } finally {
    const n = (opening.get(k) ?? 1) - 1;
    if (n > 0) opening.set(k, n);
    else opening.delete(k);
  }
  if (!read) return null;
  // Registered with nothing awaited since the figure was read.
  const usage = read;
  const mine: OpenWrite = { passed: 0, temp: null };
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
  // What the home holds NOW: a write that finished since this one began has
  // moved the cached figure and left `others()`.
  const held = () => cache.get(k)?.bytes ?? usage.bytes;
  const room = (replacedBytes: number) => (usage.truncated ? 0 : Math.max(0, quotaBytes - held() - others() + replacedBytes));
  return {
    get usedBytes() {
      return held();
    },
    quotaBytes,
    truncated: usage.truncated,
    ceiling(passed: number) {
      mine.passed = Math.max(mine.passed, passed);
      return room(replaced);
    },
    admits(landedBytes: number, replacedBytes: number) {
      const landing = Number.isFinite(landedBytes) ? Math.max(0, landedBytes) : Infinity;
      return landing <= room(Number.isFinite(replacedBytes) ? Math.max(0, replacedBytes) : 0);
    },
    replacing(bytes: number) {
      replaced = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
    },
    staging(tempPath: string) {
      mine.temp = path.resolve(tempPath);
    },
    async settle() {
      if (!open || !cache.get(k)?.stale) return;
      const asked = changes.get(k) ?? 0;
      // Asked file by file as the walk goes: a write that opens its temporary
      // file while the home is walked is left out as well.
      const openTemp = (file: string) => {
        for (const w of openWrites.get(k) ?? []) if (w.temp === file) return true;
        return false;
      };
      const fresh = await measureHomeUsage(k, { skip: openTemp });
      const now = cache.get(k);
      if (!now) return;
      // A delete or a move that asked for a walk while this one ran may or
      // may not be in it: the figure stays marked, and the next check walks.
      const askedAgain = (changes.get(k) ?? 0) !== asked;
      if (!fresh || fresh.truncated) {
        // Not measurable whole now: the figure stands — it holds every write
        // this process landed and no delete, so it errs high — and is not
        // walked again at every check; it is walked once it is old.
        if (!askedAgain) cache.set(k, { ...now, stale: false });
        return;
      }
      cache.set(k, { bytes: fresh.bytes, truncated: false, measuredAt: fresh.measuredAt, ...(askedAgain ? { stale: true } : {}) });
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
      if (now?.stale && !figureHeld(k)) cache.delete(k);
    },
  };
}

/** Is `abs` the home itself or inside it? Both resolved; no link is followed. */
export function insideHome(home: string, abs: string): boolean {
  const h = key(home);
  const a = path.resolve(abs);
  return a === h || a.startsWith(h + path.sep);
}
