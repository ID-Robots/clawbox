import fs from "fs";
import os from "os";
import { DISK_FREE_RESERVE_BYTES } from "./disk-reserve";
import path from "./runtime-path";

/**
 * Whether a background task may start NOW, beside the work already running
 * (src/lib/background-tasks.ts) — or has to wait its turn.
 *
 * WHY. Every install on Settings → Local AI is a background task, and each
 * kept its own "one at a time" flag, so a second Install pressed while another
 * engine was installing could only be refused, or — where nothing refused —
 * run on top of it: two root steps pip-installing into the same user site, a
 * CUDA build beside a PyTorch install on an 8 GB Orin Nano, two writers of the
 * agent's config. The owner wants to press Install on several rows and walk
 * away. So every press is accepted; this decides which of them start at once
 * and which wait, and the registry starts the waiting ones as the running ones
 * end.
 *
 * Two rules, in this order:
 *
 *  1. LANES. A task names what it holds while it runs — the user site and the
 *     agent's config for the engine installs, the Hugging Face cache Whisper
 *     reads for its downloads. Two tasks that share a lane never run together:
 *     the later one waits behind the one running, or behind the one queued
 *     ahead of it in that lane, so a lane keeps the order the owner pressed in.
 *  2. ROOM. A task that shares no lane may still not fit: it names the memory
 *     and the disk it needs, and it starts beside running work only when the
 *     box has that much left after what the running work said IT needs. With
 *     nothing running it always starts — its own checks then speak for the
 *     disk, in the words the row already shows — so the queue can never wait
 *     on itself.
 *
 * Pure apart from {@link systemQueueMeasure}: the registry hands in what is
 * running and queued, and a measure the tests replace.
 */

export interface BackgroundTaskNeeds {
  /** Memory the work uses at its peak (a build, a model loading), in bytes. */
  memoryBytes: number;
  /** Disk the work writes, in bytes, on the filesystem of `diskPath`. */
  diskBytes: number;
  /** Where it writes; its nearest existing ancestor is measured. Null: not measured. */
  diskPath: string | null;
}

/** What the decision reads off a task. */
export interface QueueSubject {
  id: string;
  lanes: readonly string[];
  needs: BackgroundTaskNeeds | null;
}

export interface QueueMeasure {
  /** What the kernel could hand out now (MemAvailable), or null when it would not say. */
  availableMemory(): number | null;
  /** Free bytes for this user on the filesystem `dir` lands on, or null when it would not say. */
  freeDisk(dir: string): number | null;
}

export type QueueDecision<T> =
  | { start: true }
  | { start: false; behind: T; reason: "lane" | "memory" | "disk" };

function sharesLane(a: QueueSubject, b: QueueSubject): boolean {
  return a.lanes.some((lane) => b.lanes.includes(lane));
}

/**
 * The running task whose ending gives back the most of what `pick` measures —
 * the one worth waiting for. Ties go to the one that started first (`running`
 * is in start order).
 */
function largest<T extends QueueSubject>(running: readonly T[], pick: (needs: BackgroundTaskNeeds) => number): T {
  let best = running[0];
  let bestValue = best.needs ? pick(best.needs) : 0;
  for (const task of running.slice(1)) {
    const value = task.needs ? pick(task.needs) : 0;
    if (value > bestValue) {
      best = task;
      bestValue = value;
    }
  }
  return best;
}

/**
 * May `candidate` start beside `running`? `ahead` is what is queued before it,
 * in queue order. A figure the measure could not read never holds a task back:
 * a box that cannot say how much memory it has must not stop installing.
 */
export function decideQueue<T extends QueueSubject>(
  candidate: T,
  running: readonly T[],
  ahead: readonly T[],
  measure: QueueMeasure,
): QueueDecision<T> {
  // The nearest one queued ahead in a shared lane first: that is the task this
  // one really starts after, and the one its "starts after …" should name.
  for (const task of [...ahead].reverse()) {
    if (sharesLane(candidate, task)) return { start: false, behind: task, reason: "lane" };
  }
  for (const task of running) {
    if (sharesLane(candidate, task)) return { start: false, behind: task, reason: "lane" };
  }
  const needs = candidate.needs;
  if (running.length === 0 || !needs) return { start: true };

  if (needs.memoryBytes > 0) {
    const available = measure.availableMemory();
    const promised = running.reduce((sum, task) => sum + (task.needs?.memoryBytes ?? 0), 0);
    if (available !== null && available - promised < needs.memoryBytes) {
      return { start: false, behind: largest(running, (n) => n.memoryBytes), reason: "memory" };
    }
  }
  if (needs.diskBytes > 0 && needs.diskPath) {
    const free = measure.freeDisk(needs.diskPath);
    const promised = running.reduce((sum, task) => sum + (task.needs?.diskBytes ?? 0), 0);
    if (free !== null && free - DISK_FREE_RESERVE_BYTES - promised < needs.diskBytes) {
      return { start: false, behind: largest(running, (n) => n.diskBytes), reason: "disk" };
    }
  }
  return { start: true };
}

/** MemAvailable from /proc/meminfo; `os.freemem()` where there is none. */
function availableMemory(): number | null {
  try {
    const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(fs.readFileSync("/proc/meminfo", "utf-8"));
    if (match) return Number(match[1]) * 1024;
  } catch {
    /* not Linux, or no procfs: the portable figure below */
  }
  try {
    return os.freemem();
  } catch {
    return null;
  }
}

/**
 * Free bytes on the filesystem a not-yet-created directory will land on: its
 * nearest existing ancestor's, the rule src/lib/install-disk.ts measures by.
 * Synchronous, because the registry decides with nothing awaited between the
 * decision and the start.
 */
function freeDisk(dir: string): number | null {
  let current = path.resolve(dir);
  for (;;) {
    try {
      const stat = fs.statfsSync(current);
      return Number(stat.bavail) * Number(stat.bsize);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

export const systemQueueMeasure: QueueMeasure = { availableMemory, freeDisk };
