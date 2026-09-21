import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";

const verifyPasswordMock = vi.fn();

vi.mock("@/lib/auth", () => ({ verifyPassword: verifyPasswordMock }));

/**
 * /setup-api/system/credentials/verify is a right/wrong password oracle, so
 * TASK-444b requires it to cost exactly what /login-api costs to ask: the same
 * MIN_RESPONSE_MS pad, the same persisted escalating lockout, and a session.
 * It previously answered in ~64 ms off an in-memory per-X-Forwarded-For bucket
 * the caller could reset by changing a header it controls.
 */

let session: SessionFixture;
let POST: (req: Request) => Promise<Response>;
let MIN_RESPONSE_MS: number;

async function loadRoute() {
  vi.resetModules();
  const limits = await import("@/lib/login-rate-limit");
  limits._resetForTest();
  MIN_RESPONSE_MS = limits.MIN_RESPONSE_MS;
  const mod = await import("@/app/setup-api/system/credentials/verify/route");
  POST = mod.POST;
}

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/setup-api/system/credentials/verify", {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: session.cookie, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Same request with no session cookie. */
function anonymousRequest(body: unknown): Request {
  return new Request("http://localhost/setup-api/system/credentials/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  session = installSessionFixture();
  await loadRoute();
});

afterEach(() => {
  verifyPasswordMock.mockReset();
  session.cleanup();
});

describe("/setup-api/system/credentials/verify", () => {
  it("rejects an unauthenticated caller with 401", async () => {
    verifyPasswordMock.mockResolvedValue(true);
    const res = await POST(anonymousRequest({ password: "right" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
    // The oracle must not even be consulted for a caller with no session.
    expect(verifyPasswordMock).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await POST(makeRequest("not-json"));
    expect(res.status).toBe(400);
  });

  it("rejects empty password with 400", async () => {
    const res = await POST(makeRequest({ password: "" }));
    expect(res.status).toBe(400);
  });

  it("returns 401 for an incorrect password", async () => {
    verifyPasswordMock.mockResolvedValue(false);
    const res = await POST(makeRequest({ password: "wrong" }));
    expect(res.status).toBe(401);
  });

  it("returns 200 ok:true for a correct password", async () => {
    verifyPasswordMock.mockResolvedValue(true);
    const res = await POST(makeRequest({ password: "right" }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  // ── TASK-444b: the timing oracle ───────────────────────────────────────────

  it("pads a correct and an incorrect answer to the same floor", async () => {
    verifyPasswordMock.mockResolvedValue(false);
    const wrongStart = Date.now();
    await POST(makeRequest({ password: "wrong" }));
    const wrongMs = Date.now() - wrongStart;

    await loadRoute();
    verifyPasswordMock.mockResolvedValue(true);
    const rightStart = Date.now();
    await POST(makeRequest({ password: "right" }));
    const rightMs = Date.now() - rightStart;

    // Both sit on the pad. Before the fix the wrong answer came back in ~60 ms
    // and the right one did too, but neither was padded at all — the oracle was
    // ~5x faster than /login-api, which is what made it worth attacking.
    expect(wrongMs).toBeGreaterThanOrEqual(MIN_RESPONSE_MS - 20);
    expect(rightMs).toBeGreaterThanOrEqual(MIN_RESPONSE_MS - 20);
  });

  it("pads the 400 paths too, so a malformed body is not a faster answer", async () => {
    const start = Date.now();
    await POST(makeRequest({ password: "" }));
    expect(Date.now() - start).toBeGreaterThanOrEqual(MIN_RESPONSE_MS - 20);
  });

  // ── TASK-444b/c: the throttle ──────────────────────────────────────────────

  it("locks out after repeated wrong passwords", async () => {
    verifyPasswordMock.mockResolvedValue(false);
    let last: Response | null = null;
    for (let i = 0; i < 5; i++) last = await POST(makeRequest({ password: "wrong" }));
    expect(last!.status).toBe(429);
    expect(last!.headers.get("Retry-After")).toBeTruthy();

    // And a *correct* password is still refused while the lock stands, so the
    // lockout can't be stepped over by guessing right on the next attempt.
    verifyPasswordMock.mockResolvedValue(true);
    const after = await POST(makeRequest({ password: "right" }));
    expect(after.status).toBe(429);
  });

  it("still hits the global cap when CF-Connecting-IP is rotated", async () => {
    verifyPasswordMock.mockResolvedValue(false);
    let last: Response | null = null;
    for (let i = 0; i < 5; i++) {
      last = await POST(makeRequest({ password: "wrong" }, { "CF-Connecting-IP": `203.0.113.${i}` }));
    }
    // Every request carried a different "client IP", so the per-IP buckets are
    // all at one failure — but the shared global bucket counted all five.
    expect(last!.status).toBe(429);
  });
});
