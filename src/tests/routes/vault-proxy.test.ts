import http from "http";
import type { AddressInfo } from "net";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { saveEnv } from "../helpers/env";

/**
 * TASK-2524 — ClawBox Vault's desktop app is the OWNER's alone
 * (src/app/apps/clawbox-vault, src/lib/vault-proxy.ts). Every request under
 * /apps/clawbox-vault/ needs the owner's session cookie: another user of the
 * box, the agent's bearer and a caller with nothing are all refused before the
 * vault service hears of them. And the route reaches only the desktop app's
 * half of that service — never the extension's API, the agent's API or the
 * pairing routes, which are for callers on the box itself.
 *
 * The vault service here is a real HTTP server on a loopback port that records
 * what reaches it, so "refused" is proved by its silence.
 */

const h = vi.hoisted(() => ({
  who: vi.fn(),
  bearer: vi.fn((_: string | null) => false),
}));

vi.mock("@/lib/route-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/route-auth")>()),
  sessionIdentity: h.who,
}));
vi.mock("@/lib/mcp-token", () => ({ verifyMcpBearer: h.bearer }));

import * as route from "@/app/apps/clawbox-vault/[[...path]]/route";

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const OWNER = { username: "owner", isOwner: true };
const ALICE = { username: "alice", isOwner: false };
const ORIGIN = "http://clawbox.local";

let server: http.Server;
const seen: Seen[] = [];
let restore: () => void;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'; script-src 'self'",
          "cross-origin-resource-policy": "same-origin",
          "set-cookie": "vault=should-not-travel",
        });
        return res.end("<!doctype html><title>ClawBox Vault</title>");
      }
      if (req.url === "/api/ui/unlock") {
        res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: "wrong PIN" }));
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  restore = saveEnv("CLAWBOX_VAULT_PORT", "CLAWBOX_TEST_MODE");
  process.env.CLAWBOX_VAULT_PORT = String((server.address() as AddressInfo).port);
  seen.length = 0;
  h.who.mockReset();
  h.who.mockResolvedValue(OWNER);
  h.bearer.mockReset();
  h.bearer.mockReturnValue(false);
});

afterEach(() => restore());

function req(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): NextRequest {
  const method = init.method ?? "GET";
  return new NextRequest(`${ORIGIN}${path}`, {
    method,
    headers: { host: "clawbox.local", cookie: "clawbox_session=signed", ...(init.headers ?? {}) },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}

const call = (path: string, init: Parameters<typeof req>[1] = {}) => {
  const handler = route[(init.method ?? "GET") as "GET" | "POST" | "DELETE" | "HEAD" | "PUT" | "PATCH"];
  return handler(req(path, init));
};

describe("who may open ClawBox Vault", () => {
  const PATHS = ["/apps/clawbox-vault/", "/apps/clawbox-vault/app.js", "/apps/clawbox-vault/api/health", "/apps/clawbox-vault/api/ui/status", "/apps/clawbox-vault/api/ui/entries"];

  it("the owner's cookie reaches the service", async () => {
    for (const path of PATHS) {
      const res = await call(path);
      expect(res.status, path).toBe(200);
    }
    expect(seen.map((s) => s.url)).toEqual(["/", "/app.js", "/api/health", "/api/ui/status", "/api/ui/entries"]);
  });

  it("another signed-in user is refused 403 owner_only on every path, and the service hears nothing", async () => {
    h.who.mockResolvedValue(ALICE);
    for (const path of PATHS) {
      for (const method of ["GET", "POST", "DELETE"] as const) {
        const res = await call(path, { method, headers: { origin: ORIGIN, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(((await res.json()) as { code: string }).code, `${method} ${path}`).toBe("owner_only");
      }
    }
    expect(seen).toEqual([]);
  });

  it("nobody signed in is refused 401, the agent's bearer 403, and neither reaches the service", async () => {
    h.who.mockResolvedValue(null);
    for (const path of PATHS) expect((await call(path)).status, path).toBe(401);
    h.bearer.mockReturnValue(true);
    for (const path of PATHS) {
      const res = await call(path, { headers: { authorization: "Bearer the-agents-own-token" } });
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("owner_only");
    }
    expect(seen).toEqual([]);
  });

  it("has no test-mode or first-boot opening: a box in test mode still asks for the owner", async () => {
    process.env.CLAWBOX_TEST_MODE = "1";
    h.who.mockResolvedValue(null);
    expect((await call("/apps/clawbox-vault/api/ui/status")).status).toBe(401);
    expect(seen).toEqual([]);
  });
});

describe("what of the vault service the desktop can reach", () => {
  it("only the app's page, its files, the health check and the PIN-guarded UI API", async () => {
    const refused = [
      "/apps/clawbox-vault/api/agent/entries",
      "/apps/clawbox-vault/api/agent/fill",
      "/apps/clawbox-vault/api/ext/secret",
      "/apps/clawbox-vault/api/ext/commands",
      "/apps/clawbox-vault/api/pair",
      "/apps/clawbox-vault/api/pair/auto",
      "/apps/clawbox-vault/pairing.json",
      "/apps/clawbox-vault/api/ui/../agent/entries",
      "/apps/clawbox-vault/api/ui/%2e%2e/agent/entries",
      "/apps/clawbox-vault/API/UI/entries",
      "/apps/clawbox-vault//api/ui/entries",
      "/apps/clawbox-vault/api/ui/",
      "/apps/clawbox-vault/api/ui/a/b/c",
      "/apps/clawbox-vault/extension/manifest.json",
    ];
    for (const path of refused) {
      for (const method of ["GET", "POST"] as const) {
        const res = await call(path, { method, headers: { origin: ORIGIN, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
    expect(seen).toEqual([]);
  });

  it("hands the service the vault's own bearer and the body, never the ClawBox cookie, Origin or Host", async () => {
    const res = await call("/apps/clawbox-vault/api/ui/entries?q=bank", {
      method: "POST",
      headers: { origin: ORIGIN, authorization: "Bearer vault-session-token", "content-type": "application/json", "x-forwarded-for": "198.51.100.7" },
      body: JSON.stringify({ name: "bank.example.com/me" }),
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    const got = seen[0];
    expect(got.method).toBe("POST");
    expect(got.url).toBe("/api/ui/entries?q=bank");
    expect(got.body).toBe('{"name":"bank.example.com/me"}');
    expect(got.headers.authorization).toBe("Bearer vault-session-token");
    expect(got.headers["content-type"]).toBe("application/json");
    expect(got.headers.cookie).toBeUndefined();
    expect(got.headers.origin).toBeUndefined();
    expect(got.headers["x-forwarded-for"]).toBeUndefined();
    // Asked as a local client: the service's own Host check sees loopback.
    expect(got.headers.host).toMatch(/^127\.0\.0\.1:\d+$/);
  });

  it("passes the service's answer back as it is, framed by this origin only and with no cookie of its own", async () => {
    const page = await call("/apps/clawbox-vault/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toBe("default-src 'none'; script-src 'self'; frame-ancestors 'self'");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("set-cookie")).toBeNull();
    expect(await page.text()).toContain("<title>ClawBox Vault</title>");
    // The service's own refusals are the page's to show: a wrong PIN stays a 401.
    const wrong = await call("/apps/clawbox-vault/api/ui/unlock", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: '{"pin":"nope"}' });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "wrong PIN" });
    const head = await call("/apps/clawbox-vault/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("refuses a write another site's page fired, an oversized body and a method the app never uses", async () => {
    const foreign: Array<Record<string, string>> = [{ origin: "https://evil.example.org" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }];
    for (const headers of foreign) {
      const res = await call("/apps/clawbox-vault/api/ui/setup", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: '{"pin":"attacker-pin"}' });
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("cross_origin");
    }
    const big = await call("/apps/clawbox-vault/api/ui/entries", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "x".repeat(64 * 1024 + 1) });
    expect(big.status).toBe(413);
    for (const method of ["PUT", "PATCH"] as const) {
      expect((await call("/apps/clawbox-vault/api/ui/entries", { method, headers: { origin: ORIGIN }, body: "{}" })).status, method).toBe(405);
    }
    expect(seen).toEqual([]);
  });

  it("says so, in words, when the service is not running", async () => {
    process.env.CLAWBOX_VAULT_PORT = "9";
    const api = await call("/apps/clawbox-vault/api/ui/status");
    expect(api.status).toBe(502);
    expect(await api.json()).toEqual({ error: "ClawBox Vault is not running.", code: "vault_down" });
    const page = await call("/apps/clawbox-vault/", { headers: { accept: "text/html,application/xhtml+xml" } });
    expect(page.status).toBe(502);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("ClawBox Vault is not running");
  });
});
