import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// The two harnesses' own records of their scheduled jobs, as the alerts read
// them (src/lib/job-alerts-sources.ts). The fixtures are the shapes read off
// boards: OpenClaw 2026.10.9's `cron.list` rows and Hermes' `cron/jobs.json`.

vi.mock("@/lib/openclaw-gateway-ws", () => ({ gatewayWsCall: vi.fn() }));

import {
  cleanJobName,
  hermesJob,
  openclawJob,
  readHermesJobs,
  readOpenclawJobs,
} from "@/lib/job-alerts-sources";
import { gatewayWsCall } from "@/lib/openclaw-gateway-ws";

const NOW = Date.parse("2026-11-05T12:00:00Z");

const HEARTBEAT = {
  id: "3bb60934-1082-4410-87b8-4be287870a89",
  name: "heartbeat-main",
  enabled: true,
  declarationKey: "heartbeat:main",
  schedule: { kind: "every", everyMs: 1_800_000 },
  payload: { kind: "heartbeat" },
  state: { lastRunStatus: "skipped", consecutiveSkipped: 3, lastError: "heartbeat skipped: no-route" },
};

const COMMAND_JOB = {
  id: "5f0c",
  name: "Job alerts test",
  enabled: true,
  schedule: { kind: "every", everyMs: 120_000 },
  payload: { kind: "command", argv: ["sh", "-lc", "exit 1"] },
  delivery: { mode: "none" },
  state: {
    nextRunAtMs: NOW + 60_000,
    lastRunAtMs: NOW - 60_000,
    lastRunStatus: "error",
    lastStatus: "error",
    lastError: "command exited with code 1",
    consecutiveErrors: 2,
    consecutiveSkipped: 0,
  },
};

describe("openclawJob", () => {
  it("reads a failing command job's run state", () => {
    expect(openclawJob(COMMAND_JOB)).toEqual({
      id: "5f0c",
      name: "Job alerts test",
      timed: true,
      lastStatus: "error",
      lastRunAtMs: NOW - 60_000,
      nextRunAtMs: NOW + 60_000,
      running: false,
      consecutiveErrors: 2,
      consecutiveSkipped: 0,
      stopped: false,
      error: "command exited with code 1",
    });
  });

  it("leaves out the heartbeat — skipping is how it works — and a job the owner disabled", () => {
    expect(openclawJob(HEARTBEAT)).toBeNull();
    expect(openclawJob({ ...COMMAND_JOB, enabled: false })).toBeNull();
  });

  it("keeps a job the scheduler disabled after repeated failures, as stopped", () => {
    const job = openclawJob({
      ...COMMAND_JOB,
      enabled: false,
      state: { ...COMMAND_JOB.state, autoDisabled: { reason: "consecutive-failures", atMs: NOW, consecutiveErrors: 10 } },
    });
    expect(job).toMatchObject({ stopped: true, consecutiveErrors: 2 });
  });

  it("a running job says so, and a stream or trigger job has no clock", () => {
    expect(openclawJob({ ...COMMAND_JOB, state: { ...COMMAND_JOB.state, runningAtMs: NOW } })?.running).toBe(true);
    expect(openclawJob({ ...COMMAND_JOB, schedule: { kind: "stream" } })?.timed).toBe(false);
  });

  it("refuses rows it cannot address", () => {
    expect(openclawJob(null)).toBeNull();
    expect(openclawJob({ name: "no id" })).toBeNull();
    expect(openclawJob([COMMAND_JOB])).toBeNull();
  });
});

describe("readOpenclawJobs", () => {
  beforeEach(() => vi.mocked(gatewayWsCall).mockReset());

  it("asks for every job, disabled included, and follows the pages", async () => {
    vi.mocked(gatewayWsCall)
      .mockResolvedValueOnce({ jobs: [HEARTBEAT, COMMAND_JOB], hasMore: true, nextOffset: 2 })
      .mockResolvedValueOnce({ jobs: [{ ...COMMAND_JOB, id: "second" }], hasMore: false, nextOffset: null });
    const source = await readOpenclawJobs();
    expect(source.reachable).toBe(true);
    expect(source.jobs.map((j) => j.id)).toEqual(["5f0c", "second"]);
    expect(vi.mocked(gatewayWsCall).mock.calls[0].slice(0, 2)).toEqual(["cron.list", { includeDisabled: true, limit: 200, offset: 0 }]);
    expect(vi.mocked(gatewayWsCall).mock.calls[1][1]).toMatchObject({ offset: 2 });
  });

  it("a gateway that does not answer is UNREACHABLE, never an empty list", async () => {
    vi.mocked(gatewayWsCall).mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    expect(await readOpenclawJobs()).toEqual({ runtime: "openclaw", reachable: false, jobs: [] });
    info.mockRestore();
  });
});

describe("hermesJob", () => {
  const ENTRY = {
    id: "a1b2c3",
    name: "Job alerts test",
    schedule: { kind: "interval", minutes: 2, display: "every 2m" },
    enabled: true,
    state: "scheduled",
    next_run_at: "2026-11-05T12:01:54.689834+00:00",
    last_run_at: "2026-11-05T11:59:54.689834+00:00",
    last_status: "error",
    last_error: "Script exited with code 1",
    failure_streak: 3,
    fire_claim: null,
  };

  it("reads Hermes' microsecond timestamps and its failure streak", () => {
    expect(hermesJob(ENTRY, NOW)).toEqual({
      id: "a1b2c3",
      name: "Job alerts test",
      timed: true,
      lastStatus: "error",
      lastRunAtMs: Date.parse("2026-11-05T11:59:54.689Z"),
      nextRunAtMs: Date.parse("2026-11-05T12:01:54.689Z"),
      running: false,
      consecutiveErrors: 3,
      consecutiveSkipped: null,
      stopped: false,
      error: "Script exited with code 1",
    });
  });

  it("a delivery failure is a run that worked", () => {
    expect(hermesJob({ ...ENTRY, last_status: "delivery_failed", failure_streak: 0 }, NOW)?.lastStatus).toBe("ok");
  });

  it("leaves out paused and completed jobs; a recurring job in state error is stopped", () => {
    expect(hermesJob({ ...ENTRY, state: "paused", enabled: false }, NOW)).toBeNull();
    expect(hermesJob({ ...ENTRY, paused_at: "2026-11-05T11:00:00+00:00" }, NOW)).toBeNull();
    expect(hermesJob({ ...ENTRY, state: "completed" }, NOW)).toBeNull();
    expect(hermesJob({ ...ENTRY, state: "error" }, NOW)?.stopped).toBe(true);
  });

  it("a fresh fire claim is a run in flight; a stale one is a crashed run", () => {
    expect(hermesJob({ ...ENTRY, fire_claim: { at: "2026-11-05T11:58:00+00:00", by: "m:1" } }, NOW)?.running).toBe(true);
    expect(hermesJob({ ...ENTRY, fire_claim: { at: "2026-11-05T06:00:00+00:00", by: "m:1" } }, NOW)?.running).toBe(false);
  });
});

describe("readHermesJobs", () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-home-")); });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function writeStore(dir: string, jobs: unknown[]) {
    fs.mkdirSync(path.join(dir, "cron"), { recursive: true });
    fs.writeFileSync(path.join(dir, "cron", "jobs.json"), JSON.stringify({ jobs, updated_at: "2026-11-05T12:00:00+00:00" }));
  }

  it("a home with no cron store has no jobs, and answers", async () => {
    expect(await readHermesJobs(NOW, home)).toEqual({ runtime: "hermes", reachable: true, jobs: [] });
  });

  it("reads the root store and every profile's, the profile's jobs prefixed with its name", async () => {
    writeStore(home, [{ id: "daily-brief", name: "Daily brief", schedule: { kind: "cron" }, enabled: true, last_status: "ok" }]);
    writeStore(path.join(home, "profiles", "coder"), [{ id: "daily-brief", name: "Coder brief", schedule: { kind: "cron" }, enabled: true }]);
    const source = await readHermesJobs(NOW, home);
    expect(source.reachable).toBe(true);
    expect(source.jobs.map((j) => j.id)).toEqual(["daily-brief", "coder/daily-brief"]);
  });

  it("a store that is there but not JSON makes the answer unreachable, not 'no jobs'", async () => {
    fs.mkdirSync(path.join(home, "cron"), { recursive: true });
    fs.writeFileSync(path.join(home, "cron", "jobs.json"), "{\"jobs\": [");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    expect((await readHermesJobs(NOW, home)).reachable).toBe(false);
    info.mockRestore();
  });
});

describe("cleanJobName", () => {
  it("keeps a notice one clean line", () => {
    expect(cleanJobName("  Daily\n\treport  ", "id")).toBe("Daily report");
    expect(cleanJobName("evil\u202etxt.exe", "id")).toBe("evil txt.exe");
    expect(cleanJobName("", "0123456789abcdef")).toBe("0123456789ab");
    expect(cleanJobName("x".repeat(100), "id")).toHaveLength(60);
  });
});
