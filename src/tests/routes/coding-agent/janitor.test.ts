/**
 * /setup-api/coding-agent/janitor — the Coding Agent settings' "Clean up old
 * run folders": the owner alone reads the settings and the dry run, saves the
 * switch and the retention, and runs a pass by hand. The janitor library is
 * stubbed; its own behaviour is coding-folder-janitor.test.ts's.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireSession = vi.hoisted(() => vi.fn());
const lib = vi.hoisted(() => ({
  planJanitorPass: vi.fn(),
  readJanitorSettings: vi.fn(),
  saveJanitorSettings: vi.fn(),
  runJanitorPass: vi.fn(),
  readJanitorState: vi.fn(() => ({ lastPass: null })),
  readJanitorLog: vi.fn(() => []),
  janitorPassRunning: vi.fn(() => false),
  nextPassAt: vi.fn(() => 123),
}));
vi.mock("@/lib/route-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/route-auth")>("@/lib/route-auth");
  return { ...actual, requireSession };
});
vi.mock("@/lib/coding-folder-janitor", async () => {
  class JanitorError extends Error {
    constructor(public kind: "invalid" | "busy", message: string) {
      super(message);
    }
  }
  return {
    ...lib,
    JanitorError,
    DEFAULT_RETENTION_DAYS: 14,
    MIN_RETENTION_DAYS: 1,
    MAX_RETENTION_DAYS: 365,
    MAX_REMOVALS_PER_PASS: 25,
  };
});

type Route = typeof import("@/app/setup-api/coding-agent/janitor/route");
let route: Route;

function req(method: "GET" | "POST", opts: { query?: string; body?: unknown; origin?: string } = {}): Request {
  return new Request(`http://localhost/setup-api/coding-agent/janitor${opts.query ? `?${opts.query}` : ""}`, {
    method,
    headers: { host: "localhost", "content-type": "application/json", ...(opts.origin ? { origin: opts.origin } : {}) },
    ...(opts.body !== undefined ? { body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body) } : {}),
  });
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  requireSession.mockResolvedValue(null);
  lib.readJanitorSettings.mockResolvedValue({ enabled: true, retentionDays: 14 });
  route = await import("@/app/setup-api/coding-agent/janitor/route");
});

describe("who may", () => {
  it("asks for the OWNER on every method, and answers the refusal as given", async () => {
    const { NextResponse } = await import("next/server");
    requireSession.mockResolvedValue(NextResponse.json({ error: "owner only", kind: "owner_only" }, { status: 403 }));
    expect((await route.GET(req("GET"))).status).toBe(403);
    expect((await route.POST(req("POST", { body: { action: "clean" } }))).status).toBe(403);
    expect(requireSession).toHaveBeenCalledWith(expect.anything(), { ownerOnly: true });
    expect(lib.runJanitorPass).not.toHaveBeenCalled();
  });

  it("refuses a POST from another site", async () => {
    const res = await route.POST(req("POST", { body: { action: "clean" }, origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ kind: "cross_origin" });
    expect(lib.runJanitorPass).not.toHaveBeenCalled();
  });
});

describe("reading", () => {
  it("answers the settings, the limits and the last pass, and the dry run only when asked", async () => {
    const plain = await (await route.GET(req("GET"))).json();
    expect(plain).toMatchObject({ settings: { enabled: true, retentionDays: 14 }, limits: { minRetentionDays: 1, maxRetentionDays: 365 }, lastPass: null, nextPassAt: 123, running: false });
    expect(plain.plan).toBeUndefined();
    expect(lib.planJanitorPass).not.toHaveBeenCalled();

    lib.planJanitorPass.mockResolvedValue({ entries: [{ path: "/p/a", action: "keep", reason: "dirty" }] });
    const withPlan = await (await route.GET(req("GET", { query: "plan=1" }))).json();
    expect(withPlan.plan.entries).toEqual([{ path: "/p/a", action: "keep", reason: "dirty" }]);
  });
});

describe("writing", () => {
  it("saves the switch and the retention, and answers a refusal as 400 invalid", async () => {
    lib.saveJanitorSettings.mockResolvedValue({ enabled: false, retentionDays: 30 });
    const ok = await route.POST(req("POST", { body: { enabled: false, retentionDays: 30 } }));
    expect(await ok.json()).toEqual({ settings: { enabled: false, retentionDays: 30 } });
    expect(lib.saveJanitorSettings).toHaveBeenCalledWith({ enabled: false, retentionDays: 30 });

    const { JanitorError } = await import("@/lib/coding-folder-janitor");
    lib.saveJanitorSettings.mockRejectedValue(new JanitorError("invalid", "bad days"));
    const bad = await route.POST(req("POST", { body: { retentionDays: 0 } }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "bad days", kind: "invalid" });
    expect((await route.POST(req("POST", { body: "{not json" }))).status).toBe(400);
    expect((await route.POST(req("POST", { body: { action: "everything" } }))).status).toBe(400);
  });

  it("runs one pass by hand, switch or no switch, and answers 409 while another runs", async () => {
    lib.runJanitorPass.mockResolvedValue({ removed: 2, trashed: 1, pruned: 0, failed: 0, kept: 4, freedBytes: 10, actions: [] });
    const res = await route.POST(req("POST", { body: { action: "clean" } }));
    expect(res.status).toBe(200);
    expect((await res.json()).result).toMatchObject({ removed: 2, trashed: 1 });
    expect(lib.runJanitorPass).toHaveBeenCalledWith({ trigger: "manual", ignoreSwitch: true, throwIfBusy: true });

    const { JanitorError } = await import("@/lib/coding-folder-janitor");
    lib.runJanitorPass.mockRejectedValue(new JanitorError("busy", "already"));
    expect((await route.POST(req("POST", { body: { action: "clean" } }))).status).toBe(409);
  });
});
