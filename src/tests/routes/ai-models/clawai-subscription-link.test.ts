/**
 * TASK-2501: the device-code handoff in its `entitlement` scope links the
 * owner's subscription for its PLAN alone.
 *
 * The finaliser for a chat sign-in hands the token to the configure route (or
 * to Hermes) and restarts the gateway; that is what made ClawBox AI the box's
 * chat model. Here the same handoff must record the link and touch none of
 * that — on either edition.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/clawai-connect", () => {
  const writeClawAiSession = vi.fn();
  const readClawAiSession = vi.fn();
  return {
    createClawAiUserCode: vi.fn(() => "ABCD-1234"),
    createClawAiDeviceId: vi.fn(() => "device-id-xyz"),
    CLAWAI_USER_CODE_LENGTH: 8,
    CLAWAI_CONFIGURING_TIMEOUT_MS: 3 * 60 * 1000,
    writeClawAiSession,
    readClawAiSession,
    // The real one's contract over the two mocks: write only while the stored
    // session is still the owner's.
    writeClawAiSessionIfCurrent: vi.fn(async (owner: { device_id: string; createdAt: number }, next: unknown) => {
      const current = (await readClawAiSession()) as { device_id: string; createdAt: number } | null | undefined;
      if (!current || current.device_id !== owner.device_id || current.createdAt !== owner.createdAt) return false;
      await writeClawAiSession(next);
      return true;
    }),
    clearClawAiSession: vi.fn(),
    isClawAiSessionExpired: vi.fn(() => false),
  };
});
vi.mock("@/app/setup-api/ai-models/configure/route", () => ({
  POST: vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })),
}));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "openclaw") }));
vi.mock("@/lib/hermes-clawai", () => ({
  applyClawaiToHermes: vi.fn(async () => ({})),
  ClawaiApplyError: class ClawaiApplyError extends Error {},
}));
// The chat sign-in this suite contrasts with runs as the box's provider
// sign-in task (TASK-2148): it waits out a gateway restart and reads the row back.
vi.mock("@/lib/gateway-hot-apply", () => ({ waitForGatewayBack: vi.fn(async () => true) }));
vi.mock("@/lib/provider-status", () => ({
  readProviderStatus: vi.fn(async () => ({ harness: "openclaw", providers: [], defaultProvider: null, unrunnable: [], degraded: false })),
}));
vi.mock("@/lib/portal-heartbeat", () => ({ revokeNamedTunnelWithoutAccount: vi.fn(async () => true) }));
vi.mock("@/lib/subscription-link", () => ({
  linkSubscription: vi.fn(),
  refreshSubscriptionLink: vi.fn(),
  unlinkSubscription: vi.fn(),
}));

import {
  readClawAiSession,
  writeClawAiSession,
  type ClawAiConnectSession,
} from "@/lib/clawai-connect";
import { POST as configurePost } from "@/app/setup-api/ai-models/configure/route";
import { getActiveHarness } from "@/lib/harness";
import { applyClawaiToHermes } from "@/lib/hermes-clawai";
import { linkSubscription, refreshSubscriptionLink, unlinkSubscription } from "@/lib/subscription-link";
import { resetBackgroundTasksForTests } from "@/lib/background-tasks";

const mockReadSession = vi.mocked(readClawAiSession);
const mockWriteSession = vi.mocked(writeClawAiSession);
const mockConfigure = vi.mocked(configurePost);
const mockHarness = vi.mocked(getActiveHarness);
const mockApplyHermes = vi.mocked(applyClawaiToHermes);
const mockLink = vi.mocked(linkSubscription);
const mockRefresh = vi.mocked(refreshSubscriptionLink);
const mockUnlink = vi.mocked(unlinkSubscription);

const TOKEN = "claw_0123456789abcdef0123456789abcdef";

function pendingSession(scope: ClawAiConnectSession["scope"]): ClawAiConnectSession {
  return {
    device_id: "device-id-xyz",
    user_code: "ABCD-1234",
    interval: 5,
    createdAt: Date.now(),
    status: "pending",
    provider: "clawai",
    scope,
    tier: "free",
  };
}

/** The portal has issued the token: every read of the session sees the pending one. */
function portalIssuesToken(scope: ClawAiConnectSession["scope"]) {
  mockReadSession.mockResolvedValue(pendingSession(scope));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    JSON.stringify({ status: "complete", access_token: TOKEN }),
    { status: 200 },
  )));
}

/** The session states the poll wrote, in order. */
function writtenStatuses(): string[] {
  return mockWriteSession.mock.calls.map(([session]) => session.status);
}

beforeEach(() => {
  resetBackgroundTasksForTests();
  vi.resetModules();
  vi.clearAllMocks();
  mockReadSession.mockReset();
  mockHarness.mockResolvedValue("openclaw");
  vi.unstubAllGlobals();
});

describe("/clawai/start in the entitlement scope", () => {
  it("records the scope and asks the portal for no paid model tier, whatever was sent", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      user_code: "PORT-1A2B",
      device_id: "upstream-device-id",
      interval: 4,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("@/app/setup-api/ai-models/clawai/start/route");
    const res = await POST(new NextRequest("http://clawbox.local/setup-api/ai-models/clawai/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "entitlement", tier: "pro", deviceName: "Workstation" }),
    }));

    expect(res.status).toBe(200);
    expect((await res.json()).user_code).toBe("PORT-1A2B");
    const upstream = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    // A paid tier here is what makes the portal 402 a Free account.
    expect(upstream).toEqual({ device_name: "Workstation", tier: "free" });
    expect(mockWriteSession).toHaveBeenCalledWith(expect.objectContaining({
      scope: "entitlement",
      tier: "free",
      status: "pending",
    }));
  });

  it("still refuses a scope it does not know", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { POST } = await import("@/app/setup-api/ai-models/clawai/start/route");
    const res = await POST(new NextRequest("http://clawbox.local/setup-api/ai-models/clawai/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "everything" }),
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("'entitlement'");
    expect(mockWriteSession).not.toHaveBeenCalled();
  });

  it("leaves the chat scopes' tier as it was", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const { POST } = await import("@/app/setup-api/ai-models/clawai/start/route");
    await POST(new NextRequest("http://clawbox.local/setup-api/ai-models/clawai/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "primary", tier: "pro" }),
    }));
    expect(mockWriteSession).toHaveBeenCalledWith(expect.objectContaining({ scope: "primary", tier: "pro" }));
  });
});

describe("/clawai/poll finishing an entitlement link", () => {
  for (const harness of ["openclaw", "hermes"] as const) {
    it(`on ${harness}: links the subscription and configures no chat model`, async () => {
      mockHarness.mockResolvedValue(harness);
      mockLink.mockResolvedValue({ ok: true, plan: "pro" });
      portalIssuesToken("entitlement");

      const { POST } = await import("@/app/setup-api/ai-models/clawai/poll/route");
      const res = await POST();

      expect(await res.json()).toEqual({ status: "complete" });
      expect(mockLink).toHaveBeenCalledWith(TOKEN);
      // The whole difference from a ClawBox AI sign-in:
      expect(mockConfigure).not.toHaveBeenCalled();
      expect(mockApplyHermes).not.toHaveBeenCalled();
      expect(writtenStatuses()).toEqual(["configuring", "complete"]);
    });
  }

  it("ends the session in the link's own error when it fails, and still configures nothing", async () => {
    mockLink.mockResolvedValue({
      ok: false,
      code: "token_rejected",
      message: "The ClawBox portal refused the credential it just issued. Request a new code and try again.",
    });
    portalIssuesToken("entitlement");

    const { POST } = await import("@/app/setup-api/ai-models/clawai/poll/route");
    const res = await POST();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      status: "error",
      error: "The ClawBox portal refused the credential it just issued. Request a new code and try again.",
    });
    expect(mockConfigure).not.toHaveBeenCalled();
    expect(mockWriteSession.mock.calls.at(-1)?.[0]).toMatchObject({ status: "error" });
  });

  it("answers a later poll from the finished session without asking the portal again", async () => {
    mockReadSession.mockResolvedValue({ ...pendingSession("entitlement"), status: "complete" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("@/app/setup-api/ai-models/clawai/poll/route");
    expect(await (await POST()).json()).toEqual({ status: "complete" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockLink).not.toHaveBeenCalled();
  });

  it("never writes its ending over a newer sign-in started while the portal answered the link", async () => {
    const mine = pendingSession("entitlement");
    const newer: ClawAiConnectSession = { ...pendingSession("primary"), device_id: "a-newer-device-code", createdAt: mine.createdAt + 1 };
    let stored: ClawAiConnectSession = mine;
    mockReadSession.mockImplementation(async () => stored);
    mockWriteSession.mockImplementation(async (s: ClawAiConnectSession) => { stored = s; });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "complete", access_token: TOKEN }), { status: 200 })));
    mockLink.mockImplementation(async () => {
      stored = newer; // a /clawai/start lands while the portal answers
      return { ok: true, plan: "pro" };
    });
    const { POST } = await import("@/app/setup-api/ai-models/clawai/poll/route");
    expect(await (await POST()).json()).toEqual({ status: "complete" });
    expect(stored).toBe(newer);
    expect(mockLink).toHaveBeenCalledWith(TOKEN);
  });

  it("nor its error", async () => {
    const mine = pendingSession("entitlement");
    const newer: ClawAiConnectSession = { ...pendingSession("primary"), device_id: "a-newer-device-code", createdAt: mine.createdAt + 1 };
    let stored: ClawAiConnectSession = mine;
    mockReadSession.mockImplementation(async () => stored);
    mockWriteSession.mockImplementation(async (s: ClawAiConnectSession) => { stored = s; });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "complete", access_token: TOKEN }), { status: 200 })));
    mockLink.mockImplementation(async () => {
      stored = newer;
      return { ok: false, code: "token_rejected", message: "refused" };
    });
    const { POST } = await import("@/app/setup-api/ai-models/clawai/poll/route");
    expect((await POST()).status).toBe(409);
    expect(stored).toBe(newer);
  });

  it("links nothing when the session was cancelled while the portal answered", async () => {
    mockReadSession
      .mockResolvedValueOnce(pendingSession("entitlement"))
      .mockResolvedValueOnce(null);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ status: "complete", access_token: TOKEN }),
      { status: 200 },
    )));
    const { POST } = await import("@/app/setup-api/ai-models/clawai/poll/route");
    const res = await POST();
    expect(res.status).toBe(410);
    expect(mockLink).not.toHaveBeenCalled();
  });

  it("a chat-scope session still goes to the configure route, not to the link", async () => {
    portalIssuesToken("primary");
    const { POST } = await import("@/app/setup-api/ai-models/clawai/poll/route");
    const res = await POST();
    expect((await res.json()).status).toBe("configuring");
    await vi.waitFor(() => expect(mockConfigure).toHaveBeenCalled());
    expect(mockLink).not.toHaveBeenCalled();
  });
});

describe("/setup-api/ai-models/subscription-link", () => {
  it("GET says whether a subscription is linked and its plan, never the token", async () => {
    mockRefresh.mockResolvedValue({ plan: "flash", rejected: false, changed: false });
    const { GET } = await import("@/app/setup-api/ai-models/subscription-link/route");
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ linked: true, plan: "flash", rejected: false });
    expect(JSON.stringify(body)).not.toContain("claw_");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("GET answers not linked on a box with none", async () => {
    mockRefresh.mockResolvedValue(null);
    const { GET } = await import("@/app/setup-api/ai-models/subscription-link/route");
    expect(await (await GET()).json()).toEqual({ linked: false, plan: null, rejected: false });
  });

  it("DELETE removes the link, then the named tunnel no account is left to own", async () => {
    mockUnlink.mockResolvedValue(true);
    const { revokeNamedTunnelWithoutAccount } = await import("@/lib/portal-heartbeat");
    const { DELETE } = await import("@/app/setup-api/ai-models/subscription-link/route");
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linked: false, wasLinked: true, tunnelRevoked: true });
    expect(mockUnlink).toHaveBeenCalledTimes(1);
    // After the unlink, so the heartbeat module reads a store without the link.
    expect(vi.mocked(revokeNamedTunnelWithoutAccount)).toHaveBeenCalledTimes(1);
    expect(mockUnlink.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(revokeNamedTunnelWithoutAccount).mock.invocationCallOrder[0],
    );
  });

  it("DELETE says so when the store cannot be written", async () => {
    mockUnlink.mockRejectedValue(new Error("EACCES"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { DELETE } = await import("@/app/setup-api/ai-models/subscription-link/route");
    const res = await DELETE();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("could not remove");
    errorSpy.mockRestore();
  });
});
