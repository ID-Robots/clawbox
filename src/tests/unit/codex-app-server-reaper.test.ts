/**
 * @vitest-environment node
 *
 * The idle `codex app-server` processes the gateway keeps are stopped, and
 * nothing else is (src/lib/codex-app-server-reaper.ts). /proc, the gateway's
 * answer, signals and the clock are all faked: the reaper is judged on which
 * pids it signals, with what, and when.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayWsCall = vi.fn();
vi.mock("@/lib/openclaw-gateway-ws", () => ({ gatewayWsCall: (...args: unknown[]) => gatewayWsCall(...args) }));

import {
  CODEX_APP_SERVER_IDLE_MS,
  QUIET_CPU_SHARE,
  STOP_GRACE_MS,
  createCodexAppServerReaper,
  gatewayAppServers,
  isCodexAppServerArgv,
  isCodexLauncherArgv,
  parseProcStat,
  type UnitProcess,
} from "@/lib/codex-app-server-reaper";

beforeEach(() => {
  gatewayWsCall.mockReset();
});

const LAUNCHER = "/home/clawbox/.openclaw/npm/projects/openclaw-codex-8902d781d4/node_modules/@openai/codex/bin/codex.js";
const NATIVE = "/home/clawbox/.openclaw/npm/projects/openclaw-codex-8902d781d4/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex";
const APP_SERVER_ARGS = ["-c", 'cli_auth_credentials_store="ephemeral"', "app-server", "--listen", "stdio://"];
const GATEWAY = 1000;
const MIN = 60_000;

const proc = (pid: number, ppid: number, argv: string[], extra: Partial<UnitProcess> = {}): UnitProcess => ({
  pid,
  ppid,
  startTicks: pid * 10,
  cpuTicks: 5,
  argv,
  parentComm: ppid === 1 ? "systemd" : "node",
  ...extra,
});

const gateway = () => proc(GATEWAY, 1, ["openclaw-gateway", "", ""]);
/** The plugin's app-server: the node launcher under the gateway, the native binary under it. */
const appServer = (wrapper: number, extra: Partial<UnitProcess> = {}) => [
  proc(wrapper, GATEWAY, ["/usr/bin/node", LAUNCHER, ...APP_SERVER_ARGS], extra),
  proc(wrapper + 1, wrapper, [NATIVE, ...APP_SERVER_ARGS], extra),
];

/** A fake box: what /proc lists on each look, what the gateway answers, and every signal sent. */
function fakeBox(
  initial: UnitProcess[],
  options: { active?: number | Error | ((asked: number) => number); survivesTerm?: boolean; homeless?: number[] } = {},
) {
  let procs = initial;
  let clock = 0;
  const signals: [number, string][] = [];
  const signalledAt: number[] = [];
  const logs: string[] = [];
  let gatewayAsked = 0;
  const reaper = createCodexAppServerReaper({
    listUnitProcesses: async () => procs,
    activeSessionCount: async () => {
      gatewayAsked += 1;
      if (options.active instanceof Error) throw options.active;
      if (typeof options.active === "function") return options.active(gatewayAsked);
      return options.active ?? 0;
    },
    isAlive: async (pid, start) => procs.some((p) => p.pid === pid && p.startTicks === start),
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      signalledAt.push(clock);
      if (signal === "SIGKILL" || !options.survivesTerm) {
        // The launcher forwards SIGTERM to the binary and exits with it.
        const gone = new Set([pid, ...procs.filter((p) => p.ppid === pid).map((p) => p.pid)]);
        procs = procs.filter((p) => !gone.has(p.pid));
      }
    },
    rssKb: async () => 85_000,
    agentOf: async (pid) => (options.homeless?.includes(pid) ? null : `agent-${pid}`),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    log: (line) => logs.push(line),
  });
  return {
    reaper,
    signals,
    signalledAt,
    logs,
    gatewayAsked: () => gatewayAsked,
    advance: (ms: number) => {
      clock += ms;
    },
    setProcs: (next: UnitProcess[]) => {
      procs = next;
    },
    procs: () => procs,
  };
}

describe("isCodexAppServerArgv", () => {
  it("knows the npm launcher and the native binary running app-server", () => {
    expect(isCodexAppServerArgv(["/usr/bin/node", LAUNCHER, ...APP_SERVER_ARGS])).toBe(true);
    expect(isCodexAppServerArgv([NATIVE, ...APP_SERVER_ARGS])).toBe(true);
    expect(isCodexAppServerArgv(["codex", "app-server"])).toBe(true);
    expect(isCodexAppServerArgv([`${NATIVE} (deleted)`, "app-server", "--listen", "stdio://"])).toBe(true);
  });

  it("refuses other codex commands and anything that only mentions one", () => {
    expect(isCodexAppServerArgv([NATIVE, "exec", "app-server"])).toBe(false);
    expect(isCodexAppServerArgv(["/usr/bin/node", LAUNCHER, "exec", "say app-server"])).toBe(false);
    expect(isCodexAppServerArgv(["/usr/bin/node", "/tmp/codex.js", "app-server"])).toBe(false);
    expect(isCodexAppServerArgv(["/bin/bash", "-c", `${NATIVE} app-server`])).toBe(false);
    expect(isCodexAppServerArgv(["/usr/bin/python3", NATIVE, "app-server"])).toBe(false);
    expect(isCodexAppServerArgv(["-c", "app-server"])).toBe(false);
    expect(isCodexAppServerArgv([])).toBe(false);
  });

  it("takes only the launcher as a root: a bare binary a shell exec'd in place is not the plugin's", () => {
    expect(isCodexLauncherArgv(["/usr/bin/node", LAUNCHER, ...APP_SERVER_ARGS])).toBe(true);
    expect(isCodexLauncherArgv([NATIVE, ...APP_SERVER_ARGS])).toBe(false);
    expect(isCodexLauncherArgv(["codex", "app-server"])).toBe(false);
  });
});

describe("parseProcStat", () => {
  it("counts fields from the last parenthesis, so a spaced, parenthesised command name cannot shift them", () => {
    // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime prio nice threads itreal starttime …
    const line = "181320 (codex (x) y) S 181307 181307 180962 0 -1 4194560 9157 0 12 0 20 14 0 0 20 0 9 0 8386019 1234 5678\n";
    expect(parseProcStat(line)).toEqual({ state: "S", ppid: 181307, cpuTicks: 34, startTicks: 8386019 });
    expect(parseProcStat("181320 (codex) Z 1 0 0 0 0 0 0 0 0 0 7 3 0 0 0 0 0 0 99")).toEqual({ state: "Z", ppid: 1, cpuTicks: 10, startTicks: 99 });
  });

  it("answers null for a line it cannot read", () => {
    expect(parseProcStat("")).toBeNull();
    expect(parseProcStat("181320 (codex) S 1 2")).toBeNull();
  });
});

describe("gatewayAppServers", () => {
  it("takes only the gateway's own children, with everything under them", () => {
    const shell = proc(3000, GATEWAY, ["/bin/bash", "-c", "codex app-server"]);
    const agentsOwn = proc(3001, 3000, [NATIVE, "app-server"]);
    // `bash -c 'codex app-server'` exec'd in place: a bare binary, directly under the gateway.
    const execd = proc(3100, GATEWAY, [NATIVE, ...APP_SERVER_ARGS]);
    const trees = gatewayAppServers([gateway(), ...appServer(2000), shell, agentsOwn, execd]);
    expect(trees.map((t) => t.root.pid)).toEqual([2000]);
    expect(trees[0].descendants.map((p) => p.pid)).toEqual([2001]);
  });

  it("finds nothing when the gateway is not running", () => {
    expect(gatewayAppServers(appServer(2000))).toEqual([]);
  });
});

describe("createCodexAppServerReaper", () => {
  it("stops an app-server whose CPU time stood still for the idle window while the gateway is idle", async () => {
    const box = fakeBox([gateway(), ...appServer(2000), ...appServer(2100)]);
    expect(await box.reaper.sweep()).toEqual([]); // first look: the clock starts
    box.advance(CODEX_APP_SERVER_IDLE_MS - MIN);
    expect(await box.reaper.sweep()).toEqual([]);
    expect(box.gatewayAsked()).toBe(0);
    box.advance(MIN);
    const stopped = await box.reaper.sweep();
    expect(stopped.map((s) => s.pid)).toEqual([2000, 2100]);
    expect(stopped[0]).toMatchObject({ agent: "agent-2000", idleMs: CODEX_APP_SERVER_IDLE_MS, rssKb: 170_000, killed: false });
    expect(box.signals).toEqual([[2000, "SIGTERM"], [2100, "SIGTERM"]]);
    expect(box.gatewayAsked()).toBe(2); // once before each stop
    expect(box.procs().map((p) => p.pid)).toEqual([GATEWAY]);
    expect(box.logs[0]).toMatch(/stopped the idle codex app-server of agent agent-2000 \(pid 2000, idle 30 min, 166 MB\)/);
  });

  it("counts the little CPU an idle app-server still uses as quiet", async () => {
    // Measured on a Jetson: ~10 ticks per idle app-server every five to six minutes.
    const box = fakeBox([gateway(), ...appServer(2000)]);
    for (let look = 0; look <= 6; look += 1) {
      box.setProcs([gateway(), ...appServer(2000, { cpuTicks: 5 + 5 * look })]);
      const stopped = await box.reaper.sweep();
      if (look < 6) expect(stopped).toEqual([]);
      else expect(stopped.map((s) => s.pid)).toEqual([2000]);
      box.advance(5 * MIN);
    }
  });

  it("keeps an app-server that used CPU, and restarts its clock", async () => {
    const box = fakeBox([gateway(), ...appServer(2000)]);
    await box.reaper.sweep();
    box.advance(CODEX_APP_SERVER_IDLE_MS - MIN);
    box.setProcs([gateway(), ...appServer(2000, { cpuTicks: 500 })]); // a turn
    await box.reaper.sweep();
    box.advance(2 * MIN);
    expect(await box.reaper.sweep()).toEqual([]);
    box.advance(CODEX_APP_SERVER_IDLE_MS);
    expect((await box.reaper.sweep()).map((s) => s.pid)).toEqual([2000]);
  });

  it("allows a quiet tree QUIET_CPU_SHARE of a core between looks, and not a tick more", async () => {
    const budget = 5 * 60 * 100 * QUIET_CPU_SHARE; // ticks in five minutes
    for (const [gained, quiet] of [[budget, true], [budget + 1, false]] as const) {
      const box = fakeBox([gateway(), ...appServer(2000)]);
      let cpu = 5;
      for (let look = 0; look <= 6; look += 1) {
        box.setProcs([gateway(), proc(2000, GATEWAY, ["/usr/bin/node", LAUNCHER, ...APP_SERVER_ARGS]), proc(2001, 2000, [NATIVE, ...APP_SERVER_ARGS], { cpuTicks: cpu })]);
        const stopped = await box.reaper.sweep();
        if (look === 6) expect(stopped.length).toBe(quiet ? 1 : 0);
        cpu += gained;
        box.advance(5 * MIN);
      }
    }
  });

  it("keeps an app-server with work under it: a command, a background terminal or an MCP server", async () => {
    const mcp = proc(2002, 2001, ["/usr/bin/node", "/home/clawbox/clawbox/mcp/dist/server.js"]);
    const box = fakeBox([gateway(), ...appServer(2000), mcp]);
    await box.reaper.sweep();
    box.advance(2 * CODEX_APP_SERVER_IDLE_MS);
    expect(await box.reaper.sweep()).toEqual([]);
    expect(box.signals).toEqual([]);
  });

  it("stops nothing while any session has agent work running or queued", async () => {
    const box = fakeBox([gateway(), ...appServer(2000)], { active: 1 });
    await box.reaper.sweep();
    box.advance(CODEX_APP_SERVER_IDLE_MS);
    expect(await box.reaper.sweep()).toEqual([]);
    expect(box.gatewayAsked()).toBe(1);
    expect(box.signals).toEqual([]);
  });

  it("stops nothing when the gateway does not answer, and says so once", async () => {
    const box = fakeBox([gateway(), ...appServer(2000)], { active: new Error("gateway handshake timed out") });
    await box.reaper.sweep();
    box.advance(CODEX_APP_SERVER_IDLE_MS);
    expect(await box.reaper.sweep()).toEqual([]);
    box.advance(5 * MIN);
    expect(await box.reaper.sweep()).toEqual([]);
    expect(box.signals).toEqual([]);
    expect(box.logs).toHaveLength(1);
    expect(box.logs[0]).toMatch(/did not say whether it is busy \(gateway handshake timed out\)/);
  });

  it.each([
    ["used CPU", () => [gateway(), ...appServer(2000, { cpuTicks: 7 })]],
    ["got a new process under it", () => [gateway(), proc(2000, GATEWAY, ["/usr/bin/node", LAUNCHER, ...APP_SERVER_ARGS]), proc(2005, 2000, [NATIVE, ...APP_SERVER_ARGS])]],
    ["was replaced by another process on the same pid", () => [gateway(), proc(2000, GATEWAY, ["/usr/bin/node", LAUNCHER, ...APP_SERVER_ARGS], { startTicks: 77 }), proc(2001, 2000, [NATIVE, ...APP_SERVER_ARGS])]],
    ["is gone", () => [gateway()]],
  ])("does not stop a tree that %s while the gateway answered", async (_what, meanwhile) => {
    let procs = [gateway(), ...appServer(2000)];
    let clock = 0;
    const signals: string[] = [];
    const reaper = createCodexAppServerReaper({
      listUnitProcesses: async () => procs,
      activeSessionCount: async () => {
        procs = meanwhile(); // a turn started meanwhile, or the process changed
        return 0;
      },
      signal: (_pid, signal) => signals.push(signal),
      agentOf: async () => "main",
      now: () => clock,
      log: () => {},
    });
    await reaper.sweep();
    clock = CODEX_APP_SERVER_IDLE_MS;
    expect(await reaper.sweep()).toEqual([]);
    expect(signals).toEqual([]);
  });

  it("treats a recycled pid as a new process", async () => {
    const box = fakeBox([gateway(), ...appServer(2000)]);
    await box.reaper.sweep();
    box.advance(CODEX_APP_SERVER_IDLE_MS - MIN);
    // Only the root's start time differs: the same pids, another process.
    box.setProcs([gateway(), proc(2000, GATEWAY, ["/usr/bin/node", LAUNCHER, ...APP_SERVER_ARGS], { startTicks: 99_999 }), proc(2001, 2000, [NATIVE, ...APP_SERVER_ARGS])]);
    box.advance(MIN);
    expect(await box.reaper.sweep()).toEqual([]);
    expect(box.signals).toEqual([]);
  });

  it("follows a SIGTERM that is ignored with SIGKILL, only after the grace", async () => {
    const box = fakeBox([gateway(), ...appServer(2000)], { survivesTerm: true });
    await box.reaper.sweep();
    box.advance(CODEX_APP_SERVER_IDLE_MS);
    const [stopped] = await box.reaper.sweep();
    expect(stopped.killed).toBe(true);
    expect(box.signals).toEqual([[2000, "SIGTERM"], [2000, "SIGKILL"], [2001, "SIGKILL"]]);
    expect(box.signalledAt[1] - box.signalledAt[0]).toBeGreaterThanOrEqual(STOP_GRACE_MS);
    expect(box.logs[0]).toMatch(/SIGKILL after SIGTERM/);
  });

  it("still sees to the binary when the launcher is gone by the time of the SIGTERM", async () => {
    let procs = [gateway(), ...appServer(2000)];
    let clock = 0;
    const signals: [number, string][] = [];
    const reaper = createCodexAppServerReaper({
      listUnitProcesses: async () => procs,
      activeSessionCount: async () => 0,
      isAlive: async (pid, start) => procs.some((p) => p.pid === pid && p.startTicks === start),
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === "SIGTERM") {
          procs = procs.filter((p) => p.pid !== pid); // the launcher had just exited
          throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
        }
        procs = procs.filter((p) => p.pid !== pid);
      },
      rssKb: async () => 0,
      agentOf: async () => "main",
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      log: () => {},
    });
    await reaper.sweep();
    clock = CODEX_APP_SERVER_IDLE_MS;
    expect((await reaper.sweep()).map((s) => s.killed)).toEqual([true]);
    expect(signals).toEqual([[2000, "SIGTERM"], [2001, "SIGKILL"]]);
  });

  it("leaves an app-server without the plugin's per-agent Codex home alone", async () => {
    const box = fakeBox([gateway(), ...appServer(2000), ...appServer(2100)], { homeless: [2000] });
    await box.reaper.sweep();
    box.advance(CODEX_APP_SERVER_IDLE_MS);
    expect((await box.reaper.sweep()).map((s) => s.pid)).toEqual([2100]);
    expect(box.signals).toEqual([[2100, "SIGTERM"]]);
  });

  it("asks the gateway again before each stop, and stops no more once a turn has started", async () => {
    const box = fakeBox([gateway(), ...appServer(2000), ...appServer(2100)], { active: (asked) => (asked === 1 ? 0 : 1) });
    await box.reaper.sweep();
    box.advance(CODEX_APP_SERVER_IDLE_MS);
    expect((await box.reaper.sweep()).map((s) => s.pid)).toEqual([2000]);
    expect(box.signals).toEqual([[2000, "SIGTERM"]]);
  });

  it.each([
    ["no session list", {}, false, /without a sessions list/],
    ["a running session", { sessions: [{ key: "agent:main:main" }] }, false, null],
    ["only rows that say they have no run", { sessions: [{ key: "agent:main:main", hasActiveRun: false }] }, true, null],
  ])("takes the gateway's own answer, and stops nothing on one with %s", async (_what, payload, stops, logged) => {
    gatewayWsCall.mockResolvedValue(payload);
    let clock = 0;
    const logs: string[] = [];
    const signals: number[] = [];
    let procs = [gateway(), ...appServer(2000)];
    const reaper = createCodexAppServerReaper({
      listUnitProcesses: async () => procs,
      isAlive: async (pid, start) => procs.some((p) => p.pid === pid && p.startTicks === start),
      signal: (pid) => {
        signals.push(pid);
        procs = [gateway()];
      },
      rssKb: async () => 0,
      agentOf: async () => "main",
      now: () => clock,
      log: (line) => logs.push(line),
    });
    await reaper.sweep();
    clock = CODEX_APP_SERVER_IDLE_MS;
    await reaper.sweep();
    expect(gatewayWsCall).toHaveBeenCalledWith("sessions.list", { activeOnly: true, rowMode: "compact", limit: 50 }, { timeoutMs: 5_000 });
    expect(signals).toEqual(stops ? [2000] : []);
    if (logged) expect(logs.join("\n")).toMatch(logged);
  });

  it("forgets an app-server that is gone, and starts over for its successor", async () => {
    const box = fakeBox([gateway(), ...appServer(2000)]);
    await box.reaper.sweep();
    box.advance(CODEX_APP_SERVER_IDLE_MS);
    box.setProcs([gateway()]);
    await box.reaper.sweep();
    box.setProcs([gateway(), ...appServer(2000)]);
    expect(await box.reaper.sweep()).toEqual([]);
    box.advance(CODEX_APP_SERVER_IDLE_MS);
    expect((await box.reaper.sweep()).map((s) => s.pid)).toEqual([2000]);
  });

  it("runs one sweep at a time", async () => {
    let release: () => void = () => {};
    const box = fakeBox([gateway(), ...appServer(2000)]);
    const slow = createCodexAppServerReaper({
      listUnitProcesses: () => new Promise((resolve) => {
        release = () => resolve(box.procs());
      }),
      log: () => {},
    });
    const first = slow.sweep();
    expect(await slow.sweep()).toEqual([]);
    release();
    expect(await first).toEqual([]);
  });
});
