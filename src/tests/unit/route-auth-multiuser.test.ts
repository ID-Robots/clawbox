import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

// The in-handler guard and identity questions with more than one ClawBox
// user. A second user's session is a real session that gets the owner's
// desktop: `requireSession` and the person check let it through, and only a
// route marked `ownerOnly` — the owner's account itself — answers it 403
// owner_only (never 401, which the desktop reads as "signed out").

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
    // Every module reads its data folder from CLAWBOX_ROOT when it loads.
    vi.resetModules();
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

  it("hasValidSession is true for every signed-in person, the second user included", async () => {
    const { hasValidSession } = await import("@/lib/route-auth");
    expect(await hasValidSession(request(sign({})))).toBe(true);
    expect(await hasValidSession(request(sign({ u: "alice", sv: ALICE_SV })))).toBe(true);
    expect(await hasValidSession(request())).toBe(false);
  });

  it("requireSession lets a second user through: they get the owner's desktop", async () => {
    const { requireSession } = await import("@/lib/route-auth");
    expect(await requireSession(request(sign({ u: "alice", sv: ALICE_SV })))).toBeNull();
    expect(await requireSession(request(sign({})))).toBeNull();
  });

  it("requireSession with ownerOnly answers a second user 403 owner_only, not 401 — and lets the owner through", async () => {
    const { requireSession } = await import("@/lib/route-auth");
    const res = await requireSession(request(sign({ u: "alice", sv: ALICE_SV })), { ownerOnly: true });
    expect(res?.status).toBe(403);
    expect(await res?.json()).toMatchObject({ code: "owner_only" });
    expect(await requireSession(request(sign({})), { ownerOnly: true })).toBeNull();
    expect((await requireSession(request(), { ownerOnly: true }))?.status).toBe(401);
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

  it("the Terminal's shell list and the users admin both answer a second user; the owner's password route does not", async () => {
    process.env.SESSION_SECRET = SECRET; // the person check signs with the live secret
    const alice = sign({ u: "alice", sv: ALICE_SV });
    const { GET: shells } = await import("@/app/setup-api/terminal/shells/route");
    expect((await shells(request(alice))).status).toBe(200);
    const { POST: credentials } = await import("@/app/setup-api/system/credentials/route");
    const res = await credentials(new Request("http://localhost/setup-api/system/credentials", {
      method: "POST",
      headers: { cookie: `clawbox_session=${alice}`, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "x", password: "a new password for the owner" }),
    }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "owner_only" });
  });

  it("hasPersonSession — the person gate on the desktop's routes — answers every signed-in person, never a stale cookie", async () => {
    process.env.SESSION_SECRET = SECRET;
    const { hasPersonSession, personSession } = await import("@/lib/owner-session");
    expect(await hasPersonSession(request(sign({})))).toBe(true);
    expect(await hasPersonSession(request(sign({ u: "alice", sv: ALICE_SV })))).toBe(true);
    expect(await personSession(request(sign({ u: "alice", sv: ALICE_SV })))).toEqual({ username: "alice", isOwner: false });
    expect(await hasPersonSession(request(sign({ u: "alice", sv: "0f0f0f0f0f0f0f0f" })))).toBe(false);
    expect(await hasPersonSession(request(sign({ u: "root" })))).toBe(false);
    expect(await hasPersonSession(request())).toBe(false);
  });

  it("hasOwnerSession — the owner's own token and account — refuses a second user and keeps a legacy cookie", async () => {
    process.env.SESSION_SECRET = SECRET;
    const { hasOwnerSession } = await import("@/lib/owner-session");
    expect(await hasOwnerSession(request(sign({})))).toBe(true);
    expect(await hasOwnerSession(request(sign({ u: "clawbox" })))).toBe(true);
    expect(await hasOwnerSession(request(sign({ u: "alice", sv: ALICE_SV })))).toBe(false);
    expect(await hasOwnerSession(request(sign({ u: "root" })))).toBe(false);
  });
});
