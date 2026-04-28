import { afterEach, describe, expect, it, vi } from "vitest";

const verifyPasswordMock = vi.fn();
const checkRateLimitMock = vi.fn();
const clientIpMock = vi.fn();

vi.mock("@/lib/auth", () => ({ verifyPassword: verifyPasswordMock }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: checkRateLimitMock,
  clientIp: clientIpMock,
}));

afterEach(() => {
  verifyPasswordMock.mockReset();
  checkRateLimitMock.mockReset();
  clientIpMock.mockReset();
});

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/setup-api/system/credentials/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("/setup-api/system/credentials/verify", () => {
  it("rejects when rate-limited", async () => {
    clientIpMock.mockReturnValue("1.2.3.4");
    checkRateLimitMock.mockReturnValue(false);
    const mod = await import("@/app/setup-api/system/credentials/verify/route");
    const res = await mod.POST(makeRequest({ password: "x" }));
    expect(res.status).toBe(429);
  });

  it("rejects malformed JSON with 400", async () => {
    clientIpMock.mockReturnValue("1.2.3.4");
    checkRateLimitMock.mockReturnValue(true);
    const mod = await import("@/app/setup-api/system/credentials/verify/route");
    const res = await mod.POST(makeRequest("not-json"));
    expect(res.status).toBe(400);
  });

  it("rejects empty password with 400", async () => {
    clientIpMock.mockReturnValue("1.2.3.4");
    checkRateLimitMock.mockReturnValue(true);
    const mod = await import("@/app/setup-api/system/credentials/verify/route");
    const res = await mod.POST(makeRequest({ password: "" }));
    expect(res.status).toBe(400);
  });

  it("returns 401 for an incorrect password", async () => {
    clientIpMock.mockReturnValue("1.2.3.4");
    checkRateLimitMock.mockReturnValue(true);
    verifyPasswordMock.mockResolvedValue(false);
    const mod = await import("@/app/setup-api/system/credentials/verify/route");
    const res = await mod.POST(makeRequest({ password: "wrong" }));
    expect(res.status).toBe(401);
  });

  it("returns 200 ok:true for a correct password", async () => {
    clientIpMock.mockReturnValue("1.2.3.4");
    checkRateLimitMock.mockReturnValue(true);
    verifyPasswordMock.mockResolvedValue(true);
    const mod = await import("@/app/setup-api/system/credentials/verify/route");
    const res = await mod.POST(makeRequest({ password: "right" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
