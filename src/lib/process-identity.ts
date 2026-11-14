// Which process a pid names.
//
// A pid alone is not an identity. The kernel hands the number out again once
// its process is gone, and after a reboot the low numbers are taken within
// seconds — so a record that outlives the process it names (a lock, a
// run-state file) says "running" about whatever unrelated process holds the
// number now. (pid, start time) is unique within a boot, and the boot id makes
// it unique across them. update-lock.ts keeps the same pair for the update
// lock's holder, for the same reason.
//
// No module state and no project imports: the key is read from procfs every
// time it is asked for, and is only ever compared with an earlier answer.

import { existsSync, readFileSync } from "node:fs";

/** What a live process answers where there is no procfs to read a start time from. */
const NO_PROCFS_KEY = "no-procfs";

function bootId(): string {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * A string naming the process that runs as `pid` NOW — the boot it belongs to
 * and when it started — or "" when no process has that pid.
 *
 * Record it beside the pid when the process is started; the process is still
 * that one for as long as this answers the same string. A different string is
 * another process on a reused number, and "" is no process at all.
 *
 * The start time is field 22 of `/proc/<pid>/stat`, in clock ticks since boot.
 * The executable name in field 2 can hold spaces and brackets, so the fields
 * are counted from the closing parenthesis, as proc(5) says to. An `exec` keeps
 * both the pid and the start time, so a wrapper that execs into the real
 * command is still the process that was recorded.
 *
 * Where there is no procfs (a developer's macOS) a live pid answers one fixed
 * string: the comparison is then the pid alone, which is all that can be known
 * there. Every box ClawBox ships on has procfs.
 */
export function processStartKey(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "";
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    if (existsSync("/proc/self/stat")) return "";
    try {
      process.kill(pid, 0);
      return NO_PROCFS_KEY;
    } catch {
      return "";
    }
  }
  const afterName = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  // Field 3 is the first after the name, so field 22 is index 19 here.
  const startTicks = afterName[19];
  return startTicks ? `${bootId()}:${startTicks}` : "";
}
