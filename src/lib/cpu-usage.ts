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
let lastCoreSamples: (CpuSample | null)[] = [];
let lastCoreUsage: number[] | null = null;

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

/**
 * The PER-CORE lines, `cpu0`…`cpuN`, in order.
 *
 * The same file and the same arithmetic as the aggregate above — /proc/stat
 * carries both, so a per-core reading costs no extra read and no extra sleep.
 * A core whose line is unusable is `null` rather than 0: on a six-core Orin the
 * difference between "this core is idle" and "this core could not be read" is
 * the difference between a reassuring picture and a wrong one.
 */
export function parseProcStatCores(raw: string, now: number): (CpuSample | null)[] {
  const out: (CpuSample | null)[] = [];
  for (const line of raw.split("\n")) {
    if (!/^cpu\d+\s/.test(line)) continue;
    out.push(sampleFromLine(line, now));
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
 * Percent busy per core since the previous call, one entry per `cpuN` line.
 *
 * The htop-style bars on Settings → System. Same delta discipline as the
 * aggregate: no sleep, no block, and a first call (or a stale previous sample,
 * or a counter that went backwards over a suspend) answers the last figures it
 * had rather than a fabricated zero — a row of empty bars is a claim about the
 * box, and "not measured yet" is not that claim.
 *
 * Empty when /proc/stat cannot be read at all, which the caller renders as no
 * per-core row rather than as a machine with no cores.
 */
export function getCpuCoreUsage(now: number = Date.now()): number[] {
  let current: (CpuSample | null)[];
  try {
    current = parseProcStatCores(fs.readFileSync("/proc/stat", "utf-8"), now);
  } catch {
    return lastCoreUsage ?? [];
  }
  if (current.length === 0) return lastCoreUsage ?? [];

  const previous = lastCoreSamples;
  lastCoreSamples = current;
  // A core count that changed (a hotplug, or a first call) has nothing to diff
  // against; so does a sample too old to be about "now".
  const comparable = previous.length === current.length;

  const usage: number[] = [];
  for (let i = 0; i < current.length; i += 1) {
    const now_ = current[i];
    const then = comparable ? previous[i] : null;
    if (!now_ || !then || now - then.at > MAX_SAMPLE_AGE_MS) {
      usage.push(lastCoreUsage?.[i] ?? 0);
      continue;
    }
    const dTotal = now_.total - then.total;
    const dIdle = now_.idle - then.idle;
    if (dTotal <= 0 || dIdle < 0) {
      usage.push(lastCoreUsage?.[i] ?? 0);
      continue;
    }
    usage.push(Math.min(100, Math.max(0, Math.round(((dTotal - dIdle) / dTotal) * 100))));
  }
  lastCoreUsage = usage;
  return usage;
}

/** Test seam — drops the cached sample so each test starts cold. */
export function __resetCpuUsageCache(): void {
  lastSample = null;
  lastUsage = null;
  lastCoreSamples = [];
  lastCoreUsage = null;
}
