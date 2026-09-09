import fs from "fs";
import { get, set, setMany } from "./config-store";

/**
 * "An update owns this box right now" — persisted, so a surface that is NOT the
 * updater's own process can read it.
 *
 * `updateInFlight()` in updater.ts already answers this question, and answers it
 * better: it also knows about a run that has rebooted the box and is waiting for
 * its second half. But it reads module-level state in the process that is
 * running the update, and the middleware is not that reader — it reads
 * data/config.json off the disk with `fs` (it already does, for setup_complete),
 * because it must answer before any route handler is entered.
 *
 * So this is the disk half of the same fact, and the two are kept in step at the
 * four points where a run starts and the one where it ends.
 *
 * It deliberately OUTLIVES the reboot the update performs. The web server is
 * killed mid-run by do_rebuild and the flag is still set when the box comes
 * back, which is correct: post_update, gateway_verify and verify_build_identity
 * are still to come, and the desktop must stay locked through them. What clears
 * it is the run FINISHING — or, if the box came back with nothing to resume,
 * the boot-time continuation check, so a crashed update cannot lock the desktop
 * for ever.
 */
export const UPDATE_LOCK_KEY = "update_in_progress";

/**
 * WHO holds the lock, so a second process can tell a running update from a dead
 * one.
 *
 * The flag alone says "an update owns this box", and a web server that starts
 * WHILE one is running reads exactly what a web server that starts after a
 * crashed one reads. The updater's continuation check treated both as the
 * crash: it released the lock and stamped `update_interrupted_at`, so a run
 * whose last two steps were still landing in the old process was reported
 * `failed` with every step pending — on a box whose journal shows every step
 * completing and BUILD IDENTITY OK (observed on the OpenClaw box, 2026-09-07).
 * A false failure over an update that worked.
 *
 * The pid is meaningless on its own — pids are reused, and this flag
 * deliberately outlives the reboot the update performs — so the BOOT ID is
 * recorded with it. A record from another boot proves nothing and is ignored,
 * which is exactly today's behaviour.
 */
export const UPDATE_LOCK_HOLDER_KEY = "update_lock_holder";

interface UpdateLockHolder {
  pid: number;
  /** `/proc/sys/kernel/random/boot_id`, or null where it cannot be read. */
  bootId: string | null;
  /**
   * Field 22 of `/proc/<pid>/stat` — when the process started, in clock ticks
   * since boot. A pid is not an identity: the kernel wraps `pid_max` and an
   * update spawns thousands of processes through install.sh, so on a long
   * uptime a later, unrelated process can land on the dead holder's pid. Then
   * `kill(pid, 0)` succeeds, the lock is never released and the owner is
   * redirected to /updating until the box reboots — strictly worse than the
   * behaviour this record exists to improve. (pid, start time) is unique within
   * a boot, and the boot id makes it unique across them.
   */
  startedTicks: string | null;
  /**
   * When this record was written. `setUpdateLock` is called at EVERY step
   * boundary, so it is a heartbeat: a lock whose `at` is younger than the
   * longest step's budget belongs to a run that is still moving, whichever
   * process is moving it.
   */
  at: string;
}

function currentBootId(): string | null {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim() || null;
  } catch {
    return null;
  }
}

function parseHolder(value: unknown): UpdateLockHolder | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { pid?: unknown; bootId?: unknown; startedTicks?: unknown; at?: unknown };
  if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid <= 0) return null;
  return {
    pid: raw.pid,
    bootId: typeof raw.bootId === "string" ? raw.bootId : null,
    startedTicks: typeof raw.startedTicks === "string" ? raw.startedTicks : null,
    at: typeof raw.at === "string" ? raw.at : "",
  };
}

/**
 * When a process started, from `/proc/<pid>/stat` field 22.
 *
 * Read by the string rather than parsed: it is only ever compared with itself.
 * The executable name in field 2 can contain spaces and brackets, so the fields
 * are counted from the closing parenthesis, which is what `proc(5)` says to do.
 */
function processStartTicks(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
    const after = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    // field 3 is the first after the name, so field 22 is index 19 here.
    return after[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * How long a lock may go unrefreshed before it stops counting as a live run.
 *
 * `setUpdateLock` is re-called at every step boundary, and the longest step
 * (`post_update`) is budgeted at 15 minutes, so 20 gives the slowest healthy
 * run room without holding a crashed one's lock for long. The boot-time check
 * that releases an abandoned lock still runs; this only decides whether the
 * release happens now or at the next boot.
 */
const HOLDER_HEARTBEAT_MS = 20 * 60 * 1000;

// Re-exported so server callers keep one import for the lock. Both live in
// update-constants.ts because this file opens with `import fs`, and a client
// component reading either would drag Node's fs into the browser bundle.
export { UPDATING_PAGE, UPDATE_LOCK_HEADER } from "./update-constants";

/**
 * Take the lock. Answers whether it was actually taken.
 *
 * A failure is REPORTED and does not stop the update. Refusing to update a box
 * because a courtesy lock could not be written would be the worse outcome by
 * some way: config.json being unwritable is exactly the kind of state an update
 * exists to repair, and the desktop being reachable during one is a smaller
 * harm than a box that can no longer be fixed. But it is said out loud, because
 * silently running an update with the desktop unlocked is not something anyone
 * should have to infer from behaviour.
 */
export async function setUpdateLock(): Promise<boolean> {
  try {
    // The holder rides with the flag, in one read-modify-write — of THIS
    // process. install.sh and gateway-pre-start.sh write the same file
    // unlocked, so the pair can still be split by a cross-process interleave;
    // when it is, the reader finds no holder and falls back to the behaviour it
    // had before this record existed, which is the safe direction.
    await setMany({
      [UPDATE_LOCK_KEY]: true,
      [UPDATE_LOCK_HOLDER_KEY]: {
        pid: process.pid,
        bootId: currentBootId(),
        startedTicks: processStartTicks(process.pid),
        at: new Date().toISOString(),
      },
    });
    return true;
  } catch (err) {
    console.warn(
      "[Updater] Could not lock the desktop for this update - it stays reachable while the update runs:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Release it. A failure here leaves the desktop redirected to /updating, which
 * is why it is reported too — and why it is recoverable without anyone doing
 * anything clever: the next boot finds no update to resume and clears the flag
 * (resumeContinuation in updater.ts).
 */
export async function clearUpdateLock(): Promise<boolean> {
  try {
    await setMany({ [UPDATE_LOCK_KEY]: undefined, [UPDATE_LOCK_HOLDER_KEY]: undefined });
    return true;
  } catch (err) {
    console.warn(
      "[Updater] Could not release the desktop lock - the next start will clear it:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

export async function isUpdateLocked(): Promise<boolean> {
  try {
    return (await get(UPDATE_LOCK_KEY)) === true;
  } catch {
    return false;
  }
}

/**
 * Is the lock held by an update that is STILL RUNNING, in another process on
 * this boot?
 *
 * False for everything it cannot prove: no holder recorded (a lock taken by a
 * build that predates this record), a holder from another boot (pids are reused
 * and this flag outlives a reboot), this very process (it is the reader, not a
 * second one), or a pid that is gone. Each of those falls back to exactly the
 * behaviour before the record existed.
 *
 * `process.kill(pid, 0)` sends no signal; `EPERM` means the process is there
 * and belongs to somebody else, which is still ALIVE.
 */
export async function updateLockHeldByLiveProcess(): Promise<boolean> {
  let holder: UpdateLockHolder | null = null;
  try {
    holder = parseHolder(await get(UPDATE_LOCK_HOLDER_KEY));
  } catch {
    return false;
  }
  if (!holder || holder.pid === process.pid) return false;
  const boot = currentBootId();
  if (!boot || !holder.bootId || boot !== holder.bootId) return false;
  // THE HEARTBEAT FIRST, because it is the half that survives the holder's
  // death. Every replacement path in this repo kills the old web server before
  // the new one starts — `do_rebuild` stops the unit, and systemd's restart
  // waits for the cgroup to empty — so by the time the successor asks, the
  // process that was mid-update is usually gone while its RUN is not: the root
  // step it dispatched is still working, and `update_needs_continuation` has
  // not been written yet. A record refreshed at the last step boundary is what
  // says so.
  const at = Date.parse(holder.at);
  if (Number.isFinite(at) && Date.now() - at < HOLDER_HEARTBEAT_MS && Date.now() >= at) return true;
  // …and the live process, for the case the two really do overlap. (pid, start
  // time) rather than the pid alone: see `startedTicks`.
  try {
    process.kill(holder.pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EPERM") return false;
  }
  const ticks = processStartTicks(holder.pid);
  // A recorded start time that cannot be compared proves nothing, and a pid
  // whose process started at a different time is a different process.
  if (!holder.startedTicks || !ticks) return false;
  return holder.startedTicks === ticks;
}
