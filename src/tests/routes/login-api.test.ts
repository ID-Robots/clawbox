import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  verifyPassword: vi.fn(),
  createSessionCookie: vi.fn().mockReturnValue("session.cookie"),
  getOrCreateSecret: vi.fn().mockResolvedValue("secret"),
}));

import * as config from "@/lib/config-store";
import { verifyPassword, createSessionCookie, getOrCreateSecret } from "@/lib/auth";

const mockGet = vi.mocked(config.get);
const mockSet = vi.mocked(config.set);
const mockVerifyPassword = vi.mocked(verifyPassword);
const mockCreateSessionCookie = vi.mocked(createSessionCookie);
const mockGetOrCreateSecret = vi.mocked(getOrCreateSecret);

describe("/login-api", () => {
  let POST: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGet.mockResolvedValue(true as never);
    mockVerifyPassword.mockResolvedValue(false);
    mockCreateSessionCookie.mockReturnValue("session.cookie");
    mockGetOrCreateSecret.mockResolvedValue("secret");
    const mod = await import("@/app/login-api/route");
    POST = mod.POST;
  });

  it("returns success with session cookie on valid login", async () => {
    mockVerifyPassword.mockResolvedValue(true);
    const req = new Request("http://localhost/login-api", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "1.2.3.4" },
      body: JSON.stringify({ password: "correct", duration: 43200 }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(res.headers.get("set-cookie")).toContain("clawbox_session");
  });

  it("rejects incorrect password", async () => {
    mockVerifyPassword.mockResolvedValue(false);
    const req = new Request("http://localhost/login-api", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "1.2.3.5" },
      body: JSON.stringify({ password: "wrong", duration: 43200 }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("rejects missing password", async () => {
    const req = new Request("http://localhost/login-api", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "1.2.3.6" },
      body: JSON.stringify({ duration: 43200 }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("rejects invalid duration", async () => {
    const req = new Request("http://localhost/login-api", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "1.2.3.7" },
      body: JSON.stringify({ password: "test", duration: 999 }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("handles invalid JSON", async () => {
    const req = new Request("http://localhost/login-api", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "1.2.3.8" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns error when password not configured and setup not complete", async () => {
    mockGet.mockResolvedValue(null as never);
    const req = new Request("http://localhost/login-api", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "1.2.3.9" },
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
      headers: { "Content-Type": "application/json", "x-forwarded-for": "1.2.3.10" },
      body: JSON.stringify({ password: "correct", duration: 43200 }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mockSet).toHaveBeenCalledWith("password_configured", true);
  });
});
