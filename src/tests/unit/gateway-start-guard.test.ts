import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFakeOpenclawCli } from "@/tests/helpers/fake-config-gateway";

/**
 * A config write while the gateway is starting (F3 defect 2, 2026-10-15).
 *
 * A gateway started by an update, two desktops reloading with it, and two
 * timezone writes reached openclaw.json through the CLI inside the gateway's
 * startup admission: OpenClaw refused readiness ("migration inputs changed
 * during startup", exit 78) and its unit does not restart on 78. The write path
 * asks the running gateway first, and a gateway that is starting does not
 * answer, so the write fell straight to the CLI. The owner's ruling: wait for
 * the gateway (about two minutes), then write; still starting, fail in plain
 * words.
 *
 * "Starting" is read from the gateway unit's cgroup, `/proc` and the core's own
 * `/startupz`; those reads are faked here, everything else is real.
 */

const host = vi.hoisted(() => ({
  /** The gateway unit's processes, or null for a unit with none. */
  procs: null as string | null,
  /** Seconds the gateway process has been running. */
  ageS: 5,
  /** The parent's command name: the service manager for the unit's main process. */
  parentComm: "systemd",
  /** That process's argv, NUL-separated as `/proc/<pid>/cmdline` holds it. */
  cmdline: "node\0/opt/openclaw/openclaw.mjs\0gateway\0--allow-unconfigured\0--bind\0lan\0",
  /** What `/startupz` answers, in order; the last one repeats. */
  startup: ["silent"] as ("silent" | "starting" | "started" | "draining")[],
  probes: 0,
  spawned: [] as string[][],
  file: "",
  /** The config file exists but cannot be read (EACCES). */
  unreadable: false,
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const fake = (file: unknown): string | null => {
    const p = String(file);
    if (host.unreadable && p === host.file) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    if (p.endsWith("/clawbox-gateway.service/cgroup.procs")) {
      if (host.procs === null) throw enoent();
      return host.procs;
    }
    if (p.startsWith("/sys/fs/cgroup/")) throw enoent();
    if (p === "/proc/uptime") return "1000.00 900.00\n";
    if (p === "/proc/4242/cmdline") return host.cmdline;
    if (p === "/proc/4242/stat") {
      const ticks = Math.round((1000 - host.ageS) * 100);
      // The command name carries a space and a paren on purpose. Field 4 is
      // the parent's pid (77), field 22 the start time.
      const tail = Array.from({ length: 30 }, (_v, i) => (i === 19 ? String(ticks) : i === 1 ? "77" : "0")).join(" ");
      return `4242 (node (gw) x) S ${tail.slice(2)}`;
    }
    if (p === "/proc/77/comm") return `${host.parentComm}\n`;
    if (/^\/proc\/\d+\//.test(p)) throw enoent();
    return null;
  };
  const readFileSync = ((file: unknown, ...rest: unknown[]) => fake(file)
    ?? (actual.readFileSync as (...a: unknown[]) => unknown)(file, ...rest)) as typeof actual.readFileSync;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

vi.mock("@/lib/openclaw-gateway-ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openclaw-gateway-ws")>();
  return {
    ...actual,
    gatewayWsCall: async () => {
      throw new actual.GatewayWsUnavailableError("connect ECONNREFUSED");
    },
  };
});

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: (_bin: string, argv: string[]) => {
    host.spawned.push(argv);
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stderr = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = stderr;
    child.stdin = { end: () => {}, write: () => {}, on: () => {} };
    child.kill = () => {};
    setTimeout(() => {
      const out = runFakeOpenclawCli(host.file, argv);
      if (out.stderr) stderr.emit("data", Buffer.from(out.stderr));
      child.emit("close", out.code);
    }, 1);
    return child;
  },
}));

let home: string;

function stubStartupProbe() {
  vi.stubGlobal("fetch", vi.fn(async () => {
    const answer = host.startup[Math.min(host.probes, host.startup.length - 1)];
    host.probes += 1;
    if (answer === "silent") throw new TypeError("fetch failed: ECONNREFUSED");
    if (answer === "started") return new Response(JSON.stringify({ ok: true, status: "started" }), { status: 200 });
    return new Response(JSON.stringify({ ok: false, status: answer }), { status: 503 });
  }));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-start-guard-"));
  host.file = path.join(home, "openclaw.json");
  fs.writeFileSync(host.file, JSON.stringify({ agents: { defaults: {} } }, null, 2));
  host.procs = "4242\n";
  host.ageS = 5;
  host.cmdline = "node\0/opt/openclaw/openclaw.mjs\0gateway\0--allow-unconfigured\0--bind\0lan\0";
  host.parentComm = "systemd";
  host.startup = ["silent"];
  host.probes = 0;
  host.spawned = [];
  host.unreadable = false;
  vi.stubEnv("CLAWBOX_OPENCLAW_HOME", home);
  vi.stubEnv("CLAWBOX_EDITION_FILE", "/nonexistent/edition.env");
  vi.stubEnv("CLAWBOX_EDITION", "openclaw");
  stubStartupProbe();
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("gatewayStartPhase", () => {
  it("reads a unit with processes and no listener yet, started seconds ago, as starting", async () => {
    const { gatewayStartPhase } = await import("@/lib/gateway-start-guard");
    expect(await gatewayStartPhase()).toBe("starting");
  });

  it("takes the core's own word when it answers", async () => {
    const { gatewayStartPhase } = await import("@/lib/gateway-start-guard");
    host.startup = ["starting"];
    expect(await gatewayStartPhase()).toBe("starting");
    host.probes = 0;
    host.startup = ["started"];
    expect(await gatewayStartPhase()).toBe("started");
    host.probes = 0;
    host.startup = ["draining"];
    expect(await gatewayStartPhase()).toBe("idle");
  });

  it("reads the unit's ExecStartPre as its own phase: a unit with processes, none of them the gateway", async () => {
    // A CLI write takes about 8 s from spawn to exit, so one let through late
    // in the pre-start lands inside the gateway's bootstrap (box run, 2026-10-16:
    // writes issued 2.3 s and 0.8 s before ExecStart exited 0.4 s and 1.8 s in).
    const { gatewayStartPhase, isGatewayServerArgv } = await import("@/lib/gateway-start-guard");
    host.cmdline = "/bin/bash\0/opt/clawbox/scripts/gateway-pre-start.sh\0";
    expect(await gatewayStartPhase()).toBe("pre-start");
    host.cmdline = "node\0/opt/openclaw/openclaw.mjs\0config\0validate\0--json\0";
    expect(await gatewayStartPhase()).toBe("pre-start");
    expect(isGatewayServerArgv(["openclaw", "gateway", "--allow-unconfigured"])).toBe(true);
    expect(isGatewayServerArgv(["node", "dist/index.js", "gateway", "run"])).toBe(true);
    expect(isGatewayServerArgv(["openclaw", "gateway"])).toBe(true);
    expect(isGatewayServerArgv(["openclaw", "gateway", "status", "--json"])).toBe(false);
    expect(isGatewayServerArgv(["openclaw", "gateway", "call", "config.get"])).toBe(false);
  });

  it("knows the gateway after the core has set its process title over its argv", async () => {
    // OpenClaw 2026.10.3 sets `openclaw` at CLI entry and `openclaw-gateway`
    // when the run loop starts; the kernel then shows the title, padded with NULs.
    const { gatewayStartPhase, isGatewayServerProcess } = await import("@/lib/gateway-start-guard");
    host.cmdline = `openclaw-gateway${"\0".repeat(40)}`;
    expect(await gatewayStartPhase()).toBe("starting");
    // Mid-bootstrap the title is still `openclaw`: the unit's own main process.
    host.cmdline = `openclaw${"\0".repeat(40)}`;
    expect(await gatewayStartPhase()).toBe("starting");
    // The same title on a CLI call the ExecStartPre's shell made is not it.
    host.parentComm = "bash";
    expect(await gatewayStartPhase()).toBe("pre-start");
    expect(isGatewayServerProcess(["openclaw-gateway"], "systemd")).toBe(true);
    expect(isGatewayServerProcess(["openclaw"], "systemd")).toBe(true);
    expect(isGatewayServerProcess(["openclaw"], "bash")).toBe(false);
    expect(isGatewayServerProcess(["openclaw", "config", "validate"], "systemd")).toBe(false);
  });

  it("never calls a unit with no processes, or a long-silent one, starting", async () => {
    const { gatewayStartPhase } = await import("@/lib/gateway-start-guard");
    host.procs = "";
    expect(await gatewayStartPhase()).toBe("idle");
    host.procs = null;
    expect(await gatewayStartPhase()).toBe("idle");
    host.procs = "4242\n";
    host.ageS = 900;
    expect(await gatewayStartPhase()).toBe("idle");
  });

  it("does not read a pre-start older than the unit's own start timeout as one, nor a gateway that answers", async () => {
    // systemd ends a pre-start at TimeoutStartSec (600 s on both units), so
    // processes older than that are not a start this could wait out.
    const { gatewayStartPhase } = await import("@/lib/gateway-start-guard");
    host.cmdline = "/bin/bash\0/opt/clawbox/scripts/gateway-pre-start.sh\0";
    host.ageS = 590;
    expect(await gatewayStartPhase()).toBe("pre-start");
    host.ageS = 610;
    expect(await gatewayStartPhase()).toBe("idle");
    // A gateway whose process this does not recognise is still the core's word.
    host.ageS = 5;
    host.startup = ["started"];
    expect(await gatewayStartPhase()).toBe("started");
    host.probes = 0;
    host.startup = ["starting"];
    expect(await gatewayStartPhase()).toBe("starting");
  });
});

describe("a config write while the gateway is starting", () => {
  it("waits for the gateway before it writes, then writes", async () => {
    vi.useFakeTimers();
    host.startup = ["silent", "silent", "starting", "starting", "started"];
    const lib = await import("@/lib/openclaw-config");
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const written = lib.runOpenclawConfigSet(["agents.defaults.userTimezone", "Europe/Sofia"]);
    await vi.advanceTimersByTimeAsync(2_500);
    // Still starting: nothing has been written yet.
    expect(host.spawned.filter((argv) => argv[0] === "config")).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(written).resolves.toBeUndefined();
    expect(host.spawned.filter((argv) => argv[0] === "config")).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(host.file, "utf-8")).agents.defaults.userTimezone).toBe("Europe/Sofia");
    quiet.mockRestore();
  });

  it("refuses in plain words, having written nothing, when the gateway is still starting after the wait", async () => {
    vi.useFakeTimers();
    host.startup = ["starting"];
    const lib = await import("@/lib/openclaw-config");
    const { GatewayStillStartingError } = await import("@/lib/gateway-start-guard");
    const quiet = [vi.spyOn(console, "warn"), vi.spyOn(console, "error")].map((s) => s.mockImplementation(() => {}));
    const written = lib.runOpenclawConfigSet(["agents.defaults.userTimezone", "Europe/Sofia"]);
    written.catch(() => {});
    await vi.advanceTimersByTimeAsync(125_000);
    const err = await written.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayStillStartingError);
    expect((err as Error).message).toMatch(/still starting/);
    expect(host.spawned.filter((argv) => argv[0] === "config")).toEqual([]);
    expect(JSON.parse(fs.readFileSync(host.file, "utf-8")).agents.defaults.userTimezone).toBeUndefined();
    quiet.forEach((s) => s.mockRestore());
  });

  it("holds a write issued during the unit's ExecStartPre until the gateway it starts is ready", async () => {
    // Let through here, the CLI write would still be running when ExecStart
    // begins, and land inside the gateway's startup admission.
    vi.useFakeTimers();
    host.cmdline = "/bin/bash\0/opt/clawbox/scripts/gateway-pre-start.sh\0";
    host.parentComm = "systemd";
    const lib = await import("@/lib/openclaw-config");
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const written = lib.runOpenclawConfigSet(["agents.defaults.userTimezone", "Europe/Sofia"]);
    written.catch(() => {});
    await vi.advanceTimersByTimeAsync(20_000);
    expect(host.spawned.filter((argv) => argv[0] === "config")).toEqual([]);
    // ExecStart: the gateway process is up, the core says starting, then started.
    host.cmdline = "node\0/opt/openclaw/openclaw.mjs\0gateway\0--allow-unconfigured\0--bind\0lan\0";
    host.ageS = 1;
    host.probes = 0;
    host.startup = ["silent", "starting", "starting", "started"];
    await vi.advanceTimersByTimeAsync(3_000);
    expect(host.spawned.filter((argv) => argv[0] === "config")).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(written).resolves.toBeUndefined();
    expect(host.spawned.filter((argv) => argv[0] === "config")).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(host.file, "utf-8")).agents.defaults.userTimezone).toBe("Europe/Sofia");
    quiet.mockRestore();
  });

  it("does not count the pre-start against the two minutes the gateway itself is given", async () => {
    vi.useFakeTimers();
    host.cmdline = "/bin/bash\0/opt/clawbox/scripts/gateway-pre-start.sh\0";
    const { holdWhileGatewayStarts, GatewayStillStartingError } = await import("@/lib/gateway-start-guard");
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const held = holdWhileGatewayStarts("config set");
    held.catch(() => {});
    // A cold pre-start of 200 s, then a gateway that takes 110 s to start.
    await vi.advanceTimersByTimeAsync(200_000);
    host.cmdline = "node\0/opt/openclaw/openclaw.mjs\0gateway\0";
    host.ageS = 1;
    host.probes = 0;
    host.startup = ["starting"];
    await vi.advanceTimersByTimeAsync(110_000);
    host.probes = 0;
    host.startup = ["started"];
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(held).resolves.toBe(true);
    // The same pre-start followed by a gateway still starting after 120 s is refused.
    host.cmdline = "/bin/bash\0/opt/clawbox/scripts/gateway-pre-start.sh\0";
    host.ageS = 5;
    host.probes = 0;
    host.startup = ["silent"];
    const again = holdWhileGatewayStarts("config set");
    again.catch(() => {});
    await vi.advanceTimersByTimeAsync(200_000);
    host.cmdline = "node\0/opt/openclaw/openclaw.mjs\0gateway\0";
    host.ageS = 1;
    host.probes = 0;
    host.startup = ["starting"];
    await vi.advanceTimersByTimeAsync(125_000);
    await expect(again).rejects.toBeInstanceOf(GatewayStillStartingError);
    quiet.mockRestore();
  });

  it("holds a whole-file write the same way", async () => {
    vi.useFakeTimers();
    host.startup = ["starting"];
    const lib = await import("@/lib/openclaw-config");
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const written = lib.writeConfig({ agents: { defaults: { userTimezone: "Europe/Berlin" } } } as never);
    written.catch(() => {});
    await vi.advanceTimersByTimeAsync(125_000);
    await expect(written).rejects.toThrow(/still starting/);
    expect(JSON.parse(fs.readFileSync(host.file, "utf-8")).agents.defaults.userTimezone).toBeUndefined();
    quiet.mockRestore();
  });

  it("does not write a whole-file snapshot over a file that moved while it was held", async () => {
    // The caller read the file before the hold; the gateway's own start writes
    // it during the hold. Writing the old snapshot back would revert that.
    vi.useFakeTimers();
    host.startup = ["silent", "started"];
    const lib = await import("@/lib/openclaw-config");
    const { ConfigChangedWhileHeldError } = await import("@/lib/gateway-start-guard");
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const written = lib.writeConfig({ agents: { defaults: { userTimezone: "Europe/Berlin" } } } as never);
    written.catch(() => {});
    await vi.advanceTimersByTimeAsync(10);
    fs.writeFileSync(host.file, JSON.stringify({ agents: { defaults: {} }, plugins: { entries: { started: true } } }, null, 2));
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(written).rejects.toBeInstanceOf(ConfigChangedWhileHeldError);
    expect(JSON.parse(fs.readFileSync(host.file, "utf-8")).plugins.entries.started).toBe(true);
    quiet.mockRestore();
  });

  it("does not write over a same-size rewrite in place that left the mtime where it was", async () => {
    // Same inode, same size, a clock that did not move (a coarse or stepped
    // timestamp): only the content says the file is not the one it was.
    vi.useFakeTimers();
    host.startup = ["silent", "started"];
    const before = JSON.stringify({ agents: { defaults: {} }, plugins: { entries: { a: 1 } } }, null, 2);
    const after = before.replace("\"a\": 1", "\"b\": 2");
    expect(after.length).toBe(before.length);
    fs.writeFileSync(host.file, before);
    fs.utimesSync(host.file, 1_700_000_000, 1_700_000_000);
    const lib = await import("@/lib/openclaw-config");
    const { ConfigChangedWhileHeldError } = await import("@/lib/gateway-start-guard");
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const written = lib.writeConfig({ agents: { defaults: { userTimezone: "Europe/Berlin" } } } as never);
    written.catch(() => {});
    await vi.advanceTimersByTimeAsync(10);
    fs.writeFileSync(host.file, after);
    fs.utimesSync(host.file, 1_700_000_000, 1_700_000_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(written).rejects.toBeInstanceOf(ConfigChangedWhileHeldError);
    expect(JSON.parse(fs.readFileSync(host.file, "utf-8")).plugins.entries.b).toBe(2);
    quiet.mockRestore();
  });

  it("still writes when the file was only rewritten with the same bytes during the hold", async () => {
    // A temp-and-rename that left the content as it was gives the file a new
    // inode and mtime; the caller's snapshot is still based on what is there.
    vi.useFakeTimers();
    host.startup = ["silent", "started"];
    const lib = await import("@/lib/openclaw-config");
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const written = lib.writeConfig({ agents: { defaults: { userTimezone: "Europe/Berlin" } } } as never);
    written.catch(() => {});
    await vi.advanceTimersByTimeAsync(10);
    const same = fs.readFileSync(host.file);
    fs.writeFileSync(`${host.file}.tmp`, same);
    fs.renameSync(`${host.file}.tmp`, host.file);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(written).resolves.toBeUndefined();
    expect(JSON.parse(fs.readFileSync(host.file, "utf-8")).agents.defaults.userTimezone).toBe("Europe/Berlin");
    quiet.mockRestore();
  });

  it("does not write a held snapshot over a file it could not read", async () => {
    // Unread is not unchanged: a file that cannot be inspected before and after
    // the hold is not replaced on the strength of two failed reads.
    vi.useFakeTimers();
    host.startup = ["silent", "started"];
    const before = fs.readFileSync(host.file, "utf-8");
    host.unreadable = true;
    const lib = await import("@/lib/openclaw-config");
    const { ConfigChangedWhileHeldError } = await import("@/lib/gateway-start-guard");
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const written = lib.writeConfig({ agents: { defaults: { userTimezone: "Europe/Berlin" } } } as never);
    written.catch(() => {});
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(written).rejects.toBeInstanceOf(ConfigChangedWhileHeldError);
    host.unreadable = false;
    expect(fs.readFileSync(host.file, "utf-8")).toBe(before);
    quiet.mockRestore();
  });

  it("logs a caller's label as one line, whatever it carries", async () => {
    vi.useFakeTimers();
    host.startup = ["silent", "started"];
    const { holdWhileGatewayStarts } = await import("@/lib/gateway-start-guard");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const held = holdWhileGatewayStarts("config set\n[openclaw-config] forged: written");
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(held).resolves.toBe(true);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toMatch(/[\r\n]/);
    warn.mockRestore();
  });

  it("writes at once when the gateway is not starting", async () => {
    host.procs = null;
    const lib = await import("@/lib/openclaw-config");
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    await lib.runOpenclawConfigSet(["agents.defaults.userTimezone", "Europe/Sofia"]);
    expect(host.spawned.filter((argv) => argv[0] === "config")).toHaveLength(1);
    expect(host.probes).toBe(0);
    quiet.mockRestore();
  });
});
