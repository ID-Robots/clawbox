import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

// TASK-1256: the in-handler guard and identity question with more than one
// ClawBox user. A second user's session is a real session — but not the
// owner's, so every owner route answers it 403 owner_only (never 401, which
// the desktop reads as "signed out").

const SECRET = "test-session-secret-0123456789abcdef";
const ALICE_SV = "a1b2c3d4e5f60718";

function sign(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600, gen: 0, ...claims })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function request(cookie?: string): Request {
  return new Request("http://localhost/setup-api/anything", {
    headers: cookie ? { cookie: `clawbox_session=${cookie}` } : {},
  });
}

describe("route-auth with ClawBox users", () => {
  let root: string;
  const saved = { root: process.env.CLAWBOX_ROOT, user: process.env.CLAWBOX_USER, secret: process.env.SESSION_SECRET, test: process.env.CLAWBOX_TEST_MODE };

  function writeConfig(users: unknown[]) {
    fs.writeFileSync(
      path.join(root, "data", "config.json"),
      JSON.stringify({ password_configured: true, setup_complete: true, session_generation: 0, clawbox_users: users }),
    );
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-multiuser-"));
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "data", ".session-secret"), SECRET, { mode: 0o600 });
    process.env.CLAWBOX_ROOT = root;
    process.env.CLAWBOX_USER = "clawbox";
    delete process.env.SESSION_SECRET;
    delete process.env.CLAWBOX_TEST_MODE;
    writeConfig([{ username: "alice", createdAt: "2026-09-27T10:00:00.000Z", sv: ALICE_SV }]);
  });

  afterEach(() => {
    for (const [key, value] of [["CLAWBOX_ROOT", saved.root], ["CLAWBOX_USER", saved.user], ["SESSION_SECRET", saved.secret], ["CLAWBOX_TEST_MODE", saved.test]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("sessionIdentity names each person", async () => {
    const { sessionIdentity } = await import("@/lib/route-auth");
    expect(await sessionIdentity(request(sign({})))).toEqual({ username: "clawbox", isOwner: true });
    expect(await sessionIdentity(request(sign({ u: "clawbox" })))).toEqual({ username: "clawbox", isOwner: true });
    expect(await sessionIdentity(request(sign({ u: "alice", sv: ALICE_SV })))).toEqual({ username: "alice", isOwner: false });
    expect(await sessionIdentity(request())).toBeNull();
  });

  it("hasValidSession — the owner question — is false for a second user", async () => {
    const { hasValidSession } = await import("@/lib/route-auth");
    expect(await hasValidSession(request(sign({})))).toBe(true);
    expect(await hasValidSession(request(sign({ u: "alice", sv: ALICE_SV })))).toBe(false);
  });

  it("requireSession answers a second user 403 owner_only, not 401", async () => {
    const { requireSession } = await import("@/lib/route-auth");
    const res = await requireSession(request(sign({ u: "alice", sv: ALICE_SV })));
    expect(res?.status).toBe(403);
    expect(await res?.json()).toMatchObject({ code: "owner_only" });
  });

  it("requireSession lets a second user through only where the route opts in", async () => {
    const { requireSession } = await import("@/lib/route-auth");
    expect(await requireSession(request(sign({ u: "alice", sv: ALICE_SV })), { allowNonOwner: true })).toBeNull();
    expect(await requireSession(request(sign({})), { allowNonOwner: true })).toBeNull();
  });

  it("a removed user is signed out everywhere: 401, as if they had no cookie", async () => {
    const { requireSession, sessionIdentity } = await import("@/lib/route-auth");
    const cookie = sign({ u: "alice", sv: ALICE_SV });
    writeConfig([]);
    expect(await sessionIdentity(request(cookie))).toBeNull();
    expect((await requireSession(request(cookie)))?.status).toBe(401);
  });

  it("a re-created user's old cookie does not come back to life", async () => {
    const { sessionIdentity } = await import("@/lib/route-auth");
    const cookie = sign({ u: "alice", sv: ALICE_SV });
    writeConfig([{ username: "alice", createdAt: "2026-09-28T10:00:00.000Z", sv: "0f0f0f0f0f0f0f0f" }]);
    expect(await sessionIdentity(request(cookie))).toBeNull();
  });

  it("the Terminal's shell list — scoped per user — answers a second user; the users admin does not", async () => {
    process.env.SESSION_SECRET = SECRET; // hasOwnerSession signs with the live secret
    const alice = sign({ u: "alice", sv: ALICE_SV });
    const { GET: shells } = await import("@/app/setup-api/terminal/shells/route");
    expect((await shells(request(alice))).status).toBe(200);
    const { GET: users } = await import("@/app/setup-api/users/route");
    const res = await users(request(alice));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "owner_only" });
  });

  it("hasOwnerSession — the owner-only gate on 38 routes — refuses a second user and keeps a legacy cookie", async () => {
    process.env.SESSION_SECRET = SECRET;
    const { hasOwnerSession } = await import("@/lib/owner-session");
    expect(await hasOwnerSession(request(sign({})))).toBe(true);
    expect(await hasOwnerSession(request(sign({ u: "clawbox" })))).toBe(true);
    expect(await hasOwnerSession(request(sign({ u: "alice", sv: ALICE_SV })))).toBe(false);
    expect(await hasOwnerSession(request(sign({ u: "root" })))).toBe(false);
  });
});
