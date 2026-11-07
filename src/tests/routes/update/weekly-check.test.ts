/**
 * /setup-api/update/weekly-check (TASK-2260): the Settings → System Update
 * switch for the weekly update check. On by default; only the owner may flip
 * it — not the agent's bearer, not another ClawBox user — and a flip re-plans
 * the timer.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn(async () => undefined);
const nextRunAtMs = vi.fn(() => 1_800_000_000_000);
vi.mock("@/lib/update-notice-scheduler", () => ({
  refresh: () => refresh(),
  nextRunAtMs: () => nextRunAtMs(),
}));

const MCP_TOKEN = "t".repeat(32);
const SESSION_SECRET = "a".repeat(64);

let root: string;
let route: typeof import("@/app/setup-api/update/weekly-check/route");
let ownerCookie: string;

function req(method: "GET" | "POST", headers: Record<string, string>, body?: unknown): Request {
  return new Request("http://127.0.0.1/setup-api/update/weekly-check", {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-weekly-check-"));
  process.env.CLAWBOX_ROOT = root;
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  process.env.SESSION_SECRET = SESSION_SECRET;
  vi.resetModules();
  refresh.mockClear();
  const auth = await import("@/lib/auth");
  ownerCookie = `clawbox_session=${auth.createSessionCookie(3600, SESSION_SECRET, 0)}`;
  route = await import("@/app/setup-api/update/weekly-check/route");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.CLAWBOX_MCP_TOKEN;
});

describe("GET", () => {
  it("is ON by default and says when the box looks next", async () => {
    const res = await route.GET(req("GET", { cookie: ownerCookie }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, nextCheckAt: 1_800_000_000_000, lastNotified: null });
  });

  it("reports the last version the owner was told about", async () => {
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "data", "update-notice.json"), JSON.stringify({
      jitterS: 5, lastNotifiedVersion: "4.3.1", lastNotifiedAt: 1_700_000_000_000, lastNotifiedVia: "telegram",
    }));
    const body = await (await route.GET(req("GET", { cookie: ownerCookie }))).json();
    expect(body.lastNotified).toEqual({ version: "4.3.1", at: 1_700_000_000_000, via: "telegram" });
  });

  it("needs a session", async () => {
    expect((await route.GET(req("GET", {}))).status).toBe(401);
  });
});

describe("POST", () => {
  it("lets the owner switch it off and on, and re-plans the timer each time", async () => {
    const off = await route.POST(req("POST", { cookie: ownerCookie }, { enabled: false }));
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ enabled: false, nextCheckAt: null });
    expect(refresh).toHaveBeenCalledTimes(1);
    const config = await import("@/lib/config-store");
    expect(await config.get("update_weekly_check")).toBe(false);

    const on = await route.POST(req("POST", { cookie: ownerCookie }, { enabled: true }));
    expect(await on.json()).toMatchObject({ enabled: true });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("refuses the agent's bearer: the owner's notice is the owner's to silence", async () => {
    const res = await route.POST(req("POST", { authorization: `Bearer ${MCP_TOKEN}` }, { enabled: false }));
    expect(res.status).toBe(403);
    const config = await import("@/lib/config-store");
    expect(await config.get("update_weekly_check")).toBeUndefined();
  });

  it("refuses a cross-origin POST even with the owner's cookie — another page cannot silence the notice", async () => {
    const res = await route.POST(req("POST", { cookie: ownerCookie, origin: "http://127.0.0.1:3000" }, { enabled: false }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
    const sameSite = await route.POST(req("POST", { cookie: ownerCookie, "sec-fetch-site": "same-site" }, { enabled: false }));
    expect(sameSite.status).toBe(403);
    const config = await import("@/lib/config-store");
    expect(await config.get("update_weekly_check")).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("accepts the box's own page", async () => {
    const res = await route.POST(req("POST", { cookie: ownerCookie, origin: "http://127.0.0.1" }, { enabled: false }));
    expect(res.status).toBe(200);
  });

  it("refuses anything but a boolean", async () => {
    expect((await route.POST(req("POST", { cookie: ownerCookie }, { enabled: "no" }))).status).toBe(400);
    expect((await route.POST(req("POST", { cookie: ownerCookie }, "{nope"))).status).toBe(400);
    expect(refresh).not.toHaveBeenCalled();
  });
});
