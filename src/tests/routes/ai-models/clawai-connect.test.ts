import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/openclaw-gateway-ws", () => ({
  waitForGatewayRpcReady: vi.fn().mockResolvedValue(true),
  gatewayWsCall: vi.fn(),
  gatewayWsPatchConfig: vi.fn(),
  GatewayWsUnavailableError: class GatewayWsUnavailableError extends Error {},
  GatewayRpcError: class GatewayRpcError extends Error {},
}));

vi.mock("@/lib/clawai-connect", () => ({
  createClawAiUserCode: vi.fn(() => "ABCD-1234"),
  createClawAiDeviceId: vi.fn(() => "device-id-xyz"),
  CLAWAI_USER_CODE_LENGTH: 8,
  CLAWAI_CONFIGURING_TIMEOUT_MS: 3 * 60 * 1000,
  writeClawAiSession: vi.fn(),
  readClawAiSession: vi.fn(),
  clearClawAiSession: vi.fn(),
  isClawAiSessionExpired: vi.fn(() => false),
}));

vi.mock("@/app/setup-api/ai-models/configure/route", () => ({
  POST: vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })),
}));
// The finaliser is the box's provider sign-in task (TASK-2148), which reads the
// row back before it ends.
vi.mock("@/lib/provider-status", () => ({
  readProviderStatus: vi.fn(async () => ({ harness: "openclaw", providers: [], defaultProvider: null, unrunnable: [], degraded: false })),
}));

import {
  readClawAiSession,
  writeClawAiSession,
  isClawAiSessionExpired,
} from "@/lib/clawai-connect";
import { POST as configurePost } from "@/app/setup-api/ai-models/configure/route";
import { getBackgroundTask, resetBackgroundTasksForTests } from "@/lib/background-tasks";

const mockReadClawAiSession = vi.mocked(readClawAiSession);
const mockWriteClawAiSession = vi.mocked(writeClawAiSession);
const mockIsClawAiSessionExpired = vi.mocked(isClawAiSessionExpired);
const mockConfigurePost = vi.mocked(configurePost);

describe("ClawBox AI device-auth routes", () => {
  beforeEach(() => {
    resetBackgroundTasksForTests();
    vi.resetModules();
    vi.clearAllMocks();
    // A session a case left standing for every read is not the next case's.
    mockReadClawAiSession.mockReset();
    mockIsClawAiSessionExpired.mockReturnValue(false);
  });

  it("issues a user_code via the upstream device-start endpoint", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url === "https://clawbox.com/api/clawbox-ai/device-start") {
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
    expect(body.verification_url).toContain("https://clawbox.com/portal/connect");
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

  it("gives no new code while a ClawBox AI sign-in is finishing on the box, and names that one (TASK-2148)", async () => {
    const { startBackgroundTask } = await import("@/lib/background-tasks");
    let release!: () => void;
    const running = startBackgroundTask({
      kind: "provider-sign-in",
      group: "provider-auth",
      title: "Connecting ClawBox AI",
      meta: { subject: "clawai", action: "sign-in", label: "ClawBox AI" },
      run: () => new Promise((resolve) => { release = () => resolve({}); }),
    });
    if (!running.started) throw new Error("not started");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("@/app/setup-api/ai-models/clawai/start/route");
    const response = await mod.POST(new NextRequest("http://clawbox.local/setup-api/ai-models/clawai/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "primary" }),
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "provider_change_running", taskId: running.task.id });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockWriteClawAiSession).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    vi.unstubAllGlobals();
  });

  it("gives no new code while ClawBox AI is being signed out either — the sign-out would drop it", async () => {
    const { startBackgroundTask } = await import("@/lib/background-tasks");
    let release!: () => void;
    const running = startBackgroundTask({
      kind: "provider-sign-out",
      group: "provider-auth",
      title: "Signing out of ClawBox AI",
      meta: { subject: "clawai", action: "sign-out", label: "ClawBox AI" },
      run: () => new Promise((resolve) => { release = () => resolve({}); }),
    });
    if (!running.started) throw new Error("not started");
    vi.stubGlobal("fetch", vi.fn());

    const mod = await import("@/app/setup-api/ai-models/clawai/start/route");
    const response = await mod.POST(new NextRequest("http://clawbox.local/setup-api/ai-models/clawai/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "primary" }),
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "provider_change_running", error: expect.stringContaining("ClawBox AI is being signed out") });
    expect(mockWriteClawAiSession).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
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
      if (url === "https://clawbox.com/api/clawbox-ai/device-poll") {
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

  it("signs nothing in when the session was ended while the portal answered — a sign-out cleared it", async () => {
    mockReadClawAiSession
      .mockResolvedValueOnce({
        device_id: "device-id-xyz",
        user_code: "ABCD-1234",
        interval: 5,
        createdAt: Date.now(),
        status: "pending",
        provider: "clawai",
        scope: "primary",
        tier: "pro",
        error: null,
      })
      .mockResolvedValueOnce(null);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "complete", access_token: "portal-token-123" }), { status: 200 })));

    const mod = await import("@/app/setup-api/ai-models/clawai/poll/route");
    const response = await mod.POST();
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ status: "error", error: expect.stringMatching(/cancelled/) });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(mockConfigurePost).not.toHaveBeenCalled();
    expect(mockWriteClawAiSession).not.toHaveBeenCalled();
  });

  it("acknowledges the poll with `configuring` and runs configure off the request lifecycle", async () => {
    // The session stays on disk while the poll asks the portal: it reads it
    // again before it acts on the token.
    mockReadClawAiSession.mockResolvedValue({
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
      if (url === "https://clawbox.com/api/clawbox-ai/device-poll") {
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
    // The box's sign-in task (TASK-2148), named so the card can follow it.
    expect(body).toEqual({ status: "configuring", taskId: expect.any(String) });
    // The configure runs off the request lifecycle, as that task: wait for it
    // to end before the assertions below.
    await vi.waitFor(() => expect(getBackgroundTask(body.taskId)?.state).toBe("succeeded"));

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
    // we acknowledge the poll), names its task from inside it, and then
    // `complete` once the background configure resolves.
    const writes = mockWriteClawAiSession.mock.calls.map(([arg]) => [arg.status, arg.taskId ?? null]);
    expect(writes).toEqual([["configuring", null], ["configuring", body.taskId], ["complete", null]]);
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
