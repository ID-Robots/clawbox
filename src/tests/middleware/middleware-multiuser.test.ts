import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";

// Middleware with more than one ClawBox user. The owner's session is
// unchanged; a second user's session reaches the owner's desktop — every app
// and Settings — except the owner's account, the gateway's token and its
// console trees (src/lib/non-owner-scope.ts), which answer 403 (or, for a
// page, the desktop); a removed user's cookie is no session at all.

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

  function request(
    pathname: string,
    cookie: string,
    init: { method?: string; document?: boolean; headers?: Record<string, string> } = {},
  ): NextRequest {
    const headers = new Headers({ cookie: `clawbox_session=${cookie}`, ...init.headers });
    if (init.document) headers.set("sec-fetch-dest", "document");
    return new NextRequest(new URL(`http://localhost${pathname}`), { method: init.method ?? "GET", headers });
  }

  async function expectOwnerOnlyJson(res: Response, label: string) {
    expect(res.status, label).toBe(403);
    expect(res.headers.get("content-type"), label).toContain("application/json");
    expect(await res.json(), label).toMatchObject({ code: "owner_only" });
  }

  function expectDesktopWithNotice(res: Response, label: string) {
    expect(res.status, label).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname, label).toBe("/");
    expect(location.searchParams.get("notice"), label).toBe("owner-only");
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

  it("a second user reaches the owner's desktop: every route the owner's apps and Settings use", async () => {
    const alice = await sign({ u: "alice", sv: ALICE_SV });
    for (const [method, p] of [
      ["GET", "/setup-api/users/me"],
      ["GET", "/setup-api/users"],
      ["POST", "/setup-api/users"],
      ["POST", "/setup-api/coding-agent/enable"],
      ["GET", "/setup-api/files"],
      ["GET", "/setup-api/preferences?all=1"],
      ["POST", "/setup-api/preferences"],
      ["POST", "/setup-api/system/power"],
      ["GET", "/setup-api/wifi/status"],
      ["GET", "/setup-api/network/internet"],
      ["GET", "/setup-api/gateway/ws-config"],
      ["GET", "/setup-api/chat/tabs"],
      ["GET", "/"],
      ["GET", "/app/settings"],
      ["GET", "/app/files"],
      ["GET", "/app/clawbox"],
      ["GET", "/setup"],
    ] as const) {
      const res = await middleware(request(p, alice, { method, document: p.startsWith("/app") || p === "/" || p === "/setup" }));
      expect(res.headers.get("x-middleware-next"), `${method} ${p}`).toBe("1");
    }
  });

  it("a second user is refused the owner's account and the gateway's trees with 403 owner_only — never a 401", async () => {
    const alice = await sign({ u: "alice", sv: ALICE_SV });
    for (const [method, p] of [
      ["POST", "/setup-api/system/credentials"],
      ["POST", "/setup-api/system/credentials/verify"],
      ["POST", "/setup-api/setup/reset"],
      ["GET", "/setup-api/gateway"],
      ["GET", "/api/chat"],
      ["GET", "/api/chat/media/outgoing/agent%3Amain%3Amain/1/full"],
    ] as const) {
      await expectOwnerOnlyJson(await middleware(request(p, alice, { method })), `${method} ${p}`);
    }
  });

  it("a second user reaches the media of their own chat, and nobody else's", async () => {
    const alice = await sign({ u: "alice", sv: ALICE_SV });
    const own = await middleware(request("/api/chat/media/outgoing/agent%3Amain%3Aclawbox-user-alice/1/full", alice));
    expect(own.headers.get("x-middleware-next")).toBe("1");
    await expectOwnerOnlyJson(
      await middleware(request("/api/chat/media/outgoing/agent%3Amain%3Aclawbox-user-bob/1/full", alice)),
      "bob's media",
    );
  });

  it("a second user opening a harness console page lands on the desktop, told why", async () => {
    const alice = await sign({ u: "alice", sv: ALICE_SV });
    for (const p of ["/app/openclaw", "/app/hermes", "/chat", "/settings", "/sessions"]) {
      expectDesktopWithNotice(await middleware(request(p, alice, { document: true })), p);
    }
  });

  it("a plain-HTTP browser navigation (Accept: text/html, no Sec-Fetch-*) lands on the desktop too", async () => {
    const alice = await sign({ u: "alice", sv: ALICE_SV });
    const accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    for (const p of ["/settings", "/chat", "/app/openclaw"]) {
      expectDesktopWithNotice(await middleware(request(p, alice, { headers: { accept } })), p);
    }
  });

  it("a page asked for by curl (Accept: */*) is a navigation, not an API call", async () => {
    const alice = await sign({ u: "alice", sv: ALICE_SV });
    for (const p of ["/settings", "/chat", "/app/hermes"]) {
      const res = await middleware(request(p, alice, { headers: { accept: "*/*" } }));
      expectDesktopWithNotice(res, p);
      expect(res.headers.get("cache-control"), p).toBe("no-store");
    }
  });

  it("API requests keep their 403 JSON, navigation or not", async () => {
    const alice = await sign({ u: "alice", sv: ALICE_SV });
    await expectOwnerOnlyJson(await middleware(request("/setup-api/system/credentials", alice, { document: true })), "document setup-api");
    await expectOwnerOnlyJson(await middleware(request("/api/chat", alice, { document: true })), "document gateway api");
    // A console page fetched by code (fetch/XHR, the Next router) is code asking.
    await expectOwnerOnlyJson(
      await middleware(request("/settings", alice, { headers: { "sec-fetch-dest": "empty" } })),
      "fetch /settings",
    );
    await expectOwnerOnlyJson(await middleware(request("/settings", alice, { headers: { rsc: "1" } })), "rsc /settings");
  });

  it("the redirect lands on a desktop the second user may open", async () => {
    const alice = await sign({ u: "alice", sv: ALICE_SV });
    const res = await middleware(request("/?notice=owner-only", alice, { document: true }));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("the owner is never redirected off an owner page", async () => {
    const owner = await sign({ u: "clawbox" });
    for (const p of ["/settings", "/app/files"]) {
      const res = await middleware(request(p, owner, { headers: { accept: "*/*" } }));
      expect(res.headers.get("x-middleware-next"), p).toBe("1");
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
