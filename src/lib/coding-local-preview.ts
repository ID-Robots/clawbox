/** Allow a live run's own loopback app, never arbitrary local services.
 * Every listener on the port must be the run's — in its recorded process group,
 * descended from it, or inside its systemd scope — AND have a cwd within this
 * run's real project; one whose owner cannot be seen (another user's) fails.
 * Re-check each navigation; no port grants survive a run.
 *
 * Why not the process group alone: the run CLI's shell tool starts each command
 * in a session of its own (setsid), so a server a run starts from its shell is
 * never in the harness's group. It is still the harness's descendant, and still
 * inside the run's scope, which is what the other two tests read. A server that
 * double-forked away (reparented to init or a subreaper) keeps only the scope.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "./runtime-path";
import { isRunScopeUnit } from "./coding-run-unit";
const exec = promisify(execFile);
export interface PreviewRun { directory: string; pgid: number | null; status: string; unit?: string | null }

/** A parent chain this long is a loop or a fork bomb, not a run's server. */
const MAX_ANCESTRY = 64;

/** ppid and pgrp from /proc/<pid>/stat; the comm field may hold spaces and parens. */
async function procStat(pid: number): Promise<{ ppid: number; pgrp: number }> {
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
  return { ppid: Number(fields[1]), pgrp: Number(fields[2]) };
}

/** In the run's process group, or below the harness that leads it. */
async function descendsFromRun(pid: number, pgid: number): Promise<boolean> {
  let current = pid;
  try {
    for (let hop = 0; hop < MAX_ANCESTRY && current > 1; hop++) {
      if (current === pgid) return true;
      const { ppid, pgrp } = await procStat(current);
      if (pgrp === pgid) return true;
      current = ppid;
    }
  } catch {
    // An ancestor exited mid-walk: not provably the run's; the scope may still say so.
  }
  return false;
}

/**
 * Does /proc/<pid>/cgroup text place the process in `unit`? A whole path
 * segment must equal the unit name, on any hierarchy line (v1 has several).
 */
export function cgroupNamesUnit(cgroup: string, unit: string): boolean {
  return cgroup.split("\n").some((line) => {
    const cgroupPath = line.split(":").slice(2).join(":");
    return cgroupPath.split("/").includes(unit);
  });
}

/**
 * The owner pids of the listeners `ss -H -ltnp` printed, or null when any row
 * names none. ss shows no pid for another user's socket, so a pid-less row is
 * a listener nothing here can prove is the run's — and it may be the one the
 * browser reaches: a run's server on [::1]:P or 127.0.0.2:P does not stop
 * another user's service owning 127.0.0.1:P.
 */
export function listenerPids(ss: string): number[] | null {
  const rows = ss.split("\n").filter((row) => row.trim());
  if (!rows.length) return null;
  const pids = new Set<number>();
  for (const row of rows) {
    const owners = [...row.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
    if (!owners.length) return null;
    for (const pid of owners) pids.add(pid);
  }
  return [...pids];
}

async function inRunScope(pid: number, unit: string): Promise<boolean> {
  try {
    return cgroupNamesUnit(await fs.readFile(`/proc/${pid}/cgroup`, "utf8"), unit);
  } catch {
    return false;
  }
}

export async function ownsLocalPreview(url: URL, run: PreviewRun | null): Promise<boolean> {
  if (!run || run.status !== "running") return false;
  const pgid = run.pgid && run.pgid > 1 ? run.pgid : null;
  const unit = isRunScopeUnit(run.unit) ? run.unit : null;
  if (!pgid && !unit) return false;
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return false;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || url.username || url.password) return false;
  try {
    const { stdout } = await exec("ss", ["-H", "-ltnp", "sport", "=", String(port)], { timeout: 1500, maxBuffer: 64 * 1024 });
    const pids = listenerPids(stdout);
    if (!pids) return false;
    const root = await fs.realpath(run.directory);
    // Every owner must be this run: no SO_REUSEPORT ambiguity, and no listener
    // on another loopback address of the same port that the browser may reach.
    for (const pid of pids) {
      const owned = (pgid !== null && await descendsFromRun(pid, pgid)) || (unit !== null && await inRunScope(pid, unit));
      if (!owned) return false;
      const cwd = await fs.realpath(`/proc/${pid}/cwd`);
      if (cwd !== root && !cwd.startsWith(root + path.sep)) return false;
    }
    return true;
  } catch { return false; }
}
