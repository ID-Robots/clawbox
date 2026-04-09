import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fsp from "fs/promises";

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
  },
}));

vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/test/data",
}));

vi.mock("@/lib/oauth-config", () => ({
  DEVICE_AUTH_PROVIDERS: {
    openai: {
      clientId: "test-client-id",
      scope: "openid profile email",
      deviceCodeUrl: "https://auth.openai.com/device/code",
      verificationUrl: "https://auth.openai.com/device",
      requestFormat: "form",
      responseFields: {
        deviceId: "device_auth_id",
        userCode: "user_code",
        interval: "interval",
      },
    },
    google: {
      clientId: "google-client-id",
      scope: "https://www.googleapis.com/auth/cloud-platform",
      deviceCodeUrl: "https://oauth2.googleapis.com/device/code",
      verificationUrl: "https://www.google.com/device",
      requestFormat: "json",
      responseFields: {
        deviceId: "device_code",
        userCode: "user_code",
        interval: "interval",
      },
    },
  },
}));

const mockFs = vi.mocked(fsp);

describe("POST /setup-api/ai-models/oauth/device-start", () => {
  let deviceStartPost: (req: Request) => Promise<Response>;

  function jsonRequest(body: unknown): Request {
    return new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function emptyRequest(): Request {
    return new Request("http://localhost/test", { method: "POST" });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue();
    mockFs.rename.mockResolvedValue();

    vi.stubGlobal("fetch", vi.fn());

    const mod = await import("@/app/setup-api/ai-models/oauth/device-start/route");
    deviceStartPost = mod.POST;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("starts device auth for default provider (openai)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        device_auth_id: "test-device-id",
        user_code: "ABCD-1234",
        interval: 5,
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await deviceStartPost(emptyRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.verification_url).toBeDefined();
    expect(body.user_code).toBe("ABCD-1234");
    expect(body.interval).toBe(5);
  });

  it("starts device auth for specific provider", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        device_code: "google-device-id",
        user_code: "GOOGLE-CODE",
        interval: 10,
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await deviceStartPost(jsonRequest({ provider: "google" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.user_code).toBe("GOOGLE-CODE");
  });

  it("returns 400 for unsupported provider", async () => {
    const res = await deviceStartPost(jsonRequest({ provider: "unknown" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("not supported");
  });

  it("returns 502 when provider returns error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("Invalid client"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await deviceStartPost(emptyRequest());
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toContain("400");
  });

  it("returns 502 when response is missing required fields", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ some: "other data" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await deviceStartPost(emptyRequest());
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toContain("Unexpected response");
  });

  it("returns 500 when fetch throws", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    vi.stubGlobal("fetch", mockFetch);

    const res = await deviceStartPost(emptyRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Network error");
  });

  it("saves state to file", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        device_auth_id: "test-device-id",
        user_code: "ABCD-1234",
        interval: 5,
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await deviceStartPost(emptyRequest());

    expect(mockFs.mkdir).toHaveBeenCalled();
    expect(mockFs.writeFile).toHaveBeenCalled();
    expect(mockFs.rename).toHaveBeenCalled();
  });

  it("handles invalid JSON body gracefully", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        device_auth_id: "test-device-id",
        user_code: "ABCD-1234",
        interval: 5,
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const req = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await deviceStartPost(req);

    // Should default to openai
    expect(res.status).toBe(200);
  });

  it("uses form encoding for openai", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        device_auth_id: "test-device-id",
        user_code: "ABCD-1234",
        interval: 5,
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await deviceStartPost(jsonRequest({ provider: "openai" }));

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      })
    );
  });

  it("uses JSON encoding for google", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        device_code: "test-device-id",
        user_code: "ABCD-1234",
        interval: 5,
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await deviceStartPost(jsonRequest({ provider: "google" }));

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { "Content-Type": "application/json" },
      })
    );
  });
});
