import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-2377 (G2) — `settings/staff-mcp`, the owner's grants: owner only
 * (another user, the agent's bearer and another site's page are refused 403),
 * a bad or unknown server name 400, credentials stored 0600 and answered only
 * masked, and every change synced to the staff agents.
 */

const ROOT = path.join(fs.realpathSync(os.tmpdir()), `clawbox-settings-staff-mcp-${process.pid}-${Date.now()}`);

const h = vi.hoisted(() => ({
  who: vi.fn(),
  sameOrigin: vi.fn(() => true),
  harness: "openclaw" as "openclaw" | "hermes",
  users: ["ivan", "maria"],
  sync: vi.fn(async () => true),
}));

vi.mock("@/lib/owner-session", () => ({ personSession: h.who }));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: h.sameOrigin }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => h.harness) }));
vi.mock("@/lib/org-mode-server", () => ({ readOrgMode: vi.fn(async () => true) }));
vi.mock("@/lib/org-staff-agents", () => ({ syncStaffAgents: h.sync }));
vi.mock("@/lib/clawbox-users", () => ({
  listUsers: vi.fn(async () => h.users.map((username) => ({ username, createdAt: "x", sv: "1" }))),
}));
vi.mock("@/lib/auth", () => ({ getSystemUsername: () => "owner" }));
vi.mock("@/lib/openclaw-config", () => ({
  isPlainObject: (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v),
  readConfigStrict: vi.fn(async () => ({
    mcp: {
      servers: {
        clawbox: { command: "bun", args: ["mcp.ts"] },
        docs: { url: "https://docs.example.com/mcp", transport: "streamable-http" },
        local: { command: "node", args: ["x.js"] },
        "cbstaff-12345678-docs": { url: "http://127.0.0.1/setup-api/staff-mcp/docs", transport: "streamable-http" },
      },
    },
  })),
}));
vi.mock("@/lib/clawbox-mcp-registration", () => ({ harnessesHere: () => ({ openclaw: true, hermes: false }) }));
vi.mock("@/lib/clawbox-mcp-switch", () => ({ readClawboxMcpEnabled: vi.fn(async () => true) }));

let route: typeof import("@/app/setup-api/settings/staff-mcp/route");
let storePath: string;

const get = () => route.GET(new Request("http://box.local/setup-api/settings/staff-mcp"));
const post = (body: unknown) => route.POST(new Request("http://box.local/setup-api/settings/staff-mcp", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: "http://box.local" },
  body: JSON.stringify(body),
}));

beforeAll(async () => {
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.CLAWBOX_ROOT = ROOT;
  vi.resetModules();
  route = await import("@/app/setup-api/settings/staff-mcp/route");
  storePath = (await import("@/lib/staff-mcp")).STAFF_MCP_STORE_PATH;
});

beforeEach(() => {
  vi.clearAllMocks();
  h.who.mockResolvedValue({ username: "owner", isOwner: true });
  h.sameOrigin.mockReturnValue(true);
  h.harness = "openclaw";
  fs.rmSync(storePath, { force: true });
});

afterAll(() => {
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("who may read and change the grants", () => {
  it("refuses another user and the agent's bearer (no person), both ways", async () => {
    for (const person of [{ username: "ivan", isOwner: false }, null]) {
      h.who.mockResolvedValue(person);
      for (const res of [await get(), await post({ servers: { docs: {} } })]) {
        expect(res.status).toBe(403);
        expect((await res.json()).code).toBe("owner_only");
      }
    }
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it("refuses a write from another site's page", async () => {
    h.sameOrigin.mockReturnValue(false);
    const res = await post({ servers: { docs: {} } });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
  });
});

describe("the grants", () => {
  it("lists the box's servers but the box's own and the relay entries", async () => {
    const body = await (await get()).json();
    expect(body.servers.map((s: { name: string }) => s.name)).toEqual(["docs", "local"]);
    expect(body.servers.find((s: { name: string }) => s.name === "local")).toMatchObject({ usable: false, reason: "transport" });
    expect(body.staffMcpSupported).toBe(true);
  });

  it("answers 400 for a bad name, an unknown server, one staff cannot use, or a bad header", async () => {
    for (const [servers, code] of [
      [{ "bad name": {} }, "bad_server"],
      [{ clawbox: {} }, "unknown_server"],
      [{ nope: {} }, "unknown_server"],
      [{ local: {} }, "server_not_usable"],
      [{ "cbstaff-12345678-docs": {} }, "bad_server"],
      [{ docs: { header: "Cookie" } }, "bad_header"],
    ] as const) {
      const res = await post({ servers });
      expect(res.status, JSON.stringify(servers)).toBe(400);
      expect((await res.json()).code).toBe(code);
    }
    expect(h.sync).not.toHaveBeenCalled();
  });

  it("grants a server, keeps credentials 0600 and answers them masked only", async () => {
    expect((await post({ servers: { docs: { header: "X-Api-Key" } } })).status).toBe(200);
    const res = await post({ username: "ivan", server: "docs", credential: "ivan-secret-token-0001" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("ivan-secret-token-0001");
    const body = JSON.parse(text);
    expect(body.users.find((u: { username: string }) => u.username === "ivan").credentials).toEqual({ docs: "••••0001" });
    expect(body.users.find((u: { username: string }) => u.username === "maria").credentials).toEqual({});
    expect(body.servers.find((s: { name: string }) => s.name === "docs")).toMatchObject({ granted: true, header: "X-Api-Key" });
    expect(fs.statSync(storePath).mode & 0o777).toBe(0o600);
    expect(h.sync).toHaveBeenCalledTimes(2);
    expect(await (await get()).text()).not.toContain("ivan-secret-token-0001");
  });

  it("clears a credential with null", async () => {
    await post({ servers: { docs: {} } });
    await post({ username: "ivan", server: "docs", credential: "ivan-secret-token-0001" });
    const res = await post({ username: "ivan", server: "docs", credential: null });
    expect((await res.json()).users.find((u: { username: string }) => u.username === "ivan").credentials).toEqual({});
  });

  it("refuses a credential for someone who is not a member of staff, a server not granted, or a value with a line break", async () => {
    await post({ servers: { docs: {} } });
    expect((await (await post({ username: "owner", server: "docs", credential: "x" })).json()).code).toBe("unknown_user");
    expect((await (await post({ username: "olga", server: "docs", credential: "x" })).json()).code).toBe("unknown_user");
    expect((await (await post({ username: "ivan", server: "local", credential: "x" })).json()).code).toBe("unknown_server");
    expect((await (await post({ username: "ivan", server: "docs", credential: "a\r\nX-Evil: 1" })).json()).code).toBe("bad_credential");
  });

  it("says when a saved change could not be applied to the assistant yet", async () => {
    h.sync.mockResolvedValueOnce(false);
    const res = await post({ servers: { docs: {} } });
    expect(res.status).toBe(200);
    expect((await res.json()).applied).toBe(false);
    expect((await (await post({ servers: { docs: {} } })).json()).applied).toBe(true);
  });

  it("is refused on a Hermes box, where staff get no MCP tools", async () => {
    h.harness = "hermes";
    expect((await post({ servers: { docs: {} } })).status).toBe(409);
    expect((await (await get()).json()).staffMcpSupported).toBe(false);
  });
});
