import fs from "fs";
import os from "os";

/**
 * CPU utilisation from /proc/stat, WITHOUT a per-request sleep.
 *
 * The old `getCpuUsage()` in the stats route read /proc/stat, slept 200 ms, read
 * it again and diffed. That put a hard ~209 ms floor under every
 * `/setup-api/system/stats` response (measured on the box: 5 authenticated
 * requests, 208-211 ms, of which ~8-11 ms was the actual work) for an endpoint
 * that the System app and Settings > System poll every 3 s.
 *
 * The delta does not need a sleep — it needs two samples. Keep the last sample
 * in module scope and diff the current read against it, so the figure is a real
 * average over the caller's own poll interval (3 s) instead of an artificial
 * 200 ms window. First call after boot has nothing to diff against and falls
 * back to the load-average approximation, exactly as the old code did when
 * /proc/stat was unreadable.
 */

export interface CpuSample {
  idle: number;
  total: number;
  /** Date.now() at read time — only used to detect a stale sample. */
  at: number;
}

/**
 * A sample older than this is not diffed. Nothing polls that slowly in normal
 * operation, so an older sample means the endpoint was idle for a long time and
 * the resulting figure would be an average over minutes, presented as "now".
 */
const MAX_SAMPLE_AGE_MS = 60_000;

let lastSample: CpuSample | null = null;
let lastUsage: number | null = null;
let lastCoreSamples: CoreSample[] = [];
let lastCoreUsage: number[] | null = null;
/** When `lastCoreUsage` was measured — a carried row ages out like a sample. */
let lastCoreUsageAt = 0;

/** One `cpu…` line of /proc/stat as a sample, or null if it is not one. */
function sampleFromLine(line: string | undefined, now: number): CpuSample | null {
  if (!line || !line.startsWith("cpu")) return null;
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  // idle is field 4 (user nice system idle ...). Anything shorter is not
  // /proc/stat and must not be treated as a zero-idle 100%-busy CPU.
  if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const idle = parts[3];
  const total = parts.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  return { idle, total, at: now };
}

/** Parse the aggregate `cpu` line of /proc/stat. Returns null if unusable. */
export function parseProcStat(raw: string, now: number): CpuSample | null {
  return sampleFromLine(raw.split("\n")[0], now);
}

/** One `cpuN` line of /proc/stat: which core it is, and its sample. */
export interface CoreSample {
  /**
   * The `N` of `cpuN`.
   *
   * Kept rather than implied by the position, because Linux prints a line per
   * ONLINE cpu: offline a middle core and every line after it shifts up, so two
   * readings of the same LENGTH can still be about different cores.
   */
  id: number;
  /** null where the line could not be read as a sample. */
  sample: CpuSample | null;
}

/**
 * The PER-CORE lines, `cpu0`…`cpuN`, in the order the file lists them.
 *
 * The same file and the same arithmetic as the aggregate above — /proc/stat
 * carries both, so a per-core reading costs no extra read and no extra sleep.
 * A core whose line is unusable has a `null` sample rather than 0: on a
 * six-core Orin the difference between "this core is idle" and "this core could
 * not be read" is the difference between a reassuring picture and a wrong one.
 */
export function parseProcStatCores(raw: string, now: number): CoreSample[] {
  const out: CoreSample[] = [];
  for (const line of raw.split("\n")) {
    const cpu = /^cpu(\d+)\s/.exec(line);
    if (!cpu) continue;
    out.push({ id: Number(cpu[1]), sample: sampleFromLine(line, now) });
  }
  return out;
}

function loadAverageApproximation(): number {
  const cpuCount = os.cpus().length || 1;
  return Math.min(100, Math.max(0, Math.round((os.loadavg()[0] / cpuCount) * 100)));
}

/**
 * Percent busy since the previous call. Never sleeps, never blocks.
 *
 * Returns the load-average approximation on the first call, when /proc/stat is
 * unreadable, or when the previous sample is stale; returns the previously
 * computed value when two calls land inside the same jiffy (dTotal === 0), which
 * is what a double-click on Refresh looks like.
 */
export function getCpuUsage(now: number = Date.now()): number {
  let current: CpuSample | null = null;
  try {
    current = parseProcStat(fs.readFileSync("/proc/stat", "utf-8"), now);
  } catch {
    current = null;
  }

  if (!current) return lastUsage ?? loadAverageApproximation();

  const previous = lastSample;
  lastSample = current;

  if (!previous || now - previous.at > MAX_SAMPLE_AGE_MS) {
    // Nothing (usable) to diff against yet. The NEXT call gets a real figure.
    return lastUsage ?? loadAverageApproximation();
  }

  const dTotal = current.total - previous.total;
  const dIdle = current.idle - previous.idle;
  // A counter that went backwards means /proc/stat was re-read across a
  // suspend/rollover; treat it like "no usable previous sample".
  if (dTotal <= 0 || dIdle < 0) return lastUsage ?? loadAverageApproximation();

  const usage = Math.min(100, Math.max(0, Math.round(((dTotal - dIdle) / dTotal) * 100)));
  lastUsage = usage;
  return usage;
}

/**
 * Is a sample — or a row already published — recent enough to describe "now"?
 *
 * A NEGATIVE age is not "very recent": it means the wall clock moved backwards
 * under us, which a box with no RTC does every boot once NTP answers. The age
 * is then not a fact, so the window cannot be claimed to be a short one. The
 * per-core row is the half of this module that can fabricate a reading, so it is
 * the half held to an age it can trust; the aggregate's fallback is the load
 * average, a real figure whichever way the clock jumped.
 */
function isRecent(now: number, at: number): boolean {
  const age = now - at;
  return age >= 0 && age <= MAX_SAMPLE_AGE_MS;
}

/**
 * The row published last time, where it is still recent enough to stand in for
 * a measurement of "now" — held to the same window as the samples themselves,
 * because figures from five minutes ago under a fresh timestamp are the same
 * wrong claim as a zero.
 */
function carriedCoreUsage(now: number): number[] {
  if (!lastCoreUsage) return [];
  if (!isRecent(now, lastCoreUsageAt)) {
    // Forgotten, not merely withheld: a row this call refused as too old must
    // not become eligible again when the clock next steps backwards.
    lastCoreUsage = null;
    return [];
  }
  return lastCoreUsage;
}

/** Percent busy of one core between two of its samples, or null if they do not diff. */
function coreBusy(then: CpuSample, current: CpuSample): number | null {
  const dTotal = current.total - then.total;
  const dIdle = current.idle - then.idle;
  // A counter that went backwards means /proc/stat was re-read across a
  // suspend/rollover — not that the core went idle.
  if (dTotal <= 0 || dIdle < 0) return null;
  return Math.min(100, Math.max(0, Math.round(((dTotal - dIdle) / dTotal) * 100)));
}

/**
 * Percent busy per core since the previous call, one entry per `cpuN` line.
 *
 * The htop-style bars on Settings → System. Same delta discipline as the
 * aggregate: no sleep, no block, and a call with nothing to diff (a stale
 * previous sample, or a counter that went backwards over a suspend) answers the
 * last figures it had rather than a fabricated zero — a row of empty bars is a
 * claim about the box, and "not measured yet" is not that claim.
 *
 * Empty where there is no figure to give: /proc/stat unreadable, or — the first
 * call of the process, which every server restart creates — no previous sample
 * and no recent figures to stand in for it. Empty for the WHOLE row, never a
 * row that is measured for some cores and carried for others, and never a row
 * carried across a change in which cores are online (a hotplug, or an nvpmodel
 * mode that offlines some): a six-entry row reads as six measurements of these
 * six cores. The caller renders empty as no per-core row at all, and the next
 * poll 3 s later has real figures.
 */
export function getCpuCoreUsage(now: number = Date.now()): number[] {
  let current: CoreSample[];
  try {
    current = parseProcStatCores(fs.readFileSync("/proc/stat", "utf-8"), now);
  } catch {
    return carriedCoreUsage(now);
  }
  if (current.length === 0) return carriedCoreUsage(now);

  const previous = lastCoreSamples;
  // Set before any early return: whatever this call could not answer, the next
  // one has a sample to diff against.
  lastCoreSamples = current;
  // Comparable means "about the same cores", by id — a first call has nothing to
  // diff against, and so does a reading of a different set of cores, even one
  // that happens to be the same size (offline cpu1 while cpu2 comes back and
  // the count is unchanged while every position has moved).
  const comparable =
    previous.length === current.length && previous.every((core, i) => core.id === current[i].id);

  const measured = current.map((core, i) => {
    const then = comparable ? previous[i].sample : null;
    return core.sample && then && isRecent(now, then.at) ? coreBusy(then, core.sample) : null;
  });
  if (measured.every((busy): busy is number => busy !== null)) {
    lastCoreUsage = measured;
    lastCoreUsageAt = now;
    return measured;
  }

  // Not every core was measured. The row published last time stands in only
  // when it is the whole answer — nothing measured now, the same cores as then,
  // and recent — which is the suspend/rollover case the aggregate handles the
  // same way. A part-measured row, or one from a different core count, is not
  // about these cores: it is withheld whole, and forgotten so a later call
  // cannot index it.
  const carried = carriedCoreUsage(now);
  if (measured.some((busy) => busy !== null) || !comparable || carried.length !== current.length) {
    lastCoreUsage = null;
    return [];
  }
  return carried;
}

/** Test seam — drops the cached sample so each test starts cold. */
export function __resetCpuUsageCache(): void {
  lastSample = null;
  lastUsage = null;
  lastCoreSamples = [];
  lastCoreUsage = null;
  lastCoreUsageAt = 0;
}
