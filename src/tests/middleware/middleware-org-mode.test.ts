import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";

// Organisation mode through the real middleware: the owner, a member of staff
// and the agent's MCP bearer against every route group org_mode names, and
// the update routes, which are the owner's on every box (src/lib/org-mode.ts,
// src/lib/non-owner-scope.ts). The switch is read from data/config.json on
// each request, like the users it narrows.

const SECRET = "test-secret";
const ALICE_SV = "a1b2c3d4e5f60718";
// A placeholder of the token's length, never a real one.
const BEARER = "test-mcp-bearer-0123456789abcdef";

async function sign(claims: Record<string, unknown>): Promise<string> {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600, gen: 0, ...claims })).toString("base64url");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return `${payload}.${Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** One route per group the brief names, plus the owner's Settings sections. */
const GROUPS: [string, string, string][] = [
  ["terminal", "GET", "/setup-api/terminal/shells"],
  ["coding agent", "POST", "/setup-api/coding-agent/enable"],
  ["store", "GET", "/setup-api/webapps"],
  ["ClawKeep", "GET", "/setup-api/clawkeep/snapshots"],
  ["Prime Radiant", "GET", "/setup-api/prime-radiant/pages"],
  ["Memory Shard", "GET", "/setup-api/clawkeep/memory/status"],
  ["agent browser", "GET", "/setup-api/browser/status"],
  ["provider change", "POST", "/setup-api/providers/default"],
  ["model change", "POST", "/setup-api/chat/model"],
  ["system", "POST", "/setup-api/system/power"],
  ["network", "GET", "/setup-api/wifi/status"],
  ["users", "GET", "/setup-api/users"],
];

const UPDATES: [string, string][] = [
  ["POST", "/setup-api/update/run"],
  ["POST", "/setup-api/update/openclaw"],
  ["GET", "/setup-api/update/versions"],
  ["POST", "/setup-api/update/dismissal"],
  ["POST", "/setup-api/system/update-branch"],
];

/** What a member of staff keeps: their chat, their files, their own settings. */
const MEMBER_ROUTES: [string, string][] = [
  ["GET", "/setup-api/users/me"],
  ["GET", "/setup-api/gateway/ws-config"],
  ["GET", "/setup-api/chat/tabs"],
  ["POST", "/setup-api/chat/attachments"],
  ["POST", "/setup-api/hermes/chat"],
  ["GET", "/setup-api/files"],
  ["GET", "/setup-api/preferences?all=1"],
  ["POST", "/setup-api/preferences"],
  ["POST", "/setup-api/users/me/password"],
  ["GET", "/setup-api/update/status"],
];

/**
 * Every box-wide control a member of staff must be refused on an organisation
 * box — the audit's list, route by route: a member's cookie gets 403
 * `owner_only`, the owner's passes. Preference WRITES are the preferences
 * route's own (a member's land in their own map, `installed_*` is refused 403:
 * preferences-org-mode.test.ts), so the route itself is not on this list.
 */
const BOX_WIDE: [string, string][] = [
  ["POST", "/setup-api/tunnel/enable"],
  ["POST", "/setup-api/tunnel/disable"],
  ["GET", "/setup-api/tunnel/status"],
  ["GET", "/setup-api/wifi/scan"],
  ["GET", "/setup-api/wifi/status"],
  ["GET", "/setup-api/wifi/saved"],
  ["POST", "/setup-api/wifi/connect"],
  ["GET", "/setup-api/wifi/ethernet"],
  ["GET", "/setup-api/network/internet"],
  ["GET", "/setup-api/email/status"],
  ["GET", "/setup-api/email/messages"],
  ["POST", "/setup-api/email/send"],
  ["GET", "/setup-api/email/pending"],
  ["POST", "/setup-api/email/configure"],
  ["GET", "/setup-api/telegram/status"],
  ["POST", "/setup-api/telegram/configure"],
  ["GET", "/setup-api/whatsapp/status"],
  ["GET", "/setup-api/discord/status"],
  ["GET", "/setup-api/clawkeep/snapshots"],
  ["POST", "/setup-api/clawkeep/backup"],
  ["GET", "/setup-api/prime-radiant/status"],
  ["GET", "/setup-api/clawkeep/memory/status"],
  ["GET", "/setup-api/embed/status"],
  ["POST", "/setup-api/apps/install"],
  ["POST", "/setup-api/apps/uninstall"],
  ["GET", "/setup-api/apps/store"],
  ["GET", "/setup-api/plugins"],
  ["GET", "/setup-api/webapps"],
  ["GET", "/setup-api/vnc"],
  ["POST", "/setup-api/vnc/resolution"],
  ["GET", "/setup-api/kiosk/tabs"],
  ["GET", "/setup-api/monitors"],
  ["POST", "/setup-api/monitors"],
  ["POST", "/setup-api/system/power"],
  ["GET", "/setup-api/system/power-profile"],
  ["POST", "/setup-api/system/power-profile"],
  ["GET", "/setup-api/background-jobs"],
  ["GET", "/setup-api/background-jobs/tasks"],
  ["GET", "/setup-api/browser/status"],
  ["POST", "/setup-api/browser/launch"],
  ["POST", "/setup-api/update/run"],
  ["GET", "/setup-api/update/versions"],
  ["POST", "/setup-api/system/update-branch"],
];

describe("middleware — organisation mode", () => {
  let middleware: typeof import("@/middleware").middleware;
  let tmpRoot: string;
  const savedUser = process.env.CLAWBOX_USER;
  let configWrites = 0;

  function writeConfig(extra: Record<string, unknown>) {
    const dataDir = path.join(tmpRoot, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, "config.json");
    fs.writeFileSync(file, JSON.stringify({
      setup_complete: true,
      password_configured: true,
      clawbox_users: [{ username: "alice", createdAt: "2026-09-27T10:00:00.000Z", sv: ALICE_SV }],
      ...extra,
    }));
    configWrites += 1;
    const later = new Date(Date.now() + configWrites * 1_000);
    fs.utimesSync(file, later, later);
  }

  function request(pathname: string, init: { cookie?: string; bearer?: boolean; method?: string; document?: boolean } = {}): NextRequest {
    const headers = new Headers();
    if (init.cookie) headers.set("cookie", `clawbox_session=${init.cookie}`);
    if (init.bearer) headers.set("authorization", `Bearer ${BEARER}`);
    if (init.document) headers.set("sec-fetch-dest", "document");
    return new NextRequest(new URL(`http://localhost${pathname}`), { method: init.method ?? "GET", headers });
  }

  async function expectOwnerOnly(res: Response, label: string) {
    expect(res.status, label).toBe(403);
    expect(await res.json(), label).toMatchObject({ code: "owner_only" });
  }

  const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";

  beforeEach(async () => {
    vi.resetModules();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-mw-org-"));
    process.env.CLAWBOX_ROOT = tmpRoot;
    process.env.SESSION_SECRET = SECRET;
    process.env.CLAWBOX_USER = "clawbox";
    process.env.CLAWBOX_MCP_TOKEN = BEARER;
    delete process.env.CLAWBOX_TEST_MODE;
    writeConfig({ org_mode: true });
    middleware = (await import("@/middleware")).middleware;
  });

  afterEach(() => {
    delete process.env.SESSION_SECRET;
    delete process.env.CLAWBOX_ROOT;
    delete process.env.CLAWBOX_MCP_TOKEN;
    if (savedUser === undefined) delete process.env.CLAWBOX_USER;
    else process.env.CLAWBOX_USER = savedUser;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("refuses a member of staff every route group behind the hidden apps and sections — 403, never 401", async () => {
    const alice = await sign({ u: "alice", sv: ALICE_SV });
    for (const [group, method, p] of GROUPS) {
      await expectOwnerOnly(await middleware(request(p, { cookie: alice, method })), `${group}: ${method} ${p}`);
    }
  });

  it("refuses a member of staff every box-wide control on the audit's list — 403 owner_only — and lets the owner through", async () => {
    const alice = await sign({ u: "alice", sv: ALICE_SV });
    const owner = await sign({ u: "clawbox" });
    for (const [method, p] of BOX_WIDE) {
      await expectOwnerOnly(await middleware(request(p, { cookie: alice, method })), `member: ${method} ${p}`);
      expect(passes(await middleware(request(p, { cookie: owner, method }))), `owner: ${method} ${p}`).toBe(true);
    }
  });

  it("leaves a member of staff their chat, their files and their own settings", async () => {
    const alice = await sign({ u: "alice", sv: ALICE_SV });
    for (const [method, p] of MEMBER_ROUTES) {
      expect(passes(await middleware(request(p, { cookie: alice, method }))), `${method} ${p}`).toBe(true);
    }
  });

  it("sends a member of staff's hidden app windows home and opens their three", async () => {
    const alice = await sign({ u: "alice", sv: ALICE_SV });
    for (const p of ["/app/terminal", "/app/coding", "/app/store", "/app/clawkeep", "/app/browser"]) {
      const res = await middleware(request(p, { cookie: alice, document: true }));
      expect(res.status, p).toBe(307);
      const location = new URL(res.headers.get("location")!);
      expect(location.pathname, p).toBe("/");
      expect(location.searchParams.get("notice"), p).toBe("owner-only");
    }
    for (const p of ["/", "/app/clawbox", "/app/files", "/app/settings"]) {
      expect(passes(await middleware(request(p, { cookie: alice, document: true }))), p).toBe(true);
    }
  });

  it("keeps everything for the owner, connecting and changing cloud AI providers included", async () => {
    const owner = await sign({ u: "clawbox" });
    for (const [group, method, p] of GROUPS) {
      expect(passes(await middleware(request(p, { cookie: owner, method }))), `${group}: ${method} ${p}`).toBe(true);
    }
    for (const [method, p] of UPDATES) {
      expect(passes(await middleware(request(p, { cookie: owner, method }))), `${method} ${p}`).toBe(true);
    }
    expect(passes(await middleware(request("/app/terminal", { cookie: owner, document: true })))).toBe(true);
  });

  it("leaves the agent's bearer its tools: the agent is the box's, and is no member of staff", async () => {
    for (const [group, method, p] of GROUPS) {
      expect(passes(await middleware(request(p, { bearer: true, method }))), `${group}: ${method} ${p}`).toBe(true);
    }
  });

  it("refuses a member of staff the update routes", async () => {
    const alice = await sign({ u: "alice", sv: ALICE_SV });
    for (const [method, p] of UPDATES) {
      await expectOwnerOnly(await middleware(request(p, { cookie: alice, method })), `${method} ${p}`);
    }
  });

  it("on a home box leaves a user their apps but still refuses them every update route", async () => {
    writeConfig({});
    const alice = await sign({ u: "alice", sv: ALICE_SV });
    for (const [group, method, p] of GROUPS.filter(([g]) => !["model change", "provider change"].includes(g))) {
      expect(passes(await middleware(request(p, { cookie: alice, method }))), `${group}: ${method} ${p}`).toBe(true);
    }
    for (const [method, p] of UPDATES) {
      await expectOwnerOnly(await middleware(request(p, { cookie: alice, method })), `${method} ${p}`);
    }
    expect(passes(await middleware(request("/setup-api/update/status", { cookie: alice })))).toBe(true);
  });

  it("refuses a project app's requests that carry a member of staff's cookie, and passes the owner's and the sandbox's", async () => {
    const alice = await sign({ u: "alice", sv: ALICE_SV });
    const asset = (cookie?: string) => middleware(request("/apps/weather/main.js", { cookie }));
    await expectOwnerOnly(await asset(alice), "member's app request");
    expect((await asset(await sign({ u: "clawbox" }))).status).not.toBe(403);
    // The sandboxed document's own requests carry no cookie at all.
    expect((await asset()).status).not.toBe(403);
    // A home box's user keeps the apps they had.
    writeConfig({});
    expect((await asset(alice)).status).not.toBe(403);
  });

  it("takes the switch from config.json on the next request, both ways", async () => {
    const alice = await sign({ u: "alice", sv: ALICE_SV });
    const terminal = () => middleware(request("/setup-api/terminal/shells", { cookie: alice }));
    expect((await terminal()).status).toBe(403);
    writeConfig({ org_mode: false });
    expect(passes(await terminal())).toBe(true);
    writeConfig({ org_mode: true });
    expect((await terminal()).status).toBe(403);
    // Only a literal true: anything else is a home box.
    writeConfig({ org_mode: "true" });
    expect(passes(await terminal())).toBe(true);
  });
});
