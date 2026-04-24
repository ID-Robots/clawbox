import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/clawai-connect", () => ({
  createClawAiState: vi.fn(() => "state-123"),
  writeClawAiSession: vi.fn(),
  readClawAiSession: vi.fn(),
  clearClawAiSession: vi.fn(),
  isClawAiSessionExpired: vi.fn(() => false),
}));

vi.mock("@/app/setup-api/ai-models/configure/route", () => ({
  POST: vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })),
}));

import {
  readClawAiSession,
  writeClawAiSession,
  isClawAiSessionExpired,
} from "@/lib/clawai-connect";
import { POST as configurePost } from "@/app/setup-api/ai-models/configure/route";

const mockReadClawAiSession = vi.mocked(readClawAiSession);
const mockWriteClawAiSession = vi.mocked(writeClawAiSession);
const mockIsClawAiSessionExpired = vi.mocked(isClawAiSessionExpired);
const mockConfigurePost = vi.mocked(configurePost);

describe("ClawBox AI connect routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockIsClawAiSessionExpired.mockReturnValue(false);
  });

  it("starts a local ClawBox AI connect session", async () => {
    const mod = await import("@/app/setup-api/ai-models/clawai/start/route");
    const response = await mod.POST(new NextRequest("http://clawbox.local/setup-api/ai-models/clawai/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "primary", deviceName: "ClawBox Test" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.state).toBe("state-123");
    expect(body.url).toContain("https://openclawhardware.dev/portal/connect");
    expect(body.url).toContain("state=state-123");
    expect(body.url).toContain(encodeURIComponent("http://clawbox.local/setup-api/ai-models/clawai/callback"));
    expect(mockWriteClawAiSession).toHaveBeenCalledWith(expect.objectContaining({
      state: "state-123",
      status: "pending",
      scope: "primary",
      provider: "clawai",
      redirectUri: "http://clawbox.local/setup-api/ai-models/clawai/callback",
      deviceName: "ClawBox Test",
    }));
  });

  it("persists the DeepSeek V4 model selection on the connect session", async () => {
    const mod = await import("@/app/setup-api/ai-models/clawai/start/route");
    await mod.POST(new NextRequest("http://clawbox.local/setup-api/ai-models/clawai/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "primary", model: "deepseek/deepseek-v4-flash" }),
    }));

    expect(mockWriteClawAiSession).toHaveBeenCalledWith(expect.objectContaining({
      model: "deepseek/deepseek-v4-flash",
    }));
  });

  it("reports the current local connect status", async () => {
    mockReadClawAiSession.mockResolvedValueOnce({
      state: "state-123",
      createdAt: Date.now(),
      status: "pending",
      provider: "clawai",
      scope: "primary",
      error: null,
    });
    const mod = await import("@/app/setup-api/ai-models/clawai/status/route");
    const response = await mod.GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "pending", error: null });
  });

  it("exchanges the callback code and saves the ClawBox AI token", async () => {
    mockReadClawAiSession.mockResolvedValueOnce({
      state: "state-123",
      createdAt: Date.now(),
      status: "pending",
      provider: "clawai",
      scope: "primary",
      redirectUri: "http://clawbox.local/setup-api/ai-models/clawai/callback",
      deviceName: "ClawBox Test",
      error: null,
    });
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://openclawhardware.dev/api/clawbox-ai/exchange") {
        return new Response(JSON.stringify({ access_token: "portal-token-123" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("@/app/setup-api/ai-models/clawai/callback/route");
    const response = await mod.GET(new NextRequest("http://clawbox.local/setup-api/ai-models/clawai/callback?code=abc123&state=state-123"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("ClawBox AI connected");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openclawhardware.dev/api/clawbox-ai/exchange",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          code: "abc123",
          state: "state-123",
          redirect_uri: "http://clawbox.local/setup-api/ai-models/clawai/callback",
          device_name: "ClawBox Test",
        }),
      }),
    );
    expect(mockConfigurePost).toHaveBeenCalledTimes(1);
    const configureRequest = mockConfigurePost.mock.calls[0][0];
    expect(await configureRequest.json()).toEqual({
      scope: "primary",
      provider: "clawai",
      apiKey: "portal-token-123",
    });
    expect(mockWriteClawAiSession).toHaveBeenLastCalledWith(expect.objectContaining({
      status: "complete",
      error: null,
    }));
    vi.unstubAllGlobals();
  });

  it("forwards the persisted DeepSeek V4 model to the configure route", async () => {
    mockReadClawAiSession.mockResolvedValueOnce({
      state: "state-123",
      createdAt: Date.now(),
      status: "pending",
      provider: "clawai",
      scope: "primary",
      redirectUri: "http://clawbox.local/setup-api/ai-models/clawai/callback",
      deviceName: "ClawBox Test",
      model: "deepseek/deepseek-v4-flash",
      error: null,
    });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "portal-token-123" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("@/app/setup-api/ai-models/clawai/callback/route");
    await mod.GET(new NextRequest("http://clawbox.local/setup-api/ai-models/clawai/callback?code=abc123&state=state-123"));

    expect(mockConfigurePost).toHaveBeenCalledTimes(1);
    const configureRequest = mockConfigurePost.mock.calls[0][0];
    expect(await configureRequest.json()).toEqual({
      scope: "primary",
      provider: "clawai",
      apiKey: "portal-token-123",
      model: "deepseek/deepseek-v4-flash",
    });
    vi.unstubAllGlobals();
  });
});
