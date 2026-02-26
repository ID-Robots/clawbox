import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type RoutePost = (request: Request) => Promise<Response>;

const TEST_ROOT = path.join(
  os.tmpdir(),
  `clawbox-oauth-tests-${process.pid}-${Date.now()}`
);
const DATA_DIR = path.join(TEST_ROOT, "data");
const STATE_PATH = path.join(DATA_DIR, "oauth-state.json");
const ORG_PATH = path.join(DATA_DIR, "oauth-org.json");

let startPost: RoutePost;
let exchangePost: RoutePost;

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function resetDataDir(): Promise<void> {
  await fs.rm(DATA_DIR, { recursive: true, force: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function writeState(overrides?: Partial<{
  codeVerifier: string;
  state: string;
  provider: string;
  createdAt: number;
}>): Promise<void> {
  const payload = {
    codeVerifier: "test-code-verifier",
    state: "test-state",
    provider: "openai",
    createdAt: Date.now(),
    ...(overrides || {}),
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(payload), "utf-8");
}

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  await resetDataDir();
  vi.resetModules();
  ({ POST: startPost } = await import("@/app/setup-api/ai-models/oauth/start/route"));
  ({ POST: exchangePost } = await import("@/app/setup-api/ai-models/oauth/exchange/route"));
});

beforeEach(async () => {
  vi.unstubAllGlobals();
  await resetDataDir();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.CLAWBOX_ROOT;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("OAuth start route", () => {
  it("rejects unsupported providers", async () => {
    const res = await startPost(jsonRequest({ provider: "unknown-provider" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("OAuth not supported");
  });

  it("defaults to anthropic when request JSON is invalid", async () => {
    const badJsonRequest = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    const res = await startPost(badJsonRequest);
    const body = await res.json();
    const url = new URL(body.url);
    const stored = JSON.parse(await fs.readFile(STATE_PATH, "utf-8"));

    expect(res.status).toBe(200);
    expect(url.origin).toBe("https://claude.ai");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(stored.provider).toBe("anthropic");
    expect(typeof stored.state).toBe("string");
    expect(stored.state.length).toBeGreaterThan(10);
  });

  it("generates an OpenAI authorize URL and reuses saved organization", async () => {
    await fs.writeFile(
      ORG_PATH,
      JSON.stringify({ organizationId: "org_test_123" }),
      "utf-8"
    );

    const res = await startPost(jsonRequest({ provider: "openai" }));
    const body = await res.json();
    const url = new URL(body.url);
    const stored = JSON.parse(await fs.readFile(STATE_PATH, "utf-8"));
    const orgFileStillExists = await fs.readFile(ORG_PATH, "utf-8");

    expect(res.status).toBe(200);
    expect(url.origin).toBe("https://auth.openai.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:1455/auth/callback"
    );
    expect(url.searchParams.get("organization")).toBe("org_test_123");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(stored.provider).toBe("openai");
    expect(typeof stored.codeVerifier).toBe("string");
    expect(stored.codeVerifier.length).toBeGreaterThan(10);
    expect(orgFileStillExists).toContain("org_test_123");
  });

  it("replaces a symlinked state file before writing a new state", async () => {
    const symlinkTarget = path.join(DATA_DIR, "state-target.json");
    await fs.writeFile(symlinkTarget, "stale", "utf-8");
    await fs.symlink(symlinkTarget, STATE_PATH);

    const res = await startPost(jsonRequest({ provider: "anthropic" }));
    const body = await res.json();
    const url = new URL(body.url);
    const stat = await fs.lstat(STATE_PATH);
    const stored = JSON.parse(await fs.readFile(STATE_PATH, "utf-8"));

    expect(res.status).toBe(200);
    expect(url.origin).toBe("https://claude.ai");
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stored.provider).toBe("anthropic");
  });

  it("keeps a regular state file when lstat shows non-symlink", async () => {
    await fs.writeFile(STATE_PATH, "{}", "utf-8");

    const res = await startPost(jsonRequest({ provider: "anthropic" }));
    const body = await res.json();
    const url = new URL(body.url);
    const stat = await fs.lstat(STATE_PATH);

    expect(res.status).toBe(200);
    expect(url.origin).toBe("https://claude.ai");
    expect(stat.isSymbolicLink()).toBe(false);
  });

  it("ignores oauth-org file without organizationId", async () => {
    await fs.writeFile(ORG_PATH, JSON.stringify({ note: "missing id" }), "utf-8");

    const res = await startPost(jsonRequest({ provider: "openai" }));
    const body = await res.json();
    const url = new URL(body.url);

    expect(res.status).toBe(200);
    expect(url.searchParams.get("organization")).toBeNull();
  });

  it("returns 500 when filesystem setup fails", async () => {
    vi.spyOn(fs, "mkdir").mockRejectedValueOnce(new Error("mkdir denied"));

    const res = await startPost(jsonRequest({ provider: "openai" }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toContain("mkdir denied");
  });

  it("returns fallback error string when a non-Error is thrown", async () => {
    vi.spyOn(fs, "mkdir").mockRejectedValueOnce("mkdir denied");

    const res = await startPost(jsonRequest({ provider: "openai" }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to start OAuth");
  });
});

describe("OAuth exchange route", () => {
  it("returns 400 for invalid JSON input", async () => {
    const badJsonRequest = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    const res = await exchangePost(badJsonRequest);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid JSON");
  });

  it("returns 400 when there is no pending OAuth state", async () => {
    const res = await exchangePost(jsonRequest({ code: "code-123" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("No pending OAuth session");
  });

  it("returns 400 when no code is provided", async () => {
    const res = await exchangePost(jsonRequest({}));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("Authorization code is required");
  });

  it("rejects expired OAuth sessions and removes stale state", async () => {
    await writeState({
      provider: "openai",
      createdAt: Date.now() - 11 * 60 * 1000,
    });

    const res = await exchangePost(jsonRequest({ code: "code-123" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("OAuth session expired");
    await expect(fs.readFile(STATE_PATH, "utf-8")).rejects.toBeTruthy();
  });

  it("handles unlink failure when expiring stale OAuth state", async () => {
    await writeState({
      provider: "openai",
      createdAt: Date.now() - 11 * 60 * 1000,
    });
    vi.spyOn(fs, "unlink").mockRejectedValueOnce(new Error("unlink denied"));

    const res = await exchangePost(jsonRequest({ code: "code-123" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("OAuth session expired");
  });

  it("rejects unsupported providers stored in state", async () => {
    await writeState({ provider: "not-supported" });

    const res = await exchangePost(jsonRequest({ code: "code-123" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("OAuth not supported");
    await expect(fs.readFile(STATE_PATH, "utf-8")).rejects.toBeTruthy();
  });

  it("handles unlink failure when rejecting unsupported providers", async () => {
    await writeState({ provider: "not-supported" });
    vi.spyOn(fs, "unlink").mockRejectedValueOnce(new Error("unlink denied"));

    const res = await exchangePost(jsonRequest({ code: "code-123" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("OAuth not supported");
  });

  it("rejects anthropic state mismatch and clears pending session", async () => {
    await writeState({
      provider: "anthropic",
      state: "expected-state",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await exchangePost(jsonRequest({ code: "code-123#wrong-state" }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toContain("OAuth state mismatch");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(fs.readFile(STATE_PATH, "utf-8")).rejects.toBeTruthy();
  });

  it("handles unlink failure on anthropic state mismatch cleanup", async () => {
    await writeState({
      provider: "anthropic",
      state: "expected-state",
    });
    vi.spyOn(fs, "unlink").mockRejectedValueOnce(new Error("unlink denied"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await exchangePost(jsonRequest({ code: "code-123#wrong-state" }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toContain("OAuth state mismatch");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("completes anthropic exchange with JSON body and matching state", async () => {
    await writeState({
      provider: "anthropic",
      state: "expected-state",
      codeVerifier: "anthropic-verifier",
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "anthropic_access",
          refresh_token: "anthropic_refresh",
          expires_in: 1800,
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await exchangePost(
      jsonRequest({ code: "anthropic-code#expected-state" })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      access_token: "anthropic_access",
      refresh_token: "anthropic_refresh",
      expires_in: 1800,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const firstCall = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(firstCall[0]).toBe("https://console.anthropic.com/v1/oauth/token");
    expect((firstCall[1].headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json"
    );
    expect(String(firstCall[1].body)).toContain("\"state\":\"expected-state\"");
    await expect(fs.readFile(STATE_PATH, "utf-8")).rejects.toBeTruthy();
  });

  it("defaults missing provider in state to anthropic", async () => {
    await fs.writeFile(
      STATE_PATH,
      JSON.stringify({
        codeVerifier: "anthropic-verifier",
        state: "expected-state",
        createdAt: Date.now(),
      }),
      "utf-8"
    );

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "anthropic_access",
          refresh_token: "anthropic_refresh",
          expires_in: 1800,
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await exchangePost(
      jsonRequest({ code: "anthropic-code#expected-state" })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.access_token).toBe("anthropic_access");
    const firstCall = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(firstCall[0]).toBe("https://console.anthropic.com/v1/oauth/token");
  });

  it("continues when non-openai state cleanup unlink fails", async () => {
    await writeState({
      provider: "anthropic",
      state: "expected-state",
      codeVerifier: "anthropic-verifier",
    });
    vi.spyOn(fs, "unlink").mockRejectedValueOnce(new Error("unlink denied"));

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "anthropic_access",
          refresh_token: "anthropic_refresh",
          expires_in: 1800,
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await exchangePost(
      jsonRequest({ code: "anthropic-code#expected-state" })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.access_token).toBe("anthropic_access");
  });

  it("returns 504 when token exchange times out", async () => {
    await writeState({ provider: "openai" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new DOMException("aborted", "AbortError"))
    );

    const res = await exchangePost(jsonRequest({ code: "code-123" }));
    const body = await res.json();

    expect(res.status).toBe(504);
    expect(body.error).toBe("Token exchange timed out");
  });

  it("fires internal token-timeout abort callback", async () => {
    await writeState({ provider: "openai" });
    vi
      .spyOn(global, "setTimeout")
      .mockImplementation(((callback: (...args: unknown[]) => unknown) => {
        callback();
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);
    vi
      .spyOn(global, "clearTimeout")
      .mockImplementation((() => undefined) as typeof clearTimeout);

    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      if ((init.signal as AbortSignal).aborted) {
        return Promise.reject(new DOMException("aborted", "AbortError"));
      }
      return Promise.reject(new Error("Expected aborted signal"));
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await exchangePost(jsonRequest({ code: "code-123" }));
    const body = await res.json();

    expect(res.status).toBe(504);
    expect(body.error).toBe("Token exchange timed out");
  });

  it("returns 500 when token exchange throws a non-timeout error", async () => {
    await writeState({ provider: "openai" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("network down")));

    const res = await exchangePost(jsonRequest({ code: "code-123" }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("network down");
  });

  it("returns fallback error when token exchange throws non-Error", async () => {
    await writeState({ provider: "openai" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce("network down"));

    const res = await exchangePost(jsonRequest({ code: "code-123" }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to exchange token");
  });

  it("completes OpenAI two-step exchange and prefers API key token", async () => {
    await writeState({ provider: "openai" });
    await fs.writeFile(
      ORG_PATH,
      JSON.stringify({ organizationId: "org_cleanup_me" }),
      "utf-8"
    );

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "oauth_access_token",
            refresh_token: "oauth_refresh_token",
            expires_in: 3600,
            id_token: "id-token-123",
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "openai_api_key_token",
            expires_in: 7200,
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await exchangePost(jsonRequest({ code: "code-123" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      access_token: "openai_api_key_token",
      refresh_token: "oauth_refresh_token",
      expires_in: 7200,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstCall = fetchMock.mock.calls[0] as [string, RequestInit];
    const firstBody = String(firstCall[1].body);
    expect(firstCall[0]).toBe("https://auth.openai.com/oauth/token");
    expect(firstCall[1].method).toBe("POST");
    expect(firstBody).toContain("grant_type=authorization_code");
    expect(firstBody).toContain("code=code-123");
    expect(firstBody).toContain(
      "redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback"
    );

    await expect(fs.readFile(STATE_PATH, "utf-8")).rejects.toBeTruthy();
    await expect(fs.readFile(ORG_PATH, "utf-8")).rejects.toBeTruthy();
  });

  it("falls back to access_token when OpenAI API-key exchange fails", async () => {
    await writeState({ provider: "openai" });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "oauth_access_token",
            refresh_token: "oauth_refresh_token",
            expires_in: 3600,
            id_token: "id-token-123",
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "bad exchange" }), { status: 400 })
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await exchangePost(jsonRequest({ code: "code-123" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      access_token: "oauth_access_token",
      refresh_token: "oauth_refresh_token",
      expires_in: 3600,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to oauth access token when second-step JSON is invalid", async () => {
    await writeState({ provider: "openai" });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "oauth_access_token",
            refresh_token: "oauth_refresh_token",
            expires_in: 3600,
            id_token: "id-token-123",
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response("not-json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await exchangePost(jsonRequest({ code: "code-123" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      access_token: "oauth_access_token",
      refresh_token: "oauth_refresh_token",
      expires_in: 3600,
    });
  });

  it("falls back to oauth access token when second-step request throws", async () => {
    await writeState({ provider: "openai" });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "oauth_access_token",
            refresh_token: "oauth_refresh_token",
            expires_in: 3600,
            id_token: "id-token-123",
          }),
          { status: 200 }
        )
      )
      .mockRejectedValueOnce(new Error("second step failed"));
    vi.stubGlobal("fetch", fetchMock);

    const res = await exchangePost(jsonRequest({ code: "code-123" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      access_token: "oauth_access_token",
      refresh_token: "oauth_refresh_token",
      expires_in: 3600,
    });
  });

  it("uses api_key when second-step response has no access_token", async () => {
    await writeState({ provider: "openai" });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "oauth_access_token",
            refresh_token: "oauth_refresh_token",
            expires_in: 3600,
            id_token: "id-token-123",
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            api_key: "openai_generated_api_key",
            expires_in: 7200,
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await exchangePost(jsonRequest({ code: "code-123" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      access_token: "openai_generated_api_key",
      refresh_token: "oauth_refresh_token",
      expires_in: 7200,
    });
  });

  it("returns parsed upstream error details when token exchange fails", async () => {
    await writeState({ provider: "openai" });

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error_description: "invalid_grant" }),
        { status: 401 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await exchangePost(jsonRequest({ code: "code-123" }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe("invalid_grant");
    // Failed exchange should keep state so user can retry quickly.
    const raw = await fs.readFile(STATE_PATH, "utf-8");
    expect(raw).toContain("\"provider\":\"openai\"");
  });

  it("parses nested upstream error.message values", async () => {
    await writeState({ provider: "openai" });

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: "nested-error-message" } }),
        { status: 400 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await exchangePost(jsonRequest({ code: "code-123" }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe("nested-error-message");
  });

  it("parses string upstream error values", async () => {
    await writeState({ provider: "openai" });

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "string-error" }), { status: 400 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await exchangePost(jsonRequest({ code: "code-123" }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe("string-error");
  });

  it("parses top-level upstream message values", async () => {
    await writeState({ provider: "openai" });

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "top-level-message" }), {
        status: 400,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await exchangePost(jsonRequest({ code: "code-123" }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe("top-level-message");
  });

  it("uses default token-exchange message for empty JSON errors", async () => {
    await writeState({ provider: "openai" });

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 499 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await exchangePost(jsonRequest({ code: "code-123" }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe("Token exchange failed (499)");
  });

  it("returns default upstream error when body cannot be read", async () => {
    await writeState({ provider: "openai" });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 418,
      text: () => Promise.reject(new Error("cannot read")),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await exchangePost(jsonRequest({ code: "code-123" }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe("Token exchange failed (418)");
  });

  it("returns plain-text upstream error when token endpoint does not return JSON", async () => {
    await writeState({ provider: "openai" });

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response("gateway unavailable", { status: 503 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await exchangePost(jsonRequest({ code: "code-123" }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe("gateway unavailable");
  });

  it("handles unreadable api-key failure body and still falls back to oauth token", async () => {
    await writeState({ provider: "openai" });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "oauth_access_token",
            refresh_token: "oauth_refresh_token",
            expires_in: 3600,
            id_token: "id-token-123",
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.reject(new Error("cannot read")),
      });
    vi.stubGlobal("fetch", fetchMock);

    const res = await exchangePost(jsonRequest({ code: "code-123" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.access_token).toBe("oauth_access_token");
  });

  it("continues when post-success state cleanup unlink fails", async () => {
    await writeState({ provider: "openai" });
    vi.spyOn(fs, "unlink").mockRejectedValue(new Error("unlink denied"));

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "oauth_access_token",
            refresh_token: "oauth_refresh_token",
            expires_in: 3600,
            id_token: "id-token-123",
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "openai_api_key_token",
            expires_in: 7200,
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await exchangePost(jsonRequest({ code: "code-123" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.access_token).toBe("openai_api_key_token");
  });
});

describe("OAuth route module defaults", () => {
  it("evaluates with default CLAWBOX_ROOT when env var is absent", async () => {
    const previousRoot = process.env.CLAWBOX_ROOT;
    delete process.env.CLAWBOX_ROOT;

    vi.resetModules();
    const startModule = await import("@/app/setup-api/ai-models/oauth/start/route");
    const exchangeModule = await import("@/app/setup-api/ai-models/oauth/exchange/route");

    expect(startModule.dynamic).toBe("force-dynamic");
    expect(exchangeModule.dynamic).toBe("force-dynamic");

    process.env.CLAWBOX_ROOT = previousRoot;
    vi.resetModules();
    ({ POST: startPost } = await import("@/app/setup-api/ai-models/oauth/start/route"));
    ({ POST: exchangePost } = await import("@/app/setup-api/ai-models/oauth/exchange/route"));
  });
});
