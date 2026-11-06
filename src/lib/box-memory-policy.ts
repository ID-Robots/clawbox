/**
 * How much memory a unit on THIS box may use, derived from the RAM it has.
 *
 * WHY NOT LITERALS. The box ships on boards whose memory differs by an order of
 * magnitude — an Orin Nano at 8 GB, an x64 laptop at 16 GB, a DGX Spark at
 * 128 GB — and a cap written for one is either a no-op on the large boxes or an
 * OOM kill on the small one. Every number below is a SHARE of the total, with a
 * floor so a small board still has room to work and a ceiling so a large one
 * still gets the failure mode the cap exists for: the runaway process dies,
 * not the desktop.
 *
 * An operator can pin a size per class with `CLAWBOX_RUN_MEMORY_MAX`,
 * `CLAWBOX_RUN_MEMORY_HIGH`, `CLAWBOX_APP_MEMORY_MAX` or
 * `CLAWBOX_APP_MEMORY_HIGH`, as a systemd size (`4G`, `1536M`, `512M`). A value
 * that does not parse, or a high above its max, is ignored rather than trusted:
 * a typo must not remove the cap.
 */
import os from "os";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** A cap pair, as bytes and in the form systemd's `MemoryHigh=`/`MemoryMax=` take. */
export interface MemoryLimits {
  highBytes: number;
  maxBytes: number;
  high: string;
  max: string;
}

/**
 * A share of a run's cap at which the kernel starts reclaiming hard. The run
 * slows down but survives; `max` is the wall.
 */
const RUN_MAX_SHARE = 1 / 4;
const RUN_MIN_MAX = 3 * GIB;
const RUN_MAX_MAX = 16 * GIB;

/**
 * Apps are the leakiest thing on the box — a framework dev server plus a
 * watcher plus whatever the run embedded answer to nobody — so their share is
 * smaller and reclaim starts earlier than for a coding run the owner started
 * on purpose.
 */
const APP_MAX_SHARE = 1 / 8;
const APP_MIN_MAX = 768 * MIB;
const APP_MAX_MAX = 6 * GIB;
const APP_HIGH_SHARE = 0.375;
/** No app is throttled below this, whatever the board's share works out to. */
const APP_HIGH_MIN = 512 * MIB;

/** Where `high` sits under `max` for both classes, once the floors are met. */
const HIGH_SHARE = 0.75;
/** The same floor for a coding run: a cap below this throttles the harness itself. */
const RUN_HIGH_MIN = 1 * GIB;

/** A systemd size string for a byte count, in MiB granularity. */
export function systemdSize(bytes: number): string {
  const mib = Math.max(1, Math.round(bytes / MIB));
  return mib % 1024 === 0 ? `${mib / 1024}G` : `${mib}M`;
}

/** `4G`, `1536M`, `512M` → bytes. Null for anything else, including `0`. */
export function parseSystemdSize(raw: string | undefined): number | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{1,6})([KMG])$/.exec(raw.trim().toUpperCase());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] === "G" ? GIB : m[2] === "M" ? MIB : 1024;
  return n * unit;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function limits(highBytes: number, maxBytes: number): MemoryLimits {
  const maxMib = Math.max(1, Math.round(maxBytes / MIB));
  const highMib = Math.min(maxMib, Math.max(1, Math.round(highBytes / MIB)));
  const max = maxMib * MIB;
  const high = highMib * MIB;
  return { highBytes: high, maxBytes: max, high: systemdSize(high), max: systemdSize(max) };
}

/** The cap one coding run gets. */
export function runMemoryLimits(
  totalMemBytes: number = os.totalmem(),
  env: Record<string, string | undefined> = process.env,
): MemoryLimits {
  const derived = clamp(totalMemBytes * RUN_MAX_SHARE, RUN_MIN_MAX, RUN_MAX_MAX);
  const max = parseSystemdSize(env.CLAWBOX_RUN_MEMORY_MAX) ?? derived;
  const high = parseSystemdSize(env.CLAWBOX_RUN_MEMORY_HIGH) ?? Math.max(RUN_HIGH_MIN, max * HIGH_SHARE);
  return limits(high > max ? max * HIGH_SHARE : high, max);
}

/** The cap one agent-built app server gets. */
export function appMemoryLimits(
  totalMemBytes: number = os.totalmem(),
  env: Record<string, string | undefined> = process.env,
): MemoryLimits {
  const derived = clamp(totalMemBytes * APP_MAX_SHARE, APP_MIN_MAX, APP_MAX_MAX);
  const max = parseSystemdSize(env.CLAWBOX_APP_MEMORY_MAX) ?? derived;
  const high = parseSystemdSize(env.CLAWBOX_APP_MEMORY_HIGH) ?? Math.max(APP_HIGH_MIN, max * APP_HIGH_SHARE);
  return limits(high > max ? max * HIGH_SHARE : high, max);
}
