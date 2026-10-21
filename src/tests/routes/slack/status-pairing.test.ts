import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * /setup-api/slack/status and /setup-api/slack/pairing.
 *
 * Status may only say "receiving" when the harness says the channel is up, and
 * must say `null` — not false — when nobody could be asked. Pairing approves on
 * the active harness and never leaks the harness' own error text.
 */

vi.mock("@/lib/config-store", () => ({ set: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/openclaw-config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/openclaw-config")>(
    "@/lib/openclaw-config",
  );
  return {
    GatewayNotReadyError: actual.GatewayNotReadyError,
    restartGateway: vi.fn(),
    approveChannelPairing: vi.fn(),
  };
});
vi.mock("@/lib/openclaw-channels", () => ({
  invalidateChannelStatus: vi.fn(),
  waitForChannelConnected: vi.fn(),
  readCachedChannelStatus: vi.fn(),
}));
vi.mock("@/lib/hermes-channels", () => ({
  ensureHermesGateway: vi.fn(),
  hermesGatewayStatus: vi.fn(),
  hermesPlatformRegistered: vi.fn(),
  readHermesGatewaySnapshot: vi.fn(),
  approveHermesChannelPairing: vi.fn(),
}));

import { get } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { approveChannelPairing } from "@/lib/openclaw-config";
import { readCachedChannelStatus, type ChannelStatus } from "@/lib/openclaw-channels";
import {
  approveHermesChannelPairing,
  hermesGatewayStatus,
  hermesPlatformRegistered,
  readHermesGatewaySnapshot,
} from "@/lib/hermes-channels";

const mockGet = vi.mocked(get);
const mockHarness = vi.mocked(getActiveHarness);
const mockRow = vi.mocked(readCachedChannelStatus);
const mockApprove = vi.mocked(approveChannelPairing);
const mockHermesApprove = vi.mocked(approveHermesChannelPairing);
const mockGateway = vi.mocked(hermesGatewayStatus);
const mockRegistered = vi.mocked(hermesPlatformRegistered);
const mockSnapshot = vi.mocked(readHermesGatewaySnapshot);

const BOT = ["xoxb", "000000000000", "000000000000", "clawboxtestnotreal"].join("-");
const AUTH_OK = { ok: true, team: "Acme", team_id: "T0001", user: "clawbox", user_id: "U0001", bot_id: "B0001" };

function row(over: Partial<ChannelStatus>): ChannelStatus {
  return {
    configured: true,
    running: true,
    connected: true,
    tokenStatus: "available",
    restartPending: false,
    lastError: null,
    ...over,
  } as ChannelStatus;
}

let fetchMock: ReturnType<typeof vi.fn>;

async function status() {
  const { GET } = await import("@/app/setup-api/slack/status/route");
  const res = await GET();
  return { status: res.status, json: await res.json() };
}

async function approve(body: unknown) {
  const { POST } = await import("@/app/setup-api/slack/pairing/route");
  const res = await POST(
    new Request("http://localhost/setup-api/slack/pairing", { method: "POST", body: JSON.stringify(body) }),
  );
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fetchMock = vi.fn(async () => new Response(JSON.stringify(AUTH_OK), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  mockHarness.mockResolvedValue("openclaw");
  mockGet.mockResolvedValue(BOT);
});

describe("GET /setup-api/slack/status", () => {
  it("is not configured without a stored bot token, and asks nobody", async () => {
    mockGet.mockResolvedValue(undefined);
    const { json } = await status();
    expect(json).toEqual({ configured: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockRow).not.toHaveBeenCalled();
  });

  it("reports a connected OpenClaw channel with the workspace and bot names", async () => {
    mockRow.mockResolvedValue(row({}));
    const { json } = await status();
    expect(json).toMatchObject({
      configured: true,
      verified: true,
      state: "connected",
      receiving: true,
      tokenRejected: false,
      tokenUnresolved: false,
      team: "Acme",
      botName: "clawbox",
    });
    expect(mockRow).toHaveBeenCalledWith("slack");
  });

  it("calls a running-but-disconnected channel offline", async () => {
    mockRow.mockResolvedValue(row({ connected: false }));
    const { json } = await status();
    expect(json).toMatchObject({ state: "offline", receiving: false });
  });

  it("says unknown (null), never offline, when the gateway could not be asked", async () => {
    mockRow.mockResolvedValue(null);
    const { json } = await status();
    expect(json).toMatchObject({ configured: true, verified: false, state: null, receiving: null });
  });

  it("surfaces an env reference the gateway cannot resolve", async () => {
    mockRow.mockResolvedValue(row({ connected: false, tokenStatus: "configured_unavailable" }));
    const { json } = await status();
    expect(json.tokenUnresolved).toBe(true);
  });

  it("surfaces a token Slack has revoked", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "token_revoked" }), { status: 200 }));
    mockRow.mockResolvedValue(row({ connected: false }));
    const { json } = await status();
    expect(json).toMatchObject({ tokenRejected: true, team: null });
  });

  it("asks Hermes' own snapshot on the Hermes edition", async () => {
    mockHarness.mockResolvedValue("hermes");
    mockRegistered.mockResolvedValue(true);
    mockGateway.mockResolvedValue({ installed: true, running: true, answered: true } as never);
    mockSnapshot.mockResolvedValue({
      gatewayState: "running",
      platform: { state: "connected", errorCode: null, updatedAt: null },
    });
    const { json } = await status();
    expect(json).toMatchObject({ configured: true, verified: true, state: "connected", receiving: true });
    expect(mockRegistered).toHaveBeenCalledWith("slack");
    expect(mockSnapshot).toHaveBeenCalledWith("slack");
  });

  it("reports Hermes saying it has no Slack platform as not configured", async () => {
    mockHarness.mockResolvedValue("hermes");
    mockRegistered.mockResolvedValue(false);
    mockGateway.mockResolvedValue({ installed: true, running: true, answered: true } as never);
    mockSnapshot.mockResolvedValue({ gatewayState: "running", platform: null });
    const { json } = await status();
    expect(json).toMatchObject({ configured: false, state: "offline", receiving: false });
  });

  it("keeps Hermes' unanswered gateway probe unknown", async () => {
    mockHarness.mockResolvedValue("hermes");
    mockRegistered.mockResolvedValue(null);
    mockGateway.mockResolvedValue({ installed: false, running: false, answered: false } as never);
    mockSnapshot.mockResolvedValue({ gatewayState: null, platform: null });
    const { json } = await status();
    expect(json).toMatchObject({ configured: true, verified: false, receiving: null });
  });
});

describe("POST /setup-api/slack/pairing", () => {
  it("approves on OpenClaw with the channel id", async () => {
    mockApprove.mockResolvedValue(undefined);
    const { status: code, json } = await approve({ code: "abcd2345" });
    expect(code).toBe(200);
    expect(json).toEqual({ success: true, userName: null });
    expect(mockApprove).toHaveBeenCalledWith("slack", "abcd2345");
  });

  it("approves on Hermes with its platform id and names who got in", async () => {
    mockHarness.mockResolvedValue("hermes");
    mockHermesApprove.mockResolvedValue({ userId: "U0001", userName: "Ada" });
    const { json } = await approve({ code: "ABCD2345" });
    expect(json).toEqual({ success: true, userName: "Ada" });
    expect(mockHermesApprove).toHaveBeenCalledWith("slack", "ABCD2345");
  });

  it("answers 400 for a malformed code", async () => {
    mockApprove.mockRejectedValue(new Error("Invalid pairing code format"));
    const { status: code, json } = await approve({ code: "!" });
    expect(code).toBe(400);
    expect(json.code).toBe("invalid_code");
  });

  it("answers 404 for a code the harness does not know, without its error text", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockApprove.mockRejectedValue(new Error("openclaw pairing approve exited 1: secret detail"));
    const { status: code, json } = await approve({ code: "ABCD2345" });
    expect(code).toBe(404);
    expect(json).toEqual({ error: "Pairing code not found or expired", code: "not_found" });
  });

  it("answers 429 while Hermes has approvals locked", async () => {
    mockHarness.mockResolvedValue("hermes");
    mockHermesApprove.mockRejectedValue(new Error("Approvals are locked for now after too many failed attempts."));
    const { status: code, json } = await approve({ code: "ABCD2345" });
    expect(code).toBe(429);
    expect(json.code).toBe("locked_out");
  });
});
