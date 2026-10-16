import fsSync from "fs";
import { envPort } from "@/lib/port-probe";
import { logSafe } from "@/lib/log-safe";

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
 * gateway instead, about two minutes of its own start at most, then write;
 * still not ready, fail in plain words. The unit's ExecStartPre is waited out
 * as well and, by design, not counted against those two minutes: a cold
 * pre-start can legitimately take minutes. So the worst case is the
 * pre-start's own bound (600 s) plus the two minutes, and a write a page is
 * waiting on can outlast the tunnel's ~100 s on a cold pre-start, then land
 * after the page has given up. The units keep `RestartPreventExitStatus=78`.
 *
 * WHAT "STARTING" MEANS HERE, read without spawning anything:
 *   - the gateway PROCESS is up: a process in the gateway unit's cgroup (the
 *     appliance's `clawbox-gateway.service`, or on an x64 bridge install the
 *     owner's `openclaw-gateway.service`) that is the gateway server, see
 *     {@link isGatewayServerProcess};
 *   - the core's own startup probe, `/startupz` on the gateway port, does not
 *     answer `started` (200): it answers 503 `starting`, or nothing yet
 *     (the CLI bootstrap runs before the listener opens);
 *   - and, when it answers nothing, that process is younger than
 *     `RECENT_START_MS`, read from `/proc` start ticks against the uptime, so a
 *     wall clock that NTP steps at boot cannot fake an age.
 *
 * THE UNIT'S EXECSTARTPRE IS HELD TOO, as a phase of its own (`pre-start`):
 * the unit's cgroup has processes, none of them the gateway server, the core
 * does not answer, and the oldest of them is younger than the unit's own
 * `TimeoutStartSec`. A CLI write takes about 8 s from spawn to exit, so one let
 * through late in the pre-start finished inside the gateway's bootstrap (a box
 * run, 2026-10-16: writes issued 2.3 s and 0.8 s before ExecStart exited 0.4 s
 * and 1.8 s in). That time is not counted against the gateway's own budget: a
 * cold pre-start can legitimately take minutes, and systemd ends one that
 * outlives `TimeoutStartSec`.
 *
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
/** How long a write waits for a starting gateway process (pre-start not counted): the owner's "about 120 s". */
export const GATEWAY_START_WAIT_MS = 120_000;
/** A gateway silent for longer than this since its unit started is not "starting". */
const RECENT_START_MS = 300_000;
/**
 * The `TimeoutStartSec` of both gateway units (config/clawbox-gateway.service,
 * the x64 bridge's): a pre-start older than this is one systemd has ended, so
 * whatever is left in the cgroup is not a start a write could wait out.
 */
const PRE_START_MAX_MS = 600_000;
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

export type GatewayStartPhase = "started" | "starting" | "pre-start" | "idle";

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

/**
 * What the gateway unit is running: the gateway server and how long it has
 * been up, or only other processes (its ExecStartPre) and how long the oldest
 * of them has, or nothing. A gateway server in any of the units wins: on an x64
 * bridge the system unit's start script sits beside the owner's user unit,
 * which holds the gateway itself.
 */
function readGatewayUnit(): { kind: "gateway" | "pre-start"; ageMs: number } | null {
  let gatewayTicks = Number.POSITIVE_INFINITY;
  let oldestTicks = Number.POSITIVE_INFINITY;
  for (const dir of gatewayCgroupDirs()) {
    let pids: string[];
    try {
      pids = readSmall(`${dir}/cgroup.procs`).split(/\s+/).filter((pid) => /^\d+$/.test(pid));
    } catch {
      continue; // not this unit, or a host with no unified cgroup tree
    }
    for (const pid of pids) {
      try {
        const stat = readSmall(`/proc/${pid}/stat`);
        // The command name is in parentheses and may hold spaces; fields
        // resume after its closing one: `ppid` is field 4, `starttime` 22.
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const ticks = Number.parseInt(fields[19] ?? "", 10);
        if (!Number.isFinite(ticks)) continue;
        oldestTicks = Math.min(oldestTicks, ticks);
        const argv = readSmall(`/proc/${pid}/cmdline`).replace(/\0+$/, "").split("\0");
        let parentComm: string | null = null;
        try {
          parentComm = readSmall(`/proc/${fields[1]}/comm`).trim();
        } catch {
          /* the parent is gone */
        }
        if (isGatewayServerProcess(argv, parentComm)) gatewayTicks = Math.min(gatewayTicks, ticks);
      } catch {
        /* gone between the reads */
      }
    }
  }
  const kind = Number.isFinite(gatewayTicks) ? "gateway" : Number.isFinite(oldestTicks) ? "pre-start" : null;
  if (!kind) return null;
  try {
    const uptimeS = Number.parseFloat(readSmall("/proc/uptime").split(/\s+/)[0]);
    if (!Number.isFinite(uptimeS)) return null;
    const ticks = kind === "gateway" ? gatewayTicks : oldestTicks;
    return { kind, ageMs: Math.max(0, (uptimeS - ticks / USER_HZ) * 1000) };
  } catch {
    return null;
  }
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
  const unit = readGatewayUnit();
  if (unit === null) return "idle";
  // Asked in the pre-start too, where nothing listens yet and a refused
  // connection answers at once: a gateway this does not recognise by its
  // process (a core that names itself differently) is still the core's word.
  const probe = await probeStartup();
  if (probe === "started") return "started";
  if (probe === "starting") return "starting";
  if (probe === "draining") return "idle";
  if (unit.kind === "pre-start") return unit.ageMs < PRE_START_MAX_MS ? "pre-start" : "idle";
  return unit.ageMs < RECENT_START_MS ? "starting" : "idle";
}

const holds = (phase: GatewayStartPhase) => phase === "starting" || phase === "pre-start";

/**
 * Hold a write of openclaw.json while the gateway is starting or its unit's
 * ExecStartPre runs: return once it has started or is no longer coming up,
 * and throw {@link GatewayStillStartingError} when the gateway process has been
 * starting for `budgetMs`. The pre-start is not counted against that budget.
 * Answers whether it held, so a caller whose snapshot predates the wait can
 * take a fresh one. Costs nothing on a box whose gateway is not starting.
 */
export async function holdWhileGatewayStarts(label: string, budgetMs = GATEWAY_START_WAIT_MS): Promise<boolean> {
  let phase = await gatewayStartPhase();
  if (!holds(phase)) return false;
  // JSON.stringify on top of logSafe: one record per line, and the shape
  // CodeQL's js/log-injection reads as sanitised (it does not credit a
  // replace with a visible stand-in character).
  const what = JSON.stringify(logSafe(label));
  const why = phase === "pre-start" ? "the gateway's pre-start is running" : "the gateway is starting";
  console.warn(`[openclaw-config] ${what}: ${why}; holding the write until it is ready`);
  const started = Date.now();
  let startingMs = 0;
  let last = started;
  while (startingMs < budgetMs) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const was = phase;
    phase = await gatewayStartPhase();
    const now = Date.now();
    if (was === "starting") startingMs += now - last;
    last = now;
    if (!holds(phase)) {
      console.warn(`[openclaw-config] ${what}: the gateway is ${phase === "started" ? "ready" : "no longer starting"} after ${Math.round((now - started) / 1000)}s; writing`);
      return true;
    }
  }
  console.warn(`[openclaw-config] ${what}: the gateway was still starting after ${Math.round(budgetMs / 1000)}s; not writing`);
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
