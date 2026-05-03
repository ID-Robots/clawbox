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

  it("acknowledges the poll with `configuring` and runs configure off the request lifecycle", async () => {
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
    // Make configure resolve immediately so the background task settles
    // within the test's await window — production goes through the real
    // configure pipeline which is what makes the request take ~50 s and
    // is exactly why we now run it off the poll's request lifecycle.
    mockConfigurePost.mockResolvedValueOnce(new Response(null, { status: 200 }) as unknown as Awaited<ReturnType<typeof mockConfigurePost>>);

    const mod = await import("@/app/setup-api/ai-models/clawai/poll/route");
    const response = await mod.POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "configuring" });
    // Background configure runs as a fire-and-forget; flush microtasks so
    // the test sees its writes before the assertions below.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(mockConfigurePost).toHaveBeenCalledTimes(1);
    const configureRequest = mockConfigurePost.mock.calls[0][0];
    expect(await configureRequest.json()).toEqual({
      scope: "primary",
      provider: "clawai",
      apiKey: "portal-token-123",
      authMode: "subscription",
      clawaiTier: "pro",
    });
    // The session goes through `configuring` first (synchronously, before
    // we acknowledge the poll) and then `complete` once the background
    // configure resolves.
    const writes = mockWriteClawAiSession.mock.calls.map(([arg]) => arg.status);
    expect(writes).toEqual(["configuring", "complete"]);
    expect(mockWriteClawAiSession).toHaveBeenLastCalledWith(expect.objectContaining({
      status: "complete",
      error: null,
    }));
    vi.unstubAllGlobals();
  });

  // Each entry: HTTP status + portal error code + the substring the
  // device's user-facing error message should contain. Locks the
  // TERMINAL_PORTAL_ERRORS table contract so adding a new gate or
  // editing the user-facing copy is a deliberate change with test
  // updates, not a silent behavioural drift.
  for (const { httpStatus, code, expectMessageContains } of [
    { httpStatus: 402, code: "paid_plan_required", expectMessageContains: "paid subscription" },
    { httpStatus: 403, code: "email_not_verified", expectMessageContains: "verify your email" },
  ]) {
    it(`writes terminal session error and returns ${httpStatus} when upstream poll says ${code}`, async () => {
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
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ error: code }), { status: httpStatus }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const mod = await import("@/app/setup-api/ai-models/clawai/poll/route");
      const response = await mod.POST();
      const body = await response.json();

      expect(response.status).toBe(httpStatus);
      expect(body.status).toBe("error");
      expect(typeof body.error).toBe("string");
      expect(body.error.toLowerCase()).toContain(expectMessageContains);
      expect(mockWriteClawAiSession).toHaveBeenCalledTimes(1);
      expect(mockWriteClawAiSession).toHaveBeenCalledWith(expect.objectContaining({
        status: "error",
        error: body.error,
      }));
      expect(mockConfigurePost).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  }
});
