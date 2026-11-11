import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /setup-api/users/me/password — a ClawBox user other than the owner
 * changes their OWN password (Settings → Account, TASK-2435). Pinned: a
 * person's cookie from our own page only; never the owner (their password is
 * system/credentials'), never the agent's bearer; a wrong current password is
 * a 400, never the 401 the desktop reads as "signed out"; and a run of wrong
 * guesses is refused before the helper is asked again.
 */

type Who = { username: string; isOwner: boolean } | null;

const h = vi.hoisted(() => ({
  who: vi.fn(async (): Promise<{ username: string; isOwner: boolean } | null> => ({ username: "alice", isOwner: false })),
  sameOrigin: vi.fn(() => true),
  change: vi.fn(async (): Promise<string> => "ok"),
  rotate: vi.fn(async (): Promise<string | null> => "f".repeat(32)),
}));

vi.mock("@/lib/owner-session", () => ({ personSession: h.who }));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: h.sameOrigin }));
vi.mock("@/lib/clawbox-users", () => ({ changeUserPassword: h.change, rotateUserSessionVersion: h.rotate }));
vi.mock("@/lib/auth", () => ({
  getSessionSigningSecret: vi.fn(async () => "test-secret"),
  getSessionGeneration: vi.fn(async () => 0),
  readSessionClaims: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3_600 })),
  createSessionCookie: vi.fn((duration: number, _s: string, _g: number, who: { u: string; sv?: string }) => `fresh.${who.u}.${who.sv}.${duration}`),
}));

let POST: (req: Request) => Promise<Response>;

const post = (body: unknown, raw?: string) =>
  POST(new Request("http://box.local/setup-api/users/me/password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
  }));
const as = (who: Who) => h.who.mockResolvedValue(who);
const BODY = { currentPassword: "old secret", password: "new secret 1" };

beforeEach(async () => {
  vi.resetModules();
  ({ POST } = await import("@/app/setup-api/users/me/password/route"));
  as({ username: "alice", isOwner: false });
  h.sameOrigin.mockReturnValue(true);
  h.change.mockReset();
  h.change.mockResolvedValue("ok");
  h.rotate.mockReset();
  h.rotate.mockResolvedValue("f".repeat(32));
});

describe("who may change a password here", () => {
  it("changes the signed-in user's own password, with exactly what they typed", async () => {
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.change).toHaveBeenCalledWith("alice", "old secret", "new secret 1");
  });

  it("ends the user's other sessions and keeps this one: a new session version, this browser re-signed", async () => {
    const res = await POST(new Request("http://box.local/setup-api/users/me/password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "clawbox_session=old.cookie" },
      body: JSON.stringify(BODY),
    }));
    expect(res.status).toBe(200);
    expect(h.rotate).toHaveBeenCalledWith("alice");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`clawbox_session=fresh.alice.${"f".repeat(32)}.`);
    expect(cookie.toLowerCase()).toContain("httponly");
  });

  it("says so when the other sessions could not be ended, rather than report it done", async () => {
    h.rotate.mockRejectedValue(new Error("disk full"));
    const res = await post(BODY);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "sessions_not_ended" });
    expect(h.rotate).toHaveBeenCalledTimes(2);
  });

  it("counts guesses still waiting on the helper: six at once reach it five times", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    h.change.mockImplementation(async () => { await gate; return "wrong"; });
    const replies = Array.from({ length: 6 }, () => post(BODY));
    await new Promise((r) => setTimeout(r, 20));
    release();
    const statuses = (await Promise.all(replies)).map((r) => r.status).sort();
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
    expect(h.change).toHaveBeenCalledTimes(5);
  });

  it("rotates nothing when the password did not change", async () => {
    h.change.mockResolvedValue("wrong");
    await post(BODY);
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it("sends the owner to their own password route, and changes nothing", async () => {
    as({ username: "clawbox", isOwner: true });
    const res = await post(BODY);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "owner_password" });
    expect(h.change).not.toHaveBeenCalled();
  });

  it("answers the agent's bearer and nobody signed in as signed out", async () => {
    as(null);
    expect((await post(BODY)).status).toBe(401);
    expect(h.change).not.toHaveBeenCalled();
  });

  it("refuses another site's page riding the user's cookie", async () => {
    h.sameOrigin.mockReturnValue(false);
    const res = await post(BODY);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "cross_origin" });
    expect(h.change).not.toHaveBeenCalled();
  });
});

describe("what it answers", () => {
  it("a wrong current password is a 400, never a 401", async () => {
    h.change.mockResolvedValue("wrong");
    const res = await post(BODY);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "wrong_password" });
  });

  it("stops asking the helper after five wrong passwords in a row", async () => {
    h.change.mockResolvedValue("wrong");
    for (let i = 0; i < 5; i++) expect((await post(BODY)).status).toBe(400);
    const res = await post(BODY);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "too_many_attempts" });
    expect(h.change).toHaveBeenCalledTimes(5);
    // Another user is not held to alice's guesses.
    as({ username: "bob", isOwner: false });
    h.change.mockResolvedValue("ok");
    expect((await post(BODY)).status).toBe(200);
  });

  it("maps the helper's other answers", async () => {
    for (const [result, status, code] of [
      ["invalid", 400, "invalid_password"],
      ["failed", 500, "password_change_failed"],
      ["unavailable", 503, "password_change_unavailable"],
    ] as const) {
      h.change.mockResolvedValue(result);
      const res = await post(BODY);
      expect(res.status, result).toBe(status);
      expect(await res.json(), result).toMatchObject({ code });
    }
  });

  it("refuses a body that is not the two strings", async () => {
    expect((await post(undefined, "{not json")).status).toBe(400);
    expect(await (await post({ password: "new secret 1" })).json()).toMatchObject({ code: "wrong_password" });
    expect(await (await post({ currentPassword: "old secret" })).json()).toMatchObject({ code: "invalid_password" });
    expect(await (await post([])).json()).toMatchObject({ code: "bad_body" });
    expect(h.change).not.toHaveBeenCalled();
  });
});
