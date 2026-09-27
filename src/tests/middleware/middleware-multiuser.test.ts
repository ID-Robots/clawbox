import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";

// TASK-1256: middleware with more than one ClawBox user. The owner's session
// is unchanged; a second user's session reaches only the per-user allow-list
// (src/lib/non-owner-scope.ts) and is refused everything else with 403 — or,
// for a page, sent to the desktop; a removed user's cookie is no session at all.

const SECRET = "test-secret";
const ALICE_SV = "a1b2c3d4e5f60718";

async function sign(claims: Record<string, unknown>): Promise<string> {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600, gen: 0, ...claims })).toString("base64url");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return `${payload}.${Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

describe("middleware — multi-user", () => {
  let middleware: typeof import("@/middleware").middleware;
  let tmpRoot: string;
  const savedUser = process.env.CLAWBOX_USER;

  function writeConfig(users: unknown[]) {
    const dataDir = path.join(tmpRoot, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ setup_complete: true, password_configured: true, clawbox_users: users }),
    );
  }

  function request(pathname: string, cookie: string, init: { method?: string; document?: boolean } = {}): NextRequest {
    const headers = new Headers({ cookie: `clawbox_session=${cookie}` });
    if (init.document) headers.set("sec-fetch-dest", "document");
    return new NextRequest(new URL(`http://localhost${pathname}`), { method: init.method ?? "GET", headers });
  }

  beforeEach(async () => {
    vi.resetModules();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-mw-mu-"));
    process.env.CLAWBOX_ROOT = tmpRoot;
    process.env.SESSION_SECRET = SECRET;
    process.env.CLAWBOX_USER = "clawbox";
    delete process.env.CLAWBOX_TEST_MODE;
    writeConfig([{ username: "alice", createdAt: "2026-09-27T10:00:00.000Z", sv: ALICE_SV }]);
    middleware = (await import("@/middleware")).middleware;
  });

  afterEach(() => {
    delete process.env.SESSION_SECRET;
    delete process.env.CLAWBOX_ROOT;
    if (savedUser === undefined) delete process.env.CLAWBOX_USER;
    else process.env.CLAWBOX_USER = savedUser;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("an owner cookie from before multi-user (no u) still reaches everything", async () => {
    const legacy = await sign({});
    for (const p of ["/setup-api/wifi/status", "/setup-api/users", "/api/chat"]) {
      const res = await middleware(request(p, legacy));
      expect(res.status, p).toBe(200);
      expect(res.headers.get("x-middleware-next"), p).toBe("1");
    }
  });

  it("the owner's named cookie reaches the users admin", async () => {
    const res = await middleware(request("/setup-api/users", await sign({ u: "clawbox" }), { method: "POST" }));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("a second user reaches who-am-I, the box language and the Terminal's settings", async () => {
    const alice = await sign({ u: "alice", sv: ALICE_SV });
    for (const p of ["/setup-api/users/me", "/setup-api/preferences?keys=ui_language", "/setup-api/terminal/shells", "/"]) {
      const res = await middleware(request(p, alice));
      expect(res.headers.get("x-middleware-next"), p).toBe("1");
    }
  });

  it("a second user is refused every owner route with 403 owner_only — never a 401", async () => {
    const alice = await sign({ u: "alice", sv: ALICE_SV });
    for (const [method, p] of [
      ["GET", "/setup-api/users"],
      ["POST", "/setup-api/users"],
      ["POST", "/setup-api/coding-agent/enable"],
      ["GET", "/setup-api/files"],
      ["GET", "/setup-api/preferences?all=1"],
      ["POST", "/setup-api/preferences"],
      ["POST", "/setup-api/system/power"],
      ["GET", "/api/chat"],
    ] as const) {
      const res = await middleware(request(p, alice, { method }));
      expect(res.status, `${method} ${p}`).toBe(403);
      expect(await res.json(), `${method} ${p}`).toMatchObject({ code: "owner_only" });
    }
  });

  it("a second user opening an owner page lands on the desktop", async () => {
    const alice = await sign({ u: "alice", sv: ALICE_SV });
    for (const p of ["/setup", "/app/settings", "/chat"]) {
      const res = await middleware(request(p, alice, { document: true }));
      expect(res.status, p).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname, p).toBe("/");
    }
  });

  it("a removed user's cookie is no session at all", async () => {
    const alice = await sign({ u: "alice", sv: ALICE_SV });
    writeConfig([]);
    const res = await middleware(request("/setup-api/users/me", alice));
    expect(res.status).toBe(401);
  });

  it("a cookie naming an account that is not a ClawBox user is no session", async () => {
    const res = await middleware(request("/setup-api/users/me", await sign({ u: "root" })));
    expect(res.status).toBe(401);
  });
});
