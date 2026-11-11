import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /setup-api/users/me/password — a ClawBox user other than the owner
 * changes their OWN password (Settings → Account, TASK-2435). Pinned:
 *  - a person's cookie from our own page only; never the owner (their
 *    password is system/credentials'), never the agent's bearer;
 *  - the order: the current password is checked, THEN every other session is
 *    ended, THEN the password changes — so a password never changes while
 *    older sessions stay valid, and a rotation that cannot be stored changes
 *    nothing;
 *  - a wrong current password is a 400 (never the 401 the desktop reads as
 *    "signed out"), charged to the login's own per-account bucket; one guess
 *    per account at a time; a lock the bucket could not store is still held.
 */

type Who = { username: string; isOwner: boolean } | null;

const h = vi.hoisted(() => ({
  who: vi.fn(async (): Promise<{ username: string; isOwner: boolean } | null> => ({ username: "alice", isOwner: false })),
  sameOrigin: vi.fn(() => true),
  verify: vi.fn(async (): Promise<string> => "ok"),
  change: vi.fn(async (): Promise<string> => "ok"),
  rotate: vi.fn(async (): Promise<string | null> => "f".repeat(32)),
  order: [] as string[],
  locked: vi.fn<(key: string, opts?: unknown) => Promise<{ locked: boolean; retryAfterSeconds: number }>>(async () => ({ locked: false, retryAfterSeconds: 0 })),
  failure: vi.fn<(key: string, opts?: unknown) => Promise<{ locked: boolean; retryAfterSeconds: number }>>(async () => ({ locked: false, retryAfterSeconds: 0 })),
  success: vi.fn(async () => undefined),
}));

vi.mock("@/lib/owner-session", () => ({ personSession: h.who }));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: h.sameOrigin }));
vi.mock("@/lib/clawbox-users", () => ({
  checkUserPassword: h.verify,
  changeUserPassword: h.change,
  rotateUserSessionVersion: h.rotate,
}));
vi.mock("@/lib/login-rate-limit", () => ({
  checkLockout: h.locked,
  recordFailure: h.failure,
  recordSuccess: h.success,
  SHARED_BUCKET_MAX_LOCK_MS: 300_000,
}));
vi.mock("@/lib/auth", () => ({
  isSafePasswordChars: (s: string) => !/[\r\n\x00-\x1f\x7f]/.test(s),
  getSessionSigningSecret: vi.fn(async () => "test-secret"),
  getSessionGeneration: vi.fn(async () => 0),
  readSessionClaims: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3_600 })),
  createSessionCookie: vi.fn((duration: number, _s: string, _g: number, who: { u: string; sv?: string }) => `fresh.${who.u}.${who.sv}.${duration}`),
}));

let POST: (req: Request) => Promise<Response>;

const post = (body: unknown, raw?: string) =>
  POST(new Request("http://box.local/setup-api/users/me/password", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "clawbox_session=old.cookie" },
    body: raw ?? JSON.stringify(body),
  }));
const as = (who: Who) => h.who.mockResolvedValue(who);
const BODY = { currentPassword: "old secret", password: "new secret 1" };
const freshCookie = (res: Response) => res.headers.get("set-cookie") ?? "";

beforeEach(async () => {
  vi.resetModules();
  ({ POST } = await import("@/app/setup-api/users/me/password/route"));
  as({ username: "alice", isOwner: false });
  h.sameOrigin.mockReturnValue(true);
  h.order.length = 0;
  h.verify.mockReset();
  h.verify.mockImplementation(async () => { h.order.push("verify"); return "ok"; });
  h.rotate.mockReset();
  h.rotate.mockImplementation(async () => { h.order.push("rotate"); return "f".repeat(32); });
  h.change.mockReset();
  h.change.mockImplementation(async () => { h.order.push("change"); return "ok"; });
  h.locked.mockReset();
  h.locked.mockResolvedValue({ locked: false, retryAfterSeconds: 0 });
  h.failure.mockReset();
  h.failure.mockResolvedValue({ locked: false, retryAfterSeconds: 0 });
  h.success.mockClear();
});

describe("who may change a password here", () => {
  it("changes the signed-in user's own password, with exactly what they typed", async () => {
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.verify).toHaveBeenCalledWith("alice", "old secret");
    expect(h.change).toHaveBeenCalledWith("alice", "old secret", "new secret 1");
  });

  it("sends the owner to their own password route, and changes nothing", async () => {
    as({ username: "clawbox", isOwner: true });
    const res = await post(BODY);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "owner_password" });
    expect(h.verify).not.toHaveBeenCalled();
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

describe("other sessions end before the password changes", () => {
  it("checks, then ends every other session, then changes — and re-signs this browser", async () => {
    const res = await post(BODY);
    expect(h.order).toEqual(["verify", "rotate", "change"]);
    expect(h.rotate).toHaveBeenCalledWith("alice");
    const cookie = freshCookie(res);
    expect(cookie).toContain(`clawbox_session=fresh.alice.${"f".repeat(32)}.`);
    expect(cookie.toLowerCase()).toContain("httponly");
  });

  it("changes NOTHING when the other sessions could not be ended, and says so", async () => {
    h.rotate.mockRejectedValue(new Error("disk full"));
    const res = await post(BODY);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "sessions_not_ended" });
    expect(h.rotate).toHaveBeenCalledTimes(2);
    expect(h.change).not.toHaveBeenCalled();
  });

  it("keeps this browser signed in when the change fails after the sessions were ended", async () => {
    h.change.mockResolvedValue("failed");
    const res = await post(BODY);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "password_change_failed" });
    expect(freshCookie(res)).toContain("clawbox_session=fresh.alice.");
  });

  it("holds the account's password-change lock for the whole change, so no sign-in is issued in between", async () => {
    const lock = await import("@/lib/password-change-lock");
    let seenDuring = false;
    h.rotate.mockImplementation(async () => { seenDuring = lock.passwordChangeInProgress("alice"); return "f".repeat(32); });
    await post(BODY);
    expect(seenDuring).toBe(true);
    expect(lock.passwordChangeInProgress("alice")).toBe(false);
  });

  it("ends no session for a wrong current password", async () => {
    h.verify.mockResolvedValue("wrong");
    await post(BODY);
    expect(h.rotate).not.toHaveBeenCalled();
    expect(h.change).not.toHaveBeenCalled();
  });

  it("asks nothing of the box for a new password outside the rules", async () => {
    for (const password of ["short", "x".repeat(257), "new\nsecret 1", 12345678]) {
      const res = await post({ currentPassword: "old secret", password });
      expect(await res.json(), String(password)).toMatchObject({ code: "invalid_password" });
    }
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.rotate).not.toHaveBeenCalled();
  });
});

describe("guessing", () => {
  it("a wrong current password is a 400, never a 401, charged to the login's per-account bucket", async () => {
    h.verify.mockResolvedValue("wrong");
    const res = await post(BODY);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "wrong_password" });
    expect(h.failure).toHaveBeenCalledWith("user:alice", { maxLockMs: 300_000 });
    expect(h.success).not.toHaveBeenCalled();
  });

  it("clears the bucket on success", async () => {
    await post(BODY);
    expect(h.success).toHaveBeenCalledWith("user:alice");
  });

  it("asks the helper nothing while the account is locked out — by this route or by sign-in", async () => {
    h.locked.mockResolvedValue({ locked: true, retryAfterSeconds: 60 });
    const res = await post(BODY);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "too_many_attempts" });
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.locked).toHaveBeenCalledWith("user:alice");
  });

  it("is charged to sign-in's buckets as well — the shared one, and the tunnel client's when Cloudflare names one", async () => {
    h.verify.mockResolvedValue("wrong");
    const res = await POST(new Request("http://box.local/setup-api/users/me/password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "clawbox_session=old.cookie", "cf-connecting-ip": "203.0.113.7" },
      body: JSON.stringify(BODY),
    }));
    expect(res.status).toBe(400);
    expect(h.failure).toHaveBeenCalledWith("user:alice", { maxLockMs: 300_000 });
    expect(h.failure).toHaveBeenCalledWith("global", { maxLockMs: 300_000 });
    expect(h.failure).toHaveBeenCalledWith("cf:203.0.113.7", { maxLockMs: undefined });
  });

  it("a right one clears every bucket it was charged to, as sign-in does", async () => {
    await post(BODY);
    expect(h.success).toHaveBeenCalledWith("user:alice");
    expect(h.success).toHaveBeenCalledWith("global");
  });

  it("checks no password while sign-in's shared or tunnel-client bucket is locked", async () => {
    for (const lockedKey of ["global", "cf:203.0.113.7"]) {
      h.locked.mockImplementation(async (key: string) => ({ locked: key === lockedKey, retryAfterSeconds: key === lockedKey ? 60 : 0 }));
      const res = await POST(new Request("http://box.local/setup-api/users/me/password", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "clawbox_session=old.cookie", "cf-connecting-ip": "203.0.113.7" },
        body: JSON.stringify(BODY),
      }));
      expect(res.status, lockedKey).toBe(429);
      expect(await res.json(), lockedKey).toMatchObject({ code: "too_many_attempts" });
    }
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.change).not.toHaveBeenCalled();
  });

  it("a lock of the shared bucket is not held against the account in memory", async () => {
    h.verify.mockResolvedValue("wrong");
    h.failure.mockImplementation(async (key: string) => ({ locked: key === "global", retryAfterSeconds: key === "global" ? 300 : 0 }));
    expect((await post(BODY)).status).toBe(400);
    // The shared bucket has cleared since: the account itself was never locked.
    h.verify.mockResolvedValue("ok");
    expect((await post(BODY)).status).toBe(200);
  });

  it("holds a lock the shared bucket reported but could not store", async () => {
    h.verify.mockResolvedValue("wrong");
    h.failure.mockResolvedValue({ locked: true, retryAfterSeconds: 300 });
    expect((await post(BODY)).status).toBe(400);
    // The bucket forgot (a full table): this process did not.
    h.locked.mockResolvedValue({ locked: false, retryAfterSeconds: 0 });
    expect((await post(BODY)).status).toBe(429);
    expect(h.verify).toHaveBeenCalledTimes(1);
  });

  it("takes one guess per account at a time: six sent at once reach the helper once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    h.verify.mockImplementation(async () => { await gate; return "wrong"; });
    // A barrier, not a timer: the gate opens only once the other five have
    // been answered, so every request reached the lock while it was held.
    let answered = 0;
    const replies = Array.from({ length: 6 }, () => post(BODY).then((r) => { answered++; return r; }));
    await vi.waitFor(() => expect(answered).toBe(5));
    expect(h.verify).toHaveBeenCalledTimes(1);
    release();
    const statuses = (await Promise.all(replies)).map((r) => r.status).sort();
    expect(statuses).toEqual([400, 429, 429, 429, 429, 429]);
    expect(h.verify).toHaveBeenCalledTimes(1);
    // Another account is not held by alice's guess.
    h.verify.mockResolvedValue("ok");
    as({ username: "bob", isOwner: false });
    expect((await post(BODY)).status).toBe(200);
  });

  it("maps the helper's other answers", async () => {
    h.verify.mockResolvedValue("unavailable");
    expect(await (await post(BODY)).json()).toMatchObject({ code: "password_change_unavailable" });
    h.verify.mockResolvedValue("ok");
    for (const [result, status, code] of [
      ["invalid", 400, "invalid_password"],
      ["failed", 500, "password_change_failed"],
      ["unavailable", 503, "password_change_unavailable"],
      ["wrong", 400, "wrong_password"],
    ] as const) {
      h.change.mockResolvedValue(result);
      const res = await post(BODY);
      expect(res.status, result).toBe(status);
      expect(await res.json(), result).toMatchObject({ code });
    }
  });

  it("refuses a large body before it takes the lock or asks anything", async () => {
    const res = await post({ currentPassword: "old secret", password: "new secret 1", pad: "x".repeat(64 * 1024) });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "body_too_large" });
    expect(h.verify).not.toHaveBeenCalled();
  });

  /** A request whose body arrives as a stream of chunks, declaring no length (Transfer-Encoding: chunked). */
  const postChunked = (chunks: string[], headers: Record<string, string> = {}) => {
    const encoder = new TextEncoder();
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled < chunks.length) controller.enqueue(encoder.encode(chunks[pulled++]));
        else controller.close();
      },
    });
    return {
      read: () => pulled,
      res: POST(new Request("http://box.local/setup-api/users/me/password", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "clawbox_session=old.cookie", ...headers },
        body: stream,
        duplex: "half",
      } as RequestInit)),
    };
  };

  it("refuses a body that only DECLARES more than 8 KB, on the header alone", async () => {
    const res = await POST(new Request("http://box.local/setup-api/users/me/password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "clawbox_session=old.cookie", "content-length": String(8 * 1024 + 1) },
      body: JSON.stringify(BODY),
    }));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "body_too_large", error: "That request body is too large." });
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.locked).not.toHaveBeenCalled();
  });

  it("refuses a chunked body past 8 KB once it arrives, without reading the rest", async () => {
    const chunks = ['{"currentPassword":"old secret","password":"new secret 1","pad":"', ...Array.from({ length: 64 }, () => "x".repeat(1024)), '"}'];
    const { res, read } = postChunked(chunks);
    const answered = await res;
    expect(answered.status).toBe(413);
    expect(await answered.json()).toMatchObject({ code: "body_too_large" });
    // Cut off at the cap: nowhere near all 64 KB was pulled from the client.
    expect(read()).toBeLessThan(chunks.length);
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.change).not.toHaveBeenCalled();
  });

  it("still takes a small chunked body that declares no length", async () => {
    const json = JSON.stringify(BODY);
    const { res } = postChunked([json.slice(0, 10), json.slice(10)]);
    const answered = await res;
    expect(answered.status).toBe(200);
    expect(h.change).toHaveBeenCalledWith("alice", "old secret", "new secret 1");
  });

  it("refuses a body that is not the two strings", async () => {
    expect((await post(undefined, "{not json")).status).toBe(400);
    expect(await (await post({ password: "new secret 1" })).json()).toMatchObject({ code: "wrong_password" });
    expect(await (await post({ currentPassword: "old secret" })).json()).toMatchObject({ code: "invalid_password" });
    expect(await (await post([])).json()).toMatchObject({ code: "bad_body" });
    expect(h.verify).not.toHaveBeenCalled();
  });
});
