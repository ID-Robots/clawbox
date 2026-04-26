import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/clawai-connect", () => ({
  createClawAiUserCode: vi.fn(() => "ABCD-1234"),
  createClawAiDeviceId: vi.fn(() => "device-id-xyz"),
  CLAWAI_USER_CODE_LENGTH: 8,
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

describe("ClawBox AI device-auth routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockIsClawAiSessionExpired.mockReturnValue(false);
  });

  it("issues a user_code via the upstream device-start endpoint", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url === "https://openclawhardware.dev/api/clawbox-ai/device-start") {
        return new Response(JSON.stringify({
          user_code: "PORT-1A2B",
          device_id: "upstream-device-id",
          interval: 4,
        }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("@/app/setup-api/ai-models/clawai/start/route");
    const response = await mod.POST(new NextRequest("http://clawbox.local/setup-api/ai-models/clawai/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "primary", deviceName: "ClawBox Test", tier: "pro" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.user_code).toBe("PORT-1A2B");
    expect(body.verification_url).toContain("https://openclawhardware.dev/portal/connect");
    expect(body.interval).toBe(4);
    expect(mockWriteClawAiSession).toHaveBeenCalledWith(expect.objectContaining({
      device_id: "upstream-device-id",
      user_code: "PORT-1A2B",
      status: "pending",
      scope: "primary",
      provider: "clawai",
      tier: "pro",
      deviceName: "ClawBox Test",
    }));
    vi.unstubAllGlobals();
  });

  it("falls back to a locally-generated code when upstream device-start is unreachable", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("@/app/setup-api/ai-models/clawai/start/route");
    const response = await mod.POST(new NextRequest("http://clawbox.local/setup-api/ai-models/clawai/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "primary" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.user_code).toBe("ABCD-1234");
    expect(mockWriteClawAiSession).toHaveBeenCalledWith(expect.objectContaining({
      user_code: "ABCD-1234",
      device_id: "device-id-xyz",
      status: "pending",
    }));
    vi.unstubAllGlobals();
  });

  it("returns pending while the upstream poll says the user has not entered the code", async () => {
    mockReadClawAiSession.mockResolvedValueOnce({
      device_id: "device-id-xyz",
      user_code: "ABCD-1234",
      interval: 5,
      createdAt: Date.now(),
      status: "pending",
      provider: "clawai",
      scope: "primary",
      tier: "flash",
      error: null,
    });
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url === "https://openclawhardware.dev/api/clawbox-ai/device-poll") {
        return new Response(JSON.stringify({ status: "pending" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("@/app/setup-api/ai-models/clawai/poll/route");
    const response = await mod.POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "pending" });
    expect(mockConfigurePost).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("forwards the issued token to the configure route on a complete poll", async () => {
    mockReadClawAiSession.mockResolvedValueOnce({
      device_id: "device-id-xyz",
      user_code: "ABCD-1234",
      interval: 5,
      createdAt: Date.now(),
      status: "pending",
      provider: "clawai",
      scope: "primary",
      tier: "pro",
      error: null,
    });
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url === "https://openclawhardware.dev/api/clawbox-ai/device-poll") {
        return new Response(JSON.stringify({
          status: "complete",
          access_token: "portal-token-123",
        }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("@/app/setup-api/ai-models/clawai/poll/route");
    const response = await mod.POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "complete" });
    expect(mockConfigurePost).toHaveBeenCalledTimes(1);
    const configureRequest = mockConfigurePost.mock.calls[0][0];
    expect(await configureRequest.json()).toEqual({
      scope: "primary",
      provider: "clawai",
      apiKey: "portal-token-123",
      authMode: "subscription",
      clawaiTier: "pro",
    });
    expect(mockWriteClawAiSession).toHaveBeenLastCalledWith(expect.objectContaining({
      status: "complete",
      error: null,
    }));
    vi.unstubAllGlobals();
  });
});
