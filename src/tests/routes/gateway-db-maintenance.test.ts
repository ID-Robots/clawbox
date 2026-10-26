import { beforeEach, describe, expect, it, vi } from "vitest";

// /setup-api/gateway/db-maintenance — the Settings card's status, "Run now" and
// the nightly schedule. OWNER ONLY: a run stops the gateway, and the agent's
// MCP bearer reaches every /setup-api route through the middleware.

const h = vi.hoisted(() => ({
  owner: true,
  sameOrigin: true,
  readStatus: vi.fn(),
  start: vi.fn(),
  writeSchedule: vi.fn(),
  refresh: vi.fn(async () => {}),
}));

vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: vi.fn(async () => h.owner) }));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: vi.fn(() => h.sameOrigin) }));
vi.mock("@/lib/openclaw-db-maintenance", () => {
  class DbMaintenanceScheduleError extends Error {}
  return {
    DbMaintenanceScheduleError,
    readDbMaintenanceStatus: h.readStatus,
    startDbMaintenance: h.start,
    writeDbMaintenanceSchedule: h.writeSchedule,
  };
});
vi.mock("@/lib/openclaw-db-maintenance-scheduler", () => ({ refresh: h.refresh, nextRunAtMs: () => 1_800_000_000_000 }));

const URL_ = "http://clawbox.local/setup-api/gateway/db-maintenance";
const post = (body: unknown) =>
  new Request(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

let route: typeof import("@/app/setup-api/gateway/db-maintenance/route");

beforeEach(async () => {
  h.owner = true;
  h.sameOrigin = true;
  h.readStatus.mockReset();
  h.start.mockReset();
  h.writeSchedule.mockReset();
  h.refresh.mockClear();
  vi.resetModules();
  route = await import("@/app/setup-api/gateway/db-maintenance/route");
});

describe("GET /setup-api/gateway/db-maintenance", () => {
  it("answers the owner with the databases, the last run and the schedule", async () => {
    h.readStatus.mockResolvedValue({ available: true, totalBytes: 5, databases: [], schedule: { enabled: true, time: "04:30" } });
    const res = await route.GET(new Request(URL_));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, available: true, totalBytes: 5, schedule: { time: "04:30" } });
  });

  it("refuses anyone but the owner — the agent's bearer included — without reading anything", async () => {
    h.owner = false;
    const res = await route.GET(new Request(URL_));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, code: "owner_only" });
    expect(h.readStatus).not.toHaveBeenCalled();
  });

  it("answers 502 when the helper cannot say", async () => {
    h.readStatus.mockRejectedValue(new Error("database status failed: python3 missing"));
    const res = await route.GET(new Request(URL_));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, code: "status_failed" });
  });
});

describe("POST /setup-api/gateway/db-maintenance", () => {
  it("starts a run for the owner (202) and says whether it survives a restart", async () => {
    h.start.mockResolvedValue({ started: true, survivesRestart: true });
    const res = await route.POST(post({ action: "run" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, started: true, survivesRestart: true });
    expect(h.start).toHaveBeenCalledWith("manual");
  });

  it("answers 409 with the reason when a run cannot start now", async () => {
    h.start.mockResolvedValue({ started: false, code: "already_running" });
    const res = await route.POST(post({ action: "run" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, code: "already_running" });
  });

  it("saves the schedule and re-arms the scheduler", async () => {
    h.writeSchedule.mockResolvedValue({ enabled: false, time: "03:15" });
    const res = await route.POST(post({ action: "schedule", enabled: false, time: "03:15" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, schedule: { enabled: false, time: "03:15" }, nextRunAt: 1_800_000_000_000 });
    expect(h.writeSchedule).toHaveBeenCalledWith({ enabled: false, time: "03:15" });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("answers 400 for a schedule the lib refuses, and for a body that is not an action", async () => {
    const { DbMaintenanceScheduleError } = await import("@/lib/openclaw-db-maintenance");
    h.writeSchedule.mockRejectedValue(new DbMaintenanceScheduleError("time must be HH:MM"));
    expect((await route.POST(post({ action: "schedule", time: "25:99" }))).status).toBe(400);
    expect((await route.POST(post({ action: "vacuum" }))).status).toBe(400);
    expect((await route.POST(post(null))).status).toBe(400);
    expect((await route.POST(new Request(URL_, { method: "POST", body: "{not json" }))).status).toBe(400);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("refuses a non-owner and a cross-origin page alike, starting nothing", async () => {
    h.owner = false;
    expect((await route.POST(post({ action: "run" }))).status).toBe(403);
    h.owner = true;
    h.sameOrigin = false;
    const res = await route.POST(post({ action: "run" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, code: "owner_only" });
    expect(h.start).not.toHaveBeenCalled();
    expect(h.writeSchedule).not.toHaveBeenCalled();
  });
});
