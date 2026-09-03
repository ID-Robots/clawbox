import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Restarting the chat backend without root — and, far more importantly, NOT
 * restarting it when nothing is going to bring it back.
 *
 * The whole module is one dangerous verb behind one guard. `hermes dashboard
 * --stop` is the only unprivileged way to make the dashboard re-read its `.env`
 * and re-scan its plugins, because repo policy deliberately refuses a
 * `systemctl` sudoers grant over any Hermes unit — a `restart` grant would let
 * an OpenClaw box resurrect the dashboard its foreign-edition teardown just
 * disabled. So the stop is safe exactly when systemd promises to start it
 * again, and this suite is about that promise.
 */

const cliMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());
const waitForPortOpenMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));
vi.mock("child_process", () => ({ execFile: execFileMock }));
vi.mock("@/lib/port-probe", async (orig) => ({
  ...(await orig<typeof import("@/lib/port-probe")>()),
  waitForPortOpen: waitForPortOpenMock,
}));

import {
  bounceHermesDashboard,
  classifyUnitState,
  hermesDashboardUnitState,
} from "@/lib/hermes-dashboard-control";

/**
 * Answer every `systemctl show` this module makes — the restart policy and the
 * unit's main PID — in systemd's own `Key=Value` form, which is what `showUnit`
 * parses. `pids` is consumed in order, so a case can say "this process before
 * the stop, that one after".
 */
function systemd({ restart = "always", pids = ["4242", "5353"] }: { restart?: string; pids?: string[] } = {}): void {
  const remaining = [...pids];
  execFileMock.mockImplementation((_bin: string, args: string[], _opts: unknown, cb: unknown) => {
    const done = cb as (e: Error | null, out: { stdout: string; stderr: string }) => void;
    const property = (args as string[]).find((a) => a.startsWith("--property=")) ?? "";
    if (property === "--property=MainPID") {
      const pid = (remaining.length > 1 ? remaining.shift() : remaining[0]) ?? "0";
      done(null, { stdout: `MainPID=${pid}\n`, stderr: "" });
      return;
    }
    done(null, { stdout: `Restart=${restart}\n`, stderr: "" });
  });
}

/** `systemctl show … --property=Restart` prints `Restart=value`. */
function systemdRestartPolicy(value: string): void {
  systemd({ restart: value });
}

/** The argv of the `systemctl` read, so the query itself can be asserted. */
function systemctlCall(): [string, string[]] {
  const [bin, args] = execFileMock.mock.calls[0] as [string, string[]];
  return [bin, args];
}

beforeEach(() => {
  cliMock.mockReset();
  execFileMock.mockReset();
  waitForPortOpenMock.mockReset().mockResolvedValue(true);
  cliMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  systemdRestartPolicy("always");
});

describe("bounceHermesDashboard", () => {
  it("stops the dashboard when systemd promises to start it again", async () => {
    await expect(bounceHermesDashboard()).resolves.toBe("restarted");
    expect(cliMock).toHaveBeenCalledWith(["dashboard", "--stop"], expect.anything());
  });

  it("asks systemd BEFORE it stops anything", async () => {
    await bounceHermesDashboard();
    const [bin, args] = systemctlCall();
    // Absolute path, like every other systemctl call site in the repo, and a
    // READ — this module must never need a privilege it cannot have.
    expect(bin).toBe("/usr/bin/systemctl");
    // By NAME, like every read in this module — never a bare value whose
    // meaning depends on the order systemd chose to print it in.
    expect(args).toEqual([
      "show",
      "clawbox-hermes-dashboard.service",
      "--property=Restart",
    ]);
  });

  it("refuses to stop a dashboard that nothing will restart", async () => {
    // A dev checkout running the dashboard by hand, or an older unit file. The
    // stop would leave the owner with no chat at all, which is far worse than
    // whatever staleness the caller was trying to clear.
    systemdRestartPolicy("no");
    // "failed", not "pending": nothing has been asked to restart, so nothing is
    // coming back on its own and the caller's owner DOES have to act.
    await expect(bounceHermesDashboard()).resolves.toBe("failed");
    expect(cliMock).not.toHaveBeenCalled();
  });

  it("refuses when systemd cannot be asked", async () => {
    // No systemd, no unit, a failed query: none of them is a promise, and the
    // answer that keeps the dashboard up is the same for all three.
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: unknown) => {
      (cb as (e: Error) => void)(new Error("no such unit"));
    });
    await expect(bounceHermesDashboard()).resolves.toBe("failed");
    expect(cliMock).not.toHaveBeenCalled();
  });

  it("reports a failure when the stop itself did not take", async () => {
    cliMock.mockResolvedValue({ code: 1, stdout: "", stderr: "unkillable" });
    await expect(bounceHermesDashboard()).resolves.toBe("failed");
  });

  it("does not throw when the CLI is missing entirely", async () => {
    cliMock.mockRejectedValue(new Error("ENOENT"));
    await expect(bounceHermesDashboard()).resolves.toBe("failed");
  });

  /**
   * A stop is not a bounce. `Restart=always` promises systemd will start the
   * dashboard again — it does not promise it came back, and the callers act on
   * the answer: a ClawKeep restore reports the restored state.db is being
   * served, and the image refresh reports the box can draw. Both were true
   * only once the dashboard was listening again.
   */
  it("answers restarted only once the dashboard is listening again", async () => {
    waitForPortOpenMock.mockResolvedValue(false);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // "pending", not "failed". The stop exited 0 over a Restart=always unit, so
    // the restart HAS been taken and systemd owns what happens next; the socket
    // simply has not opened inside the budget. ClawKeep's restore card renders
    // the two differently, and prescribing `systemctl restart` for this one
    // kills a dashboard mid-start.
    await expect(bounceHermesDashboard()).resolves.toBe("pending");
    errorSpy.mockRestore();
  });

  it("probes the dashboard's own socket", async () => {
    await bounceHermesDashboard();
    const [port, host] = waitForPortOpenMock.mock.calls[0];
    // 127.0.0.2:9119 — config/clawbox-hermes-dashboard.service's ExecStart.
    expect(port).toBe(9119);
    expect(host).toBe("127.0.0.2");
  });

  it("requires a DIFFERENT process, not merely an open port", async () => {
    // The port cannot tell the outgoing dashboard from the incoming one, and
    // between our stop and the unit's RestartSec=5 there is no instant where it
    // could: a probe that lands early finds the process we just killed. systemd
    // knows which process is the unit's, so it is asked.
    systemd({ pids: ["4242", "4242"] });
    process.env.HERMES_DASHBOARD_WAIT_MS = "40";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // finally, not a trailing statement: a failing assertion would otherwise
    // skip the cleanup and leak a 40 ms dashboard budget into every later test
    // in this worker, turning one red into a cascade nowhere near its cause.
    try {
      await expect(bounceHermesDashboard()).resolves.toBe("pending");
      expect(waitForPortOpenMock).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      delete process.env.HERMES_DASHBOARD_WAIT_MS;
    }
  });

  it("reads the outgoing PID before it stops anything", async () => {
    await bounceHermesDashboard();
    const mainPidQueries = execFileMock.mock.calls.filter(([, args]) =>
      (args as string[]).includes("--property=MainPID"),
    );
    // One before the stop to name the outgoing process, at least one after.
    expect(mainPidQueries.length).toBeGreaterThanOrEqual(2);
    expect(mainPidQueries[0][1]).toContain("clawbox-hermes-dashboard.service");
  });

  /**
   * ONE budget for both halves, which is what the module's own doc block
   * promises and what makes 45 s a safe number: the bounce runs synchronously
   * inside three Hermes request routes that can reach the owner through
   * cloudflared, whose edge cuts a response at 100 s. Two independent 45 s
   * waits is a 90 s ceiling — inside the edge only by 10 s, and a 90 s spinner
   * where the file says 45.
   */
  it("spends ONE budget across both halves, not one each", async () => {
    const budgetMs = 300;
    const readDelayMs = 120;
    process.env.HERMES_DASHBOARD_WAIT_MS = String(budgetMs);
    try {
      // Each systemd read costs real time, and the replacement PID only shows
      // up on the third one — so the first half eats the whole budget and the
      // second half must be left with none of it.
      const pids = ["4242", "4242", "5353"];
      execFileMock.mockImplementation((_bin: string, args: string[], _opts: unknown, cb: unknown) => {
        const done = cb as (e: Error | null, out: { stdout: string; stderr: string }) => void;
        const property = (args as string[]).find((a) => a.startsWith("--property=")) ?? "";
        if (property !== "--property=MainPID") {
          done(null, { stdout: "Restart=always\n", stderr: "" });
          return;
        }
        const pid = (pids.length > 1 ? pids.shift() : pids[0]) ?? "0";
        setTimeout(() => done(null, { stdout: `MainPID=${pid}\n`, stderr: "" }), readDelayMs);
      });

      let probeStartedAt = 0;
      waitForPortOpenMock.mockImplementation(async () => {
        probeStartedAt = Date.now();
        return true;
      });

      // Measured from the stop, which is where the shared deadline starts — not
      // from the call, so the two `systemctl show` reads before it cannot push a
      // loaded CI worker over the tolerance and turn this red for the wrong
      // reason. The tolerance then only has to absorb scheduler jitter between
      // the stop resolving and the deadline being taken.
      let deadlineStartedAt = 0;
      cliMock.mockImplementation(async () => {
        deadlineStartedAt = Date.now();
        return { code: 0, stdout: "", stderr: "" };
      });

      await expect(bounceHermesDashboard()).resolves.toBe("restarted");

      const [, , options] = waitForPortOpenMock.mock.calls[0] as [number, string, { timeoutMs: number }];
      // The budget the socket half was handed, plus what the PID half already
      // spent, may not exceed the ONE budget the whole bounce has. Two separate
      // budgets put this at roughly 2x.
      expect((probeStartedAt - deadlineStartedAt) + options.timeoutMs)
        .toBeLessThanOrEqual(budgetMs + 150);
    } finally {
      delete process.env.HERMES_DASHBOARD_WAIT_MS;
    }
  });

  /**
   * The same guard `waitForPortOpen` carries, for the same reason: this budget
   * comes from `Number(process.env…)` too. `Number("soon")` is NaN, and
   * `Date.now() + NaN` is NaN — every `remaining <= 0` comparison is then
   * false, `Math.min(500, NaN)` is NaN, and `setTimeout(_, NaN)` clamps to
   * 1 ms. The replacement wait would never return and would fork a
   * `systemctl show` per iteration for the life of the process.
   */
  it("falls back to the built-in budget when the wait override is malformed", async () => {
    process.env.HERMES_DASHBOARD_WAIT_MS = "soon";
    try {
      systemd({ pids: ["4242", "5353"] });
      await expect(bounceHermesDashboard()).resolves.toBe("restarted");
      const [, , options] = waitForPortOpenMock.mock.calls[0] as [number, string, { timeoutMs: number }];
      expect(Number.isFinite(options.timeoutMs)).toBe(true);
    } finally {
      delete process.env.HERMES_DASHBOARD_WAIT_MS;
    }
  });

  it("counts a respawn even when the unit had no running process to begin with", async () => {
    // A dashboard already down (crashed, mid-RestartSec) shows MainPID 0. The
    // replacement is still a real respawn, and `null !== 6464` says so.
    systemd({ pids: ["0", "6464"] });
    await expect(bounceHermesDashboard()).resolves.toBe("restarted");
  });
});

/**
 * TASK-663 — the second, read-only question this module answers: is the
 * dashboard still COMING UP?
 *
 * The Providers panel used to report a booting box as degraded with every
 * provider "Unknown". Whether the unit is starting is systemd's fact, not
 * something to approximate with a wall clock beside it, and `systemctl show`
 * is a read — the same unprivileged call the restart guard above already makes.
 *
 * Two of systemd's actual behaviours are pinned here because guessing at them
 * is what made the first attempt wrong, and both were reproduced on a real host
 * rather than reasoned about:
 *   - `systemctl show` prints properties in SYSTEMD's order, not the order the
 *     query asked for, so the fields have to be keyed by name;
 *   - it answers `inactive`/`dead` with exit 0 for a unit that does not exist,
 *     which is indistinguishable from an installed, stopped unit until you also
 *     read `LoadState`.
 */
describe("hermesDashboardUnitState", () => {
  /** Real output: `Key=Value` lines, in systemd's own order. */
  function systemdShow(props: Record<string, string>): void {
    const body = Object.entries(props).map(([k, v]) => `${k}=${v}`).join("\n");
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: unknown) => {
      (cb as (e: Error | null, out: { stdout: string; stderr: string }) => void)(null, {
        stdout: `${body}\n`,
        stderr: "",
      });
    });
  }

  it("asks systemd for the unit, with a read that needs no privilege", async () => {
    systemdShow({ LoadState: "loaded", ActiveState: "active", SubState: "running" });
    await hermesDashboardUnitState();

    const [bin, args] = systemctlCall();
    expect(bin).toBe("/usr/bin/systemctl");
    expect(args[0]).toBe("show");
    expect(args).toContain("--property=LoadState,ActiveState,SubState");
    // No `--value`: the values alone cannot be told apart once there is more
    // than one of them (see below).
    expect(args).not.toContain("--value");
    expect(args).not.toContain("restart");
  });

  it("answers unknown — never a guess — when systemd cannot be asked", async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: unknown) => {
      (cb as (e: Error) => void)(new Error("systemctl: not found"));
    });
    expect(await hermesDashboardUnitState()).toBe("unknown");
  });

  it("keys the answer by property NAME, not by the order it asked in", async () => {
    // Shuffled on purpose: systemd prints in its OWN order, which is the whole
    // reason the read cannot be positional. A positional read of this calls a
    // starting unit "down".
    systemdShow({ SubState: "start-pre", LoadState: "loaded", ActiveState: "activating" });
    expect(await hermesDashboardUnitState()).toBe("starting");
  });

  it("does not call a unit systemd has never heard of 'down'", async () => {
    // A dev checkout, CI, a container, and — the one that matters — a box
    // mid-update between the unit-file replace and `daemon-reload`. `down`
    // there means "degrade the panel now", on a box whose dashboard may be
    // seconds from answering.
    systemdShow({ LoadState: "not-found", ActiveState: "inactive", SubState: "dead" });
    expect(await hermesDashboardUnitState()).toBe("unknown");
  });

  it("still reads an installed, stopped unit as down", async () => {
    // The same two properties, the other LoadState: an OpenClaw box stops and
    // disables this unit on purpose, and nothing is coming back.
    systemdShow({ LoadState: "loaded", ActiveState: "inactive", SubState: "dead" });
    expect(await hermesDashboardUnitState()).toBe("down");
  });

  // The vocabulary itself, pinned so a rename upstream cannot silently turn a
  // failed unit into "still starting".
  it.each([
    // On its way. `Type=simple` means `active` arrives when ExecStart FORKS, so
    // what `activating` really covers here is the unit's two ExecStartPre lines
    // — bounded by its own TimeoutStartSec, which is where the caller's budget
    // comes from.
    ["loaded", "activating", "start-pre", "starting"],
    ["loaded", "activating", "start", "starting"],
    ["loaded", "reloading", "reload", "starting"],
    // ...but NOT the gap between crashes. `Restart=always` + `RestartSec=5`
    // with no StartLimitBurst that can trip means a broken dashboard sits here
    // for ever, and a process that has already run and died is not starting.
    ["loaded", "activating", "auto-restart", "restarting"],
    // Up as far as systemd is concerned — the socket is the caller's clock.
    ["loaded", "active", "running", "running"],
    // Nothing is going to answer. Note an OpenClaw box stops and disables this
    // unit deliberately, so "down" is not by itself a fault.
    ["loaded", "failed", "failed", "down"],
    ["loaded", "inactive", "dead", "down"],
    ["masked", "inactive", "dead", "down"],
    // Cannot be asked, in its three shapes: no such unit, mid-transition (which
    // is what this app's own dashboard bounce passes through, and reading it as
    // `down` flashed the degraded banner over a restart we asked for), and no
    // systemd at all.
    ["not-found", "inactive", "dead", "unknown"],
    ["loaded", "deactivating", "stop-sigterm", "unknown"],
    ["", "", "", "unknown"],
  ])("reads %s %s/%s as %s", (loadState, activeState, subState, expected) => {
    expect(classifyUnitState({ loadState, activeState, subState })).toBe(expected);
  });
});
