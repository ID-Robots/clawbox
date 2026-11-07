/**
 * @vitest-environment node
 *
 * The idle `codex app-server` processes the gateway keeps are stopped, and
 * nothing else is (src/lib/codex-app-server-reaper.ts). /proc, the gateway's
 * answer, signals and the clock are all faked: the reaper is judged on which
 * pids it signals, with what, and when.
 */
import { describe, expect, it } from "vitest";
import {
  CODEX_APP_SERVER_IDLE_MS,
  QUIET_CPU_SHARE,
  STOP_GRACE_MS,
  createCodexAppServerReaper,
  gatewayAppServers,
  isCodexAppServerArgv,
  type UnitProcess,
} from "@/lib/codex-app-server-reaper";

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
function fakeBox(initial: UnitProcess[], options: { active?: number | Error; survivesTerm?: boolean } = {}) {
  let procs = initial;
  let clock = 0;
  const signals: [number, string][] = [];
  const logs: string[] = [];
  let gatewayAsked = 0;
  const reaper = createCodexAppServerReaper({
    listUnitProcesses: async () => procs,
    activeSessionCount: async () => {
      gatewayAsked += 1;
      if (options.active instanceof Error) throw options.active;
      return options.active ?? 0;
    },
    isAlive: async (pid, start) => procs.some((p) => p.pid === pid && p.startTicks === start),
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === "SIGKILL" || !options.survivesTerm) {
        // The launcher forwards SIGTERM to the binary and exits with it.
        const gone = new Set([pid, ...procs.filter((p) => p.ppid === pid).map((p) => p.pid)]);
        procs = procs.filter((p) => !gone.has(p.pid));
      }
    },
    rssKb: async () => 85_000,
    agentOf: async (pid) => `agent-${pid}`,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    log: (line) => logs.push(line),
  });
  return {
    reaper,
    signals,
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
});

describe("gatewayAppServers", () => {
  it("takes only the gateway's own children, with everything under them", () => {
    const shell = proc(3000, GATEWAY, ["/bin/bash", "-c", "codex app-server"]);
    const agentsOwn = proc(3001, 3000, [NATIVE, "app-server"]);
    const trees = gatewayAppServers([gateway(), ...appServer(2000), shell, agentsOwn]);
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

  it("does not stop a tree that changed between the look and the gateway's answer", async () => {
    let procs = [gateway(), ...appServer(2000)];
    let clock = 0;
    const signals: string[] = [];
    const reaper = createCodexAppServerReaper({
      listUnitProcesses: async () => procs,
      activeSessionCount: async () => {
        procs = [gateway(), ...appServer(2000, { cpuTicks: 7 })]; // a turn started meanwhile
        return 0;
      },
      signal: (_pid, signal) => signals.push(signal),
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
    box.setProcs([gateway(), ...appServer(2000, { startTicks: 99_999 })]);
    box.advance(MIN);
    expect(await box.reaper.sweep()).toEqual([]);
    expect(box.signals).toEqual([]);
  });

  it("follows a SIGTERM that is ignored with SIGKILL after the grace", async () => {
    const box = fakeBox([gateway(), ...appServer(2000)], { survivesTerm: true });
    await box.reaper.sweep();
    box.advance(CODEX_APP_SERVER_IDLE_MS);
    const [stopped] = await box.reaper.sweep();
    expect(stopped.killed).toBe(true);
    expect(box.signals).toEqual([[2000, "SIGTERM"], [2000, "SIGKILL"], [2001, "SIGKILL"]]);
    expect(box.logs[0]).toMatch(/SIGKILL after SIGTERM/);
    expect(STOP_GRACE_MS).toBeGreaterThan(0);
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
