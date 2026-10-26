import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  findOpenclawBin: () => "/home/clawbox/.npm-global/bin/openclaw",
  gatewayIsAbsent: () => h.edition === "hermes",
}));
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
import { computeNextDbMaintenanceMs, stop as stopScheduler } from "@/lib/openclaw-db-maintenance-scheduler";

const recordPath = () => path.join(h.root, "data", "openclaw-db-maintenance.json");

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
});

afterEach(() => {
  stopScheduler();
  rmSync(h.root, { recursive: true, force: true });
});

describe("the nightly schedule", () => {
  it("is on at 04:30 local until the owner says otherwise, and ignores a malformed value", async () => {
    expect(await readDbMaintenanceSchedule()).toEqual({ enabled: true, time: "04:30" });
    expect(normaliseDbMaintenanceSchedule({ enabled: "yes", time: "25:00" })).toEqual({ enabled: true, time: "04:30" });
    expect(normaliseDbMaintenanceSchedule({ enabled: false, time: "02:15" })).toEqual({ enabled: false, time: "02:15" });
  });

  it("writes only a valid switch and HH:MM, keeping the half it was not given", async () => {
    expect(await writeDbMaintenanceSchedule({ time: "03:45" })).toEqual({ enabled: true, time: "03:45" });
    expect(await writeDbMaintenanceSchedule({ enabled: false })).toEqual({ enabled: false, time: "03:45" });
    expect(h.store[DB_MAINTENANCE_KEY]).toEqual({ enabled: false, time: "03:45" });
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

describe("dbMaintenanceRunning — what startUpdate asks", () => {
  it("is true while the run's own process is alive, by its run record or its hold on the gateway", () => {
    writeFileSync(recordPath(), JSON.stringify({ run: { pid: process.pid, phase: "compacting" } }));
    expect(dbMaintenanceRunning()).toBe(true);
    writeFileSync(recordPath(), JSON.stringify({ hold: { pid: process.pid, stopped: true } }));
    expect(dbMaintenanceRunning()).toBe(true);
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
    writeFileSync(recordPath(), JSON.stringify({ run: { pid: process.pid } }));
    expect(await startDbMaintenance("manual")).toEqual({ started: false, code: "already_running" });
    expect(h.execFile).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
  });
});

describe("readDbMaintenanceStatus", () => {
  it("reads the helper's read-only `status --json`, with the owner's schedule", async () => {
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
    expect(await readDbMaintenanceStatus()).toMatchObject({ available: false, databases: [] });
    expect(h.execFile).not.toHaveBeenCalled();
  });
});
