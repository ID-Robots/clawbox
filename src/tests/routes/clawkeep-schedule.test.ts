import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-schedule-route-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "clawkeep");

// The schedule route calls into the in-process scheduler's `refresh()` after
// each PUT. The scheduler reads the persisted schedule, arms a setTimeout,
// and would otherwise leak a real timer across the test suite — stub it out
// so we can assert it was called and avoid the leak.
vi.mock("@/lib/clawkeep-scheduler", () => ({
  start: vi.fn(async () => {}),
  refresh: vi.fn(async () => {}),
  nextRunAtMs: vi.fn(() => 0),
}));

let GET: typeof import("@/app/setup-api/clawkeep/schedule/route").GET;
let PUT: typeof import("@/app/setup-api/clawkeep/schedule/route").PUT;
let scheduler: typeof import("@/lib/clawkeep-scheduler");
let clawkeep: typeof import("@/lib/clawkeep");

beforeAll(async () => {
  process.env.CLAWKEEP_DATA_DIR = DATA_DIR;
  process.env.CLAWKEEP_CONFIG_PATH = path.join(DATA_DIR, "config.toml");
  await fs.mkdir(DATA_DIR, { recursive: true });
  const route = await import("@/app/setup-api/clawkeep/schedule/route");
  GET = route.GET;
  PUT = route.PUT;
  scheduler = await import("@/lib/clawkeep-scheduler");
  clawkeep = await import("@/lib/clawkeep");
});

afterAll(async () => {
  delete process.env.CLAWKEEP_DATA_DIR;
  delete process.env.CLAWKEEP_CONFIG_PATH;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  for (const entry of await fs.readdir(DATA_DIR).catch(() => [] as string[])) {
    await fs.rm(path.join(DATA_DIR, entry), { recursive: true, force: true });
  }
});

function jsonReq(body: unknown): NextRequest {
  return new NextRequest(new URL("http://localhost/setup-api/clawkeep/schedule"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/setup-api/clawkeep/schedule", () => {
  describe("GET", () => {
    it("returns DEFAULT_SCHEDULE when nothing is persisted", async () => {
      const res = await GET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.schedule).toEqual(clawkeep.DEFAULT_SCHEDULE);
      expect(body.nextRunAtMs).toBe(0);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    });

    it("surfaces a persisted schedule and a non-zero nextRunAtMs", async () => {
      const future = new Date(Date.now() + 60 * 60 * 1000);
      const hh = String(future.getHours()).padStart(2, "0");
      const mm = String(future.getMinutes()).padStart(2, "0");
      await clawkeep.writeSchedule({
        enabled: true,
        frequency: "daily",
        timeOfDay: `${hh}:${mm}`,
        weekday: 0,
      });
      const res = await GET();
      const body = await res.json();
      expect(body.schedule.enabled).toBe(true);
      expect(body.schedule.timeOfDay).toBe(`${hh}:${mm}`);
      expect(body.nextRunAtMs).toBeGreaterThan(Date.now());
    });
  });

  describe("PUT", () => {
    it("persists a valid schedule and re-arms the scheduler", async () => {
      const res = await PUT(jsonReq({
        enabled: true,
        frequency: "weekly",
        timeOfDay: "03:15",
        weekday: 4,
      }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.schedule).toEqual({
        enabled: true,
        frequency: "weekly",
        timeOfDay: "03:15",
        weekday: 4,
      });
      expect(scheduler.refresh).toHaveBeenCalledTimes(1);

      // Round-trip: GET should see the same thing.
      const after = await (await GET()).json();
      expect(after.schedule).toEqual(body.schedule);
    });

    it("sanitises a payload with bogus fields and still re-arms", async () => {
      const res = await PUT(jsonReq({
        enabled: true,
        frequency: "hourly",      // unknown — coerced to daily
        timeOfDay: "not-a-time",  // bogus — coerced to default
        weekday: 99,              // out-of-range — coerced to 0
      }));
      const body = await res.json();
      expect(body.schedule.frequency).toBe("daily");
      expect(body.schedule.timeOfDay).toBe(clawkeep.DEFAULT_SCHEDULE.timeOfDay);
      expect(body.schedule.weekday).toBe(0);
      expect(scheduler.refresh).toHaveBeenCalledTimes(1);
    });

    it("treats an empty body as a disable + defaults", async () => {
      const res = await PUT(new NextRequest(new URL("http://localhost/setup-api/clawkeep/schedule"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "",
      }));
      const body = await res.json();
      expect(body.schedule).toEqual(clawkeep.DEFAULT_SCHEDULE);
    });
  });
});
