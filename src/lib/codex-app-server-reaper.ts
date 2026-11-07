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
 *  - argv[0] makes it a codex app-server: node running
 *    `@openai/codex/bin/codex.js`, or the native `codex` binary, with
 *    `app-server` as the subcommand (see process-match.ts for why argv[0]
 *    comes first);
 *  - nothing runs under it except its own native binary, so a command it is
 *    running, a background terminal or an MCP server keeps it alive;
 *  - the wrapper and binary together have stayed under
 *    {@link QUIET_CPU_SHARE} of a core at every look for
 *    {@link CODEX_APP_SERVER_IDLE_MS}, the plugin's own idle window for a
 *    retained thread. The clock starts when this process first sees the
 *    app-server, so a web-server restart starts it over;
 *  - the gateway, asked right before the stop, says no session has agent work
 *    running or queued (`sessions.list` with `activeOnly`, read-only). When the
 *    gateway does not answer, nothing is stopped.
 *
 * WHAT HAPPENS NEXT. SIGTERM goes to the wrapper, which forwards it to the
 * binary and exits with it. If the tree is still there after
 * {@link STOP_GRACE_MS}, SIGKILL. The plugin sees its child exit, closes the
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
import path from "./runtime-path";
import { gatewayCgroupDirs, isGatewayServerProcess } from "@/lib/gateway-start-guard";
import { gatewayWsActiveSessions } from "@/lib/openclaw-gateway-ws";
import { parseProcCmdline } from "@/lib/process-match";
import { logSafe } from "@/lib/log-safe";

/** How often the web server looks. */
export const CODEX_REAP_SWEEP_MS = 5 * 60_000;

/** How long an app-server must stay quiet before it is stopped. */
export const CODEX_APP_SERVER_IDLE_MS = 30 * 60_000;

/**
 * Quiet, as a share of one core: what an app-server tree may use between two
 * looks and still count as idle. Not zero, because an idle one is not still:
 * on a Jetson Orin Nano with @openai/codex 0.160.0, four app-servers nobody
 * had used for half an hour each gained ~10 clock ticks (0.1 s) every five to
 * six minutes, about 0.03 % of a core. A turn costs far more than this.
 */
export const QUIET_CPU_SHARE = 0.002;

/** Linux's USER_HZ, the unit of utime/stime in /proc/<pid>/stat. */
const USER_HZ = 100;

/** How long a SIGTERM gets before SIGKILL. */
export const STOP_GRACE_MS = 10_000;

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
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

export interface StoppedAppServer {
  pid: number;
  agent: string | null;
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
 * Whether an argv is a codex app-server: the native `codex` binary, or node
 * running the npm launcher, followed by the `app-server` subcommand. Anchored
 * on argv[0]; a shell whose arguments merely mention one never matches.
 */
export function isCodexAppServerArgv(argv: readonly string[]): boolean {
  const exe = executableName(argv[0]);
  if (exe === "codex") return runsAppServer(argv.slice(1));
  if (NODE_EXECUTABLE.test(exe) && isCodexLauncherScript(argv[1])) return runsAppServer(argv.slice(2));
  return false;
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
    if (!gateways.has(root.ppid) || !isCodexAppServerArgv(root.argv)) continue;
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

/** `/proc/<pid>/stat` after the command name, which may hold spaces and parentheses. */
function statFields(stat: string): string[] {
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
}

async function readUnitProcess(pid: number): Promise<UnitProcess | null> {
  try {
    const fields = statFields(await fs.readFile(`/proc/${pid}/stat`, "utf8"));
    const ppid = Number.parseInt(fields[1] ?? "", 10);
    const cpuTicks = Number.parseInt(fields[11] ?? "", 10) + Number.parseInt(fields[12] ?? "", 10);
    const startTicks = Number.parseInt(fields[19] ?? "", 10);
    if (![ppid, cpuTicks, startTicks].every(Number.isFinite)) return null;
    const argv = parseProcCmdline(await fs.readFile(`/proc/${pid}/cmdline`, "utf8"));
    const parentComm = await fs.readFile(`/proc/${ppid}/comm`, "utf8").then((s) => s.trim(), () => null);
    return { pid, ppid, startTicks, cpuTicks, argv, parentComm };
  } catch {
    return null; // gone between the reads
  }
}

const realDeps: ReaperDeps = {
  async listUnitProcesses() {
    const pids = new Set<number>();
    for (const dir of gatewayCgroupDirs()) {
      const raw = await fs.readFile(`${dir}/cgroup.procs`, "utf8").catch(() => "");
      for (const pid of raw.split(/\s+/)) if (/^\d+$/.test(pid)) pids.add(Number(pid));
    }
    const found = await Promise.all([...pids].map(readUnitProcess));
    return found.filter((p): p is UnitProcess => p !== null);
  },
  async activeSessionCount() {
    return (await gatewayWsActiveSessions({ timeoutMs: 5_000 })).sessionKeys.length;
  },
  async isAlive(pid, startTicks) {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
    if (!stat) return false;
    const fields = statFields(stat);
    return fields[0] !== "Z" && Number.parseInt(fields[19] ?? "", 10) === startTicks;
  },
  signal(pid, signal) {
    process.kill(pid, signal);
  },
  async rssKb(pid) {
    const status = await fs.readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
    return Number.parseInt(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? "0", 10);
  },
  async agentOf(pid) {
    const environ = await fs.readFile(`/proc/${pid}/environ`, "utf8").catch(() => "");
    const home = environ.split("\0").find((entry) => entry.startsWith("CODEX_HOME="));
    return /\/agents\/([^/]+)\/agent\/codex-home\/?$/.exec(home ?? "")?.[1] ?? null;
  },
  now: () => Date.now(),
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
  let lastRefusal = "";

  async function stop(tree: AppServerTree, idleFor: number): Promise<StoppedAppServer | null> {
    const members = [tree.root, ...tree.descendants];
    const [agent, ...rss] = await Promise.all([deps.agentOf(tree.root.pid), ...members.map((p) => deps.rssKb(p.pid))]);
    try {
      deps.signal(tree.root.pid, "SIGTERM");
    } catch (err) {
      deps.log(`[codex-reaper] could not stop codex app-server pid ${tree.root.pid}: ${logSafe(err instanceof Error ? err.message : String(err))}`);
      return null;
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
    const stopped = { pid: tree.root.pid, agent, idleMs: idleFor, rssKb: rss.reduce((a, b) => a + b, 0), killed: left.length > 0 };
    deps.log(
      `[codex-reaper] stopped the idle codex app-server${agent ? ` of agent ${logSafe(agent, 64)}` : ""} (pid ${stopped.pid}, idle ${Math.round(idleFor / 60_000)} min, ${Math.round(stopped.rssKb / 1024)} MB${stopped.killed ? ", SIGKILL after SIGTERM" : ""})`,
    );
    return stopped;
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
      if (!idle.length) return [];

      let active: number;
      try {
        active = await deps.activeSessionCount();
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        if (why !== lastRefusal) deps.log(`[codex-reaper] left ${idle.length} idle codex app-server(s) running: the gateway did not say whether it is busy (${logSafe(why)})`);
        lastRefusal = why;
        return [];
      }
      lastRefusal = "";
      if (active > 0) return [];

      // Looked at again after the gateway answered: only a tree that is still
      // what was judged idle, and has stayed quiet meanwhile, is stopped.
      const current = new Map(gatewayAppServers(await deps.listUnitProcesses()).map((tree) => [identity(tree.root), tree]));
      const recheckedAt = deps.now();
      const stopped: StoppedAppServer[] = [];
      for (const { tree, idleFor } of idle) {
        const key = identity(tree.root);
        const latest = current.get(key);
        const before = watched.get(key);
        if (!latest || !before || !stayedQuiet(before, treeState(latest), recheckedAt)) continue;
        watched.delete(key);
        const result = await stop(latest, idleFor);
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
