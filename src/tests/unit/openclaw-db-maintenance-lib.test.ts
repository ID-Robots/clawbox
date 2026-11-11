import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import path from "node:path";

// src/lib/openclaw-db-maintenance.ts — the web server's side of the OpenClaw
// database maintenance: the owner's schedule, the "is a run holding the
// gateway" answer the updater asks, the status the Settings card reads and the
// launch into a transient user unit. The helper itself is
// openclaw-db-maintenance-maintain.test.ts.

const h = vi.hoisted(() => {
  const root = `${process.env.TMPDIR || "/tmp"}/db-maint-lib-${process.pid}-${Math.random().toString(36).slice(2)}`;
  return {
    root,
    store: {} as Record<string, unknown>,
    edition: "openclaw",
    updating: false,
    probe: { available: true, path: "/usr/bin/systemd-run", detail: null as string | null },
    execFile: vi.fn(),
    spawn: vi.fn(),
    bin: "/home/clawbox/.npm-global/bin/openclaw",
    /** The desktop integration's host file, as this suite stands it in: never the host's own /etc. */
    envFile: `${root}/etc/x64-integration.env`,
  };
});

vi.mock("child_process", () => ({ execFile: h.execFile, spawn: h.spawn }));
vi.mock("@/lib/config-store", () => ({
  CONFIG_ROOT: h.root,
  DATA_DIR: `${h.root}/data`,
  get: vi.fn(async (key: string) => h.store[key]),
  set: vi.fn(async (key: string, value: unknown) => { h.store[key] = value; }),
}));
vi.mock("@/lib/openclaw-config", () => ({
  CONFIG_PATH: "/home/clawbox/.openclaw/openclaw.json",
  OPENCLAW_HOME: "/home/clawbox/.openclaw",
  findOpenclawBin: () => h.bin,
  gatewayIsAbsent: () => h.edition === "hermes",
}));
vi.mock("@/lib/x64-integration", async (original) => {
  const actual = await original<typeof import("@/lib/x64-integration")>();
  return { ...actual, x64IntegrationNpmPrefix: () => actual.x64IntegrationNpmPrefix(h.envFile) };
});
vi.mock("@/lib/openclaw-state-store", () => ({ openclawStateDir: (home: string) => home }));
vi.mock("@/lib/updater", () => ({ updateInFlight: async () => h.updating }));
vi.mock("@/lib/coding-run-unit", () => ({
  probeSystemdRun: async () => h.probe,
  scopeEnv: (base: Record<string, string>) => ({ ...base, XDG_RUNTIME_DIR: "/run/user/1000" }),
}));

import {
  DB_MAINTENANCE_KEY,
  DbMaintenanceScheduleError,
  dbMaintenanceRunning,
  normaliseDbMaintenanceSchedule,
  readDbMaintenanceSchedule,
  readDbMaintenanceStatus,
  startDbMaintenance,
  writeDbMaintenanceSchedule,
} from "@/lib/openclaw-db-maintenance";
import {
  computeNextDbMaintenanceMs,
  nextRunAtMs,
  refresh as refreshScheduler,
  start as startScheduler,
  stop as stopScheduler,
} from "@/lib/openclaw-db-maintenance-scheduler";

const recordPath = () => path.join(h.root, "data", "openclaw-db-maintenance.json");

/**
 * A live process whose command line names the helper, as a run's does
 * (`python3 -I .../openclaw-db-maintenance.py maintain ...`). The real spawn:
 * this suite mocks child_process for the module under test.
 */
let standIns: ChildProcess[] = [];
async function liveHelperPid(): Promise<number> {
  const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "openclaw-db-maintenance.py", "maintain"], { stdio: "ignore" });
  standIns.push(child);
  return child.pid as number;
}

/** A pid nothing can hold: above Linux's largest possible pid_max (2^22). */
function deadPid(): number {
  return 2 ** 22 + 12345;
}

beforeEach(() => {
  mkdirSync(path.join(h.root, "data"), { recursive: true });
  for (const k of Object.keys(h.store)) delete h.store[k];
  h.edition = "openclaw";
  h.updating = false;
  h.probe = { available: true, path: "/usr/bin/systemd-run", detail: null };
  h.execFile.mockReset();
  h.spawn.mockReset();
  h.bin = "/home/clawbox/.npm-global/bin/openclaw";
  h.envFile = path.join(h.root, "etc", "x64-integration.env");
});

afterEach(() => {
  for (const child of standIns) child.kill("SIGKILL");
  standIns = [];
  stopScheduler();
  rmSync(h.root, { recursive: true, force: true });
});

describe("the nightly schedule", () => {
  it("is OFF until the owner turns it on, with 04:30 local as the suggested time, and ignores a malformed value", async () => {
    // A box that never saved a choice — a fresh install, an update from a
    // build whose default was on, a factory reset — has no record at all.
    expect(h.store[DB_MAINTENANCE_KEY]).toBeUndefined();
    expect(await readDbMaintenanceSchedule()).toEqual({ enabled: false, time: "04:30" });
    expect(normaliseDbMaintenanceSchedule(undefined)).toEqual({ enabled: false, time: "04:30" });
    expect(normaliseDbMaintenanceSchedule(null)).toEqual({ enabled: false, time: "04:30" });
    expect(normaliseDbMaintenanceSchedule({ enabled: "yes", time: "25:00" })).toEqual({ enabled: false, time: "04:30" });
    expect(normaliseDbMaintenanceSchedule({ enabled: 1, time: "04:30" })).toEqual({ enabled: false, time: "04:30" });
    expect(normaliseDbMaintenanceSchedule({ time: "02:15" })).toEqual({ enabled: false, time: "02:15" });
    expect(normaliseDbMaintenanceSchedule({ enabled: false, time: "02:15" })).toEqual({ enabled: false, time: "02:15" });
  });

  it("keeps an owner's own saved enabled:true", async () => {
    h.store[DB_MAINTENANCE_KEY] = { enabled: true, time: "02:15" };
    expect(await readDbMaintenanceSchedule()).toEqual({ enabled: true, time: "02:15" });
  });

  it("writes only a valid switch and HH:MM, keeping the half it was not given", async () => {
    // A time alone never switches it on.
    expect(await writeDbMaintenanceSchedule({ time: "03:45" })).toEqual({ enabled: false, time: "03:45" });
    expect(await writeDbMaintenanceSchedule({ enabled: true })).toEqual({ enabled: true, time: "03:45" });
    expect(await writeDbMaintenanceSchedule({ time: "02:00" })).toEqual({ enabled: true, time: "02:00" });
    expect(await writeDbMaintenanceSchedule({ enabled: false })).toEqual({ enabled: false, time: "02:00" });
    expect(h.store[DB_MAINTENANCE_KEY]).toEqual({ enabled: false, time: "02:00" });
    await expect(writeDbMaintenanceSchedule({ time: "3:45pm" })).rejects.toBeInstanceOf(DbMaintenanceScheduleError);
    await expect(writeDbMaintenanceSchedule({ enabled: 1 })).rejects.toBeInstanceOf(DbMaintenanceScheduleError);
  });

  it("fires at the next local HH:MM — later today, or tomorrow once it has passed — and never when off", () => {
    const now = new Date(2026, 9, 26, 3, 0, 0);
    expect(new Date(computeNextDbMaintenanceMs({ enabled: true, time: "04:30" }, now))).toEqual(new Date(2026, 9, 26, 4, 30, 0));
    expect(new Date(computeNextDbMaintenanceMs({ enabled: true, time: "02:00" }, now))).toEqual(new Date(2026, 9, 27, 2, 0, 0));
    expect(computeNextDbMaintenanceMs({ enabled: false, time: "04:30" }, now)).toBe(0);
  });
});

describe("the scheduler's boot hook", () => {
  it("arms nothing on a box whose owner never saved a choice", async () => {
    await startScheduler();
    expect(nextRunAtMs()).toBe(0);
    h.store[DB_MAINTENANCE_KEY] = { enabled: false, time: "04:30" };
    await refreshScheduler();
    expect(nextRunAtMs()).toBe(0);
  });

  it("arms the nightly slot once the owner turns it on, and disarms it when they turn it off", async () => {
    h.store[DB_MAINTENANCE_KEY] = { enabled: true, time: "04:30" };
    await startScheduler();
    const armed = nextRunAtMs();
    expect(armed).toBeGreaterThan(Date.now());
    expect(armed).toBe(computeNextDbMaintenanceMs({ enabled: true, time: "04:30" }, new Date()));
    h.store[DB_MAINTENANCE_KEY] = { enabled: false, time: "04:30" };
    await refreshScheduler();
    expect(nextRunAtMs()).toBe(0);
  });
});

describe("dbMaintenanceRunning — what startUpdate asks", () => {
  it("is true while the run's own process is alive, by its run record or its hold on the gateway", async () => {
    const pid = await liveHelperPid();
    writeFileSync(recordPath(), JSON.stringify({ run: { pid, phase: "compacting" } }));
    expect(dbMaintenanceRunning()).toBe(true);
    writeFileSync(recordPath(), JSON.stringify({ hold: { pid, stopped: true } }));
    expect(dbMaintenanceRunning()).toBe(true);
  });

  it("is false for a hold a finished run left behind once its pid is another process's", () => {
    // A run whose gateway did not come back keeps `hold` for the next run;
    // pid 1 (alive, EPERM) and this process stand for a reused pid.
    writeFileSync(recordPath(), JSON.stringify({ hold: { pid: 1, stopped: true }, lastRun: { outcome: "compacted", gatewayRestarted: false } }));
    expect(dbMaintenanceRunning()).toBe(false);
    writeFileSync(recordPath(), JSON.stringify({ run: { pid: process.pid } }));
    expect(dbMaintenanceRunning()).toBe(false);
  });

  it("is false for a run that is gone, a record without one, or no record at all", () => {
    writeFileSync(recordPath(), JSON.stringify({ run: { pid: deadPid() }, hold: { pid: deadPid() } }));
    expect(dbMaintenanceRunning()).toBe(false);
    writeFileSync(recordPath(), JSON.stringify({ lastRun: { outcome: "compacted" } }));
    expect(dbMaintenanceRunning()).toBe(false);
    writeFileSync(recordPath(), "{torn");
    expect(dbMaintenanceRunning()).toBe(false);
    rmSync(recordPath());
    expect(dbMaintenanceRunning()).toBe(false);
  });
});

describe("startDbMaintenance", () => {
  it("starts the helper's `maintain` in a transient user unit of its own, which a web-server restart does not stop", async () => {
    h.execFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (e: Error | null, o: string, e2: string) => void) => cb(null, "", ""));
    // "Run now" is the owner's own call: it starts with the nightly switch off.
    h.store[DB_MAINTENANCE_KEY] = { enabled: false, time: "04:30" };
    const start = await startDbMaintenance("manual");
    expect(start).toEqual({ started: true, survivesRestart: true });
    expect(h.execFile).toHaveBeenCalledTimes(1);
    const [bin, args] = h.execFile.mock.calls[0];
    expect(bin).toBe("/usr/bin/systemd-run");
    expect(args.slice(0, 4)).toEqual(["--user", "--unit=clawbox-openclaw-db-maintenance", "--collect", "--quiet"]);
    const command = args.slice(args.indexOf("--") + 1);
    expect(command.slice(0, 6)).toEqual([
      "/usr/bin/env", "python3", "-I", path.join(h.root, "scripts", "openclaw-db-maintenance.py"), "maintain", "--trigger",
    ]);
    expect(command).toContain("manual");
    expect(command.join(" ")).toContain(`--data-dir ${h.root}/data`);
    expect(command.join(" ")).toContain("--openclaw-bin /home/clawbox/.npm-global/bin/openclaw");
    expect(command.join(" ")).toContain("--core-pkg /home/clawbox/.npm-global/lib/node_modules/openclaw/package.json");
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("answers already_running when systemd says the unit is still there", async () => {
    // systemd's own words for a second start while the first run goes (captured).
    h.execFile.mockImplementation((_b: string, _a: string[], _o: unknown, cb: (e: Error | null, o: string, e2: string) => void) =>
      cb(new Error("exit 1"), "", "Failed to start transient service unit: Unit clawbox-openclaw-db-maintenance.service was already loaded or has a fragment file."));
    expect(await startDbMaintenance("scheduled")).toEqual({ started: false, code: "already_running" });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("starts it as a detached child — and says so — on a box with no user manager", async () => {
    h.probe = { available: false, path: null as unknown as string, detail: "no user manager" };
    h.spawn.mockReturnValue({ on: vi.fn(), unref: vi.fn() });
    expect(await startDbMaintenance("scheduled")).toEqual({ started: true, survivesRestart: false });
    const [bin, args, opts] = h.spawn.mock.calls[0];
    expect(bin).toBe("python3");
    expect(args.slice(2, 5)).toEqual(["maintain", "--trigger", "scheduled"]);
    expect(opts).toMatchObject({ detached: true, stdio: "ignore" });
  });

  it("refuses without starting anything on a box with no OpenClaw, under an update, or beside a live run", async () => {
    h.edition = "hermes";
    expect(await startDbMaintenance("scheduled")).toEqual({ started: false, code: "no_openclaw" });
    h.edition = "openclaw";
    h.updating = true;
    expect(await startDbMaintenance("scheduled")).toEqual({ started: false, code: "update_in_progress" });
    h.updating = false;
    writeFileSync(recordPath(), JSON.stringify({ run: { pid: await liveHelperPid() } }));
    expect(await startDbMaintenance("manual")).toEqual({ started: false, code: "already_running" });
    expect(h.execFile).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
  });
});

describe("readDbMaintenanceStatus", () => {
  it("says the schedule is off with no next check on a box whose owner never turned it on", async () => {
    h.execFile.mockImplementation((_b: string, _a: string[], _o: unknown, cb: (e: Error | null, o: string, e2: string) => void) =>
      cb(null, JSON.stringify({ core: "2026.10.6", supported: true, databases: [] }), ""));
    const status = await readDbMaintenanceStatus();
    expect(status.schedule).toEqual({ enabled: false, time: "04:30" });
    expect(status.nextRunAt).toBeNull();
  });

  it("reads the helper's read-only `status --json`, with the owner's schedule", async () => {
    h.store[DB_MAINTENANCE_KEY] = { enabled: true, time: "04:30" };
    const report = {
      core: "2026.10.6", supported: true, totalBytes: 8_000_000_000, diskFreeBytes: 20_000_000_000,
      databases: [{ key: "agent:main", label: "agent main", kind: "agent", agentId: "main", bytes: 8_000_000_000, needs: "37% free pages" }],
      running: null, lastRun: { outcome: "compacted", beforeBytes: 8_000_000_000, afterBytes: 5_000_000_000 },
    };
    h.execFile.mockImplementation((_b: string, _a: string[], _o: unknown, cb: (e: Error | null, o: string, e2: string) => void) => cb(null, JSON.stringify(report), ""));
    const status = await readDbMaintenanceStatus();
    const [bin, args] = h.execFile.mock.calls[0];
    expect(bin).toBe("python3");
    expect(args.slice(2, 4)).toEqual(["status", "--json"]);
    expect(status).toMatchObject({
      available: true, core: "2026.10.6", supported: true, totalBytes: 8_000_000_000,
      schedule: { enabled: true, time: "04:30" },
      lastRun: { outcome: "compacted" },
    });
    expect(status.databases[0]).toMatchObject({ key: "agent:main", needs: "37% free pages" });
    expect(typeof status.nextRunAt).toBe("number");
  });

  it("answers not-available on the Hermes edition without running anything", async () => {
    h.edition = "hermes";
    expect(await readDbMaintenanceStatus()).toMatchObject({ available: false, databases: [], schedule: { enabled: false }, nextRunAt: null });
    expect(h.execFile).not.toHaveBeenCalled();
  });
});

// The real one: this suite mocks child_process for the module under test.
const { spawnSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");

describe("the core package.json the helper reads (--core-pkg)", () => {
  const HELPER = path.resolve(process.cwd(), "scripts/openclaw-db-maintenance.py");
  const hasPython3 = (() => {
    try {
      return spawnSync("python3", ["--version"]).status === 0;
    } catch {
      return false;
    }
  })();
  const okStatus = () => h.execFile.mockImplementation((_b: string, _a: string[], _o: unknown, cb: (e: Error | null, o: string, e2: string) => void) =>
    cb(null, JSON.stringify({ core: null, supported: false, databases: [] }), ""));
  const statusArgs = async (): Promise<string[]> => {
    okStatus();
    await readDbMaintenanceStatus();
    return h.execFile.mock.calls[0][1] as string[];
  };
  const opt = (args: string[], name: string) => args[args.indexOf(name) + 1];
  const writePkg = (prefix: string, version: string) => {
    const dir = path.join(prefix, "lib", "node_modules", "openclaw");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "openclaw", version, openclaw: { schemaVersions: { state: 3, agent: 5 } } }));
    return path.join(dir, "package.json");
  };
  /** The desktop integration: ~/.npm-global/bin/openclaw is a link to its wrapper, and the core is under NPM_PREFIX. */
  const desktopIntegration = (prefix: string, prefixLine = `NPM_PREFIX=${prefix}`) => {
    const npmBin = path.join(h.root, "home", ".npm-global", "bin");
    const libexec = path.join(h.root, "libexec");
    mkdirSync(npmBin, { recursive: true });
    mkdirSync(libexec, { recursive: true });
    writeFileSync(path.join(libexec, "openclaw-cli"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
    symlinkSync(path.join(libexec, "openclaw-cli"), path.join(npmBin, "openclaw"));
    h.bin = path.join(npmBin, "openclaw");
    mkdirSync(path.dirname(h.envFile), { recursive: true });
    writeFileSync(h.envFile, [
      "INSTALL_USER=fixture", `INSTALL_HOME=${path.join(h.root, "home")}`, "PROJECT_DIR=/fixture/clawbox",
      "NODE_DIR=/fixture/node/bin", prefixLine, "",
    ].join("\n"));
    return path.join(h.root, "home", ".npm-global", "lib", "node_modules", "openclaw", "package.json");
  };
  /** The helper's own read-only `status --json` over an empty state, with the args the web server built. */
  const realStatus = (args: string[]) => {
    const state = path.join(h.root, "state");
    mkdirSync(state, { recursive: true });
    const real = [...args];
    real[real.indexOf("status") - 1] = HELPER;
    real[real.indexOf("--state-dir") + 1] = state;
    real[real.indexOf("--config") + 1] = path.join(state, "openclaw.json");
    const run = spawnSync("python3", real, { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    return JSON.parse(run.stdout) as { core: string | null; supported: boolean };
  };

  it("is the one beside the binary's npm prefix on the appliance layout, exactly as before, whatever a host file says", async () => {
    const npmGlobal = path.join(h.root, "home", ".npm-global");
    const pkg = writePkg(npmGlobal, "2026.10.6");
    mkdirSync(path.join(npmGlobal, "bin"), { recursive: true });
    h.bin = path.join(npmGlobal, "bin", "openclaw");
    const args = await statusArgs();
    expect(args.slice(args.indexOf("--openclaw-bin"))).toEqual([
      "--openclaw-bin", h.bin, "--core-pkg", path.join(npmGlobal, "bin", "..", "lib", "node_modules", "openclaw", "package.json"),
    ]);
    expect(opt(args, "--core-pkg")).toBe(pkg);
    // A desktop integration's host file does not move a core that is where the binary says.
    const other = writePkg(path.join(h.root, "other-prefix"), "2026.10.9");
    mkdirSync(path.dirname(h.envFile), { recursive: true });
    writeFileSync(h.envFile, `NPM_PREFIX=${path.join(h.root, "other-prefix")}\n`);
    h.execFile.mockReset();
    expect(opt(await statusArgs(), "--core-pkg")).toBe(pkg);
    expect(opt(await statusArgs(), "--core-pkg")).not.toBe(other);
  });

  it("keeps the appliance's path for a binary with no package beside it, as before (startDbMaintenance)", async () => {
    h.execFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (e: Error | null, o: string, e2: string) => void) => cb(null, "", ""));
    await startDbMaintenance("manual");
    const args = h.execFile.mock.calls[0][1] as string[];
    expect(opt(args, "--core-pkg")).toBe("/home/clawbox/.npm-global/lib/node_modules/openclaw/package.json");
  });

  it("is the desktop integration's NPM_PREFIX core when the binary is its wrapper, for status and for a run", async () => {
    const prefix = path.join(h.root, "desktop-prefix");
    const pkg = writePkg(prefix, "2026.10.9");
    desktopIntegration(prefix);
    expect(opt(await statusArgs(), "--core-pkg")).toBe(pkg);
    expect(opt(await statusArgs(), "--openclaw-bin")).toBe(h.bin);
    h.execFile.mockReset();
    h.execFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (e: Error | null, o: string, e2: string) => void) => cb(null, "", ""));
    await startDbMaintenance("manual");
    const command = h.execFile.mock.calls[0][1] as string[];
    expect(opt(command, "--core-pkg")).toBe(pkg);
  });

  it("reads a prefix the package's shlex.quote single-quoted", async () => {
    const prefix = path.join(h.root, "desktop prefix");
    const pkg = writePkg(prefix, "2026.10.9");
    desktopIntegration(prefix, `NPM_PREFIX='${prefix}'`);
    expect(opt(await statusArgs(), "--core-pkg")).toBe(pkg);
  });

  it("parses the host file as text: the last NPM_PREFIX, CRLF lines, shlex's two forms, and nothing else", async () => {
    const { x64IntegrationNpmPrefix } = await vi.importActual<typeof import("@/lib/x64-integration")>("@/lib/x64-integration");
    const file = path.join(h.root, "parse.env");
    const read = (text: string) => {
      writeFileSync(file, text);
      return x64IntegrationNpmPrefix(file);
    };
    expect(read("NPM_PREFIX=/opt/a\nNPM_PREFIX=/opt/b\n")).toBe("/opt/b");
    expect(read("INSTALL_USER=fixture\r\nNPM_PREFIX=/opt/crlf\r\n")).toBe("/opt/crlf");
    expect(read("NPM_PREFIX='/opt/with space'\n")).toBe("/opt/with space");
    expect(read("NPM_PREFIX=/opt/with space\n")).toBeNull();
    expect(read("NPM_PREFIX='/opt/it'\"'\"'s'\n")).toBeNull();
    expect(read("NPM_PREFIX=\"/opt/double\"\n")).toBeNull();
    expect(read("NPM_PREFIX=\n")).toBeNull();
    expect(read(" NPM_PREFIX=/opt/indented\n")).toBeNull();
    expect(read(`NPM_PREFIX=/opt/${"x".repeat(5000)}\n`)).toBeNull();
    symlinkSync(file, path.join(h.root, "link.env"));
    writeFileSync(file, "NPM_PREFIX=/opt/through-a-link\n");
    expect(x64IntegrationNpmPrefix(path.join(h.root, "link.env"))).toBeNull();
    expect(x64IntegrationNpmPrefix(path.join(h.root, "absent.env"))).toBeNull();
  });

  it.skipIf(!hasPython3)("reads back what the integration package's writer emits (build-package.py: k=shlex.quote(v))", async () => {
    const { x64IntegrationNpmPrefix } = await vi.importActual<typeof import("@/lib/x64-integration")>("@/lib/x64-integration");
    const writer = "import shlex, sys\nhost = dict(INSTALL_USER='fixture', NPM_PREFIX=sys.argv[1], NODE_DIR='/opt/node/bin')\n"
      + "open(sys.argv[2], 'w').write(''.join(f'{k}={shlex.quote(v)}\\n' for k, v in host.items()))\n";
    const file = path.join(h.root, "written.env");
    for (const prefix of ["/opt/fixture/.npm-global", "/opt/fixture user/.npm-global", "/srv/a+b@c/.npm-global"]) {
      const run = spawnSync("python3", ["-I", "-c", writer, prefix, file], { encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      expect(x64IntegrationNpmPrefix(file), prefix).toBe(prefix);
    }
  });

  it.skipIf(!hasPython3)("lets the helper see a 2026.10 core on the desktop integration: supported", async () => {
    const prefix = path.join(h.root, "desktop-prefix");
    writePkg(prefix, "2026.10.9");
    desktopIntegration(prefix);
    expect(realStatus(await statusArgs())).toMatchObject({ core: "2026.10.9", supported: true });
  });

  it("keeps today's path when the host file is missing, unreadable, names no usable prefix, or a prefix with no core", async () => {
    const prefix = path.join(h.root, "desktop-prefix");
    writePkg(prefix, "2026.10.9");
    const today = desktopIntegration(prefix);
    const cases: Array<[string, () => void]> = [
      ["missing", () => {}],
      ["unreadable (a directory)", () => mkdirSync(h.envFile)],
      ["no NPM_PREFIX", () => writeFileSync(h.envFile, "INSTALL_USER=fixture\nPROJECT_DIR=/fixture/clawbox\n")],
      ["a relative prefix", () => writeFileSync(h.envFile, "NPM_PREFIX=desktop-prefix\n")],
      ["shell code, never run", () => writeFileSync(h.envFile, `NPM_PREFIX=$(touch ${path.join(h.root, "ran")})${prefix}\n`)],
      ["a prefix with no core", () => writeFileSync(h.envFile, `NPM_PREFIX=${path.join(h.root, "empty-prefix")}\n`)],
    ];
    for (const [name, arrange] of cases) {
      rmSync(h.envFile, { recursive: true, force: true });
      arrange();
      h.execFile.mockReset();
      expect(opt(await statusArgs(), "--core-pkg"), name).toBe(today);
    }
    expect(existsSync(path.join(h.root, "ran"))).toBe(false);
    if (hasPython3) expect(realStatus(await statusArgs())).toMatchObject({ core: null, supported: false });
  });
});
