import fsSync from "fs";
import { envPort } from "@/lib/port-probe";

/**
 * Never write openclaw.json under a gateway that is starting.
 *
 * On 2026-10-15 a box's gateway was started by an update, the desktops reloaded
 * with it, and two timezone writes reached openclaw.json through the CLI while
 * the gateway was inside its startup admission. OpenClaw (2026.9.4, and the
 * pinned 2026.10.3) hashes the effective config, the plugin-doctor config and
 * the plugin migration fingerprint during that admission and refuses with
 * "migration inputs changed during startup; refusing to report the gateway
 * ready", exit 78, which its own unit (and ClawBox's) does not restart. The
 * gateway stayed down until someone restarted it by hand.
 *
 * The write path asked the running gateway first (`config.patch`), and a
 * gateway that is starting does not answer yet, so the write fell straight to
 * the CLI, which writes the file regardless. The owner's ruling: wait for the
 * gateway instead, about two minutes at most, then write; still not ready,
 * fail in plain words. The units keep `RestartPreventExitStatus=78`.
 *
 * WHAT "STARTING" MEANS HERE, read without spawning anything:
 *   - the gateway PROCESS is up: a process in the gateway unit's cgroup (the
 *     appliance's `clawbox-gateway.service`, or on an x64 bridge install the
 *     owner's `openclaw-gateway.service`) that is the gateway server, see
 *     {@link isGatewayServerProcess}. The appliance's ExecStartPre does not
 *     count: a write that lands before ExecStart is what the startup admission
 *     then reads, and cannot change it mid-admission;
 *   - the core's own startup probe, `/startupz` on the gateway port, does not
 *     answer `started` (200): it answers 503 `starting`, or nothing yet
 *     (the CLI bootstrap runs before the listener opens);
 *   - and, when it answers nothing, that process is younger than
 *     `RECENT_START_MS`, read from `/proc` start ticks against the uptime, so a
 *     wall clock that NTP steps at boot cannot fake an age.
 * Anything this cannot read is "not starting", which is the write path as it
 * was. The reads are of small kernel pseudo-files and synchronous on purpose:
 * they cost microseconds, and they cannot leave a caller waiting on host I/O.
 *
 * `/startupz` is the core's own readiness contract (docs/gateway/health.md,
 * OpenClaw 2026.10.3): 503 `starting` until startup sidecars and agent
 * database inspection settle, 503 `draining` during a drain, 200 `started`.
 *
 * Its own module, not an export of `@/lib/openclaw-config`, for the reason
 * `@/lib/openclaw-maintenance` gives.
 */

const GATEWAY_PORT = envPort(process.env.GATEWAY_PORT, 18789);
/** How long a write waits for a starting gateway: the owner's "about 120 s". */
export const GATEWAY_START_WAIT_MS = 120_000;
/** A gateway silent for longer than this since its unit started is not "starting". */
const RECENT_START_MS = 300_000;
const POLL_MS = 1_000;
const PROBE_TIMEOUT_MS = 2_000;
/** Linux's USER_HZ, the unit of `/proc/<pid>/stat` start times on every architecture ClawBox runs on. */
const USER_HZ = 100;

/** The gateway was still starting when the wait ran out; nothing was written. */
export class GatewayStillStartingError extends Error {
  readonly code = "gateway_starting";
  constructor() {
    super("The assistant is still starting, so this change was not saved. Try again in a minute.");
    this.name = "GatewayStillStartingError";
  }
}

export type GatewayStartPhase = "started" | "starting" | "idle";

/** Where systemd keeps the gateway unit's processes, appliance and x64 bridge. */
function gatewayCgroupDirs(): string[] {
  const dirs = ["/sys/fs/cgroup/system.slice/clawbox-gateway.service"];
  const uid = process.getuid?.();
  if (typeof uid === "number") {
    const manager = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service`;
    dirs.push(`${manager}/app.slice/openclaw-gateway.service`, `${manager}/openclaw-gateway.service`);
  }
  return dirs;
}

/** Whether an argv is the gateway server itself: `… gateway` followed by nothing, `run` or a flag. */
export function isGatewayServerArgv(argv: readonly string[]): boolean {
  const at = argv.indexOf("gateway");
  if (at < 0) return false;
  const next = argv[at + 1];
  return next === undefined || next === "run" || next.startsWith("-");
}

/**
 * Whether one process is the gateway server. Its argv names the command only
 * until the core sets its process title, which replaces the argv the kernel
 * shows: OpenClaw 2026.10.3 sets `openclaw` at CLI entry and `openclaw-gateway`
 * when the run loop starts (`process.title`, dist `run-*.mjs`). The bootstrap in
 * between, the window this guard exists for, reads `openclaw` like any CLI
 * call, so a bare `openclaw` title counts only for the unit's own main process,
 * whose parent is the service manager; the CLI calls the ExecStartPre makes are
 * children of its shell.
 */
export function isGatewayServerProcess(argv: readonly string[], parentComm: string | null): boolean {
  if (isGatewayServerArgv(argv)) return true;
  const title = (argv[0] ?? "").trim();
  const titled = argv.slice(1).every((arg) => arg === "");
  if (title === "openclaw-gateway" && titled) return true;
  return title === "openclaw" && titled && parentComm === "systemd";
}

function readSmall(file: string): string {
  return String(fsSync.readFileSync(file, "utf8"));
}

/** How long the gateway process has been running, or null when its unit runs none. */
function liveGatewayAgeMs(): number | null {
  for (const dir of gatewayCgroupDirs()) {
    try {
      const pids = readSmall(`${dir}/cgroup.procs`).split(/\s+/).filter((pid) => /^\d+$/.test(pid));
      let startTicks = Number.POSITIVE_INFINITY;
      for (const pid of pids) {
        try {
          const stat = readSmall(`/proc/${pid}/stat`);
          // The command name is in parentheses and may hold spaces; fields
          // resume after its closing one: `ppid` is field 4, `starttime` 22.
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          const argv = readSmall(`/proc/${pid}/cmdline`).replace(/\0+$/, "").split("\0");
          let parentComm: string | null = null;
          try {
            parentComm = readSmall(`/proc/${fields[1]}/comm`).trim();
          } catch {
            /* the parent is gone */
          }
          if (!isGatewayServerProcess(argv, parentComm)) continue;
          const ticks = Number.parseInt(fields[19] ?? "", 10);
          if (Number.isFinite(ticks)) startTicks = Math.min(startTicks, ticks);
        } catch {
          /* gone between the reads */
        }
      }
      if (!Number.isFinite(startTicks)) continue;
      const uptimeS = Number.parseFloat(readSmall("/proc/uptime").split(/\s+/)[0]);
      if (!Number.isFinite(uptimeS)) return null;
      return Math.max(0, (uptimeS - startTicks / USER_HZ) * 1000);
    } catch {
      /* not this unit, or a host with no unified cgroup tree */
    }
  }
  return null;
}

/** The core's own answer on `/startupz`: started, starting, draining, or nothing. */
async function probeStartup(): Promise<"started" | "starting" | "draining" | "silent"> {
  try {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/startupz`, {
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = await res.text().catch(() => "");
    if (res.status === 200) return "started";
    if (res.status === 503) {
      const status = (() => {
        try {
          return (JSON.parse(body) as { status?: unknown }).status;
        } catch {
          return undefined;
        }
      })();
      if (status === "starting") return "starting";
      if (status === "draining") return "draining";
    }
    return "silent";
  } catch {
    return "silent";
  }
}

/** Whether the gateway is starting right now. Anything unreadable reads as not. */
export async function gatewayStartPhase(): Promise<GatewayStartPhase> {
  const ageMs = liveGatewayAgeMs();
  if (ageMs === null) return "idle";
  const probe = await probeStartup();
  if (probe === "started") return "started";
  if (probe === "starting") return "starting";
  if (probe === "draining") return "idle";
  return ageMs < RECENT_START_MS ? "starting" : "idle";
}

/**
 * Hold a write of openclaw.json while the gateway is starting: return once it
 * has started or is no longer coming up, and throw
 * {@link GatewayStillStartingError} when it is still starting after
 * `budgetMs`. Answers whether it held, so a caller whose snapshot predates the
 * wait can take a fresh one. Costs nothing on a box whose gateway is not
 * starting.
 */
export async function holdWhileGatewayStarts(label: string, budgetMs = GATEWAY_START_WAIT_MS): Promise<boolean> {
  if ((await gatewayStartPhase()) !== "starting") return false;
  console.warn(`[openclaw-config] ${label}: the gateway is starting; holding the write until it is ready`);
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const phase = await gatewayStartPhase();
    if (phase !== "starting") {
      console.warn(`[openclaw-config] ${label}: the gateway is ${phase === "started" ? "ready" : "no longer starting"} after ${Math.round((Date.now() - started) / 1000)}s; writing`);
      return true;
    }
  }
  console.warn(`[openclaw-config] ${label}: the gateway was still starting after ${Math.round(budgetMs / 1000)}s; not writing`);
  throw new GatewayStillStartingError();
}

/** CLI verbs that write openclaw.json themselves. Read-only verbs never wait. */
export function cliWritesConfig(args: readonly string[]): boolean {
  const [noun, verb, sub] = args;
  if (noun === "config") return verb === "set" || verb === "unset" || verb === "patch";
  if (noun === "models" && verb === "auth") return sub === "paste-api-key" || sub === "paste-token" || sub === "logout";
  if (noun === "plugins") return verb === "install" || verb === "enable" || verb === "disable" || verb === "uninstall";
  if (noun === "channels") return verb === "logout";
  return false;
}

/**
 * The config file changed while a whole-file write was held for a starting
 * gateway: the snapshot that write carries is older than the file, so it is
 * not written over it.
 */
export class ConfigChangedWhileHeldError extends Error {
  readonly code = "config_changed_while_held";
  constructor() {
    super("OpenClaw's settings changed while the assistant was starting, so this older copy was not saved over them. Try again.");
    this.name = "ConfigChangedWhileHeldError";
  }
}
