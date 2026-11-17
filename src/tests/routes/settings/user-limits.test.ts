import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";

/**
 * TASK-2446 — the owner's Settings routes for the per-user limits and the
 * audit log. Pinned: both are the OWNER's alone (another user, the agent's
 * bearer and another site's page are refused), a change is whole numbers in
 * range only and is stored as given, every change is an audit line, the
 * usage column measures each user's home, and the audit log reads back
 * newest first.
 */

type Who = { username: string; isOwner: boolean } | null;

const h = vi.hoisted(() => ({
  who: vi.fn(async (): Promise<{ username: string; isOwner: boolean } | null> => ({ username: "clawbox", isOwner: true })),
  sameOrigin: vi.fn(() => true),
  homes: {} as Record<string, string>,
}));

vi.mock("@/lib/owner-session", () => ({ personSession: h.who }));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: h.sameOrigin }));
vi.mock("@/lib/route-auth", () => ({ sessionIdentity: h.who }));
vi.mock("@/lib/clawbox-users", () => ({
  listUsers: vi.fn(async () => [{ username: "ivan" }, { username: "maria" }]),
  userHomeDir: vi.fn(async (name: string) => h.homes[name] ?? null),
}));
vi.mock("@/lib/org-staff-agents", () => ({ syncStaffAgents: vi.fn(async () => true) }));

let root: string;
let restoreEnv: () => void;
let limits: { GET: (req: Request) => Promise<Response>; POST: (req: Request) => Promise<Response> };
let auditRoute: { GET: (req: Request) => Promise<Response> };
let orgMode: { POST: (req: Request) => Promise<Response> };
let resetUsage: () => void;

const LIMITS_URL = "http://box.local/setup-api/settings/user-limits";
const AUDIT_URL = "http://box.local/setup-api/settings/audit-log";
const as = (who: Who) => h.who.mockResolvedValue(who);
const post = (body: unknown, raw?: string) =>
  limits.POST(new Request(LIMITS_URL, { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) }));
const stored = () => JSON.parse(fs.readFileSync(path.join(root, "data", "config.json"), "utf-8")).user_limits;
const auditLines = () => {
  const file = path.join(root, "data", "audit-log.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

beforeAll(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-user-limits-route-"));
  process.env.CLAWBOX_ROOT = root;
  limits = await import("@/app/setup-api/settings/user-limits/route");
  auditRoute = await import("@/app/setup-api/settings/audit-log/route");
  orgMode = await import("@/app/setup-api/settings/org-mode/route");
  ({ resetHomeUsageForTests: resetUsage } = await import("@/lib/home-usage"));
});

afterAll(() => {
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(root, "data"), { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.rmSync(path.join(root, "homes"), { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "homes", "ivan"), { recursive: true });
  fs.writeFileSync(path.join(root, "homes", "ivan", "notes.txt"), Buffer.alloc(4096));
  h.homes = { ivan: path.join(root, "homes", "ivan") };
  as({ username: "clawbox", isOwner: true });
  h.sameOrigin.mockReturnValue(true);
  resetUsage();
});

describe("GET /setup-api/settings/user-limits", () => {
  it("shows the owner the defaults, the maxima and each user's home usage", async () => {
    const res = await limits.GET(new Request(LIMITS_URL));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.limits).toEqual({ uploadMaxMb: 100, homeQuotaMb: 10240, chatPerMinute: 20, chatPerHour: 300 });
    expect(body.defaults).toEqual(body.limits);
    expect(body.max.uploadMaxMb).toBeGreaterThan(100);
    expect(body.orgMode).toBe(false);
    expect(body.users).toEqual([
      { username: "ivan", usedBytes: 4096, truncated: false, quotaBytes: 10240 * 1024 * 1024 },
      // A home the box cannot read (or find) is not measured, never "0 bytes".
      { username: "maria", usedBytes: null, truncated: false, quotaBytes: 10240 * 1024 * 1024 },
    ]);
  });

  it("is refused to every other user and to the agent's bearer", async () => {
    for (const who of [{ username: "ivan", isOwner: false }, null] as Who[]) {
      as(who);
      const res = await limits.GET(new Request(LIMITS_URL));
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("owner_only");
    }
  });
});

describe("POST /setup-api/settings/user-limits", () => {
  it("stores the owner's change, keeps the fields not named, and records it in the audit log", async () => {
    const res = await post({ uploadMaxMb: 25, chatPerMinute: 0 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limits).toEqual({ uploadMaxMb: 25, homeQuotaMb: 10240, chatPerMinute: 0, chatPerHour: 300 });
    expect(stored()).toEqual(body.limits);
    const [line] = auditLines();
    expect(line).toMatchObject({ event: "user_limits", actor: "clawbox", detail: body.limits });
  });

  it("refuses anything but whole numbers in range, naming the field, and changes nothing", async () => {
    for (const bad of [{ uploadMaxMb: "25" }, { homeQuotaMb: -1 }, { chatPerHour: 1.5 }, { chatPerMinute: 10_000_000 }]) {
      const res = await post(bad);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("bad_limit");
      expect(body.field).toBe(Object.keys(bad)[0]);
    }
    expect((await post({})).status).toBe(400);
    expect((await post(null, "{nope")).status).toBe(400);
    expect(fs.existsSync(path.join(root, "data", "config.json"))).toBe(false);
    expect(auditLines()).toEqual([]);
  });

  it("is refused to another user, to the agent's bearer and from another site", async () => {
    as({ username: "ivan", isOwner: false });
    expect((await post({ uploadMaxMb: 0 })).status).toBe(403);
    as(null);
    expect((await post({ uploadMaxMb: 0 })).status).toBe(403);
    as({ username: "clawbox", isOwner: true });
    h.sameOrigin.mockReturnValue(false);
    const res = await post({ uploadMaxMb: 0 });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
    expect(fs.existsSync(path.join(root, "data", "config.json"))).toBe(false);
  });
});

describe("GET /setup-api/settings/audit-log", () => {
  it("shows the owner the administrator actions, newest first", async () => {
    await post({ homeQuotaMb: 2048 });
    const on = await orgMode.POST(new Request("http://box.local/setup-api/settings/org-mode", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.44" },
      body: JSON.stringify({ orgMode: true }),
    }));
    expect(on.status).toBe(200);
    const res = await auditRoute.GET(new Request(`${AUDIT_URL}?limit=10`));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.more).toBe(false);
    expect(body.entries.map((e: { event: string }) => e.event)).toEqual(["org_mode", "user_limits"]);
    expect(body.entries[0]).toMatchObject({ actor: "clawbox", ip: "192.0.2.44", detail: { on: true } });
  });

  it("is refused to every other user and to the agent's bearer", async () => {
    for (const who of [{ username: "ivan", isOwner: false }, null] as Who[]) {
      as(who);
      const res = await auditRoute.GET(new Request(AUDIT_URL));
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("owner_only");
    }
  });

  it("holds the limit to its range", async () => {
    for (let i = 0; i < 3; i++) await post({ chatPerHour: 100 + i });
    const one = await (await auditRoute.GET(new Request(`${AUDIT_URL}?limit=1`))).json();
    expect(one.entries).toHaveLength(1);
    expect(one.more).toBe(true);
    const silly = await (await auditRoute.GET(new Request(`${AUDIT_URL}?limit=-5`))).json();
    expect(silly.entries).toHaveLength(3);
  });
});
