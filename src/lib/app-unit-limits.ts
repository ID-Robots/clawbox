/**
 * Memory caps for the app servers the AGENT runs as its own user units.
 *
 * ClawBox starts a server app in a transient scope with MemoryHigh/MemoryMax
 * from `appMemoryLimits()` (`buildAppScopeArgv`, src/lib/app-server-start.ts).
 * The agent sometimes serves an app another way: it writes a
 * `~/.config/systemd/user/<app>-app.service` of its own, with no cap at all.
 * One of those — a Next.js server for a registered app — sat at 4.3 GB
 * resident on the owner's box and pushed it 6 GB into swap (measured
 * 2026-10-28); on an 8 GB Jetson it would have taken the box down.
 *
 * `capForeignAppServers` gives such a unit the same caps a scope gets. It
 * walks the registered apps (`data/webapps/<id>/meta.json`), finds what
 * listens on each app's port the way the proxy does (`ss`, loopback rows, and
 * the listener's cwd inside the app's folder — so a port that is somebody
 * else's is never touched), reads the unit the listener runs in off
 * `/proc/<pid>/cgroup`, and caps it with `systemctl --user set-property`,
 * which writes a drop-in under `~/.config/systemd/user.control/` and applies
 * to the running unit at once. Only a USER `.service` is a candidate — never a
 * system unit, never a `.scope`, never a unit of ClawBox's own (`clawbox-*`) —
 * and only one that has no MemoryMax yet, so an owner's deliberate cap is left
 * alone and a unit is capped once, not on every pass.
 *
 * A unit that is already above the cap when it lands is OOM-killed by the
 * kernel and comes back under its own `Restart=`; that is the same wall a
 * scope has, and a server that grew past it was not going to recover.
 *
 * `CLAWBOX_APP_CAPS=0` in the web server's environment turns the pass off.
 */

import fs from "fs";
import path, { untraced } from "@/lib/runtime-path";
import { isLoopbackListenRow } from "@/lib/app-proxy";
import { APP_ID_RE } from "@/lib/code-projects";
import { DATA_DIR } from "@/lib/config-store";
import { isProxyablePort } from "@/lib/clawbox-manifest";
import { appMemoryLimits } from "@/lib/box-memory-policy";
import { runChild, type ChildResult } from "@/lib/child-run";
import { isInside } from "@/lib/file-guard";
import { APP_CPU_WEIGHT, APP_IO_WEIGHT } from "@/lib/app-server-start";
import { scopeEnv } from "@/lib/coding-run-unit";

/** How often the web server looks again, after the boot pass. */
export const APP_CAPS_SWEEP_MS = 15 * 60_000;

/** A user unit's name as systemd prints it in a cgroup path. */
const UNIT_RE = /^[A-Za-z0-9@._-]+\.service$/;

/** Units ClawBox makes itself (`clawbox-app-*` scopes, the run scopes, its services) are never candidates. */
const OWN_PREFIX = "clawbox-";

export type Runner = (bin: string, args: string[], opts: { timeoutMs: number; env: Record<string, string> }) => Promise<ChildResult>;

export interface CapOptions {
  /** A test's webapps folder, instead of the box's. */
  webappsDir?: string;
  /** A test's child runner, instead of the real one. */
  run?: Runner;
  /** A test's `/proc/<pid>/cwd` and `/proc/<pid>/cgroup` reads. */
  proc?: { cwd(pid: number): Promise<string | null>; cgroup(pid: number): Promise<string | null> };
  /** A test's environment, instead of the process's. */
  env?: Record<string, string | undefined>;
}

const childEnv = (): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C",
});

/**
 * `systemctl --user` from the web server, which is a SYSTEM service whose
 * environment has neither XDG_RUNTIME_DIR nor DBUS_SESSION_BUS_ADDRESS (checked
 * on the box, 2026-10-28): without the runtime dir every call fails and the
 * pass is a silent no-op. `scopeEnv` derives `/run/user/<uid>`, the one thing
 * systemctl needs to find the user bus — the same answer the run scopes use.
 */
const systemctlEnv = (): Record<string, string> => scopeEnv(childEnv());

const realProc = {
  cwd: (pid: number) => fs.promises.readlink(`/proc/${pid}/cwd`).catch(() => null),
  cgroup: (pid: number) => fs.promises.readFile(`/proc/${pid}/cgroup`, "utf-8").catch(() => null),
};

/**
 * The user `.service` a cgroup line names, or null when the process runs
 * anywhere else: a system unit, a scope, no unit at all.
 */
export function foreignUserServiceOf(cgroup: string | null): string | null {
  if (!cgroup) return null;
  const line = cgroup.split("\n").find((l) => l.startsWith("0::")) ?? cgroup.split("\n")[0] ?? "";
  const cgPath = line.replace(/^0::/, "").trim();
  if (!cgPath.includes("/user@")) return null;
  const unit = cgPath.split("/").pop() ?? "";
  if (!UNIT_RE.test(unit) || unit.startsWith(OWN_PREFIX)) return null;
  return unit;
}

/** The pids of the loopback-reachable listeners on `port`, or null when `ss` could not say. */
async function listenerPids(port: number, run: Runner): Promise<number[] | null> {
  const r = await run("ss", ["-H", "-l", "-t", "-n", "-p", `sport = :${port}`], { timeoutMs: 5_000, env: childEnv() });
  if (r.code !== 0) return null;
  const rows = r.stdout.split("\n").map((l) => l.trim()).filter((l) => l && isLoopbackListenRow(l));
  return [...new Set([...rows.join("\n").matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))];
}

/**
 * Cap every registered app's server that runs in a user unit of the agent's
 * own making. Answers the units it capped on this pass. Never throws: an
 * `ss` or `systemctl` that fails only skips that app.
 */
export async function capForeignAppServers(options: CapOptions = {}): Promise<string[]> {
  const env = options.env ?? process.env;
  if (env.CLAWBOX_APP_CAPS === "0") return [];
  const dir = options.webappsDir ?? path.join(DATA_DIR, "webapps");
  const run = options.run ?? runChild;
  const proc = options.proc ?? realProc;
  const entries = await fs.promises.readdir(untraced(dir), { withFileTypes: true }).catch(() => []);
  const capped: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory() || !APP_ID_RE.test(entry.name)) continue;
    const id = entry.name;
    const meta = await fs.promises.readFile(untraced(path.join(dir, id, "meta.json")), "utf-8")
      .then((raw) => JSON.parse(raw) as Record<string, unknown>)
      .catch(() => null);
    if (!meta) continue;
    const port = typeof meta.port === "number" ? meta.port : Number.NaN;
    const directory = typeof meta.directory === "string" ? meta.directory : "";
    if (!isProxyablePort(port) || !directory) continue;
    const pids = await listenerPids(port, run);
    if (!pids || pids.length === 0) continue;
    const real = await fs.promises.realpath(untraced(directory)).catch(() => directory);
    for (const pid of pids) {
      const cwd = await proc.cwd(pid);
      if (!cwd || !isInside(cwd, real)) continue;
      const unit = foreignUserServiceOf(await proc.cgroup(pid));
      if (!unit || seen.has(unit)) continue;
      seen.add(unit);
      const shown = await run("systemctl", ["--user", "show", "-p", "MemoryMax", "--value", unit], { timeoutMs: 10_000, env: systemctlEnv() });
      if (shown.code !== 0 || shown.stdout.trim() !== "infinity") continue;
      const limits = appMemoryLimits();
      const set = await run(
        "systemctl",
        ["--user", "set-property", unit, `MemoryHigh=${limits.high}`, `MemoryMax=${limits.max}`, `CPUWeight=${APP_CPU_WEIGHT}`, `IOWeight=${APP_IO_WEIGHT}`],
        { timeoutMs: 10_000, env: systemctlEnv() },
      );
      if (set.code !== 0) {
        console.error(`[app-caps] ${unit} (app ${id}, port ${port}): set-property failed: ${(set.stderr || set.stdout).trim().slice(0, 200)}`);
        continue;
      }
      console.log(`[app-caps] ${unit} (app ${id}, port ${port}): MemoryHigh=${limits.high} MemoryMax=${limits.max}`);
      capped.push(unit);
    }
  }
  return capped;
}
