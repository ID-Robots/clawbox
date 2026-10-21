/**
 * /setup-api/coding-agent/mcp-servers — which MCP servers a project's coding
 * runs may use.
 *
 * The property under test: **the agent cannot widen its own next run.** The
 * middleware admits the MCP bearer to every /setup-api/* path, so this route
 * refuses it in-handler with the real cookie verifier, on both verbs; the
 * write also refuses another site's page. Below that: the listing names
 * servers and never carries a value, every box is unticked until the owner
 * ticks it, and what is saved is what the runner reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createSessionCookie } from "@/lib/auth";
import { saveEnv } from "@/tests/helpers/env";

const SESSION_SECRET = "a".repeat(64);
/** A bearer that really verifies, so "the agent" in these tests is the agent. */
const MCP_TOKEN = "c".repeat(48);
/** A placeholder in the shape a board token has; never a real credential. */
const BOARD_TOKEN = "fixture-board-token-0123456789";

let route: typeof import("@/app/setup-api/coding-agent/mcp-servers/route");
let store: typeof import("@/lib/project-mcp-servers");
let base: string;
let restore: () => void;

function ownerCookie(): string {
  return `clawbox_session=${createSessionCookie(3600, SESSION_SECRET, 0)}`;
}

function request(init: { method?: string; cookie?: string; bearer?: string; body?: unknown; query?: string; origin?: string | null } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", host: "clawbox.local" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.origin !== null) headers.origin = init.origin ?? "http://clawbox.local";
  const method = init.method ?? "GET";
  return new Request(`http://clawbox.local/setup-api/coding-agent/mcp-servers${init.query ?? ""}`, {
    method,
    headers,
    ...(method === "GET" ? {} : { body: JSON.stringify(init.body ?? { project: "site", servers: ["board"] }) }),
  });
}

function configJson(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(base, "clawbox", "data", "config.json"), "utf-8"));
}

beforeEach(async () => {
  restore = saveEnv("SESSION_SECRET", "CLAWBOX_MCP_TOKEN", "HOME", "CLAWBOX_ROOT", "CLAWBOX_EDITION", "OPENCLAW_HOME", "CLAWBOX_OPENCLAW_HOME", "HERMES_HOME");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-servers-route-"));
  fs.mkdirSync(path.join(base, "clawbox", "data"), { recursive: true });
  fs.writeFileSync(path.join(base, "clawbox", "data", "config.json"), "{}");
  fs.mkdirSync(path.join(base, ".openclaw"), { recursive: true });
  fs.writeFileSync(path.join(base, ".openclaw", "openclaw.json"), JSON.stringify({
    mcp: {
      servers: {
        clawbox: { command: "bun", args: ["run", "mcp/clawbox-mcp.ts"] },
        board: { command: "node", args: ["board.js"], env: { BOARD_TOKEN } },
        docs: { url: "https://mcp.example.com/mcp", auth: "oauth" },
        off: { command: "node", args: ["off.js"], enabled: false },
      },
    },
  }));
  process.env.HOME = base;
  process.env.CLAWBOX_ROOT = path.join(base, "clawbox");
  process.env.CLAWBOX_EDITION = "openclaw";
  delete process.env.OPENCLAW_HOME;
  delete process.env.CLAWBOX_OPENCLAW_HOME;
  delete process.env.HERMES_HOME;
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  vi.resetModules();
  route = await import("@/app/setup-api/coding-agent/mcp-servers/route");
  store = await import("@/lib/project-mcp-servers");
});

afterEach(() => {
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("who may read and change a project's servers", () => {
  it("refuses the MCP bearer on both verbs — the agent is the party this gates", async () => {
    for (const [name, call] of [
      ["GET", () => route.GET(request({ bearer: MCP_TOKEN, query: "?project=site" }))],
      ["POST", () => route.POST(request({ method: "POST", bearer: MCP_TOKEN }))],
    ] as const) {
      const res = await call();
      expect(res.status, name).toBe(403);
      expect((await res.json()).code, name).toBe("owner_only");
    }
    expect(configJson()).toEqual({});
  });

  it("refuses a second ClawBox user on both verbs: the harness's servers and their credentials are the owner's", async () => {
    const users = { clawbox_users: [{ username: "alice", sv: "a1b2c3d4e5f60718", createdAt: "" }] };
    fs.writeFileSync(path.join(base, "clawbox", "data", "config.json"), JSON.stringify(users));
    const guest = `clawbox_session=${createSessionCookie(3600, SESSION_SECRET, 0, { u: "alice", sv: "a1b2c3d4e5f60718" })}`;
    // The cookie is a real person's: the harness's own route lets it in.
    expect(await (await import("@/lib/owner-session")).hasPersonSession(request({ cookie: guest }))).toBe(true);
    for (const [name, call] of [
      ["GET", () => route.GET(request({ cookie: guest, query: "?project=site" }))],
      ["POST", () => route.POST(request({ method: "POST", cookie: guest }))],
    ] as const) {
      const res = await call();
      expect(res.status, name).toBe(403);
      expect((await res.json()).code, name).toBe("owner_only");
    }
    expect(configJson()).toEqual(users);
  });

  it("refuses another site's page even with the owner's cookie", async () => {
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
    expect(configJson()).toEqual({});
  });
});

describe("the checklist", () => {
  it("lists the harness's servers unticked, names only, with why one cannot be used", async () => {
    const res = await route.GET(request({ cookie: ownerCookie(), query: "?project=site" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.selected).toEqual([]);
    const ids = body.options.map((o: { id: string }) => o.id);
    // The box's own server is offered as the read-only tools, never as an extra;
    // a server the harness has switched off is not offered at all.
    expect(ids).toEqual(["clawbox", "board", "docs"]);
    expect(body.options[0]).toMatchObject({ kind: "clawbox", usable: true });
    expect(body.options[1]).toEqual({ id: "board", kind: "harness", harness: "openclaw", transport: "stdio", usable: true });
    expect(body.options[2]).toMatchObject({ id: "docs", usable: false, reasonCode: "oauth" });
    expect(body.options[2].reason).toMatch(/OAuth/);
    expect(JSON.stringify(body)).not.toContain(BOARD_TOKEN);
  });

  it("saves what the owner ticked, and the runner reads the same list", async () => {
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { project: "site", servers: ["board", "clawbox", "board"] } }));
    expect(res.status).toBe(200);
    expect((await res.json()).selected).toEqual(["board", "clawbox"]);
    expect(configJson()[store.PROJECT_MCP_SERVERS_KEY]).toEqual({ site: ["board", "clawbox"] });
    expect(await store.readProjectMcpAllowlist("site")).toEqual(["board", "clawbox"]);
    expect(await store.readProjectMcpAllowlist("other")).toEqual([]);
    const plan = await store.resolveRunMcpPlan("site");
    expect(plan).toMatchObject({ names: ["clawbox", "board"], readOnlyTools: true, allowedTools: ["mcp__board"], missing: [] });

    // Unticking everything removes the project's entry, and then the key.
    const cleared = await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { project: "site", servers: [] } }));
    expect((await cleared.json()).selected).toEqual([]);
    expect(configJson()[store.PROJECT_MCP_SERVERS_KEY]).toBeUndefined();
    expect(await store.resolveRunMcpPlan("site")).toBeNull();
  });

  it("keeps a ticked server that is no longer configured on the list, to untick", async () => {
    await store.setProjectMcpAllowlist("site", ["gone"]);
    const body = await (await route.GET(request({ cookie: ownerCookie(), query: "?project=site" }))).json();
    expect(body.selected).toEqual(["gone"]);
    expect(body.options.find((o: { id: string }) => o.id === "gone")).toMatchObject({ usable: false, reasonCode: "notConfigured" });
    expect(await store.resolveRunMcpPlan("site")).toMatchObject({ names: [], missing: ["gone"] });
  });

  it("refuses a body that is not a project and a list of names", async () => {
    for (const body of [
      { project: "../etc", servers: [] },
      { project: "site", servers: "board" },
      { project: "site", servers: ["has space"] },
      { project: "site", servers: ["two__parts"] },
      { project: "site", servers: Array.from({ length: 40 }, (_, i) => `s${i}`) },
    ]) {
      const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body }));
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect(configJson()).toEqual({});
    const bad = await route.GET(request({ cookie: ownerCookie(), query: "?project=a/b" }));
    expect(bad.status).toBe(400);
  });

  it("does not offer the read-only tools while the ClawBox MCP server is switched off", async () => {
    fs.writeFileSync(path.join(base, "clawbox", "data", "config.json"), JSON.stringify({ clawbox_mcp_enabled: false }));
    const body = await (await route.GET(request({ cookie: ownerCookie(), query: "?project=site" }))).json();
    expect(body.clawboxMcpEnabled).toBe(false);
    expect(body.options.map((o: { id: string }) => o.id)).not.toContain("clawbox");
  });
});

describe("a project named like an object's own machinery", () => {
  it("keeps a list for __proto__ through the route, and reads none for constructor", async () => {
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { project: "__proto__", servers: ["board"] } }));
    expect(res.status).toBe(200);
    expect((await res.json()).selected).toEqual(["board"]);
    expect(Object.keys(configJson()[store.PROJECT_MCP_SERVERS_KEY] as object)).toEqual(["__proto__"]);
    const read = await (await route.GET(request({ cookie: ownerCookie(), query: "?project=__proto__" }))).json();
    expect(read.selected).toEqual(["board"]);
    expect(await store.readProjectMcpAllowlist("constructor")).toEqual([]);
    expect(await store.setProjectMcpAllowlist("constructor", [])).toEqual([]);
  });
});
