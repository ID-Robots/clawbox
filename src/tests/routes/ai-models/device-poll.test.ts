import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fsp from "fs/promises";

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    unlink: vi.fn(),
  },
}));

vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/test/data",
}));

vi.mock("@/lib/oauth-config", () => ({
  OPENAI_CLIENT_ID: "test-client-id",
  OPENAI_DEVICE_TOKEN_URL: "https://auth.openai.com/device/token",
  OPENAI_REDIRECT_URI: "https://clawbox.local/callback",
  OPENAI_TOKEN_URL: "https://auth.openai.com/token",
}));

const mockFs = vi.mocked(fsp.default);

describe("POST /setup-api/ai-models/oauth/device-poll", () => {
  let devicePollPost: () => Promise<Response>;

  const validState = {
    provider: "openai",
    device_id: "test-device-id",
    user_code: "ABCD-1234",
    interval: 5,
    createdAt: Date.now(),
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockFs.readFile.mockResolvedValue(JSON.stringify(validState));
    mockFs.unlink.mockResolvedValue();

    vi.stubGlobal("fetch", vi.fn());

    const mod = await import("@/app/setup-api/ai-models/oauth/device-poll/route");
    devicePollPost = mod.POST;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("returns pending when user hasn't authorized", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await devicePollPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("pending");
  });

  it("returns pending for 404 status", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await devicePollPost();
    const body = await res.json();

    expect(body.status).toBe("pending");
  });

  it("returns 400 when no state file exists", async () => {
    mockFs.readFile.mockRejectedValue(new Error("ENOENT"));

    const res = await devicePollPost();
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("No pending device auth");
  });

  it("returns 400 when state is expired", async () => {
    const expiredState = {
      ...validState,
      createdAt: Date.now() - 20 * 60 * 1000, // 20 minutes ago
    };
    mockFs.readFile.mockResolvedValue(JSON.stringify(expiredState));

    const res = await devicePollPost();
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("expired");
  });

  it("returns 400 when device_id is missing", async () => {
    const invalidState = {
      provider: "openai",
      user_code: "ABCD-1234",
      interval: 5,
      createdAt: Date.now(),
    };
    mockFs.readFile.mockResolvedValue(JSON.stringify(invalidState));

    const res = await devicePollPost();
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("Missing device_id");
  });

  it("returns complete with tokens on success", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        expires_in: 3600,
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await devicePollPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("complete");
    expect(body.access_token).toBe("test-access-token");
    expect(body.refresh_token).toBe("test-refresh-token");
    expect(mockFs.unlink).toHaveBeenCalled();
  });

  it("exchanges auth code for tokens", async () => {
    const mockFetch = vi.fn()
      // First call: poll returns auth code
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          authorization_code: "test-auth-code",
          code_verifier: "test-verifier",
        }),
      })
      // Second call: token exchange
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          access_token: "exchanged-token",
          refresh_token: "exchanged-refresh",
          expires_in: 7200,
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const res = await devicePollPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("complete");
    expect(body.access_token).toBe("exchanged-token");
  });

  it("returns 502 when no code_verifier in response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        authorization_code: "test-auth-code",
        // No code_verifier
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await devicePollPost();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toContain("code_verifier");
  });

  it("returns 502 when token exchange fails", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          authorization_code: "test-auth-code",
          code_verifier: "test-verifier",
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve("Invalid code"),
      });
    vi.stubGlobal("fetch", mockFetch);

    const res = await devicePollPost();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toContain("Token exchange failed");
  });

  it("attempts API key exchange when id_token present", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          authorization_code: "test-auth-code",
          code_verifier: "test-verifier",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          access_token: "first-token",
          id_token: "test-id-token",
          refresh_token: "first-refresh",
          expires_in: 3600,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          api_key: "sk-test-api-key",
          expires_in: 86400,
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const res = await devicePollPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("complete");
    expect(body.access_token).toBe("sk-test-api-key");
  });

  it("falls back to access_token when API key exchange fails", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          authorization_code: "test-auth-code",
          code_verifier: "test-verifier",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          access_token: "fallback-token",
          id_token: "test-id-token",
          refresh_token: "first-refresh",
          expires_in: 3600,
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
      });
    vi.stubGlobal("fetch", mockFetch);

    const res = await devicePollPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.access_token).toBe("fallback-token");
  });

  it("returns 502 for server errors", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Server error"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await devicePollPost();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toContain("500");
  });

  it("returns 500 when fetch throws", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    vi.stubGlobal("fetch", mockFetch);

    const res = await devicePollPost();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Network error");
  });

  it("handles legacy state format with device_auth_id", async () => {
    const legacyState = {
      device_auth_id: "legacy-device-id",
      user_code: "ABCD-1234",
      interval: 5,
      createdAt: Date.now(),
    };
    mockFs.readFile.mockResolvedValue(JSON.stringify(legacyState));

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await devicePollPost();
    const body = await res.json();

    // Should not fail - should use device_auth_id as fallback
    expect(body.status).toBe("pending");
  });

  it("returns pending for unknown response format", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ unknown: "data" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await devicePollPost();
    const body = await res.json();

    expect(body.status).toBe("pending");
  });
});
