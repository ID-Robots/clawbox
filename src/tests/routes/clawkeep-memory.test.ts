import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TASK-398: the three routes behind the ClawKeep memory panel.
 *
 * Driven through the REAL route handlers, not through the lib, because the
 * contract that matters here is what crosses the HTTP boundary: the status
 * codes, and the fact that no path, provider error or CLI output rides along.
 */

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-memory-route-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "clawkeep");

// The schedule route re-arms the in-process scheduler after each PUT. Stub it
// so the suite does not leak a real timer, and so we can assert the re-arm
// happened — a saved schedule that only takes effect at the next reboot is the
// bug this panel is meant to make impossible.
vi.mock("@/lib/clawkeep-memory-scheduler", () => ({
  start: vi.fn(async () => {}),
  refresh: vi.fn(async () => {}),
  nextRunAtMs: vi.fn(() => 0),
}));

let statusGET: typeof import("@/app/setup-api/clawkeep/memory/route").GET;
let indexPOST: typeof import("@/app/setup-api/clawkeep/memory/index/route").POST;
let scheduleGET: typeof import("@/app/setup-api/clawkeep/memory/schedule/route").GET;
let schedulePUT: typeof import("@/app/setup-api/clawkeep/memory/schedule/route").PUT;
let scheduler: typeof import("@/lib/clawkeep-memory-scheduler");

beforeAll(async () => {
  process.env.CLAWKEEP_DATA_DIR = DATA_DIR;
  // A binary that exits non-zero with no output: the status probe must turn
  // that into an explicit "unavailable", never into a 500.
  process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = "false";
  await fs.mkdir(DATA_DIR, { recursive: true });
  statusGET = (await import("@/app/setup-api/clawkeep/memory/route")).GET;
  indexPOST = (await import("@/app/setup-api/clawkeep/memory/index/route")).POST;
  const sched = await import("@/app/setup-api/clawkeep/memory/schedule/route");
  scheduleGET = sched.GET;
  schedulePUT = sched.PUT;
  scheduler = await import("@/lib/clawkeep-memory-scheduler");
});

afterAll(async () => {
  delete process.env.CLAWKEEP_DATA_DIR;
  delete process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  await fs.rm(path.join(DATA_DIR, "memory-index-schedule.json"), { force: true });
  await fs.rm(path.join(DATA_DIR, "memory-index-state.json"), { force: true });
  await fs.rm(path.join(DATA_DIR, "memory-index.lock"), { recursive: true, force: true });
});

function put(body: unknown): NextRequest {
  return new NextRequest("http://localhost/setup-api/clawkeep/memory/schedule", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /setup-api/clawkeep/memory", () => {
  it("answers 200 with an explicit unavailable status when the CLI cannot be read", async () => {
    const res = await statusGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(false);
    expect(body.health).toBe("unavailable");
    // A panel that renders "unavailable" is useful. An error toast tells the
    // owner nothing about their index.
    expect(body.error).toBeTruthy();
  });

  it("is never cached, so the panel cannot show a stale index", async () => {
    const res = await statusGET();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("PUT /setup-api/clawkeep/memory/schedule", () => {
  it("persists a schedule and re-arms the scheduler in the same request", async () => {
    const res = await schedulePUT(put({ enabled: true, frequency: "weekly", timeOfDay: "04:15", weekday: 3 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schedule).toEqual({ enabled: true, frequency: "weekly", timeOfDay: "04:15", weekday: 3 });
    expect(body.nextRunAtMs).toBeGreaterThan(Date.now());
    expect(scheduler.refresh).toHaveBeenCalledTimes(1);
  });

  it("survives being read back, which is what a reboot does", async () => {
    await schedulePUT(put({ enabled: true, frequency: "daily", timeOfDay: "02:45", weekday: 0 }));
    const body = await (await scheduleGET()).json();
    expect(body.schedule.enabled).toBe(true);
    expect(body.schedule.timeOfDay).toBe("02:45");
  });

  it("does not persist an impossible time as if it were valid", async () => {
    const body = await (await schedulePUT(put({ enabled: true, timeOfDay: "25:99" }))).json();
    expect(body.schedule.timeOfDay).toBe("03:00");
    expect(body.nextRunAtMs).toBeGreaterThan(0);
  });
});

describe("POST /setup-api/clawkeep/memory/index", () => {
  it("declines a second run instead of starting one, and says so with 409", async () => {
    // Pin the box down as mid-run: the lock exists and the state file names a
    // live pid (this process), which is what a real in-flight index looks like.
    await fs.mkdir(path.join(DATA_DIR, "memory-index.lock"), { recursive: true });
    await fs.writeFile(path.join(DATA_DIR, "memory-index-state.json"), JSON.stringify({
      status: "running", mode: "full", trigger: "manual",
      startedAtMs: Date.now(), finishedAtMs: 0, durationMs: 0, error: "", childPid: process.pid,
    }));
    const res = await indexPOST(new NextRequest("http://localhost/x", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "full" }),
    }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.accepted).toBe(false);
    expect(body.run.status).toBe("running");
    // No status payload on this path: attaching it made every accept/decline
    // pay for a fresh 90s-bounded CLI probe on an 8 GB box, and the panel
    // refetches the status straight afterwards anyway.
    expect(body.status).toBeUndefined();
  });

  it("declines an incremental request at once too, without asking the CLI anything", async () => {
    // The incremental path used to resolve its mode — a status probe — BEFORE
    // the single-flight check. With the cache dropped by the run in flight,
    // that probe took as long as the run itself; by the time it answered the
    // first run had finished and a second one started over its record.
    const marker = path.join(TEST_ROOT, "probed");
    const script = path.join(TEST_ROOT, "probing-openclaw");
    await fs.writeFile(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\necho '[]'\n`, { mode: 0o755 });
    process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = script;
    try {
      await fs.mkdir(path.join(DATA_DIR, "memory-index.lock"), { recursive: true });
      await fs.writeFile(path.join(DATA_DIR, "memory-index-state.json"), JSON.stringify({
        status: "running", mode: "full", trigger: "manual",
        startedAtMs: Date.now(), finishedAtMs: 0, durationMs: 0, error: "", childPid: process.pid,
      }));
      const started = performance.now();
      const res = await indexPOST(new NextRequest("http://localhost/x", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "incremental" }),
      }));
      expect(res.status).toBe(409);
      // Generous on purpose — a loaded runner must not fail a correct route
      // on timing; the assertion that matters is the absent marker below.
      expect(performance.now() - started).toBeLessThan(5_000);
      expect((await res.json()).run.status).toBe("running");
      await new Promise((r) => setTimeout(r, 100));
      expect(await fs.stat(marker).then(() => true, () => false)).toBe(false);
    } finally {
      process.env.CLAWKEEP_MEMORY_OPENCLAW_BIN = "false";
    }
  });

  it("never returns the pid it is running under", async () => {
    await fs.mkdir(path.join(DATA_DIR, "memory-index.lock"), { recursive: true });
    await fs.writeFile(path.join(DATA_DIR, "memory-index-state.json"), JSON.stringify({
      status: "running", mode: "incremental", trigger: "schedule",
      startedAtMs: Date.now(), finishedAtMs: 0, durationMs: 0, error: "", childPid: process.pid,
    }));
    const res = await indexPOST(new NextRequest("http://localhost/x", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }));
    expect(JSON.stringify(await res.json())).not.toContain(String(process.pid));
  });
});
