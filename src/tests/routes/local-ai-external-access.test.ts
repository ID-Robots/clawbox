import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Who may reach the external engine's routes (TASK-2376), through the REAL
 * route-auth: only the owner. A second ClawBox user's session and the agent's
 * MCP bearer are answered 403 `owner_only` (never 401, which the desktop reads
 * as "signed out"); no session at all is 401. None of them makes the box send
 * a request anywhere — the probe is never reached.
 */

const SECRET = "test-session-secret-0123456789abcdef";
const BOB_SV = "b1c2d3e4f5a60718";
const MCP = "mcp-test-bearer-placeholder-0123456789abcdef";

function sign(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600, gen: 0, ...claims })).toString("base64url");
  return `${payload}.${crypto.createHmac("sha256", SECRET).update(payload).digest("hex")}`;
}

const BODY = { baseUrl: "http://192.0.2.10:8000/v1", modelId: "Qwen/Qwen3-32B", apiKey: "sk-test-placeholder-0123456789" };

function req(method: string, url: string, who: { cookie?: string; bearer?: string }): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (who.cookie) headers.cookie = `clawbox_session=${who.cookie}`;
  if (who.bearer) headers.authorization = `Bearer ${who.bearer}`;
  return new Request(`http://localhost${url}`, {
    method,
    headers,
    ...(method === "POST" ? { body: JSON.stringify(BODY) } : {}),
  });
}

describe("external engine routes: owner only", () => {
  let root: string;
  const saved = { root: process.env.CLAWBOX_ROOT, user: process.env.CLAWBOX_USER, secret: process.env.SESSION_SECRET, test: process.env.CLAWBOX_TEST_MODE, mcp: process.env.CLAWBOX_MCP_TOKEN };
  const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));

  beforeEach(() => {
    vi.resetModules();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-engine-access-"));
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "data", ".session-secret"), SECRET, { mode: 0o600 });
    fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({
      password_configured: true, setup_complete: true, session_generation: 0,
      clawbox_users: [{ username: "bob", createdAt: "2026-11-01T10:00:00.000Z", sv: BOB_SV }],
    }));
    process.env.CLAWBOX_ROOT = root;
    process.env.CLAWBOX_USER = "clawbox";
    process.env.CLAWBOX_MCP_TOKEN = MCP;
    delete process.env.SESSION_SECRET;
    delete process.env.CLAWBOX_TEST_MODE;
    fetchSpy.mockClear();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of [["CLAWBOX_ROOT", saved.root], ["CLAWBOX_USER", saved.user], ["SESSION_SECRET", saved.secret], ["CLAWBOX_TEST_MODE", saved.test], ["CLAWBOX_MCP_TOKEN", saved.mcp]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function routes() {
    const external = await import("@/app/setup-api/local-ai/external/route");
    const test = await import("@/app/setup-api/local-ai/external/test/route");
    return [
      ["GET external", () => external.GET, "GET", "/setup-api/local-ai/external?probe=1"],
      ["POST external (Save)", () => external.POST, "POST", "/setup-api/local-ai/external"],
      ["DELETE external (Remove)", () => external.DELETE, "DELETE", "/setup-api/local-ai/external"],
      ["POST external/test (Test)", () => test.POST, "POST", "/setup-api/local-ai/external/test"],
    ] as const;
  }

  it("answers a second ClawBox user's session 403 owner_only on every method, and sends nothing", async () => {
    for (const [name, handler, method, url] of await routes()) {
      const res = await handler()(req(method, url, { cookie: sign({ u: "bob", sv: BOB_SV }) }));
      expect(res.status, name).toBe(403);
      expect(await res.json(), name).toMatchObject({ code: "owner_only" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers the agent's MCP bearer 403 owner_only on every method, and sends nothing", async () => {
    for (const [name, handler, method, url] of await routes()) {
      const res = await handler()(req(method, url, { bearer: MCP }));
      expect(res.status, name).toBe(403);
      expect(await res.json(), name).toMatchObject({ code: "owner_only" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers no session 401, and sends nothing", async () => {
    for (const [name, handler, method, url] of await routes()) {
      expect((await handler()(req(method, url, {}))).status, name).toBe(401);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lets the owner through", async () => {
    const [[, get, , url]] = await routes();
    const res = await get()(req("GET", url, { cookie: sign({}) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: false });
  });
});
