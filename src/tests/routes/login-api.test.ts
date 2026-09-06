import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(),
  set: vi.fn(),
  DATA_DIR: "/tmp/clawbox-test-data",
}));

vi.mock("@/lib/auth", () => ({
  verifyPassword: vi.fn(),
  createSessionCookie: vi.fn().mockReturnValue("session.cookie"),
  getSessionSigningSecret: vi.fn().mockResolvedValue("secret"),
  getSessionGeneration: vi.fn().mockResolvedValue(0),
}));

vi.mock("@/lib/system-password", () => ({
  hasOwnerPassword: vi.fn(),
}));

vi.mock("@/lib/login-rate-limit", () => ({
  checkLockout: vi.fn(),
  recordFailure: vi.fn(),
  recordSuccess: vi.fn(),
  // No-op so tests don't sleep 300 ms each.
  padResponseTime: vi.fn().mockResolvedValue(undefined),
  SHARED_BUCKET_MAX_LOCK_MS: 300000,
}));

import * as config from "@/lib/config-store";
import { verifyPassword, createSessionCookie, getSessionSigningSecret } from "@/lib/auth";
import { checkLockout, recordFailure, recordSuccess, padResponseTime } from "@/lib/login-rate-limit";
import { hasOwnerPassword } from "@/lib/system-password";

const mockGet = vi.mocked(config.get);
const mockSet = vi.mocked(config.set);
const mockVerifyPassword = vi.mocked(verifyPassword);
const mockCreateSessionCookie = vi.mocked(createSessionCookie);
const mockGetSessionSigningSecret = vi.mocked(getSessionSigningSecret);
const mockCheckLockout = vi.mocked(checkLockout);
const mockRecordFailure = vi.mocked(recordFailure);
const mockRecordSuccess = vi.mocked(recordSuccess);
const mockPadResponseTime = vi.mocked(padResponseTime);
const mockHasOwnerPassword = vi.mocked(hasOwnerPassword);

describe("/login-api", () => {
  let POST: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGet.mockResolvedValue(true as never);
    mockVerifyPassword.mockResolvedValue(false);
    mockCreateSessionCookie.mockReturnValue("session.cookie");
    mockGetSessionSigningSecret.mockResolvedValue("secret");
    mockCheckLockout.mockResolvedValue({ locked: false, retryAfterSeconds: 0 });
    mockRecordFailure.mockResolvedValue({ locked: false, retryAfterSeconds: 0 });
    mockRecordSuccess.mockResolvedValue(undefined);
    // Default: no owner password on the account, so the flag alone decides and
    // the pre-existing cases below are unaffected by the shadow fallback.
    mockHasOwnerPassword.mockResolvedValue(false);
    const mod = await import("@/app/login-api/route");
    POST = mod.POST;
  });

  it("returns success with session cookie on valid login", async () => {
    mockVerifyPassword.mockResolvedValue(true);
    const req = new Request("http://localhost/login-api", {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.4" },
      body: JSON.stringify({ password: "correct", duration: 43200 }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(res.headers.get("set-cookie")).toContain("clawbox_session");
    expect(mockRecordSuccess).toHaveBeenCalledWith("cf:1.2.3.4");
    // Timing pad must run on the success path too — otherwise valid logins
    // return faster than failures, leaking signal to a probing attacker.
    expect(mockPadResponseTime).toHaveBeenCalled();
  });

  it("rejects incorrect password and records a failure", async () => {
    mockVerifyPassword.mockResolvedValue(false);
    const req = new Request("http://localhost/login-api", {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.5" },
      body: JSON.stringify({ password: "wrong", duration: 43200 }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(mockRecordFailure).toHaveBeenCalledWith("cf:1.2.3.5", { maxLockMs: undefined });
    expect(mockPadResponseTime).toHaveBeenCalled();
  });

  it("returns 429 with Retry-After when already locked out", async () => {
    mockCheckLockout.mockResolvedValue({ locked: true, retryAfterSeconds: 300 });
    const req = new Request("http://localhost/login-api", {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-connecting-ip": "9.9.9.9" },
      body: JSON.stringify({ password: "anything", duration: 43200 }),
    });
    const res = await POST(req);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("300");
    // Must not even attempt PAM verification once locked.
    expect(mockVerifyPassword).not.toHaveBeenCalled();
    expect(mockPadResponseTime).toHaveBeenCalled();
  });

  it("returns 429 when this failure tipped into a lockout", async () => {
    mockVerifyPassword.mockResolvedValue(false);
    mockRecordFailure.mockResolvedValue({ locked: true, retryAfterSeconds: 600 });
    const req = new Request("http://localhost/login-api", {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.6" },
      body: JSON.stringify({ password: "wrong", duration: 43200 }),
    });
    const res = await POST(req);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("600");
  });

  // TASK-444c, pinned here for the first time. Main's rateLimitKey() returned
  // ONLY `cf:<ip>` when the header was present, so a header-carrying request
  // never touched the global bucket and every fresh value minted an empty,
  // un-capped one — the scanner's "unlimited fresh buckets" path. The two
  // cases below fail against that shape; the earlier cf cases do not.
  it("a request carrying cf-connecting-ip is also charged to global", async () => {
    mockVerifyPassword.mockResolvedValue(false);
    const req = new Request("http://localhost/login-api", {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.5" },
      body: JSON.stringify({ password: "wrong", duration: 43200 }),
    });
    await POST(req);
    expect(mockRecordFailure).toHaveBeenCalledWith("cf:1.2.3.5", { maxLockMs: undefined });
    expect(mockRecordFailure).toHaveBeenCalledWith("global", { maxLockMs: 300000 });
    expect(mockRecordFailure).toHaveBeenCalledTimes(2);
  });

  it("a locked global bucket refuses a request with a fresh cf header before verifyPassword", async () => {
    // The cf bucket is brand new and clear; only the shared one is locked.
    // Rotating the header must buy nothing: no unix_chkpwd call, a 429.
    mockCheckLockout.mockImplementation(async (key: string) =>
      key === "global" ? { locked: true, retryAfterSeconds: 300 } : { locked: false, retryAfterSeconds: 0 },
    );
    const req = new Request("http://localhost/login-api", {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-connecting-ip": "198.51.100.77" },
      body: JSON.stringify({ password: "anything", duration: 43200 }),
    });
    const res = await POST(req);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("300");
    expect(mockCheckLockout).toHaveBeenCalledWith("global");
    expect(mockVerifyPassword).not.toHaveBeenCalled();
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it("buckets requests with no proxy header into a global counter", async () => {
    mockVerifyPassword.mockResolvedValue(false);
    const req = new Request("http://localhost/login-api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong", duration: 43200 }),
    });
    await POST(req);
    expect(mockRecordFailure).toHaveBeenCalledWith("global", { maxLockMs: 300000 });
  });

  it("rejects missing password", async () => {
    const req = new Request("http://localhost/login-api", {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.6" },
      body: JSON.stringify({ duration: 43200 }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    // Validation rejections aren't credential failures and must not advance
    // the lockout counter — that would let "password missing" spam lock out
    // the real owner.
    expect(mockRecordFailure).not.toHaveBeenCalled();
    // …but the timing pad still has to run, otherwise the validation path
    // is fast-fail relative to PAM and an attacker can probe by latency.
    expect(mockPadResponseTime).toHaveBeenCalled();
  });

  it("rejects invalid duration", async () => {
    const req = new Request("http://localhost/login-api", {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.7" },
      body: JSON.stringify({ password: "test", duration: 999 }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it("handles invalid JSON", async () => {
    const req = new Request("http://localhost/login-api", {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.8" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns error when password not configured and setup not complete", async () => {
    mockGet.mockResolvedValue(null as never);
    const req = new Request("http://localhost/login-api", {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.9" },
      body: JSON.stringify({ password: "test", duration: 43200 }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("auto-migrates when setup complete but password not configured", async () => {
    mockGet
      .mockResolvedValueOnce(null as never)  // password_configured
      .mockResolvedValueOnce(true as never); // setup_complete
    mockVerifyPassword.mockResolvedValue(true);
    const req = new Request("http://localhost/login-api", {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.10" },
      body: JSON.stringify({ password: "correct", duration: 43200 }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mockSet).toHaveBeenCalledWith("password_configured", true);
  });

  // The unclaimable-box deadlock: config.json says "no password" while the OS
  // account carries one somebody set. system/credentials refuses (shadow says
  // the box is owned, so it demands a session) and this route used to refuse
  // too (flag says unconfigured), leaving no way in from the UI at all.
  describe("when the flag and /etc/shadow disagree", () => {
    it("lets the owner log in when shadow says the account is owned", async () => {
      mockGet
        .mockResolvedValueOnce(null as never)   // password_configured
        .mockResolvedValueOnce(false as never); // setup_complete — wizard never finished
      mockHasOwnerPassword.mockResolvedValue(true);
      mockVerifyPassword.mockResolvedValue(true);

      const req = new Request("http://localhost/login-api", {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.11" },
        body: JSON.stringify({ password: "the-owners-password", duration: 43200 }),
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect((await res.json()).success).toBe(true);
    });

    it("heals the stale flag so the next request takes the normal path", async () => {
      mockGet
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce(false as never);
      mockHasOwnerPassword.mockResolvedValue(true);
      mockVerifyPassword.mockResolvedValue(true);

      const req = new Request("http://localhost/login-api", {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.12" },
        body: JSON.stringify({ password: "the-owners-password", duration: 43200 }),
      });
      await POST(req);

      expect(mockSet).toHaveBeenCalledWith("password_configured", true);
    });

    it("still rejects the wrong password on such a box", async () => {
      mockGet
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce(false as never);
      mockHasOwnerPassword.mockResolvedValue(true);
      mockVerifyPassword.mockResolvedValue(false);

      const req = new Request("http://localhost/login-api", {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.13" },
        body: JSON.stringify({ password: "wrong", duration: 43200 }),
      });
      const res = await POST(req);

      expect(res.status).toBe(401);
    });

    // The security property that makes trusting shadow safe: hasOwnerPassword()
    // is false for the published factory default, so an as-flashed box is still
    // refused here and must go through the wizard.
    it("keeps refusing an as-flashed box, whose account holds only the factory default", async () => {
      mockGet
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce(false as never);
      mockHasOwnerPassword.mockResolvedValue(false);
      mockVerifyPassword.mockResolvedValue(true);

      const req = new Request("http://localhost/login-api", {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.14" },
        body: JSON.stringify({ password: "clawbox", duration: 43200 }),
      });
      const res = await POST(req);

      expect(res.status).toBe(400);
      expect(mockSet).not.toHaveBeenCalledWith("password_configured", true);
    });

    // hasOwnerPassword() returns null when /etc/shadow cannot be read at all.
    // "Unknown" must not open the path.
    it("refuses when the shadow state cannot be read", async () => {
      mockGet
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce(false as never);
      mockHasOwnerPassword.mockResolvedValue(null);
      mockVerifyPassword.mockResolvedValue(true);

      const req = new Request("http://localhost/login-api", {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.15" },
        body: JSON.stringify({ password: "anything", duration: 43200 }),
      });
      const res = await POST(req);

      expect(res.status).toBe(400);
    });
  });
});
