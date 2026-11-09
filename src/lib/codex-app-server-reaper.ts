/**
 * Stops the `codex app-server` processes the OpenClaw gateway leaves idle.
 *
 * WHY. With a ChatGPT sign-in every turn runs through the Codex app-server,
 * and the Codex plugin of the pinned core (`@openclaw/codex` 2026.10.9) keeps
 * one app-server per agent for the life of the gateway. When a turn ends the
 * plugin releases its lease, but the shared client stays in its pool with no
 * idle timer (`releaseSharedClientEntry` closes a client only if it was already
 * retired), so the process ends only when the gateway stops. Each one is a node
 * wrapper (`@openai/codex/bin/codex.js`) plus the native `codex` it starts,
 * 130-260 MB together on a Jetson. A customer report showed four of them,
 * ~685 MB, idle for 10+ h, on a box that then could not wake its memory
 * embedder for lack of RAM. The plugin has no setting for this. Upstream added
 * the timer in 2026.10.10: an app-server is retired 30 s after its last lease
 * once its retained threads, which are themselves dropped after 30 min idle,
 * are gone. Until the pin moves past that, this does the same from outside.
 *
 * WHAT IS STOPPED. Only a process that meets every one of these:
 *  - it is in the gateway unit's own cgroup and a DIRECT child of the gateway
 *    server, so a `codex app-server` the agent starts from a shell, or a
 *    coding run's, is never a candidate;
 *  - it is the plugin's launcher, node running `@openai/codex/bin/codex.js`
 *    with `app-server` as the subcommand (argv[0] first, see process-match.ts),
 *    and it runs with the plugin's per-agent home,
 *    `CODEX_HOME=…/agents/<id>/agent/codex-home`;
 *  - nothing runs under it except its own native binary, so a command it is
 *    running, a background terminal or an MCP server keeps it alive;
 *  - the wrapper and binary together have stayed under
 *    {@link QUIET_CPU_SHARE} of a core at every look for
 *    {@link CODEX_APP_SERVER_IDLE_MS}, the plugin's own idle window for a
 *    retained thread. The clock starts when this process first sees the
 *    app-server, so a web-server restart starts it over;
 *  - the gateway, asked right before each stop, says no session has agent work
 *    running or queued (`sessions.list` with `activeOnly`, read-only). When the
 *    gateway does not answer, or answers without a session list, nothing is
 *    stopped.
 *
 * WHAT HAPPENS NEXT. SIGTERM goes to the wrapper, which forwards it to the
 * binary and exits with it. If the tree is still there after
 * {@link STOP_GRACE_MS}, SIGKILL; a tree that outlives that too is logged as
 * not stopped, and a later sweep tries again. The plugin sees its child exit, closes the
 * client, and drops it from the pool (`markClosed`, then the shared entry's
 * close handler), so the agent's next turn starts a fresh app-server and
 * resumes its thread from the rollout on disk. That is the same path
 * upstream's own idle retirement and every gateway restart take. If a turn
 * starts in the moment between the check and the stop, it meets a closed
 * client, the error the plugin already retries as "client is closed".
 *
 * `CLAWBOX_CODEX_REAP=0` in the web server's environment turns it off.
 */

import fs from "fs/promises";
import path, { untraced } from "./runtime-path";
import { gatewayCgroupDirs, isGatewayServerProcess } from "@/lib/gateway-start-guard";
import { gatewayWsCall } from "@/lib/openclaw-gateway-ws";
import { parseProcCmdline } from "@/lib/process-match";
import { logSafe } from "@/lib/log-safe";
import { monotonicNow } from "@/lib/monotonic-clock";

/** How often the web server looks. */
export const CODEX_REAP_SWEEP_MS = 5 * 60_000;

/** How long an app-server must stay quiet before it is stopped. */
export const CODEX_APP_SERVER_IDLE_MS = 30 * 60_000;

/**
 * Quiet, as a share of one core: what an app-server tree may use between two
 * looks and still count as idle. Not zero, because an idle one is not still:
 * on a Jetson Orin Nano with @openai/codex 0.160.0, four app-servers nobody
 * used for 35 minutes each gained 3-4 clock ticks a minute, about 0.06 % of a
 * core. 0.5 % (150 ticks in five minutes) leaves room for an idle one that
 * wakes more often. What decides that nobody is using it is the gateway's
 * answer below; this only keeps a box from churning app-servers it is using.
 */
export const QUIET_CPU_SHARE = 0.005;

/** Linux's USER_HZ, the unit of utime/stime in /proc/<pid>/stat. */
const USER_HZ = 100;

/** How long a SIGTERM gets before SIGKILL. */
export const STOP_GRACE_MS = 10_000;

/** How long a SIGKILL gets to take effect before the stop is reported as failed. */
export const KILL_WAIT_MS = 5_000;

/** One process in the gateway unit, as /proc describes it. */
export interface UnitProcess {
  pid: number;
  ppid: number;
  /** `starttime` from /proc/<pid>/stat: with the pid, the process's identity. */
  startTicks: number;
  /** utime + stime, in clock ticks. */
  cpuTicks: number;
  argv: string[];
  /** The parent's `comm`, for {@link isGatewayServerProcess}. */
  parentComm: string | null;
}

export interface ReaperDeps {
  /** Every process in the gateway unit's cgroup(s). Empty when the unit is not running. */
  listUnitProcesses(): Promise<UnitProcess[]>;
  /** How many sessions have agent work running or queued. Rejects when the gateway does not answer. */
  activeSessionCount(): Promise<number>;
  /** Still the same process: the pid exists and carries this start time. */
  isAlive(pid: number, startTicks: number): Promise<boolean>;
  signal(pid: number, signal: NodeJS.Signals): void;
  /** Resident memory in kB, 0 when unreadable. */
  rssKb(pid: number): Promise<number>;
  /** The agent whose `CODEX_HOME` the app-server runs with, when it can be read. */
  agentOf(pid: number): Promise<string | null>;
  /** Milliseconds on a monotonic clock; only differences are used. */
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

export interface StoppedAppServer {
  pid: number;
  agent: string;
  idleMs: number;
  rssKb: number;
  killed: boolean;
}

/** The executable name from argv[0]; a trailing " (deleted)" appears after an in-place upgrade. */
function executableName(argv0: string | undefined): string {
  return path.basename((argv0 ?? "").trim().replace(/ \(deleted\)$/, ""));
}

const NODE_EXECUTABLE = /^node(js)?(\d+)?$/;

/** The npm package's launcher, `…/@openai/codex/bin/codex.js`. */
function isCodexLauncherScript(arg: string | undefined): boolean {
  return typeof arg === "string" && /(^|\/)@openai\/codex\/bin\/codex\.js$/.test(arg);
}

/**
 * True when `args` (what follows the program) runs the `app-server`
 * subcommand. The plugin puts `-c key=value` overrides before it.
 */
function runsAppServer(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-c" || arg === "--config") {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg === "app-server";
  }
  return false;
}

/**
 * Whether an argv is the plugin's app-server launcher: node running the npm
 * package's `codex.js` with the `app-server` subcommand. This is the only form
 * a root may have. The plugin always starts the launcher, and a bare `codex
 * app-server` that a shell exec'd in place would also be a direct child of the
 * gateway. Anchored on argv[0], so a shell whose arguments merely mention one
 * never matches.
 */
export function isCodexLauncherArgv(argv: readonly string[]): boolean {
  return NODE_EXECUTABLE.test(executableName(argv[0])) && isCodexLauncherScript(argv[1]) && runsAppServer(argv.slice(2));
}

/** Whether an argv is a codex app-server in either form: the launcher, or the native `codex` binary it starts. */
export function isCodexAppServerArgv(argv: readonly string[]): boolean {
  if (executableName(argv[0]) === "codex") return runsAppServer(argv.slice(1));
  return isCodexLauncherArgv(argv);
}

interface AppServerTree {
  root: UnitProcess;
  /** Every process under the root, at any depth. */
  descendants: UnitProcess[];
}

/** The app-servers the gateway itself started, each with what runs under it. */
export function gatewayAppServers(processes: readonly UnitProcess[]): AppServerTree[] {
  const gateways = new Set(processes.filter((p) => isGatewayServerProcess(p.argv, p.parentComm)).map((p) => p.pid));
  const children = new Map<number, UnitProcess[]>();
  for (const p of processes) {
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  const trees: AppServerTree[] = [];
  for (const root of processes) {
    if (!gateways.has(root.ppid) || !isCodexLauncherArgv(root.argv)) continue;
    const descendants: UnitProcess[] = [];
    const queue = [...(children.get(root.pid) ?? [])];
    while (queue.length) {
      const next = queue.shift()!;
      descendants.push(next);
      queue.push(...(children.get(next.pid) ?? []));
    }
    trees.push({ root, descendants });
  }
  return trees;
}

const identity = (p: UnitProcess) => `${p.pid}:${p.startTicks}`;

/** Who is in the tree, the CPU it has used, and whether anything under it is work. */
function treeState(tree: AppServerTree): { members: string; cpuTicks: number; busy: boolean } {
  return {
    members: [tree.root, ...tree.descendants].map(identity).join(","),
    cpuTicks: [tree.root, ...tree.descendants].reduce((sum, p) => sum + p.cpuTicks, 0),
    // Anything under it that is not the app-server's own binary is work.
    busy: tree.descendants.some((p) => !isCodexAppServerArgv(p.argv)),
  };
}

/**
 * The fields of `/proc/<pid>/stat` this module reads, or null for a line it
 * cannot parse. The command name is in parentheses and may hold spaces and
 * parentheses itself, so fields are counted from the LAST `)`: state is field
 * 3, ppid 4, utime 14, stime 15, starttime 22 (proc(5)).
 */
export function parseProcStat(stat: string): { state: string; ppid: number; cpuTicks: number; startTicks: number } | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat.slice(close + 2).trim().split(" ");
  const ppid = Number.parseInt(fields[1] ?? "", 10);
  const cpuTicks = Number.parseInt(fields[11] ?? "", 10) + Number.parseInt(fields[12] ?? "", 10);
  const startTicks = Number.parseInt(fields[19] ?? "", 10);
  if (!fields[0] || ![ppid, cpuTicks, startTicks].every(Number.isFinite)) return null;
  return { state: fields[0], ppid, cpuTicks, startTicks };
}

/**
 * `/proc/<pid>/<name>`, built so `next build` does not read the template as a
 * glob and trace whatever matches it (see runtime-path.ts).
 */
function procFile(pid: number, name: string): string {
  return untraced(`/proc/${pid}/${name}`);
}

async function readUnitProcess(pid: number): Promise<UnitProcess | null> {
  try {
    const stat = parseProcStat(await fs.readFile(procFile(pid, "stat"), "utf8"));
    if (!stat) return null;
    const argv = parseProcCmdline(await fs.readFile(procFile(pid, "cmdline"), "utf8"));
    const parentComm = await fs.readFile(procFile(stat.ppid, "comm"), "utf8").then((s) => s.trim(), () => null);
    return { pid, ppid: stat.ppid, startTicks: stat.startTicks, cpuTicks: stat.cpuTicks, argv, parentComm };
  } catch {
    return null; // gone between the reads
  }
}

/**
 * How many sessions have agent work running or queued: `sessions.list` with
 * `activeOnly`, as `gatewayWsActiveSessions` asks it. An answer without a
 * `sessions` list is not taken as "none", because a stop rests on this answer.
 */
async function countActiveSessions(): Promise<number> {
  const payload = await gatewayWsCall("sessions.list", { activeOnly: true, rowMode: "compact", limit: 50 }, { timeoutMs: 5_000 });
  if (!Array.isArray(payload.sessions)) throw new Error("sessions.list answered without a sessions list");
  // A row that says it has no active run is not counted; anything else is.
  return payload.sessions.filter((row) => !(row && typeof row === "object" && (row as Record<string, unknown>).hasActiveRun === false)).length;
}

const realDeps: ReaperDeps = {
  async listUnitProcesses() {
    const pids = new Set<number>();
    for (const dir of gatewayCgroupDirs()) {
      // Untraced: to the build, `${dir}/cgroup.procs` is every cgroup.procs in
      // the project, data/ included.
      const raw = await fs.readFile(untraced(`${dir}/cgroup.procs`), "utf8").catch(() => "");
      for (const pid of raw.split(/\s+/)) if (/^\d+$/.test(pid)) pids.add(Number(pid));
    }
    const found = await Promise.all([...pids].map(readUnitProcess));
    return found.filter((p): p is UnitProcess => p !== null);
  },
  activeSessionCount: countActiveSessions,
  async isAlive(pid, startTicks) {
    const stat = parseProcStat(await fs.readFile(procFile(pid, "stat"), "utf8").catch(() => ""));
    return stat !== null && stat.state !== "Z" && stat.startTicks === startTicks;
  },
  signal(pid, signal) {
    process.kill(pid, signal);
  },
  async rssKb(pid) {
    const status = await fs.readFile(procFile(pid, "status"), "utf8").catch(() => "");
    return Number.parseInt(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? "0", 10);
  },
  async agentOf(pid) {
    const environ = await fs.readFile(procFile(pid, "environ"), "utf8").catch(() => "");
    const home = environ.split("\0").find((entry) => entry.startsWith("CODEX_HOME="));
    return /\/agents\/([^/]+)\/agent\/codex-home\/?$/.exec(home ?? "")?.[1] ?? null;
  },
  // Monotonic: timesyncd steps the clock forward after a cold boot, and a
  // wall-clock jump would read as half a day of quiet.
  now: monotonicNow,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (line) => console.log(line),
};

/** The ticks a quiet tree may gain in `elapsedMs`. Never under two, so a short re-look is not judged on one tick. */
function quietBudget(elapsedMs: number): number {
  return Math.max(2, (elapsedMs / 1000) * USER_HZ * QUIET_CPU_SHARE);
}

/** One app-server as last seen: who was in its tree, its CPU then, and since when it has been quiet. */
interface Watched {
  members: string;
  cpuTicks: number;
  lookedAt: number;
  quietSince: number;
}

/** Still quiet since `before`: same members, no work under it, CPU within the budget for the time that passed. */
function stayedQuiet(before: Watched, state: ReturnType<typeof treeState>, now: number): boolean {
  if (state.busy || state.members !== before.members) return false;
  const gained = state.cpuTicks - before.cpuTicks;
  return gained >= 0 && gained <= quietBudget(now - before.lookedAt);
}

/**
 * A reaper with its own memory of each app-server's CPU time and since when
 * it has been quiet. `sweep` is one look; the web server calls it every
 * {@link CODEX_REAP_SWEEP_MS}.
 */
export function createCodexAppServerReaper(overrides: Partial<ReaperDeps> = {}, idleMs = CODEX_APP_SERVER_IDLE_MS) {
  const deps: ReaperDeps = { ...realDeps, ...overrides };
  const watched = new Map<string, Watched>();
  let sweeping = false;
  let lastHold = "";

  async function stop(tree: AppServerTree, idleFor: number, agent: string): Promise<StoppedAppServer | null> {
    const members = [tree.root, ...tree.descendants];
    const rss = await Promise.all(members.map((p) => deps.rssKb(p.pid)));
    try {
      deps.signal(tree.root.pid, "SIGTERM");
    } catch (err) {
      // Gone already: what it started may still be there, and is seen to below.
      if ((err as NodeJS.ErrnoException)?.code !== "ESRCH") {
        deps.log(`[codex-reaper] could not stop codex app-server pid ${tree.root.pid}: ${logSafe(err instanceof Error ? err.message : String(err))}`);
        return null;
      }
    }
    const alive = async () => (await Promise.all(members.map(async (p) => ((await deps.isAlive(p.pid, p.startTicks)) ? p : null)))).filter((p): p is UnitProcess => p !== null);
    let left = await alive();
    for (let waited = 0; left.length && waited < STOP_GRACE_MS; waited += 500) {
      await deps.sleep(500);
      left = await alive();
    }
    for (const p of left) {
      try {
        deps.signal(p.pid, "SIGKILL");
      } catch {
        /* gone in between */
      }
    }
    // Stopped means gone, not signalled: a process stuck in the kernel outlives
    // a SIGKILL. Its clock was dropped above, so a later sweep tries it again.
    let survivors = left;
    for (let waited = 0; survivors.length && waited < KILL_WAIT_MS; waited += 500) {
      await deps.sleep(500);
      survivors = await alive();
    }
    if (survivors.length) {
      deps.log(
        `[codex-reaper] could not stop the idle codex app-server of agent ${logSafe(agent, 64)}: pid ${survivors.map((p) => p.pid).join(", ")} still running after SIGKILL`,
      );
      return null;
    }
    const stopped = { pid: tree.root.pid, agent, idleMs: idleFor, rssKb: rss.reduce((a, b) => a + b, 0), killed: left.length > 0 };
    deps.log(
      `[codex-reaper] stopped the idle codex app-server of agent ${logSafe(agent, 64)} (pid ${stopped.pid}, idle ${Math.round(idleFor / 60_000)} min, ${Math.round(stopped.rssKb / 1024)} MB${stopped.killed ? ", SIGKILL after SIGTERM" : ""})`,
    );
    return stopped;
  }

  /** Says why idle app-servers were left running, once per distinct reason, so a box that stays busy says it once. */
  function hold(reason: string, line: string) {
    if (reason !== lastHold) deps.log(`[codex-reaper] ${line}`);
    lastHold = reason;
  }

  /** The gateway's answer, or null when it gave none. Either way, a reason to wait is logged. */
  async function activeSessions(waiting: number): Promise<number | null> {
    let active: number;
    try {
      active = await deps.activeSessionCount();
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      hold(`no answer: ${why}`, `left ${waiting} idle codex app-server(s) running: the gateway did not say whether it is busy (${logSafe(why)})`);
      return null;
    }
    if (active > 0) hold("busy", `left ${waiting} idle codex app-server(s) running: ${active} session(s) have agent work running or queued`);
    else lastHold = "";
    return active;
  }

  async function sweep(): Promise<StoppedAppServer[]> {
    if (sweeping) return [];
    sweeping = true;
    try {
      const now = deps.now();
      const seen = new Set<string>();
      const idle: { tree: AppServerTree; idleFor: number }[] = [];
      for (const tree of gatewayAppServers(await deps.listUnitProcesses())) {
        const key = identity(tree.root);
        seen.add(key);
        const state = treeState(tree);
        const before = watched.get(key);
        const quietSince = before && stayedQuiet(before, state, now) ? before.quietSince : now;
        watched.set(key, { members: state.members, cpuTicks: state.cpuTicks, lookedAt: now, quietSince });
        if (now - quietSince >= idleMs) idle.push({ tree, idleFor: now - quietSince });
      }
      for (const key of [...watched.keys()]) if (!seen.has(key)) watched.delete(key);

      // One at a time, each on a fresh answer and a fresh look: a stop takes
      // up to STOP_GRACE_MS, and a turn may start on the next one meanwhile.
      const stopped: StoppedAppServer[] = [];
      for (const [index, { tree, idleFor }] of idle.entries()) {
        const key = identity(tree.root);
        // The plugin starts every app-server with the agent's own Codex home;
        // one without it is not the plugin's, whoever started it.
        const agent = await deps.agentOf(tree.root.pid);
        if (!agent) continue;
        const active = await activeSessions(idle.length - index);
        if (active === null || active > 0) break;
        // Looked at again after the gateway answered: only a tree that is still
        // what was judged idle, and has stayed quiet meanwhile, is stopped.
        const latest = gatewayAppServers(await deps.listUnitProcesses()).find((t) => identity(t.root) === key);
        const before = watched.get(key);
        if (!latest || !before || !stayedQuiet(before, treeState(latest), deps.now())) continue;
        watched.delete(key);
        const result = await stop(latest, idleFor, agent);
        if (result) stopped.push(result);
      }
      return stopped;
    } finally {
      sweeping = false;
    }
  }

  return { sweep };
}

let shared: ReturnType<typeof createCodexAppServerReaper> | null = null;

/** The web server's sweep: one reaper for the life of the process. */
export function reapIdleCodexAppServers(): Promise<StoppedAppServer[]> {
  shared ??= createCodexAppServerReaper();
  return shared.sweep();
}
