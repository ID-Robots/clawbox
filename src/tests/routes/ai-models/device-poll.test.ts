import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fsp from "fs/promises";
import path from "path";

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    unlink: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    mkdir: vi.fn(),
    stat: vi.fn(),
  },
}));

// Built the same way the route builds them, so the expectations hold on a
// developer's machine as well as on the device.
const STATE_PATH = path.join("/test/data", "oauth-device-state.json");
const TOKENS_PATH = path.join("/test/data", "oauth-device-tokens.json");

vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/test/data",
}));

vi.mock("@/lib/oauth-config", () => ({
  OPENAI_CLIENT_ID: "test-client-id",
  OPENAI_DEVICE_TOKEN_URL: "https://auth.openai.com/device/token",
  OPENAI_REDIRECT_URI: "https://clawbox.local/callback",
  OPENAI_TOKEN_URL: "https://auth.openai.com/token",
}));

const mockFs = vi.mocked(fsp);

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
    mockFs.writeFile.mockResolvedValue();
    mockFs.rename.mockResolvedValue();
    mockFs.mkdir.mockResolvedValue(undefined);
    // Default: no handoff file on disk, so the age sweep is a no-op.
    mockFs.stat.mockRejectedValue(new Error("ENOENT"));

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

  it("persists tokens server-side and returns complete without tokens in the body", async () => {
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
    // SEC-12: the browser gets only a status — provider tokens never travel
    // back over the plain-HTTP setup AP.
    expect(body.access_token).toBeUndefined();
    expect(body.refresh_token).toBeUndefined();
    // Tokens are written to the server-only handoff file instead.
    expect(mockFs.writeFile).toHaveBeenCalled();
    const written = JSON.parse(mockFs.writeFile.mock.calls.at(-1)?.[1] as string);
    expect(written.access_token).toBe("test-access-token");
    expect(written.refresh_token).toBe("test-refresh-token");
    expect(written.provider).toBe("openai");
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
    expect(body.access_token).toBeUndefined();
    const written = JSON.parse(mockFs.writeFile.mock.calls.at(-1)?.[1] as string);
    expect(written.access_token).toBe("exchanged-token");
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

  it("returns the OAuth tokens incl. id_token without an api-key exchange", async () => {
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
      });
    vi.stubGlobal("fetch", mockFetch);

    const res = await devicePollPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("complete");
    // Codex needs the JWTs, not an exchanged sk- key: id_token is preserved and
    // there is no third (id_token → api-key) fetch. The tokens are persisted
    // to the server-only handoff file, not returned to the browser.
    expect(body.access_token).toBeUndefined();
    expect(body.id_token).toBeUndefined();
    const written = JSON.parse(mockFs.writeFile.mock.calls.at(-1)?.[1] as string);
    expect(written.access_token).toBe("first-token");
    expect(written.id_token).toBe("test-id-token");
    expect(mockFetch).toHaveBeenCalledTimes(2);
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

  // A flow that ends without completing should leave nothing behind: the state
  // file and the token handoff file are two halves of the same flow, so both go.
  describe("interrupted flow cleanup", () => {
    it("removes the handoff tokens when the token exchange fails", async () => {
      vi.stubGlobal("fetch", vi.fn()
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
        }));

      const res = await devicePollPost();

      expect(res.status).toBe(502);
      expect(mockFs.unlink).toHaveBeenCalledWith(TOKENS_PATH);
      expect(mockFs.unlink).toHaveBeenCalledWith(STATE_PATH);
    });

    it("removes the handoff tokens when the provider returns no code_verifier", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ authorization_code: "test-auth-code" }),
      }));

      const res = await devicePollPost();

      expect(res.status).toBe(502);
      expect(mockFs.unlink).toHaveBeenCalledWith(TOKENS_PATH);
      expect(mockFs.unlink).toHaveBeenCalledWith(STATE_PATH);
    });

    it("sweeps a handoff file that is past the TTL", async () => {
      mockFs.stat.mockResolvedValue({ mtimeMs: Date.now() - 20 * 60 * 1000 } as never);
      mockFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const res = await devicePollPost();

      // No state file, so the poll itself is a 400 — the sweep runs regardless.
      expect(res.status).toBe(400);
      expect(mockFs.unlink).toHaveBeenCalledWith(TOKENS_PATH);
    });

    it("leaves a handoff file that is still inside the TTL", async () => {
      mockFs.stat.mockResolvedValue({ mtimeMs: Date.now() - 60 * 1000 } as never);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));

      const res = await devicePollPost();

      expect((await res.json()).status).toBe("pending");
      expect(mockFs.unlink).not.toHaveBeenCalledWith(TOKENS_PATH);
    });
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
