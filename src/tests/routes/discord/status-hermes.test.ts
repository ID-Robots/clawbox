import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * On a Hermes device a stored token proves nothing on its own — that is the
 * whole lesson of the Telegram bug. The flag comes from Hermes, and "we could
 * not ask Hermes" must never render as "your bot is gone".
 */

vi.mock("@/lib/config-store", () => ({ get: vi.fn() }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/hermes-discord", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hermes-discord")>("@/lib/hermes-discord");
  return {
    // The state mapping is a pure function and is the thing under test here —
    // stubbing it would leave the route's honesty unverified.
    mapDiscordConnectionState: actual.mapDiscordConnectionState,
    DISCORD_AUTH_ERROR_CODE: actual.DISCORD_AUTH_ERROR_CODE,
    hermesDiscordRegistered: vi.fn(),
    hermesGatewayStatus: vi.fn(),
    readHermesGatewaySnapshot: vi.fn(),
    readHermesDiscordAccess: vi.fn(),
  };
});

import { get } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import {
  hermesDiscordRegistered,
  hermesGatewayStatus,
  readHermesDiscordAccess,
  readHermesGatewaySnapshot,
} from "@/lib/hermes-discord";

const mockGet = vi.mocked(get);
const mockHarness = vi.mocked(getActiveHarness);
const mockRegistered = vi.mocked(hermesDiscordRegistered);
const mockGatewayStatus = vi.mocked(hermesGatewayStatus);
const mockSnapshot = vi.mocked(readHermesGatewaySnapshot);
const mockAccess = vi.mocked(readHermesDiscordAccess);

const TOKEN = "clawbox-test-not-a-real-discord-bot-token-000000";

describe("GET /setup-api/discord/status — Hermes", () => {
  let GET: () => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id: "42", username: "clawbot", discriminator: "0" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    mockGet.mockResolvedValue(TOKEN);
    mockHarness.mockResolvedValue("hermes");
    mockRegistered.mockResolvedValue(true);
    mockGatewayStatus.mockResolvedValue({ installed: true, running: true, scope: "system" });
    // The healthy baseline: gateway up, Discord connected, one person allowed.
    mockSnapshot.mockResolvedValue({
      gatewayState: "running",
      platform: { state: "connected", errorCode: null, updatedAt: null },
    });
    mockAccess.mockResolvedValue({
      allowedUsers: ["100000000000000001"],
      allowlistExtras: [],
      allowedRoles: [],
      allowedChannels: [],
      allowAllUsers: false,
      authorized: true,
    });

    GET = (await import("@/app/setup-api/discord/status/route")).GET;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is live only when Hermes knows the platform AND its gateway is up", async () => {
    const body = await (await GET()).json();
    expect(body).toMatchObject({
      configured: true,
      verified: true,
      receiving: true,
      username: "clawbot",
    });
  });

  it("is configured but not receiving when the gateway is down", async () => {
    mockGatewayStatus.mockResolvedValue({ installed: true, running: false, scope: "system" });

    const body = await (await GET()).json();

    expect(body).toMatchObject({ configured: true, receiving: false });
    expect(body.gateway).toMatchObject({ installed: true, running: false });
  });

  it("reports not-configured when Hermes says it has no Discord platform", async () => {
    mockRegistered.mockResolvedValue(false);
    const body = await (await GET()).json();
    expect(body).toMatchObject({ configured: false, verified: true, receiving: false });
  });

  it("falls back to the stored token — unverified — when Hermes cannot be asked", async () => {
    mockRegistered.mockResolvedValue(null);

    const body = await (await GET()).json();

    expect(body).toMatchObject({ configured: true, verified: false });
  });

  it("memoises its own CLI read and leaves the gateway to the shared reader", async () => {
    await Promise.all([GET(), GET(), GET()]);
    // `send --list discord` is this route's own shell-out and stays memoised here.
    expect(mockRegistered).toHaveBeenCalledTimes(1);
    // `hermes gateway status` is NOT: three status routes ask for that same
    // command, so its dedup, its short failure TTL and the invalidation the
    // gateway restart paths call all live in `hermesGatewayStatus()`. A second
    // 15 s copy here shadowed all three — see
    // `src/tests/unit/hermes-gateway-status-memo.test.ts`.
    expect(mockGatewayStatus).toHaveBeenCalledTimes(3);
  });

  it("reads the allowlist per request, so a save is visible at once", async () => {
    // The snapshot and the access env are one file read each. Memoising them
    // for 15 s composed a FRESH `gateway.running` with a stale allowlist: after
    // the owner saved the allowlist and the gateway restarted, this route kept
    // answering `denied-no-allowlist` — "every message is being dropped" — over
    // the thing he had just fixed.
    await Promise.all([GET(), GET(), GET()]);
    expect(mockAccess).toHaveBeenCalledTimes(3);
    expect(mockSnapshot).toHaveBeenCalledTimes(3);
  });

  it("never returns the token itself", async () => {
    expect(await (await GET()).text()).not.toContain(TOKEN);
  });
});
